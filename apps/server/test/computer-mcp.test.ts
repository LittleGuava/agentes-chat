import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type MachineOp, type MachineRequest, MCP_STDIO_PROTOCOL } from "@agenteschat/adapters";
import {
  connectOnComputer,
  type MachineCaller,
  MachineRequestError,
  type MachineStatus,
  requestTimeoutMs,
} from "@agenteschat/engine";
import { toMachineError } from "../runner/errors";
import { type HandlerContext, handleRequest } from "../runner/handlers";
import { agentFolderName } from "../runner/paths";
import { removeDirs, tempDir } from "./runner/helpers";

/*
 * ADR 0215 end to end: the engine's session over a computer, the runner's handler on the other side, and a real stdio
 * program (`fake-stdio-mcp.mjs`) behind it. The caller stands in for the hub's socket, errors and all.
 */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0002", handle: "ops", name: "Ops" };
const FAKE = path.join(import.meta.dir, "runner", "fake-stdio-mcp.mjs");
const SERVER = { command: process.execPath, args: [FAKE] };

function computerAt(protocol = MCP_STDIO_PROTOCOL) {
  const home = tempDir("computer-mcp-");
  dirs.push(home);
  mkdirSync(path.join(home, agentFolderName(AGENT).name), { recursive: true });
  const ctx: HandlerContext = { workspaceReal: home, ownHome: home, exec: true, token: "agm_x" };
  const sent: MachineRequest[] = [];
  const status = { id: "m1", orgId: "o1", name: "Build box", online: true, execAllowed: true, os: "linux", protocol };
  const hub: MachineCaller = {
    async call(_machineId, request) {
      sent.push(request);
      try {
        return (await handleRequest(ctx, request, { signal: new AbortController().signal, output: () => {} })) as never;
      } catch (err) {
        const { code, message } = toMachineError(err);
        throw new MachineRequestError(code, message);
      }
    },
    status: async () => status as MachineStatus,
  };
  return { hub, sent, ops: () => sent.map((r): MachineOp => r.op) };
}

test("the program's tools and answers reach the engine as any MCP server's do, as the agent", async () => {
  const { hub, sent, ops } = computerAt();
  const session = await connectOnComputer(hub, "m1", AGENT, SERVER);
  const tools = await session.listTools();
  expect(tools.map((t) => [t.name, t.readOnlyHint])).toEqual([
    ["echo", null],
    ["read_text", true],
  ]);
  expect(session.serverInfo?.()).toEqual({ name: "fake-stdio" });
  const result = await session.callTool("echo", { q: "hi" });
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content).arguments).toEqual({ q: "hi" });
  const unknown = await session.callTool("nope", {});
  expect(unknown).toEqual({ content: "No tool nope", isError: true });
  expect(ops()).toEqual(["mcp.stdio", "mcp.stdio", "mcp.stdio"]);
  expect(sent.every((r) => r.agent?.id === AGENT.id)).toBe(true);
  await session.close();
});

test("a held program is the runner's refusal, word for word, and nothing ran", async () => {
  const { hub } = computerAt();
  const session = await connectOnComputer(hub, "m1", AGENT, { command: "npx", args: ["vercel", "deploy", "--prod"] });
  const refused = await session.listTools().catch((err: unknown) => err);
  expect(refused).toBeInstanceOf(MachineRequestError);
  expect((refused as MachineRequestError).code).toBe("approval_needed");
});

test("the hub waits past the program's own deadline and its stop, so the computer's answer is the one heard", () => {
  const request = (timeoutSeconds: number): MachineRequest => ({
    agent: AGENT,
    op: "mcp.stdio",
    server: SERVER,
    call: { method: "tools/list" },
    timeoutSeconds,
  });
  // The runner gives the program at most 300 s, then up to 4 s to stop it and what it started.
  expect(requestTimeoutMs(request(60))).toBeGreaterThan((60 + 4) * 1000);
  expect(requestTimeoutMs(request(300))).toBeGreaterThan((300 + 4) * 1000);
  expect(requestTimeoutMs(request(100_000))).toBe(requestTimeoutMs(request(300)));
});

test("an older runner is told to update before anything is sent", async () => {
  const { hub, sent } = computerAt(MCP_STDIO_PROTOCOL - 1);
  const refused = await connectOnComputer(hub, "m1", AGENT, SERVER).catch((err: Error) => err.message);
  expect(refused).toStartWith("The runner on the computer Build box is too old to run MCP programs.");
  expect(sent).toEqual([]);
});
