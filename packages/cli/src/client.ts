import { CliError, EXIT, type ExitCode } from "./exit";

/**
 * A client of the server's `/mcp` endpoint (ADR 0119): stateless `tools/call` requests with a bearer token, and
 * each answer turned into the tool's data or a `CliError` with its exit code (ADR 0188 §7). The exit code comes
 * from the HTTP status, the JSON-RPC error code, `isError` and the tool's own fields, never from an error's words.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type ToolData = Record<string, unknown>;

export interface ClientOptions {
  endpoint: string;
  token: string;
  fetch: Fetch;
  userAgent: string;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/** A failure worth trying again after a pause: no answer, a 5xx, a limit. */
export class RetryableError extends CliError {
  constructor(
    message: string,
    exitCode: ExitCode,
    readonly retryAfterMs: number | null,
  ) {
    super(message, exitCode, retryAfterMs === null ? {} : { retry_after: Math.ceil(retryAfterMs / 1000) });
  }
}

/** The JSON-RPC errors the server sends with a meaning of their own (ADR 0119 §3 and §8). */
const RPC_AUTH = -32010;
const RPC_LIMITED = -32013;

const PAUSE_MS = 1000;
const PAUSE_MAX_MS = 15_000;

/** `https://chat.example.com` and `…/mcp` both name the endpoint `…/mcp`. */
export function endpointOf(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new CliError(`"${url}" is not an address. Give the server's, such as https://chat.example.com.`, EXIT.usage);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new CliError(`The server's address starts with https:// or http://, not ${parsed.protocol}.`, EXIT.usage);
  if (parsed.username || parsed.password)
    throw new CliError("The server's address can't hold a user or password. Use a token.", EXIT.usage);
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

/** Plain http to anything but this computer sends the token unencrypted. */
export function sendsInTheClear(endpoint: URL) {
  if (endpoint.protocol !== "http:") return false;
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host));
}

const secondsHeader = (value: string | null) => {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
};

/** The `{"retry_after":N}` a tool appends to a refusal it means as a limit (`send_to_agent`'s sending limits). */
function retryAfterOf(text: string): number | null {
  const brace = text.lastIndexOf(" {");
  if (brace === -1) return null;
  try {
    const extra = JSON.parse(text.slice(brace + 1)) as { retry_after?: unknown };
    return typeof extra.retry_after === "number" ? extra.retry_after * 1000 : null;
  } catch {
    return null;
  }
}

interface RpcAnswer {
  result?: { isError?: boolean; content?: { type?: string; text?: string }[]; structuredContent?: ToolData };
  error?: { code?: number; message?: string; data?: { retry_after?: unknown } };
}

export class McpClient {
  private id = 0;
  constructor(private readonly options: ClientOptions) {}

  /**
   * Calls a tool. With `retryUntil` (a time from `now`), a failure worth retrying is retried after a pause (a limit's
   * `Retry-After`, else 1 s doubling to 15 s) while the pause ends before then.
   */
  async call(name: string, args: ToolData, retryUntil?: number): Promise<ToolData> {
    let pause = PAUSE_MS;
    for (;;) {
      try {
        return await this.once(name, args);
      } catch (error) {
        if (!(error instanceof RetryableError) || retryUntil === undefined) throw error;
        const wait = error.retryAfterMs ?? pause;
        pause = Math.min(pause * 2, PAUSE_MAX_MS);
        if (this.options.now() + wait > retryUntil) throw error;
        await this.options.sleep(wait, this.options.signal);
      }
    }
  }

  private async once(name: string, args: ToolData): Promise<ToolData> {
    const { endpoint, token, signal } = this.options;
    const host = new URL(endpoint).host;
    let res: Response;
    try {
      res = await this.options.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "user-agent": this.options.userAgent,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new CliError("Interrupted.", EXIT.interrupted);
      const why = error instanceof Error ? error.message : String(error);
      throw new RetryableError(`Can't reach ${host}: ${why}`, EXIT.unreachable, null);
    }
    if (res.status === 401 || res.status === 403)
      throw new CliError(
        `${host} refused the token: it is expired, revoked, or for another server or workspace.`,
        EXIT.unreachable,
      );
    let answer: RpcAnswer | null = null;
    try {
      answer = (await res.json()) as RpcAnswer;
    } catch {
      answer = null;
    }
    if (res.status === 429) {
      const fromBody = answer?.error?.data?.retry_after;
      const after =
        secondsHeader(res.headers.get("retry-after")) ?? (typeof fromBody === "number" ? fromBody * 1000 : null);
      throw new RetryableError(`${host} limits this token's requests. Try again later.`, EXIT.limited, after);
    }
    if (res.status >= 500) throw new RetryableError(`${host} answered ${res.status}.`, EXIT.unreachable, null);
    if (!answer || typeof answer !== "object" || (!answer.result && !answer.error))
      throw new CliError(`${host} didn't answer as an agentes.chat server (HTTP ${res.status}).`, EXIT.unreachable);
    if (answer.error) {
      const code = answer.error.code;
      if (code === RPC_LIMITED) {
        const after = answer.error.data?.retry_after;
        throw new RetryableError(
          `${host} limits this token's requests. Try again later.`,
          EXIT.limited,
          typeof after === "number" ? after * 1000 : null,
        );
      }
      if (code === RPC_AUTH) throw new CliError(`${host} refused the token.`, EXIT.unreachable);
      // A tool the token's access doesn't list (a read token sending) is unknown to this connection.
      throw new CliError(
        `${host} refused the call to ${name}: ${answer.error.message ?? "no reason given"}. The token may lack the access it needs (Settings → Apps de IA), or the server may be older than this command.`,
        EXIT.unreachable,
      );
    }
    const result = answer.result ?? {};
    if (result.isError) {
      const text =
        (result.content ?? [])
          .map((c) => c.text ?? "")
          .join("\n")
          .trim() || `${name} was refused.`;
      const after = retryAfterOf(text);
      if (after !== null) throw new CliError(text, EXIT.limited, { retry_after: Math.ceil(after / 1000) });
      throw new CliError(text, EXIT.failed);
    }
    return result.structuredContent ?? {};
  }
}
