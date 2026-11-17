import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import {
  createSiteRelay,
  createStreamBroker,
  getAgentComputer,
  type MachineHub,
  type StreamSocket,
  setAgentComputerTarget,
  siteRelayFromDb,
  siteRelayHooks,
  withRelaySites,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { fakeSocket } from "./stream-fixtures";

/**
 * ADR 0203 through the hub: the person's computer reports what it lends, the agent's computer hears its sites in
 * its `agents` frame, asks for a tunnel and gets one whose far end the person's computer was asked to dial.
 */

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
});

const RUNNER = { hostname: "pc", os: "linux", arch: "x64", version: "0.9.0", workspace: "/home/ana/agentes" };
const TOOLS = { claude: false, codex: false, commands: true };
type Request = Extract<ServerFrame, { type: "request" }>;

function fakeRunner(hub: MachineHub, onRequest: (req: Request) => unknown = () => ({})) {
  const sent: ServerFrame[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type !== "request") return;
      setTimeout(async () => {
        const data = await onRequest(frame);
        void reply({ type: "result", id: frame.id, ok: true, data });
      }, 1);
    },
    close() {
      void hub.close(conn);
    },
  });
  return {
    sent,
    /** The runner's socket drops (the computer slept, or lost its network). */
    drop: () => hub.close(conn),
    send: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string, access: Record<string, unknown>) =>
      reply({ type: "hello", token, ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION, exec: true, access }),
    last: <T extends ServerFrame["type"]>(type: T) =>
      sent.filter((s): s is Extract<ServerFrame, { type: T }> => s.type === type).at(-1),
  };
}

const socket = (): StreamSocket & { got: Uint8Array[] } => {
  const got: Uint8Array[] = [];
  return {
    got,
    send: (d) => {
      if (typeof d !== "string") got.push(d);
    },
    close: () => undefined,
    buffered: () => 0,
  };
};

const waitFor = async (check: () => unknown) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
};

test("the agent's computer hears the sites a person's computer lends it, and gets a tunnel through it", async () => {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const deps = { db: f.db, pubsub: f.pubsub };
  const relay = createSiteRelay({ hub, ...siteRelayFromDb(f.db) });
  hub.setRelayHooks({
    want: (machine, frame) => relay.want(machine, frame),
    agents: (orgId, machineId, agents) => withRelaySites(f.db, orgId, machineId, agents),
  });

  const agentsComputer = await pairMachine(deps, f.owner.id, f.org.id, { name: "Server", ...RUNNER, exec: true });
  const home = await pairMachine(deps, f.owner.id, f.org.id, { name: "Ana's PC", ...RUNNER, exec: true });
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, agentsComputer.machineId);

  const farEnd = socket();
  const person = fakeRunner(hub, (req) => {
    if (req.op === "relay.open") {
      // The person's runner dials its end of the tunnel, named by the id it was given.
      expect(relay.claim(req.streamId, home.machineId, farEnd)).not.toBeNull();
      return { opened: true };
    }
    return {};
  });
  await person.hello(home.token, { folders: [], tools: TOOLS });
  const agentRunner = fakeRunner(hub);
  await agentRunner.hello(agentsComputer.token, { folders: [], tools: TOOLS });
  await waitFor(() => agentRunner.last("agents"));
  const sitesOfAgent = () => agentRunner.last("agents")?.agents.find((a) => a.id === f.agent.id)?.relay;
  expect(agentRunner.last("agents")?.agents.map((a) => a.id)).toContain(f.agent.id);
  expect(sitesOfAgent()).toBeUndefined();
  // The person grants it while both runners run (`agentes-runner relay allow`): the agent's computer hears it.
  await person.send({
    type: "access.changed",
    access: { folders: [], tools: TOOLS, relay: [{ site: "example.com", agents: [f.agent.id] }] },
  });
  await waitFor(() => sitesOfAgent());
  expect(sitesOfAgent()).toEqual(["example.com"]);
  // The person's own computer isn't told to send its own sites anywhere.
  expect(person.last("agents")?.agents.every((a) => a.relay === undefined)).toBe(true);

  await agentRunner.send({ type: "relay.want", callId: "c1", agentId: f.agent.id, host: "jobs.example.com" });
  await waitFor(() => agentRunner.last("relay.ready"));
  const ready = agentRunner.last("relay.ready");
  if (!ready?.ok) throw new Error(`no tunnel: ${JSON.stringify(ready)}`);
  const asked = person.sent.find((s): s is Request => s.type === "request" && s.op === "relay.open");
  expect(asked).toMatchObject({ op: "relay.open", agentId: f.agent.id });

  const nearEnd = relay.claim(ready.streamId, agentsComputer.machineId, socket());
  nearEnd?.data(new TextEncoder().encode("CONNECT jobs.example.com:443 HTTP/1.1\r\n\r\n"));
  expect(new TextDecoder().decode(farEnd.got[0])).toBe("CONNECT jobs.example.com:443 HTTP/1.1\r\n\r\n");

  // A site the person doesn't lend: refused, and their computer isn't asked.
  await agentRunner.send({ type: "relay.want", callId: "c2", agentId: f.agent.id, host: "other.org" });
  await waitFor(() => agentRunner.last("relay.ready")?.callId === "c2");
  expect(agentRunner.last("relay.ready")).toMatchObject({ callId: "c2", ok: false, error: { code: "relay_none" } });
  expect(person.sent.filter((s) => s.type === "request" && s.op === "relay.open")).toHaveLength(1);

  // The person stops lending it: the agent's computer hears the list again, empty.
  await person.send({ type: "access.changed", access: { folders: [], tools: TOOLS, relay: [] } });
  await waitFor(() => agentRunner.last("agents")?.agents.find((a) => a.id === f.agent.id)?.relay === undefined);
  expect(agentRunner.last("agents")?.agents.find((a) => a.id === f.agent.id)?.relay).toBeUndefined();
});

