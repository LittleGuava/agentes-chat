import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, openAgentDm, openPersonAgentDm, queueOnRun } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Work = { state: string; channelId: string | null; threadId: string | null; forAgentId: string | null } | null;

test("work handed to an agent in two agents' DM shows where it was handed off, bare to who can't read it", async () => {
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const { orgId, agentId, credentialId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const infra = (await (
    await api("/agents", {
      json: { name: "Atlas", handle: "atlas", instructions: "Cuida das propostas para clientes.", credentialId },
    })
  ).json()) as { id: string };
  const vendas = (await (await api("/channels", { json: { name: "vendas", visibility: "private" } })).json()) as {
    id: string;
  };

  // Dev asked in a thread of #vendas and handed the work to Atlas; its turn ended, Atlas's run works.
  const root = await insertMessage(t.db, {
    orgId,
    channelId: vendas.id,
    author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
    body: "Revisar a proposta do cliente novo",
  });
  const ask = await insertMessage(t.db, {
    orgId,
    channelId: vendas.id,
    threadId: root.id,
    author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
    body: "Passei para o Atlas.",
  });
  const [asker] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId: vendas.id,
      threadRootId: root.id,
      triggerMessageId: ask.id,
      trigger: "mention",
      hop: 0,
      status: "done",
      replyMessageId: ask.id,
    })
    .returning();
  if (!asker) throw new Error("no asking run");
  const dm = await openAgentDm(t.db, orgId, agentId, infra.id);
  const note = await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "agent", agentId, runId: asker.id, hop: 0 },
    body: "Revisa a proposta.",
  });
  const [helper] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId: infra.id,
      channelId: dm.id,
      threadRootId: note.id,
      triggerMessageId: note.id,
      trigger: "dm",
      hop: 1,
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .returning();
  if (!helper) throw new Error("no helper run");
  await t.db.insert(schema.agentConsultations).values({
    orgId,
    kind: "note",
    askerRunId: asker.id,
    askerAgentId: agentId,
    targetAgentId: infra.id,
    channelId: dm.id,
    messageId: note.id,
    targetRunId: helper.id,
    waitId: "w1",
    question: "Revisa a proposta.",
    chain: [agentId],
    expiresAt: new Date(Date.now() + 600_000),
  });
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");

  const workOf = async (b: typeof owner) => {
    const { agents } = (await (await b(`/api/app/organizations/${orgId}/agent-status`)).json()) as {
      agents: { agentId: string; work: Work }[];
    };
    return agents.find((a) => a.agentId === infra.id)?.work ?? null;
  };
  expect(await workOf(owner)).toMatchObject({
    state: "working",
    channelId: vendas.id,
    threadId: root.id,
    forAgentId: agentId,
    messageId: ask.id,
  });
  expect(await workOf(bia)).toMatchObject({ state: "working", channelId: null, threadId: null, forAgentId: null });

  const listed = async (b: typeof owner) =>
    (
      (await (await b(`/api/app/organizations/${orgId}/active-runs`)).json()) as {
        runs: { runId: string; channelId: string; threadId: string | null; forAgentId: string | null }[];
      }
    ).runs;
  expect((await listed(owner)).find((r) => r.runId === helper.id)).toMatchObject({
    channelId: vendas.id,
    threadId: root.id,
    forAgentId: agentId,
  });
  expect((await listed(bia)).some((r) => r.runId === helper.id)).toBe(false);

  // The working line of #vendas hears the hand-off, and the thread's chip counts it as work there.
  const here = (await (await api(`/channels/${vendas.id}/active-runs`)).json()) as {
    consults: { consultedAgentId: string; kind: string; threadId: string | null }[];
  };
  expect(here.consults).toMatchObject([{ consultedAgentId: infra.id, kind: "note", threadId: root.id }]);
  const thread = (await (await api(`/threads/${root.id}`)).json()) as { working: boolean; wait: string | null };
  expect(thread).toMatchObject({ working: true, wait: null });
});

test("the agents' status names who waits for an agent, only to who reads where they asked (ADR 0084 addendum)", async () => {
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const [biaUser] = await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"));
  if (!biaUser) throw new Error("no bia");
  await bia(`/api/app/organizations/${orgId}/channels/${channelId}/join`, { method: "POST" });

  // Dev works in #general on Ana's ask; Bia writes meanwhile, and her message waits in its run.
  const [ana] = await t.db.select().from(schema.users).where(eq(schema.users.email, "ana@example.com"));
  if (!ana) throw new Error("no ana");
  const ask = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ana.id },
    body: "@dev olha os bugs",
  });
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  const later = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: biaUser.id },
    body: "e o deploy?",
  });
  await queueOnRun(t.db, run.id, later.id);
  // Bia also asked Dev in her DM: that run is in line.
  const dm = await openPersonAgentDm(t.db, orgId, biaUser.id, agentId);
  const private_ = await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "person", userId: biaUser.id },
    body: "me ajuda com a carta",
  });
  await t.db.insert(schema.agentRuns).values({
    orgId,
    agentId,
    channelId: dm.id,
    threadRootId: private_.id,
    triggerMessageId: private_.id,
    trigger: "dm",
    hop: 1,
    status: "queued",
  });

  const queueOf = async (b: typeof owner) => {
    const { agents } = (await (await b(`/api/app/organizations/${orgId}/agent-status`)).json()) as {
      agents: { agentId: string; queue?: unknown }[];
    };
    return agents.find((a) => a.agentId === agentId)?.queue;
  };
  expect(await queueOf(owner)).toEqual({ count: 1, askers: [{ type: "person", id: biaUser.id }] });
  expect(await queueOf(bia)).toEqual({ count: 2, askers: [{ type: "person", id: biaUser.id }] });
});
