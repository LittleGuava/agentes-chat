import { expect, test } from "bun:test";
import {
  type ClaimedStream,
  createSiteRelay,
  MachineRequestError,
  pickRelay,
  type RelayMachine,
  relaySitesOf,
  type StreamSocket,
} from "../src";

/** ADR 0203: which computer lends a site, and the server pairing two data sockets into one tunnel. */

const lender = (over: Partial<RelayMachine> = {}): RelayMachine => ({
  id: "home",
  kind: "connected",
  online: true,
  protocol: 83,
  paused: false,
  systemMode: false,
  access: { relay: [{ site: "example.com", agents: ["a1"] }] },
  ...over,
});
const agentsComputer: RelayMachine = lender({ id: "cloud", kind: "managed", access: null });

test("a person's own computer lends a site to the agents it names, never the agent's own or a server's", () => {
  const want = { fromMachineId: "cloud", agentId: "a1", host: "jobs.example.com" };
  expect(pickRelay([agentsComputer, lender()], want)).toEqual({ machineId: "home" });
  expect(pickRelay([agentsComputer, lender()], { ...want, agentId: "a2" })).toEqual({ refused: "relay_none" });
  expect(pickRelay([agentsComputer, lender()], { ...want, host: "other.org" })).toEqual({ refused: "relay_none" });
  // The agent's own computer, the server's and the workspace's never lend, nor one in system mode.
  expect(pickRelay([lender()], { ...want, fromMachineId: "home" })).toEqual({ refused: "relay_none" });
  for (const kind of ["host", "managed"]) {
    expect(pickRelay([agentsComputer, lender({ kind })], want)).toEqual({ refused: "relay_none" });
  }
  expect(pickRelay([agentsComputer, lender({ systemMode: true })], want)).toEqual({ refused: "relay_none" });
  // Lent, but away, paused or too old to dial its end.
  for (const over of [{ online: false }, { paused: true }, { protocol: 67 }]) {
    expect(pickRelay([agentsComputer, lender(over)], want)).toEqual({ refused: "relay_offline" });
  }
  expect(pickRelay([agentsComputer, lender({ id: "away", online: false }), lender()], want)).toEqual({
    machineId: "home",
  });
});

test("an agent's computer is told the sites the others lend it", () => {
  const machines = [
    agentsComputer,
    lender(),
    lender({ id: "office", access: { relay: [{ site: "jobs.org", agents: ["*"] }] } }),
  ];
  expect(relaySitesOf(machines, "cloud", "a1")).toEqual(["example.com", "jobs.org"]);
  expect(relaySitesOf(machines, "cloud", "a2")).toEqual(["jobs.org"]);
  expect(relaySitesOf(machines, "home", "a1")).toEqual(["jobs.org"]);
});

test("a site leaves an agent's list while every computer lending it is away, paused or too old to dial", () => {
  for (const over of [{ online: false }, { paused: true }, { protocol: 67 }]) {
    expect(relaySitesOf([agentsComputer, lender(over)], "cloud", "a1")).toEqual([]);
    // Another computer that lends it and is there keeps it listed.
    expect(relaySitesOf([agentsComputer, lender(over), lender({ id: "office" })], "cloud", "a1")).toEqual([
      "example.com",
    ]);
  }
});

/** A data socket as the broker hands it over: what it was sent, and whether it was closed. */
function fakeSocket() {
  const sent: Uint8Array[] = [];
  let closed = false;
  const socket: StreamSocket = {
    send: (d) => {
      if (typeof d !== "string") sent.push(d);
    },
    close: () => {
      closed = true;
    },
    buffered: () => 0,
  };
  return { socket, text: () => sent.map((b) => new TextDecoder().decode(b)).join(""), closed: () => closed };
}

const enc = (s: string) => new TextEncoder().encode(s);

