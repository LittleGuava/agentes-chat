import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("a channel's instructions: set by who manages it, within the limit, listed with the channel, audited", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId: general } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const patch = (who: typeof owner, instructions: string) =>
    who(`${org}/channels/${general}`, { method: "PATCH", json: { instructions } });

  expect((await patch(member, "Answer in English.")).status).toBe(403);
  expect((await patch(owner, "x".repeat(4001))).status).toBe(400);
  const saved = await patch(owner, "Every answer links the ticket it is about.");
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { instructions: string }).instructions).toBe(
    "Every answer links the ticket it is about.",
  );

  // Members read them where they read the channel.
  const list = (await (await member(`${org}/channels`)).json()) as { channels: { id: string; instructions: string }[] };
  expect(list.channels.find((c) => c.id === general)?.instructions).toBe("Every answer links the ticket it is about.");

  const audit = (await (await owner(`${org}/audit?kind=change`)).json()) as {
    rows: { action: string; details: Record<string, unknown> }[];
  };
  const row = audit.rows.find((r) => r.action === "channel.instructions_changed");
  expect(row?.details).toMatchObject({ name: "general" });
  expect(JSON.stringify(row?.details)).not.toContain("links the ticket");
});
