import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { ACP_METHOD_NOT_FOUND, AcpConnection, AcpError } from "./acp";
import { ACP_CLIENT_INIT, type AcpEngineConfig, acpEngineEnv, acpModelsOf } from "./acp-engines";
import { LIMIT_TEXT } from "./brain";
import { type CodexBrainEvent, CodexThreads } from "./brain-codex";
import { acpProblem, goneWithin, OpencodeTurnReader, opencodeBridge, opencodePrompt, within } from "./brain-opencode";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { cliSpawn, envValue } from "./executors";
import { CODEX_MCP_SERVER } from "./mcp";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The custom ACP branch of `brain.turn` (protocol 71, ADR 0216): one agent turn as one process of an ACP agent the
 * computer's owner declared (`acpEngines` in `config.json`), driven through `acp.ts` as OpenCode's turns are.
 *
 * - We know nothing of the agent's own tools, so only a `work` turn runs: every permission it asks for is answered
 *   with its own allow option (its folder and the computer's user are the boundary, as for OpenCode). A `plan` or
 *   `chat` turn is refused (`acp_profile`): it couldn't be kept to reads, or to our tools.
 * - No account: the agent keeps its own sign-in. Its env is the agent's without any other brain's key or token
 *   (`withoutSignIns`), plus the engine's own `env`.
 * - The session: ours → the agent's lives in `<runner home>/brain/acp-sessions.json`, per engine and folder. A stored one
 *   is resumed (`session/resume`, else `session/load`); one the agent no longer has starts over, with the engine's
 *   context leading its first prompt (ACP has no system prompt).
 * - The model: the session's `model` config option when it lists one, else `session/set_model`.
 * - Events: `OpencodeTurnReader`, which reads only ACP's own updates; our bridge's calls are left out by any of the
 *   names agents give an MCP server's tools.
 * - No live steering: `brain.steer` answers `unsupported`.
 */

const STOP_WAIT_MS = 8000;
const EXIT_GRACE_MS = 3000;
const KILL_WAIT_MS = 2000;
const SETUP_TIMEOUT_MS = 120_000;
/** A turn that hears nothing from the agent this long, with no tool running, stops. */
export const ACP_SILENCE_MS = 5 * 60_000;

/** `brain.turn` with `kind: "acp"`. */
export interface AcpBrainTurnRequest {
  runId: string;
  kind: "acp";
  engine: string;
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
}

export const acpSessionsFile = (runnerHome: string) => path.join(runnerHome, "brain", "acp-sessions.json");

/** The session key: per engine and folder (a resumed session keeps the folder it started in). */
export const acpSessionKey = (engine: string, sessionId: string, cwd: string) => `${engine}:${sessionId}|${cwd}`;

/** Our bridge's tools as ACP agents name an MCP server's: `<server>_<tool>`, `<server>-<tool>`, `mcp__<server>__<tool>`. */
export const isAcpBridgeTool = (name: string) =>
  name.startsWith(`${CODEX_MCP_SERVER}_`) ||
  name.startsWith(`${CODEX_MCP_SERVER}-`) ||
  name.startsWith(`mcp__${CODEX_MCP_SERVER}__`);

const AUTH =
  /unauthori[sz]ed|\b401\b|invalid (?:api )?key|missing api key|not (?:authenticated|logged in|signed in)|authentication (?:failed|required)|log ?in (?:first|again)/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `acp_failed`. */
export function acpEngineProblem(problem: string, worked = false, auth = false): CodexBrainEvent[] {
  if (LIMIT_TEXT.test(problem) || /\b429\b|quota|too many requests/i.test(problem)) {
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  }
  if (auth || AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "acp_failed", message: problem, retryable: true }];
}

/** The answer to `session/request_permission` in a `work` turn: the agent's own allow option, once if it has one. */
export function acpPermissionAnswer(params: unknown) {
  const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const options = Array.isArray(p.options)
    ? p.options.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    : [];
  const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
  return allow && typeof allow.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: allow.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export interface AcpTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  engine: AcpEngineConfig;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
}

export interface AcpTurnOptions {
  sessions: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Tests: how it starts, the system, the silence limit, and the exit grace. */
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  silenceMs?: number;
  exitGraceMs?: number;
}

