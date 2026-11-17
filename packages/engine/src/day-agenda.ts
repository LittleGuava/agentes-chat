import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { calendarRange } from "./calendar";
import { zonedParts, zonedTimeForward } from "./cron";
import { localDate } from "./rrule";

/**
 * "Hoje" on the day's card (ADR 0177, addendum 2026-11-15): the day ahead of the reader, read from their own calendar
 * (`calendarRange`, the same view the Calendar page draws), narrowed to what is theirs: meetings they attend and did
 * not decline, routines of agents they own, and tasks due that day held by them or by one of their agents. Counts and
 * the first meeting's title and time, never an event's description or a routine's prompt.
 */
export interface DayAgenda {
  meetings: number;
  /** Routines with a run in the window, each once however often it runs. */
  routines: number;
  deadlines: number;
  /** The first meeting: a timed one by its start, else the first all-day one. */
  first: { title: string; at: string; allDay: boolean } | null;
}

/** The next midnight after `at` on that zone's clock. */
export function endOfLocalDay(at: Date, timezone: string): Date {
  const p = zonedParts(at, timezone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return (
    zonedTimeForward(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone) ??
    new Date(at.getTime() + 86_400_000)
  );
}

/** What is the reader's from `from` to midnight in `timezone`; null on a day with none of it. */
export async function dayAgenda(
  db: Database,
  orgId: string,
  userId: string,
  from: Date,
  timezone: string,
): Promise<DayAgenda | null> {
  const to = endOfLocalDay(from, timezone);
  const day = localDate(from, timezone);
  const [range, owned] = await Promise.all([
    calendarRange({ db }, userId, orgId, from.toISOString(), to.toISOString()),
    db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          eq(schema.agents.ownerUserId, userId),
          isNull(schema.agents.archivedAt),
          isNull(schema.agents.deletedAt),
        ),
      ),
  ]);
  const mine = new Set(owned.map((a) => a.id));
  const meetings = range.events
    .filter((e) => e.rsvp.some((r) => r.type === "person" && r.id === userId && r.status !== "declined"))
    // A timed meeting from the slot on; an all-day one on this day.
    .filter((e) =>
      e.allDay
        ? (e.startDate ?? "") <= day && day <= (e.endDate ?? e.startDate ?? "")
        : Date.parse(e.start) >= from.getTime(),
    );
  const timed = meetings.filter((e) => !e.allDay);
  const firstMeeting = timed[0] ?? meetings[0];
  const routines = new Set(range.routines.filter((r) => mine.has(r.agentId)).map((r) => r.routineId)).size;
  // Read by the reader's own date: the calendar's range keeps every UTC day the window touches.
  const deadlines = range.deadlines.filter(
    (d) =>
      d.date === day &&
      // A task has several assignees: one that is the reader, or an agent of theirs, makes it theirs.
      d.assignees.some((a) => (a.type === "person" ? a.id === userId : mine.has(a.id))),
  ).length;
  if (meetings.length === 0 && routines === 0 && deadlines === 0) return null;
  return {
    meetings: meetings.length,
    routines,
    deadlines,
    first: firstMeeting
      ? { title: firstMeeting.title, at: new Date(firstMeeting.start).toISOString(), allDay: firstMeeting.allDay }
      : null,
  };
}
