import { createHmac } from "node:crypto";
import { type KeyWrapper, OutboundAddressError } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { openSecret, randomToken, sealSecret } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { readableBody } from "./message-preview";
import { assertPublicHttpsUrl, outboundFetch, type ResolveHost } from "./net-guard";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { closedOrg } from "./standing";

const { outgoingWebhooks, outgoingWebhookDeliveries: deliveries, channels } = schema;

/** What a webhook can listen to (ADR 0212 §2). `ping` is only the test (`testOutgoingWebhook`). */
export const OUTGOING_WEBHOOK_EVENTS = ["message.posted", "run.finished", "issue.created"] as const;
export type OutgoingWebhookEvent = (typeof OUTGOING_WEBHOOK_EVENTS)[number];

/** The job that sends one delivery. */
export const OUTGOING_WEBHOOK_JOB = "webhooks.deliver";
export const MAX_OUTGOING_WEBHOOKS = 20;
/** Attempts per delivery: the outbox's backoff spreads them over about 45 minutes (ADR 0005). */
export const DELIVERY_ATTEMPTS = 6;
/** Deliveries failed for good in a row that turn a webhook off. */
export const DISABLE_AFTER_FAILURES = 10;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Deliveries kept per webhook, newest first. */
export const KEPT_DELIVERIES = 100;
const MAX_CHANNELS = 50;
const MAX_URL = 2000;

export interface OutgoingWebhookDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** Resolves a host for the address check (injected in tests). */
  resolveHost?: ResolveHost;
}

export interface OutgoingWebhookView {
  id: string;
  name: string;
  url: string;
  events: OutgoingWebhookEvent[];
  channelIds: string[];
  enabled: boolean;
  /** Why it is off: `manual` or `failures`; null while on. */
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
}

type WebhookRow = typeof outgoingWebhooks.$inferSelect;

const aadFor = (orgId: string, id: string) => `outgoing-webhook|${orgId}|${id}`;

const viewOf = (w: WebhookRow): OutgoingWebhookView => ({
  id: w.id,
  name: w.name,
  url: w.url,
  events: w.events.filter((e): e is OutgoingWebhookEvent => (OUTGOING_WEBHOOK_EVENTS as readonly string[]).includes(e)),
  channelIds: w.channelIds,
  enabled: w.disabledAt === null,
  disabledReason: w.disabledAt ? w.disabledReason : null,
  consecutiveFailures: w.consecutiveFailures,
  lastSuccessAt: w.lastSuccessAt,
  lastFailureAt: w.lastFailureAt,
  createdAt: w.createdAt,
});

function cleanName(name: string) {
  const clean = name.trim().slice(0, 100);
  if (!clean) throw new ValidationError("Give the webhook a name", "outgoing_webhook.name");
  return clean;
}

function cleanEvents(events: string[]): OutgoingWebhookEvent[] {
  const unique = [...new Set(events)];
  if (unique.length === 0) throw new ValidationError("Choose at least one event", "outgoing_webhook.no_events");
  for (const e of unique) {
    if (!(OUTGOING_WEBHOOK_EVENTS as readonly string[]).includes(e))
      throw new ValidationError(`Unknown event ${e}`, "outgoing_webhook.event", { event: e });
  }
  return unique as OutgoingWebhookEvent[];
}

async function cleanUrl(deps: OutgoingWebhookDeps, raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL) throw new ValidationError("The address is too long", "url.invalid");
  return (await assertPublicHttpsUrl(trimmed, deps.resolveHost)).toString();
}

/** The channels chosen: the workspace's own channels of kind `channel`, never a DM nor a deleted one (ADR 0212 §3). */
async function cleanChannels(db: Database, orgId: string, ids: string[], events: OutgoingWebhookEvent[]) {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_CHANNELS)
    throw new ValidationError(`At most ${MAX_CHANNELS} channels`, "outgoing_webhook.too_many_channels");
  if (events.includes("message.posted") && unique.length === 0)
    throw new ValidationError("Choose the channels whose messages it sends", "outgoing_webhook.no_channels");
  if (unique.length === 0) return [];
  const found = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        inArray(channels.id, unique),
        eq(channels.kind, "channel"),
        sql`${channels.deletedAt} is null`,
      ),
    );
  if (found.length !== unique.length)
    throw new ValidationError("Only the workspace's channels can be chosen, never a DM", "outgoing_webhook.channel");
  return unique;
}