type ExitError = Error & { exit?: { code: number | null; error?: Error } };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Runs one turn of a declared ACP agent and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runAcpTurn(input: AcpTurnInput, opts: AcpTurnOptions): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const name = input.engine.name;
  let ended = false;
  const emit = (event: CodexBrainEvent) => {
    if (ended) return;
    if (event.type === "done" || event.type === "error") ended = true;
    opts.emit(event);
  };
  const fail = (code: string, message: string, retryable?: boolean) =>
    emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });

  const env = acpEngineEnv(input.engine, { ...process.env, ...(opts.env ?? {}) });
  // A process started in the turn's folder: some agents read `$PWD` before their own cwd.
  env.PWD = input.cwd;
  const run = cliSpawn([input.engine.command], input.engine.args, envValue(env, "PATH", platform), platform);
  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(run.file, run.args, {
      cwd: input.cwd,
      env: run.env ? { ...env, ...run.env } : env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
      ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "acp_missing" : "acp_failed",
      missing ? `${name}'s command is not on this computer.` : String(err),
      true,
    );
  }

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-2000);
  });
  const reader = new OpencodeTurnReader({
    isBridge: isAcpBridgeTool,
    name,
    ...(opts.redact ? { redact: opts.redact } : {}),
  });
  const sessionKey = acpSessionKey(input.engine.id, input.sessionId, input.cwd);
  const s = {
    sessionId: null as string | null,
    admitted: false,
    stopping: null as "canceled" | "silence" | null,
    killTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const admit = () => {
    if (s.admitted || !s.sessionId) return;
    s.admitted = true;
    opts.sessions.set(sessionKey, s.sessionId);
  };

  const conn = new AcpConnection(
    child.stdin as NonNullable<ChildProcess["stdin"]>,
    child.stdout as NonNullable<ChildProcess["stdout"]>,
    {
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== s.sessionId) return;
        admit();
        for (const event of reader.update(params.update)) emit(event);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        return acpPermissionAnswer(params);
      },
    },
  );

  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    const proc = child as unknown as EventEmitter;
    proc.on("error", (error: Error) => resolve({ code: null, error }));
    proc.on("close", (code: number | null) => resolve({ code }));
  });
  void exited.then(({ code, error }) => {
    const why = error?.message ?? `${name} exited with code ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    const closed: ExitError = new Error(opts.redact ? opts.redact(why) : why);
    closed.exit = { code, ...(error ? { error } : {}) };
    conn.close(closed);
  });

  function stop(why: "canceled" | "silence") {
    if (s.stopping) return;
    s.stopping = why;
    if (s.sessionId) conn.notify("session/cancel", { sessionId: s.sessionId });
    s.killTimer = setTimeout(() => killTree(child, "SIGKILL"), STOP_WAIT_MS);
  }
  const onAbort = () => stop("canceled");
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const silenceMs = opts.silenceMs ?? ACP_SILENCE_MS;
  const silence = setInterval(
    () => {
      if (s.sessionId && reader.running.size === 0 && Date.now() - conn.lastHeard > silenceMs) stop("silence");
    },
    Math.min(15_000, Math.max(50, silenceMs / 4)),
  );
  const setup = <T>(p: Promise<T>) => within(p, SETUP_TIMEOUT_MS, `${name} took too long to start`);
  const stopped = () => {
    if (s.stopping === "canceled") fail("canceled", "The turn was canceled.");
    else if (s.stopping === "silence") {
      const span =
        silenceMs >= 60_000 ? `${Math.round(silenceMs / 60_000)} minutes` : `${Math.round(silenceMs / 1000)} seconds`;
      fail("acp_failed", `${name} said nothing for ${span} with no tool running, so the turn stopped.`, true);
    }
    return s.stopping !== null;
  };

  try {
    const init = await setup(conn.request<Record<string, unknown> | null>("initialize", ACP_CLIENT_INIT));
    const caps = isRecord(init?.agentCapabilities) ? init.agentCapabilities : {};
    const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
    const bridge = opencodeBridge({
      runId: input.runId,
      token: input.mcp.token,
      ...(input.mcp.url ? { url: input.mcp.url } : {}),
      ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
      ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
      runnerHome: opts.runnerHome,
    });

    const stored = opts.sessions.get(sessionKey);
    let opened: Record<string, unknown> | null = null;
    const resume = isRecord(sessionCaps.resume) ? "session/resume" : caps.loadSession === true ? "session/load" : null;
    if (stored && resume && !s.stopping) {
      // A load replays the history as updates: none of them is this turn's.
      s.sessionId = resume === "session/resume" ? stored : null;
      opened = await setup(
        conn.request<Record<string, unknown> | null>(resume, {
          sessionId: stored,
          cwd: input.cwd,
          mcpServers: [bridge],
        }),
      ).then(
        (r) => r ?? {},
        () => null,
      );
      if (opened) {
        s.sessionId = stored;
        s.admitted = true;
      } else {
        s.sessionId = null;
        opts.sessions.delete(sessionKey);
      }
    } else if (stored) opts.sessions.delete(sessionKey);
    const fresh = !opened;
    if (fresh && !s.stopping) {
      opened = await setup(
        conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridge] }),
      );
      s.sessionId = str(opened?.sessionId) || null;
      if (!s.sessionId) throw new Error(`${name} didn't start a session`);
    }
    if (input.model && s.sessionId && !s.stopping) {
      const offered = acpModelsOf(opened);
      if (offered.current !== input.model) {
        const change =
          offered.way === "set_model"
            ? conn.request("session/set_model", { sessionId: s.sessionId, modelId: input.model })
            : conn.request("session/set_config_option", {
                sessionId: s.sessionId,
                configId: "model",
                value: input.model,
              });
        await setup(change).catch((err: unknown) => {
          throw new Error(`${name} here doesn't offer ${input.model}: ${acpProblem(err).message}`);
        });
      }
    }

    if (stopped()) return;
    const answer = await conn
      .request<Record<string, unknown> | null>("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: opencodePrompt(input.system, input.prompt, fresh) }],
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    if (answer.ok) {
      admit();
      for (const event of reader.usage(answer.result?.usage, input.model)) emit(event);
    }
    if (stopped()) return;
    if (!answer.ok) {
      if ((answer.error as ExitError).exit) throw answer.error;
      const problem = acpProblem(answer.error);
      for (const event of acpEngineProblem(problem.message, reader.worked, problem.auth)) emit(event);
      return;
    }
    const stopReason = str(answer.result?.stopReason);
    if (stopReason === "cancelled") return fail("acp_failed", `${name} stopped the turn by itself.`, true);
    const text = reader.answer || reader.streamed;
    if (stopReason === "refusal" && !text.trim()) return fail("model_refused", "The model refused to answer.");
    emit({ type: "done", text, session: { id: input.sessionId } });
  } catch (err) {
    if (stopped()) return;
    const exit = (err as ExitError).exit;
    const missing =
      (exit?.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (windows && exit?.code === 9009);
    if (missing) return fail("acp_missing", `${name}'s command is not on this computer.`, true);
    const problem = acpProblem(err);
    for (const event of acpEngineProblem(problem.message, reader.worked, problem.auth)) emit(event);
  } finally {
    clearInterval(silence);
    clearTimeout(s.killTimer);
    opts.signal.removeEventListener("abort", onAbort);
    conn.close();
    if (!ended) fail("acp_failed", `${name} ended without an answer.`, true);
    child.stdin?.end();
    if (!(await goneWithin(exited, opts.exitGraceMs ?? EXIT_GRACE_MS))) {
      killTree(child, "SIGTERM");
      if (!(await goneWithin(exited, KILL_WAIT_MS))) {
        killTree(child, "SIGKILL");
        await goneWithin(exited, KILL_WAIT_MS);
      }
    }
  }
}

/** What the runner's `brain.turn` handler hands the ACP branch. */
export interface AcpBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  /** The engines `config.json` declares (none in system mode: ADR 0216 §7). */
  engines: readonly AcpEngineConfig[];
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  sessions?: CodexThreads;
  grants?: string[];
  spawn?: Spawn;
}

