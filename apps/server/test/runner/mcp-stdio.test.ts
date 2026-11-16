import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MachineReplies,
  MachineRequest,
  McpStdioCall,
  RunnerAccess,
} from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import { type HandlerContext, handleRequest, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import { argvLine } from "../../runner/mcp-stdio";
import { agentFolderName } from "../../runner/paths";
import { errorCode, removeDirs, tempDir } from "./helpers";

/*
 * ADR 0215: one MCP operation of a stdio program on the computer, for the request's agent. The program here is a real
 * child process (`fake-stdio-mcp.mjs`), started the way a workspace's `npx …` would be.
 */

const dirs: string[] = [];
afterEach(() => {
  delete process.env.AGENTES_TEST_LEAK;
  removeDirs(dirs);
});

const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001", handle: "dev", name: "Dev" };
const FAKE = path.join(import.meta.dir, "fake-stdio-mcp.mjs");
const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });

function computer(tools: Partial<RunnerAccess["tools"]> = {}) {
  const home = tempDir("mcp-home-");
  const secrets = tempDir("mcp-secrets-");
  dirs.push(home, secrets);
  const folder = path.join(home, agentFolderName(AGENT).name);
  mkdirSync(folder, { recursive: true });
  const access: RunnerAccess = { folders: [], tools: { claude: false, codex: false, commands: true, ...tools } };
  const ctx: HandlerContext = {
    workspaceReal: home,
    ownHome: home,
    exec: true,
    token: "agm_x",
    access: () => access,
    secretsDir: path.join(secrets, "secrets"),
  };
  return { ctx, folder };
}

const ask = (
  ctx: HandlerContext,
  call: McpStdioCall,
  server: Partial<Extract<MachineRequest, { op: "mcp.stdio" }>["server"]> = {},
  timeoutSeconds = 20,
) =>
  handleRequest(
    ctx,
    {
      agent: AGENT,
      op: "mcp.stdio",
      server: { command: process.execPath, args: [FAKE], ...server },
      call,
      timeoutSeconds,
    },
    scope(),
  ) as Promise<MachineReplies["mcp.stdio"]>;

const echoOf = (reply: MachineReplies["mcp.stdio"]) => {
  const [first] = reply.result?.content ?? [];
  return JSON.parse((first as { text: string }).text) as {
    argv: string[];
    arguments: Record<string, unknown>;
    meta: Record<string, unknown> | null;
    cwd: string;
    env: { FAKE_TOKEN: string | null; LEAK: string | null };
  };
};

test("system mode runs it in the agent's worker, as the agent's own user, like a command", () => {
  expect(OP_ROUTES["mcp.stdio"]).toBe("agent");
});

test("a listing is every page, and the program's request of the client is refused, not left waiting", async () => {
  const { ctx } = computer();
  const reply = await ask(ctx, { method: "tools/list" });
  expect(reply.serverInfo).toEqual({ name: "fake-stdio", version: "1.0.0" });
  expect(reply.tools?.map((t) => t.name)).toEqual(["echo", "read_text"]);
  expect(reply.tools?.[1]?.annotations).toEqual({ readOnlyHint: true });
});

test("a call gets its argv word for word, the env it was given and none of the runner's, in the agent's folder", async () => {
  const { ctx, folder } = computer();
  process.env.AGENTES_TEST_LEAK = "runner-only";
  const tricky = ["x; echo hi", "$(id)", "a|b", "it's", "two words", ""];
  const reply = await ask(
    ctx,
    { method: "tools/call", name: "echo", arguments: { q: 1 }, meta: { progressToken: "p1" } },
    { args: [FAKE, ...tricky], env: { FAKE_TOKEN: "given" } },
  );
  const said = echoOf(reply);
  expect(said.argv).toEqual(tricky);
  expect(said.arguments).toEqual({ q: 1 });
  expect(said.meta).toEqual({ progressToken: "p1" });
  expect(said.env).toEqual({ FAKE_TOKEN: "given", LEAK: null });
  expect(said.cwd).toBe(folder);
  expect(reply.result?.isError).not.toBe(true);
});

