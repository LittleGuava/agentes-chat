import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0199 §6 and the way out: the workspace's switch, and "Leave meeting" from the conversation. */

let t: TestServer;
afterEach(() => t.close());

test("meeting notes start off; who configures the workspace turns them on", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "ana@acme.test");
  const { orgId } = await seedOrg(owner);
  const settings = `/api/app/organizations/${orgId}/settings`;
  expect(((await (await owner(settings)).json()) as { meetingNotes: boolean }).meetingNotes).toBe(false);
  const patched = await owner(settings, { method: "PATCH", json: { meetingNotes: true } });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { meetingNotes: boolean }).meetingNotes).toBe(true);
  const [row] = await t.db
    .select({ on: schema.organizationSettings.meetingNotes })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  expect(row?.on).toBe(true);
});

test("Leave meeting: the agent leaves, the notes come with what was heard, and a second press says it ended", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "ana@acme.test");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const [meeting] = await t.db
    .insert(schema.agentMeetings)
    .values({
      orgId,
      agentId,
      channelId,
      platform: "google_meet",
      url: "https://meet.google.com/abc-defg-hij",
      displayName: "Dev (notes)",
      status: "in_call",
      transcript: [{ speaker: "", atMs: 4000, text: "Ship it on Friday." }],
    })
    .returning();
  const leave = `/api/app/organizations/${orgId}/meetings/${meeting?.id}/leave`;
  expect((await owner(leave, { json: {} })).status).toBe(204);
  const [ended] = await t.db
    .select()
    .from(schema.agentMeetings)
    .where(eq(schema.agentMeetings.id, meeting?.id ?? ""));
  expect(ended?.status).toBe("ended");
  const notices = await t.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.id, ended?.noticeMessageId ?? "")));
  expect(notices).toHaveLength(1);

  const again = await owner(leave, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("meeting.ended");
  const none = await owner(`/api/app/organizations/${orgId}/meetings/${crypto.randomUUID()}/leave`, { json: {} });
  expect(none.status).toBe(404);
});
