import { zonedParts, zonedTimeForward } from "../cron";
import { safeZone } from "../zones";

/** A stretch of time for `search_context` (ADR 0017 addendum 2026-11-15): from `after`, up to but not at `before`. */
export interface Period {
  after?: Date;
  before?: Date;
}

export type PeriodResult = { ok: true; period: Period } | { ok: false; error: string };

/** What `since` and `until` take, said once for the tool's schema and its errors. */
export const PERIOD_WORDS =
  "`today`, `yesterday`, a span back from now (`6h`, `7d`, `2w`), a day (`2026-11-14`) or a time (`2026-11-14T09:00`, in the person's time zone unless it names its own)";

const SPAN = /^(\d{1,4})\s*([hdw])$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const HOUR_MS = 3_600_000;
const SPAN_MS = { h: HOUR_MS, d: 24 * HOUR_MS, w: 7 * 24 * HOUR_MS } as const;

/** The calendar day `delta` days from a local date, as its year, month and day. */
function shiftDay(y: number, m: number, d: number, delta: number) {
  const at = new Date(Date.UTC(y, m - 1, d + delta));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** When a local day starts in a zone (a midnight a DST change skips moves to the first minute that exists). */
function dayStart(y: number, m: number, d: number, zone: string) {
  return zonedTimeForward(y, m, d, 0, 0, zone);
}

const realDay = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() + 1 === m && at.getUTCDate() === d;
};

/**
 * One bound. A word or a day names a stretch: `since` starts where it starts, `until` ends where it ends, so
 * `since: yesterday, until: yesterday` is all of yesterday. A span or a time is an instant either way.
 */
function bound(raw: string, edge: "start" | "end", zone: string, now: Date): Date | null {
  const text = raw.trim().toLowerCase();
  const today = zonedParts(now, zone);
  const day = (delta: number) => {
    const d = shiftDay(today.year, today.month, today.day, delta + (edge === "end" ? 1 : 0));
    return dayStart(d.year, d.month, d.day, zone);
  };
  if (text === "today") return day(0);
  if (text === "yesterday") return day(-1);
  const span = SPAN.exec(text);
  if (span) return new Date(now.getTime() - Number(span[1]) * SPAN_MS[span[2] as keyof typeof SPAN_MS]);
  const date = DAY.exec(text);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!realDay(y, m, d)) return null;
    const at = edge === "end" ? shiftDay(y, m, d, 1) : { year: y, month: m, day: d };
    return dayStart(at.year, at.month, at.day, zone);
  }
  const time = TIME.exec(raw.trim());
  if (time) {
    const n = (i: number) => Number(time[i] ?? 0);
    const [y, m, d, h, mi, s] = [n(1), n(2), n(3), n(4), n(5), n(6)];
    if (!realDay(y, m, d) || h > 23 || mi > 59 || s > 59) return null;
    if (time[7]) {
      const at = new Date(raw.trim());
      return Number.isNaN(at.getTime()) ? null : at;
    }
    const at = zonedTimeForward(y, m, d, h, mi, zone);
    return at ? new Date(at.getTime() + s * 1000) : null;
  }
  return null;
}

/** `since` and `until` as instants in the person's zone, or what's wrong with them. */
export function resolvePeriod(input: { since?: string; until?: string }, zone: string, now = new Date()): PeriodResult {
  const tz = safeZone(zone);
  const period: Period = {};
  for (const [key, edge] of [
    ["since", "start"],
    ["until", "end"],
  ] as const) {
    const raw = input[key];
    if (raw === undefined || raw.trim() === "") continue;
    const at = bound(raw, edge, tz, now);
    if (!at) return { ok: false, error: `\`${key}\` "${raw}" isn't a time I know. Use ${PERIOD_WORDS}.` };
    if (key === "since") period.after = at;
    else period.before = at;
  }
  if (period.after && period.before && period.after >= period.before)
    return { ok: false, error: "`since` must come before `until`." };
  return { ok: true, period };
}

/** "2026-11-14 09:30", the local wall time of an instant in a zone. */
export function localStamp(at: Date, zone: string) {
  const p = zonedParts(at, safeZone(zone));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
