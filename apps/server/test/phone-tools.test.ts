import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * ADR 0205: the phone app turns its contacts on for a workspace, lists the jobs its person's agents sent it and
 * answers them. The web app does neither, another member never sees them, and an answer past its limits is refused.
 */

let t: TestServer;
afterEach(async () => {
  await t.close();
});

const PHONE = { origin: null, headers: { "x-agentes-client": "mobile" } } as const;

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const seeded = await seedOrg(owner);
  const sam = await joinByInvitation(t, owner, seeded.orgId, "sam@example.com");
  const idOf = async (email: string) =>
    (await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  return { owner, sam, ...seeded, anaId: await idOf("ana@example.com") };
}

test("the phone app turns contacts on and off; the web app can't", async () => {
  const { owner, orgId } = await start();
  const tools = (init: Parameters<typeof owner>[1] = {}) =>
    owner(`/api/app/organizations/${orgId}/phone/tools`, { ...PHONE, ...init });

  const fromWeb = await owner(`/api/app/organizations/${orgId}/phone/tools`, {
    method: "PUT",
    json: { tools: ["contacts"], deviceName: "Chrome" },
  });
  expect(fromWeb.status).toBe(403);
  expect(await fromWeb.json()).toMatchObject({ error: { code: "phone.app_only" } });

  expect(await (await tools()).json()).toEqual({ tools: [], deviceName: null, updatedAt: null });
  const on = await tools({ method: "PUT", json: { tools: ["contacts"], deviceName: "Ana's iPhone" } });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ tools: ["contacts"], deviceName: "Ana's iPhone" });
  expect(await (await tools()).json()).toMatchObject({ tools: ["contacts"], deviceName: "Ana's iPhone" });
  expect((await tools({ method: "PUT", json: { tools: ["sms"], deviceName: "x" } })).status).toBe(400);
  expect((await tools({ method: "PUT", json: { tools: [], deviceName: "Ana's iPhone" } })).status).toBe(200);
  expect(await (await tools()).json()).toEqual({ tools: [], deviceName: null, updatedAt: null });
});

test("the phone lists its person's jobs and answers within the limits; another member's phone sees none", async () => {
  const { owner, sam, orgId, anaId } = await start();
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId));
  if (!agent) throw new Error("no agent");
  const [job] = await t.db
    .insert(schema.phoneJobs)
    .values({
      orgId,
      userId: anaId,
      agentId: agent.id,
      runId: crypto.randomUUID(),
      kind: "find_contact",
      input: { query: "Maria" },
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!job) throw new Error("no job");
  const jobs = (b: typeof owner) => b(`/api/app/organizations/${orgId}/phone/jobs`, PHONE);
  const answer = (b: typeof owner, json: unknown) =>
    b(`/api/app/organizations/${orgId}/phone/jobs/${job.id}`, { ...PHONE, json });
  const contact = { name: "Maria Souza", phones: ["+55 11 91234-5678"], emails: [] };

  expect(await (await jobs(owner)).json()).toMatchObject({
    jobs: [{ id: job.id, kind: "find_contact", input: { query: "Maria" }, agent: { id: agent.id } }],
  });
  expect(await (await jobs(sam)).json()).toEqual({ jobs: [] });
  expect((await answer(sam, { outcome: "declined" })).status).toBe(404);
  expect((await owner(`/api/app/organizations/${orgId}/phone/jobs`)).status).toBe(403);

  expect((await answer(owner, { outcome: "done", contacts: Array(6).fill(contact) })).status).toBe(400);
  expect(
    (await answer(owner, { outcome: "done", contacts: [{ ...contact, phones: Array(6).fill("1") }] })).status,
  ).toBe(400);
  expect((await answer(owner, { outcome: "maybe" })).status).toBe(400);
  expect((await answer(owner, { outcome: "done", contacts: [contact] })).status).toBe(204);
  expect((await answer(owner, { outcome: "declined" })).status).toBe(409);
  expect(await (await jobs(owner)).json()).toEqual({ jobs: [] });
  const [stored] = await t.db.select().from(schema.phoneJobs).where(eq(schema.phoneJobs.id, job.id));
  expect(stored).toMatchObject({ status: "done", result: { contacts: [contact] } });
});
