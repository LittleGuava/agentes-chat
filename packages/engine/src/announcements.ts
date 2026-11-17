import { and, type Database, desc, eq, isNull, lte, or, type SQL, schema, sql } from "@agenteschat/db";
import { NotFoundError, ValidationError } from "./errors";

/**
 * Announcements (ADR 0056, addendum on announcements): what the people who run the instance tell its people, written
 * through the operator API and shown by the apps as a card each person closes for good.
 */

const { announcements, announcementDismissals: dismissals, organizations } = schema;

export const ANNOUNCEMENT_AUDIENCES = schema.ANNOUNCEMENT_AUDIENCES;

/** The most a person is shown at once in a workspace. */
export const ANNOUNCEMENTS_SHOWN_MAX = 5;
/** The most the operator's list returns. */
export const ANNOUNCEMENTS_LIST_MAX = 200;

export interface AnnouncementLink {
  /** An `https` address, checked where it enters. */
  url: string;
  /** Null: the apps' own words. */
  label: string | null;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  link: AnnouncementLink | null;
  audience: schema.AnnouncementAudience;
  /** Set only for `workspace`. */
  orgId: string | null;
  /** Null: now on create, unchanged on update. */
  startsAt: Date | null;
  /** Null: until removed. */
  endsAt: Date | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  link: AnnouncementLink | null;
  audience: schema.AnnouncementAudience;
  orgId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Where a person looks from: the workspace on screen, and whether they hold `administrator` there. */
export interface AnnouncementViewer {
  userId: string;
  orgId: string;
  admin: boolean;
}

const COLUMNS = {
  id: announcements.id,
  title: announcements.title,
  body: announcements.body,
  linkUrl: announcements.linkUrl,
  linkLabel: announcements.linkLabel,
  audience: announcements.audience,
  orgId: announcements.orgId,
  startsAt: announcements.startsAt,
  endsAt: announcements.endsAt,
  createdAt: announcements.createdAt,
  updatedAt: announcements.updatedAt,
};

type Row = typeof announcements.$inferSelect;

const toAnnouncement = ({ linkUrl, linkLabel, ...row }: Row): Announcement => ({
  ...row,
  link: linkUrl ? { url: linkUrl, label: linkLabel } : null,
});

/** Live for this viewer at `now`, closed or not: the one rule of who sees what and when. */
function reaches(viewer: AnnouncementViewer, now: Date): SQL | undefined {
  return and(
    lte(announcements.startsAt, now),
    or(isNull(announcements.endsAt), sql`${announcements.endsAt} > ${now}`),
    or(
      eq(announcements.audience, "everyone"),
      viewer.admin ? eq(announcements.audience, "admins") : undefined,
      and(eq(announcements.audience, "workspace"), eq(announcements.orgId, viewer.orgId)),
    ),
  );
}

/** The row as stored: the start resolved, the period and the workspace checked. */
async function stored(db: Database, input: AnnouncementInput, startsAt: Date) {
  if (input.endsAt && input.endsAt.getTime() <= startsAt.getTime()) {
    throw new ValidationError("endsAt must come after startsAt", "announcement.period");
  }
  if (input.orgId) {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));
    if (!org) throw new NotFoundError("No workspace with this id");
  }
  return {
    title: input.title,
    body: input.body,
    linkUrl: input.link?.url ?? null,
    linkLabel: input.link?.label ?? null,
    audience: input.audience,
    orgId: input.audience === "workspace" ? input.orgId : null,
    startsAt,
    endsAt: input.endsAt,
  };
}

/** How many people closed it. */
const DISMISSALS = sql<number>`(select count(*) from ${dismissals} where ${dismissals.announcementId} = ${announcements.id})::int`;

/** As the operator reads it: with how many people closed it. */
export type OperatorAnnouncement = Announcement & { dismissals: number };

const withCount = ({ dismissals: count, ...row }: Row & { dismissals: number }): OperatorAnnouncement => ({
  ...toAnnouncement(row),
  dismissals: count,
});

export async function createAnnouncement(
  db: Database,
  input: AnnouncementInput,
  now = new Date(),
): Promise<OperatorAnnouncement> {
  const [row] = await db
    .insert(announcements)
    .values(await stored(db, input, input.startsAt ?? now))
    .returning(COLUMNS);
  if (!row) throw new Error("announcement not stored");
  return { ...toAnnouncement(row), dismissals: 0 };
}

/** Every field but the id: whoever closed it doesn't see it again. Null when there is none. */
export async function updateAnnouncement(db: Database, id: string, input: AnnouncementInput, now = new Date()) {
  const [current] = await db
    .select({ startsAt: announcements.startsAt })
    .from(announcements)
    .where(eq(announcements.id, id));
  if (!current) return null;
  const values = await stored(db, input, input.startsAt ?? current.startsAt);
  await db
    .update(announcements)
    .set({ ...values, updatedAt: now })
    .where(eq(announcements.id, id));
  const [row] = await db
    .select({ ...COLUMNS, dismissals: DISMISSALS })
    .from(announcements)
    .where(eq(announcements.id, id));
  return row ? withCount(row) : null;
}

/** Removes it and who closed it; false when there was none. */
export async function deleteAnnouncement(db: Database, id: string) {
  const gone = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
  return gone.length > 0;
}

/** Every announcement, live or not, newest first, with how many people closed it. */
export async function listAnnouncements(db: Database, limit = ANNOUNCEMENTS_LIST_MAX) {
  const rows = await db
    .select({ ...COLUMNS, dismissals: DISMISSALS })
    .from(announcements)
    .orderBy(desc(announcements.createdAt), desc(announcements.id))
    .limit(limit + 1);
  return {
    announcements: rows.slice(0, limit).map(withCount),
    more: rows.length > limit,
  };
}

/** What a person is shown in a workspace now: live for them and not closed, newest first. */
export async function announcementsFor(db: Database, viewer: AnnouncementViewer, now = new Date()) {
  const rows = await db
    .select(COLUMNS)
    .from(announcements)
    .where(
      and(
        reaches(viewer, now),
        sql`not exists (select 1 from ${dismissals} where ${dismissals.announcementId} = ${announcements.id}
          and ${dismissals.userId} = ${viewer.userId})`,
      ),
    )
    .orderBy(desc(announcements.startsAt), desc(announcements.createdAt))
    .limit(ANNOUNCEMENTS_SHOWN_MAX);
  return rows.map(toAnnouncement);
}

/**
 * Closes one for this person, for good and in every workspace. Again changes nothing. `NotFoundError` for one they
 * aren't shown here now.
 */
export async function dismissAnnouncement(db: Database, viewer: AnnouncementViewer, id: string, now = new Date()) {
  const [shown] = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(and(eq(announcements.id, id), reaches(viewer, now)));
  if (!shown) throw new NotFoundError("No such announcement");
  await db.insert(dismissals).values({ announcementId: id, userId: viewer.userId }).onConflictDoNothing();
}
