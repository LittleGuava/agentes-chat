import { afterEach, expect, test } from "bun:test";
import {
  type MachineReplies,
  type MachineRequest,
  MCP_STDIO_LISTING_PROTOCOL,
  type McpStdioCall,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  acceptCustomSuggestion,
  type CustomDeps,
  connectComputerProgram,
  createConnectorToolSource,
  createToolGateway,
  listCustomServers,
  type MachineCaller,
  MachineOfflineError,
  MachineRequestError,
  type MachineStatus,
  postPersonMessage,
  programComputers,
  refreshCustomServer,
  removeMachine,
  withComputerPrograms,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/*
 * ADR 0215, addendum 2026-11-17: a stdio program on a person's connected computer registered as a workspace's
 * connector. The computer here is a fake hub that answers `mcp.stdio` as the program would (the runner and a real
 * stdio program behind it are `apps/server/test/computer-mcp.test.ts`'s).
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PROGRAM = {
  command: "npx",
  args: ["-y", "@acme/notes-mcp"],
  env: [{ name: "NOTES_TOKEN", value: "nt_very_secret_1" }],
};

/** A computer someone paired, with the program's two tools; `state` changes what the hub says of it. */
async function computer(fx: Fixture, overrides: Partial<typeof schema.machines.$inferInsert> = {}) {
  const [row] = await fx.db
    .insert(schema.machines)
    .values({
      orgId: fx.org.id,
      name: "Fabio's laptop",
      kind: "connected",
      pairedByUserId: fx.owner.id,
      protocol: MCP_STDIO_LISTING_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      access: { folders: [], tools: { claude: false, codex: false, commands: true } },
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("no machine");
  const sent: Extract<MachineRequest, { op: "mcp.stdio" }>[] = [];
  // `leaky`: a program that says its own variables back, in a tool's description and in what a call answers.
  const state = { online: true, refuse: null as MachineRequestError | null, leaky: false };
  const answer = (call: McpStdioCall, env: Record<string, string>): MachineReplies["mcp.stdio"] => {
    const said = state.leaky ? ` ${JSON.stringify(env)} ${Object.values(env).join(" ")}` : "";
    if (call.method === "tools/list") {
      return {
        serverInfo: { name: "notes", version: "1" },
        tools: [
          {
            name: "list_notes",
            description: `List the notes${said}`,
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
          {
            name: "add_note",
            description: "Add a note",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      };
    }
    return {
      serverInfo: { name: "notes", version: "1" },
      result: { content: [{ type: "text", text: `${call.name} ${JSON.stringify(call.arguments)}${said}` }] },
    };
  };
  const hub: MachineCaller = {
    async call(machineId, request) {
      if (machineId !== row.id || request.op !== "mcp.stdio") throw new Error("unexpected request");
      if (!state.online) throw new MachineOfflineError(row.name, row.kind);
      sent.push(request as Extract<MachineRequest, { op: "mcp.stdio" }>);
      if (state.refuse) throw state.refuse;
      const stdio = request as Extract<MachineRequest, { op: "mcp.stdio" }>;
      return answer(stdio.call, stdio.server.env ?? {}) as never;
    },
    async status(machineId) {
      const [m] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
      if (!m || m.deletedAt) return null;
      return {
        id: m.id,
        orgId: m.orgId,
        name: m.name,
        kind: m.kind,
        pairedByUserId: m.pairedByUserId,
        online: state.online && m.online,
        execAllowed: m.execAllowed,
        os: m.os,
        protocol: m.protocol,
        executors: m.executors ?? {},
        access: m.access ?? null,
        ...(m.executors?.mode === "system" ? { mode: "system" as const } : {}),
      } satisfies MachineStatus;
    },
  };
  return { row, hub, sent, state };
}

function depsOf(fx: Fixture, hub: MachineCaller): CustomDeps {
  const base = { db: fx.db, keyWrappers: [fx.keyWrapper], publicUrl: "https://chat.example.com", machines: hub };
  return { ...base, connect: withComputerPrograms(async () => Promise.reject(new Error("no http here")), base) };
}

async function runOf(fx: Fixture) {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

/** One call through the gateway, as a run makes it: what the agent reads back. */
async function call(
  gateway: ReturnType<typeof createToolGateway>,
  ctx: Awaited<ReturnType<typeof runOf>>,
  name: string,
) {
  const out = await gateway.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input: {} });
  if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
  return out.output as { content: string; isError?: boolean };
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

test("the pairer registers a program: listed with no agent, its variables sealed, its tools waiting for a level", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  expect(await programComputers(deps, f.owner.id, f.org.id)).toEqual([
    { id: pc.row.id, name: "Fabio's laptop", available: true },
  ]);
  const server = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM });
  expect(server).toMatchObject({
    label: "notes",
    authType: "computer",
    program: { machineId: pc.row.id },
    headerNames: ["NOTES_TOKEN"],
  });
  expect(server.tools.map((t) => [t.name, t.access])).toEqual([
    ["add_note", null],
    ["list_notes", null],
  ]);
  // One start on the computer, for nobody, with the program word for word and its variable's value.
  expect(pc.sent.map((r) => [r.agent ?? null, r.call.method, r.server])).toEqual([
    [null, "tools/list", { command: "npx", args: ["-y", "@acme/notes-mcp"], env: { NOTES_TOKEN: "nt_very_secret_1" } }],
  ]);
  // The value is in no column, and no answer gives it back.
  expect(JSON.stringify(await f.db.select().from(schema.connectorConnections))).not.toContain("nt_very_secret_1");
  expect(JSON.stringify(await listCustomServers(f.db, f.owner.id, f.org.id))).not.toContain("nt_very_secret_1");
  // A program on a person's computer starts with no agent: each one is given it.
  const grants = (await f.db.select().from(schema.agentScopes)).filter((g) => g.connectionId === server.id);
  expect(grants).toEqual([]);
});

test("only the pairer, managing connectors, on a computer of theirs outside system mode with Commands on", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  const register = (actor: string, machineId = pc.row.id) =>
    codeOf(connectComputerProgram(deps, actor, f.org.id, { machineId, ...PROGRAM }));
  const admin = await addMember(f.db, f.org.id, "admin", "Ana");
  expect(await register(admin.id)).toBe("connector.program_computer");
  const member = await addMember(f.db, f.org.id, "member", "Bia");
  const own = await computer(f, { pairedByUserId: member.id, name: "Bia's PC" });
  // A member who can't manage connectors, even on a computer they paired.
  expect(await register(member.id, own.row.id)).toBe("forbidden");
  const system = await computer(f, { name: "Server", executors: { mode: "system" } });
  expect(
    await codeOf(
      connectComputerProgram(depsOf(f, system.hub), f.owner.id, f.org.id, { machineId: system.row.id, ...PROGRAM }),
    ),
  ).toBe("connector.program_computer");
  const off = await computer(f, {
    name: "Off",
    access: { folders: [], tools: { claude: false, codex: false, commands: false } },
  });
  expect(
    await codeOf(
      connectComputerProgram(depsOf(f, off.hub), f.owner.id, f.org.id, { machineId: off.row.id, ...PROGRAM }),
    ),
  ).toBe("connector.program_computer");
  const old = await computer(f, { name: "Old", protocol: MCP_STDIO_LISTING_PROTOCOL - 1 });
  expect(
    await codeOf(
      connectComputerProgram(depsOf(f, old.hub), f.owner.id, f.org.id, { machineId: old.row.id, ...PROGRAM }),
    ),
  ).toBe("connector.program_computer");
  const managed = await computer(f, { name: "Workspace", kind: "managed", pairedByUserId: null });
  expect(
    await codeOf(
      connectComputerProgram(depsOf(f, managed.hub), f.owner.id, f.org.id, { machineId: managed.row.id, ...PROGRAM }),
    ),
  ).toBe("connector.program_computer");
  // None of them started anything.
  for (const c of [pc, own, system, off, old, managed]) expect(c.sent).toEqual([]);
  // The list says which of the person's own computers can take one, by name; nobody else's, nor the workspace's.
  expect(await programComputers(deps, f.owner.id, f.org.id)).toEqual([
    { id: pc.row.id, name: "Fabio's laptop", available: true },
    { id: off.row.id, name: "Off", available: false },
    { id: old.row.id, name: "Old", available: false },
    { id: system.row.id, name: "Server", available: false },
  ]);
});

test("a malformed program, or one with a variable that loads code the command doesn't show, is refused", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  const register = (program: Partial<typeof PROGRAM>) =>
    codeOf(connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM, ...program }));
  expect(await register({ command: " " })).toBe("connector.program_invalid");
  expect(await register({ env: [{ name: "BAD-NAME", value: "x" }] })).toBe("connector.program_invalid");
  expect(await register({ env: [{ name: "NODE_OPTIONS", value: "--require /tmp/x.js" }] })).toBe(
    "connector.program_invalid",
  );
  expect(await register({ env: [{ name: "LD_PRELOAD", value: "/tmp/x.so" }] })).toBe("connector.program_invalid");
  expect(
    await register({
      env: [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
    }),
  ).toBe("connector.program_invalid");
  // Windows reads a variable's name in any case: `Path` is PATH, `Token` and `TOKEN` are one variable.
  expect(await register({ env: [{ name: "Path", value: "C:\\tools" }] })).toBe("connector.program_invalid");
  expect(
    await register({
      env: [
        { name: "Token", value: "1" },
        { name: "TOKEN", value: "2" },
      ],
    }),
  ).toBe("connector.program_invalid");
  expect(pc.sent).toEqual([]);
});