test("the stream broker hands each end's data socket to the relay by its id, checked against its computer's token", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const agentsComputer = await pairMachine(deps, f.owner.id, f.org.id, { name: "Server", ...RUNNER, exec: true });
  const home = await pairMachine(deps, f.owner.id, f.org.id, { name: "Ana's PC", ...RUNNER, exec: true });
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, agentsComputer.machineId);
  const dial = async (token: string, streamId: string) => {
    const socket = fakeSocket();
    const link = broker.accept(socket.socket);
    await broker.fromRunner(link, JSON.stringify({ type: "stream.hello", token, streamId }));
    return { socket, link };
  };
  let homeDial: Awaited<ReturnType<typeof dial>> | null = null;
  const hub = {
    async call(machineId: string, request: { op: string; streamId: string }) {
      expect(machineId).toBe(home.machineId);
      expect(request.op).toBe("relay.open");
      // The person's runner dials its end with its own token.
      homeDial = await dial(home.token, request.streamId);
      return { opened: true };
    },
  } as unknown as Pick<MachineHub, "call">;
  const relay = createSiteRelay({
    hub,
    machines: async () => [
      {
        id: agentsComputer.machineId,
        kind: "connected",
        online: true,
        protocol: 83,
        paused: false,
        systemMode: false,
        access: null,
      },
      {
        id: home.machineId,
        kind: "connected",
        online: true,
        protocol: 83,
        paused: false,
        systemMode: false,
        access: { relay: [{ site: "example.com", agents: [f.agent.id] }] },
      },
    ],
    agentOn: siteRelayFromDb(f.db).agentOn,
  });
  const broker = createStreamBroker({
    db: f.db,
    hub,
    authorize: async () => ({ refused: 4404, reason: "no person's streams here" }),
    claim: (streamId, machineId, socket) => relay.claim(streamId, machineId, socket),
  });
  try {
    const ready = await relay.want(
      { id: agentsComputer.machineId, orgId: f.org.id },
      { callId: "c1", agentId: f.agent.id, host: "www.example.com" },
    );
    if (!ready.ok) throw new Error(ready.error.message);
    const far = homeDial as Awaited<ReturnType<typeof dial>> | null;
    if (!far) throw new Error("the person's computer didn't dial");
    expect(far.socket.sent).toEqual(['{"type":"stream.ready"}']);
    // The person's token can't take the agent computer's end.
    expect((await dial(home.token, ready.streamId)).socket.closed).not.toBeNull();
    const near = await dial(agentsComputer.token, ready.streamId);
    expect(near.socket.closed).toBeNull();
    await broker.fromRunner(near.link, new TextEncoder().encode("CONNECT www.example.com:443 HTTP/1.1\r\n\r\n"));
    expect(far.socket.sent.at(-1)).toEqual(new TextEncoder().encode("CONNECT www.example.com:443 HTTP/1.1\r\n\r\n"));
    await broker.fromRunner(far.link, new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    expect(near.socket.sent.at(-1)).toEqual(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    broker.runnerClosed(near.link, 1000);
    expect(far.socket.closed).not.toBeNull();
    expect(relay.open).toBe(0);
  } finally {
    broker.stop();
  }
});

