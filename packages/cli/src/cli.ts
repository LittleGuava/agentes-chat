/**
 * `agentes`: send a task to an agentes.chat agent, wait for it, keep the conversation, follow it, from scripts and
 * CI (ADR 0219). A thin client of the server's `/mcp` endpoint with a personal token (ADR 0119): every check is the
 * server's, as for any MCP client.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { type Args, allowOnly, parseArgs, parseCount, parseDuration } from "./args";
import { endpointOf, type Fetch, McpClient, sendsInTheClear, type ToolData } from "./client";
import { CliError, EXIT, type ExitCode, exitForStatus } from "./exit";

export { EXIT, type ExitCode } from "./exit";

export const VERSION = "0.1.0";

/** Everything the command touches outside itself, so tests can hand it the app in memory. */
export interface Io {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal;
}

/** What a command hands back: its data for `--json`, the plain text for stdout, a line for stderr. */
interface Outcome {
  data: ToolData;
  exit: ExitCode;
  text?: string;
  note?: string;
}

interface Context {
  args: Args;
  io: Io;
  client: McpClient;
  endpoint: URL;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The longest `wait_for_reply` the server holds (ADR 0119 §7). */
const WAIT_MAX_S = 45;
const MESSAGE_MAX = 8000;
const KEY_MAX = 64;
const PAGE = 50;
/** A send is safe to resend for this long: it carries its idempotency key. */
const SEND_RETRY_MS = 30_000;
/** Each of an export's reads may wait out the token's per-minute limit. */
const READ_RETRY_MS = 2 * 60_000;
/** Never more often: a token has 5,000 requests a day (ADR 0219 §9). */
const EVENTS_MIN_INTERVAL_MS = 30_000;

const HELP: Record<string, string> = {
  "": `agentes ${VERSION}: give agentes.chat agents work from scripts and CI.

Usage: agentes <command> [options]

  send AGENT TEXT        Send a task to an agent; prints its task id.
  run AGENT TEXT         Send a task and wait until it is done.
  wait TASK_ID           Wait on a task already sent.
  export TASK_ID         Write a task's conversation as JSON or Markdown.
  events --task ID       Print new messages and status changes as JSON lines.
  help COMMAND           One command's options.

Every command takes:
  --url URL              The server (or AGENTES_URL), such as https://chat.example.com.
  --token-file FILE      A file holding the token (or AGENTES_TOKEN): Settings → Apps de IA → Tokens pessoais.
  --json                 Exactly one JSON document on stdout, failures included.
  --quiet                No progress lines on stderr.

Exit codes: 0 done · 1 failed, canceled, no run or refused · 2 wrong command line · 3 a person must act ·
4 timed out (the task keeps running) · 5 server unreachable or token refused · 6 limited, try later · 130 Ctrl-C.`,
  send: `agentes send AGENT TEXT [--channel ID] [--thread ID] [--key KEY]

Sends TEXT to AGENT (a handle such as @dev, or an id) as you, and prints the task id.
TEXT is the next word, --message-file FILE, or - to read standard input.
  --channel ID   Post in this channel with the agent mentioned (else your direct conversation with it).
  --thread ID    Continue this thread.
  --key KEY      The same key sends once, so a retried script doesn't post twice (64 characters at most).`,
  run: `agentes run AGENT TEXT [--timeout 10m] [--channel ID] [--thread ID] [--key KEY]

Sends TEXT to AGENT, then waits until the task is done, needs a person, fails or the time is up.
Prints the reply. Takes send's options, and:
  --timeout D    How long to wait (90, 90s, 5m, 2h; default 10m). The task keeps running after it.`,
  wait: `agentes wait TASK_ID [--timeout 10m]

Waits on a task sent earlier (by send, run, or an AI app) and prints the reply when it is done.
  --timeout D    How long to wait (default 10m; 0 checks once).`,
  export: `agentes export TASK_ID | --thread ID | --channel ID [--out FILE] [--format json|md] [--limit 200] [--force]

Writes a conversation, oldest message first, to stdout or FILE.
  --format F     json (default) or md.
  --limit N      The newest N messages, 1 to 2000 (default 200).
  --out FILE     Write to FILE; an existing one is replaced only with --force.`,
  events: `agentes events --task ID | --thread ID | --channel ID [--interval 30s] [--until-done] [--timeout D]

Prints each new message, and a task's status changes, as one JSON line each, until Ctrl-C.
With --task it starts from the task's own message; otherwise from now.
  --interval D   How often a channel, a thread or a settled task is read (default and least 30s).
                 A running task is followed with waits the server holds 45 s.
  --until-done   With --task: end when the task does, with its exit code.
  --timeout D    End after this long (exit 4 with --until-done).`,
};

const usage = (message: string) => new CliError(message, EXIT.usage);

/** Tasks, threads and channels are named by UUID: anything else (an empty `$TASK`) is the command line's fault. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOf(value: string, what: string) {
  if (!UUID.test(value)) throw usage(`${what} is an id such as 0195f3a0-…, not "${value}".`);
  return value;
}

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CliError("Interrupted.", EXIT.interrupted));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CliError("Interrupted.", EXIT.interrupted));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Runs one command line and returns its exit code; never throws. */
export async function main(argv: string[], io: Io): Promise<number> {
  const json = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    const command = args.command;
    const help = args.switches.has("help");
    if (command === null && !help) {
      io.stderr(`${HELP[""]}\n`);
      return EXIT.usage;
    }
    if (command === null || command === "help" || help) {
      const topic = command === "help" ? (args.positionals[0] ?? "") : (command ?? "");
      const text = HELP[topic];
      if (text === undefined) throw usage(`No command "${topic}". agentes help lists them.`);
      io.stdout(`${text}\n`);
      return EXIT.done;
    }
    const run = COMMANDS[command];
    if (!run) throw usage(`No command "${command}". agentes help lists them.`);
    const ctx = await connect(args, io);
    const outcome = await run(ctx);
    if (json)
      io.stdout(`${JSON.stringify({ ok: outcome.exit === EXIT.done, exitCode: outcome.exit, ...outcome.data })}\n`);
    else if (outcome.text !== undefined) io.stdout(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
    if (outcome.note && !args.switches.has("quiet")) io.stderr(`${outcome.note}\n`);
    return outcome.exit;
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, EXIT.failed);
    if (json)
      io.stdout(
        `${JSON.stringify({ ok: false, error: failure.message, exitCode: failure.exitCode, ...failure.extra })}\n`,
      );
    else io.stderr(`agentes: ${failure.message}\n`);
    return failure.exitCode;
  }
}

