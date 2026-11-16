import { and, type Database, desc, eq, inArray, isNotNull, isNull, lte, not, schema, sql } from "@agenteschat/db";
import { type AwayItem, emailLocale, modeStamp, queueEmail } from "./email";
import { isAwayEmailMinutes } from "./notice-prefs";
import { inboxVisible, type NotificationLatest, type NotificationSource } from "./notifications";
import { pushQuote } from "./push";
import { accountInUse, closedOrg } from "./standing";

const { organizationMembers, organizations, notifications, users, agents, channels } = schema;

/**
 * The email of what a person missed while away from a workspace (ADR 0069, addendum 2026-11-15): the mentions, DMs and
 * finished work still unread in their inbox, once they were away their wait (`away_email_minutes`: 15, 60 or 1440)
 * and that long after the last one. Away is `active_at`, which an open socket moves every `ACTIVE_MARK_MS`: unknown
 * (null) is never away, so a server whose sockets don't mark it yet emails nobody.
 */

/** Which inbox kinds go in, by the email's group. Everything else (approvals have an email of their own) stays in the app. */
export const AWAY_KINDS = {
  mentions: ["mention"],
  dms: ["dm"],
  done: ["agent_reply", "mission_finished", "routine_finished"],
} as const satisfies Record<AwayItem["group"], readonly string[]>;
const KINDS: string[] = Object.values(AWAY_KINDS).flat();
const groupOf = (kind: string) =>
  (Object.keys(AWAY_KINDS) as AwayItem["group"][]).find((g) => (AWAY_KINDS[g] as readonly string[]).includes(kind));

/** How often an open socket marks its person active: well under the shortest wait (15 minutes). */
export const ACTIVE_MARK_MS = 5 * 60_000;
/** Nothing older than this goes in an email, however long the person was away. */
export const AWAY_LOOKBACK_MS = 24 * 3600_000;
/** A thing this new waits: a phone's push may still bring the person back to it. */
export const AWAY_SETTLE_MS = 10 * 60_000;
/** The most an email lists; the rest are counted. */
export const AWAY_ITEMS_SHOWN = 10;
/** People looked at per tick: the rest come on the next one. */
const PER_TICK = 500;

const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const minutes = sql`make_interval(mins => ${organizationMembers.awayEmailMinutes})`;

/**
 * Worker: one email per person due, in their language, then marked (`away_email_at`) in the same transaction, which
 * claims it first: two ticks at once, on two replicas too, queue one. The things it lists are only newer than the last
 * email and than when they were last active, so none comes twice.
 */