/** Two computers on one workspace, the hooks as the server sets them, and the agent working on the first. */
async function twoComputers() {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const deps = { db: f.db, pubsub: f.pubsub };
  hub.setRelayHooks(siteRelayHooks(f.db, createSiteRelay({ hub, ...siteRelayFromDb(f.db) })));
  const agentsComputer = await pairMachine(deps, f.owner.id, f.org.id, { name: "Server", ...RUNNER, exec: true });
  const home = await pairMachine(deps, f.owner.id, f.org.id, { name: "Ana's PC", ...RUNNER, exec: true });
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, agentsComputer.machineId);
  return { hub, agentsComputer, home };
}

const LENT = { folders: [], tools: TOOLS, relay: [{ site: "example.com", agents: ["*"] }] };

test("a site leaves the agent's list while the only computer lending it is away or paused, and comes back with it", async () => {
  const { hub, agentsComputer, home } = await twoComputers();
  const agentRunner = fakeRunner(hub);
  await agentRunner.hello(agentsComputer.token, { folders: [], tools: TOOLS });
  const sites = () => agentRunner.last("agents")?.agents.find((a) => a.id === f.agent.id)?.relay;
  let person = fakeRunner(hub);
  await person.hello(home.token, LENT);
  await waitFor(() => sites());
  expect(sites()).toEqual(["example.com"]);

  // The person's laptop sleeps: its socket drops, and the agent's browser stops sending that site to it.
  await person.drop();
  await waitFor(() => !sites());
  expect(sites()).toBeUndefined();

  person = fakeRunner(hub);
  await person.hello(home.token, LENT);
  await waitFor(() => sites());
  expect(sites()).toEqual(["example.com"]);

  // Paused at the computer: nothing goes through it, so the site leaves the list until it resumes.
  await person.send({ type: "runner.state", paused: { paused: true, until: null } });
  await waitFor(() => !sites());
  expect(sites()).toBeUndefined();
  await person.send({ type: "runner.state", paused: { paused: false } });
  await waitFor(() => sites());
  expect(sites()).toEqual(["example.com"]);
});

test("a person's computer hears the workspace's agents that work elsewhere, by name and by their computer", async () => {
  const { hub, agentsComputer, home } = await twoComputers();
  const agentRunner = fakeRunner(hub);
  await agentRunner.hello(agentsComputer.token, { folders: [], tools: TOOLS });
  const person = fakeRunner(hub);
  await person.hello(home.token, { folders: [], tools: TOOLS });
  await waitFor(() => person.last("agents")?.lendable);
  const lendable = person.last("agents")?.lendable ?? [];
  expect(lendable).toContainEqual(
    expect.objectContaining({ id: f.agent.id, handle: f.agent.handle, name: f.agent.name, machine: "Server" }),
  );
  // Not its own agents (it can't lend to itself), and every entry names its computer.
  await waitFor(() => agentRunner.last("agents")?.lendable);
  expect(agentRunner.last("agents")?.lendable?.some((a) => a.id === f.agent.id)).toBe(false);
  expect(lendable.every((a) => a.machine.length > 0)).toBe(true);
});

test("the agent's page says which sites go through whose computer, and whether it is there", async () => {
  const { hub, agentsComputer, home } = await twoComputers();
  const agentRunner = fakeRunner(hub);
  await agentRunner.hello(agentsComputer.token, { folders: [], tools: TOOLS });
  const person = fakeRunner(hub);
  await person.hello(home.token, { folders: [], tools: TOOLS, relay: [{ site: "example.com", agents: [f.agent.id] }] });
  const view = await getAgentComputer(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(view.relay).toEqual([
    {
      site: "example.com",
      machine: { id: home.machineId, name: "Ana's PC" },
      by: { id: f.owner.id, name: f.owner.name },
      online: true,
    },
  ]);
  await person.drop();
  const away = await getAgentComputer(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(away.relay).toEqual([expect.objectContaining({ site: "example.com", online: false })]);
});