async function webhookOf(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(outgoingWebhooks)
    .where(and(eq(outgoingWebhooks.orgId, orgId), eq(outgoingWebhooks.id, id)));
  if (!row) throw new NotFoundError("Webhook not found");
  return row;
}

async function sealFor(deps: OutgoingWebhookDeps, orgId: string, id: string) {
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const secret = `whsec_${randomToken(32)}`;
  return { secret, sealed: await sealSecret(wrapper, secret, aadFor(orgId, id)) };
}

/** The workspace's outgoing webhooks (administrators). */
export async function listOutgoingWebhooks(deps: OutgoingWebhookDeps, actorId: string, orgId: string) {
  await requirePermission(deps.db, actorId, orgId, "administrator");
  const rows = await deps.db
    .select()
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.orgId, orgId))
    .orderBy(outgoingWebhooks.createdAt);
  return rows.map(viewOf);
}

/** A new outgoing webhook (administrators). Its secret is in the answer, the only time it is shown. */
export async function createOutgoingWebhook(
  deps: OutgoingWebhookDeps,
  actorId: string,
  orgId: string,
  input: { name: string; url: string; events: string[]; channelIds?: string[] },
): Promise<{ webhook: OutgoingWebhookView; secret: string }> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  const name = cleanName(input.name);
  const events = cleanEvents(input.events);
  const channelIds = await cleanChannels(db, orgId, input.channelIds ?? [], events);
  const url = await cleanUrl(deps, input.url);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.orgId, orgId));
  if ((count?.n ?? 0) >= MAX_OUTGOING_WEBHOOKS)
    throw new ValidationError(`At most ${MAX_OUTGOING_WEBHOOKS} webhooks per workspace`, "outgoing_webhook.limit");
  const id = crypto.randomUUID();
  const { secret, sealed } = await sealFor(deps, orgId, id);
  const [row] = await db
    .insert(outgoingWebhooks)
    .values({
      id,
      orgId,
      name,
      url,
      events,
      channelIds,
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("webhook insert returned nothing");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.outgoing_created",
    target: { type: "webhook", id },
    details: { name, host: new URL(url).host, events, channelIds },
  });
  return { webhook: viewOf(row), secret };
}

/**
 * Changes a webhook (administrators). Turning it on again starts its failures from zero; turning it off is `manual`.
 */
export async function updateOutgoingWebhook(
  deps: OutgoingWebhookDeps,
  actorId: string,
  orgId: string,
  id: string,
  patch: { name?: string; url?: string; events?: string[]; channelIds?: string[]; enabled?: boolean },
): Promise<OutgoingWebhookView> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  const current = await webhookOf(db, orgId, id);
  const events = patch.events ? cleanEvents(patch.events) : viewOf(current).events;
  const channelIds =
    patch.channelIds || patch.events
      ? await cleanChannels(db, orgId, patch.channelIds ?? current.channelIds, events)
      : current.channelIds;
  const set: Partial<typeof outgoingWebhooks.$inferInsert> = { events, channelIds, updatedAt: new Date() };
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.url !== undefined) set.url = await cleanUrl(deps, patch.url);
  if (patch.enabled === true && current.disabledAt) {
    Object.assign(set, { disabledAt: null, disabledReason: null, consecutiveFailures: 0 });
  } else if (patch.enabled === false && !current.disabledAt) {
    Object.assign(set, { disabledAt: new Date(), disabledReason: "manual" });
  }
  const [row] = await db
    .update(outgoingWebhooks)
    .set(set)
    .where(and(eq(outgoingWebhooks.orgId, orgId), eq(outgoingWebhooks.id, id)))
    .returning();
  if (!row) throw new NotFoundError("Webhook not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.outgoing_updated",
    target: { type: "webhook", id },
    details: {
      name: row.name,
      host: new URL(row.url).host,
      events: row.events,
      channelIds: row.channelIds,
      enabled: row.disabledAt === null,
    },
  });
  return viewOf(row);
}

