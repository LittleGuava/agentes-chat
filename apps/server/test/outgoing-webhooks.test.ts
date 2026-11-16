import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0212: the outgoing webhooks' API, for administrators only. */

let t: TestServer;
afterEach(() => t.close());

test("an admin makes a webhook (secret once), changes it, tests it and reads its deliveries; a member can't", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }), resolveHost: async () => ["93.184.216.34"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}/outgoing-webhooks${path}`, init);

  const refused = await api("", {
    json: { name: "CRM", url: "https://10.0.0.1/hook", events: ["message.posted"], channelIds: [channelId] },
  });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("url.internal");

  const made = await api("", {
    json: { name: "CRM", url: "https://hooks.example.com/in", events: ["message.posted"], channelIds: [channelId] },
  });
  expect(made.status).toBe(201);
  const { webhook, secret } = (await made.json()) as { webhook: { id: string; enabled: boolean }; secret: string };
  expect(secret).toMatch(/^whsec_/);
  expect(webhook.enabled).toBe(true);
  const listed = (await (await api("")).json()) as { webhooks: { id: string }[] };
  expect(listed.webhooks.map((w) => w.id)).toEqual([webhook.id]);
  expect(JSON.stringify(listed)).not.toContain(secret);

  const off = await api(`/${webhook.id}`, { method: "PATCH", json: { enabled: false, events: ["issue.created"] } });
  expect(await off.json()).toMatchObject({ enabled: false, disabledReason: "manual", events: ["issue.created"] });
  expect((await api(`/${webhook.id}/test`, { json: {} })).status).toBe(400);
  await api(`/${webhook.id}`, { method: "PATCH", json: { enabled: true } });
  const queued = await api(`/${webhook.id}/test`, { json: {} });
  expect(queued.status).toBe(202);
  const { deliveryId } = (await queued.json()) as { deliveryId: string };
  const { deliveries } = (await (await api(`/${webhook.id}/deliveries`)).json()) as {
    deliveries: { id: string; event: string }[];
  };
  expect(deliveries.find((d) => d.id === deliveryId)).toMatchObject({ event: "ping" });

  const rotated = (await (await api(`/${webhook.id}/secret`, { json: {} })).json()) as { secret: string };
  expect(rotated.secret).not.toBe(secret);

  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await member(`/api/app/organizations/${orgId}/outgoing-webhooks`)).status).toBe(403);

  expect((await api(`/${webhook.id}`, { method: "DELETE" })).status).toBe(204);
  expect(((await (await api("")).json()) as { webhooks: unknown[] }).webhooks).toEqual([]);
});
