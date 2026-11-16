import { and, type Database, desc, type Executor, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { failureSignature, normalizeFailure } from "./health-signature";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { runErrorDetail } from "./runs";

/**
 * Health (ADR 0214): a workspace's failures grouped into issues by signature, from rows the server already writes.
 * Plain code, no model call. `scanHealth` is the outbox job `health.scan`; `listHealthIssues` is the admins' read and
 * `operatorHealthIssues` the operator's, without titles.
 */

type HealthIssueKind = schema.HealthIssueKind;
const { healthIssues, healthOccurrences, agents } = schema;

/** The outbox job that scans every workspace. */
export const HEALTH_SCAN_JOB = "health.scan";

const MINUTE_MS = 60_000;
/** How often the scan is queued (its window is in the dedupe key). */
export const HEALTH_SCAN_EVERY_MS = 5 * MINUTE_MS;
/** What a scan rereads: steps and endings of the last two hours, of runs created in the last day (ADR 0214 §3). */
const WINDOW_MS = 120 * MINUTE_MS;
const RUNS_MS = 24 * 60 * MINUTE_MS;
/** A job still waiting this long after it was due is stalled. */
const STALLED_MS = 5 * MINUTE_MS;
/** A run that cost the workspace more than this is a cost spike ($5, in nano-USD). */
export const COST_SPIKE_NANO_USD = 5_000_000_000;
/** Occurrences are kept this long, as examples and to count each once; the issue keeps its count. */
const KEEP_MS = 14 * 24 * 60 * MINUTE_MS;
/** The most rows a scan reads from each source. */
const SOURCE_MAX = 5000;
/** The examples an issue shows. */
const EXAMPLES = 3;

/**
 * The codes the Tool Gateway gives a call it refused itself (a refusal is the policy working, not a failure). Its
 * refusals also carry `data.refusal`.
 */
const GATEWAY_REFUSALS = [
  "tool.not_allowed",
  "tool.credential",
  "tool.why_missing",
  "autonomy",
  "team",
  "team.action_seen",
  "approval.ahead_refused",
  "secret.connector_first",
];

/** One failure, before it is counted. */
interface Failure {
  orgId: string;
  kind: HealthIssueKind;
  source: string | null;
  subject: string | null;
  title: string;
  /** What the signature hashes besides the kind and source. */
  key: string;
  agentId: string | null;
  runId: string | null;
  ref: string;
  at: Date;
}

const asDate = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));

async function toolErrors(db: Executor, now: Date): Promise<Failure[]> {
  const rows = rowsOf<{
    id: string;
    org_id: string;
    agent_id: string;
    run_id: string;
    at: unknown;
    name: string | null;
    content: string | null;
  }>(
    await db.execute(sql`
      select s.id, s.org_id, r.agent_id, s.run_id, s.created_at as at, s.data->>'name' as name,
        left(s.data->>'content', 2000) as content
      from agent_runs r join agent_run_steps s on s.run_id = r.id
      where r.created_at >= ${new Date(now.getTime() - RUNS_MS)}
        and s.kind = 'tool_result'
        and s.created_at >= ${new Date(now.getTime() - WINDOW_MS)} and s.created_at <= ${now}
        and s.data->>'isError' = 'true'
        and s.data->'data'->>'refusal' is null
        and s.data->'data'->>'secretRequestId' is null and s.data->'data'->>'questionId' is null
        and coalesce(s.data->'data'->>'code', '') not in (${sql.join(
          GATEWAY_REFUSALS.map((c) => sql`${c}`),
          sql`, `,
        )})
      limit ${SOURCE_MAX}`),
  );
  return rows.map((r) => {
    const title = normalizeFailure(r.content ?? "");
    return {
      orgId: r.org_id,
      kind: "tool_error",
      source: r.name ?? "",
      subject: null,
      title,
      key: title,
      agentId: r.agent_id,
      runId: r.run_id,
      ref: `step:${r.id}`,
      at: asDate(r.at),
    };
  });
}

