import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { desc, eq, schema } from "@agenteschat/db";
import { MODEL_CATALOG } from "@agenteschat/providers";
import {
  addChannelMember,
  type Brain,
  type BrainTurn,
  brainModelFor,
  createJobHandlers,
  deleteAgent,
  drainOutbox,
  ForbiddenError,
  getConversationModel,
  openDm,
  postPersonMessage,
  setConversationModel,
  ValidationError,
  withConversationModel,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * A model chosen for one agent in one conversation (ADR 0032, addendum 2026-11-15): runs there think with it, every
 * other conversation keeps the agent's own, budget and cost stay the agent's.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const say = async (fx: Fixture, body: string, threadId?: string) => {
  const posted = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });
  await drainOutbox(fx.db, fx.handlers);
  return posted;
};

const lastUsage = async (fx: Fixture) => {
  const [row] = await fx.db
    .select({ agentId: schema.usageRecords.agentId, model: schema.usageRecords.model })
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.orgId, fx.org.id))
    .orderBy(desc(schema.usageRecords.createdAt))
    .limit(1);
  return row;
};

test("a run in the conversation thinks with its model, on the agent's budget; back to the default, the agent's own", async () => {
  f = await setup();
  const fx = f;
  const place = { channelId: fx.general.id };
  const view = await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    ...place,
    model: "claude-opus-5-5",
  });
  expect(view.model).toBe("claude-opus-5-5");
  expect(view.label).toBe("Claude Opus 5.5");
  expect(view.canEdit).toBe(true);
  expect(view.options.map((o) => o.value)).toContain("claude-haiku-5-5");

  await say(fx, "@dev oi");
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-opus-5-5");
  expect(await lastUsage(fx)).toEqual({ agentId: fx.agent.id, model: "claude-opus-5-5" });

  const back = await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: null });
  expect(back.model).toBeNull();
  await say(fx, "@dev de novo");
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-sonnet-5-5");
});

test("a thread's own model wins over its channel's, which a thread with none takes", async () => {
  f = await setup();
  const fx = f;
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    model: "claude-haiku-5-5",
  });
  const root = await say(fx, "@dev começa");
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-haiku-5-5");

  const inThread = await getConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    threadId: root.id,
  });
  expect([inThread.model, inThread.inherited]).toEqual([null, "claude-haiku-5-5"]);

  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    threadId: root.id,
    model: "claude-opus-5-5",
  });
  await say(fx, "@dev na thread", root.id);
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-opus-5-5");
  await say(fx, "@dev no canal");
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-haiku-5-5");
});

test("on Automático, the conversation's model is the one it runs", async () => {
  f = await setup();
  const fx = f;
  await fx.db.update(schema.agents).set({ model: "auto" }).where(eq(schema.agents.id, fx.agent.id));
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    model: "claude-haiku-5-5",
  });
  await say(fx, "@dev oi");
  expect(fx.provider.calls.at(-1)?.request.model).toBe("claude-haiku-5-5");
});

test("only a model of the agent's own key, never Automático; a thread of another channel is no place", async () => {
  f = await setup();
  const fx = f;
  const openai = Object.entries(MODEL_CATALOG).find(([, m]) => m.provider === "openai")?.[0];
  if (!openai) throw new Error("no OpenAI model in the catalog");
  const place = { channelId: fx.general.id };
  await expect(
    setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: openai }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: "auto" }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
      ...place,
      threadId: "00000000-0000-7000-8000-000000000000",
      model: "claude-haiku-5-5",
    }),
  ).rejects.toThrow("Thread not found");
});

