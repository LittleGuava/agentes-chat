/**
 * An agent's reserve AIs (ADR 0118 addendum 2026-11-15): `agents.brain_fallback_chain`, in order. Each is an account
 * on the agent's own computer, of any computer brain; `model` null = that brain's default (its own model when it is
 * the agent's brain).
 */
export interface ReserveEntry {
  accountId: string;
  model?: string | null;
}

/** The most reserves an agent keeps. */
export const MAX_RESERVES = 3;

/**
 * What a reserve stands in for: the plan at its limit (the account's, or one model's own), or signed out. Anything
 * about the computer itself (offline, paused, full) holds every account on it alike, so a reserve there can't help.
 */
export const RESERVE_CODES: ReadonlySet<string> = new Set(["plan_limit", "not_logged_in"]);

/** The stored chain, entries of the right shape only (the column is checked on save, `setAgentBrain`). */
export function reserveChainOf(raw: unknown): ReserveEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): ReserveEntry[] => {
    if (!e || typeof e !== "object") return [];
    const { accountId, model } = e as { accountId?: unknown; model?: unknown };
    if (typeof accountId !== "string") return [];
    return [{ accountId, ...(typeof model === "string" ? { model } : {}) }];
  });
}