test("a program the computer holds or can't start is not registered, and says why", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  pc.state.refuse = new MachineRequestError("approval_needed", "A person approves this command on the computer");
  const failed = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM }).catch(
    (e: { code: string; params?: Record<string, unknown> }) => e,
  );
  expect(failed).toMatchObject({
    code: "connector.program_failed",
    params: { computer: "Fabio's laptop", detail: "A person approves this command on the computer" },
  });
  expect(await f.db.select().from(schema.connectorConnections)).toEqual([]);
});

test("an agent given it calls its tools on the computer, as itself, through the Tool Gateway", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  const server = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM });
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, server.id);
  const source = createConnectorToolSource(deps);
  const gateway = createToolGateway({ sources: [source] });
  const ctx = await runOf(f);
  // Not given to the agent yet: its tools aren't offered.
  expect(await gateway.list(ctx)).toEqual([]);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: server.id,
    scope: "connector:*",
    grantedByUserId: f.owner.id,
  });
  pc.sent.length = 0;
  const listed = await gateway.list(ctx);
  expect(listed.map((t) => t.name).sort()).toEqual(["notes_add_note", "notes_list_notes"]);
  // Offered from what was stored: a turn starts no program.
  expect(pc.sent).toEqual([]);
  const result = await call(gateway, ctx, "notes_list_notes");
  expect(result.isError).not.toBe(true);
  expect(result.content).toContain("list_notes {}");
  expect(pc.sent.map((r) => [r.agent?.id, r.agent?.handle, r.call.method])).toEqual([
    [f.agent.id, f.agent.handle, "tools/call"],
  ]);
  expect(pc.sent[0]?.server.env).toEqual({ NOTES_TOKEN: "nt_very_secret_1" });
});