async function failedRuns(db: Executor, now: Date): Promise<Failure[]> {
  const rows = rowsOf<{ id: string; org_id: string; agent_id: string; error: string | null; at: unknown }>(
    await db.execute(sql`
      select id, org_id, agent_id, error, finished_at as at from agent_runs
      where created_at >= ${new Date(now.getTime() - RUNS_MS)} and status = 'failed'
        and finished_at >= ${new Date(now.getTime() - WINDOW_MS)} and finished_at <= ${now}
      limit ${SOURCE_MAX}`),
  );
  return rows.flatMap((r): Failure[] => {
    const detail = runErrorDetail(r.error) ?? { errorCode: "run.failed" };
    if (detail.errorCode === "run.canceled") return [];
    const params = detail.errorParams ?? {};
    // One name and one text, as the apps word the code (`healthHeadline`): a wrong key's are its model's provider and
    // the key's.
    const subject = params.provider || params.brain || params.model || params.modelProvider || null;
    const title = normalizeFailure(params.detail ?? params.keyProvider ?? "");
    return [
      {
        orgId: r.org_id,
        kind: detail.errorCode.includes("timeout") ? "timeout" : "run_failed",
        source: detail.errorCode,
        subject,
        title,
        key: `${subject ?? ""}\u0000${title}`,
        agentId: r.agent_id,
        runId: r.id,
        ref: `run:${r.id}`,
        at: asDate(r.at),
      },
    ];
  });
}

async function queueFailures(db: Executor, now: Date): Promise<Failure[]> {
  const stalled = rowsOf<{ id: string; org_id: string; kind: string }>(
    await db.execute(sql`
      select id, org_id, kind from outbox
      where status = 'pending' and org_id is not null and next_attempt_at <= ${new Date(now.getTime() - STALLED_MS)}
      limit ${SOURCE_MAX}`),
  );
  const dead = rowsOf<{ id: string; org_id: string; kind: string; last_error: string | null; at: unknown }>(
    await db.execute(sql`
      select id, org_id, kind, last_error, next_attempt_at as at from outbox
      where status = 'failed' and org_id is not null and created_at >= ${new Date(now.getTime() - RUNS_MS)}
      limit ${SOURCE_MAX}`),
  );
  const job = (r: { id: string; org_id: string; kind: string; at: unknown }) => ({
    orgId: r.org_id,
    source: r.kind,
    subject: null,
    agentId: null,
    runId: null,
    at: asDate(r.at),
  });
  return [
    // When the scan found it stalled, not when it was due: an occurrence older than 14 days is deleted, and a job due
    // longer ago than that would be found again, and counted again, at every scan.
    ...stalled.map(
      (r): Failure => ({
        ...job({ ...r, at: now }),
        kind: "queue_stalled",
        title: "",
        key: "",
        ref: `job:${r.id}:stalled`,
      }),
    ),
    ...dead.map((r): Failure => {
      const title = normalizeFailure(r.last_error ?? "");
      return { ...job(r), kind: "job_failed", title, key: title, ref: `job:${r.id}:failed` };
    }),
  ];
}

async function costSpikes(db: Executor, now: Date): Promise<Failure[]> {
  const since = new Date(now.getTime() - RUNS_MS);
  const rows = rowsOf<{ id: string; org_id: string; agent_id: string; at: unknown }>(
    await db.execute(sql`
      select r.id, r.org_id, r.agent_id, r.finished_at as at
      from agent_runs r join usage_records u on u.org_id = r.org_id and u.run_id = r.id
      where r.created_at >= ${since} and u.created_at >= ${since}
        and r.finished_at >= ${new Date(now.getTime() - WINDOW_MS)} and r.finished_at <= ${now}
        and u.billed_to = 'org'
      group by r.id, r.org_id, r.agent_id, r.finished_at
      having sum(u.cost_nano_usd) > ${COST_SPIKE_NANO_USD}
      limit ${SOURCE_MAX}`),
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    kind: "cost_spike",
    source: null,
    subject: null,
    title: "",
    key: r.agent_id,
    agentId: r.agent_id,
    runId: r.id,
    ref: `run:${r.id}:cost`,
    at: asDate(r.at),
  }));
}

/**
 * Job `health.scan`: every workspace's failures of the last window counted into their issues (ADR 0214 §3). Each
 * failure's occurrence is inserted once (`ON CONFLICT DO NOTHING`) and only what was inserted moves an issue, so a
 * second scan over the same rows changes nothing. Returns how many failures were new.
 */
