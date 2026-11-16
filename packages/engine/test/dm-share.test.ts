import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  buildRunContext,
  createChannel,
  drainOutbox,
  insertMessage,
  joinChannel,
  listAudit,
  listDms,
  listMessages,
  listNotifications,
  NotFoundError,
  openDm,
  postPersonMessage,
  type SharedDm,
  searchForUser,
  shareDm,
  sharedDmOf,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 10, minute));

/** Ana's DM with Dev: two lines of talk, and what isn't talk (a notice for the agent, a card the server words). */
async function dmWithDev(fx: Fixture) {
  const dm = await openDm(fx.db, fx.owner.id, fx.org.id, { agentId: fx.agent.id });
  const say = (who: "ana" | "dev", body: string, minute: number, meta?: Record<string, unknown>) =>
    insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: dm.id,
      author:
        who === "ana"
          ? { type: "person", userId: fx.owner.id }
          : { type: "agent", agentId: fx.agent.id, runId: null, hop: 0, stretchId: null },
      body,
      createdAt: at(minute),
      ...(meta ? { meta } : {}),
    });
  await say("ana", "Can we ship the launch-plan-zebra on Friday?", 1);
  await say("dev", "Yes: the review passes on Thursday.", 2);
  await say("dev", "internal note for the agent", 3, { notice: { kind: "proposal_result", text: "x" } });
  await say("dev", "Dev has no AI", 4, { bodyCode: "no_ai", noAi: { reason: "no_key" } });
  // Cards waiting on a click and progress lines: the agent's words, but not talk.
  await say("dev", "Approve the deploy?", 5, { approvalId: "00000000-0000-4000-8000-000000000001" });
  await say("dev", "Which day?", 6, { questionId: "00000000-0000-4000-8000-000000000002" });
  await say("dev", "I need the token", 7, { secretRequestId: "00000000-0000-4000-8000-000000000003" });
  await say("dev", "Still building the report", 8, { workUpdate: { step: 1 } });
  return dm;
}

const share = (fx: Fixture, dmId: string, to: { channelId: string } | { userId: string }, by = fx.owner.id) =>
  shareDm({ db: fx.db, pubsub: fx.pubsub }, by, fx.org.id, dmId, { to, note: "Our plan for Friday" });