test("a member who neither owns nor manages the agent sees the choice and can't change it", async () => {
  f = await setup();
  const fx = f;
  const bob = await addMember(fx.db, fx.org.id, "member", "bob");
  await addChannelMember(fx.db, fx.owner.id, fx.org.id, fx.general.id, { userId: bob.id });
  const place = { channelId: fx.general.id };
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: "claude-opus-5-5" });
  const seen = await getConversationModel(fx.db, bob.id, fx.org.id, fx.agent.id, place);
  expect([seen.model, seen.canEdit, seen.options]).toEqual(["claude-opus-5-5", false, []]);
  await expect(
    setConversationModel(fx.db, bob.id, fx.org.id, fx.agent.id, { ...place, model: null }),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("an admin can't choose a model in someone else's DM", async () => {
  f = await setup();
  const fx = f;
  const lia = await addMember(fx.db, fx.org.id, "member", "lia");
  const dm = await openDm(fx.db, lia.id, fx.org.id, { agentId: fx.agent.id });
  await expect(
    setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
      channelId: dm.id,
      model: "claude-opus-5-5",
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("a computer brain's choice is its brainModel, a mission's own still wins, and a brain change passes it over", async () => {
  f = await setup();
  const fx = f;
  const [onCode] = await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "sonnet" })
    .where(eq(schema.agents.id, fx.agent.id))
    .returning();
  if (!onCode) throw new Error("no agent");
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    model: "opus",
  });
  const run = { channelId: fx.general.id };
  const thinks = await withConversationModel(fx.db, onCode, run, null);
  expect(thinks.brainModel).toBe("opus");
  expect(brainModelFor("claude_code", thinks)).toBe("opus");
  expect(brainModelFor("claude_code", thinks, { model: "haiku" })).toBe("haiku");
  // Back on the API key: a Claude Code alias is no API model, so the agent's own stays.
  const onApi = { ...onCode, brain: "model", brainModel: null };
  expect((await withConversationModel(fx.db, onApi, run, null)).model).toBe("claude-sonnet-5-5");
});

test("deleting the agent forgets its conversations' models", async () => {
  f = await setup();
  const fx = f;
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    channelId: fx.general.id,
    model: "claude-opus-5-5",
  });
  await deleteAgent({ db: fx.db, pubsub: fx.pubsub, hub: fx.machineHub }, fx.owner.id, fx.org.id, fx.agent.id);
  const left = await fx.db
    .select()
    .from(schema.conversationModels)
    .where(eq(schema.conversationModels.agentId, fx.agent.id));
  expect(left).toEqual([]);
});

/** The agent on Claude Code on a paired MacBook, with a stand-in brain that keeps what each turn received. */
async function onClaudeCode(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    os: "darwin",
    arch: "arm64",
    hostname: "mac",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", brainModel: "sonnet", ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push({ ...turn, system: "", messages: [] });
      yield { type: "done", text: "Feito." };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => ({
        id,
        orgId: fx.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: 8,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  });
  return { machineId: paired.machineId, seen, handlers };
}

test("a Claude Code run in the conversation is sent its model; back to the default, the agent's own", async () => {
  f = await setup();
  const fx = f;
  const { seen, handlers } = await onClaudeCode(fx);
  const place = { channelId: fx.general.id };
  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: "opus" });
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body: "@dev oi" });
  await drainOutbox(fx.db, handlers);
  expect(seen.at(-1)?.model).toBe("opus");

  await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: null });
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev de novo",
  });
  await drainOutbox(fx.db, handlers);
  expect(seen.length).toBe(2);
  expect(seen.at(-1)?.model).toBe("sonnet");
});

test("on a coding plan's account, only that plan's models; never Automático", async () => {
  f = await setup();
  const fx = f;
  const accountId = crypto.randomUUID();
  const { machineId } = await onClaudeCode(fx);
  await fx.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: fx.org.id,
    machineId,
    kind: "claude_code",
    label: "GLM Coding",
    provider: "zai",
    status: "active",
    createdBy: fx.owner.id,
  });
  await fx.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, fx.agent.id));
  const place = { channelId: fx.general.id };
  const view = await getConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, place);
  expect(view.options.map((o) => o.label)).toContain("GLM-5.3 Flash");
  expect(view.options.some((o) => o.value === "opus" || o.value === "auto")).toBe(false);
  await expect(
    setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ...place, model: "opus" }),
  ).rejects.toBeInstanceOf(ValidationError);
  const chosen = await setConversationModel(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
    ...place,
    model: "glm-5.3-flash[1m]",
  });
  expect(chosen.label).toBe("GLM-5.3 Flash");
});
