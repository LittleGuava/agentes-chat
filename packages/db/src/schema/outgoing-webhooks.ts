import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A workspace's outgoing webhook (ADR 0212): the events it sends, signed with its secret, to an address its
 * administrators chose. `channelIds` narrows the events that have a channel (and is required for `message.posted`);
 * only channels of kind `channel` are ever sent from, never a DM. Turned off by hand or after
 * `consecutiveFailures` reached the limit (`disabledReason`).
 */
export const outgoingWebhooks = pgTable(
  "outgoing_webhooks",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    url: text().notNull(),
    events: text().array().notNull(),
    channelIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    secretCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Deliveries that failed for good in a row; a delivered one sets it back to zero. */
    consecutiveFailures: integer().notNull().default(0),
    lastSuccessAt: timestamp({ withTimezone: true }),
    lastFailureAt: timestamp({ withTimezone: true }),
    disabledAt: timestamp({ withTimezone: true }),
    /** `manual` (an admin) or `failures` (too many in a row). */
    disabledReason: text(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * One event for one webhook (ADR 0212 §4, §8): what it is about by id only, its body built when it is sent, so this
 * log never keeps a copy of a message. `pending` until it is `delivered`, `failed` or `skipped` (what it was about is
 * gone, or the webhook is off). The newest 100 per webhook are kept.
 */
export const outgoingWebhookDeliveries = pgTable(
  "outgoing_webhook_deliveries",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    webhookId: uuid()
      .notNull()
      .references(() => outgoingWebhooks.id, { onDelete: "cascade" }),
    event: text().notNull(),
    /** The message, run or task it is about; a test's own id for `ping`. */
    subjectId: uuid().notNull(),
    status: text().$type<"pending" | "delivered" | "failed" | "skipped">().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    /** The last answer's HTTP status, null when none came. */
    responseStatus: integer(),
    /** A short code for the last failure (`timeout`, `network`, `address_refused`, `http_500`…), never a body. */
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.webhookId, t.event, t.subjectId), index().on(t.webhookId, t.createdAt)],
);
