import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CursorModelInfo,
  parseCursorModels,
  type RunnerAcpEngineInfo,
} from "@agenteschat/adapters/machine-protocol";
import { withoutSignIns } from "./accounts";
import { ACP_PROTOCOL_VERSION, AcpConnection } from "./acp";
import { within } from "./brain-opencode";
import type { AcpEngineConfig } from "./config";
import { killTree } from "./exec";
import { cliSpawn, envValue } from "./executors";
import type { Spawn } from "./scope-gate";

/**
 * The ACP agents a computer's owner declares in the runner's `config.json` (`acpEngines`, ADR 0216): any agent that
 * speaks the Agent Client Protocol over its standard input and output, started with the command and arguments given.
 * Only the id, the name and the models it offers ever leave the computer (`hello.executors.acp`). What `config.json`
 * may declare is read in `config.ts` (`parseAcpEngineConfigs`).
 */

export type { AcpEngineConfig } from "./config";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What `initialize` says of the client: no file system and no terminal of ours, the agent's own tools only. */
export const ACP_CLIENT_INIT = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "agentes-runner", version: "1" },
} as const;

/** How a session chooses its model: ACP's `model` config option, or the unstable `session/set_model`. */
export type AcpModelWay = "config_option" | "set_model" | null;

/**
 * The models a session offers (`session/new`'s answer): its `model` config option's choices (`configOptions`, the
 * protocol's own way), else the unstable `models.availableModels`. Ids are checked and cut like Cursor's.
 */
export function acpModelsOf(session: unknown): { models: CursorModelInfo[]; way: AcpModelWay; current?: string } {
  const s = isRecord(session) ? session : {};
  const options = Array.isArray(s.configOptions) ? s.configOptions.filter(isRecord) : [];
  const option = options.find((o) => o.id === "model") ?? options.find((o) => o.category === "model");
  if (option && option.type !== "boolean") {
    const listed = Array.isArray(option.options) ? option.options.filter(isRecord) : [];
    // A select may group its choices (`{ group, options }`).
    const flat = listed.flatMap((o) => (Array.isArray(o.options) ? o.options.filter(isRecord) : [o]));
    const models = parseCursorModels(flat.map((o) => ({ id: o.value, label: o.name })));
    const current = typeof option.currentValue === "string" ? option.currentValue : undefined;
    return { models, way: "config_option", ...(current ? { current } : {}) };
  }
  const listed = isRecord(s.models) && Array.isArray(s.models.availableModels) ? s.models.availableModels : null;
  if (listed) {
    const models = parseCursorModels(listed.filter(isRecord).map((m) => ({ id: m.modelId, label: m.name })));
    const current = isRecord(s.models) && typeof s.models.currentModelId === "string" ? s.models.currentModelId : "";
    return { models, way: "set_model", ...(current ? { current } : {}) };
  }
  return { models: [], way: null };
}

/**
 * The env an engine's process runs with: `base` without any other brain's key or token (`withoutSignIns`, so an engine
 * never thinks with a key another brain holds), then the engine's own `env`.
 */
export const acpEngineEnv = (engine: AcpEngineConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...withoutSignIns(base),
  ...engine.env,
});

export const ACP_LOOK_TIMEOUT_MS = 20_000;

export interface AcpLookOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
}

/**
 * One look at an engine: started in an empty folder of its own, `initialize` and `session/new` with no MCP server, its
 * models read from the answer, then ended with its whole tree. No prompt, so nothing is counted against anyone's plan.
 * Never throws: an engine that doesn't answer in time is announced with no models.
 */
export async function acpLook(engine: AcpEngineConfig, opts: AcpLookOptions = {}): Promise<RunnerAcpEngineInfo> {
  const info: RunnerAcpEngineInfo = { id: engine.id, name: engine.name };
  const platform = opts.platform ?? process.platform;
  let cwd: string;
  try {
    cwd = mkdtempSync(path.join(tmpdir(), "agentes-acp-look-"));
  } catch {
    return info;
  }
  let child: ChildProcess | null = null;
  let exited: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const env = acpEngineEnv(engine, opts.env ?? process.env);
    const run = cliSpawn([engine.command], engine.args, envValue(env, "PATH", platform), platform);
    child = (opts.spawn ?? spawn)(run.file, run.args, {
      cwd,
      env: run.env ? { ...env, ...run.env } : env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: platform !== "win32",
      windowsHide: true,
      ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const started = child;
    exited = new Promise((resolve) => {
      (started as unknown as EventEmitter).on("error", resolve);
      (started as unknown as EventEmitter).on("close", resolve);
    });
    const conn = new AcpConnection(
      started.stdin as NonNullable<ChildProcess["stdin"]>,
      started.stdout as NonNullable<ChildProcess["stdout"]>,
    );
    (started as unknown as EventEmitter).on("close", () => conn.close(new Error("The agent exited")));
    const look = (async () => {
      await conn.request("initialize", ACP_CLIENT_INIT);
      const session = await conn.request("session/new", { cwd, mcpServers: [] });
      return acpModelsOf(session).models;
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? ACP_LOOK_TIMEOUT_MS);
    });
    const models = await Promise.race([look.catch(() => null), timeout]);
    conn.close();
    return models?.length ? { ...info, models } : info;
  } catch {
    return info;
  } finally {
    clearTimeout(timer);
    if (child) {
      child.stdin?.end();
      killTree(child, "SIGKILL");
      // Windows keeps a folder a process still runs in: it goes once the process has.
      await within(exited, 3000, "").catch(() => undefined);
    }
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A folder of the temp directory's, left for the system to clear.
    }
  }
}

/** Every declared engine looked at once (`hello.executors.acp`). */
export const acpLookAll = (engines: readonly AcpEngineConfig[], opts: AcpLookOptions = {}) =>
  Promise.all(engines.map((engine) => acpLook(engine, opts)));
