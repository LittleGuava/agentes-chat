import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  buildRunContext,
  createIncidentToolSource,
  createToolGateway,
  drainOutbox,
  INCIDENT_WAKES_AN_HOUR,
  incidentCause,
  insertMessage,
  liveLodiSwitches,
  lodiLanes,
  lodiSwitches,
  openPersonAgentDm,
  postPersonMessage,
  RETRIES_AN_HOUR,
  RIGHT_HAND,
  RUN_RETRIES,
  runAuthority,
  type ToolContext,
  updateOrgSettings,
} from "../src";
import { reportRunFailure } from "../src/continuation";
import { isAgentOnlyNotice, isQuietNotice, noticeText } from "../src/notices";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

type Run = typeof schema.agentRuns.$inferSelect;

/** `userId` asked @dev in #general, and its run there ended `failed` with `error`. */
async function failed(error: string, userId = f.owner.id, agentId = f.agent.id): Promise<Run> {
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "@dev o build passou?",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 1,
      status: "failed",
      error,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** The right hand's incident notices in its DM with `userId`. */
async function incidents(userId = f.owner.id) {
  const lodi = await lodiOf();
  const dm = await openPersonAgentDm(f.db, f.org.id, userId, lodi.id);
  const rows = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id));
  return rows
    .filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "run_incident")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const refsOf = (m: { meta: Record<string, unknown> } | undefined) =>
  ((m?.meta.notice as { refs?: Record<string, string> } | undefined)?.refs ?? {}) as Record<string, string>;

/** The right hand's turns the incidents started end, so the next incident starts its own. */
async function settleLodi() {
  const lodi = await lodiOf();
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done" })
    .where(and(eq(schema.agentRuns.agentId, lodi.id), eq(schema.agentRuns.status, "queued")));
}

const runsOn = (messageId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));

/** The right hand's turn the incident `m` started: what `retry_run` is called from. */
async function incidentTurn(m: { id: string }): Promise<ToolContext> {
  const [run] = await runsOn(m.id);
  if (!run) throw new Error("the incident woke no turn");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
}

async function retry(ctx: ToolContext, runId: string, why = "the provider was down") {
  const gateway = createToolGateway({ sources: [createIncidentToolSource({ pubsub: f.pubsub })] });
  const res = await gateway.invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: "retry_run",
    input: { run_id: runId, why },
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output as { content: string; isError?: boolean };
}

/** Notices in #general that asked @dev to try again. */
async function retries() {
  const rows = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, f.general.id));
  return rows.filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "run_retry");
}

describe("which failures are incidents", () => {
  test("only causes a later try may pass", () => {
    for (const error of [
      "gave_up: overloaded",
      "gave_up: down@Claude: bad gateway",
      "gave_up: rate_limit@Claude: slow down",
      "empty_reply",
      "runner_failed",
      "timeout",
      "brain_interrupted: The computer stopped answering",
      "cli_failed: Claude Code: boom",
      "cli_closed: Codex: exit 1",
      "claude_failed",
    ])
      expect([error, incidentCause(error)]).not.toEqual([error, null]);
    for (const error of [
      null,
      "budget_exceeded",
      "gave_up: invalid_key@Claude: bad key",
      "gave_up: no_credit@Claude: no credit",
      "gave_up: ours@Claude: no credit",
      "provider_error: rate_limit@Claude: slow down",
      "provider_error: account: invalid provider API key",
      "Stopped after an error: relation does not exist",
      "bad_request",
      "cli_sandbox: Grok Build",
      "stuck",
      "too_many_tool_calls",
      "account_missing",
      "brain_unavailable: Codex is turned off on this computer",
      "Add an API key for Claude in the workspace settings",
      "canceled_by:someone",
      "no_ai",
      "Some message a validation error left",
    ])
      expect([error, incidentCause(error)]).toEqual([error, null]);
  });
});

