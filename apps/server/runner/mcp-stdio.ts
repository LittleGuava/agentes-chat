import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { MachineReplies, McpStdioCall, McpStdioTool } from "@agenteschat/adapters/machine-protocol";
import { NETWORK_ENV } from "./accounts";
import { RUNNER_VERSION, RunnerError } from "./errors";
import { killTree } from "./exec";
import { MCP_PROTOCOL_VERSION } from "./mcp";

/**
 * `mcp.stdio` (ADR 0215): one MCP operation of a local stdio program. The program starts for this call alone, with the
 * argv it was given and no shell, speaks the handshake, answers the one call, and is stopped with everything it started
 * before the reply leaves. The handler checks the request and the command policy first (`handlers.ts`, `doMcpStdio`).
 */

/** One message from the program; a longer one stops it (`too_large`). */
export const MCP_STDIO_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Pages of a `tools/list`, as the HTTP client reads them. */
export const MCP_STDIO_MAX_PAGES = 20;
const STOP_GRACE_MS = 2_000;
/** After `exit`, how long the last lines of its output may take to arrive before it counts as gone. */
const EXIT_DRAIN_MS = 250;

/**
 * The variables of the runner's environment a program gets (ADR 0215 §3): where programs and the home are, the locale,
 * the temp folders, on Windows the system folders programs can't start without, the computer's proxies and trusted
 * certificates (`NETWORK_ENV`, so `npx` reaches its registry where the computer goes through one), and the agent's own
 * containers socket (`systemLauncher`, so `docker run -i …` servers work as the agent's commands do). Nothing else: not
 * the runner's token, not the agent's secrets.
 */
const PASSED_ENV = [
  ...NETWORK_ENV,
  "CONTAINER_HOST",
  "DOCKER_HOST",
  ...(process.platform === "win32"
    ? [
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
      ]
    : ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", "XDG_RUNTIME_DIR"]),
];

/** The program's environment: the allow-list read from `base`, then what the request names. */
export function stdioEnv(given: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows names are any case (`Path`): matched without it, kept as written.
  const key = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
  const wanted = new Set(PASSED_ENV.map(key));
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && wanted.has(key(name))) env[name] = value;
  }
  return { ...env, ...given };
}

/** Held programs can't be approved yet (ADR 0215, Later): what the agent reads instead of "ask again". */
export const ASK_ABOUT_MCP =
  "An MCP program can't be approved from here yet: tell the person who set this connector up, so they change the program.";

/** Every string the reply holds, redacted where it is: a value with quotes or newlines is found as it was written. */
function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, redact)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactStrings(v, redact)])) as T;
  }
  return value;
}

/** The reply as it may leave the computer: the agent's secret values redacted in every string (ADR 0215 §4). */
export const redactedReply = (reply: MachineReplies["mcp.stdio"], redact: (text: string) => string) =>
  redactStrings(reply, redact);

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * The argv as one POSIX command line, each word quoted unless it is plain characters: the line the command policy
 * judges is the argv that starts, word for word (an argument holding `;` or `$(…)` is one literal word in both).
 */
export function argvLine(argv: readonly string[]): string {
  return argv.map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(" ");
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface StdioMcpRun {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Absolute, already checked against the agent's folders. */
  cwd: string;
  call: McpStdioCall;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Starts the program, makes the handshake and the call, stops it; throws `RunnerError` when it can't answer. */
export async function runStdioMcp(run: StdioMcpRun): Promise<MachineReplies["mcp.stdio"]> {
  if (run.signal?.aborted) throw new RunnerError("dropped", "Stopped before the MCP program started");
  let child: ChildProcess;
  try {
    child = spawn(run.command, [...run.args], {
      cwd: run.cwd,
      env: stdioEnv(run.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so stopping it reaches what it started (`npx` runs the package as a child).
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    // Some runtimes refuse a missing program at once instead of with an `error` event.
    throw startFailure(err);
  }
  const client = new LineClient(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RunnerError("timed_out", `The MCP program didn't answer in ${run.timeoutMs / 1000} s`)),
      run.timeoutMs,
    );
  });
  const onAbort = () => client.fail(new RunnerError("dropped", "Stopped before the MCP program answered"));
  run.signal?.addEventListener("abort", onAbort, { once: true });
  const answer = talk(client, run.call);
  // Lost to the deadline or a cancel, it still settles when the program stops: nobody waits for it then.
  answer.catch(() => {});
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
    run.signal?.removeEventListener("abort", onAbort);
    await stop(child);
  }
}

async function talk(client: LineClient, call: McpStdioCall): Promise<MachineReplies["mcp.stdio"]> {
  const init = await client.request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "agentes.chat", version: RUNNER_VERSION },
  });
  client.notify("notifications/initialized");
  const info = isRecord(init) && isRecord(init.serverInfo) ? init.serverInfo : null;
  const serverInfo = info
    ? Object.fromEntries(
        (["name", "title", "version"] as const).flatMap((k) => (typeof info[k] === "string" ? [[k, info[k]]] : [])),
      )
    : null;
  if (call.method === "tools/list") {
    const tools: McpStdioTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_STDIO_MAX_PAGES; page++) {
      const res = await client.request("tools/list", cursor ? { cursor } : {});
      if (!isRecord(res) || !Array.isArray(res.tools))
        throw new RunnerError("internal", "The MCP program listed no tools");
      for (const t of res.tools) {
        if (!isRecord(t) || typeof t.name !== "string") continue;
        tools.push({
          name: t.name,
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          inputSchema: isRecord(t.inputSchema) ? t.inputSchema : { type: "object" },
          ...(isRecord(t.annotations) ? { annotations: hints(t.annotations) } : {}),
        });
      }
      cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return { serverInfo, tools };
  }
  const res = await client.request("tools/call", {
    name: call.name,
    arguments: call.arguments,
    ...(call.meta ? { _meta: call.meta } : {}),
  });
  if (!isRecord(res)) throw new RunnerError("internal", "The MCP program's answer wasn't a tool result");
  return {
    serverInfo,
    result: {
      ...(Array.isArray(res.content) ? { content: res.content } : {}),
      ...(res.isError === true ? { isError: true } : {}),
      ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
    },
  };
}

