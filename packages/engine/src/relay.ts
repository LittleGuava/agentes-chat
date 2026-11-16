import { randomBytes } from "node:crypto";
import {
  type MachineAgent,
  RELAY_LENDABLE_MAX,
  RELAY_LIMITS,
  RELAY_PROTOCOL,
  type RelayAgent,
  type RelayRefusal,
  type RunnerAccess,
  relayCovers,
  relaySitesFor,
  type ServerFrame,
} from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNotNull, isNull, ne, schema } from "@agenteschat/db";
import { type MachineHub, type MachineRelayHooks, MachineRequestError } from "./machine-hub";
import { machineOnline, machinePause } from "./machines";
import type { ClaimedStream, StreamSocket } from "./streams";

/**
 * Sites that refuse data centers open through a person's own computer (ADR 0203): which computer lends a site to an
 * agent, and the server's part of a tunnel, two runners' data sockets paired and copied between.
 */

/** A computer of the workspace as the relay reads it. */
export interface RelayMachine {
  id: string;
  /** Its name, and who paired it (the agent's page says through whose computer). */
  name?: string;
  pairedBy?: { id: string; name: string } | null;
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

/** A lender there to dial its end now: online, not paused, on a protocol that knows `relay.open`. */
const ready = (m: RelayMachine) => m.online && !m.paused && m.protocol >= RELAY_PROTOCOL;

/**
 * The sites the other computers of the workspace lend `agentId` now (its `agents` frame's `relay`): a site whose
 * every lender is away, paused or too old leaves the list, so the agent's browser opens it straight meanwhile.
 */
export function relaySitesOf(machines: readonly RelayMachine[], fromMachineId: string, agentId: string): string[] {
  const out: string[] = [];
  for (const m of lenders(machines, fromMachineId).filter(ready)) {
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
  const there = lending.find(ready);
  return there ? { machineId: there.id } : { refused: "relay_offline" };
}

/** The workspace's computers, as `pickRelay` reads them. */
export async function relayMachines(db: Database, orgId: string, now = new Date()): Promise<RelayMachine[]> {
  const rows = await db
    .select({
      id: schema.machines.id,
      name: schema.machines.name,
      pairedById: schema.machines.pairedByUserId,
      pairedByName: schema.users.name,
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
    .leftJoin(schema.users, eq(schema.users.id, schema.machines.pairedByUserId))
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    pairedBy: r.pairedById ? { id: r.pairedById, name: r.pairedByName ?? "" } : null,
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

/**
 * Whom a person's computer may lend a site to, by name (its `agents` frame's `lendable`): the workspace's agents that
 * work on another computer, each with that computer's name. Only to a person's own computer, where lending applies;
 * empty for the others.
 */
export async function relayLendable(db: Database, orgId: string, machineId: string): Promise<RelayAgent[]> {
  const [me] = await db
    .select({ kind: schema.machines.kind, executors: schema.machines.executors })
    .from(schema.machines)
    .where(and(eq(schema.machines.id, machineId), eq(schema.machines.orgId, orgId)));
  if (me?.kind !== "connected" || me.executors?.mode === "system") return [];
  const rows = await db
    .select({
      id: schema.agents.id,
      handle: schema.agents.handle,
      name: schema.agents.name,
      appearance: schema.agents.appearance,
      machine: schema.machines.name,
    })
    .from(schema.agents)
    .innerJoin(schema.machines, and(eq(schema.machines.id, schema.agents.machineId), isNull(schema.machines.deletedAt)))
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        isNull(schema.agents.archivedAt),
        isNotNull(schema.agents.machineId),
        ne(schema.agents.machineId, machineId),
      ),
    )
    .orderBy(asc(schema.agents.name), asc(schema.agents.createdAt))
    .limit(RELAY_LENDABLE_MAX);
  return rows.map((a) => ({
    id: a.id,
    handle: a.handle,
    name: a.name,
    ...(a.appearance
      ? { look: { color: a.appearance.color, eyes: a.appearance.eyes, accessory: a.appearance.accessory } }
      : {}),
    machine: a.machine,
  }));
}

/** A site lent to an agent, as its page shows it: through which computer, whose, and whether it is there now. */
export interface AgentRelaySite {
  site: string;
  machine: { id: string; name: string };
  by: { id: string; name: string } | null;
  online: boolean;
}

/** Every site another computer lends `agentId`, one line per computer that lends it (its page, ADR 0203 §4). */
export async function agentRelaySites(db: Database, orgId: string, agentId: string): Promise<AgentRelaySite[]> {
  const [agent] = await db
    .select({ machineId: schema.agents.machineId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId)));
  if (!agent?.machineId) return [];
  const out: AgentRelaySite[] = [];
  for (const m of lenders(await relayMachines(db, orgId), agent.machineId)) {
    for (const site of relaySitesFor(m.access, agentId)) {
      out.push({ site, machine: { id: m.id, name: m.name ?? "" }, by: m.pairedBy ?? null, online: ready(m) });
    }
  }
  return out.sort((a, b) => a.site.localeCompare(b.site) || a.machine.name.localeCompare(b.machine.name));
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

/** The hub's relay hooks as the server sets them: tunnels, each agent's sites, and whom a computer may lend to. */
export function siteRelayHooks(db: Database, relay: Pick<SiteRelay, "want">): MachineRelayHooks {
  return {
    want: (machine, frame) => relay.want(machine, frame),
    agents: (orgId, machineId, agents) => withRelaySites(db, orgId, machineId, agents),
    lendable: (orgId, machineId) => relayLendable(db, orgId, machineId),
  };
}

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
