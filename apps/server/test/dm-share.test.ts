import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Shared = { channelId: string; message: { id: string; body: string; meta: { sharedDm?: { count: number } } } };

test("sharing my DM with an agent: confirmed, the copy in the channel, the DM still mine", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId: general, agentId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const { channelId: dm } = (await (
    await owner(`/api/app/organizations/${orgId}/dms`, { json: { agentId } })
  ).json()) as { channelId: string };
  const sent = await owner(`/api/app/organizations/${orgId}/channels/${dm}/messages`, {
    json: { body: "the rollout plan for friday" },
  });
  expect(sent.status).toBe(201);
  const share = (b: typeof owner, json: Record<string, unknown>) =>
    b(`/api/app/organizations/${orgId}/dms/${dm}/share`, { json });

  // Not confirmed: nothing is posted.
  expect((await share(owner, { to: { channelId: general }, note: "FYI" })).status).toBe(400);
  // Someone else's DM: as if it weren't there.
  expect((await share(member, { to: { channelId: general }, note: "FYI", confirm: true })).status).toBe(404);

  const res = await share(owner, { to: { channelId: general }, note: "FYI", confirm: true });
  expect(res.status).toBe(201);
  const shared = (await res.json()) as Shared;
  expect(shared.channelId).toBe(general);
  expect(shared.message.body).toBe("FYI");
  expect(shared.message.meta.sharedDm?.count).toBeGreaterThanOrEqual(1);

  const listed = (await (await member(`/api/app/organizations/${orgId}/channels/${general}/messages`)).json()) as {
    messages: { id: string }[];
  };
  expect(listed.messages.map((m) => m.id)).toContain(shared.message.id);
  expect((await member(`/api/app/organizations/${orgId}/channels/${dm}/messages`)).status).toBeGreaterThanOrEqual(400);
});

test("a copy is a post: it counts toward the posting limit", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId: general, agentId } = await seedOrg(owner);
  const { channelId: dm } = (await (
    await owner(`/api/app/organizations/${orgId}/dms`, { json: { agentId } })
  ).json()) as { channelId: string };
  await owner(`/api/app/organizations/${orgId}/channels/${dm}/messages`, { json: { body: "hello" } });
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    const res = await owner(`/api/app/organizations/${orgId}/dms/${dm}/share`, {
      json: { to: { channelId: general }, note: `FYI ${i}`, confirm: true },
    });
    statuses.push(res.status);
  }
  // The DM's own message already took one of the 30.
  expect(statuses.filter((s) => s === 201)).toHaveLength(29);
  expect(statuses.at(-1)).toBe(429);
});
