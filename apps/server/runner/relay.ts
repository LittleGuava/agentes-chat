import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
  RELAY_LIMITS,
  type RunnerFrame,
  readConnectHead,
  relayCovers,
  relayPac,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { publicAddress } from "./egress";
import type { DataSocket } from "./streams";

/**
 * Sites that refuse data centers open through a person's own computer (ADR 0203). Two ends, on two computers, with
 * the server's data sockets between them: the entrance, a loopback listener the agent's Chrome reaches through its
 * proxy script, and the exit, which serves one tunnel's `CONNECT` from its data socket and never listens.
 */

/** One end of a tunnel toward the server: a data socket, or in tests an in-memory pipe. */
export type RelayLink = Pick<DataSocket, "send" | "close" | "listen" | "bufferedAmount">;

/** A socket a tunnel writes to: what the exit dialed, or the browser's connection to the entrance. */
type Wire = Pick<Socket, "write" | "end" | "destroy" | "pause" | "resume" | "on" | "once">;

/** Queued bytes past which the side that reads pauses until the link drains. */
const HIGH_WATER = 1024 * 1024;

const reply = (status: string) => `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
/** A tunnel's bytes always go as binary frames: a data socket reads text frames as its own control. */
const text = (s: string) => new TextEncoder().encode(s);

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * Copies bytes between a link and a socket until either ends, `tunnelBytes` went through or nothing moved for
 * `idleMs`. Resolves once both are closed.
 */
function pipe(link: RelayLink, wire: Wire, opts: { idleMs: number; first?: Uint8Array }): Promise<void> {
  return new Promise((resolve) => {
    let carried = 0;
    let done = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setInterval> | undefined;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearInterval(drain);
      link.close();
      wire.destroy();
      resolve();
    };
    const moved = (n: number) => {
      carried += n;
      if (carried > RELAY_LIMITS.tunnelBytes) return end();
      clearTimeout(idle);
      idle = setTimeout(end, opts.idleMs);
    };
    moved(0);
    link.listen({
      bytes: (b) => {
        if (done) return;
        moved(b.length);
        wire.write(b);
      },
      closed: end,
    });
    if (opts.first && opts.first.length > 0) {
      moved(opts.first.length);
      wire.write(opts.first);
    }
    wire.on("data", (chunk: Buffer) => {
      if (done) return;
      moved(chunk.length);
      link.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (link.bufferedAmount > HIGH_WATER && !drain) {
        wire.pause();
        drain = setInterval(() => {
          if (link.bufferedAmount > HIGH_WATER) return;
          clearInterval(drain);
          drain = undefined;
          wire.resume();
        }, 20);
      }
    });
    wire.on("error", end);
    wire.on("close", end);
  });
}

/**
 * Reads a `CONNECT` head from whatever `listen` hands over (bounded in size and time). Resolves with the head and the
 * bytes after it, or null when the other side closed or it timed out; `bad` with the reason when it isn't one.
 */
function readHead(
  listen: (on: { bytes(b: Uint8Array): void; closed(): void }) => void,
  timeoutMs: number,
): Promise<
  { ok: true; host: string; port: number; head: Uint8Array; rest: Uint8Array } | { ok: false; bad: boolean } | null
> {
  return new Promise((resolve) => {
    let got: Uint8Array = new Uint8Array(0);
    let settled = false;
    const settle = (v: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle({ ok: false, bad: true }), timeoutMs);
    listen({
      bytes(b) {
        if (settled) return;
        got = concat(got, b);
        const head = readConnectHead(got);
        if (head.status === "partial") return;
        if (head.status === "bad") return settle({ ok: false, bad: true });
        settle({
          ok: true,
          host: head.host,
          port: head.port,
          head: got.slice(0, head.length),
          rest: got.slice(head.length),
        });
      },
      closed: () => settle(null),
    });
  });
}

export interface RelayExitOptions {
  /** The sites this computer lends the tunnel's agent now, read from its own access when the head arrives. */
  sites(): string[];
  /** Tests: the name's addresses (default: the system's resolver, every address). */
  resolve?(host: string): Promise<string[]>;
  /** Tests: whether an address is public (default `publicAddress`). */
  isPublic?(ip: string): boolean;
  /** Tests: the connection to the site (default a TCP connection). */
  dial?(ip: string, port: number): Socket;
  headTimeoutMs?: number;
  idleMs?: number;
  log?(line: string): void;
}

const systemResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The exit (ADR 0203 §2): serves one tunnel from `link`, whose first bytes are the browser's `CONNECT`. Refuses what
 * this computer doesn't lend (another site, another port than 443, a name with any private address), dials the site
 * at the address it checked, answers `200` and copies bytes until either side ends. Resolves when the tunnel is over.
 */
export async function serveRelayExit(link: RelayLink, opts: RelayExitOptions): Promise<void> {
  const refuse = (status: string) => {
    link.send(text(reply(status)));
    link.close();
  };
  const inbox = new Inbox(link);
  const head = await readHead((on) => inbox.to(on), opts.headTimeoutMs ?? RELAY_LIMITS.headTimeoutMs);
  // From here what the browser sends waits for the site.
  const tunnel = inbox.link();
  if (!head) return link.close();
  if (!head.ok) return refuse("400 Bad Request");
  if (head.port !== RELAY_LIMITS.port || !relayCovers(head.host, opts.sites())) {
    opts.log?.(`a tunnel to ${head.host}:${head.port} was refused: not a site this computer lends`);
    return refuse("403 Forbidden");
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? systemResolve)(head.host);
  } catch {
    return refuse("502 Bad Gateway");
  }
  const isPublic = opts.isPublic ?? publicAddress;
  const first = addresses[0];
  if (!first || !addresses.every(isPublic)) {
    opts.log?.(`a tunnel to ${head.host} was refused: it names a private address`);
    return refuse("403 Forbidden");
  }
  const wire = (opts.dial ?? ((ip, port) => connect({ host: ip, port })))(first, head.port);
  const connected = await new Promise<boolean>((resolve) => {
    wire.once("connect", () => resolve(true));
    wire.once("error", () => resolve(false));
  });
  if (!connected) {
    wire.destroy();
    return refuse("502 Bad Gateway");
  }
  link.send(text("HTTP/1.1 200 Connection Established\r\n\r\n"));
  // Bytes after the head (a client that didn't wait for the answer) go on to the site, then what came meanwhile.
  await pipe(tunnel, wire, { idleMs: opts.idleMs ?? RELAY_LIMITS.idleMs, first: head.rest });
}

type Listener = Parameters<RelayLink["listen"]>[0];

/**
 * A link heard once, its bytes handed to whoever reads now: the head's reader, then the tunnel. What arrives between
 * the two waits here, so nothing is lost while the exit dials.
 */
class Inbox {
  private sink: Listener | null = null;
  private readonly queued: Uint8Array[] = [];
  private ended = false;

  constructor(private readonly source: RelayLink) {
    source.listen({
      bytes: (b) => {
        if (this.sink) this.sink.bytes(b);
        else this.queued.push(b);
      },
      closed: () => {
        this.ended = true;
        this.sink?.closed();
      },
    });
  }

  /** Hands what comes from now on (and what waited) to `on`. */
  to(on: Listener) {
    this.sink = on;
    for (const b of this.queued.splice(0)) on.bytes(b);
    if (this.ended) on.closed();
  }

  /** The same link, read from here on (what comes before its `listen` waits). */
  link(): RelayLink {
    this.sink = null;
    const source = this.source;
    return {
      send: (d) => source.send(d),
      close: (code, reason) => source.close(code, reason),
      get bufferedAmount() {
        return source.bufferedAmount;
      },
      listen: (on) => this.to(on),
    };
  }
}

export interface RelayEntranceOptions {
  /** The sites another computer lends this agent now (the `agents` frame's `relay`). */
  sitesOf(agentId: string): string[];
  /** Asks the server for a tunnel (`relay.want`): the data socket of its near end, ready. */
  open(agentId: string, host: string): Promise<RelayLink>;
  headTimeoutMs?: number;
  idleMs?: number;
  log?(line: string): void;
}

/**
 * The entrance (ADR 0203 §2): one loopback listener per agent, which its Chrome reaches through the proxy script
 * (`pacFor`). Each connection must be a `CONNECT` to port 443 of one of the agent's sites; the rest is refused
 * without asking the server. The head goes on through the tunnel: the exit decides again with its own access.
 */
export class RelayEntrance {
  private readonly listeners = new Map<string, Promise<{ server: Server; port: number }>>();
  private readonly bound = new Map<string, { host: string; port: number }>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: RelayEntranceOptions) {}

  /** The port of the agent's listener, started on first use. */
  async port(agentId: string): Promise<number> {
    let started = this.listeners.get(agentId);
    if (!started) {
      started = new Promise((resolve, reject) => {
        const server = createServer((socket) => this.serve(agentId, socket));
        (server as unknown as EventEmitter).once("error", reject);
        // Loopback only: nothing on the network reaches it.
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("no port"));
          this.bound.set(agentId, { host: address.address, port: address.port });
          resolve({ server, port: address.port });
        });
      });
      this.listeners.set(agentId, started);
    }
    return (await started).port;
  }

  /** Where the agent's listener is, once started. */
  address(agentId: string): { host: string; port: number } | null {
    return this.bound.get(agentId) ?? null;
  }

  /** The `--proxy-pac-url` for the agent's Chrome, or null when no computer lends it a site. */
  async pacFor(agentId: string): Promise<string | null> {
    const sites = this.opts.sitesOf(agentId);
    if (sites.length === 0) return null;
    return relayPac(sites, await this.port(agentId));
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const all = [...this.listeners.values()];
    this.listeners.clear();
    this.bound.clear();
    await Promise.all(
      all.map(async (started) => {
        const bound = await started.catch(() => null);
        if (bound) await new Promise((r) => bound.server.close(() => r(undefined)));
      }),
    );
  }

  private async serve(agentId: string, socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    const refuse = (status: string) => {
      socket.end(reply(status));
    };
    const head = await readHead((on) => {
      socket.on("data", (chunk: Buffer) => on.bytes(new Uint8Array(chunk)));
      socket.once("close", () => on.closed());
    }, this.opts.headTimeoutMs ?? RELAY_LIMITS.headTimeoutMs);
    // Held while the tunnel opens: what the browser sends meanwhile waits in the socket.
    socket.pause();
    socket.removeAllListeners("data");
    if (!head) return socket.destroy();
    if (!head.ok) return refuse("400 Bad Request");
    if (head.port !== RELAY_LIMITS.port || !relayCovers(head.host, this.opts.sitesOf(agentId))) {
      return refuse("403 Forbidden");
    }
    let link: RelayLink;
    try {
      link = await this.opts.open(agentId, head.host);
    } catch (err) {
      this.opts.log?.(`no tunnel to ${head.host} for an agent: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("502 Bad Gateway");
    }
    if (socket.destroyed) return link.close();
    link.send(concat(head.head, head.rest));
    const done = pipe(link, socket, { idleMs: this.opts.idleMs ?? RELAY_LIMITS.idleMs });
    socket.resume();
    await done;
  }
}

