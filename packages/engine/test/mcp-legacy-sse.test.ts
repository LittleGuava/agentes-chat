import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CustomDeps, connectCustomServer, connectOverHttpVia, refreshCustomServer } from "../src";
import { type Fixture, setup } from "./fixtures";

const SSE_URL = "https://legacy.example.com/sse";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
}

/**
 * An MCP server on the older HTTP+SSE transport (no network): GET `/sse` opens the stream and names where messages go
 * (`endpoint`), every answer comes back on that stream. A POST to `/sse` answers `post` (405 by default, as such
 * servers do). `get`: what the stream's GET answers instead (a 401 for a refused key); `silent`: the stream never
 * names its endpoint.
 */
function legacyServer(mode: { post?: number; get?: number; silent?: boolean; noStream?: boolean } = {}) {
  const seen: Seen[] = [];
  /** Whether the open stream is still held: its request's signal ends it, as a socket closed under it would. */
  const stream = { open: false };
  let push: ((text: string) => void) | null = null;
  const enc = new TextEncoder();
  const result = (method: string) =>
    method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } }
      : method === "tools/list"
        ? { tools: [{ name: "list_tickets", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: "text", text: "3 tickets" }] };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    seen.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/sse" && method === "POST") return new Response(null, { status: mode.post ?? 405 });
    if (url.pathname === "/sse") {
      if (mode.noStream) return new Response(null, { status: 404 });
      if (mode.get) {
        return new Response(null, { status: mode.get, headers: { "www-authenticate": 'Bearer realm="legacy"' } });
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          stream.open = true;
          init?.signal?.addEventListener("abort", () => {
            stream.open = false;
            push = null;
            c.error(new DOMException("aborted", "AbortError"));
          });
          push = (text) => c.enqueue(enc.encode(text));
          if (!mode.silent) push("event: endpoint\ndata: /messages?sessionId=s1\n\n");
        },
        cancel() {
          stream.open = false;
          push = null;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/messages" && method === "POST") {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (msg.id !== undefined) {
        const answer = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result(msg.method) });
        setTimeout(() => push?.(`event: message\ndata: ${answer}\n\n`), 0);
      }
      return new Response("Accepted", { status: 202 });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, seen, stream };
}

describe("an MCP server on the older HTTP+SSE transport", () => {
  test("its tools are listed and called over SSE; the key goes on the stream's GET and on every POST", async () => {
    const server = legacyServer();
    const session = await connectOverHttpVia(server.fetch)(
      { serverUrl: SSE_URL },
      { Authorization: "Bearer legacy_key_123" },
    );
    try {
      expect((await session.listTools()).map((t) => [t.name, t.readOnlyHint])).toEqual([["list_tickets", true]]);
      expect(await session.callTool("list_tickets", {})).toEqual({ content: "3 tickets", isError: false });
      expect(session.serverInfo?.()?.name).toBe("legacy");
    } finally {
      await session.close();
    }
    expect(server.stream.open).toBe(false);
    // Streamable HTTP first (refused with 405), then the stream and its messages.
    expect(server.seen[0]).toEqual({ method: "POST", path: "/sse", auth: "Bearer legacy_key_123" });
    expect(server.seen.some((s) => s.method === "GET" && s.path === "/sse")).toBe(true);
    expect(server.seen.filter((s) => s.path !== "/sse" || s.method === "GET").every((s) => s.auth)).toBe(true);
    expect(server.seen.filter((s) => s.path === "/messages").length).toBeGreaterThanOrEqual(3);
  });

  test("a 404 on the POST falls back too", async () => {
    const server = legacyServer({ post: 404 });
    const session = await connectOverHttpVia(server.fetch)({ serverUrl: SSE_URL }, {});
    await session.close();
    expect(server.seen.some((s) => s.method === "GET" && s.path === "/sse")).toBe(true);
  });

  for (const status of [400, 401, 403, 500, 502]) {
    test(`a ${status} on the POST is the server's answer: no fallback`, async () => {
      const server = legacyServer({ post: status });
      const error = await connectOverHttpVia(server.fetch)({ serverUrl: SSE_URL }, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StreamableHTTPError);
      expect((error as StreamableHTTPError).code).toBe(status);
      expect(server.seen.some((s) => s.method === "GET")).toBe(false);
    });
  }

  test("a stream that never says where to send is given up after the limit", async () => {
    const server = legacyServer({ silent: true });
    const started = Date.now();
    const error = await connectOverHttpVia(server.fetch, { sseOpenMs: 50 })({ serverUrl: SSE_URL }, {}).catch(
      (e: unknown) => e,
    );
    expect(String(error)).toContain("SSE");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.stream.open).toBe(false);
  });

  test("an address with neither transport says what the POST got, not the stream", async () => {
    const server = legacyServer({ post: 404, noStream: true });
    const error = await connectOverHttpVia(server.fetch)({ serverUrl: SSE_URL }, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect((error as StreamableHTTPError).code).toBe(404);
  });
});

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

function depsOf(fx: Fixture, fetch: FetchLike): CustomDeps {
  return {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    http: fetch as typeof globalThis.fetch,
    connect: connectOverHttpVia(fetch),
  };
}

describe("connecting a server on the older transport", () => {
  test("without a key: the probe sees the stream and connects it, with its tools", async () => {
    f = await setup();
    const server = legacyServer();
    const started = await connectCustomServer(depsOf(f, server.fetch), f.owner.id, f.org.id, {
      serverUrl: SSE_URL,
      label: "Legacy",
    });
    expect(started.status).toBe("connected");
    if (started.status !== "connected") return;
    expect(started.server.tools.map((t) => t.name)).toEqual(["list_tickets"]);
  });

  test("a stream that asks for a key: needs_key, as over Streamable HTTP", async () => {
    f = await setup();
    const server = legacyServer({ get: 401 });
    const started = await connectCustomServer(depsOf(f, server.fetch), f.owner.id, f.org.id, { serverUrl: SSE_URL });
    expect(started).toEqual({ status: "needs_key" });
  });

  test("a key the stream refuses (401) marks the connection to reconnect", async () => {
    f = await setup();
    const open = legacyServer();
    const started = await connectCustomServer(depsOf(f, open.fetch), f.owner.id, f.org.id, {
      serverUrl: SSE_URL,
      apiKey: "legacy_key_123",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const refused = legacyServer({ get: 401 });
    await refreshCustomServer(depsOf(f, refused.fetch), f.owner.id, f.org.id, started.server.id);
    const [row] = await f.db
      .select({ status: schema.connectorConnections.status })
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, started.server.id));
    expect(row?.status).toBe("needs_reconnect");
  });
});
