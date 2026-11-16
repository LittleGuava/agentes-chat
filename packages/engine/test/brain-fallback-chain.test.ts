import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  drainOutbox,
  getAgentBrain,
  listMessages,
  type MachineStatus,
  postPersonMessage,
  setAgentBrain,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0118 addendum (2026-11-15): an agent's reserve AIs. When the plan it thinks with is at its limit or signed out,
 * the next account of its chain answers instead, the reply says which, and the next conversation goes back to the
 * agent's own plan once it has room again.
 */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  return f?.close();
});

const PRIMARY = "0193eeee-0000-4000-8000-000000000001";
const RESERVE = "0193eeee-0000-4000-8000-000000000002";
const SECOND = "0193eeee-0000-4000-8000-000000000003";

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: ACCOUNTS_PROTOCOL,
  executors: {
    claude: { version: "2.1.300", loggedIn: true },
    codex: { version: "0.170.0" },
    detectedAt: new Date().toISOString(),
  },
});

/** The agent thinks with Claude Code on the account "Principal"; "Reserva" (and maybe more) wait on the same computer. */
async function agentWithReserves(
  fx: Fixture,
  reserves: { id: string; label: string; kind?: string; status?: string }[],
  over: Partial<typeof schema.agents.$inferInsert> = {},
) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  const machineId = paired.machineId;
  await fx.db.insert(schema.machineAccounts).values([
    { id: PRIMARY, orgId: fx.org.id, machineId, kind: "claude_code", label: "Principal", createdBy: fx.owner.id },
    ...reserves.map((r) => ({
      id: r.id,
      orgId: fx.org.id,
      machineId,
      kind: r.kind ?? "claude_code",
      label: r.label,
      status: r.status ?? "active",
      createdBy: fx.owner.id,
    })),
  ]);
  await fx.db
    .update(schema.agents)
    .set({
      machineId,
      brain: "claude_code",
      brainAccountId: PRIMARY,
      brainFallbackChain: reserves.map((r) => ({ accountId: r.id })),
      ...over,
    })
    .where(eq(schema.agents.id, fx.agent.id));
  return machineId;
}

/** A computer brain whose turns answer per account: `limited` accounts refuse at once at their plan's limit. */
function brainByAccount(kind: "claude_code" | "codex", limited: Set<string | undefined>) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind,
    async *run(turn) {
      seen.push({ ...turn, system: "", messages: [] });
      const events: BrainEvent[] = limited.has(turn.account?.id)
        ? [
            { type: "limit", resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
            { type: "error", code: "plan_limit", message: "You've hit your limit.", worked: false },
          ]
        : [{ type: "done", text: `Respondi com ${turn.account?.label ?? "a conta do computador"}.` }];
      yield* events;
    },
  };
  return { brain, seen };
}

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const timeline = (fx: Fixture) => listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);

test("the plan at its limit: the reserve answers, the reply says which, and the API is never called", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  await agentWithReserves(f, [{ id: RESERVE, label: "Reserva" }]);
  const { brain, seen } = brainByAccount("claude_code", new Set([PRIMARY]));
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen.map((t) => t.account?.id)).toEqual([PRIMARY, RESERVE]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("claude_code");
  const reply = (await timeline(f)).at(-1);
  expect(reply?.body).toBe("Respondi com Reserva.");
  expect(reply?.meta.brainReserve).toMatchObject({
    from: { brain: "claude_code", account: "Principal" },
    to: { brain: "claude_code", account: "Reserva", accountId: RESERVE },
    code: "plan_limit",
  });
  expect(reply?.meta.brainFallback).toBeUndefined();
  expect(f.provider.calls.length).toBe(0);
  // The reserve thinks in a session of its own: the plan's session lives in the other account's folder.
  expect(seen[1]?.session?.id).not.toBe(seen[0]?.session?.id);
  expect(seen[1]?.session?.resume).toBe(false);
});

