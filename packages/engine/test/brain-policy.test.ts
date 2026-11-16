import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  type Brain,
  createCredential,
  createJobHandlers,
  drainOutbox,
  getOrgSettings,
  listMessages,
  type MachineStatus,
  postPersonMessage,
  resolveBrain,
  setAgentBrain,
  updateAgent,
  updateOrgSettings,
} from "../src";
import { autoModelFor } from "../src/auto-model";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** ADR 0191: a workspace's rule on the brains, providers and models its agents think with, held on the server. */

let f: Fixture;
afterEach(() => f?.close());

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const rule = (fx: Fixture, allowedBrains: Parameters<typeof updateOrgSettings>[3]["allowedBrains"]) =>
  updateOrgSettings(fx.db, fx.owner.id, fx.org.id, { allowedBrains });

const lastRun = async (fx: Fixture) => (await fx.db.select().from(schema.agentRuns)).at(-1);

test("admins set the rule, members read it, and a rule that leaves nothing or names a left-out provider is refused", async () => {
  f = await setup();
  expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).allowedBrains).toBeNull();

  const saved = await rule(f, { brains: ["model", "codex"], providers: ["anthropic"], models: ["claude-sonnet-5-5"] });
  expect(saved.allowedBrains).toEqual({
    brains: ["model", "codex"],
    providers: ["anthropic"],
    models: ["claude-sonnet-5-5"],
  });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  expect((await getOrgSettings(f.db, bia.id, f.org.id)).allowedBrains?.brains).toEqual(["model", "codex"]);
  await expect(updateOrgSettings(f.db, bia.id, f.org.id, { allowedBrains: null })).rejects.toMatchObject({
    name: "ForbiddenError",
  });

  await expect(rule(f, { brains: [], providers: null, models: null })).rejects.toMatchObject({
    code: "brain_policy.invalid",
  });
  await expect(rule(f, { brains: ["telepathy"], providers: null, models: null })).rejects.toMatchObject({
    code: "brain_policy.invalid",
  });
  await expect(rule(f, { brains: null, providers: ["acme-ai"], models: null })).rejects.toMatchObject({
    code: "brain_policy.invalid",
  });
  // A model whose provider the rule leaves out could never run.
  await expect(rule(f, { brains: null, providers: ["anthropic"], models: ["gpt-6-luna"] })).rejects.toMatchObject({
    code: "brain_policy.invalid",
  });
  await expect(rule(f, { brains: null, providers: null, models: ["no-such-model"] })).rejects.toMatchObject({
    code: "brain_policy.invalid",
  });

  // Null lifts it, and each change is audited with what it was.
  expect((await rule(f, null)).allowedBrains).toBeNull();
  const audit = await f.db
    .select({ details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "organization.brain_policy_changed"))
    .orderBy(schema.auditLog.createdAt);
  expect(audit.map((e) => e.details)).toEqual([
    { from: null, to: { brains: ["model", "codex"], providers: ["anthropic"], models: ["claude-sonnet-5-5"] } },
    { from: { brains: ["model", "codex"], providers: ["anthropic"], models: ["claude-sonnet-5-5"] }, to: null },
  ]);
});

test("the gateway refuses an agent's call outside the rule before reading its key, reserving or billing anything", async () => {
  f = await setup();
  const call = () =>
    f.gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: systemText("You help."),
      messages: [{ role: "user", content: "oi" }],
      maxTokens: 500,
      onDelta: () => {},
    });
  await rule(f, { brains: null, providers: ["openai"], models: null });
  await expect(call()).rejects.toMatchObject({ code: "brain.not_allowed" });
  await rule(f, { brains: null, providers: null, models: ["claude-haiku-5-5"] });
  await expect(call()).rejects.toMatchObject({ code: "brain.not_allowed" });
  // The API brain itself left out.
  await rule(f, { brains: ["claude_code"], providers: null, models: null });
  await expect(call()).rejects.toMatchObject({ code: "brain.not_allowed" });
  expect(f.provider.calls).toHaveLength(0);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(0);
  expect(await f.db.select().from(schema.budgetReservations)).toHaveLength(0);

  // Its model listed: it answers.
  await rule(f, { brains: ["model"], providers: ["anthropic"], models: ["claude-sonnet-5-5"] });
  await call();
  expect(f.provider.calls).toHaveLength(1);
});

