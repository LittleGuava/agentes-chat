import { type AgentScope, MCP_STDIO_PROTOCOL, type McpStdioCall, type McpStdioServer } from "@agenteschat/adapters";
import type { MachineCaller } from "../machine-hub";
import { runnerUpdateWay } from "../runner-update";
import { type McpSession, mcpCallResultOf, mcpToolOf } from "./mcp";
import type { McpServerInfo } from "./server-icon";

/** How long one operation of the program may take on the computer, start to stop (ADR 0215 §4). */
export const COMPUTER_MCP_TIMEOUT_SECONDS = 60;

type ContentPart = { type: string; text?: string; resource?: { text?: unknown } };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A stdio MCP program on a connected computer as an ordinary `McpSession` (ADR 0215): each operation is one `mcp.stdio`
 * request, run there as `agent` under the computer's command policy, so the connector tool source, scopes, approvals
 * and the audit log apply unchanged behind the Tool Gateway. Nothing stays open between calls: `close` has nothing to
 * stop. A computer whose runner is older than `MCP_STDIO_PROTOCOL` is refused here, before any request.
 */
export async function connectOnComputer(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  server: McpStdioServer,
  timeoutSeconds = COMPUTER_MCP_TIMEOUT_SECONDS,
): Promise<McpSession> {
  const status = await hub.status(machineId);
  if (status && status.protocol < MCP_STDIO_PROTOCOL) {
    throw new Error(
      `The runner on the computer ${status.name} is too old to run MCP programs. ${runnerUpdateWay(status)}`,
    );
  }
  let info: McpServerInfo | null = null;
  const ask = async (call: McpStdioCall) => {
    const reply = await hub.call<"mcp.stdio">(machineId, { agent, op: "mcp.stdio", server, call, timeoutSeconds });
    const said = reply.serverInfo;
    info = said
      ? {
          ...(said.name !== undefined ? { name: said.name } : {}),
          ...(said.title !== undefined ? { title: said.title } : {}),
        }
      : null;
    return reply;
  };
  return {
    async listTools() {
      const { tools } = await ask({ method: "tools/list" });
      return (tools ?? []).map(mcpToolOf);
    },
    async callTool(name, args, meta) {
      const { result } = await ask({ method: "tools/call", name, arguments: args, ...(meta ? { meta } : {}) });
      // What the computer sent is read once, here: only parts with a type reach the shared reading.
      const content = (result?.content ?? []).filter(
        (c): c is ContentPart => isRecord(c) && typeof c.type === "string",
      );
      return mcpCallResultOf({
        content,
        isError: result?.isError === true,
        ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      });
    },
    serverInfo: () => info,
    close: async () => {},
  };
}
