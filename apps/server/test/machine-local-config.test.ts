import { afterEach, expect, test } from "bun:test";
import {
  LOCAL_CONFIG_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { schema } from "@agenteschat/db";
import type { LocalSetup } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t.close();
});

const RUNNER = { hostname: "box", os: "linux", arch: "x64", version: "0.1.0", workspace: "/srv/agentes" };

const skill = (name: string, body = "Review the diff before merging.") =>
  `---\nname: ${name}\ndescription: ${name} for tests\n---\n\n${body}\n`;

/**
 * What a runner answers, as it comes from the person's computer: a server's values that must never be read,
 * an address with a user and a query, a field nobody asked for.
 */
const ANSWER = {
  files: [
    { app: "claude", path: "~/.claude.json", state: "read" },
    { app: "cursor", path: "~/.cursor/mcp.json", state: "missing" },
    { app: "codex", path: "~/.codex/config.toml", state: "too_big" },
    { app: "claude", path: "~/.claude/skills", state: "read" },
  ],
  servers: [
    {
      app: "claude",
      name: "linear",
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      headers: ["Authorization"],
      env: [],
      query: [],
    },
    {
      app: "claude",
      name: "notes",
      kind: "http",
      url: "https://notes.example.com/mcp",
      headers: [],
      env: [],
      query: [],
    },
    {
      app: "cursor",
      name: "leaky",
      kind: "http",
      url: "https://bob:hunter2@leaky.example.com/mcp?api_key=sk-live-1#x",
      headers: ["X-Key", "bad name with spaces"],
      env: [],
      query: [],
      value: "sk-live-2",
    },
    { app: "cursor", name: "local", kind: "http", url: "http://localhost:3000/mcp", headers: [], env: [], query: [] },
    { app: "cursor", name: "lan", kind: "http", url: "https://10.0.0.5/mcp", headers: [], env: [], query: [] },
    { app: "claude", name: "old", kind: "sse", url: "https://old.example.com/sse", headers: [], env: [], query: [] },
    {
      app: "codex",
      name: "db",
      kind: "stdio",
      command: "/opt/tools/uvx --password hunter3",
      args: ["--password", "hunter4"],
      headers: [],
      env: ["DB_URL"],
      query: [],
    },
    // An older or changed runner that left a key in the path: the server masks it.
    {
      app: "claude",
      name: "hook",
      kind: "http",
      url: "https://hooks.example.com/s/a1B2c3D4e5F6g7H8i9J0k1L2m3/mcp",
      headers: [],
      env: [],
      query: [],
    },
    {
      app: "vscode",
      name: "other",
      kind: "http",
      url: "https://other.example.com/mcp",
      headers: [],
      env: [],
      query: [],
    },
  ],
  skills: [
    { name: "review", markdown: skill("review") },
    {
      name: "deploy",
      markdown: skill("deploy", "Then call it with Authorization: Bearer sk-ant-api03-abcdefghijklmnop0123"),
    },
  ],
  skipped: [{ path: "~/.claude/skills/linked", reason: "link" }],
};

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const orgApi = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  return { owner, orgId, orgApi };
}

/** A computer that answers `local.config` with `answer`, connected now. */
async function connect(token: string, answer: unknown, sent: MachineRequest[], runner: Record<string, unknown>) {
  const hub = t.engine.machineHub;
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "local.config") return;
      sent.push(frame);
      setTimeout(
        () => void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data: answer })),
        1,
      );
    },
    close() {},
  });
  await hub.message(conn, JSON.stringify({ type: "hello", token, ...runner, exec: true }));
}