export async function deleteOutgoingWebhook(deps: OutgoingWebhookDeps, actorId: string, orgId: string, id: string) {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  const [row] = await db
    .delete(outgoingWebhooks)
    .where(and(eq(outgoingWebhooks.orgId, orgId), eq(outgoingWebhooks.id, id)))
    .returning({ name: outgoingWebhooks.name, url: outgoingWebhooks.url });
  if (!row) throw new NotFoundError("Webhook not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.outgoing_deleted",
    target: { type: "webhook", id },
    details: { name: row.name, host: new URL(row.url).host },
  });
}

/** A new secret (administrators), shown once: the old one stops signing at once. */
export async function rotateOutgoingWebhookSecret(
  deps: OutgoingWebhookDeps,
  actorId: string,
  orgId: string,
  id: string,
): Promise<{ secret: string }> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  await webhookOf(db, orgId, id);
  const { secret, sealed } = await sealFor(deps, orgId, id);
  await db
    .update(outgoingWebhooks)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      updatedAt: new Date(),
    })
    .where(and(eq(outgoingWebhooks.orgId, orgId), eq(outgoingWebhooks.id, id)));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.outgoing_secret_changed",
    target: { type: "webhook", id },
  });
  return { secret };
}

const deliveryJob = (orgId: string, deliveryId: string) => ({
  orgId,
  kind: OUTGOING_WEBHOOK_JOB,
  payload: { deliveryId },
  dedupeKey: `${OUTGOING_WEBHOOK_JOB}:${deliveryId}`,
  maxAttempts: DELIVERY_ATTEMPTS,
});

/** Testar (administrators): a `ping` delivery, sent down the same path as an event's. */
export async function testOutgoingWebhook(
  deps: OutgoingWebhookDeps,
  actorId: string,
  orgId: string,
  id: string,
): Promise<{ deliveryId: string }> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  const webhook = await webhookOf(db, orgId, id);
  if (webhook.disabledAt) throw new ValidationError("Turn the webhook on first", "outgoing_webhook.disabled");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(deliveries)
      .values({ orgId, webhookId: id, event: "ping", subjectId: crypto.randomUUID() })
      .returning({ id: deliveries.id });
    if (!row) throw new Error("delivery insert returned nothing");
    await enqueue(tx, deliveryJob(orgId, row.id));
    return { deliveryId: row.id };
  });
}

export interface OutgoingWebhookDeliveryView {
  id: string;
  event: string;
  subjectId: string;
  status: (typeof deliveries.$inferSelect)["status"];
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** A webhook's latest deliveries, newest first (administrators). */
export async function listOutgoingWebhookDeliveries(
  deps: OutgoingWebhookDeps,
  actorId: string,
  orgId: string,
  id: string,
): Promise<OutgoingWebhookDeliveryView[]> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "administrator");
  await webhookOf(db, orgId, id);
  return db
    .select({
      id: deliveries.id,
      event: deliveries.event,
      subjectId: deliveries.subjectId,
      status: deliveries.status,
      attempts: deliveries.attempts,
      responseStatus: deliveries.responseStatus,
      error: deliveries.error,
      createdAt: deliveries.createdAt,
      finishedAt: deliveries.finishedAt,
    })
    .from(deliveries)
    .where(and(eq(deliveries.orgId, orgId), eq(deliveries.webhookId, id)))
    .orderBy(desc(deliveries.createdAt))
    .limit(KEPT_DELIVERIES);
}

// ── Queueing (ADR 0212 §4) ──────────────────────────────────────────────────────────────────────────────────────

export interface WebhookEventRef {
  orgId: SQL;
  event: OutgoingWebhookEvent;
  /** What it is about: a message, a run or a task. */
  subjectId: SQL;
  /** Where it happened; null for a task made outside any channel. Never sent unless it is of kind `channel`. */
  channelId: SQL;
  /** Only when this holds too (a message's insert: only when the message was written). */
  when?: SQL;
}

/**
 * The `insert … select` of the deliveries an event makes, `returning id, org_id`, for a CTE: one per webhook of the
 * workspace that is on, listens to the event and to its channel (a message's channel must be chosen; with no
 * channel chosen, the other events come from every channel), and only from a channel of kind `channel`. With no
 * webhook in the workspace it is one indexed lookup that writes nothing.
 */