test("the next conversation goes back to the agent's own plan once its limit has reset", async () => {
  f = await setup({});
  await agentWithReserves(f, [{ id: RESERVE, label: "Reserva" }]);
  const limited = new Set<string | undefined>([PRIMARY]);
  const { brain, seen } = brainByAccount("claude_code", limited);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // Still at its limit: the next message goes straight to the reserve, with no turn spent on the plan.
  await post(f, "@dev e agora?");
  await drainOutbox(f.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([PRIMARY, RESERVE, RESERVE]);

  // The plan reset: the agent thinks with its own plan again, and its reply carries no reserve line.
  limited.clear();
  clearPlanLimits();
  await post(f, "@dev voltou?");
  await drainOutbox(f.db, handlers);
  expect(seen.at(-1)?.account?.id).toBe(PRIMARY);
  const reply = (await timeline(f)).at(-1);
  expect(reply?.body).toBe("Respondi com Principal.");
  expect(reply?.meta.brainReserve).toBeUndefined();
});

test("a signed-out plan goes to the reserve before any turn, and a limited reserve hands on to the next one", async () => {
  f = await setup({});
  await agentWithReserves(f, [
    { id: RESERVE, label: "Reserva" },
    { id: SECOND, label: "Codex", kind: "codex" },
  ]);
  await f.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, PRIMARY));
  const claude = brainByAccount("claude_code", new Set([RESERVE]));
  const codex = brainByAccount("codex", new Set());
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => claude.brain, codex: () => codex.brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(claude.seen.map((t) => t.account?.id)).toEqual([RESERVE]);
  expect(codex.seen.map((t) => t.account?.id)).toEqual([SECOND]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("codex");
  const reply = (await timeline(f)).at(-1);
  expect(reply?.body).toBe("Respondi com Codex.");
  expect(reply?.meta.brainReserve).toMatchObject({
    from: { brain: "claude_code", account: "Principal" },
    to: { brain: "codex", account: "Codex", accountId: SECOND },
  });
});

test("every reserve unavailable: the run does what it did before (here, waits for the plan)", async () => {
  f = await setup({});
  await agentWithReserves(f, [{ id: RESERVE, label: "Reserva", status: "signed_out" }], { brainFallback: false });
  const { brain, seen } = brainByAccount("claude_code", new Set([PRIMARY]));
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen.map((t) => t.account?.id)).toEqual([PRIMARY]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect((run?.transcript as { reserve?: unknown } | undefined)?.reserve).toBeUndefined();
});

test("settings: an ordered list of the agent's own or the workspace's accounts on its computer, audited", async () => {
  f = await setup({});
  const machineId = await agentWithReserves(f, []);
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const BIAS = "0193eeee-0000-4000-8000-0000000000b1";
  await f.db.insert(schema.machineAccounts).values([
    { id: RESERVE, orgId: f.org.id, machineId, kind: "claude_code", label: "Reserva", createdBy: f.owner.id },
    { id: SECOND, orgId: f.org.id, machineId, kind: "codex", label: "Codex", createdBy: f.owner.id },
    { id: BIAS, orgId: f.org.id, machineId, kind: "claude_code", label: "Bia", createdBy: bia.id, serves: "owner" },
  ]);
  const deps = { db: f.db };
  const set = (fallbackChain: unknown) => setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { fallbackChain });

  const saved = await set([{ accountId: SECOND }, { accountId: RESERVE, model: "opus" }]);
  expect(saved.fallbackChain).toEqual([{ accountId: SECOND }, { accountId: RESERVE, model: "opus" }]);
  expect((await getAgentBrain(deps, f.owner.id, f.org.id, f.agent.id)).fallbackChain.map((e) => e.accountId)).toEqual([
    SECOND,
    RESERVE,
  ]);
  const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.brain"));
  expect(audit?.details).toMatchObject({ to: { reserves: [{ accountId: SECOND }, { accountId: RESERVE }] } });

  // Its own account, the same one twice, Bia's plan kept to herself, an unknown account, too many: refused.
  for (const bad of [
    [{ accountId: PRIMARY }],
    [{ accountId: RESERVE }, { accountId: RESERVE }],
    [{ accountId: BIAS }],
    [{ accountId: "0193eeee-0000-4000-8000-0000000000ff" }],
    [{ accountId: RESERVE }, { accountId: SECOND }, { accountId: BIAS }, { accountId: PRIMARY }],
    "nope",
  ]) {
    await expect(set(bad)).rejects.toBeInstanceOf(ValidationError);
  }

  // Thinking with a reserve's account from now on drops it from the reserves.
  const moved = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { account: RESERVE });
  expect(moved.fallbackChain).toEqual([{ accountId: SECOND }]);
  expect((await set([])).fallbackChain).toEqual([]);
});
