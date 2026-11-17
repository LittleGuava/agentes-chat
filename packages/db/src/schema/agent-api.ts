import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A key that opens one agent's REST API (ADR 0210): `agk_…`, shown once and stored only as sha256. Messages sent with
 * it are posted as `created_by_user_id`, in a room of the key's own.
 */
export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdByUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    tokenHash: text().notNull().unique(),
    /** The secret's last four characters, to tell keys apart in a list. */
    lastFour: text().notNull(),
    /** Null: no expiry. */
    expiresAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    /** Who revoked it (a person's id), null when the server did (the creator left, a password reset). */
    revokedBy: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_api_keys_live_idx").on(t.orgId, t.agentId).where(sql`${t.revokedAt} is null`),
    index().on(t.createdByUserId),
  ],
);

export type AgentApiKey = typeof agentApiKeys.$inferSelect;
