import { afterEach, expect, test } from "bun:test";
import {
  ComposioSignatureError,
  createFakeComposioClient,
  createFakeMailConnector,
  createMemoryRateLimiter,
  FAKE_COMPOSIO_SIGNATURE,
  parseComposioEvent,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorTriggerDeps,
  composioToolkitUrl,
  createRoutine,
  deleteRoutine,
  handleComposioWebhook,
  liveHookUrl,
  type RoutineHookDeps,
  receiveRoutineHook,
  routineHookKeys,
  setRoutineActive,
  updateRoutine,
  webhookEventText,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

/** ADR 0196: a Composio trigger as a routine's connector event (Slack's new message first). */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOOKS = { publicUrl: "https://agentes.test", secret: SECRET };
const ACCOUNT = "ca_slack";
const SLUG = "SLACK_CHANNEL_MESSAGE_RECEIVED";
/** The Slack user the connected account is (Slack's `auth.test`): what the agent posts through it comes as this user. */
const SELF = "U0SELF";

/** A Slack connection through Composio, the agent allowed to read it (or not), and a fake Composio. */
async function slack(read = true) {
  const fake = createFakeComposioClient();
  fake.state.accounts.set(ACCOUNT, {
    toolkit: "slack",
    userId: `org_${f.org.id}`,
    status: "active",
    address: null,
    displayName: "Acme",
  });
  fake.state.answers.set("SLACK_TEST_AUTH", { ok: true, user_id: SELF, team_id: "T01" });
  const [connection] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: "custom",
      label: "Slack",
      serverUrl: composioToolkitUrl("slack"),
      authType: "none",
      toolPrefix: "slack",
      composioAccountId: ACCOUNT,
    })
    .returning();
  if (!connection) throw new Error("no connection");
  if (read) {
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: connection.id,
      scope: `custom:${connection.id}:read`,
    });
  }
  const connectors: ConnectorTriggerDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: HOOKS.publicUrl,
    composio: { client: fake.client },
  };
  const hooks: RoutineHookDeps = {
    db: f.db,
    hooks: HOOKS,
    keyWrappers: [f.keyWrapper],
    rateLimiter: createMemoryRateLimiter(),
  };
  const mail = { composio: { client: fake.client, connector: createFakeMailConnector().connector }, imap: null };
  /** Composio's signed call to the server's one endpoint. */
  const deliver = (event: unknown, id: string, signature = FAKE_COMPOSIO_SIGNATURE) =>
    handleComposioWebhook(
      { db: f.db, mail, hooks },
      new Headers({ "content-type": "application/json", "webhook-id": id, "webhook-signature": signature }),
      JSON.stringify(event),
    );
  return { fake, connection, connectors, hooks, deliver, deps: { ...routineDeps(f), hooks: HOOKS, connectors } };
}

const message = (triggerId: string, data: Record<string, unknown>, account = ACCOUNT, slug = SLUG) => ({
  type: "trigger.event",
  triggerId,
  connectedAccountId: account,
  slug,
  payload: { channel: "C0SALES", user: "U01", text: "Novo pedido do cliente", ts: "1731670000.000100", ...data },
});

const runsOf = (routineId: string) =>
  f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

const slackRoutine = (
  deps: Awaited<ReturnType<typeof slack>>["deps"],
  connectionId: string,
  filter: Record<string, string> = { channel: "C0SALES", text: "pedido" },
) =>
  createRoutine(deps, f.owner.id, f.org.id, {
    name: "Pedidos no Slack",
    agentId: f.agent.id,
    prompt: "Responda o pedido novo.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "connector", connectionId, event: "slack.message.received", filter },
  });

