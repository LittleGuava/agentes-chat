import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, schema } from "@agenteschat/db";
import {
  createChannel,
  createIssue,
  createJobHandlers,
  createOutgoingWebhook,
  DISABLE_AFTER_FAILURES,
  deleteOutgoingWebhook,
  deliverOutgoingWebhook,
  drainOutbox,
  listOutgoingWebhookDeliveries,
  listOutgoingWebhooks,
  OUTGOING_WEBHOOK_JOB,
  openDm,
  outboundFetch,
  postPersonMessage,
  processOutbox,
  setOrgStanding,
  testOutgoingWebhook,
  transitionRun,
  updateOutgoingWebhook,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** ADR 0212: a workspace's events, signed, to an address its administrators chose. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Every name resolves to a public address (the check at save time); a test that wants a private one says so. */
const PUBLIC = async () => ["93.184.216.34"];
const deps = () => ({ db: f.db, pubsub: f.pubsub, keyWrappers: [f.keyWrapper], resolveHost: PUBLIC });

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

/** A receiver that answers each request with the next status (the last one repeats) and records what it got. */
function receiver(...statuses: number[]) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ url: String(input), headers: new Headers(init.headers), body: String(init.body) });
    const status = statuses[Math.min(sent.length - 1, statuses.length - 1)] ?? 200;
    return new Response(status === 204 ? null : "ok", { status });
  }) as typeof fetch;
  return { sent, fetcher };
}

const deliveryDeps = (fetcher: typeof fetch) => ({
  db: f.db,
  pubsub: f.pubsub,
  keyWrappers: [f.keyWrapper],
  fetch: fetcher,
});

const deliveriesOf = (webhookId: string) =>
  f.db.select().from(schema.outgoingWebhookDeliveries).where(eq(schema.outgoingWebhookDeliveries.webhookId, webhookId));

const deliveryJobs = () =>
  f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, OUTGOING_WEBHOOK_JOB), eq(schema.outbox.status, "pending")));

const post = (channelId: string, body: string, userId = f.owner.id) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, channelId, { body });

async function webhook(input: Partial<Parameters<typeof createOutgoingWebhook>[3]> = {}) {
  return createOutgoingWebhook(deps(), f.owner.id, f.org.id, {
    name: "CRM",
    url: "https://hooks.example.com/agentes",
    events: ["message.posted"],
    channelIds: [f.general.id],
    ...input,
  });
}

describe("saving a webhook", () => {
  test("only administrators; the secret comes back once; https to a public address; channels, never a DM", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(
      createOutgoingWebhook(deps(), member.id, f.org.id, {
        name: "x",
        url: "https://hooks.example.com",
        events: ["issue.created"],
      }),
    ).rejects.toThrow();

    const { webhook: made, secret } = await webhook();
    expect(secret).toMatch(/^whsec_/);
    expect(made).toMatchObject({ name: "CRM", events: ["message.posted"], channelIds: [f.general.id], enabled: true });
    const listed = await listOutgoingWebhooks(deps(), f.owner.id, f.org.id);
    expect(listed.map((w) => w.id)).toEqual([made.id]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    const refused = (input: Partial<Parameters<typeof createOutgoingWebhook>[3]>, d = deps()) =>
      createOutgoingWebhook(d, f.owner.id, f.org.id, {
        name: "x",
        url: "https://hooks.example.com",
        events: ["message.posted"],
        channelIds: [f.general.id],
        ...input,
      }).then(
        () => "saved",
        (e: { code?: string }) => e.code,
      );
    expect(await refused({ url: "http://hooks.example.com" })).toBe("url.https_required");
    expect(await refused({ url: "https://10.0.0.1/hook" })).toBe("url.internal");
    expect(await refused({ url: "https://169.254.169.254/latest" })).toBe("url.internal");
    expect(await refused({}, { ...deps(), resolveHost: async () => ["127.0.0.1"] })).toBe("url.internal");
    expect(await refused({ channelIds: [] })).toBe("outgoing_webhook.no_channels");
    expect(await refused({ events: ["message.edited"] })).toBe("outgoing_webhook.event");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(await refused({ channelIds: [dm.id] })).toBe("outgoing_webhook.channel");
  });
});