test("a run on a model outside the rule fails with the rule's words, and nothing is asked of the provider", async () => {
  f = await setup({ reply: () => ({ chunks: ["Oi!"] }) });
  await rule(f, { brains: null, providers: ["openai"], models: null });
  await post(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls).toHaveLength(0);
  const run = await lastRun(f);
  expect(run?.status).toBe("failed");
  expect(run?.error).toContain("workspace's rules");
});

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

/** Pairs a computer and makes it the agent's, thinking with Claude Code. */
async function computerAgent(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

test("a computer brain outside the rule: the run fails at once, never waits for it nor stands in on the API", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  await computerAgent(f);
  const seen: unknown[] = [];
  const brain: Brain = {
    kind: "claude_code",
    // biome-ignore lint/correctness/useYield: the turn must never start, so it yields nothing.
    async *run(turn) {
      seen.push(turn);
    },
  };
  const machines = { status: async (id: string) => statusOf(id) };
  const handlers = createJobHandlers({ ...f.jobDeps, brains: { claude_code: () => brain }, machines });
  await rule(f, { brains: ["model"], providers: null, models: null });

  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const message = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(seen).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);
  const run = await lastRun(f);
  expect(run?.status).toBe("failed");
  expect(run?.error).toContain("Claude Code");
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.some((m) => m.meta.brainFallback)).toBe(false);

  // Where the engine resolves it: unavailable by the rule, so the agent's, a mission's or the right hand's alike.
  if (!agent || !run) throw new Error("no agent or run");
  const plan = await resolveBrain({ db: f.db, machines }, agent, run, message.id);
  expect(plan.unavailable).toMatchObject({ code: "not_allowed" });
});

test("saving a brain or a model outside the rule is refused; one saved before stays, and its page says why", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, f.agent.id));
  await f.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, machineId));
  const deps = { db: f.db, pubsub: f.pubsub };
  await rule(f, { brains: ["model"], providers: ["anthropic"], models: ["claude-sonnet-5-5", "claude-haiku-5-5"] });

  await expect(setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { brain: "claude_code" })).rejects.toMatchObject({
    code: "brain.not_allowed",
  });
  const openai = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-openai-test-1234",
  });
  await expect(
    updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "gpt-6-luna", credentialId: openai.id }),
  ).rejects.toMatchObject({ code: "brain.not_allowed" });
  await expect(updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "claude-opus-5-5" })).rejects.toMatchObject(
    { code: "brain.not_allowed" },
  );
  expect((await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "claude-haiku-5-5" })).model).toBe(
    "claude-haiku-5-5",
  );
  // Automático is the API brain's own choice: allowed while the API brain is.
  expect((await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" })).model).toBe("auto");

  // Tightened later: nothing is rewritten, and the brain view marks what the rule leaves out.
  await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
  const view = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {});
  expect(view.brain).toBe("claude_code");
  expect(view.options.find((o) => o.kind === "claude_code")).toMatchObject({ available: false, reason: "not_allowed" });
  expect(view.options.find((o) => o.kind === "model")).toMatchObject({ available: true });
  expect(view.machines[0]?.options.find((o) => o.kind === "claude_code")?.reason).toBe("not_allowed");
});

test("Automático under the rule: a line of an allowed provider, and on it the allowed model nearest the tier", async () => {
  f = await setup({ reply: () => ({ chunks: ["Oi!"] }) });
  await f.db.update(schema.agents).set({ model: "auto" }).where(eq(schema.agents.id, f.agent.id));
  // Its key is Claude's; the rule allows OpenAI only, one of whose keys the workspace has.
  await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-openai-test-1234",
  });
  await rule(f, { brains: null, providers: ["openai"], models: ["gpt-6-luna"] });
  await post(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls).toHaveLength(0);
  expect(f.openaiProvider.calls.map((c) => c.request.model)).toEqual(["gpt-6-luna"]);
  expect((await lastRun(f))?.status).toBe("done");

  // The tier's own pick when allowed; else the allowed one nearest it; none of that provider: no model.
  const allows = (ids: string[]) => (model: string) => ids.includes(model);
  const medium = autoModelFor("openai", "medium");
  expect(medium).not.toBeNull();
  expect(autoModelFor("openai", "medium", undefined, null, allows([medium as string]))).toBe(medium);
  expect(autoModelFor("openai", "large", undefined, null, allows(["gpt-6-luna"]))).toBe("gpt-6-luna");
  expect(autoModelFor("openai", "medium", undefined, null, allows(["claude-haiku-5-5"]))).toBeNull();
});
