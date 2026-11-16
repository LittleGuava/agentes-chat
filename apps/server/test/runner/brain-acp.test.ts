import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters";
import { parseExecutors } from "@agenteschat/adapters/machine-protocol";
import { acpLook } from "../../runner/acp-engines";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import { type AcpEngineConfig, normalizeStored, parseAcpEngineConfigs } from "../../runner/config";
import { cachedExecutors } from "../../runner/executors";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const ENV_NAMES = ["FAKE_ACP_LOG", "FAKE_ACP_MODELS", "FAKE_ACP_STORE", "FAKE_ACP_MODE", "ANTHROPIC_API_KEY"];
afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  removeDirs(dirs);
});

const FAKE = path.join(import.meta.dir, "fake-acp.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000a1";
const SESSION = "0193cccc-0000-7000-8000-0000000000a1";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff00a1", handle: "dev" };

/** Every engine starts as the fake, whatever its command: its arguments are the engine's own. */
const fakeSpawn: Spawn = ((_file, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn;

const VIBE: AcpEngineConfig = {
  id: "vibe",
  name: "Mistral Vibe",
  // A program that is there, so it starts as it is on every system (a bare name goes through cmd.exe on Windows).
  command: process.execPath,
  args: ["--stdio"],
  env: { FAKE_ENGINE_VAR: "from-config" },
};

interface Logged {
  start?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  text?: string;
  args?: string[];
  cwd?: string;
  anthropicKey?: string | null;
  engineVar?: string | null;
  permissionAnswer?: unknown;
}
const logOf = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Logged)
    : [];
const methods = (file: string) => logOf(file).flatMap((l) => (l.method ? [l.method] : []));

function setup(engines: AcpEngineConfig[] = [VIBE]) {
  const root = tempDir("brain-acp-");
  dirs.push(root);
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  for (const d of [ws, home]) mkdirSync(d, { recursive: true });
  const log = path.join(root, "acp.log");
  process.env.FAKE_ACP_LOG = log;
  process.env.FAKE_ACP_STORE = path.join(root, "sessions.json");
  return {
    log,
    ctx: {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      codex: { runnerHome: home, runs: new Map(), spawn: fakeSpawn, acpEngines: engines },
    },
  };
}

const turn = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.turn",
    runId: RUN,
    kind: "acp",
    engine: "vibe",
    session: { id: SESSION, resume: false },
    cwd: "",
    system: "You are Dev, the team's developer.",
    prompt: "run the tests",
    mcp: { token: "tok_run" },
    agent: AGENT,
    ...over,
  }) as MachineRequest;

async function runTurn(ctx: object, req: MachineRequest) {
  const events: CodexBrainEvent[] = [];
  const scope = {
    signal: new AbortController().signal,
    output: () => {},
    emit: (f: { type: string; event?: CodexBrainEvent }) => f.type === "brain.event" && f.event && events.push(f.event),
  };
  const reply = (await handleRequest(ctx as never, req, scope as never)) as { final: CodexBrainEvent };
  return { final: reply.final, events };
}

// ── What the computer declares ────────────────────────────────────────────────

test("config.json's acpEngines: valid entries load, broken ones are left out, the rest stay", () => {
  const engines = parseAcpEngineConfigs([
    { id: "vibe", name: "  Mistral   Vibe ", command: "/opt/vibe/vibe-acp", args: ["--stdio"], env: { A: "1" } },
    { id: "vibe", name: "Again", command: "other" },
    { id: "Bad Id", command: "x" },
    { id: "nocmd", command: "  " },
    { id: "badargs", command: "x", args: ["ok", 3] },
    { id: "badenv", command: "x", env: { "NOT A NAME": "1" } },
    { id: "zed", command: "zed-agent" },
  ]);
  expect(engines).toEqual([
    { id: "vibe", name: "Mistral Vibe", command: "/opt/vibe/vibe-acp", args: ["--stdio"], env: { A: "1" } },
    { id: "zed", name: "zed", command: "zed-agent", args: [], env: {} },
  ]);
  expect(parseAcpEngineConfigs("nope")).toEqual([]);
  expect(parseAcpEngineConfigs(Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, command: "x" })))).toHaveLength(8);
  // Kept when the runner rewrites its config (an access change, a pause).
  expect(normalizeStored({ acpEngines: [{ id: "zed", command: "zed-agent" }] }).acpEngines).toEqual([
    { id: "zed", name: "zed", command: "zed-agent", args: [], env: {} },
  ]);
});