describe("events", () => {
  test("a message in a chosen channel is sent signed; one elsewhere, or in a DM, never", async () => {
    f = await setup();
    const { webhook: hook, secret } = await webhook();
    const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "outro" });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post(other.id, "fora do filtro");
    await post(dm.id, "segredo do DM");
    expect(await deliveriesOf(hook.id)).toHaveLength(0);

    const message = await post(f.general.id, "pedido novo #42");
    const [delivery] = await deliveriesOf(hook.id);
    expect(delivery).toMatchObject({ event: "message.posted", subjectId: message.id, status: "pending" });
    const jobs = await deliveryJobs();
    expect(jobs.map((j) => j.payload)).toEqual([{ deliveryId: delivery?.id }]);

    // Run through the job handlers the server builds, with the receiver as the network.
    const { sent, fetcher } = receiver(200);
    const handlers = createJobHandlers({
      ...f.jobDeps,
      outgoingWebhooks: { keyWrappers: [f.keyWrapper], fetch: fetcher },
    });
    await processOutbox(f.db, handlers, { workerId: "t", skipKinds: ["agent_run.execute", "message.posted"] });
    expect(sent).toHaveLength(1);
    const request = sent[0] as Sent;
    expect(request.url).toBe("https://hooks.example.com/agentes");
    const expected = `sha256=${createHmac("sha256", secret).update(request.body).digest("hex")}`;
    expect(request.headers.get("x-agentes-webhook-signature")).toBe(expected);
    expect(request.headers.get("x-agentes-webhook-event")).toBe("message.posted");
    expect(request.headers.get("x-agentes-webhook-id")).toBe(delivery?.id ?? "");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      id: delivery?.id,
      type: "message.posted",
      orgId: f.org.id,
      data: {
        message: {
          id: message.id,
          channel: { id: f.general.id, name: "general" },
          author: { type: "person", id: f.owner.id },
          text: "pedido novo #42",
        },
      },
    });
    expect(request.body).not.toContain("segredo do DM");
    const [done] = await listOutgoingWebhookDeliveries(deps(), f.owner.id, f.org.id, hook.id);
    expect(done).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 200 });
    const [after] = await listOutgoingWebhooks(deps(), f.owner.id, f.org.id);
    expect(after?.lastSuccessAt).not.toBeNull();
  });

  test("a run's end in a channel is sent with ids and its status; one in a DM is not", async () => {
    f = await setup();
    const { webhook: hook } = await webhook({ events: ["run.finished"], channelIds: [] });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inDm = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "faz isso",
    });
    const inChannel = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz isso",
    });
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, f.org.id));
    const runIn = (messageId: string) => runs.find((r) => r.triggerMessageId === messageId);
    const dmRun = runIn(inDm.id);
    const channelRun = runIn(inChannel.id);
    if (!dmRun || !channelRun) throw new Error("no runs");
    for (const run of [dmRun, channelRun]) {
      await transitionRun(f.db, run.id, "queued", "running");
      await transitionRun(f.db, run.id, "running", "done");
    }
    const queued = await deliveriesOf(hook.id);
    expect(queued.map((d) => [d.event, d.subjectId])).toEqual([["run.finished", channelRun.id]]);

    const { sent, fetcher } = receiver(204);
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), queued[0]?.id ?? "", { finalAttempt: false })).toBe(
      "delivered",
    );
    const body = JSON.parse(sent[0]?.body ?? "{}");
    expect(body.data.run).toMatchObject({
      id: channelRun.id,
      status: "done",
      agent: { id: f.agent.id, handle: "dev" },
      channel: { id: f.general.id },
    });
    expect(Object.keys(body.data.run)).not.toContain("text");
  });

  test("a task is sent when created where everyone sees it, never one made in a DM", async () => {
    f = await setup();
    const { webhook: hook } = await webhook({ events: ["issue.created"], channelIds: [] });
    const actor = { type: "person" as const, userId: f.owner.id };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, { title: "Do DM", channelId: dm.id });
    const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, {
      title: "Cliente pediu orçamento",
    });
    const queued = await deliveriesOf(hook.id);
    expect(queued.map((d) => [d.event, d.subjectId])).toEqual([["issue.created", issue.id]]);
    const { sent, fetcher } = receiver(200);
    await deliverOutgoingWebhook(deliveryDeps(fetcher), queued[0]?.id ?? "", { finalAttempt: false });
    expect(JSON.parse(sent[0]?.body ?? "{}").data.issue).toMatchObject({
      id: issue.id,
      number: issue.number,
      title: "Cliente pediu orçamento",
    });
  });
});

