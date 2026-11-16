import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { addRunStep, scanHealth } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

test("Health: admins read what keeps failing, grouped and without what anyone wrote; members get 403", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const runs = [];
  for (const n of [1, 2]) {
    const id = crypto.randomUUID();
    const [run] = await t.db
      .insert(schema.agentRuns)
      .values({ orgId, agentId, channelId, threadRootId: id, triggerMessageId: id, trigger: "mention", hop: 1 })
      .returning();
    if (!run) throw new Error("no run");
    runs.push(run);
    await addRunStep(t.db, run, "tool_result", {
      toolUseId: `call-${n}`,
      name: "web_fetch",
      isError: true,
      content: `fetch of https://intranet.acme.test/q${n} failed for joao@acme.com after ${n * 10} s`,
    });
  }
  await scanHealth(t.db);

  const res = await owner(`/api/app/organizations/${orgId}/health-issues`);
  expect(res.status).toBe(200);
  const text = await res.text();
  for (const leaked of ["intranet.acme.test", "joao@acme.com"]) expect(text).not.toContain(leaked);
  const { issues } = JSON.parse(text) as {
    issues: { kind: string; source: string; title: string; count: number; examples: { runId: string }[] }[];
  };
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({
    kind: "tool_error",
    source: "web_fetch",
    title: "fetch of <url> failed for <email> after <n> s",
    count: 2,
  });
  expect(issues[0]?.examples.map((e) => e.runId).sort()).toEqual(runs.map((r) => r.id).sort());

  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  expect((await member(`/api/app/organizations/${orgId}/health-issues`)).status).toBe(403);
});
