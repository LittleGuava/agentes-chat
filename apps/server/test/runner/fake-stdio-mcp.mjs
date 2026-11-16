// A stdio MCP server for the runner's `mcp.stdio` tests (ADR 0215): newline-delimited JSON-RPC on stdin/stdout.
// FAKE_MCP_MODE=hang never answers `initialize`, after starting a child that sleeps (its pid in FAKE_MCP_CHILD_PID).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
process.stderr.write("fake stdio server: noise that nobody keeps\n");

if (process.env.FAKE_MCP_MODE === "hang") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_MCP_CHILD_PID, String(child.pid));
}

const TOOLS = [
  { name: "echo", description: "Says back what it got", inputSchema: { type: "object" } },
  {
    name: "read_text",
    description: "A file of the folder it runs in",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];

let initialized = false;
let pendingList = null;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (process.env.FAKE_MCP_MODE === "hang") return;
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  // The answer to the request this server made of the client: the listing goes on only once it is refused.
  if (msg.id === "ask-roots") {
    if (msg.error?.code === -32601 && pendingList) {
      send({ id: pendingList, result: { tools: [TOOLS[0]], nextCursor: "page-2" } });
      pendingList = null;
    }
    return;
  }
  if (!initialized) {
    send({ id: msg.id, error: { code: -32600, message: "not initialized" } });
    return;
  }
  if (msg.method === "tools/list") {
    if (msg.params?.cursor === "page-2") {
      send({ id: msg.id, result: { tools: [TOOLS[1]] } });
      return;
    }
    pendingList = msg.id;
    send({ id: "ask-roots", method: "roots/list", params: {} });
    return;
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args, _meta: meta } = msg.params;
    if (name === "echo") {
      const said = {
        argv: process.argv.slice(2),
        arguments: args,
        meta: meta ?? null,
        cwd: process.cwd(),
        env: { FAKE_TOKEN: process.env.FAKE_TOKEN ?? null, LEAK: process.env.AGENTES_TEST_LEAK ?? null },
      };
      send({ id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(said) }] } });
      return;
    }
    if (name === "read_text") {
      send({ id: msg.id, result: { content: [{ type: "text", text: readFileSync(args.path, "utf8") }] } });
      return;
    }
    send({ id: msg.id, result: { content: [{ type: "text", text: `No tool ${name}` }], isError: true } });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
});