test("a program that says its variable back hands it to nobody: not in a tool, an answer or a failure", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  // A quote, a backslash and a slash: JSON writes each its own way.
  const value = 'nt_"very"\\secret/1';
  const program = { ...PROGRAM, env: [{ name: "NOTES_TOKEN", value }] };
  const forms = [value, JSON.stringify(value).slice(1, -1)];
  const leaks = (text: string) => forms.some((form) => text.includes(form));
  pc.state.leaky = true;
  const server = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...program });
  expect(pc.sent[0]?.server.env).toEqual({ NOTES_TOKEN: value });
  expect(leaks(JSON.stringify(server))).toBe(false);
  expect(server.tools.find((t) => t.name === "list_notes")?.description).toContain("[secret:NOTES_TOKEN]");
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, server.id);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: server.id,
    scope: "connector:*",
    grantedByUserId: f.owner.id,
  });
  const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
  const ctx = await runOf(f);
  expect(leaks(JSON.stringify(await gateway.list(ctx)))).toBe(false);
  const answered = await call(gateway, ctx, "notes_list_notes");
  expect(answered.content).toContain("[secret:NOTES_TOKEN]");
  expect(leaks(answered.content)).toBe(false);
  // "Atualizar" lists it again: what it stores is cleaned the same way.
  const refreshed = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
  expect(leaks(JSON.stringify(refreshed))).toBe(false);
  // The program refuses, quoting its token: the agent hears the refusal without it.
  pc.state.refuse = new MachineRequestError("bad_request", `The MCP program refused the request: bad token ${value}`);
  const refused = await call(gateway, ctx, "notes_list_notes");
  expect(refused.isError).toBe(true);
  expect(refused.content).toContain("bad token [secret:NOTES_TOKEN]");
  expect(leaks(refused.content)).toBe(false);
});