test("the line the command policy judges is the argv that runs", async () => {
  expect(argvLine(["npx", "-y", "@scope/pkg@1.2.0", "--root=/srv/data"])).toBe(
    "npx -y @scope/pkg@1.2.0 --root=/srv/data",
  );
  expect(argvLine(["npx", "x; npx vercel deploy --prod", "it's", ""])).toBe(
    `npx 'x; npx vercel deploy --prod' 'it'\\''s' ''`,
  );
  const { ctx } = computer();
  // A deploy waits for a person, as the same command would through `exec`: nothing starts.
  const deploy = () => ask(ctx, { method: "tools/list" }, { command: "npx", args: ["vercel", "deploy", "--prod"] });
  expect(await errorCode(deploy)).toBe("approval_needed");
  // Nobody can approve it from here yet: the agent isn't told to try again.
  const why = await deploy().catch((err: Error) => err.message);
  expect(why).toContain("can't be approved from here yet");
  expect(why).not.toContain("make the same call again");
  // Quoting hides nothing: the policy reads a quoted word that holds a deploy as the deploy it could be.
  expect(
    await errorCode(() => ask(ctx, { method: "tools/list" }, { args: [FAKE, "x; npx vercel deploy --prod"] })),
  ).toBe("approval_needed");
});

test("the computer's Commands switch off: nothing starts", async () => {
  const { ctx } = computer({ commands: false });
  expect(await errorCode(() => ask(ctx, { method: "tools/list" }))).toBe("exec_disabled");
});

test("a program that never answers is stopped at the deadline, with what it started", async () => {
  const { ctx, folder } = computer();
  const pidFile = path.join(folder, "child.pid");
  const started = Date.now();
  expect(
    await errorCode(() =>
      ask(ctx, { method: "tools/list" }, { env: { FAKE_MCP_MODE: "hang", FAKE_MCP_CHILD_PID: pidFile } }, 1),
    ),
  ).toBe("timed_out");
  expect(Date.now() - started).toBeLessThan(8_000);
  const child = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(child, 0);
      await Bun.sleep(100);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
}, 15_000);

test("a secret of the agent's that the program reads goes back redacted", async () => {
  const { ctx, folder } = computer();
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope());
  const requestId = "req-0215-aaaa";
  const target = { kind: "file" as const, path: ".npmrc" };
  const name = "NPM_TOKEN";
  const { publicKey } = (await call({ agent: AGENT, op: "secret", action: "keypair", requestId })) as {
    publicKey: string;
  };
  const aad = secretAad({ requestId, orgId: "org-1", name, target });
  // Quotes, a backslash and a newline: written escaped in the reply's JSON, found anyway.
  const secret = 'npm"secret\\value\n123';
  const box = await sealSecret(publicKey, secret, aad);
  await call({ agent: AGENT, op: "secret", action: "deliver", requestId, name, target, aad, box });
  await call({
    agent: AGENT,
    op: "secret",
    action: "activate",
    requestId,
    order: `${new Date(1).toISOString()}|${requestId}`,
  });
  writeFileSync(path.join(folder, "note.txt"), `token is ${secret} here`);
  const reply = await ask(ctx, { method: "tools/call", name: "read_text", arguments: { path: "note.txt" } });
  const [first] = reply.result?.content ?? [];
  const text = (first as { text: string }).text;
  expect(text).not.toContain(secret);
  expect(text).toStartWith("token is ");
  expect(text).toEndWith(" here");
});

test("a program that isn't on the computer says so", async () => {
  const { ctx } = computer();
  expect(
    await errorCode(() => ask(ctx, { method: "tools/list" }, { command: "agentes-no-such-mcp-program", args: [] })),
  ).toBe("tool_missing");
});

test("in system mode root starts nothing: the agent's worker gets the request whole", async () => {
  const { ctx } = computer();
  const forwarded: MachineRequest[] = [];
  const root: HandlerContext = {
    ...ctx,
    systemMode: () => true,
    workers: {
      run: async (req) => {
        forwarded.push(req);
        return { serverInfo: null, tools: [] };
      },
    },
  };
  // A program that would fail at once if root started it: only the worker sees it.
  const reply = await ask(root, { method: "tools/list" }, { command: "agentes-no-such-mcp-program" });
  expect(reply).toEqual({ serverInfo: null, tools: [] });
  expect(forwarded.map((r) => [r.op, r.agent?.id])).toEqual([["mcp.stdio", AGENT.id]]);
});

test("a malformed program is refused before anything starts", async () => {
  const { ctx } = computer();
  expect(await errorCode(() => ask(ctx, { method: "tools/list" }, { command: "" }))).toBe("bad_request");
  expect(await errorCode(() => ask(ctx, { method: "tools/list" }, { env: { "BAD-NAME": "x" } }))).toBe("bad_request");
  expect(await errorCode(() => ask(ctx, { method: "tools/list" }, { cwd: "../elsewhere" }))).not.toBe("ok");
});
