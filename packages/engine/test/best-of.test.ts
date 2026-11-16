import { afterEach, expect, test } from "bun:test";
import { and, asc, eq, schema, sql } from "@agenteschat/db";
import { type ModelRequest, ProviderError, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  BURST_JUDGE_JOB,
  drainOutbox,
  judgeBurst,
  listChannels,
  listMessages,
  openDm,
  postPersonMessage,
} from "../src";
import { isAgentOnlyNotice } from "../src/notices";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

/** The conversation as people see it: the apps leave out notices only the agent reads. */
const shown = async () =>
  (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).filter((m) => !isAgentOnlyNotice(m.meta));

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
};

/** The drafts each attempt writes, in the order they are asked; the comparing turn answers "FINAL". */
function drafts(fail?: number) {
  let n = 0;
  return (request: ModelRequest) => {
    const all = request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    if (all.some((t) => t.includes("burst attempts"))) return { chunks: ["FINAL: the best slogan."] };
    // The workspace's background jobs (summaries, reflection) use other words: only the attempts count here.
    if (!lastUserText(request).includes("slogan for the launch")) return { chunks: ["ok"] };
    n += 1;
    if (n === fail) return new ProviderError("model refused", false, 400);
    return { chunks: [`Draft ${n}: rockets for everyone.`] };
  };
}

const runsIn = (channelId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, channelId));

test("/burst N runs the agent N times, each in its own room, then the agent answers once with the best", async () => {
  f = await setup({ reply: drafts() });
  const view = await post("/burst 3 @dev write a slogan for the launch");

  // The person's message is posted as they typed it, and no run answers it directly.
  expect(view.body).toBe("/burst 3 @dev write a slogan for the launch");
  expect(await runsIn(f.general.id)).toHaveLength(0);

  // Three runs of the agent, each in a private room of its own that no person is in.
  const runs = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
  expect(runs).toHaveLength(3);
  expect(new Set(runs.map((r) => r.channelId)).size).toBe(3);
  expect(runs.every((r) => r.agentId === f.agent.id && !r.background)).toBe(true);
  for (const run of runs) {
    const people = await f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, run.channelId), sql`${schema.channelMembers.userId} is not null`));
    expect(people).toHaveLength(0);
  }

  await drainOutbox(f.db, f.handlers);

  // Each attempt read only the request, never another attempt.
  const attemptCalls = f.provider.calls.filter(
    (c) =>
      lastUserText(c.request).includes("slogan for the launch") &&
      !JSON.stringify(c.request.messages).includes("burst attempts"),
  );
  expect(attemptCalls).toHaveLength(3);
  for (const call of attemptCalls) expect(JSON.stringify(call.request.messages)).not.toContain("Draft");

  // The comparing turn read the three drafts, and the person reads one answer, in the conversation they asked in.
  const judging = f.provider.calls.find((c) => JSON.stringify(c.request.messages).includes("burst attempts"));
  const read = JSON.stringify(judging?.request.messages);
  for (const n of [1, 2, 3]) expect(read).toContain(`Draft ${n}: rockets for everyone.`);
  expect(systemText(judging?.request.system ?? "")).toContain("Answer briefly.");
  const all = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(all.filter((m) => isAgentOnlyNotice(m.meta)).map((m) => (m.meta.notice as { kind: string }).kind)).toEqual([
    "burst_results",
  ]);
  const main = await shown();
  expect(main.map((m) => [m.author.type, m.body])).toEqual([
    ["person", "/burst 3 @dev write a slogan for the launch"],
    ["agent", "FINAL: the best slogan."],
  ]);
  const [final] = await runsIn(f.general.id);
  expect(final).toMatchObject({ status: "done", agentId: f.agent.id });

  // The rooms are closed and never show in the person's lists.
  const rooms = await f.db
    .select({ archivedAt: schema.channels.archivedAt })
    .from(schema.channels)
    .where(
      sql`${schema.channels.id} in (${sql.join(
        runs.map((r) => sql`${r.channelId}::uuid`),
        sql`, `,
      )})`,
    );
  expect(rooms.every((r) => r.archivedAt !== null)).toBe(true);
  const listed = await listChannels(f.db, f.owner.id, f.org.id);
  expect(listed.some((c) => runs.some((r) => r.channelId === c.id))).toBe(false);

  // Judged once: running the check again delivers nothing more.
  await judgeBurst({ db: f.db, pubsub: f.pubsub }, f.org.id, view.id, { deadline: true });
  await drainOutbox(f.db, f.handlers);
  expect(await runsIn(f.general.id)).toHaveLength(1);
});

test("an attempt that fails leaves the others to compare", async () => {
  f = await setup({ reply: drafts(2) });
  await post("/burst 2 @dev write a slogan for the launch");
  await drainOutbox(f.db, f.handlers);
  const judging = f.provider.calls.find((c) => JSON.stringify(c.request.messages).includes("burst attempts"));
  const read = JSON.stringify(judging?.request.messages);
  expect(read).toContain("Draft 1: rockets for everyone.");
  expect(read).toContain("did not finish");
  const main = await shown();
  expect(main.map((m) => m.body)).toEqual(["/burst 2 @dev write a slogan for the launch", "FINAL: the best slogan."]);
});

