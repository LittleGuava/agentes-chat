import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type AgentQueue,
  addChannelMember,
  agentStatuses,
  createAgent,
  createChannel,
  insertMessage,
  openPersonAgentDm,
  queueOnRun,
  releaseInbox,
  takeInbox,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const queueOf = async (userId: string, agentId = f.agent.id) =>
  (await agentStatuses(f.db, userId, f.org.id)).find((s) => s.agentId === agentId)?.queue ?? null;

/** A person's (or an agent's, with no run behind it) message in a conversation. */
const say = (channelId: string, by: { type: "person"; userId: string } | { type: "agent"; agentId: string }) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: by.type === "person" ? by : { ...by, runId: null, hop: 1, stretchId: null },
    body: "pode ver isso?",
  });

/** A run of `agentId` started by `triggerId` in `channelId`, with the given status. */
async function runOf(
  channelId: string,
  triggerId: string,
  status: "queued" | "running" | "waiting_input" = "running",
  agentId = f.agent.id,
) {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 1,
      status,
      startedAt: status === "queued" ? null : new Date(),
      heartbeatAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** @dev at work in #general, asked by Ana (the owner); Bia, a member, reads #general. */
async function atWork() {
  const ask = await say(f.general.id, { type: "person", userId: f.owner.id });
  const run = await runOf(f.general.id, ask.id);
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  return { run, bia };
}

describe("an agent's queue, by who asked (ADR 0084 addendum of 2026-11-15)", () => {
  test("messages waiting in its run's inbox name who sent them, oldest first, each asker once", async () => {
    f = await setup();
    const { run, bia } = await atWork();
    expect(await queueOf(f.owner.id)).toBeNull();

    for (const author of [bia.id, f.owner.id, bia.id]) {
      const m = await say(f.general.id, { type: "person", userId: author });
      expect(await queueOnRun(f.db, run.id, m.id)).toBe(true);
    }
    const queue: AgentQueue = {
      count: 3,
      askers: [
        { type: "person", id: bia.id },
        { type: "person", id: f.owner.id },
      ],
    };
    expect(await queueOf(f.owner.id)).toEqual(queue);
    expect(await queueOf(bia.id)).toEqual(queue);

    // Read at its next step: nothing waits any more.
    await takeInbox(f.db, run.id);
    expect(await queueOf(f.owner.id)).toBeNull();
  });

  test("a run in line (never started, or waiting for room on its computer) counts as its asker's request", async () => {
    f = await setup();
    const { bia } = await atWork();
    const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "produto" });
    await addChannelMember(f.db, f.owner.id, f.org.id, other.id, { agentId: f.agent.id });
    const asked = await say(other.id, { type: "person", userId: f.owner.id });
    const line = await runOf(other.id, asked.id, "queued");
    expect(await queueOf(f.owner.id)).toEqual({ count: 1, askers: [{ type: "person", id: f.owner.id }] });
    // Bia doesn't read #produto: nothing of it, not even a count.
    expect(await queueOf(bia.id)).toBeNull();

    // Started, then in line for its computer's room: still waiting.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input", transcript: { waitingForBrain: { code: "busy" } } })
      .where(eq(schema.agentRuns.id, line.id));
    expect(await queueOf(f.owner.id)).toMatchObject({ count: 1 });
    // Waiting on an answer is no line.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input", transcript: {} })
      .where(eq(schema.agentRuns.id, line.id));
    expect(await queueOf(f.owner.id)).toBeNull();
  });

  test("a DM never shows to anyone else, nor a private channel to who isn't in it", async () => {
    f = await setup();
    const { bia } = await atWork();
    // Bia's DM with @dev: a run there, with a message of hers waiting in it.
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    const first = await say(dm.id, { type: "person", userId: bia.id });
    const dmRun = await runOf(dm.id, first.id);
    const waiting = await say(dm.id, { type: "person", userId: bia.id });
    await queueOnRun(f.db, dmRun.id, waiting.id);
    // A private channel only Ana is in.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const asked = await say(secret.id, { type: "person", userId: f.owner.id });
    await runOf(secret.id, asked.id, "queued");

    expect(await queueOf(bia.id)).toEqual({ count: 1, askers: [{ type: "person", id: bia.id }] });
    // Ana owns the workspace and reads every channel, never someone else's DM.
    expect(await queueOf(f.owner.id)).toEqual({ count: 1, askers: [{ type: "person", id: f.owner.id }] });
  });

  test("a notice, a deleted message and a talk only agents are in are no request", async () => {
    f = await setup();
    const { run } = await atWork();
    const notice = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Resultado da consulta",
      meta: { notice: { kind: "consult_answer" } },
    });
    await queueOnRun(f.db, run.id, notice.id);
    const gone = await say(f.general.id, { type: "person", userId: f.owner.id });
    await queueOnRun(f.db, run.id, gone.id);
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, gone.id));
    // Another agent hands @dev work in their own conversation.
    const infra = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Servers", instructions: "You run them.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const [pair] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, kind: "dm", name: "", dmKey: [f.agent.id, infra.id].sort().join(":") })
      .returning();
    if (!pair) throw new Error("no dm");
    const note = await say(pair.id, { type: "agent", agentId: infra.id });
    await runOf(pair.id, note.id, "queued");
    expect(await queueOf(f.owner.id)).toBeNull();

    // Another agent asking in a channel people read is a request, by that agent.
    const asks = await say(f.general.id, { type: "agent", agentId: infra.id });
    await queueOnRun(f.db, run.id, asks.id);
    expect(await queueOf(f.owner.id)).toEqual({ count: 1, askers: [{ type: "agent", id: infra.id }] });
  });

  test("an agent hidden from the viewer shows no queue; one its run handed on still waits", async () => {
    f = await setup();
    const { run, bia } = await atWork();
    const m = await say(f.general.id, { type: "person", userId: bia.id });
    await queueOnRun(f.db, run.id, m.id);
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, f.agent.id));
    expect(await queueOf(bia.id)).toBeNull();
    expect(await queueOf(f.owner.id)).toMatchObject({ count: 1 });

    // The run ends without reading it: the message gets a run of its own, in line until a worker takes it.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
    const handed = await releaseInbox(f.db, f.pubsub, run, { reason: "done" });
    expect(handed?.messageIds).toEqual([m.id]);
    expect(await queueOf(f.owner.id)).toEqual({ count: 1, askers: [{ type: "person", id: bia.id }] });
  });
});