const hints = (a: Json): NonNullable<McpStdioTool["annotations"]> => ({
  ...(typeof a.readOnlyHint === "boolean" ? { readOnlyHint: a.readOnlyHint } : {}),
  ...(typeof a.destructiveHint === "boolean" ? { destructiveHint: a.destructiveHint } : {}),
});

/**
 * Ends it and what it started (`killTree`), and waits for it to be gone (`STOP_GRACE_MS` for each signal), so nothing
 * of it runs, or holds the agent's folder, once the reply leaves.
 */
async function stop(child: ChildProcess) {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const ended = new Promise<void>((resolve) => events(child).once("exit", () => resolve()));
  const within = (ms: number) => Promise.race([ended, new Promise<void>((r) => setTimeout(r, ms).unref())]);
  child.stdin?.end();
  if (!gone()) killTree(child, "SIGTERM");
  if (!gone()) await within(STOP_GRACE_MS);
  // Its group may outlive it (POSIX): what it started goes too.
  killTree(child, "SIGKILL");
  if (!gone()) await within(STOP_GRACE_MS);
}

/** A program that didn't start: missing (`tool_missing`, the commonest: no `npx` or `uvx` here) or refused. */
function startFailure(err: unknown): RunnerError {
  const code = isRecord(err) ? err.code : undefined;
  return code === "ENOENT"
    ? new RunnerError("tool_missing", "The MCP program isn't on this computer (its command wasn't found)")
    : new RunnerError("internal", "The MCP program couldn't start");
}

/** Through EventEmitter, as `exec.ts` does: some @types/node versions lose ChildProcess's event methods. */
const events = (child: ChildProcess) => child as unknown as EventEmitter;

/** JSON-RPC over the program's stdio, one message per line (MCP's stdio transport). */
class LineClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private failed: Error | null = null;
  private line: Buffer[] = [];
  private lineBytes = 0;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    // Read and dropped: diagnostics can hold credentials, and nothing here keeps or logs them.
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", () => {});
    events(child).on("error", (err: unknown) => this.fail(startFailure(err)));
    const ended = (code: number | null, signal: NodeJS.Signals | null) =>
      this.fail(new RunnerError("internal", `The MCP program ended (${signal ?? `exit ${code}`}) before it answered`));
    // `close` comes once its output is all read; `exit` may come first, so it waits a moment for the last lines.
    events(child).on("close", ended);
    events(child).on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      setTimeout(() => ended(code, signal), EXIT_DRAIN_MS).unref();
    });
  }

  request(method: string, params: Json): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string) {
    this.write({ jsonrpc: "2.0", method });
  }

  fail(err: Error) {
    this.failed ??= err;
    for (const p of this.pending.values()) p.reject(this.failed);
    this.pending.clear();
  }

  private write(message: Json) {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer) {
    let rest = chunk;
    for (let at = rest.indexOf(10); at !== -1; at = rest.indexOf(10)) {
      this.line.push(rest.subarray(0, at));
      const text = Buffer.concat(this.line).toString("utf8");
      this.line = [];
      this.lineBytes = 0;
      rest = rest.subarray(at + 1);
      this.message(text);
    }
    if (rest.length === 0) return;
    this.lineBytes += rest.length;
    if (this.lineBytes > MCP_STDIO_MESSAGE_BYTES) {
      this.line = [];
      this.lineBytes = 0;
      this.fail(new RunnerError("too_large", "The MCP program sent a message larger than 8 MB"));
      return;
    }
    this.line.push(rest);
  }

  private message(text: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      // Not a message (a program printing a banner on stdout): skipped.
      return;
    }
    if (!isRecord(msg)) return;
    const { id } = msg;
    if (typeof msg.method === "string") {
      if (id === undefined || id === null) return;
      // The computer asks nobody and samples no model (ADR 0215 §4): every request of the client is refused but ping.
      this.write(
        msg.method === "ping"
          ? { jsonrpc: "2.0", id, result: {} }
          : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
      );
      return;
    }
    if (typeof id !== "number") return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (isRecord(msg.error)) {
      const said = typeof msg.error.message === "string" ? msg.error.message.slice(0, 500) : "an error";
      waiting.reject(new RunnerError("bad_request", `The MCP program refused the request: ${said}`));
    } else waiting.resolve(msg.result);
  }
}