describe("delivery", () => {
  test("a 5xx is retried with the outbox's backoff; the last attempt fails it and counts one failure", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    await post(f.general.id, "oi");
    const { sent, fetcher } = receiver(503);
    const handlers = createJobHandlers({
      ...f.jobDeps,
      outgoingWebhooks: { keyWrappers: [f.keyWrapper], fetch: fetcher },
    });
    const before = Date.now();
    const errors: unknown[] = [];
    await processOutbox(f.db, handlers, {
      workerId: "t",
      skipKinds: ["agent_run.execute", "message.posted"],
      onError: (_job, error) => errors.push(error),
    });
    // The receiver's trouble: tried again, and told as transient (a warning), never as the server's error.
    expect(errors.map((e) => (e as { retryable?: unknown }).retryable)).toEqual([true]);
    expect(sent).toHaveLength(1);
    const [job] = await deliveryJobs();
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(before + 4_000);
    const [pending] = await deliveriesOf(hook.id);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, responseStatus: 503, error: "http_503" });

    // Its last attempt.
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), pending?.id ?? "", { finalAttempt: true })).toBe(
      "failed",
    );
    const [failed] = await deliveriesOf(hook.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 2 });
    const [after] = await listOutgoingWebhooks(deps(), f.owner.id, f.org.id);
    expect(after).toMatchObject({ consecutiveFailures: 1, enabled: true });
    // Run again (a lost lease): nothing is sent and nothing counted twice.
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), pending?.id ?? "", { finalAttempt: true })).toBe("done");
    expect(sent).toHaveLength(2);
    expect((await listOutgoingWebhooks(deps(), f.owner.id, f.org.id))[0]?.consecutiveFailures).toBe(1);
  });

  test("a 4xx fails at once; ten failures in a row turn it off; a success sets the count back", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    const { fetcher: refusing } = receiver(400);
    const { fetcher: ok } = receiver(200);
    await post(f.general.id, "um");
    const [first] = await deliveriesOf(hook.id);
    await expect(
      deliverOutgoingWebhook(deliveryDeps(refusing), first?.id ?? "", { finalAttempt: false }),
    ).resolves.toBe("failed");
    expect((await listOutgoingWebhooks(deps(), f.owner.id, f.org.id))[0]?.consecutiveFailures).toBe(1);

    await post(f.general.id, "dois");
    const second = (await deliveriesOf(hook.id)).find((d) => d.status === "pending");
    await deliverOutgoingWebhook(deliveryDeps(ok), second?.id ?? "", { finalAttempt: false });
    expect((await listOutgoingWebhooks(deps(), f.owner.id, f.org.id))[0]?.consecutiveFailures).toBe(0);

    for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
      await post(f.general.id, `falha ${i}`);
      const pending = (await deliveriesOf(hook.id)).find((d) => d.status === "pending");
      await deliverOutgoingWebhook(deliveryDeps(refusing), pending?.id ?? "", { finalAttempt: false });
    }
    const [off] = await listOutgoingWebhooks(deps(), f.owner.id, f.org.id);
    expect(off).toMatchObject({ enabled: false, disabledReason: "failures", consecutiveFailures: 10 });

    // Off: nothing more is queued, and Testar asks to turn it on first.
    const count = (await deliveriesOf(hook.id)).length;
    await post(f.general.id, "depois");
    expect(await deliveriesOf(hook.id)).toHaveLength(count);
    await expect(testOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id)).rejects.toMatchObject({
      code: "outgoing_webhook.disabled",
    });
    const on = await updateOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id, { enabled: true });
    expect(on).toMatchObject({ enabled: true, consecutiveFailures: 0 });
  });

  test("turned off by failures, the administrators hear it once; turning it back on or deleting it closes the notice", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "ana");
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const { webhook: hook } = await webhook({ name: "CRM de vendas" });
    const { fetcher: refusing } = receiver(400);
    const failAll = async () => {
      for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
        await post(f.general.id, `falha ${i}`);
        const pending = (await deliveriesOf(hook.id)).find((d) => d.status === "pending");
        await deliverOutgoingWebhook(deliveryDeps(refusing), pending?.id ?? "", { finalAttempt: false });
      }
    };
    const notices = async () =>
      (await f.db.select().from(schema.notifications)).filter((n) => n.kind === "webhook_disabled");

    await failAll();
    const told = await notices();
    expect(told.map((n) => n.userId).sort()).toEqual([admin.id, f.owner.id].sort());
    expect(told.map((n) => n.userId)).not.toContain(member.id);
    expect(told[0]).toMatchObject({
      orgId: f.org.id,
      doneAt: null,
      source: { webhookId: hook.id, label: "CRM de vendas" },
      latest: { title: "CRM de vendas", reason: "http_400" },
    });

    await updateOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id, { enabled: true });
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);

    // Off again: a new notice; deleting the webhook closes it too.
    await failAll();
    expect((await notices()).filter((n) => n.doneAt === null)).toHaveLength(2);
    await deleteOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id);
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
  });

  test("an address that resolves to a private one when sent is refused, never retried", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    await post(f.general.id, "oi");
    const [delivery] = await deliveriesOf(hook.id);
    // The name moved to the server's own network after it was saved (DNS rebinding).
    const guarded = outboundFetch({ resolveHost: async () => ["10.0.0.1"] });
    expect(await deliverOutgoingWebhook(deliveryDeps(guarded), delivery?.id ?? "", { finalAttempt: false })).toBe(
      "failed",
    );
    expect((await deliveriesOf(hook.id))[0]).toMatchObject({ status: "failed", error: "address_refused" });
  });

  test("a redirect is a failure, never followed", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    await post(f.general.id, "oi");
    const [delivery] = await deliveriesOf(hook.id);
    const { sent, fetcher } = receiver(302);
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), delivery?.id ?? "", { finalAttempt: false })).toBe(
      "failed",
    );
    expect(sent).toHaveLength(1);
    expect((await deliveriesOf(hook.id))[0]).toMatchObject({ error: "http_302", responseStatus: 302 });
  });

  test("Testar sends a ping; a deleted message is skipped, not sent", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    const { sent, fetcher } = receiver(200);
    const { deliveryId } = await testOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id);
    await deliverOutgoingWebhook(deliveryDeps(fetcher), deliveryId, { finalAttempt: false });
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ type: "ping", data: { test: true } });

    const message = await post(f.general.id, "apagada");
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, message.id));
    const pending = (await deliveriesOf(hook.id)).find((d) => d.status === "pending");
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), pending?.id ?? "", { finalAttempt: false })).toBe(
      "skipped",
    );
    expect(sent).toHaveLength(1);
  });
});

