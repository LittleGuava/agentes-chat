import { randomBytes } from "node:crypto";
import {
  type MachineAgent,
  RELAY_LIMITS,
  RELAY_PROTOCOL,
  type RelayRefusal,
  type RunnerAccess,
  relayCovers,
  relaySitesFor,
  type ServerFrame,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { type MachineHub, MachineRequestError } from "./machine-hub";
import { machineOnline, machinePause } from "./machines";
import type { ClaimedStream, StreamSocket } from "./streams";

/**
 * Sites that refuse data centers open through a person's own computer (ADR 0203): which computer lends a site to an
 * agent, and the server's part of a tunnel, two runners' data sockets paired and copied between.
 */

/** A computer of the workspace as the relay reads it. */
export interface RelayMachine {
  id: string;
  kind: string;
  online: boolean;
  protocol: number;
  paused: boolean;
  /** Each agent works as its own OS user there (ADR 0058 §10): it lends nothing. */
  systemMode: boolean;
  access: Pick<RunnerAccess, "relay"> | null;
}

/** The computers that may lend `agentId` their connection: a person's own, never the agent's nor a server's. */
const lenders = (machines: readonly RelayMachine[], fromMachineId: string) =>
  machines.filter((m) => m.id !== fromMachineId && m.kind === "connected" && !m.systemMode);

/** The sites the other computers of the workspace lend `agentId` (its `agents` frame's `relay`). */
export function relaySitesOf(machines: readonly RelayMachine[], fromMachineId: string, agentId: string): string[] {
  const out: string[] = [];
  for (const m of lenders(machines, fromMachineId)) {
    for (const site of relaySitesFor(m.access, agentId)) if (!out.includes(site)) out.push(site);
  }
  return out.slice(0, RELAY_LIMITS.sites);
}

/** Which computer lends `host` to `agentId` now, or why none does. */
export function pickRelay(
  machines: readonly RelayMachine[],
  want: { fromMachineId: string; agentId: string; host: string },
): { machineId: string } | { refused: RelayRefusal } {
  const lending = lenders(machines, want.fromMachineId).filter((m) =>
    relayCovers(want.host, relaySitesFor(m.access, want.agentId)),
  );
  if (lending.length === 0) return { refused: "relay_none" };
  const ready = lending.find((m) => m.online && !m.paused && m.protocol >= RELAY_PROTOCOL);
  return ready ? { machineId: ready.id } : { refused: "relay_offline" };
}

/** The workspace's computers, as `pickRelay` reads them. */
export async function relayMachines(db: Database, orgId: string, now = new Date()): Promise<RelayMachine[]> {
  const rows = await db
    .select({
      id: schema.machines.id,
      kind: schema.machines.kind,
      online: schema.machines.online,
      lastSeenAt: schema.machines.lastSeenAt,
      deletedAt: schema.machines.deletedAt,
      protocol: schema.machines.protocol,
      paused: schema.machines.paused,
      pausedUntil: schema.machines.pausedUntil,
      executors: schema.machines.executors,
      access: schema.machines.access,
    })
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    online: machineOnline(r, now),
    protocol: r.protocol,
    paused: machinePause(r, now) !== null,
    systemMode: r.executors.mode === "system",
    access: r.access,
  }));
}

/** The `agents` frame of a computer on `RELAY_PROTOCOL`: each agent with the sites another computer lends it. */
export async function withRelaySites(
  db: Database,
  orgId: string,
  machineId: string,
  agents: MachineAgent[],
): Promise<MachineAgent[]> {
  const machines = await relayMachines(db, orgId);
  return agents.map((a) => {
    const relay = relaySitesOf(machines, machineId, a.id);
    return relay.length > 0 ? { ...a, relay } : a;
  });
}

type RelayReady = Extract<ServerFrame, { type: "relay.ready" }>;

interface End {
  machineId: string;
  socket: StreamSocket | null;
}

interface Tunnel {
  ids: [string, string];
  ends: [End, End];
  /** What one end sent before the other came (at most a head). */
  queued: [Uint8Array[], Uint8Array[]];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  over: boolean;
}

