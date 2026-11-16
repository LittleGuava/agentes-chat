import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

interface ConversationModel {
  model: string | null;
  inherited: string | null;
  options: { value: string; label: string }[];
  canEdit: boolean;
}

test("a conversation's model over HTTP: its owner sets and clears it, a member reads it and can't change it", async () => {
  t = await createTestServer();
  const ana = browser(t);
  await signUp(ana, "ana@acme.test");
  const { orgId, channelId, agentId } = await seedOrg(ana);
  const path = `/api/app/organizations/${orgId}/agents/${agentId}/conversation-model`;

  const first = await ana(`${path}?channelId=${channelId}`);
  expect(first.status).toBe(200);
  const fresh = (await first.json()) as ConversationModel;
  expect(fresh).toMatchObject({ model: null, inherited: null, canEdit: true });
  expect(fresh.options.map((o) => o.value)).toContain("claude-opus-5-5");

  const set = await ana(path, { method: "PUT", json: { channelId, model: "claude-opus-5-5" } });
  expect(set.status).toBe(200);
  expect(((await set.json()) as ConversationModel).model).toBe("claude-opus-5-5");
  const wrong = await ana(path, { method: "PUT", json: { channelId, model: "auto" } });
  expect(wrong.status).toBe(400);

  const bia = await joinByInvitation(t, ana, orgId, "bia@acme.test");
  const seen = await bia(`${path}?channelId=${channelId}`);
  expect(seen.status).toBe(200);
  expect((await seen.json()) as ConversationModel).toMatchObject({ model: "claude-opus-5-5", canEdit: false });
  expect((await bia(path, { method: "PUT", json: { channelId, model: null } })).status).toBe(403);

  const cleared = await ana(path, { method: "PUT", json: { channelId, model: null } });
  expect(((await cleared.json()) as ConversationModel).model).toBeNull();
});
