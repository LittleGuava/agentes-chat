import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { RunnerAccess, RunnerRelayGrant } from "@agenteschat/adapters/machine-protocol";
import type { ServerWebSocket } from "bun";
import {
  allowRelaySite,
  ControlError,
  reduceAccess,
  relayAgentIds,
  removeRelaySite,
  widens,
} from "../../runner/access";
import { chromeLaunchArgs } from "../../runner/browser";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { RelayEntrance, RelayExits, type RelayLink, serveRelayExit } from "../../runner/relay";
import { DataSockets } from "../../runner/streams";
import { errorCode } from "./helpers";

/** ADR 0203: the entrance on the agent's computer, the exit on the person's, and only loopback sockets between. */

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A site that echoes what it hears, on loopback: the only place a test tunnel ever reaches. */
async function fakeSite(): Promise<{ port: number; heard: () => number }> {
  let connections = 0;
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections++;
    open.add(socket);
    socket.on("data", (d) => socket.write(d));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    for (const s of open) s.destroy();
    return new Promise((r) => server.close(() => r(undefined)));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, heard: () => connections };
}

/** Two ends of a data socket's path through the server, in memory: what one sends, the other hears. */
function linkPair(): [RelayLink, RelayLink] {
  type End = { on: Parameters<RelayLink["listen"]>[0] | null; early: Uint8Array[]; closed: boolean };
  const ends: [End, End] = [
    { on: null, early: [], closed: false },
    { on: null, early: [], closed: false },
  ];
  const make = (me: End, other: End): RelayLink => ({
    bufferedAmount: 0,
    send(data) {
      if (me.closed || other.closed) return;
      // A real data socket reads a text frame as its own control, never as the tunnel's bytes.
      if (typeof data === "string") return;
      const bytes = data.slice();
      queueMicrotask(() => (other.on ? other.on.bytes(bytes) : other.early.push(bytes)));
    },
    close() {
      if (me.closed) return;
      me.closed = true;
      other.closed = true;
      queueMicrotask(() => {
        me.on?.closed();
        other.on?.closed();
      });
    },
    listen(on) {
      me.on = on;
      for (const b of me.early.splice(0)) on.bytes(b);
      if (me.closed) on.closed();
    },
  });
  return [make(ends[0], ends[1]), make(ends[1], ends[0])];
}

/** Talks to a socket: sends, and collects what comes back. */
function talk(socket: Socket) {
  let got = "";
  socket.on("data", (d) => {
    got += d.toString("latin1");
  });
  const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  return {
    send: (text: string) => socket.write(text),
    got: () => got,
    ended,
    async until(text: string, ms = 3000) {
      const start = Date.now();
      while (!got.includes(text)) {
        if (Date.now() - start > ms) throw new Error(`waited for ${JSON.stringify(text)}, got ${JSON.stringify(got)}`);
        await Bun.sleep(5);
      }
    },
  };
}

