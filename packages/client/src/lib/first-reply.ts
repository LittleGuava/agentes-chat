import type { LiveRun } from "../realtime/streams";

/**
 * How long a run's AI may send nothing at all (no word, call or step) after it was set to work before the person who
 * asked is offered to switch it. A model's first word comes in seconds and a computer brain's CLI is up well within a
 * minute; a reasoning model may think for about one before it writes. Past a minute and a half, it is stuck or
 * overloaded, and waiting longer only wastes the person's time. Still before "no news for 3 min" (`QUIET_AFTER_MS`),
 * which is about the run itself going silent, not its AI.
 */
export const FIRST_REPLY_RESCUE_MS = 90_000;

/** Who looks at the live row: whether their message started the run, and whether they may change the agent's AI. */
export interface RescueViewer {
  askedByMe: boolean;
  /** The agent's owner. */
  ownsAgent: boolean;
  /** May manage every agent (`manage_agents`). */
  admin: boolean;
}

/**
 * The rescue under a run whose AI has sent nothing since it was set to work (`LiveRun.silentSince`): for the person who
 * asked only, "switch AI" when they may change it (the agent's owner, an admin: the same people "Quem pensa" lets),
 * else "see status". `ms`: how long it has been silent. Null when there is nothing to offer.
 */
export function firstReplyRescue(
  run: LiveRun,
  viewer: RescueViewer,
  now = Date.now(),
): { action: "switchAi" | "status"; ms: number } | null {
  if (!viewer.askedByMe || run.silentSince === undefined || run.provisional || run.stopping) return null;
  if (run.status !== "thinking") return null;
  const ms = now - run.silentSince;
  if (ms < FIRST_REPLY_RESCUE_MS) return null;
  return { action: viewer.ownsAgent || viewer.admin ? "switchAi" : "status", ms };
}
