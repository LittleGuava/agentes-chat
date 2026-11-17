import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type RunnerAccess,
  type ServerFrame,
} from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { toMachineError } from "../runner/errors";
import { type HandlerContext, handleRequest } from "../runner/handlers";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";
import { removeDirs, tempDir } from "./runner/helpers";

/*
 * ADR 0215, addendum 2026-11-17, over HTTP: the routes, the engine and the hub, with the runner's own handler on the
 * computer's side of the socket and a real stdio program (`fake-stdio-mcp.mjs`) behind it.
 */

let t: TestServer;
const dirs: string[] = [];
afterEach(async () => {
  await t.close();
  removeDirs(dirs);
});

const FAKE = path.join(import.meta.dir, "runner", "fake-stdio-mcp.mjs");
const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};
const ACCESS = (commands: boolean): RunnerAccess => ({
  folders: [],
  tools: { claude: false, codex: false, commands },
});

/** The computer's side of the socket: every request goes to the runner's handler, in a folder of its own. */
function computer(token: string, commands = true) {
  const home = tempDir("programs-");
  dirs.push(home);
  mkdirSync(home, { recursive: true });
  const access = ACCESS(commands);
  const ctx: HandlerContext = { workspaceReal: home, ownHome: home, exec: true, token, access: () => access };
  const hub = t.engine.machineHub;
  const requests: MachineRequest[] = [];
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      const { type: _type, id, ...request } = frame;
      requests.push(request as MachineRequest);
      void handleRequest(ctx, request as MachineRequest, {
        signal: new AbortController().signal,
        output: () => {},
      }).then(
        (data) => hub.message(conn, JSON.stringify({ type: "result", id, ok: true, data })),
        (err: unknown) =>
          hub.message(conn, JSON.stringify({ type: "result", id, ok: false, error: toMachineError(err) })),
      );
    },
    close() {},
  });
  const hello = () => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, access }));
  return { hello, requests };
}

async function workspace() {
  // No address is looked up for real: every host is a documentation address.
  t = await createTestServer({ resolveHost: async () => ["203.0.113.10"] });
  const b = browser(t);
  await signUp(b, "fabio@example.com");
  const { orgId, channelId, agentId } = await seedOrg(b);
  const api = (p: string, init?: Parameters<typeof b>[1]) => b(`/api/app/organizations/${orgId}${p}`, init);
  return { api, orgId, channelId, agentId };
}

const program = (machineId: string) => ({
  machineId,
  command: process.execPath,
  args: [FAKE],
  env: [{ name: "FAKE_TOKEN", value: "fake-token-value-77" }],
  label: "Notas",
});