const CONNECT = (host: string, port = 443) => `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;

/** The exit, serving one tunnel whose other end the test holds; DNS and the dial stay on loopback. */
function exit(
  site: { port: number },
  opts: { sites?: string[]; addresses?: string[]; realAddressRule?: boolean } = {},
) {
  const [near, far] = linkPair();
  const dialed: { ip: string; port: number }[] = [];
  const done = serveRelayExit(far, {
    sites: () => opts.sites ?? ["example.com"],
    resolve: async () => opts.addresses ?? ["127.0.0.1"],
    // The fake site is on loopback: only the test that checks the rule itself keeps it.
    ...(opts.realAddressRule ? {} : { isPublic: () => true }),
    dial: (ip, port) => {
      dialed.push({ ip, port });
      // Never anywhere but the fake site on loopback, whatever the tunnel asked for.
      expect(ip).toBe("127.0.0.1");
      return connect({ host: "127.0.0.1", port: site.port });
    },
  });
  let got = "";
  let closed = false;
  near.listen({
    bytes: (b) => {
      got += Buffer.from(b).toString("latin1");
    },
    closed: () => {
      closed = true;
    },
  });
  return {
    near,
    send: (s: string) => near.send(new TextEncoder().encode(s)),
    dialed,
    done,
    got: () => got,
    closed: () => closed,
    async until(text: string) {
      const start = Date.now();
      while (!got.includes(text)) {
        if (Date.now() - start > 3000)
          throw new Error(`waited for ${JSON.stringify(text)}, got ${JSON.stringify(got)}`);
        await Bun.sleep(5);
      }
    },
  };
}

describe("the exit on the person's computer", () => {
  test("a CONNECT to a site it lends opens the site and carries bytes both ways", async () => {
    const site = await fakeSite();
    const x = exit(site);
    x.send(CONNECT("www.example.com"));
    await x.until("HTTP/1.1 200 Connection Established\r\n\r\n");
    x.send("hello");
    await x.until("hello");
    expect(x.dialed).toEqual([{ ip: "127.0.0.1", port: 443 }]);
    x.near.close();
    await x.done;
  });

  test("a site it doesn't lend, another port or something else than CONNECT is refused before any dial", async () => {
    const site = await fakeSite();
    for (const [ask, status] of [
      [CONNECT("other.org"), "403"],
      [CONNECT("badexample.com"), "403"],
      [CONNECT("www.example.com", 22), "403"],
      [CONNECT("127.0.0.1"), "400"],
      ["GET http://www.example.com/ HTTP/1.1\r\nHost: www.example.com\r\n\r\n", "400"],
    ] as const) {
      const x = exit(site);
      x.send(ask);
      await x.until(`HTTP/1.1 ${status}`);
      await x.done;
      expect(x.closed()).toBe(true);
      expect(x.dialed).toEqual([]);
    }
    expect(site.heard()).toBe(0);
  });

  test("a name that resolves to a private address is refused, even next to a public one", async () => {
    const site = await fakeSite();
    for (const addresses of [["127.0.0.1"], ["10.0.0.7"], ["93.184.216.34", "192.168.1.1"], []]) {
      const x = exit(site, { addresses, realAddressRule: true });
      x.send(CONNECT("www.example.com"));
      await x.until("HTTP/1.1 403");
      await x.done;
      expect(x.dialed).toEqual([]);
    }
  });

  test("the sites are read when the tunnel opens: one removed since is refused", async () => {
    const site = await fakeSite();
    const x = exit(site, { sites: [] });
    x.send(CONNECT("www.example.com"));
    await x.until("HTTP/1.1 403");
    await x.done;
    expect(x.dialed).toEqual([]);
  });

  test("a head that never ends is cut", async () => {
    const site = await fakeSite();
    const x = exit(site);
    x.send(`CONNECT www.example.com:443 HTTP/1.1\r\nX: ${"a".repeat(9000)}`);
    await x.until("HTTP/1.1 400");
    await x.done;
    expect(x.dialed).toEqual([]);
  });
});

describe("the entrance on the agent's computer", () => {
  test("listens on loopback only, and its proxy script sends the agent's sites there", async () => {
    const entrance = new RelayEntrance({ sitesOf: () => ["example.com"], open: async () => linkPair()[0] });
    closers.push(() => entrance.close());
    const port = await entrance.port("agent-1");
    expect(entrance.address("agent-1")).toEqual({ host: "127.0.0.1", port });
    const pac = await entrance.pacFor("agent-1");
    expect(pac).toStartWith("data:application/x-ns-proxy-autoconfig;base64,");
    const script = atob((pac as string).split(",")[1] as string);
    expect(script).toContain(`PROXY 127.0.0.1:${port}`);
    expect(script).toContain('"example.com"');
    // An agent with no site gets no script and no listener.
    expect(await new RelayEntrance({ sitesOf: () => [], open: async () => linkPair()[0] }).pacFor("x")).toBeNull();
  });

  test("a site the agent isn't lent is refused without asking the server", async () => {
    const asked: string[] = [];
    const entrance = new RelayEntrance({
      sitesOf: () => ["example.com"],
      open: async (_agent, host) => {
        asked.push(host);
        return linkPair()[0];
      },
    });
    closers.push(() => entrance.close());
    const port = await entrance.port("agent-1");
    const c = talk(connect({ host: "127.0.0.1", port }));
    c.send(CONNECT("other.org"));
    await c.until("HTTP/1.1 403");
    await c.ended;
    expect(asked).toEqual([]);
  });

  test("no tunnel from the server is a 502", async () => {
    const entrance = new RelayEntrance({
      sitesOf: () => ["example.com"],
      open: async () => {
        throw new Error("relay_none");
      },
    });
    closers.push(() => entrance.close());
    const port = await entrance.port("agent-1");
    const c = talk(connect({ host: "127.0.0.1", port }));
    c.send(CONNECT("www.example.com"));
    await c.until("HTTP/1.1 502");
    await c.ended;
  });

  test("the whole way: browser → entrance → tunnel → exit → site, and back", async () => {
    const site = await fakeSite();
    const opened: { agentId: string; host: string }[] = [];
    const entrance = new RelayEntrance({
      sitesOf: (agentId) => (agentId === "agent-1" ? ["example.com"] : []),
      open: async (agentId, host) => {
        opened.push({ agentId, host });
        const [near, far] = linkPair();
        void serveRelayExit(far, {
          sites: () => ["example.com"],
          resolve: async () => ["127.0.0.1"],
          isPublic: () => true,
          dial: (ip) => {
            expect(ip).toBe("127.0.0.1");
            return connect({ host: "127.0.0.1", port: site.port });
          },
        });
        return near;
      },
    });
    closers.push(() => entrance.close());
    const port = await entrance.port("agent-1");
    const browser = talk(connect({ host: "127.0.0.1", port }));
    browser.send(CONNECT("jobs.example.com"));
    await browser.until("HTTP/1.1 200 Connection Established\r\n\r\n");
    browser.send("tls bytes");
    await browser.until("tls bytes");
    expect(opened).toEqual([{ agentId: "agent-1", host: "jobs.example.com" }]);
    expect(site.heard()).toBe(1);
  });
});

describe("the person's grant", () => {
  const base: RunnerAccess = { folders: [], tools: { claude: false, codex: false, commands: false } };

  test("lends a site to the agents named, merges, and stops for one or for all", () => {
    let access = allowRelaySite(base, "https://www.Example.com/jobs", ["a1"]);
    access = allowRelaySite(access, "www.example.com", ["a2", "a1"]);
    expect(access.relay).toEqual([{ site: "www.example.com", agents: ["a1", "a2"] }]);
    expect(removeRelaySite(access, "www.example.com", "a1").relay).toEqual([
      { site: "www.example.com", agents: ["a2"] },
    ]);
    expect(removeRelaySite(access, "WWW.example.com").relay).toEqual([]);
    expect(() => allowRelaySite(base, "192.168.0.1", ["a1"])).toThrow(ControlError);
    expect(() => allowRelaySite(base, "nas.local", ["a1"])).toThrow(ControlError);
  });

  test("the server can't widen it: a reduce keeps the sites, and a new site or agent counts as wider", () => {
    const access = allowRelaySite(base, "example.com", ["a1"]);
    expect(reduceAccess(access, { disableTool: "codex" }).relay).toEqual(access.relay);
    expect(widens(allowRelaySite(access, "jobs.org", ["a1"]), access)).toBe(true);
    expect(widens(allowRelaySite(access, "example.com", ["a2"]), access)).toBe(true);
    expect(widens(removeRelaySite(access, "example.com"), access)).toBe(false);
  });
});

describe("relay.open on the person's computer", () => {
  const STREAM = "R".repeat(43);
  const TOKEN = "agm_test-token";

  /** The server's side of the data socket, on loopback: says ready, then plays the browser's end of the tunnel. */
  function dataServer() {
    let got = "";
    let peer: ServerWebSocket<unknown> | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws, message) {
          if (peer !== ws) {
            peer = ws;
            ws.send(JSON.stringify({ type: "stream.ready" }));
            return;
          }
          if (typeof message !== "string") got += Buffer.from(message).toString("latin1");
        },
      },
    });
    closers.push(() => server.stop(true));
    return {
      url: `ws://127.0.0.1:${server.port}/api/machines/stream`,
      send: (s: string) => peer?.send(new TextEncoder().encode(s)),
      got: () => got,
      ready: () => peer !== null,
    };
  }

  async function setup(opts: { relay?: RunnerRelayGrant[]; system?: boolean } = {}) {
    const site = await fakeSite();
    const s = dataServer();
    const dialed: string[] = [];
    const exits = new RelayExits({
      resolve: async () => ["127.0.0.1"],
      isPublic: () => true,
      dial: (ip) => {
        dialed.push(ip);
        expect(ip).toBe("127.0.0.1");
        return connect({ host: "127.0.0.1", port: site.port });
      },
    });
    const ctx: HandlerContext = {
      workspaceReal: "/srv/agentes",
      exec: true,
      token: TOKEN,
      access: () => ({ ...base(), relay: opts.relay ?? [{ site: "example.com", agents: ["a1"] }] }),
      streams: new DataSockets({ url: s.url, token: TOKEN }),
      relayExits: exits,
      ...(opts.system ? { systemMode: () => true } : {}),
    };
    const scope: RequestScope = { signal: new AbortController().signal, output: () => undefined };
    return {
      s,
      site,
      dialed,
      exits,
      open: (agentId: string) => handleRequest(ctx, { op: "relay.open", streamId: STREAM, agentId }, scope),
    };
  }
  const base = (): RunnerAccess => ({ folders: [], tools: { claude: false, codex: false, commands: false } });

  test("dials the data socket and serves the CONNECT that comes through it", async () => {
    const t = await setup();
    expect(await t.open("a1")).toEqual({ opened: true });
    t.s.send(CONNECT("www.example.com"));
    for (let i = 0; i < 200 && !t.s.got().includes("200 Connection Established"); i++) await Bun.sleep(10);
    t.s.send("over tls");
    for (let i = 0; i < 200 && !t.s.got().includes("over tls"); i++) await Bun.sleep(10);
    expect(t.s.got()).toContain("over tls");
    expect(t.dialed).toEqual(["127.0.0.1"]);
  });

  test("refuses an agent it lends nothing to, and a computer in system mode, without dialing", async () => {
    const t = await setup();
    expect(await errorCode(() => t.open("a2"))).toBe("not_allowed");
    const sys = await setup({ system: true });
    expect(await errorCode(() => sys.open("a1"))).toBe("not_allowed");
    expect(t.s.ready()).toBe(false);
    expect(sys.s.ready()).toBe(false);
  });
});

test("the agent's Chrome takes the proxy script before the page it opens, and none without one", () => {
  const pac = "data:application/x-ns-proxy-autoconfig;base64,AAAA";
  const args = chromeLaunchArgs("150.0.0.0", "/p", "linux", null, false, "about:blank", 0, undefined, false, pac);
  expect(args).toContain(`--proxy-pac-url=${pac}`);
  expect(args.at(-1)).toBe("about:blank");
  expect(chromeLaunchArgs("150.0.0.0", "/p", "linux", null).some((a) => a.startsWith("--proxy"))).toBe(false);
});

test("the agents a site is lent to: handles listed here, ids of agents on other computers, or every agent", () => {
  const here = [{ id: "11111111-2222-4333-8444-555555555555", handle: "dev", name: "Dev" }];
  const elsewhere = "AAAAAAAA-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  expect(relayAgentIds(here, ["@dev", elsewhere])).toEqual({
    ids: ["11111111-2222-4333-8444-555555555555", elsewhere.toLowerCase()],
  });
  expect(relayAgentIds(here, [], true)).toEqual({ ids: ["*"] });
  expect(relayAgentIds(here, ["sales"])).toEqual({ unknown: "sales" });
});
