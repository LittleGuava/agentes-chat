import { afterEach, beforeEach, expect, test } from "bun:test";
import { consolidateItem } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Memory = { id: string; text: string; validUntil?: string | null; expired?: boolean; archived: boolean };

test("a memory's end on the memory page (ADR 0028 §2): set, past it marked and still listed, taken away", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const { item } = await consolidateItem(t.db, {
    orgId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agentId,
    agentId,
    content: "Deploys are frozen during the launch.",
    channelIds: [channelId],
  });
  const list = async () =>
    (
      (await (await owner(`/api/app/organizations/${orgId}/agents/${agentId}/memories`)).json()) as {
        memories: Memory[];
      }
    ).memories;
  const patch = (json: Record<string, unknown>, id = item.id, as = owner) =>
    as(`/api/app/organizations/${orgId}/memories/${id}`, { method: "PATCH", json });

  expect((await list()).map((m) => [m.id, m.validUntil, m.expired])).toEqual([[item.id, null, false]]);

  const ahead = new Date(Date.now() + 86_400_000).toISOString();
  const set = await patch({ validUntil: ahead });
  expect(set.status).toBe(200);
  expect(((await set.json()) as Memory).validUntil).toBe(ahead);

  // Past its end: the same item, still on the page, marked.
  const past = new Date(Date.now() - 60_000).toISOString();
  expect((await patch({ validUntil: past })).status).toBe(200);
  expect((await list()).map((m) => [m.id, m.validUntil, m.expired, m.archived])).toEqual([
    [item.id, past, true, false],
  ]);

  // Text and a new end in one save: a new version, current again.
  const again = await patch({ text: "Deploys are frozen until the launch ends.", validUntil: ahead });
  const next = (await again.json()) as Memory;
  expect([next.text, next.validUntil, next.expired]).toEqual([
    "Deploys are frozen until the launch ends.",
    ahead,
    false,
  ]);

  expect(((await (await patch({ validUntil: null }, next.id)).json()) as Memory).validUntil).toBeNull();
  expect((await patch({ validUntil: "next week" }, next.id)).status).toBe(400);

  // Only who may edit it sets its end.
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  expect((await patch({ validUntil: ahead }, next.id, ana)).status).toBe(403);
});