const sessionStores = new Map<string, CodexThreads>();
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$/;

/** `brain.turn` with `kind: "acp"`: the engine the computer declares, the turn's folder, its secrets, then the turn. */
export async function handleAcpBrainTurn(
  ctx: AcpBrainContext,
  req: AcpBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "Commands are turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token) {
    throw new RunnerError("bad_request", "mcp.token is required");
  }
  if (typeof req.model === "string" && req.model && !MODEL.test(req.model)) {
    throw new RunnerError("bad_request", "model is invalid");
  }
  if (req.account !== undefined && req.account !== null && req.account !== "") {
    throw new RunnerError("bad_request", "An ACP agent keeps its own sign-in: no account");
  }
  const engine = ctx.engines.find((e) => e.id === req.engine);
  if (!engine) {
    scope.emit({
      type: "error",
      code: "acp_engine_missing",
      message: `This computer declares no ACP agent named ${typeof req.engine === "string" ? req.engine : "that"}.`,
      retryable: false,
    });
    return;
  }
  const mode = req.permissions?.mode ?? "work";
  if (mode !== "work") {
    scope.emit({
      type: "error",
      code: "acp_profile",
      message:
        mode === "chat"
          ? `${engine.name} can't be kept to the agent's own tools, so it can't think for the team's right hand.`
          : `${engine.name} can't be kept to reading, so it doesn't take turns that only read.`,
      retryable: false,
    });
    return;
  }
  let cwd = ctx.folder;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  const secrets = await agentSecrets(ctx.secretsDir, req.agent);
  const file = acpSessionsFile(ctx.runnerHome);
  const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
  sessionStores.set(file, sessions);
  await runAcpTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      engine,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
    },
    {
      sessions,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
    },
  );
}
