import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("PATCH a message: its author edits its text, the list shows it edited, anyone else gets 403; in OpenAPI", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const sent = (await (
    await owner(`${org}/channels/${channelId}/messages`, { json: { body: "reunião às 10h" } })
  ).json()) as {
    id: string;
  };
  const patch = (who: typeof owner, json: unknown) => who(`${org}/messages/${sent.id}`, { method: "PATCH", json });

  const refused = await patch(member, { body: "outra coisa" });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("message.edit_not_yours");

  const edited = await patch(owner, { body: "reunião às 11h" });
  expect(edited.status).toBe(200);
  const result = (await edited.json()) as { message: { body: string; editedAt?: string }; runs: unknown[] };
  expect(result.message.body).toBe("reunião às 11h");
  expect(typeof result.message.editedAt).toBe("string");
  expect(result.runs).toEqual([]);

  const { messages } = (await (await member(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; body: string; editedAt?: string }[];
  };
  const shown = messages.find((m) => m.id === sent.id);
  expect(shown?.body).toBe("reunião às 11h");
  expect(shown?.editedAt).toBe(result.message.editedAt);

  const doc = (await (await t.app.request("/api/openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  expect(Object.keys(doc.paths["/app/organizations/{orgId}/messages/{messageId}"] ?? {})).toContain("patch");
});
