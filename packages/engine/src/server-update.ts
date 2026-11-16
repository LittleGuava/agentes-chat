/**
 * Whether a self-hosted server has a newer release to install (ADR 0060, addendum 2026-11-15): the newest
 * `v<x.y.z>` release of the project's repository against this server's own version, and what installs it. Pure:
 * the server's check (`apps/server/src/server-update.ts`) asks GitHub and passes the answer here.
 */
import { isAgentesCloud } from "./telemetry";

export type InstallMode = "docker" | "native" | "desktop";

export interface ServerRelease {
  version: string;
  publishedAt: string | null;
  /** The release's page on GitHub, built here from the repository and the tag, never taken from the answer. */
  notesUrl: string;
}

export interface ServerUpdate {
  /** This server's version. */
  version: string;
  /** The newest release seen, or null while none was. */
  latest: ServerRelease | null;
  updateAvailable: boolean;
  install: InstallMode;
  /** What installs it, as SELF_HOSTING.md's Upgrades says; null when there is nothing to install. */
  command: string | null;
}

/** A server release's tag: `v1.2.3`. The desktop app's (`desktop-v…`), the setup's and pre-releases aren't. */
const SERVER_TAG = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const PLAIN_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

const partsOf = (text: string, pattern: RegExp): [number, number, number] | null => {
  const m = pattern.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * The highest published server release in GitHub's release list (`GET /repos/{repo}/releases`), or null. GitHub's
 * `releases/latest` can't answer this: the desktop app's releases share the repository and come out more often.
 */
export function newestServerRelease(list: unknown, repo: string): ServerRelease | null {
  if (!Array.isArray(list)) return null;
  let best: { parts: [number, number, number]; release: ServerRelease } | null = null;
  for (const item of list) {
    const tag = field(item, "tag_name");
    if (typeof tag !== "string" || field(item, "draft") === true || field(item, "prerelease") === true) continue;
    const parts = partsOf(tag, SERVER_TAG);
    if (!parts || (best && compare(parts, best.parts) <= 0)) continue;
    const published = field(item, "published_at");
    const version = parts.join(".");
    best = {
      parts,
      release: {
        version,
        publishedAt: typeof published === "string" ? published : null,
        notesUrl: `https://github.com/${repo}/releases/tag/v${version}`,
      },
    };
  }
  return best?.release ?? null;
}

/** The commands SELF_HOSTING.md gives for each way of installing; the desktop app installs its server's updates itself. */
function commandFor(install: InstallMode, repo: string, version: string): string | null {
  if (install === "docker") {
    return [
      `curl -fsSLO https://raw.githubusercontent.com/${repo}/v${version}/docker-compose.yml`,
      "docker compose pull",
      "docker compose up -d",
    ].join("\n");
  }
  if (install === "native") return `~/.agentes/app/${version}/bin/agentes-server service install --data ~/.agentes`;
  return null;
}

/**
 * What the owner is told. A version that isn't `x.y.z` (a deploy's own numbering, a development build) is never
 * behind: nothing compares with it.
 */
export function serverUpdate(input: {
  current: string;
  latest: ServerRelease | null;
  install: InstallMode;
  repo: string;
}): ServerUpdate {
  const here = partsOf(input.current, PLAIN_VERSION);
  const there = input.latest ? partsOf(input.latest.version, PLAIN_VERSION) : null;
  const updateAvailable = Boolean(here && there && compare(there, here) > 0);
  return {
    version: input.current,
    latest: input.latest,
    updateAvailable,
    install: input.install,
    command: updateAvailable && input.latest ? commandFor(input.install, input.repo, input.latest.version) : null,
  };
}

/**
 * Whether this server looks for new releases: unless `UPDATE_CHECK=off`; never on agentes.chat's own servers, which
 * deploy from `main`, nor in the desktop app's server, which updates with the app (ADR 0066 §7).
 */
export function updateChecks(config: { UPDATE_CHECK: "on" | "off"; PUBLIC_URL: string }, install: InstallMode) {
  return config.UPDATE_CHECK === "on" && install !== "desktop" && !isAgentesCloud(config.PUBLIC_URL);
}
