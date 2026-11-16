import type { ShareDmTarget, SharedDm, SharedDmLine } from "../api/types";

/**
 * A DM with an agent shared as a read-only copy (ADR 0151, addendum 2026-11-15): what the apps read of
 * `meta.sharedDm`, where to send one, and who reads it there.
 */

const isLine = (v: unknown): v is SharedDmLine => {
  const l = v as Partial<SharedDmLine> | null;
  return (
    Boolean(l) &&
    typeof l?.body === "string" &&
    typeof l.at === "string" &&
    typeof l.author?.name === "string" &&
    (l.author.type === "person" || l.author.type === "agent")
  );
};

/** A message's shared copy, or null when it carries none (or one this app can't read). */
export function sharedDmOf(meta: Record<string, unknown> | null | undefined): SharedDm | null {
  const s = meta?.sharedDm as Partial<SharedDm> | undefined;
  if (!s || typeof s !== "object" || typeof s.agent?.name !== "string" || !Array.isArray(s.lines)) return null;
  const lines = s.lines.filter(isLine);
  return {
    agent: { id: String(s.agent.id ?? ""), name: s.agent.name, handle: String(s.agent.handle ?? "") },
    count: typeof s.count === "number" ? s.count : lines.length,
    omitted: typeof s.omitted === "number" ? s.omitted : 0,
    lines,
  };
}

/** One choice of the share's place, as a select holds it: a channel (`c:`) or a person (`u:`). */
export type SharePlace = `c:${string}` | `u:${string}`;

export const sharePlaceOf = (to: ShareDmTarget): SharePlace =>
  "channelId" in to ? `c:${to.channelId}` : `u:${to.userId}`;

export const shareTargetOf = (place: SharePlace): ShareDmTarget =>
  place.startsWith("c:") ? { channelId: place.slice(2) } : { userId: place.slice(2) };

/**
 * Who reads the copy where it goes, as the apps say it before sending (ADR 0151 §5: administrators read every
 * channel, never a DM): a public channel's members, a private one's and the administrators, or the one person.
 */
export function shareReaders(
  place: { channel: { name: string; visibility: "public" | "private" } } | { person: { name: string } },
): { key: "dmShare.readersChannel" | "dmShare.readersPrivate" | "dmShare.readersPerson"; params: { name: string } } {
  if ("person" in place) return { key: "dmShare.readersPerson", params: { name: place.person.name } };
  return {
    key: place.channel.visibility === "private" ? "dmShare.readersPrivate" : "dmShare.readersChannel",
    params: { name: place.channel.name },
  };
}