export function webhookDeliveriesInsert(e: WebhookEventRef): SQL {
  const channel = sql`${e.channelId}::uuid`;
  const event = sql`${e.event}::text`;
  return sql`insert into ${deliveries} (org_id, webhook_id, event, subject_id)
    select w.org_id, w.id, ${event}, ${e.subjectId}::uuid
    from ${outgoingWebhooks} w
    where w.org_id = ${e.orgId}::uuid and w.disabled_at is null and ${event} = any(w.events)
      and (${channel} = any(w.channel_ids) or (cardinality(w.channel_ids) = 0 and ${event} <> 'message.posted'))
      and (${channel} is null or exists (select 1 from ${channels} wc
        where wc.id = ${channel} and wc.kind = 'channel' and wc.deleted_at is null))
      ${e.when ? sql`and ${e.when}` : sql``}
    on conflict do nothing
    returning id, org_id`;
}

/** The outbox rows for the deliveries a CTE named `cte` returned (a `select` to `union all` into an outbox insert). */
export const webhookDeliveryJobsSelect = (cte: string) =>
  sql`select gen_random_uuid(), d.org_id, ${OUTGOING_WEBHOOK_JOB}::text, jsonb_build_object('deliveryId', d.id),
    ${`${OUTGOING_WEBHOOK_JOB}:`}::text || d.id, ${DELIVERY_ATTEMPTS}::int from ${sql.raw(cte)} d`;

/** Queues an event's deliveries in the caller's transaction: one statement, nothing written when nobody listens. */
export async function queueWebhookEvent(
  db: Executor,
  e: { orgId: string; event: OutgoingWebhookEvent; subjectId: string; channelId: string | null },
) {
  await db.execute(sql`with hooked as (${webhookDeliveriesInsert({
    orgId: sql`${e.orgId}`,
    event: e.event,
    subjectId: sql`${e.subjectId}`,
    channelId: sql`${e.channelId}`,
  })})
    insert into ${schema.outbox} (id, org_id, kind, payload, dedupe_key, max_attempts)
    ${webhookDeliveryJobsSelect("hooked")}
    on conflict do nothing`);
}

// ── Sending (ADR 0212 §5–§7) ────────────────────────────────────────────────────────────────────────────────────