test("the person who paired a computer registers a program on it; its variable's value never comes back", async () => {
  const { api } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  const pc = computer(mac.token);
  await pc.hello();
  const listed = (await (await api("/connectors/program-computers")).json()) as { computers: unknown[] };
  expect(listed.computers).toEqual([{ id: mac.machineId, name: "MacBook", available: true }]);
  const res = await api("/connectors/custom/program", { json: program(mac.machineId) });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("fake-token-value-77");
  const server = JSON.parse(text) as {
    id: string;
    label: string;
    authType: string;
    program: { machineId: string };
    headerNames: string[];
    tools: { name: string; access: string | null }[];
  };
  expect(server).toMatchObject({
    label: "Notas",
    authType: "computer",
    program: { machineId: mac.machineId },
    headerNames: ["FAKE_TOKEN"],
  });
  expect(server.tools.map((x) => [x.name, x.access])).toEqual([
    ["echo", null],
    ["read_text", null],
  ]);
  // Listed once on the computer, for no agent.
  expect(pc.requests.filter((r) => r.op === "mcp.stdio").map((r) => [r.agent ?? null])).toEqual([[null]]);
  const all = await (await api("/connectors/custom")).text();
  expect(all).toContain(server.id);
  expect(all).not.toContain("fake-token-value-77");
  // Removing the computer disconnects it.
  expect((await api(`/machines/${mac.machineId}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await api("/connectors/custom")).text()).not.toContain(server.id);
});

test("given to an agent, its tool runs on the computer as that agent through the Tool Gateway; offline it says so", async () => {
  const { api, orgId, channelId, agentId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  const pc = computer(mac.token);
  await pc.hello();
  const server = (await (await api("/connectors/custom/program", { json: program(mac.machineId) })).json()) as {
    id: string;
  };
  const levels = await api(`/connectors/custom/${server.id}/tools`, {
    method: "PUT",
    json: {
      label: "Notas",
      tools: [
        { name: "echo", access: "read", label: "" },
        { name: "read_text", access: "read", label: "" },
      ],
    },
  });
  expect(levels.status).toBe(200);
  const granted = await api(`/agents/${agentId}/access`, {
    method: "PUT",
    json: { all: false, connectors: { [server.id]: true }, scopes: [], tools: { allow: [], deny: [] } },
  });
  expect(granted.status).toBe(200);

  const message = (await (await api(`/channels/${channelId}/messages`, { json: { body: "notas" } })).json()) as {
    id: string;
  };
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const ctx = {
    db: t.db,
    orgId,
    agentId,
    runId: run?.id ?? "",
    channelId,
    threadRootId: message.id,
    triggerMessageId: message.id,
  };
  const listed = (await t.engine.tools.list(ctx)).map((x) => x.name).filter((n) => n.endsWith("echo"));
  expect(listed).toHaveLength(1);
  const name = listed[0] as string;
  const invoke = async () => {
    const out = await t.engine.tools.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input: { said: "oi" } });
    if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
    return out.output as { content: string; isError?: boolean };
  };
  const result = await invoke();
  expect(result.isError).not.toBe(true);
  // What the program said, inside the block outside text comes in.
  expect(result.content).toContain('"arguments":{"said":"oi"}');
  // The variable reached the program, but its value never reaches the agent, even when the program prints it.
  expect(result.content).toContain('"FAKE_TOKEN":"[secret:FAKE_TOKEN]"');
  expect(result.content).not.toContain("fake-token-value-77");
  const calls = pc.requests.filter((r) => r.op === "mcp.stdio" && r.call?.method === "tools/call");
  expect(calls.map((r) => (r.op === "mcp.stdio" ? r.agent?.id : null))).toEqual([agentId]);

  // The computer goes away mid-run: the tool answers in words and the run goes on.
  await t.engine.machineHub.stop();
  const offline = await invoke();
  expect(offline.isError).toBe(true);
  expect(offline.content).toContain("MacBook");
  // "Update" while it's offline keeps the tools turns read, and says why it couldn't list them.
  const refreshed = await api(`/connectors/custom/${server.id}/refresh`, { json: {} });
  expect(refreshed.status).toBe(200);
  const view = (await refreshed.json()) as { tools: { name: string }[]; toolsError?: unknown };
  expect(view.tools.map((x) => x.name)).toEqual(["echo", "read_text"]);
  expect(view.toolsError).toBeTruthy();
  expect(await t.engine.tools.list(ctx).then((all) => all.some((x) => x.name === name))).toBe(true);
});

test("the address form reaches no program: not by a computer:// address, nor by reconnecting one", async () => {
  const { api } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  const pc = computer(mac.token);
  await pc.hello();
  const server = (await (await api("/connectors/custom/program", { json: program(mac.machineId) })).json()) as {
    id: string;
    serverUrl: string;
  };
  const byAddress = await api("/connectors/custom", {
    json: { serverUrl: server.serverUrl, apiKey: "key-12345678", returnTo: "/" },
  });
  expect(byAddress.status).toBe(400);
  expect(await byAddress.json()).toMatchObject({ error: { code: "url.https_required" } });
  const reconnect = await api("/connectors/custom", {
    json: { serverUrl: "https://mcp.example.com/mcp", apiKey: "key-12345678", returnTo: "/", connectionId: server.id },
  });
  expect(reconnect.status).toBe(400);
  expect(await reconnect.json()).toMatchObject({ error: { code: "connector.other_server" } });
  // Only the registration's listing ran there.
  expect(pc.requests.filter((r) => r.op === "mcp.stdio")).toHaveLength(1);
});

test("a computer with Commands off takes no program, and nothing starts there", async () => {
  const { api } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  const pc = computer(mac.token, false);
  await pc.hello();
  const listed = (await (await api("/connectors/program-computers")).json()) as { computers: unknown[] };
  expect(listed.computers).toEqual([{ id: mac.machineId, name: "MacBook", available: false }]);
  const res = await api("/connectors/custom/program", { json: program(mac.machineId) });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "connector.program_computer", params: { computer: "MacBook" } },
  });
  expect(pc.requests.filter((r) => r.op === "mcp.stdio")).toEqual([]);
});