async function connect(args: Args, io: Io): Promise<Context> {
  const url = args.values.get("url") ?? io.env.AGENTES_URL;
  if (!url?.trim()) throw usage("Which server? Give --url or set AGENTES_URL.");
  const endpoint = endpointOf(url);
  const tokenFile = args.values.get("token-file");
  let token: string | undefined;
  if (tokenFile) {
    try {
      token = (await readFile(tokenFile, "utf8")).trim();
    } catch {
      throw usage(`Can't read the token file ${tokenFile}.`);
    }
  } else token = io.env.AGENTES_TOKEN?.trim();
  if (!token)
    throw usage("No token. Set AGENTES_TOKEN or give --token-file (Settings → Apps de IA → Tokens pessoais).");
  if (/\s/.test(token)) throw usage("The token has spaces in it. It is one word, such as agp_….");
  if (sendsInTheClear(endpoint) && !args.switches.has("quiet"))
    io.stderr(`agentes: ${endpoint.host} is plain http: the token travels unencrypted.\n`);
  const now = io.now ?? Date.now;
  const sleeper = io.sleep ?? realSleep;
  const client = new McpClient({
    endpoint: endpoint.toString(),
    token,
    fetch: io.fetch,
    userAgent: `agentes-cli/${VERSION}`,
    now,
    sleep: sleeper,
    ...(io.signal ? { signal: io.signal } : {}),
  });
  return { args, io, client, endpoint, now, sleep: (ms) => sleeper(ms, io.signal) };
}