/** `sha256=<hex>`: the HMAC-SHA256 of the raw body under the webhook's secret. */
export const outgoingWebhookSignature = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** The event's data, read now; null when what it is about is gone or can no longer be sent. */
async function eventData(
  db: Database,
  orgId: string,
  event: string,
  subjectId: string,
): Promise<Record<string, unknown> | null> {
  if (event === "ping") return { test: true };
  if (event === "message.posted") {
    const rows = rowsOf<{
      id: string;
      channel_id: string;
      channel_name: string;
      thread_id: string | null;
      author_type: string;
      author_id: string | null;
      author_name: string | null;
      body: string;
      meta: Record<string, unknown> | null;
      created_at: string | Date;
    }>(
      await db.execute(sql`select m.id, m.channel_id, c.name as channel_name, m.thread_id, m.author_type::text as author_type,
        coalesce(m.author_user_id, m.author_agent_id::text) as author_id, coalesce(u.name, a.name) as author_name,
        m.body, m.meta, m.created_at
      from ${schema.messages} m
      join ${channels} c on c.id = m.channel_id and c.kind = 'channel' and c.deleted_at is null
      left join ${schema.users} u on u.id = m.author_user_id
      left join ${schema.agents} a on a.id = m.author_agent_id
      where m.org_id = ${orgId}::uuid and m.id = ${subjectId}::uuid and m.deleted_at is null
      limit 1`),
    );
    const m = rows[0];
    if (!m) return null;
    return {
      message: {
        id: m.id,
        channel: { id: m.channel_id, name: m.channel_name },
        threadId: m.thread_id,
        author: { type: m.author_type, id: m.author_id, name: m.author_name },
        text: readableBody(m.body, m.meta),
        createdAt: new Date(m.created_at).toISOString(),
      },
    };
  }
  if (event === "run.finished") {
    const rows = rowsOf<{
      id: string;
      agent_id: string;
      agent_handle: string;
      agent_name: string;
      channel_id: string;
      channel_name: string;
      thread_root_id: string;
      reply_message_id: string | null;
      status: string;
      created_at: string | Date;
      finished_at: string | Date | null;
    }>(
      await db.execute(sql`select r.id, r.agent_id, a.handle as agent_handle, a.name as agent_name, r.channel_id,
        c.name as channel_name, r.thread_root_id, r.reply_message_id, r.status::text as status, r.created_at,
        r.finished_at
      from ${schema.agentRuns} r
      join ${channels} c on c.id = r.channel_id and c.kind = 'channel' and c.deleted_at is null
      join ${schema.agents} a on a.id = r.agent_id
      where r.org_id = ${orgId}::uuid and r.id = ${subjectId}::uuid
      limit 1`),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      run: {
        id: r.id,
        status: r.status,
        agent: { id: r.agent_id, handle: r.agent_handle, name: r.agent_name },
        channel: { id: r.channel_id, name: r.channel_name },
        threadId: r.thread_root_id,
        replyMessageId: r.reply_message_id,
        createdAt: new Date(r.created_at).toISOString(),
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      },
    };
  }
  if (event === "issue.created") {
    const [issue] = await db
      .select({
        id: schema.issues.id,
        number: schema.issues.number,
        title: schema.issues.title,
        priority: schema.issues.priority,
        status: schema.issues.status,
        channelId: schema.issues.channelId,
        restricted: schema.issues.restricted,
        createdByType: schema.issues.createdByType,
        createdById: schema.issues.createdById,
        createdAt: schema.issues.createdAt,
      })
      .from(schema.issues)
      .where(and(eq(schema.issues.orgId, orgId), eq(schema.issues.id, subjectId)));
    if (!issue || issue.restricted) return null;
    return {
      issue: {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        priority: issue.priority,
        status: issue.status,
        channelId: issue.channelId,
        createdBy: { type: issue.createdByType, id: issue.createdById },
        createdAt: issue.createdAt.toISOString(),
      },
    };
  }
  return null;
}

export interface DeliveryDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** The fetch each attempt goes through; default `outboundFetch()`, made at send time (ADR 0212 §6). */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Attempt = { ok: true; status: number } | { ok: false; status: number | null; error: string; retry: boolean };

async function attempt(deps: DeliveryDeps, url: string, headers: Record<string, string>, body: string) {
  const send = deps.fetch ?? outboundFetch();
  let res: Response;
  try {
    res = await send(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof OutboundAddressError)
      return { ok: false, status: null, error: "address_refused", retry: false };
    const name = (error as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { ok: false, status: null, error: timedOut ? "timeout" : "network", retry: true } satisfies Attempt;
  }
  // Never read: the socket is let go.
  await res.body?.cancel().catch(() => {});
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status } satisfies Attempt;
  const retry = res.status === 408 || res.status === 429 || res.status >= 500;
  return { ok: false, status: res.status, error: `http_${res.status}`, retry } satisfies Attempt;
}

/**
 * A failed attempt the outbox tries again: the receiver's trouble, not the server's, so the worker logs it as a
 * warning (`retryable`), not as an error to report.
 */
export class WebhookDeliveryRetry extends Error {
  readonly retryable = true;
  constructor(readonly code: string) {
    super(`webhook delivery failed: ${code}`);
    this.name = "WebhookDeliveryRetry";
  }
}

/**
 * Keeps a webhook's newest `KEPT_DELIVERIES` that are over, and the pending ones younger than a day: an older one was
 * left by a job that ended without its handler (a worker lost on its last attempt), its attempts long spent.
 */
async function prune(db: Executor, webhookId: string) {
  await db.execute(sql`delete from ${deliveries} where webhook_id = ${webhookId}::uuid
    and (status <> 'pending' or created_at < now() - interval '1 day')
    and id not in (select id from ${deliveries} where webhook_id = ${webhookId}::uuid
      order by created_at desc limit ${KEPT_DELIVERIES})`);
}