export async function queueAwayEmails(db: Database, publicUrl: string, now = new Date()): Promise<number> {
  const floor = sql`greatest(${organizationMembers.activeAt}, coalesce(${organizationMembers.awayEmailAt}, '-infinity'::timestamptz), ${at(new Date(now.getTime() - AWAY_LOOKBACK_MS))})`;
  const settled = new Date(now.getTime() - AWAY_SETTLE_MS);
  const waited = sql`(${organizationMembers.awayEmailAt} is null or ${organizationMembers.awayEmailAt} <= ${at(now)} - ${minutes})`;
  const due = await db
    .select({
      orgId: organizationMembers.orgId,
      userId: organizationMembers.userId,
      minutes: organizationMembers.awayEmailMinutes,
      activeAt: organizationMembers.activeAt,
      awayEmailAt: organizationMembers.awayEmailAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        sql`${organizationMembers.awayEmailMinutes} > 0`,
        accountInUse,
        isNotNull(organizationMembers.activeAt),
        sql`${organizationMembers.activeAt} <= ${at(now)} - ${minutes}`,
        waited,
        not(closedOrg),
        sql`exists (select 1 from ${notifications} n
          where n.org_id = ${organizationMembers.orgId} and n.user_id = ${organizationMembers.userId}
            and n.done_at is null and n.read_at is null and n.kind in (${sql.join(
              KINDS.map((k) => sql`${k}`),
              sql`, `,
            )})
            and n.updated_at > ${floor} and n.updated_at <= ${at(settled)})`,
      ),
    )
    .limit(PER_TICK);

  let queued = 0;
  for (const member of due) {
    if (!isAwayEmailMinutes(member.minutes) || !member.activeAt) continue;
    const since = new Date(
      Math.max(member.activeAt.getTime(), member.awayEmailAt?.getTime() ?? 0, now.getTime() - AWAY_LOOKBACK_MS),
    );
    const unseen = and(
      inboxVisible(member.orgId, member.userId, now),
      isNull(notifications.readAt),
      inArray(notifications.kind, KINDS),
      sql`${notifications.updatedAt} > ${at(since)}`,
      lte(notifications.updatedAt, settled),
    );
    const shown = await db
      .select()
      .from(notifications)
      .where(unseen)
      .orderBy(desc(notifications.updatedAt), desc(notifications.id))
      .limit(AWAY_ITEMS_SHOWN);
    if (shown.length === 0) continue;
    const [all] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(unseen);
    const more = Number(all?.n ?? 0) - shown.length;
    const items = await awayItems(db, member.orgId, shown);
    const [person] = await db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, member.userId));
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, member.orgId));
    if (!person) continue;
    const mode = await modeStamp(db, member.orgId);
    const claimed = await db.transaction(async (tx) => {
      const [won] = await tx
        .update(organizationMembers)
        .set({ awayEmailAt: now })
        .where(and(eq(organizationMembers.orgId, member.orgId), eq(organizationMembers.userId, member.userId), waited))
        .returning({ userId: organizationMembers.userId });
      if (!won) return false;
      await queueEmail(tx, {
        orgId: member.orgId,
        key: `away-digest:${member.orgId}:${member.userId}:${now.getTime()}`,
        to: [person.email],
        template: {
          kind: "away_digest",
          locale: emailLocale(person.locale),
          orgName: org?.name ?? "",
          items,
          ...(more > 0 ? { more } : {}),
          url: `${publicUrl.replace(/\/$/, "")}/org/${member.orgId}/notifications`,
          minutes: member.minutes,
          ...mode,
        },
      });
      return true;
    });
    if (claimed) queued++;
  }
  return queued;
}

/** The email's lines: the newest actor's name and face, where, and the start of what was said. */
async function awayItems(
  db: Database,
  orgId: string,
  rows: (typeof notifications.$inferSelect)[],
): Promise<AwayItem[]> {
  const actors = rows.map((r) => r.actors[0]);
  const agentIds = [...new Set(actors.flatMap((a) => (a?.type === "agent" ? [a.id] : [])))];
  const userIds = [...new Set(actors.flatMap((a) => (a?.type === "user" ? [a.id] : [])))];
  const channelIds = [
    ...new Set(rows.flatMap((r) => ((r.source as NotificationSource).channelId ? [r.source.channelId as string] : []))),
  ];
  const agentOf = new Map(
    (agentIds.length
      ? await db
          .select({ id: agents.id, name: agents.name, appearance: agents.appearance })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
      : []
    ).map((a) => [a.id, a]),
  );
  const userOf = new Map(
    (userIds.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const channelOf = new Map(
    (channelIds.length
      ? await db
          .select({ id: channels.id, name: channels.name, kind: channels.kind })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : []
    ).map((c) => [c.id, c]),
  );
  return rows.flatMap((r): AwayItem[] => {
    const group = groupOf(r.kind);
    if (!group) return [];
    const source = r.source as NotificationSource;
    const latest = r.latest as NotificationLatest;
    const actor = r.actors[0];
    const agent = actor?.type === "agent" ? agentOf.get(actor.id) : undefined;
    const channel = source.channelId ? channelOf.get(source.channelId) : undefined;
    // A mission's or routine's name says more than the channel its report went to.
    const place =
      group === "done" && r.kind !== "agent_reply"
        ? (latest.title ?? source.label)
        : channel?.kind === "channel"
          ? `#${channel.name}`
          : undefined;
    const text = pushQuote(latest) ?? undefined;
    return [
      {
        group,
        name: agent?.name ?? (actor?.type === "user" ? (userOf.get(actor.id) ?? "") : ""),
        ...(actor?.type === "agent" ? { agentColor: agent?.appearance?.color ?? "sky" } : {}),
        ...(place ? { place } : {}),
        ...(text ? { text } : {}),
        ...(!text && latest.media ? { media: latest.media } : {}),
      },
    ];
  });
}
