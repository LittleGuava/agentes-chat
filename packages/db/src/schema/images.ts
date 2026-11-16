import { bigint, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { agentRuns } from "./runtime";
import { organizations } from "./tenancy";

/**
 * A picture an agent asked `generate_image` for (ADR 0213): the slot it took before the provider was called, so a
 * reply's and a day's limits hold when several calls come at once. `pending` while it is made, then `done` or
 * `failed`; a `pending` row older than the gateway's wait counts as failed (its process died). What the picture cost
 * is on its `usage_records` row; `cost_nano_usd` here is the same number, for the day's count without a join.
 */
export const imageGenerations = pgTable(
  "image_generations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /** The reply it was made for; null for a call without a run (a mission task's). */
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    status: text({ enum: ["pending", "done", "failed"] })
      .notNull()
      .default("pending"),
    provider: text().notNull(),
    model: text().notNull(),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.createdAt),
    index().on(t.runId),
  ],
);