describe("the incident", () => {
  test("a task that failed on its own tells the right hand in its DM with the person behind it, as theirs", async () => {
    f = await setup({ rightHand: true, reply: () => ({ chunks: [] }) });
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev o build passou?" });
    await drainOutbox(f.db, f.handlers, { maxBatches: 1 });
    const [dev] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
    expect([dev?.status, dev?.error]).toEqual(["failed", "empty_reply"]);
    const [told, ...more] = await incidents();
    expect(more).toHaveLength(0);
    expect(refsOf(told)).toMatchObject({ runId: dev?.id, agentId: f.agent.id, cause: "empty", attempt: "0" });
    expect(isAgentOnlyNotice(told?.meta)).toBe(true);
    // What it reads names the run and how many tries are left, and says what to do with it.
    const reads = noticeText(told?.meta, true) ?? "";
    expect(reads).toContain(dev?.id as string);
    expect(reads).toContain("retry_run");
    expect(reads).toContain(`Retries left: ${RUN_RETRIES}`);
    // Its turn is the person's: the same person as the failed task.
    const [turn] = await runsOn(told?.id as string);
    expect(turn?.agentId).toBe((await lodiOf()).id);
    expect(await runAuthority(f.db, turn as Run)).toEqual({ kind: "person", personId: f.owner.id });
  }, 30_000);

  test("is told once per failed task", async () => {
    f = await setup({ rightHand: true });
    const run = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), run, run.error as string);
    await reportRunFailure(deps(), run, run.error as string);
    expect(await incidents()).toHaveLength(1);
  });

  test("not for a cause only a person fixes, nor with the workspace's switch off", async () => {
    f = await setup({ rightHand: true });
    const budget = await failed("budget_exceeded");
    await reportRunFailure(deps(), budget, "budget_exceeded");
    expect(await incidents()).toHaveLength(0);
    // Off: nothing; on again: the next one is told.
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { incidents: false });
    expect((await lodiSwitches(f.db, f.org.id)).incidents).toBe(false);
    const off = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), off, "gave_up: overloaded");
    expect(await incidents()).toHaveLength(0);
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { incidents: true });
    const on = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), on, "gave_up: overloaded");
    expect(refsOf((await incidents())[0]).runId).toBe(on.id);
  });

  test("not for the right hand's own task, nor one another agent's mention woke, nor one nobody asked for", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const own = await failed("gave_up: overloaded", f.owner.id, lodi.id);
    await reportRunFailure(deps(), own, "gave_up: overloaded");
    // @dev was woken by another agent's message from its run: that agent hears it and decides.
    const asker = await failed("gave_up: overloaded", f.owner.id, lodi.id);
    const mention = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: lodi.id, runId: asker.id, hop: 1 },
      body: "@dev pode olhar o build?",
    });
    const [woken] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: mention.id,
        triggerMessageId: mention.id,
        trigger: "mention",
        hop: 2,
        status: "failed",
        error: "gave_up: overloaded",
      })
      .returning();
    await reportRunFailure(deps(), woken as Run, "gave_up: overloaded");
    // An agent's own message with no run behind it: nobody is at the root.
    const alone = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
      body: "@dev bom dia",
    });
    const [unattended] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: alone.id,
        triggerMessageId: alone.id,
        trigger: "mention",
        hop: 2,
        status: "failed",
        error: "gave_up: overloaded",
      })
      .returning();
    await reportRunFailure(deps(), unattended as Run, "gave_up: overloaded");
    expect(await incidents()).toHaveLength(0);
  });

  test(`starts at most ${INCIDENT_WAKES_AN_HOUR} turns a person an hour; past that it is read with the next`, async () => {
    f = await setup({ rightHand: true });
    for (let n = 0; n <= INCIDENT_WAKES_AN_HOUR; n++) {
      const run = await failed("gave_up: overloaded");
      await reportRunFailure(deps(), run, "gave_up: overloaded");
      await settleLodi();
    }
    const told = await incidents();
    expect(told).toHaveLength(INCIDENT_WAKES_AN_HOUR + 1);
    const woke = await Promise.all(told.map(async (m) => (await runsOn(m.id)).length));
    expect(woke.filter((n) => n === 1)).toHaveLength(INCIDENT_WAKES_AN_HOUR);
    expect(woke.at(-1)).toBe(0);
  });

  test("is a lane with its own workspace switch, on by default", async () => {
    f = await setup({ rightHand: true });
    expect(lodiLanes().some((l) => l.switch === "incidents" && l.live)).toBe(true);
    expect(liveLodiSwitches()).toContain("incidents");
    expect((await lodiSwitches(f.db, f.org.id)).incidents).toBe(true);
  });
});