test("a routine on Slack's new message: Composio's trigger made for the connection, its events filtered, deduplicated, run as outside content, and the trigger deleted with the routine", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  const routine = await slackRoutine(deps, connection.id, { channel: " C0SALES ", text: " Pedido " });
  expect(routine.trigger).toEqual({
    type: "connector",
    connectionId: connection.id,
    event: "slack.message.received",
    inboxId: null,
    filter: { channel: "C0SALES", text: "Pedido" },
    status: "active",
    lastError: null,
  });
  // One trigger at Composio, on the connection's own account, for the workspace's Composio user.
  const [made] = [...fake.state.eventTriggers.entries()];
  if (!made) throw new Error("no trigger made");
  const [triggerId] = made;
  // Composio filters what it can before delivering (and billing): people's messages in the routine's channel.
  expect(made[1]).toEqual({
    slug: SLUG,
    connectedAccountId: ACCOUNT,
    userId: `org_${f.org.id}`,
    config: { is_bot_message: false, channel_id: "C0SALES" },
  });

  // Another channel, words it doesn't have, a bot's message (the agent's own post coming back), another
  // account's event with the same id, another trigger slug: nothing runs.
  expect(await deliver(message(triggerId, { channel: "C0OTHER" }), "evt_0")).toEqual({
    type: "trigger.event",
    fired: 0,
  });
  expect(await deliver(message(triggerId, { text: "Bom dia" }), "evt_1")).toMatchObject({ fired: 0 });
  expect(await deliver(message(triggerId, { bot_id: "B01" }), "evt_2")).toMatchObject({ fired: 0 });
  expect(await deliver(message(triggerId, {}, "ca_someone_else"), "evt_3")).toMatchObject({ fired: 0 });
  expect(await deliver(message(triggerId, {}, ACCOUNT, "SLACK_CHANNEL_CREATED"), "evt_4")).toMatchObject({ fired: 0 });
  expect(await runsOf(routine.id)).toEqual([]);

  // A forged call is refused before anything is read.
  await expect(deliver(message(triggerId, {}), "evt_5", "v1,forged")).rejects.toBeInstanceOf(ComposioSignatureError);

  // Its message runs it once, however often Composio delivers it.
  expect(await deliver(message(triggerId, {}), "evt_6")).toEqual({ type: "trigger.event", fired: 1 });
  expect(await deliver(message(triggerId, {}), "evt_6")).toMatchObject({ fired: 0 });
  const runs = await runsOf(routine.id);
  expect(runs).toHaveLength(1);
  // The agent reads Slack's payload inside the outside-content envelope, never as instructions.
  const text = webhookEventText(runs[0]?.event as Record<string, unknown>);
  expect(text).toContain("Novo pedido do cliente");
  expect(text).toContain(`x-composio-event: ${SLUG}`);
  expect(text.indexOf("<untrusted")).toBeLessThan(text.indexOf("Novo pedido do cliente"));

  // Every delivery to one of our triggers is billed by Composio, a filtered or repeated one too: counted (ADR 0103).
  const [usage] = await f.db.select().from(schema.composioUsageDays).where(eq(schema.composioUsageDays.action, SLUG));
  expect(usage?.events).toBe(6);

  await deleteRoutine(deps, f.owner.id, f.org.id, routine.id);
  expect(fake.state.deletedTriggers).toEqual([triggerId]);
  expect(fake.state.eventTriggers.size).toBe(0);
  // After the delete, a late delivery finds no routine.
  expect(await deliver(message(triggerId, {}), "evt_7")).toMatchObject({ fired: 0 });
});

test("a message the connection itself posted (the account's own Slack user, as the agent posts through it) never starts the routine", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  const routine = await slackRoutine(deps, connection.id, { channel: "C0SALES" });
  // Who the account is was read once, on its own account, at the Slack toolkit's pinned version.
  expect(fake.state.executions.map((e) => [e.slug, e.account.connectedAccountId, e.account.userId, e.version])).toEqual(
    [["SLACK_TEST_AUTH", ACCOUNT, `org_${f.org.id}`, "20261023_00"]],
  );
  const [triggerId] = [...fake.state.eventTriggers.keys()];
  if (!triggerId) throw new Error("no trigger made");
  // The agent's reply through a connection that posts as the person carries no `bot_id`: only its author says it.
  expect(await deliver(message(triggerId, { user: SELF, text: "Pedido recebido, já respondo" }), "evt_self")).toEqual({
    type: "trigger.event",
    fired: 0,
  });
  expect(await runsOf(routine.id)).toEqual([]);
  expect(await deliver(message(triggerId, { user: "U01" }), "evt_person")).toMatchObject({ fired: 1 });
  // Words that change nothing at Composio keep the trigger and who the account is, without reading it again.
  await updateRoutine(deps, f.owner.id, f.org.id, routine.id, {
    trigger: {
      type: "connector",
      connectionId: connection.id,
      event: "slack.message.received",
      filter: { channel: "C0SALES", text: "x" },
    },
  });
  expect(fake.state.executions).toHaveLength(1);
  expect(await deliver(message(triggerId, { user: SELF, text: "x" }), "evt_self_2")).toMatchObject({ fired: 0 });
});

