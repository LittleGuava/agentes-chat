import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * What a POST gets from a server that speaks only the older HTTP+SSE transport (protocol 2024-11-05): its address is
 * the stream's, which takes GET alone. Any other refusal is the server's own answer and is never retried over SSE.
 */
const OLDER_TRANSPORT_STATUS = new Set([404, 405]);

/** How long the older transport's stream may take to say where messages go before the session is given up. */
export const SSE_OPEN_MS = 30_000;

/**
 * A session to `url` over Streamable HTTP, or over the older HTTP+SSE transport when the address refuses the POST
 * with 404 or 405, as the MCP spec's backwards-compatibility section has clients do (ADR 0016, addendum 2026-11-15).
 * Nothing is stored: each session tries Streamable HTTP first, so a server that moves to it is used that way at once.
 */
export async function openHttpSession<S>(
  url: URL,
  headers: Record<string, string>,
  fetch: FetchLike,
  over: (transport: Transport) => Promise<S>,
  sseOpenMs = SSE_OPEN_MS,
): Promise<S> {
  let refused: StreamableHTTPError;
  try {
    return await over(new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch }));
  } catch (error) {
    if (!(error instanceof StreamableHTTPError) || !OLDER_TRANSPORT_STATUS.has(error.code ?? 0)) throw error;
    refused = error;
  }
  const transport = new SSEClientTransport(url, { requestInit: { headers }, fetch });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The SDK waits for the stream's `endpoint` event with no limit of its own.
  const tooLate = new Error("The MCP server's SSE stream never said where to send messages");
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooLate), sseOpenMs);
  });
  try {
    return await Promise.race([over(transport), late]);
  } catch (error) {
    await transport.close().catch(() => {});
    // A stream that refused the key or never named its endpoint says what's wrong; else the address had neither
    // transport, and the POST's refusal says it best.
    throw error === tooLate || refusedCredentials(error) ? error : refused;
  } finally {
    clearTimeout(timer);
  }
}

/** A server refused the credentials it was sent (HTTP 401), over either transport. */
export function refusedCredentials(error: unknown): error is Error {
  return (error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401;
}