test("what reaches the server is each engine's id, name and models, never its command", () => {
  const parsed = parseExecutors({
    acp: [
      {
        id: "vibe",
        name: "Mistral Vibe",
        command: "/opt/vibe/vibe-acp",
        args: ["--secret"],
        env: { KEY: "x" },
        models: [{ id: "vibe/devstral-3", label: "Devstral 3" }, { id: "bad id!" }],
      },
      { id: "BAD", name: "x" },
      { id: "zed" },
    ],
  });
  expect(parsed.acp).toEqual([
    { id: "vibe", name: "Mistral Vibe", models: [{ id: "vibe/devstral-3", label: "Devstral 3" }] },
    { id: "zed", name: "zed" },
  ]);
  expect(JSON.stringify(parsed)).not.toContain("vibe-acp");
});

// ── The models the agent itself offers ────────────────────────────────────────

for (const way of ["config", "models"] as const) {
  test(`a look lists the models a session offers (${way === "config" ? "a model config option" : "models.availableModels"}), with no prompt`, async () => {
    const { log } = setup();
    process.env.FAKE_ACP_MODELS = way;
    const info = await acpLook(VIBE, { spawn: fakeSpawn });
    expect(info).toEqual({
      id: "vibe",
      name: "Mistral Vibe",
      models: [
        { id: "vibe/devstral-3", label: "Devstral 3" },
        { id: "vibe/mistral-large-4", label: "Mistral Large 4" },
      ],
    });
    expect(methods(log)).toEqual(["initialize", "session/new"]);
    expect(logOf(log).find((l) => l.method === "session/new")?.params).toMatchObject({ mcpServers: [] });
  });
}

test("an engine that offers no models, or doesn't answer, is still announced, with none", async () => {
  setup();
  process.env.FAKE_ACP_MODELS = "none";
  expect(await acpLook(VIBE, { spawn: fakeSpawn })).toEqual({ id: "vibe", name: "Mistral Vibe" });
  process.env.FAKE_ACP_MODE = "CRASH";
  expect(await acpLook(VIBE, { spawn: fakeSpawn, timeoutMs: 3000 })).toEqual({ id: "vibe", name: "Mistral Vibe" });
});

test("the executors look carries the declared engines to hello", async () => {
  const cache = cachedExecutors({
    run: async () => ({ status: null, stdout: "", error: Object.assign(new Error("gone"), { code: "ENOENT" }) }),
    acp: async () => [{ id: "vibe", name: "Mistral Vibe", models: [{ id: "vibe/devstral-3" }] }],
  });
  const found = await cache.ready();
  expect(found.acp).toEqual([{ id: "vibe", name: "Mistral Vibe", models: [{ id: "vibe/devstral-3" }] }]);
  expect(found.claude).toBeUndefined();
});

// ── Turns ─────────────────────────────────────────────────────────────────────

test("a work turn: the context leads a new session, our bridge goes with it, its own tools are recorded, ours aren't", async () => {
  const { ctx, log } = setup();
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-for-this-engine";
  const { final, events } = await runTurn(ctx, turn());
  expect(final).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toEqual(["read_file"]);
  expect(events.find((e) => e.type === "usage")).toEqual({
    type: "usage",
    input: 550,
    output: 20,
    source: "plan",
    cacheRead: 50,
  });
  const [start] = logOf(log);
  // Started with the engine's own arguments and env, never another brain's key.
  expect(start).toMatchObject({ start: true, args: ["--stdio"], engineVar: "from-config", anthropicKey: null });
  expect(methods(log)).toEqual(["initialize", "session/new", "session/prompt"]);
  expect(logOf(log).find((l) => l.method === "session/new")?.params).toMatchObject({
    mcpServers: [
      {
        name: CODEX_MCP_SERVER,
        args: ["mcp", "--run", RUN],
        env: expect.arrayContaining([{ name: "AGENTES_MCP_TOKEN", value: "tok_run" }]),
      },
    ],
  });
  const said = logOf(log).find((l) => l.method === "session/prompt")?.text ?? "";
  expect(said.startsWith("You are Dev, the team's developer.")).toBe(true);
  expect(said.endsWith("run the tests")).toBe(true);
});