// ── send, run, wait ──────────────────────────────────────────────────────────

/** The text to send: the word after the agent, `-` for standard input, or `--message-file`. */
async function messageOf(ctx: Context, words: string[]) {
  const file = ctx.args.values.get("message-file");
  if (words.length > 1) throw usage("Put the message in quotes: it is one argument.");
  if (file && words.length > 0) throw usage("Give the message once: as an argument or with --message-file.");
  let text: string;
  if (file) {
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw usage(`Can't read ${file}.`);
    }
  } else if (words[0] === "-") text = await ctx.io.readStdin();
  else if (words[0] !== undefined) text = words[0];
  else throw usage("What should the agent do? Give the message, --message-file FILE, or - for standard input.");
  text = text.trim();
  if (!text) throw usage("The message is empty.");
  if (text.length > MESSAGE_MAX) throw usage(`The message has ${text.length} characters; ${MESSAGE_MAX} at most.`);
  return text;
}

async function sendTask(ctx: Context) {
  const [agent, ...words] = ctx.args.positionals;
  if (!agent) throw usage("Which agent? Give its handle, such as @dev.");
  const message = await messageOf(ctx, words);
  const key = ctx.args.values.get("key") ?? randomBytes(12).toString("hex");
  if (key.length > KEY_MAX) throw usage(`--key has ${KEY_MAX} characters at most.`);
  const channelText = ctx.args.values.get("channel");
  const threadText = ctx.args.values.get("thread");
  const channel = channelText === undefined ? undefined : idOf(channelText, "--channel");
  const thread = threadText === undefined ? undefined : idOf(threadText, "--thread");
  return ctx.client.call(
    "send_to_agent",
    {
      agent,
      message,
      wait_seconds: 0,
      idempotency_key: key,
      ...(channel ? { channel_id: channel } : {}),
      ...(thread ? { thread_id: thread } : {}),
    },
    ctx.now() + SEND_RETRY_MS,
  );
}

const handleOf = (data: ToolData) => {
  const agent = obj(data.agent);
  return agent && str(agent.handle) ? `@${agent.handle}` : "the agent";
};

async function send(ctx: Context): Promise<Outcome> {
  allowOnly(ctx.args, "send", ["message-file", "channel", "thread", "key"]);
  const data = await sendTask(ctx);
  const taskId = str(data.task_id) ?? "";
  return {
    data: { command: "send", ...data },
    exit: EXIT.done,
    text: taskId,
    note: `Sent to ${handleOf(data)}: ${str(data.message_url) ?? taskId}`,
  };
}

/** Waits on a task, 45 s per request held by the server, until it changes or the time is up (ADR 0219 §5). */
async function waitFor(ctx: Context, taskId: string, timeoutMs: number): Promise<ToolData> {
  const deadline = ctx.now() + timeoutMs;
  try {
    for (;;) {
      const asked = Math.min(WAIT_MAX_S, Math.max(1, Math.ceil((deadline - ctx.now()) / 1000)));
      const started = ctx.now();
      const data = await ctx.client.call("wait_for_reply", { task_id: taskId, timeout_seconds: asked }, deadline);
      if (data.status !== "still_running" || ctx.now() >= deadline) return data;
      // Answered before the time it was asked to hold: the person's waits are all taken, or it was cut short.
      const retry = num(data.retry_after_seconds);
      if (retry !== null || ctx.now() - started < asked * 1000 - 1000) {
        const pause = (retry ?? num(data.poll_after_seconds) ?? 5) * 1000;
        if (ctx.now() + pause >= deadline) return data;
        await ctx.sleep(pause);
      }
    }
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.interrupted)
      throw new CliError(`Interrupted. The task keeps running: agentes wait ${taskId}`, EXIT.interrupted, {
        task_id: taskId,
      });
    throw error;
  }
}