export async function scanHealth(db: Database, now = new Date()): Promise<number> {
  const found = [
    ...(await toolErrors(db, now)),
    ...(await failedRuns(db, now)),
    ...(await queueFailures(db, now)),
    ...(await costSpikes(db, now)),
  ];
  let counted = 0;
  if (found.length > 0) {
    // What an earlier scan already counted is left out before any issue is touched.
    const seen = new Set<string>();
    for (let i = 0; i < found.length; i += 1000) {
      const part = found.slice(i, i + 1000);
      const rows = await db
        .select({ orgId: healthOccurrences.orgId, ref: healthOccurrences.ref })
        .from(healthOccurrences)
        .where(inArray(healthOccurrences.ref, [...new Set(part.map((f) => f.ref))]));
      for (const r of rows) seen.add(`${r.orgId}\u0000${r.ref}`);
    }
    const groups = new Map<string, { signature: string; failures: Failure[] }>();
    for (const failure of found) {
      if (seen.has(`${failure.orgId}\u0000${failure.ref}`)) continue;
      const signature = failureSignature(failure.kind, failure.source, failure.key);
      const id = `${failure.orgId}\u0000${signature}`;
      const group = groups.get(id) ?? { signature, failures: [] };
      group.failures.push(failure);
      groups.set(id, group);
    }
    for (const { signature, failures } of groups.values()) counted += await countInto(db, signature, failures);
  }
  await db.delete(healthOccurrences).where(sql`${healthOccurrences.at} < ${new Date(now.getTime() - KEEP_MS)}`);
  return counted;
}

/** One issue's new failures, in one transaction: the issue made if new, its occurrences, then its count and times. */
async function countInto(db: Database, signature: string, failures: Failure[]): Promise<number> {
  const [first] = failures;
  if (!first) return 0;
  const agentIds = new Set(failures.map((f) => f.agentId));
  return db.transaction(async (tx) => {
    const [issue] = await tx
      .insert(healthIssues)
      .values({
        orgId: first.orgId,
        kind: first.kind,
        signature,
        title: first.title,
        source: first.source,
        subject: first.subject,
        agentId: agentIds.size === 1 ? first.agentId : null,
        firstAt: first.at,
        lastAt: first.at,
      })
      .onConflictDoUpdate({
        target: [healthIssues.orgId, healthIssues.signature],
        // A no-op that returns the row: the count and times move below, by what was really inserted.
        set: { signature: sql`excluded.signature` },
      })
      .returning({ id: healthIssues.id, agentId: healthIssues.agentId, count: healthIssues.count });
    if (!issue) return 0;
    const inserted = await tx
      .insert(healthOccurrences)
      .values(
        failures.map((f) => ({
          orgId: f.orgId,
          issueId: issue.id,
          ref: f.ref,
          agentId: f.agentId,
          runId: f.runId,
          at: f.at,
        })),
      )
      .onConflictDoNothing()
      .returning({ at: healthOccurrences.at, agentId: healthOccurrences.agentId });
    if (inserted.length === 0) return 0;
    const times = inserted.map((o) => o.at.getTime());
    // An issue that was one agent's stays so only while every new occurrence is that agent's too.
    const oneAgent = issue.count === 0 ? (agentIds.size === 1 ? first.agentId : null) : issue.agentId;
    const sameAgent = oneAgent !== null && inserted.every((o) => o.agentId === oneAgent);
    await tx
      .update(healthIssues)
      .set({
        count: sql`${healthIssues.count} + ${inserted.length}`,
        firstAt: sql`least(${healthIssues.firstAt}, ${new Date(Math.min(...times))})`,
        lastAt: sql`greatest(${healthIssues.lastAt}, ${new Date(Math.max(...times))})`,
        agentId: sameAgent ? oneAgent : null,
      })
      .where(eq(healthIssues.id, issue.id));
    return inserted.length;
  });
}

