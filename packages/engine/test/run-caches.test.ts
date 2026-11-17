import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgentRuns,
  createOutgoingWebhook,
  drainOutbox,
  enableCaches,
  insertMessage,
  notifyAgentNeedsAi,
  postPersonMessage,
  setConversationModel,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * What a run reads from the process's cache instead of the database, as a running server does (`enableCaches`): the
 * model chosen for its conversation, whether its agent has a "no AI" notice open and whether its workspace has an
 * outgoing webhook. Each answer is forgotten by what changes it, so the run right after the change sees it.
 */

let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const say = async (body: string, userId = f.owner.id) => {
  const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body });
  await drainOutbox(f.db, f.handlers);
  return posted;
};

test("a model chosen for the conversation is the next run's, and taken back the agent's own again", async () => {
  f = await setup();
  enableCaches();
  const place = { channelId: f.general.id };
  await say("@dev um");
  const own = f.provider.calls.at(-1)?.request.model;
  expect(own).not.toBe("claude-opus-5-5");

  await setConversationModel(f.db, f.owner.id, f.org.id, f.agent.id, { ...place, model: "claude-opus-5-5" });
  await say("@dev dois");
  expect(f.provider.calls.at(-1)?.request.model).toBe("claude-opus-5-5");

  await setConversationModel(f.db, f.owner.id, f.org.id, f.agent.id, { ...place, model: null });
  await say("@dev três");
  expect(f.provider.calls.at(-1)?.request.model).toBe(own);
});

test("a workspace's first webhook hears of the run that ends right after it is made", async () => {
  f = await setup();
  enableCaches();
  // A run with no webhook anywhere: the process now knows there is none.
  await say("@dev um");
  const { webhook } = await createOutgoingWebhook(
    { db: f.db, pubsub: f.pubsub, keyWrappers: [f.keyWrapper], resolveHost: async () => ["93.184.216.34"] },
    f.owner.id,
    f.org.id,
    { name: "CRM", url: "https://hooks.example.com/agentes", events: ["run.finished"], channelIds: [] },
  );
  const asked = await say("@dev dois");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  if (!run) throw new Error("no run");
  expect(run.status).toBe("done");
  const queued = await f.db
    .select()
    .from(schema.outgoingWebhookDeliveries)
    .where(eq(schema.outgoingWebhookDeliveries.webhookId, webhook.id));
  expect(queued.map((d) => [d.event, d.subjectId])).toEqual([["run.finished", run.id]]);
});

test('a "no AI" notice told after the agent last thought is done by the next run that ends well', async () => {
  f = await setup();
  enableCaches();
  const needsAi = async () =>
    (await f.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_needs_ai");
  // It thought, with no such notice open: the process now knows there is none.
  await say("@dev um");
  expect(await needsAi()).toHaveLength(0);

  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id }).catch(() => {});
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: bia.id },
    body: "@dev oi",
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, trigger, [f.agent.id], "mention"));
  if (!run) throw new Error("no run");
  await notifyAgentNeedsAi({ db: f.db, pubsub: f.pubsub }, run, "not_signed_in", "claude_code");
  const open = await needsAi();
  expect(open.length).toBeGreaterThan(0);
  expect(open.every((n) => n.doneAt === null)).toBe(true);

  await say("@dev dois");
  expect((await needsAi()).every((n) => n.doneAt !== null)).toBe(true);
});