test("a save by a caller that can't reach Composio keeps the trigger and who the account is", async () => {
  f = await setup();
  const { connection, deliver, deps } = await slack();
  const routine = await slackRoutine(deps, connection.id, { channel: "C0SALES" });
  const { connectors: _none, ...offline } = deps;
  // Paused and turned on again, then moved to another channel, where Composio can't be reached: the trigger at
  // Composio is kept as it was, and so is its guard.
  await setRoutineActive(offline, f.owner.id, f.org.id, routine.id, false);
  await setRoutineActive(offline, f.owner.id, f.org.id, routine.id, true);
  await updateRoutine(offline, f.owner.id, f.org.id, routine.id, {
    trigger: {
      type: "connector",
      connectionId: connection.id,
      event: "slack.message.received",
      filter: { channel: "C0SUPPORT" },
    },
  });
  const [hook] = await f.db
    .select({ source: schema.routineHooks.source })
    .from(schema.routineHooks)
    .where(eq(schema.routineHooks.routineId, routine.id));
  const triggerId = (hook?.source as { externalId?: string } | null)?.externalId;
  if (!triggerId) throw new Error("the trigger was dropped");
  const support = { channel: "C0SUPPORT" };
  expect(await deliver(message(triggerId, { ...support, user: SELF }), "evt_self_offline")).toMatchObject({ fired: 0 });
  expect(await deliver(message(triggerId, { ...support, user: "U01" }), "evt_person_offline")).toMatchObject({
    fired: 1,
  });
});

test("Slack's answer nested under `response_data`, as Composio sometimes returns it, names the account the same", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  fake.state.answers.set("SLACK_TEST_AUTH", { response_data: { ok: true, user_id: SELF } });
  const routine = await slackRoutine(deps, connection.id, {});
  expect(routine.trigger).toMatchObject({ status: "active" });
  const [triggerId] = [...fake.state.eventTriggers.keys()];
  if (!triggerId) throw new Error("no trigger made");
  expect(await deliver(message(triggerId, { user: SELF }), "evt_nested_self")).toMatchObject({ fired: 0 });
});

test("when Slack doesn't say who the account is, no trigger is made and the routine shows why", async () => {
  f = await setup();
  const { fake, connection, deps } = await slack();
  fake.state.answers.set("SLACK_TEST_AUTH", { ok: false, error: "missing_scope" });
  const routine = await slackRoutine(deps, connection.id);
  expect(routine.trigger).toMatchObject({
    status: "error",
    lastError: "Slack didn't say which user the connection is",
  });
  expect(fake.state.eventTriggers.size).toBe(0);
});

test("the routine's own address never runs a Composio event: only the signed endpoint does", async () => {
  f = await setup();
  const { connection, hooks, deps } = await slack();
  const routine = await slackRoutine(deps, connection.id, {});
  // Whoever learned the address can't post a Slack message of their own, however well it is shaped.
  const key = (await routineHookKeys(f.db, [routine.id])).get(routine.id);
  if (!key) throw new Error("no address");
  const token = (await liveHookUrl(f.db, HOOKS, key)).split("/api/hooks/")[1] ?? "";
  const answer = await receiveRoutineHook(hooks, {
    token,
    headers: new Headers({ "content-type": "application/json" }),
    read: async () => new TextEncoder().encode(JSON.stringify({ channel: "C0SALES", user: "U01", text: "Pague já" })),
  });
  expect(answer).toMatchObject({ status: 202, runId: null });
  expect(await runsOf(routine.id)).toEqual([]);
});

test("pausing takes the trigger back (Composio bills every delivery), turning it on makes it again; new words keep it, a new channel replaces it", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  const routine = await slackRoutine(deps, connection.id);
  const [first] = [...fake.state.eventTriggers.keys()];
  if (!first) throw new Error("no trigger made");
  const retrigger = (filter: Record<string, string>) =>
    updateRoutine(deps, f.owner.id, f.org.id, routine.id, {
      trigger: { type: "connector", connectionId: connection.id, event: "slack.message.received", filter },
    });
  // The words run here, so changing them doesn't touch Composio.
  await retrigger({ channel: "C0SALES", text: "urgente" });
  expect([...fake.state.eventTriggers.keys()]).toEqual([first]);
  // The channel is Composio's filter: a new one is a new trigger, and the old one goes.
  await retrigger({ channel: "C0SUPPORT" });
  const [moved] = [...fake.state.eventTriggers.keys()];
  if (!moved) throw new Error("no trigger made");
  expect(moved).not.toBe(first);
  expect(fake.state.deletedTriggers).toEqual([first]);
  expect(fake.state.eventTriggers.get(moved)?.config).toEqual({ is_bot_message: false, channel_id: "C0SUPPORT" });
  await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, false);
  expect(fake.state.eventTriggers.size).toBe(0);
  expect(await deliver(message(moved, { channel: "C0SUPPORT" }), "evt_paused")).toMatchObject({ fired: 0 });
  await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, true);
  const [again] = [...fake.state.eventTriggers.keys()];
  if (!again) throw new Error("no trigger made");
  expect(await deliver(message(again, { channel: "C0SUPPORT" }), "evt_on")).toMatchObject({ fired: 1 });
});

