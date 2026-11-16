import { expect, test } from "bun:test";
import { ACP_ENGINE_PROTOCOL } from "@agenteschat/adapters";
import {
  acpBrainOption,
  brainOptions,
  defaultBrainModel,
  isBrainKind,
  normalizeBrainModel,
} from "../src/brain-settings";
import { AcpBrain, type BrainTurnRequest, type ComputerBrainLink } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, UNAVAILABLE_CODES } from "../src/brains/select";
import { BRAIN_NAMES, type BrainEvent, type BrainTurn, isComputerBrain, isSandboxedBrain } from "../src/brains/types";
import type { MachineStatus } from "../src/machine-hub";
import { isCliFailure, runErrorDetail } from "../src/runs";

const SESSION = "0193aaaa-0000-7000-8000-00000000acp1";
const VIBE = { id: "vibe", name: "Mistral Vibe", models: [{ id: "vibe/devstral-3", label: "Devstral 3" }] };

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: "0193aaaa-0000-7000-8000-000000000001",
  orgId: "org",
  agentId: "agent",
  channelId: "channel",
  threadRootId: null,
  system: "You are Dev.",
  messages: [{ role: "user", content: "run the tests" }],
  tools: [],
  trigger: "run the tests",
  session: { id: SESSION, resume: false, machineId: "m1", cwd: "" },
  ...over,
});

function link(opts: {
  protocol?: number;
  engines?: { id: string; name: string }[];
  tools?: { claude: boolean; codex: boolean; commands: boolean };
  events?: BrainEvent[];
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? ACP_ENGINE_PROTOCOL,
        executors: { acp: opts.engines ?? [VIBE] },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const brain = (l: ComputerBrainLink, engine: string | null = "vibe", permissions?: BrainTurnRequest["permissions"]) =>
  new AcpBrain({
    link: l,
    engine,
    mcp: async () => ({ token: "tok" }),
    ...(permissions ? { permissions: async () => permissions } : {}),
  });

test("an ACP turn goes to the runner as kind acp with the engine the agent chose and its model", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 550, output: 20, source: "plan", cacheRead: 50 },
      { type: "done", text: "All good.", session: { id: "x" } },
    ],
  });
  const events = await collect(brain(l).run(turn({ model: "vibe/devstral-3" }), io()));
  expect(l.sent[0]).toMatchObject({ kind: "acp", engine: "vibe", model: "vibe/devstral-3", session: { id: SESSION } });
  expect(l.sent[0]?.account).toBeUndefined();
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
});

test("an ACP turn is refused before the runner: older runner, engine not declared, commands off, an account", async () => {
  const first = async (l: ComputerBrainLink, engine: string | null = "vibe", t: Partial<BrainTurn> = {}) =>
    (await collect(brain(l, engine).run(turn(t), io())))[0];
  expect(await first(link({ protocol: ACP_ENGINE_PROTOCOL - 1 }))).toMatchObject({ code: "runner_outdated" });
  expect(await first(link({ engines: [] }))).toMatchObject({ code: "acp_engine_missing" });
  expect(await first(link({}), "zed")).toMatchObject({ code: "acp_engine_missing" });
  expect(await first(link({}), null)).toMatchObject({ code: "acp_engine_missing" });
  // Its switch is the computer's commands switch, not Codex's.
  expect(await first(link({ tools: { claude: true, codex: true, commands: false } }))).toMatchObject({
    code: "tool_off",
  });
  expect(await first(link({ tools: { claude: false, codex: false, commands: true } }), "vibe")).not.toMatchObject({
    code: "tool_off",
  });
  expect(await first(link({}), "vibe", { account: { id: "a", label: "x", status: "active" } })).toMatchObject({
    code: "acp_account",
  });
  expect(UNAVAILABLE_CODES.has("acp_engine_missing")).toBe(true);
  expect(NO_AI_CODES.has("acp_engine_missing")).toBe(true);
});

test("an ACP agent can't be kept to reads: plan turns, and agents that always ask, are refused with why", async () => {
  for (const permissions of [{ mode: "plan" as const }, { mode: "work" as const, asks: "always" as const }]) {
    const l = link({});
    const [first] = await collect(brain(l, "vibe", permissions).run(turn(), io()));
    expect(first).toMatchObject({ type: "error", code: "acp_profile" });
    expect(l.sent).toHaveLength(0);
  }
});

test("Quem pensa: the ACP option lists the engines the computer declares, each with the models it offered", () => {
  const machine = (over: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      name: "mac",
      execAllowed: true,
      protocol: ACP_ENGINE_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      executors: { acp: [VIBE, { id: "zed", name: "Zed agent" }], detectedAt: "x" },
      ...over,
    }) as never;
  const option = (m: unknown) => acpBrainOption(m as never);
  // Apart from the CLIs: the apps read every kind in `options` as a plan's.
  expect(brainOptions(machine()).some((o) => o.kind === "acp")).toBe(false);
  expect(option(machine())).toMatchObject({
    available: true,
    defaultModel: null,
    models: [],
    engines: [
      { id: "vibe", name: "Mistral Vibe", models: [{ value: "vibe/devstral-3", label: "Devstral 3" }] },
      { id: "zed", name: "Zed agent", models: [] },
    ],
  });
  expect(option(machine({ protocol: ACP_ENGINE_PROTOCOL - 1 }))).toMatchObject({
    available: false,
    reason: "runner_old",
  });
  expect(option(machine({ executors: { detectedAt: "x" } }))).toMatchObject({
    available: false,
    reason: "not_installed",
    engines: [],
  });
  expect(option(machine({ access: { tools: { claude: true, codex: true, commands: false } } }))).toMatchObject({
    available: false,
    reason: "tool_off",
  });
  expect(defaultBrainModel("acp")).toBeNull();
  // Any id the agent listed: ACP agents' ids hold `/` and `:`.
  expect(normalizeBrainModel("acp", "vibe/devstral-3:latest")).toBe("vibe/devstral-3:latest");
  expect(isBrainKind("acp") && isComputerBrain("acp")).toBe(true);
  expect(BRAIN_NAMES.acp).toBe("ACP agent");
  expect(isSandboxedBrain("acp")).toBe(false);
});

test("availability: a computer that declares no ACP agent has nothing to think with", () => {
  const status = {
    name: "mac",
    online: true,
    execAllowed: true,
    protocol: ACP_ENGINE_PROTOCOL,
    pairedByUserId: "u1",
    executors: { acp: [VIBE], detectedAt: new Date().toISOString() },
  } as unknown as MachineStatus;
  expect(computerBrainUnavailable("acp", "m1", status)).toBeNull();
  expect(
    computerBrainUnavailable("acp", "m1", { ...status, executors: { detectedAt: new Date().toISOString() } } as never),
  ).toMatchObject({ code: "acp_engine_missing" });
  expect(
    computerBrainUnavailable("acp", "m1", { ...status, protocol: ACP_ENGINE_PROTOCOL - 1 } as never),
  ).toMatchObject({ code: "runner_outdated" });
});

test("an ACP agent's failed turn is that agent's, never the computer's", () => {
  expect(isCliFailure("acp_failed")).toBe(true);
  expect(runErrorDetail("acp_failed")).toEqual({ errorCode: "run.cli_stopped", errorParams: { brain: "ACP agent" } });
});
