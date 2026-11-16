import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/** Who an announcement is for (ADR 0056, addendum on announcements). */
export const ANNOUNCEMENT_AUDIENCES = ["everyone", "admins", "workspace"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/**
 * What the people who run the instance tell its people (ADR 0056, addendum on announcements): written only through the
 * operator API, shown by the apps as a card each person closes. Installation-level: `org_id` is set only for an
 * announcement to one workspace, which is deleted with it.
 */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Plain text, one line. */
    title: text().notNull(),
    /** Plain text; line breaks kept. */
    body: text().notNull().default(""),
    /** An `https` address opened outside the app; null: no link. */
    linkUrl: text(),
    /** The link's words; null: the apps' own. */
    linkLabel: text(),
    audience: text({ enum: ANNOUNCEMENT_AUDIENCES }).notNull(),
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    startsAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Null: until removed. */
    endsAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("announcements_audience", sql`${t.audience} in ('everyone', 'admins', 'workspace')`),
    check("announcements_workspace", sql`(${t.audience} = 'workspace') = (${t.orgId} is not null)`),
    check("announcements_period", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("announcements_link", sql`${t.linkLabel} is null or ${t.linkUrl} is not null`),
    index("announcements_created").on(t.createdAt, t.id),
    index("announcements_org").on(t.orgId),
  ],
);

/** Who closed which announcement, for good and across workspaces: a person's, so no `org_id`. */
export const announcementDismissals = pgTable(
  "announcement_dismissals",
  {
    announcementId: uuid()
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dismissedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.announcementId] }), index().on(t.announcementId)],
);