function setup(opts: { answer?: "dial" | "refuse" | "silent"; agentOn?: boolean; pairTimeoutMs?: number } = {}) {
  const calls: unknown[] = [];
  const home = fakeSocket();
  let homeEnd: ClaimedStream | null = null;
  // The relay is made below; the fake hub dials the lending computer's end through it, as the runner would.
  const relay: ReturnType<typeof createSiteRelay> = createSiteRelay({
    hub: {
      call: async (machineId: string, request: unknown) => {
        calls.push({ machineId, request });
        if (opts.answer === "refuse") throw new MachineRequestError("not_allowed", "no");
        if (opts.answer === "silent") throw new MachineRequestError("timeout", "no answer");
        const req = request as { streamId: string };
        homeEnd = relay.claim(req.streamId, machineId, home.socket);
        expect(homeEnd).not.toBeNull();
        return { opened: true };
      },
    } as unknown as Parameters<typeof createSiteRelay>[0]["hub"],
    machines: async () => [agentsComputer, lender()],
    agentOn: async () => opts.agentOn ?? true,
    limits: { pairTimeoutMs: opts.pairTimeoutMs ?? 1000, idleMs: 1000 },
  });
  return { relay, calls, home, homeEnd: () => homeEnd };
}

const WANT = { callId: "c1", agentId: "a1", host: "www.example.com" };
const CLOUD = { id: "cloud", orgId: "org" };

test("a want asks the lending computer for its end, and the two data sockets carry bytes both ways", async () => {
  const { relay, calls, home, homeEnd } = setup();
  const ready = await relay.want(CLOUD, WANT);
  if (!ready.ok) throw new Error(ready.error.message);
  expect(relay.open).toBe(1);
  expect(calls).toEqual([
    { machineId: "home", request: { op: "relay.open", streamId: expect.any(String), agentId: "a1" } },
  ]);
  const browser = fakeSocket();
  // Only from the computer it was minted for, and once.
  expect(relay.claim(ready.streamId, "home", browser.socket)).toBeNull();
  const near = relay.claim(ready.streamId, "cloud", browser.socket);
  if (!near) throw new Error("not claimed");
  expect(relay.claim(ready.streamId, "cloud", fakeSocket().socket)).toBeNull();
  near.data(enc("CONNECT www.example.com:443 HTTP/1.1\r\n\r\n"));
  near.data("a control frame");
  expect(home.text()).toBe("CONNECT www.example.com:443 HTTP/1.1\r\n\r\n");
  homeEnd()?.data(enc("HTTP/1.1 200 Connection Established\r\n\r\n"));
  expect(browser.text()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
  expect(relay.open).toBe(1);
  near.closed();
  expect(home.closed()).toBe(true);
  expect(relay.open).toBe(0);
});

test("no tunnel for an agent that isn't on that computer, a site nobody lends, or a computer that refuses", async () => {
  expect(await setup({ agentOn: false }).relay.want(CLOUD, WANT)).toMatchObject({
    ok: false,
    error: { code: "relay_refused" },
  });
  const none = setup();
  expect(await none.relay.want(CLOUD, { ...WANT, host: "other.org" })).toMatchObject({
    ok: false,
    error: { code: "relay_none" },
  });
  expect(none.calls).toEqual([]);
  const refused = setup({ answer: "refuse" });
  expect(await refused.relay.want(CLOUD, WANT)).toMatchObject({ ok: false, error: { code: "relay_refused" } });
  expect(refused.relay.open).toBe(0);
  const silent = setup({ answer: "silent" });
  expect(await silent.relay.want(CLOUD, WANT)).toMatchObject({ ok: false, error: { code: "relay_offline" } });
});

test("an end that never comes lapses, and the other end is closed", async () => {
  const { relay, home } = setup({ pairTimeoutMs: 30 });
  const ready = await relay.want(CLOUD, WANT);
  if (!ready.ok) throw new Error("no tunnel");
  await Bun.sleep(80);
  expect(home.closed()).toBe(true);
  expect(relay.claim(ready.streamId, "cloud", fakeSocket().socket)).toBeNull();
  expect(relay.open).toBe(0);
});