/** The tunnels this computer serves at once (at most `RELAY_LIMITS.tunnels`), each until it ends. */
export class RelayExits {
  private open = 0;

  constructor(private readonly opts: Omit<RelayExitOptions, "sites"> = {}) {}

  hasRoom(): boolean {
    return this.open < RELAY_LIMITS.tunnels;
  }

  get serving(): number {
    return this.open;
  }

  /** Serves one tunnel from `link`; `sites` is read when its head arrives. */
  serve(link: RelayLink, sites: () => string[]) {
    this.open++;
    void serveRelayExit(link, { ...this.opts, sites })
      .catch((err: unknown) => this.opts.log?.(`a tunnel failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.open--;
      });
  }
}

type RelayReady = Extract<ServerFrame, { type: "relay.ready" }>;

/**
 * The entrance's questions to the server (`relay.want`), each answered by its `relay.ready`: the stream id of the
 * tunnel's near end, or the server's reason. Unanswered within `timeoutMs`, or the connection gone, it fails.
 */
export class RelayWants {
  private readonly pending = new Map<
    string,
    { resolve(streamId: string): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly send: (frame: RunnerFrame) => boolean,
    private readonly timeoutMs: number = RELAY_LIMITS.pairTimeoutMs,
  ) {}

  want(agentId: string, host: string): Promise<string> {
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error("the server didn't answer"));
      }, this.timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      if (!this.send({ type: "relay.want", callId, agentId, host })) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(new Error("not connected to the server"));
      }
    });
  }

  /** The server's answer to one of them. */
  ready(frame: RelayReady) {
    const waiting = this.pending.get(frame.callId);
    if (!waiting) return;
    this.pending.delete(frame.callId);
    clearTimeout(waiting.timer);
    if (frame.ok) waiting.resolve(frame.streamId);
    else waiting.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
  }

  /** The connection went down: nothing pending will be answered. */
  failAll() {
    for (const [callId, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("the connection to the server ended"));
      this.pending.delete(callId);
    }
  }
}
