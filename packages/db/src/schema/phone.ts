import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

/** What the phone app lets the person's own runs use on it (ADR 0205). */
export type PhoneTool = "contacts";

/**
 * A person's yes, from the phone app, to the agents they talk to using their phone's own apps (ADR 0205): per person
 * and workspace, sent only by the phone app. No row: nothing on any phone of theirs is reachable. Leaving the
 * workspace removes it (`removeMember`).
 */
export const phoneToolGrants = pgTable(
  "phone_tool_grants",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Validated in code (`PHONE_TOOLS`); never empty: turning everything off deletes the row. */
    tools: text().array().$type<PhoneTool[]>().notNull(),
    /** The phone's own name as its app read it ("Ana's iPhone"), shown back to the person. */
    deviceName: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** A phone job's state: the first answer wins, and a job past `expiresAt` takes none. */
export type PhoneJobStatus = "pending" | "done" | "declined" | "failed" | "expired";

/**
 * One request from an agent's run to the phone of the person behind it (ADR 0205): the phone app lists the pending
 * ones and answers each. The waiting tool wipes `result` once it has read it, so contacts don't stay here; the rest of
 * the row (the search, how it ended) counts a run's searches and is pruned after a day when the person's next starts.
 */
export const phoneJobs = pgTable(
  "phone_jobs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Whose phone: always the person behind the run. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid().notNull(),
    /** `find_contact`, validated in code (`PHONE_JOB_KINDS`). */
    kind: text().$type<"find_contact">().notNull(),
    input: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text().$type<PhoneJobStatus>().notNull().default("pending"),
    /** The phone's answer, validated by the route that took it. */
    result: jsonb().$type<Record<string, unknown>>(),
    /** A failed job's reason, as the phone said it. */
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.userId, t.status)],
);