describe("retry_run", () => {
  test("asks the same agent to try again where it failed, for the same person, once", async () => {
    f = await setup({ rightHand: true });
    const run = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), run, "gave_up: overloaded");
    const [told] = await incidents();
    const ctx = await incidentTurn(told as { id: string });
    const out = await retry(ctx, run.id);
    expect(out.isError).toBeFalsy();
    const [asked] = await retries();
    expect(asked?.authorAgentId).toBe(f.agent.id);
    expect(refsOf(asked)).toMatchObject({ runId: run.id, attempt: "1" });
    expect(isQuietNotice(asked?.meta)).toBe(true);
    expect(isAgentOnlyNotice(asked?.meta)).toBe(false);
    // The right hand's own words stay out of the other agent's turn: only the server's.
    expect(noticeText(asked?.meta, true)).toContain("asked you to try it again");
    expect(noticeText(asked?.meta, true)).not.toContain("the provider was down");
    const [again] = await runsOn(asked?.id as string);
    expect(again?.agentId).toBe(f.agent.id);
    expect(again?.channelId).toBe(f.general.id);
    expect(again?.status).toBe("queued");
    expect(await runAuthority(f.db, again as Run)).toEqual({ kind: "person", personId: f.owner.id });
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.retried"));
    expect(audit.map((a) => [a.targetId, a.onBehalfOfUserId])).toEqual([[again?.id as string, f.owner.id]]);
    expect(audit[0]?.details).toMatchObject({ why: "the provider was down", attempt: 1 });
    // The same failed task again: no.
    const twice = await retry(ctx, run.id);
    expect(twice.isError).toBe(true);
    expect(await retries()).toHaveLength(1);
  });

  test("the retried task reads the same request, however much the channel said since", async () => {
    f = await setup({ rightHand: true });
    const run = await failed("gave_up: overloaded");
    // Hours of an outage later, the channel moved on well past a run's history.
    for (let i = 0; i < 30; i++)
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: `bom dia ${i}`,
      });
    await reportRunFailure(deps(), run, "gave_up: overloaded");
    const [told] = await incidents();
    expect((await retry(await incidentTurn(told as { id: string }), run.id)).isError).toBeFalsy();
    const [asked] = await retries();
    // Under the request itself, which a run always reads.
    expect(asked?.threadId).toBe(run.triggerMessageId);
    const [again] = await runsOn(asked?.id as string);
    if (!again) throw new Error("no retried run");
    const built = await buildRunContext(f.db, again, f.agent, { maxMessages: 10 });
    const said = JSON.stringify(built.messages);
    expect(said).toContain("o build passou?");
    expect(said).toContain("asked you to try it again");
  });

  test(`a task tried ${RUN_RETRIES} times is not tried again: its next incident says so`, async () => {
    f = await setup({ rightHand: true });
    let run = await failed("gave_up: overloaded");
    for (let attempt = 1; attempt <= RUN_RETRIES; attempt++) {
      await reportRunFailure(deps(), run, "gave_up: overloaded");
      const told = (await incidents()).at(-1);
      expect(refsOf(told).attempt).toBe(String(attempt - 1));
      expect((await retry(await incidentTurn(told as { id: string }), run.id)).isError).toBeFalsy();
      await settleLodi();
      const [next] = await runsOn((await retries()).at(-1)?.id as string);
      // The retried task fails again.
      const [again] = await f.db
        .update(schema.agentRuns)
        .set({ status: "failed", error: "gave_up: overloaded" })
        .where(eq(schema.agentRuns.id, next?.id as string))
        .returning();
      if (!again) throw new Error("no retried run");
      run = again;
    }
    await reportRunFailure(deps(), run, "gave_up: overloaded");
    const last = (await incidents()).at(-1);
    expect(refsOf(last)).toMatchObject({ attempt: String(RUN_RETRIES), retriesLeft: "0" });
    expect(noticeText(last?.meta, true)).toContain("Retries left: 0");
    const refused = await retry(await incidentTurn(last as { id: string }), run.id);
    expect(refused.isError).toBe(true);
    expect(await retries()).toHaveLength(RUN_RETRIES);
  });

  test("only a task told in this DM, never one the agent worked on since, and only in the person's own DM", async () => {
    f = await setup({ rightHand: true });
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const ninas = await failed("gave_up: overloaded", nina.id);
    await reportRunFailure(deps(), ninas, "gave_up: overloaded");
    const mine = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), mine, "gave_up: overloaded");
    const [told] = await incidents();
    const ctx = await incidentTurn(told as { id: string });
    // Nina's task was told in her DM, not here.
    expect((await retry(ctx, ninas.id)).isError).toBe(true);
    // Outside the person's own DM (here, #general), nothing.
    expect((await retry({ ...ctx, channelId: f.general.id }, mine.id)).isError).toBe(true);
    // The agent answered there since: trying again would redo it.
    await failed("gave_up: overloaded");
    expect((await retry(ctx, mine.id)).isError).toBe(true);
    expect(await retries()).toHaveLength(0);
  });

  test(`at most ${RETRIES_AN_HOUR} retries a person an hour`, async () => {
    f = await setup({ rightHand: true });
    const runs: Run[] = [];
    for (let n = 0; n <= RETRIES_AN_HOUR; n++) {
      // Each in its own thread, so none is newer than another where it was asked.
      const root = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: `tarefa ${n}`,
      });
      const asked = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "person", userId: f.owner.id },
        body: "@dev o build passou?",
      });
      const [run] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: root.id,
          triggerMessageId: asked.id,
          trigger: "mention",
          hop: 1,
          status: "failed",
          error: "gave_up: overloaded",
        })
        .returning();
      runs.push(run as Run);
    }
    for (const run of runs) await reportRunFailure(deps(), run, "gave_up: overloaded");
    const told = await incidents();
    const ctx = await incidentTurn(told[0] as { id: string });
    const results = [];
    for (const run of runs) results.push((await retry(ctx, run.id)).isError === true);
    expect(results).toEqual([...Array(RETRIES_AN_HOUR).fill(false), true]);
    // Each retry answers in the thread it failed in.
    const asked = await retries();
    expect(asked.map((m) => m.threadId).sort()).toEqual(
      runs
        .slice(0, RETRIES_AN_HOUR)
        .map((r) => r.threadRootId)
        .sort(),
    );
  });

  test("is offered to the right hand only, and not with the switch off", async () => {
    f = await setup({ rightHand: true });
    const run = await failed("gave_up: overloaded");
    await reportRunFailure(deps(), run, "gave_up: overloaded");
    const ctx = await incidentTurn((await incidents())[0] as { id: string });
    const source = createIncidentToolSource({ pubsub: f.pubsub });
    expect((await source.tools(ctx)).map((t) => t.name)).toEqual(["retry_run"]);
    expect(await source.tools({ ...ctx, agentId: f.agent.id })).toEqual([]);
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { incidents: false });
    expect(await source.tools(ctx)).toEqual([]);
  });
});
