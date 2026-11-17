import type { SearchFilterInput, SearchHit } from "../api/types";

/**
 * Find in the conversation (ADR 0123 addendum 2026-11-15): Ctrl/⌘F opens a bar over the conversation that asks the
 * workspace search for these words in this channel, newest first, and steps through the messages found, the
 * conversation going to each one (paging older history in as a message link does).
 */

/** The server's most for a search with filters: a full page may hide older hits. */
export const FIND_LIMIT = 100;

/** A key press as the shortcut reads it (a DOM `KeyboardEvent` is one). */
export interface FindKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+F, ⌘F on Apple platforms: no Shift or Alt, which other shortcuts use. */
export const isFindShortcut = (e: FindKey) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";

/**
 * The search's filters: this channel, newest first (by date only text matches come back, ADR 0123 §3). None without
 * words: the channel filter alone would list the channel's latest messages.
 */
export function findFilters(channelId: string, q: string): SearchFilterInput | undefined {
  return q.trim() ? { in: [channelId], sort: "newest" } : undefined;
}

/** Where the find looks: a channel's (or DM's) main timeline, or one thread (its root and replies). */
export interface FindScope {
  channelId: string;
  /** A thread view: the root message's id, what its replies carry as `threadId`. */
  threadId?: string;
}

/**
 * The messages found that are rows of this conversation, newest first, each once. A channel's timeline has no
 * thread replies (they show in their thread), a thread holds its root and replies; a deleted message (no
 * `messageId`) has nowhere to go. The server's search takes a channel, not a thread: the thread's are picked here.
 */
export function findIdsIn(hits: readonly SearchHit[], scope: FindScope): string[] {
  const inScope = (h: SearchHit) => {
    if (h.kind !== "message" || !h.messageId || !h.channelIds.includes(scope.channelId)) return false;
    if (scope.threadId) return h.messageId === scope.threadId || h.threadId === scope.threadId;
    return !h.threadId || h.threadId === h.messageId;
  };
  const ids: string[] = [];
  for (const h of [...hits].filter(inScope).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const id = h.messageId as string;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Older goes up the conversation (Enter, ↑), newer back down (Shift+Enter, ↓). */
export type FindStep = "older" | "newer";

/** The next hit from `current`, wrapping around at either end; from none (or one gone since), the newest. */
export function stepFind(ids: readonly string[], current: string | null, step: FindStep): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return ids[0] ?? null;
  const next = (at + (step === "older" ? 1 : -1) + ids.length) % ids.length;
  return ids[next] ?? null;
}

/**
 * Where the find stands: `at` counted from the newest (0 before the first step), of `total`; `more` when the
 * server's page was full (`served`, its hits before this conversation's were picked), so older ones may be missing.
 */
export function findPosition(ids: readonly string[], current: string | null, served: number) {
  return { at: current ? ids.indexOf(current) + 1 : 0, total: ids.length, more: served >= FIND_LIMIT };
}
