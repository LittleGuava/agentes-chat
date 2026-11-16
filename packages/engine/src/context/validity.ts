import { schema, sql } from "@agenteschat/db";
import { zonedTimeForward } from "../cron";
import { ValidationError } from "../errors";

const { contextItems } = schema;

/**
 * How long a memory holds (ADR 0028 §2, addendum 2026-11-15): `valid_until` is the first instant it no longer holds.
 * An item past it reads in no prompt and no agent's search; people still see it on the memory page, marked, and may
 * change it. This file is the one place that says what "still holds" means.
 */

/** Still holds: no end, or an end still ahead. For the queries that feed a prompt or an agent's search. */
export const currentSql = () => sql`(${contextItems.validUntil} is null or ${contextItems.validUntil} > now())`;

/** `currentSql` for a row already read. */
export const isCurrent = (item: { validUntil: Date | null }, now = new Date()) =>
  item.validUntil === null || item.validUntil.getTime() > now.getTime();

/** What an agent may write for `until`: a day, an instant, a short span from now, or `never` to take the end away. */
export const UNTIL_DESCRIPTION =
  'Only when it stops holding at a known time ("until Friday", "this quarter"): the last day it holds (YYYY-MM-DD, the workspace\'s time zone), or a span from now (7d, 2w, 3m, 1y). After it, the memory stops reading in your work; people still see it.';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPAN = /^(\d{1,4})\s*([dwmy])$/i;
const NEVER = new Set(["never", "none", "no", "forever"]);

/**
 * `until` as the instant the memory stops holding. A day holds through its end in `timeZone` (an item "until
 * 2026-09-28" still reads that whole day there); a span counts from `now`; an ISO instant is taken as is. `null`:
 * no end (`never`, or nothing given). Refuses what can't be read and an end that is not ahead.
 */
export function parseUntil(input: unknown, options: { now?: Date; timeZone?: string } = {}): Date | null {
  if (input === undefined || input === null) return null;
  const text = String(input).trim().toLowerCase();
  if (text === "" || NEVER.has(text)) return null;
  const now = options.now ?? new Date();
  const at = untilInstant(text, now, options.timeZone ?? "UTC");
  if (!at || Number.isNaN(at.getTime()))
    throw new ValidationError(
      `"${String(input).slice(0, 40)}" is not a date: give the last day it holds (YYYY-MM-DD) or a span (7d, 2w, 3m, 1y).`,
      "memory.invalid_until",
    );
  if (at.getTime() <= now.getTime())
    throw new ValidationError("That end has already passed: give a day still ahead.", "memory.past_until");
  return at;
}

function untilInstant(text: string, now: Date, timeZone: string): Date | null {
  const day = DAY.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    // The day after, at its first minute where the workspace is.
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return zonedTimeForward(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  }
  const span = SPAN.exec(text);
  if (span) {
    const n = Number(span[1]);
    const unit = (span[2] ?? "d").toLowerCase();
    if (n <= 0) return null;
    const at = new Date(now);
    if (unit === "d") at.setUTCDate(at.getUTCDate() + n);
    else if (unit === "w") at.setUTCDate(at.getUTCDate() + 7 * n);
    else if (unit === "m") at.setUTCMonth(at.getUTCMonth() + n);
    else at.setUTCFullYear(at.getUTCFullYear() + n);
    return at;
  }
  // An instant with its time and zone ("2026-09-28T18:00:00-03:00"); a bare date was read above.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(text) && /(z|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text);
  return null;
}

/** The day an end falls on, for a model's line: the last day it holds in `timeZone` (`parseUntil` backwards). */
export function lastDayHeld(validUntil: Date, timeZone = "UTC") {
  const before = new Date(validUntil.getTime() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    before,
  );
}