describe("sharing a DM with an agent (a read-only copy)", () => {
  test("the copy lands in a channel with the talk in order, and the DM stays closed", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await joinChannel(f.db, bia.id, f.org.id, f.general.id);
    const dm = await dmWithDev(f);

    const { channelId, message } = await share(f, dm.id, { channelId: f.general.id });
    expect(channelId).toBe(f.general.id);
    expect(message.body).toBe("Our plan for Friday");

    const seen = await listMessages(f.db, bia.id, f.org.id, f.general.id);
    const copy = seen.find((m) => m.id === message.id);
    const shared = sharedDmOf(copy?.meta) as SharedDm;
    expect(shared.agent).toEqual({ id: f.agent.id, name: "Dev", handle: "dev" });
    expect(shared.count).toBe(2);
    expect(shared.omitted).toBe(0);
    expect(shared.lines.map((l) => [l.author.type, l.author.name, l.body])).toEqual([
      ["person", "ana", "Can we ship the launch-plan-zebra on Friday?"],
      ["agent", "Dev", "Yes: the review passes on Thursday."],
    ]);
    expect(shared.lines[0]?.at).toBe(at(1).toISOString());
    // The copy names no DM: nothing in it opens the conversation itself.
    expect(JSON.stringify(shared)).not.toContain(dm.id);
    // Bia reads the copy, never the DM.
    await expect(listMessages(f.db, bia.id, f.org.id, dm.id)).rejects.toThrow();
  });

  test("the copy wakes no agent, even one its note names, and its words stay out of search", async () => {
    f = await setup({ embeddings: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await joinChannel(f.db, bia.id, f.org.id, f.general.id);
    const dm = await dmWithDev(f);
    await shareDm({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      to: { channelId: f.general.id },
      note: "@dev look at this",
    });
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.channelId, f.general.id)));
    expect(runs).toEqual([]);
    const hits = await searchForUser({ db: f.db, search: f.search, gateway: f.gateway }, bia.id, f.org.id, {
      text: "zebra",
    });
    expect(hits).toEqual([]);
    // The note is the message's text, searched like any other.
    const note = await searchForUser({ db: f.db, search: f.search, gateway: f.gateway }, bia.id, f.org.id, {
      text: "look at this",
    });
    expect(note.length).toBeGreaterThan(0);
    // The words themselves are searchable where they were said: Ana finds them in her DM.
    const own = await searchForUser({ db: f.db, search: f.search, gateway: f.gateway }, f.owner.id, f.org.id, {
      text: "zebra",
    });
    expect(own.length).toBeGreaterThan(0);
  });

  test("an agent asked in the channel afterwards reads the note, never the copy", async () => {
    f = await setup();
    const dm = await dmWithDev(f);
    await share(f, dm.id, { channelId: f.general.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev what do you think?",
    });
    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.channelId, f.general.id)));
    expect(run).toBeDefined();
    const context = JSON.stringify(
      await buildRunContext(f.db, run as NonNullable<typeof run>, f.agent, { maxMessages: 30 }),
    );
    expect(context).toContain("Our plan for Friday");
    expect(context).not.toContain("zebra");
  });

  test("to one person: it lands in our DM, unread for them, and nobody else reads it", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const dm = await dmWithDev(f);

    const { channelId } = await share(f, dm.id, { userId: bia.id });
    const ours = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    expect(channelId).toBe(ours.id);
    const listed = (await listDms(f.db, bia.id, f.org.id)).find((d) => d.channelId === ours.id);
    expect(listed?.unread).toBe(1);
    // Bia is told, as for any message in a DM.
    await drainOutbox(f.db, f.handlers);
    const inbox = (await listNotifications({ db: f.db }, bia.id, f.org.id)).items;
    expect(inbox.some((n) => n.source.channelId === ours.id || n.source.dmId === ours.id)).toBe(true);
    const [copy] = await listMessages(f.db, bia.id, f.org.id, ours.id);
    expect(sharedDmOf(copy?.meta)?.count).toBe(2);
    await expect(listMessages(f.db, caio.id, f.org.id, ours.id)).rejects.toThrow();
  });

  test("only the person of a DM with an agent shares it, and only where they talk", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await dmWithDev(f);
    // Someone else's DM: not found, as if it weren't there.
    await expect(share(f, dm.id, { channelId: f.general.id }, bia.id)).rejects.toThrow(NotFoundError);
    // A DM between people holds the other one's words: not shared this way.
    const people = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    await expect(share(f, people.id, { channelId: f.general.id })).rejects.toMatchObject({
      code: "dm_share.not_agent_dm",
    });
    // A channel is not a DM.
    await expect(share(f, f.general.id, { userId: bia.id })).rejects.toThrow(NotFoundError);
    // A channel Ana doesn't belong to, though as the owner she could read it.
    const theirs = await createChannel(f.db, bia.id, f.org.id, { name: "bias-room" });
    await expect(share(f, dm.id, { channelId: theirs.id })).rejects.toThrow(NotFoundError);
    // Into the DM itself, or into another DM with an agent: neither is a place to share with people.
    await expect(share(f, dm.id, { channelId: dm.id })).rejects.toMatchObject({ code: "dm_share.target" });
    await expect(share(f, dm.id, { userId: f.owner.id })).rejects.toThrow(ValidationError);
    // A DM with nothing to share in it.
    const empty = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
    await expect(share(f, empty.id, { channelId: f.general.id }, bia.id)).rejects.toMatchObject({
      code: "dm_share.empty",
    });
  });

  test("the audit log says it happened, never what was said", async () => {
    f = await setup();
    const dm = await dmWithDev(f);
    const { message } = await share(f, dm.id, { channelId: f.general.id });
    const { rows } = await listAudit(f.db, f.owner.id, f.org.id);
    const row = rows.find((r) => r.action === "dm.shared");
    expect(row?.target).toMatchObject({ type: "message", id: message.id });
    expect(row?.details).toMatchObject({ agentId: f.agent.id, toChannelId: f.general.id, lines: 2 });
    expect(JSON.stringify(row)).not.toContain("zebra");
    expect(JSON.stringify(row)).not.toContain("Our plan");
  });
});
