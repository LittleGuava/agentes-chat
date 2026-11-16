/**
 * Asks GitHub for the project's newest server release (ADR 0060, addendum 2026-11-15). Only when the owner's
 * Settings ask (`GET /api/app/server-update`), at most once every `CHECK_EVERY_MS` per process: a GET with no token,
 * no body and no query beyond the page size, so it says nothing about this server beyond the request's own address.
 */
import { newestServerRelease, type ServerRelease } from "@agenteschat/engine";
import type { Logger } from "./logger";

export const CHECK_EVERY_MS = 12 * 3600_000;
/** After a failure (offline, GitHub's rate limit for addresses without a token): the version last seen stays. */
export const RETRY_AFTER_MS = 3600_000;
const TIMEOUT_MS = 5_000;
const GITHUB_API = "https://api.github.com";

export interface UpdateCheck {
  /** The newest release seen, asking GitHub when the last answer is old; null while none was seen. Never throws. */
  latest(): Promise<ServerRelease | null>;
}

export function createUpdateCheck(options: {
  repo: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Pick<Logger, "debug">;
}): UpdateCheck {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let seen: ServerRelease | null = null;
  let askAgainAt = 0;
  let asking: Promise<ServerRelease | null> | null = null;

  async function ask(): Promise<ServerRelease | null> {
    const started = now();
    try {
      const res = await http(`${GITHUB_API}/repos/${options.repo}/releases?per_page=30`, {
        method: "GET",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      seen = newestServerRelease(await res.json(), options.repo) ?? seen;
      askAgainAt = started + CHECK_EVERY_MS;
    } catch (error) {
      // Nobody waits on it: the notice shows the version last seen, or nothing.
      options.log?.debug("update check", { error: String(error) });
      askAgainAt = started + RETRY_AFTER_MS;
    }
    return seen;
  }

  return {
    latest() {
      if (now() < askAgainAt) return Promise.resolve(seen);
      asking ??= ask().finally(() => {
        asking = null;
      });
      return asking;
    },
  };
}
