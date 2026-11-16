import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/** What kind of failure an issue groups (ADR 0214 §2). */
export type HealthIssueKind = "tool_error" | "timeout" | "run_failed" | "queue_stalled" | "job_failed" | "cost_spike";

/**
 * A workspace's failures with one signature (ADR 0214): how many, since when, until when. The title is the failure's
 * normalized text (`normalizeFailure`), never its raw text.
 */
export const healthIssues = pgTable(
  "health_issues",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<HealthIssueKind>().notNull(),
    /** `kind:` and 16 hex characters (`failureSignature`). */
    signature: text().notNull(),
    title: text().notNull(),
    /** What failed: the tool's name, the job's kind, or a run's error code (`run.provider_timeout`); null for a cost spike. */
    source: text(),
    /** The provider or brain a run's failure names (`runErrorDetail`'s params), shown with its code. */
    subject: text(),
    /** The agent, when every occurrence is one agent's (a cost spike is grouped by agent). */
    agentId: uuid(),
    count: integer().notNull().default(0),
    firstAt: timestamp({ withTimezone: true }).notNull(),
    lastAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.orgId, t.signature), index().on(t.orgId, t.lastAt)],
);

/**
 * One failure counted in an issue (ADR 0214 §3): its key (the step's, run's or job's id) is counted once, whichever
 * scan sees it. References only, the issue's examples. Deleted after 14 days; the issue keeps its count.
 */
export const healthOccurrences = pgTable(
  "health_occurrences",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    issueId: uuid()
      .notNull()
      .references(() => healthIssues.id, { onDelete: "cascade" }),
    /** `step:<id>`, `run:<id>` or `job:<id>`. */
    ref: text().notNull(),
    agentId: uuid(),
    runId: uuid(),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.orgId, t.ref), index().on(t.issueId, t.at), index().on(t.at)],
);
