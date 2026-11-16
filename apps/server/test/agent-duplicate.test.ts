import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Agent = { id: string; name: string; handle: string; role: string; instructions: string; ownerUserId: string };

test("Duplicar: a copy with its settings, yours; someone else's agent refused; audited as a creation", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId: dev } = await seedOrg(owner);
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  await api(owner, `/agents/${dev}`, {
    method: "PATCH",
    json: { role: "Developer", instructions: "Write the test first." },
  });

  const made = await api(owner, `/agents/${dev}/duplicate`, { json: { name: "Dev (cópia)" } });
  expect(made.status).toBe(201);
  const { agent, skipped } = (await made.json()) as { agent: Agent; skipped: string[] };
  expect(skipped).toEqual([]);
  expect(agent).toMatchObject({ name: "Dev (cópia)", handle: "dev-2", role: "Developer" });
  expect(agent.id).not.toBe(dev);
  const listed = (await (await api(owner, "/agents")).json()) as { agents: Agent[] };
  expect(listed.agents.map((a) => a.handle)).toContain("dev-2");

  // No name: the default one.
  const plain = (await (await api(owner, `/agents/${dev}/duplicate`, { json: {} })).json()) as {
    agent: Agent;
  };
  expect(plain.agent).toMatchObject({ name: expect.stringMatching(/ \(copy\)$/), handle: "dev-3" });

  // A member can't copy an agent that isn't theirs.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const refused = await api(member, `/agents/${dev}/duplicate`, { json: {} });
  expect(refused.status).toBe(403);

  const { rows } = (await (await api(owner, "/audit?kind=change")).json()) as {
    rows: { action: string; target: { id: string | null }; details: Record<string, unknown> }[];
  };
  const created = rows.find((r) => r.action === "agent.created" && r.target.id === agent.id);
  expect(created?.details).toMatchObject({ handle: "dev-2", duplicateOf: dev });
});
