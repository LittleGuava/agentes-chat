import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Updates from the app (ADR 0200). The `updater` service of docker-compose.yml holds the Docker socket; this server
 * never does. They share two folders under `SERVER_UPDATER_DIR`: `requests`, where the server leaves a request that
 * says nothing, and `status`, where the updater writes `status.json` and touches `alive`. Both are read and checked
 * here, once; the engine trusts what this returns.
 */
export const SERVER_UPDATE_STATES = [
  "running",
  "updated",
  "current",
  "pinned",
  "rolled_back",
  "failed",
  "interrupted",
] as const;
export type ServerUpdateState = (typeof SERVER_UPDATE_STATES)[number];

export const SERVER_UPDATE_STEPS = ["pulling", "stopping", "backing_up", "starting", "rolling_back"] as const;
export type ServerUpdateStep = (typeof SERVER_UPDATE_STEPS)[number];

export const SERVER_UPDATE_REASONS = ["pull", "backup", "unhealthy", "rollback", "no_app"] as const;
export type ServerUpdateReason = (typeof SERVER_UPDATE_REASONS)[number];

/** The updater's last run, as `status.json` says it. */
export interface ServerUpdateRun {
  state: ServerUpdateState;
  /** What a run going on is doing; null once it ended. */
  step: ServerUpdateStep | null;
  /** Why a run failed or went back; null otherwise. */
  reason: ServerUpdateReason | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The app's image id before the run, and the one the registry had. */
  from: string | null;
  to: string | null;
}

export interface ServerUpdaterReading {
  run: ServerUpdateRun | null;
  /** When the updater last said it was there; null = never. */
  aliveAt: Date | null;
  /** A request is waiting for the updater. */
  requested: boolean;
}

export interface ServerUpdater {
  read(): Promise<ServerUpdaterReading>;
  /** Leaves the request. It carries nothing the updater reads. */
  request(at: Date): Promise<void>;
}

const IMAGE_ID = /^sha256:[0-9a-f]{12,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null | undefined {
  if (value === null) return null;
  return values.find((known) => known === value);
}

function matching(pattern: RegExp, value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** `status.json` as the updater writes it; anything else (not JSON, a state this server doesn't know) is no run. */
export function parseServerUpdateRun(text: string): ServerUpdateRun | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  const state = oneOf(SERVER_UPDATE_STATES, fields.state);
  const step = oneOf(SERVER_UPDATE_STEPS, fields.step);
  const reason = oneOf(SERVER_UPDATE_REASONS, fields.reason);
  const startedAt = matching(ISO_TIME, fields.startedAt);
  const finishedAt = matching(ISO_TIME, fields.finishedAt);
  const from = matching(IMAGE_ID, fields.from);
  const to = matching(IMAGE_ID, fields.to);
  if (!state || step === undefined || reason === undefined) return null;
  if (startedAt === undefined || finishedAt === undefined || from === undefined || to === undefined) return null;
  return { state, step, reason, startedAt, finishedAt, from, to };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function modifiedAt(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}

/** The updater through the folders it shares with this server; null without `SERVER_UPDATER_DIR`. */
export function createServerUpdater(dir: string | undefined): ServerUpdater | null {
  if (!dir) return null;
  const requests = join(dir, "requests");
  const status = join(dir, "status");
  return {
    async read() {
      const text = await readOrNull(join(status, "status.json"));
      return {
        run: text === null ? null : parseServerUpdateRun(text),
        aliveAt: await modifiedAt(join(status, "alive")),
        requested: (await modifiedAt(join(requests, "request"))) !== null,
      };
    },
    async request(at) {
      await mkdir(requests, { recursive: true });
      // Whole or not at all: the updater may look at any moment.
      const temporary = join(requests, `.request-${process.pid}`);
      await writeFile(temporary, `${at.toISOString()}\n`);
      await rename(temporary, join(requests, "request"));
    },
  };
}