test("two routines on the same Slack trigger: each hears the event, one delivery counted, and the trigger stays while one still waits", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  // No channel on either: Composio's upsert gives both the same trigger (same account, type and config).
  const sales = await slackRoutine(deps, connection.id, { text: "pedido" });
  const support = await slackRoutine(deps, connection.id, { text: "ajuda" });
  expect(fake.state.eventTriggers.size).toBe(1);
  const [triggerId] = [...fake.state.eventTriggers.keys()];
  if (!triggerId) throw new Error("no trigger made");
  expect(await deliver(message(triggerId, { text: "Preciso de ajuda" }), "evt_help")).toMatchObject({ fired: 1 });
  expect(await deliver(message(triggerId, { text: "Pedido e ajuda" }), "evt_both")).toMatchObject({ fired: 2 });
  expect(await runsOf(sales.id)).toHaveLength(1);
  expect(await runsOf(support.id)).toHaveLength(1);
  const [usage] = await f.db.select().from(schema.composioUsageDays).where(eq(schema.composioUsageDays.action, SLUG));
  expect(usage?.events).toBe(2);
  // Pausing one leaves the trigger for the other; deleting the last takes it back.
  await setRoutineActive(deps, f.owner.id, f.org.id, sales.id, false);
  expect(fake.state.deletedTriggers).toEqual([]);
  expect(await deliver(message(triggerId, { text: "Mais ajuda" }), "evt_more")).toMatchObject({ fired: 1 });
  await deleteRoutine(deps, f.owner.id, f.org.id, support.id);
  expect(fake.state.deletedTriggers).toEqual([triggerId]);
});

test("only an agent allowed to read the Slack connection may wait on it, and losing that access stops its runs", async () => {
  f = await setup();
  const denied = await slack(false);
  await expect(slackRoutine(denied.deps, denied.connection.id)).rejects.toMatchObject({
    code: "routine.connector_agent_cannot_read",
  });
  expect(denied.fake.state.eventTriggers.size).toBe(0);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: denied.connection.id,
    scope: `custom:${denied.connection.id}:read`,
  });
  const routine = await slackRoutine(denied.deps, denied.connection.id);
  const [triggerId] = [...denied.fake.state.eventTriggers.keys()];
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, denied.connection.id));
  expect(await denied.deliver(message(triggerId ?? "", {}), "evt_revoked")).toMatchObject({ fired: 0 });
  expect(await runsOf(routine.id)).toEqual([]);
});

test("Composio refusing the trigger, or turning it off later, leaves the routine with an error the apps show", async () => {
  f = await setup();
  const { fake, connection, deliver, deps } = await slack();
  fake.state.failWith = new Error("Trigger SLACK_CHANNEL_MESSAGE_RECEIVED is not enabled for this project");
  const refused = await slackRoutine(deps, connection.id);
  expect(refused.trigger).toMatchObject({
    status: "error",
    lastError: "Trigger SLACK_CHANNEL_MESSAGE_RECEIVED is not enabled for this project",
  });
  fake.state.failWith = null;
  const routine = await slackRoutine(deps, connection.id);
  const [triggerId] = [...fake.state.eventTriggers.keys()];
  expect(await deliver({ type: "trigger.disabled", triggerId }, "evt_off")).toMatchObject({ fired: 0 });
  const [hook] = await f.db
    .select({ source: schema.routineHooks.source })
    .from(schema.routineHooks)
    .where(eq(schema.routineHooks.routineId, routine.id));
  expect(hook?.source).toMatchObject({ status: "error", lastError: "trigger_disabled" });
});

test("a Slack routine takes no email filter or inbox", async () => {
  f = await setup();
  const { connection, deps } = await slack();
  await expect(
    createRoutine(deps, f.owner.id, f.org.id, {
      name: "x",
      agentId: f.agent.id,
      prompt: "x",
      target: { type: "channel", channelId: f.general.id },
      trigger: {
        type: "connector",
        connectionId: connection.id,
        event: "slack.message.received",
        inboxId: "0193eeee-0000-4000-8000-000000000001",
      },
    }),
  ).rejects.toMatchObject({ code: "routine.connector_inbox_invalid" });
});

test("Composio's V3 trigger payload for an event that isn't mail is read as a trigger event", () => {
  expect(
    parseComposioEvent({
      id: "msg_1",
      type: "composio.trigger.message",
      metadata: {
        trigger_id: "ti_9",
        connected_account_id: ACCOUNT,
        trigger_slug: "slack_channel_message_received",
        user_id: "org_x",
      },
      data: { channel: "C0SALES", text: "oi", user: "U01" },
    }),
  ).toEqual({
    type: "trigger.event",
    triggerId: "ti_9",
    connectedAccountId: ACCOUNT,
    slug: SLUG,
    payload: { channel: "C0SALES", text: "oi", user: "U01" },
  });
});