/** Queues `health.scan` for the five-minute window `now` is in (once, whatever replica asks: its dedupe key). */
export async function enqueueHealthScan(db: Executor, now = new Date()) {
  const window = Math.floor(now.getTime() / HEALTH_SCAN_EVERY_MS);
  await enqueue(db, {
    orgId: null,
    kind: HEALTH_SCAN_JOB,
    payload: {},
    dedupeKey: `${HEALTH_SCAN_JOB}:${window}`,
    maxAttempts: 3,
  });
}

export interface HealthExample {
  at: string;
  runId: string | null;
  /** Null when the failure was no agent's (a job), or the agent was removed (its id stays). */
  agent: { id: string; name: string | null } | null;
}

export interface HealthIssue {
  id: string;
  kind: HealthIssueKind;
  signature: string;
  title: string;
  source: string | null;
  subject: string | null;
  agentId: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  examples: HealthExample[];
}

/** The most issues a read returns, latest first. */
const ISSUES_MAX = 200;

/**
 * The workspace's issues, the latest first, for who may read the audit log (`view_audit`, ADR 0214 §5): it already
 * shows them why each call failed. Examples are references: when, which agent, which run; never the conversation.
 */
export async function listHealthIssues(
  db: Database,
  actorId: string,
  orgId: string,
): Promise<{ issues: HealthIssue[] }> {
  await requirePermission(db, actorId, orgId, "view_audit");
  const rows = await db
    .select()
    .from(healthIssues)
    .where(and(eq(healthIssues.orgId, orgId), sql`${healthIssues.count} > 0`))
    .orderBy(desc(healthIssues.lastAt))
    .limit(ISSUES_MAX);
  if (rows.length === 0) return { issues: [] };
  const latest = rowsOf<{ issue_id: string; at: unknown; run_id: string | null; agent_id: string | null }>(
    await db.execute(sql`
      select issue_id, at, run_id, agent_id from (
        select issue_id, at, run_id, agent_id,
          row_number() over (partition by issue_id order by at desc, id desc) as n
        from health_occurrences
        where org_id = ${orgId} and issue_id in (${sql.join(
          rows.map((r) => sql`${r.id}`),
          sql`, `,
        )})
      ) o where n <= ${EXAMPLES}
      order by at desc`),
  );
  const agentIds = [...new Set(latest.flatMap((o) => (o.agent_id ? [o.agent_id] : [])))];
  const names = new Map(
    agentIds.length === 0
      ? []
      : (
          await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
        ).map((a) => [a.id, a.name] as const),
  );
  const examples = new Map<string, HealthExample[]>();
  for (const o of latest) {
    const list = examples.get(o.issue_id) ?? [];
    list.push({
      at: asDate(o.at).toISOString(),
      runId: o.run_id,
      agent: o.agent_id ? { id: o.agent_id, name: names.get(o.agent_id) ?? null } : null,
    });
    examples.set(o.issue_id, list);
  }
  return {
    issues: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      signature: r.signature,
      title: r.title,
      source: r.source,
      subject: r.subject,
      agentId: r.agentId,
      count: r.count,
      firstAt: r.firstAt.toISOString(),
      lastAt: r.lastAt.toISOString(),
      examples: examples.get(r.id) ?? [],
    })),
  };
}

/** An issue as the operator reads it (ADR 0214 §6): facts only, never the title. */
export interface OperatorHealthIssue {
  kind: HealthIssueKind;
  signature: string;
  source: string | null;
  subject: string | null;
  agentId: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
}

/** A workspace's issues for the operator API, the latest first; null when there is no such workspace. */
export async function operatorHealthIssues(db: Executor, orgId: string): Promise<OperatorHealthIssue[] | null> {
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  if (!org) return null;
  const rows = await db
    .select({
      kind: healthIssues.kind,
      signature: healthIssues.signature,
      source: healthIssues.source,
      subject: healthIssues.subject,
      agentId: healthIssues.agentId,
      count: healthIssues.count,
      firstAt: healthIssues.firstAt,
      lastAt: healthIssues.lastAt,
    })
    .from(healthIssues)
    .where(and(eq(healthIssues.orgId, orgId), sql`${healthIssues.count} > 0`))
    .orderBy(desc(healthIssues.lastAt))
    .limit(ISSUES_MAX);
  return rows.map((r) => ({ ...r, firstAt: r.firstAt.toISOString(), lastAt: r.lastAt.toISOString() }));
}