test("the computer offline or no longer eligible: the tool says so clearly, the run goes on", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  const server = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM });
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, server.id);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: server.id,
    scope: "connector:*",
    grantedByUserId: f.owner.id,
  });
  const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
  const ctx = await runOf(f);
  pc.state.online = false;
  // Still offered: the agent hears why it can't run now, rather than finding it gone.
  expect((await gateway.list(ctx)).map((t) => t.name)).toContain("notes_list_notes");
  const offline = await call(gateway, ctx, "notes_list_notes");
  expect(offline.isError).toBe(true);
  expect(offline.content).toContain("Fabio's laptop is offline");
  pc.state.online = true;
  await f.db
    .update(schema.machines)
    .set({ access: { folders: [], tools: { claude: false, codex: false, commands: false } } })
    .where(eq(schema.machines.id, pc.row.id));
  const commandsOff = await call(gateway, ctx, "notes_list_notes");
  expect(commandsOff.isError).toBe(true);
  expect(commandsOff.content).toContain("Commands are off on Fabio's laptop");
  expect(pc.sent.filter((r) => r.call.method === "tools/call")).toEqual([]);
});

test("removing the computer disconnects its programs: grants go, tools go, and Atualizar can't reach it", async () => {
  f = await setup();
  const pc = await computer(f);
  const deps = depsOf(f, pc.hub);
  const server = await connectComputerProgram(deps, f.owner.id, f.org.id, { machineId: pc.row.id, ...PROGRAM });
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, server.id);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: server.id,
    scope: "connector:*",
    grantedByUserId: f.owner.id,
  });
  const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
  const ctx = await runOf(f);
  expect((await gateway.list(ctx)).length).toBe(2);
  await removeMachine({ db: f.db }, pc.row, { type: "person", id: f.owner.id });
  expect(await gateway.list(ctx)).toEqual([]);
  expect((await f.db.select().from(schema.agentScopes)).filter((g) => g.connectionId === server.id)).toEqual([]);
  const [row] = await f.db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.id, server.id));
  expect(row?.revokedAt).not.toBeNull();
  expect(await listCustomServers(f.db, f.owner.id, f.org.id)).toEqual([]);
  expect(await codeOf(refreshCustomServer(deps, f.owner.id, f.org.id, server.id))).toBe("not_found");
});
