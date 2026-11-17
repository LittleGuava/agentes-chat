import type { OwnOrder } from "../api/types";

/** Someone who never turned "Usar a minha ordem" on: everyone's order. */
export const OWN_ORDER_DEFAULT: OwnOrder = { on: false, channels: [], people: [], agents: [] };
export type OwnOrderKind = Exclude<keyof OwnOrder, "on">;

/**
 * A section's rows in my order (ADR 0080, addendum of 2026-11-16). `base` is the section as everyone sees it (the
 * workspace's order, a sort, the latest activity): the rows I ordered take the places they hold there, in my order, and
 * a row I never ordered (a new channel) keeps its own place, where everyone's order puts it.
 */
export function inOwnOrder<T>(base: readonly T[], order: readonly string[], idOf: (item: T) => string): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const mine = base.filter((item) => rank.has(idOf(item)));
  mine.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0));
  let next = 0;
  return base.map((item) => (rank.has(idOf(item)) ? (mine[next++] as T) : item));
}

/**
 * My order with `id` dropped before `before` (or last, null) among `shown`, the section's ids as I see them now. The
 * whole section is kept in its new order, so the move shows even past a row I never ordered; the other sections' ids
 * stay. Null when nothing would move.
 */
export function placeInOwnOrder(
  order: readonly string[],
  shown: readonly string[],
  id: string,
  before: string | null,
): string[] | null {
  if (!shown.includes(id) || id === before || (before !== null && !shown.includes(before))) return null;
  const rest = shown.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  if (next.join() === shown.join()) return null;
  return [...order.filter((x) => !shown.includes(x)), ...next];
}

/** "Mover para cima" (-1) / "Mover para baixo" (1) in my order among `shown`; null at that end. */
export function stepInOwnOrder(
  order: readonly string[],
  shown: readonly string[],
  id: string,
  by: -1 | 1,
): string[] | null {
  const i = shown.indexOf(id);
  if (i < 0 || i + by < 0 || i + by >= shown.length) return null;
  return placeInOwnOrder(order, shown, id, by < 0 ? (shown[i - 1] ?? null) : (shown[i + 2] ?? null));
}
