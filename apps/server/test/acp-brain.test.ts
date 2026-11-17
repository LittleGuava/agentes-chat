import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

// ADR 0216: what a runner declares reaches "Quem pensa" through the app API, and nothing of its command does.

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "linux",
  arch: "x64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/home/w/agentes",
};
const EXECUTORS = {
  claude: { version: "2.1.304" },
  acp: [
    {
      id: "vibe",
      name: "Mistral Vibe",
      // A runner never sends these; one that did is not believed.
      command: "/home/me/.local/bin/vibe-acp",
      args: ["--secret-flag"],
      models: [{ id: "vibe/devstral-3", label: "Devstral 3" }],
    },
  ],
  detectedAt: new Date().toISOString(),
};

interface AcpView {
  brain: string;
  engine?: string;
  model: string | null;
  options: { kind: string }[];
  acp?: { available: boolean; reason?: string; engines: { id: string; name: string; models: { value: string }[] }[] };
}

async function withComputer() {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const hub = t.engine.machineHub;
  const conn = hub.open({ send() {}, close() {} });
  await hub.message(
    conn,
    JSON.stringify({ type: "hello", token: mac.token, ...RUNNER, exec: true, executors: EXECUTORS }),
  );
  expect(
    (await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } })).status,
  ).toBe(200);
  return { api, agentId, channelId };
}

test("the brain view lists the ACP agents the computer declares, apart from options, without their commands", async () => {
  const { api, agentId } = await withComputer();
  const got = await api(`/agents/${agentId}/brain`);
  expect(got.status).toBe(200);
  const text = await got.text();
  expect(text).not.toContain("vibe-acp");
  expect(text).not.toContain("--secret-flag");
  const view = JSON.parse(text) as AcpView;
  expect(view.acp).toMatchObject({
    available: true,
    engines: [{ id: "vibe", name: "Mistral Vibe", models: [{ value: "vibe/devstral-3" }] }],
  });
  expect(view.options.map((o) => o.kind)).not.toContain("acp");
});

test("PUT …/brain chooses one by its id with a model it offered; one the computer doesn't declare is refused", async () => {
  const { api, agentId } = await withComputer();
  const refused = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "acp", engine: "zed" } });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("brain.invalid_engine");

  const chosen = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "acp", engine: "vibe", model: "vibe/devstral-3" },
  });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toMatchObject({ brain: "acp", engine: "vibe", model: "vibe/devstral-3" });
  expect(await (await api(`/agents/${agentId}/brain`)).json()).toMatchObject({ brain: "acp", engine: "vibe" });
});

test("a routine of an agent on an ACP agent says it thinks there, not through the API", async () => {
  const { api, agentId, channelId } = await withComputer();
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "acp", engine: "vibe" } });
  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Resuma o dia",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    },
  });
  expect(created.status).toBe(201);
  const list = (await (await api("/routines")).json()) as {
    routines: { brain: { kind: string; machineName: string | null } }[];
  };
  expect(list.routines[0]?.brain).toEqual({ kind: "acp", machineName: "mac" });
});

test("what the apps send once it thinks with one keeps that one: a model alone, with its brain, and its settings", async () => {
  const { api, agentId } = await withComputer();
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "acp", engine: "vibe" } });
  for (const json of [
    // The web's model screen.
    { brain: "acp", model: "vibe/devstral-3" },
    // The phone's model screen.
    { model: null },
    // The web's "Mais opções".
    { brain: "acp", fallback: true },
    { brain: "acp", effort: "high", contextTokens: null },
  ]) {
    const put = await api(`/agents/${agentId}/brain`, { method: "PUT", json });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ brain: "acp", engine: "vibe" });
  }
  expect(await (await api(`/agents/${agentId}/brain`)).json()).toMatchObject({
    brain: "acp",
    engine: "vibe",
    model: null,
  });
});

test("the agent list names the ACP agent it thinks with and that agent's model, as the apps say it", async () => {
  const { api, agentId } = await withComputer();
  await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "acp", engine: "vibe", model: "vibe/devstral-3" },
  });
  const { agents } = (await (await api("/agents")).json()) as {
    agents: { id: string; brain?: { kind: string; engine?: string; model: string | null } }[];
  };
  expect(agents.find((a) => a.id === agentId)?.brain).toMatchObject({
    kind: "acp",
    engine: "Mistral Vibe",
    model: "Devstral 3",
  });
});
