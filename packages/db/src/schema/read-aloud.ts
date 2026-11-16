import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

/**
 * An agent's reply read aloud (ADR 0209), on the workspace's storage: a cache, made once for everyone who listens and
 * gone after `READ_ALOUD_CACHE_DAYS`. `key` is a hash of the engine, model, voice and text, so an edited reply or another
 * voice makes a new one. The rows a person made are what fair use counts.
 */
export const readAloudClips = pgTable(
  "read_aloud_clips",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** No foreign key: `messages` is partitioned (ADR 0009). */
    messageId: uuid().notNull(),
    key: text().notNull(),
    /** Who asked first. */
    userId: text().references(() => users.id, { onDelete: "set null" }),
    engine: text().notNull(),
    voice: text().notNull(),
    /** What the engine bills by. */
    chars: integer().notNull(),
    /** Null: platform storage, as on `voice_clips`. */
    storageConfigId: uuid(),
    blobKey: text().notNull(),
    contentType: text().notNull(),
    size: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.messageId, t.key), index().on(t.userId, t.createdAt), index().on(t.createdAt)],
);
