import { afterEach, expect, test } from "bun:test";
import {
  createFakeComposioClient,
  createFakeMailConnector,
  FAKE_COMPOSIO_SIGNATURE,
  type MailAdapters,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { composioToolkitUrl } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0196 through the HTTP API: a routine on Slack's new message, run by Composio's signed webhook. */

let t: TestServer;
afterEach(async () => {
  await t?.close();
  t = undefined as never;
});

test("a routine on a Slack message: made through the API, run by Composio's signed call, its trigger gone with it", async () => {
  const composio = createFakeComposioClient();
  const mail: MailAdapters = {
    composio: { client: composio.client, connector: createFakeMailConnector().connector },
    imap: null,
  };
  t = await createTestServer({ mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  composio.state.accounts.set("ca_slack", {
    toolkit: "slack",
    userId: `org_${orgId}`,
    status: "active",
    address: null,
    displayName: "Acme",
  });
  // Who the account is at Slack (`auth.test`), read before the trigger is made.
  composio.state.answers.set("SLACK_TEST_AUTH", { ok: true, user_id: "U0SELF" });
  const [connection] = await t.db
    .insert(schema.connectorConnections)
    .values({
      orgId,
      connector: "custom",
      label: "Slack",
      serverUrl: composioToolkitUrl("slack"),
      authType: "none",
      toolPrefix: "slack",
      composioAccountId: "ca_slack",
    })
    .returning();
  if (!connection) throw new Error("no connection");
  await t.db.insert(schema.agentScopes).values({
    orgId,
    agentId,
    connectionId: connection.id,
    scope: `custom:${connection.id}:read`,
  });

  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Responda o pedido novo.",
      target: { type: "dm" },
      trigger: {
        type: "connector",
        connectionId: connection.id,
        event: "slack.message.received",
        filter: { channel: "C0SALES", text: "pedido" },
      },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; trigger: Record<string, unknown> };
  expect(routine.trigger).toEqual({
    type: "connector",
    connectionId: connection.id,
    event: "slack.message.received",
    inboxId: null,
    filter: { channel: "C0SALES", text: "pedido" },
    status: "active",
    lastError: null,
  });
  const [triggerId] = [...composio.state.eventTriggers.keys()];

  const hook = (id: string, signature = FAKE_COMPOSIO_SIGNATURE) =>
    t.app.request("/api/webhooks/composio", {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-signature": signature, "webhook-id": id },
      body: JSON.stringify({
        type: "trigger.event",
        triggerId,
        connectedAccountId: "ca_slack",
        slug: "SLACK_CHANNEL_MESSAGE_RECEIVED",
        payload: { channel: "C0SALES", user: "U01", text: "Novo pedido", ts: "1731670000.000100" },
      }),
    });
  expect((await hook("evt_1", "v1,forged")).status).toBe(401);
  const accepted = await hook("evt_1");
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ ok: true, type: "trigger.event", fired: 1 });
  expect(await (await hook("evt_1")).json()).toMatchObject({ fired: 0 });
  const runs = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(runs).toHaveLength(1);

  expect((await api(`/routines/${routine.id}`, { method: "DELETE" })).status).toBe(204);
  expect(composio.state.eventTriggers.size).toBe(0);
});