/**
 * Job `webhooks.deliver`: sends one delivery (ADR 0212 §5–§7). Every outcome is written only while the delivery is
 * still `pending`, so a job run twice never counts twice; a retryable failure before the last attempt throws for the
 * outbox's backoff. Returns how it ended.
 */
export async function deliverOutgoingWebhook(
  deps: DeliveryDeps,
  deliveryId: string,
  ctx: { finalAttempt: boolean },
): Promise<"delivered" | "failed" | "skipped" | "done"> {
  const { db } = deps;
  const [row] = await db
    .select({ delivery: deliveries, webhook: outgoingWebhooks, closed: closedOrg })
    .from(deliveries)
    .innerJoin(outgoingWebhooks, eq(outgoingWebhooks.id, deliveries.webhookId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, deliveries.orgId))
    .where(eq(deliveries.id, deliveryId));
  if (row?.delivery.status !== "pending") return "done";
  const { delivery, webhook } = row;
  const pending = and(eq(deliveries.id, deliveryId), eq(deliveries.status, "pending"));
  const skip = async (error: string) => {
    await db.update(deliveries).set({ status: "skipped", error, finishedAt: new Date() }).where(pending);
    return "skipped" as const;
  };
  if (webhook.disabledAt) return skip("webhook_off");
  // A suspended workspace, or one being deleted, sends nothing out (ADR 0212 §7).
  if (row.closed) return skip("workspace_closed");
  const data = await eventData(db, delivery.orgId, delivery.event, delivery.subjectId);
  if (!data) return skip("gone");
  const body = JSON.stringify({
    id: delivery.id,
    type: delivery.event,
    createdAt: delivery.createdAt.toISOString(),
    sentAt: new Date().toISOString(),
    orgId: delivery.orgId,
    data,
  });
  const secret = await openSecret(
    deps.keyWrappers,
    { ciphertext: webhook.secretCiphertext, wrappedDataKey: webhook.wrappedDataKey, kekId: webhook.kekId },
    aadFor(webhook.orgId, webhook.id),
  );
  const result = await attempt(
    deps,
    webhook.url,
    {
      "content-type": "application/json",
      "user-agent": "agentes.chat-webhooks",
      "x-agentes-webhook-id": delivery.id,
      "x-agentes-webhook-event": delivery.event,
      "x-agentes-webhook-signature": outgoingWebhookSignature(secret, body),
    },
    body,
  );
  const now = new Date();
  const attempts = sql`${deliveries.attempts} + 1`;
  if (result.ok) {
    await db.transaction(async (tx) => {
      const done = await tx
        .update(deliveries)
        .set({ status: "delivered", attempts, responseStatus: result.status, error: null, finishedAt: now })
        .where(pending)
        .returning({ id: deliveries.id });
      if (done.length === 0) return;
      await tx
        .update(outgoingWebhooks)
        .set({ consecutiveFailures: 0, lastSuccessAt: now })
        .where(eq(outgoingWebhooks.id, webhook.id));
      await prune(tx, webhook.id);
    });
    return "delivered";
  }
  if (result.retry && !ctx.finalAttempt) {
    await db.update(deliveries).set({ attempts, responseStatus: result.status, error: result.error }).where(pending);
    throw new WebhookDeliveryRetry(result.error);
  }
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(deliveries)
      .set({ status: "failed", attempts, responseStatus: result.status, error: result.error, finishedAt: now })
      .where(pending)
      .returning({ id: deliveries.id });
    if (failed.length === 0) return;
    const off = sql`${outgoingWebhooks.disabledAt} is null and ${outgoingWebhooks.consecutiveFailures} + 1 >= ${DISABLE_AFTER_FAILURES}`;
    await tx
      .update(outgoingWebhooks)
      .set({
        consecutiveFailures: sql`${outgoingWebhooks.consecutiveFailures} + 1`,
        lastFailureAt: now,
        disabledAt: sql`case when ${off} then ${now.toISOString()}::timestamptz else ${outgoingWebhooks.disabledAt} end`,
        disabledReason: sql`case when ${off} then 'failures' else ${outgoingWebhooks.disabledReason} end`,
      })
      .where(eq(outgoingWebhooks.id, webhook.id));
    await prune(tx, webhook.id);
  });
  return "failed";
}
