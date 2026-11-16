import { afterEach, expect, test } from "bun:test";
import { connectOverHttpVia } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

/**
 * An MCP server on the older HTTP+SSE transport, as the outside world sees it (no network): POST to its address is
 * 405, GET opens the stream that names `/messages`, and every answer comes back on the stream.
 */
function legacyServer() {
  let push: ((text: string) => void) | null = null;
  const enc = new TextEncoder();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/sse" && method === "POST") return new Response(null, { status: 405 });
    if (url.pathname === "/sse") {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          push = (text) => c.enqueue(enc.encode(text));
          push("event: endpoint\ndata: /messages?sessionId=s1\n\n");
        },
        cancel() {
          push = null;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/messages" && method === "POST") {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wiki", version: "1" } }
          : { tools: [{ name: "search_pages", inputSchema: { type: "object" } }] };
      if (msg.id !== undefined) {
        const answer = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        setTimeout(() => push?.(`event: message\ndata: ${answer}\n\n`), 0);
      }
      return new Response("Accepted", { status: 202 });
    }
    return new Response(null, { status: 404 });
  };
  return fetch;
}

test("a server on the older HTTP+SSE transport connects by its /sse address, with its tools", async () => {
  const fetch = legacyServer();
  t = await createTestServer({
    http: fetch as typeof globalThis.fetch,
    mcpConnect: connectOverHttpVia(fetch),
    resolveHost: async () => ["93.184.216.34"],
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
    json: { serverUrl: "https://wiki.example.com/sse", label: "Wiki" },
  });
  expect(res.status).toBe(200);
  const started = (await res.json()) as { status: string; server: { tools: { name: string }[] } };
  expect(started.status).toBe("connected");
  expect(started.server.tools.map((x) => x.name)).toEqual(["search_pages"]);
});