test("the next turn of the conversation goes on in the agent's session, without the context again", async () => {
  const { ctx, log } = setup();
  await runTurn(ctx, turn());
  const { final } = await runTurn(ctx, turn({ prompt: "and now?", session: { id: SESSION, resume: true } }));
  expect(final).toMatchObject({ type: "done", text: "All good." });
  const loads = logOf(log).filter((l) => l.method === "session/load");
  const created = logOf(log).filter((l) => l.method === "session/new");
  expect(created).toHaveLength(1);
  expect(loads).toHaveLength(1);
  const prompts = logOf(log).filter((l) => l.method === "session/prompt");
  expect(prompts[1]?.text).toBe("and now?");
  expect(prompts[1]?.params).toBeUndefined();
});

for (const way of ["config", "models"] as const) {
  test(`the agent's model is chosen the way its session offers it (${way})`, async () => {
    const { ctx, log } = setup();
    process.env.FAKE_ACP_MODELS = way;
    const { final } = await runTurn(ctx, turn({ model: "vibe/mistral-large-4" }));
    expect(final).toMatchObject({ type: "done" });
    const set = logOf(log).find((l) => l.method === "session/set_config_option" || l.method === "session/set_model");
    expect(set?.method).toBe(way === "config" ? "session/set_config_option" : "session/set_model");
    expect(set?.params).toMatchObject(
      way === "config" ? { configId: "model", value: "vibe/mistral-large-4" } : { modelId: "vibe/mistral-large-4" },
    );
  });
}

test("a model the agent doesn't offer ends the turn with what it said", async () => {
  const { ctx } = setup();
  const { final } = await runTurn(ctx, turn({ model: "nope/model" }));
  expect(final).toMatchObject({ type: "error", code: "acp_failed" });
  expect((final as { message: string }).message).toContain("Mistral Vibe here doesn't offer nope/model");
});

test("a permission the agent asks for in a work turn is allowed once", async () => {
  const { ctx, log } = setup();
  const { final } = await runTurn(ctx, turn({ prompt: "ASK" }));
  expect(final).toMatchObject({ type: "done" });
  expect(logOf(log).find((l) => l.permissionAnswer)?.permissionAnswer).toEqual({
    outcome: { outcome: "selected", optionId: "once" },
  });
});

test("a limit and a refused sign-in end the turn by the agent's words", async () => {
  const { ctx } = setup();
  const limit = await runTurn(ctx, turn({ prompt: "LIMIT" }));
  expect(limit.final).toMatchObject({ type: "error", code: "plan_limit" });
  expect(limit.events.some((e) => e.type === "limit")).toBe(true);
  const auth = await runTurn(ctx, turn({ runId: RUN.replace(/1$/, "2"), prompt: "AUTH" }));
  expect(auth.final).toMatchObject({ type: "error", code: "not_logged_in" });
});

test("plan and chat turns, an engine the computer doesn't declare and an account are refused before anything starts", async () => {
  const { ctx, log } = setup();
  const plan = await runTurn(ctx, turn({ permissions: { mode: "plan" } }));
  expect(plan.final).toMatchObject({ type: "error", code: "acp_profile" });
  const chat = await runTurn(ctx, turn({ permissions: { mode: "chat" } }));
  expect(chat.final).toMatchObject({ type: "error", code: "acp_profile" });
  const other = await runTurn(ctx, turn({ engine: "zed" }));
  expect(other.final).toMatchObject({ type: "error", code: "acp_engine_missing" });
  // System mode declares none (ADR 0216 §7).
  const none = await runTurn({ ...ctx, codex: { ...ctx.codex, acpEngines: [] } }, turn());
  expect(none.final).toMatchObject({ type: "error", code: "acp_engine_missing" });
  await expect(runTurn(ctx, turn({ account: "0193eeee-0000-7000-8000-0000000000a1" }))).rejects.toThrow(
    "keeps its own sign-in",
  );
  expect(logOf(log)).toEqual([]);
});

test("with commands off on the computer, no ACP agent runs", async () => {
  const { ctx, log } = setup();
  await expect(runTurn({ ...ctx, exec: false }, turn())).rejects.toThrow(/turned off/);
  expect(logOf(log)).toEqual([]);
});
