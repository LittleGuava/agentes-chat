import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "./storage";
import { organizations } from "./tenancy";

/**
 * A Drive page anyone with its address opens (ADR 0211), at `<PUBLISHED_PAGES_URL>/p/<token>/`. It shows `version`,
 * the one a person approved, never the file's latest. Revoked rows stay (`revokedAt`) for the audit; a revoked
 * address never comes back.
 */
export const publishedPages = pgTable(
  "published_pages",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    /** 32 random bytes, base64url: the only thing that finds the page. */
    token: text().notNull(),
    /** `person` or `agent`, as on `artifacts`. */
    createdByType: text().notNull(),
    createdById: text().notNull(),
    /** An agent's: the run it published from. */
    runId: uuid(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedById: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.token),
    // One live page per file: publishing again moves it to the new version and keeps its address.
    uniqueIndex("published_pages_live_artifact").on(t.artifactId).where(sql`${t.revokedAt} is null`),
    index().on(t.orgId, t.createdAt),
  ],
);