test("the MCP servers and skills on a person's computer: only they read them, cleaned again, and the skills import", async () => {
  const { owner, orgId, orgApi } = await start();
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com", { role: "admin" });
  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's PC" });
  const sent: MachineRequest[] = [];
  await connect(paired.token, ANSWER, sent, runner);
  await t.db.insert(schema.connectorConnections).values({
    orgId,
    connector: "custom:notes",
    label: "Notes",
    toolPrefix: "notes",
    serverUrl: "https://notes.example.com/mcp",
    authType: "none",
  });
  const path = `/machines/${paired.machineId}/local-config`;

  // Not their computer, even for the workspace's owner: refused before anything reaches it.
  const refused = await orgApi(owner)(path, { json: {} });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("machine.not_owner");
  expect(sent).toHaveLength(0);

  const read = await orgApi(bia)(path, { json: {} });
  expect(read.status).toBe(200);
  // The request names no path: the runner holds the list.
  expect(sent).toEqual([expect.objectContaining({ op: "local.config" })]);
  expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["id", "op", "type"]);
  const setup = (await read.json()) as LocalSetup;
  expect(setup.files).toEqual(ANSWER.files as LocalSetup["files"]);
  expect(setup.servers.map((s) => [s.name, s.state])).toEqual([
    ["linear", "connect"],
    ["notes", "connected"],
    ["leaky", "connect"],
    ["local", "private"],
    ["lan", "private"],
    ["old", "sse"],
    ["db", "stdio"],
    ["hook", "key_in_address"],
  ]);
  expect(setup.servers.find((s) => s.name === "leaky")).toEqual({
    app: "cursor",
    name: "leaky",
    kind: "http",
    url: "https://leaky.example.com/mcp",
    headers: ["X-Key"],
    env: [],
    query: ["api_key"],
    state: "connect",
  });
  expect(setup.servers.find((s) => s.name === "db")).toMatchObject({ command: "?" });
  const wire = JSON.stringify(setup);
  expect(setup.servers.find((s) => s.name === "hook")).toMatchObject({
    url: "https://hooks.example.com/s/***/mcp",
    keyInAddress: true,
  });
  expect(setup.masked).toEqual(["deploy"]);
  const masked = ["sk-ant-api03", "a1B2c3D4e5F6g7H8i9J0k1L2m3"];
  for (const secret of ["hunter2", "hunter3", "hunter4", "sk-live-1", "sk-live-2", "bob", "/opt/tools", ...masked]) {
    expect(wire).not.toContain(secret);
  }
  expect(setup.skipped).toEqual(ANSWER.skipped as LocalSetup["skipped"]);
  expect(setup.bundle.source).toMatchObject({
    app: "claude-code",
    ref: `computer:${paired.machineId}`,
    name: "Bia's PC",
  });
  expect(setup.bundle.skills.map((s) => s.key)).toEqual(["review", "deploy"]);

  // The audit keeps how many, never a name or an address.
  const audit = (await (await orgApi(owner)("/audit")).json()) as {
    rows: { action: string; details: Record<string, unknown> | null }[];
  };
  const entry = audit.rows.find((e) => e.action === "machine.local_config_shown");
  expect(entry?.details).toEqual({ servers: 8, skills: 2 });

  // The skills go through the usual import: planned, applied, and the same again is unchanged.
  const plan = await orgApi(bia)("/imports", { json: { bundle: setup.bundle, dryRun: true } });
  expect(plan.status).toBe(200);
  type Plan = { items: { kind: string; key: string; action: string }[] };
  expect(((await plan.json()) as Plan).items.map((i) => [i.kind, i.key, i.action])).toEqual([
    ["skill", "review", "create"],
    ["skill", "deploy", "create"],
  ]);
  expect((await orgApi(bia)("/imports", { json: { bundle: setup.bundle, dryRun: false } })).status).toBe(200);
  const skills = (await (await orgApi(bia)("/skills")).json()) as { skills: { name: string }[] };
  expect(skills.skills.map((s) => s.name).sort()).toEqual(["deploy", "review"]);
  const again = (await (
    await orgApi(bia)("/imports", { json: { bundle: setup.bundle, dryRun: true } })
  ).json()) as Plan;
  expect(again.items.map((i) => i.action)).toEqual(["unchanged", "unchanged"]);
}, 30_000);

test("an app too old, one in system mode, and an offline computer each say so", async () => {
  const { owner, orgApi } = await start();
  const old = { ...RUNNER, protocol: LOCAL_CONFIG_PROTOCOL - 1 };
  const outdated = await pairComputer(t, orgApi(owner), { ...old, exec: true }, { name: "Old PC" });
  await connect(outdated.token, ANSWER, [], old);
  const tooOld = await orgApi(owner)(`/machines/${outdated.machineId}/local-config`, { json: {} });
  expect(tooOld.status).toBe(400);
  expect(((await tooOld.json()) as { error: { code: string } }).error.code).toBe("machine.local_config_outdated");

  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION };
  const system = await pairComputer(t, orgApi(owner), { ...runner, exec: true }, { name: "Server" });
  await connect(system.token, { files: [], servers: [], skills: [], skipped: [], unsupported: true }, [], runner);
  const unsupported = await orgApi(owner)(`/machines/${system.machineId}/local-config`, { json: {} });
  expect(unsupported.status).toBe(400);
  expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
    "machine.local_config_unsupported",
  );

  const away = await pairComputer(t, orgApi(owner), { ...runner, exec: true }, { name: "Laptop" });
  const offline = await orgApi(owner)(`/machines/${away.machineId}/local-config`, { json: {} });
  expect(offline.status).toBe(409);
  expect(((await offline.json()) as { error: { code: string } }).error.code).toBe("machine.offline");

  // The list says which apps can be asked, so the screens offer it only there.
  const listed = (await (await orgApi(owner)("/machines")).json()) as {
    machines: { id: string; localConfig: boolean }[];
  };
  const flag = (id: string) => listed.machines.find((m) => m.id === id)?.localConfig;
  expect([flag(outdated.machineId), flag(system.machineId), flag(away.machineId)]).toEqual([false, true, true]);
}, 30_000);