/** The reply's text on stdout, where the task stands on stderr. */
function settled(command: string, data: ToolData): Outcome {
  const status = str(data.status) ?? "unknown";
  const exit = exitForStatus(status);
  const reply = obj(data.reply);
  const replyText = reply ? str(reply.untrusted_text) : null;
  const taskId = str(data.task_id) ?? "";
  const where = str(data.message_url) ?? taskId;
  const notes: Record<string, string> = {
    done: `Done: ${handleOf(data)} replied. ${where}`,
    waiting_approval: `A person must decide an approval in agentes.chat: ${str(data.approval_url) ?? where}`,
    waiting_input: `${handleOf(data)} asked a question. Answer with: agentes send ${handleOf(data)} - --thread ${taskId}`,
    still_running: `Still running. Wait again with: agentes wait ${taskId}`,
    no_run: `No run started for this task. ${str(data.detail) ?? ""}`.trim(),
    canceled: `The task was canceled. ${where}`,
  };
  const note = notes[status] ?? `The task ${status}${str(data.error) ? `: ${data.error}` : ""}. ${where}`;
  return { data: { command, ...data }, exit, ...(replyText !== null ? { text: replyText } : {}), note };
}

const timeoutOf = (ctx: Context, fallbackMs: number) => {
  const given = ctx.args.values.get("timeout");
  return given === undefined ? fallbackMs : parseDuration(given, "timeout");
};

async function run(ctx: Context): Promise<Outcome> {
  allowOnly(ctx.args, "run", ["message-file", "channel", "thread", "key", "timeout"]);
  const timeout = timeoutOf(ctx, 10 * 60_000);
  const sent = await sendTask(ctx);
  const taskId = str(sent.task_id);
  if (!taskId) throw new CliError("The server sent the task but returned no task id.", EXIT.unreachable);
  if (!ctx.args.switches.has("quiet")) ctx.io.stderr(`Sent to ${handleOf(sent)} as task ${taskId}. Waiting…\n`);
  return settled("run", await waitFor(ctx, taskId, timeout));
}

async function wait(ctx: Context): Promise<Outcome> {
  allowOnly(ctx.args, "wait", ["timeout"]);
  const [taskId, extra] = ctx.args.positionals;
  if (!taskId || extra !== undefined) throw usage("Give one task id: agentes wait TASK_ID.");
  return settled("wait", await waitFor(ctx, idOf(taskId, "The task"), timeoutOf(ctx, 10 * 60_000)));
}

// ── export ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  author?: { kind?: string; name?: string };
  sent_at?: string;
  untrusted_text?: string;
  truncated?: boolean;
  attachments?: { name?: string; url?: string }[];
  via?: string;
}

/** Exactly one of a task id (as the argument or `--task`), `--thread` or `--channel`. */
function targetOf(ctx: Context, command: string): Record<string, string> {
  const [first, extra] = ctx.args.positionals;
  if (extra !== undefined) throw usage(`${command} takes one task id.`);
  const given = [
    ...(first ? [["task_id", first]] : []),
    ...(["task", "thread", "channel"] as const).flatMap((name) => {
      const value = ctx.args.values.get(name);
      return value ? [[`${name}_id`, value]] : [];
    }),
  ];
  const only = given[0];
  if (given.length !== 1 || !only)
    throw usage(`${command} reads one conversation: a task id, --thread ID or --channel ID.`);
  const [key, value] = only as [string, string];
  return { [key]: idOf(value, key === "task_id" ? "The task" : `--${key.replace(/_id$/, "")}`) };
}

const messagesOf = (data: ToolData) => (Array.isArray(data.messages) ? (data.messages as Message[]) : []);

