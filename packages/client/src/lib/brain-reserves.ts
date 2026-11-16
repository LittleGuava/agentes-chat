import type { AgentBrain, BrainReserve, MachineAccount } from "../api/types";

/**
 * An agent's reserve AIs (ADR 0118 addendum 2026-11-15), as "Quem pensa" edits them on the web and the phone: up to
 * `MAX_RESERVES` accounts on its computer, in the order they stand in while its own plan is at its limit or signed
 * out. Platform-neutral.
 */

/** The most reserves an agent keeps (the server's `MAX_RESERVES`). */
export const MAX_RESERVES = 3;

/** The reserves the view lists (none on an older server). */
export const reservesOf = (view: Pick<AgentBrain, "fallbackChain">): BrainReserve[] => view.fallbackChain ?? [];

/** The chosen reserves in order, each with its account; one the computer no longer lists isn't shown. */
export function reserveRows(
  view: Pick<AgentBrain, "accounts">,
  chain: readonly BrainReserve[],
): { reserve: BrainReserve; account: MachineAccount }[] {
  return chain.flatMap((reserve) => {
    const account = view.accounts.find((a) => a.id === reserve.accountId);
    return account ? [{ reserve, account }] : [];
  });
}

/**
 * Whether an account may stand in for the agent, as the server checks it (`nextFallbackChain`, ADR 0059 §3): the
 * agent's owner's, or someone's that serves the whole workspace. `owner`: the agent's owner (null: nobody's).
 */
export const mayBeReserve = (account: Pick<MachineAccount, "ownerId" | "serves">, owner: string | null | undefined) =>
  (account.ownerId !== null && account.serves === "everyone") || (!!owner && account.ownerId === owner);

/** The accounts that may be added: on its computer, ones it may use, not the one it thinks with, not chosen yet; none once full. */
export function reserveCandidates(
  view: Pick<AgentBrain, "accounts" | "account">,
  chain: readonly BrainReserve[],
  owner: string | null | undefined,
): MachineAccount[] {
  if (chain.length >= MAX_RESERVES) return [];
  return view.accounts.filter(
    (a) => a.id !== view.account && mayBeReserve(a, owner) && !chain.some((r) => r.accountId === a.id),
  );
}

/** `accountId` added last, unless the list is full or has it already. */
export const addReserve = (chain: BrainReserve[], accountId: string): BrainReserve[] =>
  chain.length >= MAX_RESERVES || chain.some((r) => r.accountId === accountId) ? chain : [...chain, { accountId }];

export const removeReserve = (chain: BrainReserve[], accountId: string): BrainReserve[] =>
  chain.filter((r) => r.accountId !== accountId);

/** `accountId` one place earlier (-1) or later (1); at either end the list stays as it is. */
export function moveReserve(chain: BrainReserve[], accountId: string, by: -1 | 1): BrainReserve[] {
  const from = chain.findIndex((r) => r.accountId === accountId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= chain.length) return chain;
  const next = [...chain];
  [next[from], next[to]] = [next[to] as BrainReserve, next[from] as BrainReserve];
  return next;
}

export const sameReserves = (a: readonly BrainReserve[], b: readonly BrainReserve[]) =>
  a.length === b.length &&
  a.every((r, i) => r.accountId === b[i]?.accountId && (r.model ?? null) === (b[i]?.model ?? null));

/**
 * Whether "Quem pensa" offers its reserves: an agent on a plan (never a key, nor the team's right hand, which has a
 * view `scope`), on a server and a computer that know them, with an account to choose or one chosen already.
 * `owner`: the agent's owner.
 */
export const offersReserves = (
  view: Pick<AgentBrain, "brain" | "scope" | "accountsSupported" | "fallbackChain" | "accounts" | "account">,
  owner: string | null | undefined,
) =>
  view.brain !== "model" &&
  view.scope === undefined &&
  view.accountsSupported &&
  view.fallbackChain !== undefined &&
  (reserveRows(view, view.fallbackChain).length > 0 || reserveCandidates(view, view.fallbackChain, owner).length > 0);