test("its time runs out: what finished is compared and the rest stops", async () => {
  f = await setup({ reply: drafts() });
  const view = await post("/burst 2 @dev write a slogan for the launch");
  // One attempt never gets to work (its job is held back); the other answers.
  const [held] = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3600_000) })
    .where(sql`${schema.outbox.kind} = 'agent_run.execute' and ${schema.outbox.payload}->>'runId' = ${held?.id}`);
  await drainOutbox(f.db, f.handlers);
  expect(await runsIn(f.general.id)).toHaveLength(0);
  const deadline = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, BURST_JUDGE_JOB), eq(schema.outbox.status, "pending")));
  expect(deadline).toHaveLength(1);

  await judgeBurst({ db: f.db, pubsub: f.pubsub }, f.org.id, view.id, { deadline: true });
  await drainOutbox(f.db, f.handlers);
  const [stopped] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, held?.id ?? ""));
  expect(stopped?.status).toBe("canceled");
  const main = await shown();
  expect(main.map((m) => m.body)).toEqual(["/burst 2 @dev write a slogan for the launch", "FINAL: the best slogan."]);
});

test("refused before anything starts when the whole burst doesn't fit the agent's budget", async () => {
  // Fifteen cents a month: room for two tries and the comparing turn, not for three.
  f = await setup({ reply: drafts(), budgetNanoUsd: 150_000_000 });
  await expect(post("/burst 3 @dev write a slogan for the launch")).rejects.toMatchObject({
    code: "burst.over_budget",
  });
  expect(await shown()).toHaveLength(0);
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  // Two tries fit.
  await post("/burst 2 @dev write a slogan for the launch");
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(2);
});

test("a /burst it can't run is refused with what to fix, and nothing is posted", async () => {
  f = await setup({ reply: drafts() });
  await expect(post("/burst 4 @dev write a slogan")).rejects.toMatchObject({ code: "burst.attempts" });
  await expect(post("/burst 1 @dev write a slogan")).rejects.toMatchObject({ code: "burst.attempts" });
  await expect(post("/burst 3 @dev")).rejects.toMatchObject({ code: "burst.no_request" });
  await expect(post("/burst 3 write a slogan")).rejects.toMatchObject({ code: "burst.needs_agent" });
  await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
  await expect(post("/burst 3 @dev write a slogan")).rejects.toMatchObject({ code: "burst.computer_brain" });
  expect(await shown()).toHaveLength(0);
  // Without a number it tries three times; a message that only mentions the word is a message.
  await f.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, f.agent.id));
  await post("/burst @dev write a slogan for the launch");
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(3);
  await post("@dev what is /burst?");
  expect(await runsIn(f.general.id)).toHaveLength(1);
});

test("only someone the agent answers can make it try", async () => {
  f = await setup({ reply: drafts() });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
  await expect(
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "/burst 2 @dev write a slogan for the launch",
    }),
  ).rejects.toMatchObject({ code: "burst.agent_unreachable" });
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
});

test("the workspace's right hand, which answers in every channel, can be asked too", async () => {
  f = await setup({ reply: drafts(), rightHand: true });
  const [hand] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, "right_hand"));
  await post(`/burst 2 @${hand?.handle} write a slogan for the launch`);
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs.map((r) => r.agentId)).toEqual([hand?.id ?? "", hand?.id ?? ""]);
});

test("in a DM with the agent it needs no mention, and its answer comes back there", async () => {
  f = await setup({ reply: drafts() });
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
    body: "/burst 2 write a slogan for the launch",
  });
  await drainOutbox(f.db, f.handlers);
  const said = (await listMessages(f.db, f.owner.id, f.org.id, dm.id)).filter((m) => !isAgentOnlyNotice(m.meta));
  expect(said.map((m) => m.body)).toEqual(["/burst 2 write a slogan for the launch", "FINAL: the best slogan."]);
});

test("files, a quote or a mission's thread: refused, since the attempts couldn't honor them", async () => {
  f = await setup({ reply: drafts() });
  const earlier = await post("the launch is on Friday");
  await expect(
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "/burst 2 @dev write a slogan for the launch",
      replyTo: earlier.id,
    }),
  ).rejects.toMatchObject({ code: "burst.plain_only" });
  await f.db.insert(schema.missions).values({
    orgId: f.org.id,
    threadRootId: earlier.id,
    channelId: f.general.id,
    agentId: f.agent.id,
    ownerId: f.owner.id,
    title: "Launch",
    goal: "Ship it",
    mainSessionId: "s1",
  });
  await expect(
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "/burst 2 @dev write a slogan for the launch",
      threadId: earlier.id,
    }),
  ).rejects.toMatchObject({ code: "burst.mission_thread" });
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  expect((await shown()).map((m) => m.body)).toEqual(["the launch is on Friday"]);
});