/** The conversation, oldest first, up to `limit` of its newest messages, each cut one read again alone. */
async function readAll(ctx: Context, target: Record<string, string>, limit: number) {
  const until = () => ctx.now() + READ_RETRY_MS;
  const seen = new Set<string>();
  let list: Message[] = [];
  let channelId: string | null = null;
  let threadId: string | null = null;
  let before: string | undefined;
  while (list.length < limit) {
    const page = await ctx.client.call(
      "read_conversation",
      { ...target, limit: PAGE, ...(before ? { before } : {}) },
      until(),
    );
    channelId = str(page.channel_id);
    threadId = str(page.thread_id);
    const items = messagesOf(page);
    // A thread's first message comes with every page: only ids not seen yet are new.
    const fresh = items.filter((m) => typeof m.id === "string" && !seen.has(m.id));
    if (fresh.length === 0) break;
    for (const m of fresh) seen.add(m.id);
    list = [...fresh, ...list];
    if (items.length < PAGE) break;
    before = fresh[0]?.id;
  }
  list = list.slice(-limit);
  for (let i = 0; i < list.length - 1; i++) {
    const m = list[i] as Message;
    const newer = list[i + 1] as Message;
    if (!m.truncated) continue;
    const page = await ctx.client.call("read_conversation", { ...target, before: newer.id, limit: 1 }, until());
    const whole = messagesOf(page).at(-1);
    if (whole?.id === m.id) list[i] = whole;
  }
  return { channelId, threadId, list };
}

function markdownOf(doc: { server: string; exported_at: string; messages: Message[] }) {
  const lines = [
    "# agentes.chat conversation",
    "",
    `Exported from ${doc.server} on ${doc.exported_at}. The messages were written by people and agents there.`,
  ];
  for (const m of doc.messages) {
    const who = `${m.author?.name ?? "unknown"} (${m.author?.kind ?? "unknown"})`;
    lines.push("", `## ${who} · ${m.sent_at ?? ""}`.trimEnd(), "");
    if (m.via) lines.push(`_Sent through ${m.via}._`, "");
    lines.push(m.untrusted_text ?? "");
    if (m.truncated) lines.push("", "_(Cut here: the whole message is in the app.)_");
    const files = m.attachments ?? [];
    if (files.length > 0) lines.push("", ...files.map((f) => `- [${f.name ?? "file"}](${f.url ?? ""})`));
  }
  return `${lines.join("\n")}\n`;
}