describe("more of what is sent, and when not", () => {
  test("an agent's reply in a chosen channel is sent with the agent as its author", async () => {
    f = await setup({ reply: () => ({ chunks: ["Orçamento enviado."] }) });
    await webhook();
    const { sent, fetcher } = receiver(200);
    const handlers = createJobHandlers({
      ...f.jobDeps,
      outgoingWebhooks: { keyWrappers: [f.keyWrapper], fetch: fetcher },
    });
    await post(f.general.id, "@dev manda o orçamento");
    await drainOutbox(f.db, handlers);
    const bodies = sent.map((r) => JSON.parse(r.body).data.message);
    expect(bodies.map((m) => [m.author.type, m.text])).toEqual([
      ["person", "@dev manda o orçamento"],
      ["agent", "Orçamento enviado."],
    ]);
    expect(bodies[1].author).toMatchObject({ id: f.agent.id, name: f.agent.name });
  });

  test("a suspended workspace sends nothing: its deliveries are skipped", async () => {
    f = await setup();
    const { webhook: hook } = await webhook();
    await post(f.general.id, "antes da suspensão");
    await setOrgStanding({ db: f.db }, f.org.id, { state: "suspended", reason: "abuse", notice: "shown" });
    const [delivery] = await deliveriesOf(hook.id);
    const { sent, fetcher } = receiver(200);
    expect(await deliverOutgoingWebhook(deliveryDeps(fetcher), delivery?.id ?? "", { finalAttempt: false })).toBe(
      "skipped",
    );
    expect(sent).toHaveLength(0);
    expect((await deliveriesOf(hook.id))[0]).toMatchObject({ status: "skipped", error: "workspace_closed" });
  });

  test("every change is in the audit log, in the incoming webhooks' area, never with the secret", async () => {
    f = await setup();
    const { webhook: hook, secret } = await webhook();
    await updateOutgoingWebhook(deps(), f.owner.id, f.org.id, hook.id, { name: "CRM novo" });
    const rows = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, f.org.id));
    const mine = rows.filter((r) => r.action.startsWith("webhook.outgoing_"));
    expect(mine.map((r) => [r.action, r.targetType, r.targetId])).toEqual([
      ["webhook.outgoing_created", "webhook", hook.id],
      ["webhook.outgoing_updated", "webhook", hook.id],
    ]);
    expect(JSON.stringify(mine)).not.toContain(secret);
  });
});