export interface SiteRelayDeps {
  hub: Pick<MachineHub, "call">;
  /** The workspace's computers (default from the database). */
  machines(orgId: string): Promise<RelayMachine[]>;
  /** Whether `agentId` is an agent of the workspace that works on `machineId`. */
  agentOn(orgId: string, agentId: string, machineId: string): Promise<boolean>;
  /** Tests: shorter waits, smaller caps. */
  limits?: Partial<Record<"pairTimeoutMs" | "idleMs" | "tunnelBytes" | "headBytes", number>>;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

const mint = () => randomBytes(32).toString("base64url");
/** Bytes queued toward one end past which its tunnel ends (each runner pauses its side at 1 MiB). */
const SLOW_PEER_BYTES = 8 * 1024 * 1024;

/**
 * The server's part of the tunnels (ADR 0203 §2): `want` answers a runner's `relay.want` (the computer that lends,
 * asked to dial its end), `claim` takes the data sockets the stream broker doesn't know. An id serves once, only from
 * the computer it was minted for, and lapses unpaired after `pairTimeoutMs`.
 */
export function createSiteRelay(deps: SiteRelayDeps) {
  const limits = { ...RELAY_LIMITS, ...deps.limits };
  const byId = new Map<string, { tunnel: Tunnel; side: 0 | 1 }>();
  const live = new Set<Tunnel>();

  const end = (tunnel: Tunnel) => {
    if (tunnel.over) return;
    tunnel.over = true;
    if (tunnel.timer) clearTimeout(tunnel.timer);
    for (const id of tunnel.ids) byId.delete(id);
    live.delete(tunnel);
    for (const e of tunnel.ends) e.socket?.close(1000, "tunnel over");
  };
  const arm = (tunnel: Tunnel, ms: number) => {
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.timer = setTimeout(() => end(tunnel), ms);
  };

  async function want(
    machine: { id: string; orgId: string },
    frame: { callId: string; agentId: string; host: string },
  ): Promise<RelayReady> {
    const refuse = (code: RelayRefusal, message: string): RelayReady => ({
      type: "relay.ready",
      callId: frame.callId,
      ok: false,
      error: { code, message },
    });
    if (!(await deps.agentOn(machine.orgId, frame.agentId, machine.id))) {
      return refuse("relay_refused", "That agent doesn't work on this computer");
    }
    const picked = pickRelay(await deps.machines(machine.orgId), {
      fromMachineId: machine.id,
      agentId: frame.agentId,
      host: frame.host,
    });
    if ("refused" in picked) {
      return refuse(
        picked.refused,
        picked.refused === "relay_none"
          ? "No computer lends its connection to this agent for that site"
          : "The computer that lends its connection for that site isn't online",
      );
    }
    const tunnel: Tunnel = {
      ids: [mint(), mint()],
      ends: [
        { machineId: machine.id, socket: null },
        { machineId: picked.machineId, socket: null },
      ],
      queued: [[], []],
      bytes: 0,
      timer: null,
      over: false,
    };
    live.add(tunnel);
    byId.set(tunnel.ids[0], { tunnel, side: 0 });
    byId.set(tunnel.ids[1], { tunnel, side: 1 });
    arm(tunnel, limits.pairTimeoutMs);
    try {
      await deps.hub.call(
        picked.machineId,
        { op: "relay.open", streamId: tunnel.ids[1], agentId: frame.agentId },
        { timeoutMs: limits.pairTimeoutMs },
      );
    } catch (error) {
      end(tunnel);
      const refused = error instanceof MachineRequestError && error.code === "not_allowed";
      return refuse(
        refused ? "relay_refused" : "relay_offline",
        refused
          ? "The computer that lends its connection refused this tunnel"
          : "The computer that lends its connection didn't answer",
      );
    }
    if (tunnel.over) return refuse("relay_offline", "The computer that lends its connection didn't answer in time");
    return { type: "relay.ready", callId: frame.callId, ok: true, streamId: tunnel.ids[0] };
  }

  function claim(streamId: string, machineId: string, socket: StreamSocket): ClaimedStream | null {
    const found = byId.get(streamId);
    if (!found) return null;
    const { tunnel, side } = found;
    const me = tunnel.ends[side];
    if (me.machineId !== machineId || me.socket) return null;
    me.socket = socket;
    byId.delete(streamId);
    const other = side === 0 ? 1 : 0;
    const paired = () => tunnel.ends[0].socket !== null && tunnel.ends[1].socket !== null;
    if (paired()) {
      // Both ends are here: what waited goes on, and the tunnel lives while bytes move.
      for (const s of [0, 1] as const) {
        const to = tunnel.ends[s === 0 ? 1 : 0].socket;
        for (const b of tunnel.queued[s].splice(0)) to?.send(b);
      }
      arm(tunnel, limits.idleMs);
    }
    return {
      data(data) {
        // Text frames are a data socket's own control: a tunnel carries bytes only.
        if (tunnel.over || typeof data === "string") return;
        tunnel.bytes += data.byteLength;
        if (tunnel.bytes > limits.tunnelBytes) return end(tunnel);
        const to = tunnel.ends[other].socket;
        if (!to) {
          const waiting = tunnel.queued[side].reduce((n, b) => n + b.byteLength, 0) + data.byteLength;
          if (waiting > limits.headBytes) return end(tunnel);
          tunnel.queued[side].push(data);
          return;
        }
        // A runner that stopped reading would have the server hold the tunnel's bytes: it ends instead.
        if (to.buffered() > SLOW_PEER_BYTES) return end(tunnel);
        to.send(data);
        arm(tunnel, limits.idleMs);
      },
      closed() {
        end(tunnel);
      },
    };
  }

  return {
    want,
    claim,
    /** Tunnels open or waiting for an end (tests, the log). */
    get open() {
      return live.size;
    },
  };
}

export type SiteRelay = ReturnType<typeof createSiteRelay>;

/** `SiteRelayDeps` read from the database. */
export function siteRelayFromDb(db: Database): Pick<SiteRelayDeps, "machines" | "agentOn"> {
  return {
    machines: (orgId) => relayMachines(db, orgId),
    async agentOn(orgId, agentId, machineId) {
      const [row] = await db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, orgId),
            eq(schema.agents.id, agentId),
            eq(schema.agents.machineId, machineId),
            isNull(schema.agents.archivedAt),
          ),
        );
      return !!row;
    },
  };
}