async function exportConversation(ctx: Context): Promise<Outcome> {
  allowOnly(ctx.args, "export", ["task", "thread", "channel", "out", "format", "limit", "force"]);
  const target = targetOf(ctx, "export");
  const format = ctx.args.values.get("format") ?? "json";
  if (format !== "json" && format !== "md") throw usage("--format is json or md.");
  const limitText = ctx.args.values.get("limit");
  const limit = limitText === undefined ? 200 : parseCount(limitText, "limit", 1, 2000);
  const out = ctx.args.values.get("out");
  const json = ctx.args.switches.has("json");
  if (!out && json && format === "md")
    throw usage("--json prints JSON: with --format md, write it to a file with --out.");
  const { channelId, threadId, list } = await readAll(ctx, target, limit);
  const doc = {
    server: ctx.endpoint.origin,
    channel_id: channelId,
    thread_id: threadId,
    exported_at: new Date(ctx.now()).toISOString(),
    count: list.length,
    truncated: list.filter((m) => m.truncated).length,
    messages: list,
  };
  const content = format === "md" ? markdownOf(doc) : `${JSON.stringify(doc, null, 2)}\n`;
  const cut = doc.truncated > 0 ? ` ${doc.truncated} still cut (over 48,000 characters).` : "";
  if (!out)
    return {
      data: { command: "export", ...doc },
      exit: EXIT.done,
      text: content,
      note: `${doc.count} messages.${cut}`,
    };
  try {
    await writeFile(out, content, { encoding: "utf8", flag: ctx.args.switches.has("force") ? "w" : "wx" });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EEXIST") throw usage(`${out} exists. --force replaces it.`);
    throw usage(`Can't write ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = { command: "export", out, format, count: doc.count, truncated: doc.truncated };
  return { data: summary, exit: EXIT.done, text: out, note: `Wrote ${doc.count} messages to ${out}.${cut}` };
}

// ── events ───────────────────────────────────────────────────────────────────

async function events(ctx: Context): Promise<Outcome> {
  allowOnly(ctx.args, "events", ["task", "thread", "channel", "interval", "until-done", "timeout"]);
  const target = targetOf(ctx, "events");
  const taskId = target.task_id;
  const untilDone = ctx.args.switches.has("until-done");
  if (untilDone && !taskId) throw usage("--until-done follows a task: give --task ID.");
  const intervalText = ctx.args.values.get("interval");
  const interval = intervalText === undefined ? EVENTS_MIN_INTERVAL_MS : parseDuration(intervalText, "interval");
  if (interval < EVENTS_MIN_INTERVAL_MS) throw usage("--interval is 30s or more: a token has 5,000 requests a day.");
  const timeoutText = ctx.args.values.get("timeout");
  const deadline = timeoutText === undefined ? null : ctx.now() + parseDuration(timeoutText, "timeout");
  const retryUntil = () => deadline ?? ctx.now() + 24 * 3_600_000;
  const line = (event: ToolData) => ctx.io.stdout(`${JSON.stringify(event)}\n`);
  const seen = new Set<string>();
  const read = async (print: boolean) => {
    const items = messagesOf(await ctx.client.call("read_conversation", { ...target, limit: PAGE }, retryUntil()));
    // A task's own conversation is printed from the task's message on; elsewhere, only what comes after now.
    const from = print
      ? Math.max(
          0,
          items.findIndex((m) => m.id === taskId),
        )
      : items.length;
    items.forEach((m, i) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      if (i >= from) line({ type: "message", ...m });
    });
  };
  let status: string | null = null;
  let last: ToolData = {};
  try {
    await read(Boolean(taskId));
    for (;;) {
      const left = deadline === null ? Number.POSITIVE_INFINITY : deadline - ctx.now();
      if (left <= 0) return { data: { command: "events", ...last }, exit: untilDone ? EXIT.timedOut : EXIT.done };
      if (taskId && (status === null || status === "still_running")) {
        // Held by the server up to 45 s: a wait and a read every 45 s is under 4,000 requests a day.
        const asked = Math.min(WAIT_MAX_S, Math.max(1, Math.ceil(left / 1000)));
        const started = ctx.now();
        const data = await ctx.client.call("wait_for_reply", { task_id: taskId, timeout_seconds: asked }, retryUntil());
        await read(true);
        const now = str(data.status);
        if (now !== status) {
          status = now;
          const { reply: _reply, ...rest } = data;
          last = rest;
          line({ type: "status", ...rest });
        }
        if (untilDone && status !== "still_running")
          return { data: { command: "events", ...last }, exit: exitForStatus(status ?? "") };
        // Answered at once while still running: the person's waits are taken. Pause instead of asking again.
        if (status === "still_running" && ctx.now() - started < asked * 1000 - 1000)
          await ctx.sleep(Math.min(left, Math.max((num(data.retry_after_seconds) ?? 0) * 1000, interval)));
      } else {
        // A channel, a thread, or a task that has settled: only new messages, read every interval.
        await ctx.sleep(Math.min(interval, left));
        await read(true);
      }
    }
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.interrupted)
      return { data: { command: "events", ...last }, exit: EXIT.interrupted };
    throw error;
  }
}

const COMMANDS: Record<string, (ctx: Context) => Promise<Outcome>> = {
  send,
  run,
  wait,
  export: exportConversation,
  events,
};
