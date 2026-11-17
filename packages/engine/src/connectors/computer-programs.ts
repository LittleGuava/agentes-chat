import { type AgentScope, MCP_STDIO_LISTING_PROTOCOL, type McpStdioServer } from "@agenteschat/adapters";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { type MachineCaller, MachineRequestError, type MachineStatus } from "../machine-hub";
import { getMachine, MachineOfflineError, MachinePausedError } from "../machines";
import { requirePermission } from "../organizations";
import type { ToolContext } from "../tools/types";
import { connectOnComputer } from "./computer-mcp";
import { type ConnectorDeps, openConnectionSecret } from "./connections";
import { type CustomDeps, type CustomServerView, serverView, storeCustomConnection, syncCustomTools } from "./custom";
import { type McpCallResult, type McpConnect, type McpSession, type McpTool, writtenForms } from "./mcp";
import { PROGRAM_AUTH, programMachineOf, programServerUrl } from "./program-url";

/*
 * A stdio MCP program registered on a person's connected computer as a workspace's connector (ADR 0215, addendum
 * 2026-11-17). Its connection is an ordinary custom server's row: `server_url` names the computer, `auth_type` is
 * `computer`, and the sealed secret holds what starts there. Registering lists its tools once, for no agent; a turn
 * offers what was stored and starts nothing; each call starts it there for the run's agent, under the computer's
 * Commands switch and command policy, behind the Tool Gateway like any connector's tool.
 */

const { connectorConnections, connectorToolPins, customTools, machines } = schema;

/** Why a computer can't run a workspace's program now. */
export type ProgramRefusal =
  | "workspace_computer"
  | "pairer"
  | "system_mode"
  | "commands_off"
  | "offline"
  | "paused"
  | "old_runner";

/**
 * Whether a computer runs a registered program: a person's connected computer, outside system mode (there each agent
 * is its own OS user, which this first slice doesn't cover), with Commands on, online, not paused, and a runner that
 * lists for nobody. `actorId`: who registers it, who must be the person who paired it; a call checks the rest only.
 */
export function programRefusal(m: MachineStatus, actorId?: string): ProgramRefusal | null {
  if ((m.kind ?? "connected") !== "connected") return "workspace_computer";
  if (actorId !== undefined && m.pairedByUserId !== actorId) return "pairer";
  if (m.mode === "system") return "system_mode";
  if (!m.execAllowed || m.access?.tools.commands !== true) return "commands_off";
  if (!m.online) return "offline";
  if (m.paused) return "paused";
  if (m.protocol < MCP_STDIO_LISTING_PROTOCOL) return "old_runner";
  return null;
}

/** The refusal in words the agent, or a person, can act on. */
export function programRefusalText(refusal: ProgramRefusal, name: string): string {
  switch (refusal) {
    case "workspace_computer":
      return `${name} is the workspace's own computer: a program runs only on a computer a person connected.`;
    case "pairer":
      return `Only the person who connected ${name} can add a program on it.`;
    case "system_mode":
      return `${name} runs each agent as its own user, where programs aren't available yet.`;
    case "commands_off":
      return `Commands are off on ${name}, so its programs can't run. Its owner turns them on in the agentes app.`;
    case "offline":
      return `The computer ${name} is offline, so its programs can't run. Ask its owner to start the runner.`;
    case "paused":
      return `The computer ${name} is paused, so its programs can't run until its owner resumes it.`;
    case "old_runner":
      return `The runner on ${name} is too old to run programs. Its owner updates the agentes app there, or runs \`agentes-runner update\`.`;
  }
}

/** What a person types for a program: the command, its words, and variables by name. */
export interface ProgramInput {
  machineId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  label?: string;
}

const LIMITS = { command: 1000, args: 100, arg: 4000, env: 50, value: 8000 };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUL = String.fromCharCode(0);
/**
 * Variables that make a program load code its command line doesn't show: the command policy judges that line, so
 * these would hide what runs from it.
 */
const LOADERS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "BASH_ENV",
  "ENV",
  "PATH",
  "JAVA_TOOL_OPTIONS",
]);

/** The program as it starts, checked once here: what comes in is a person's typing. */
export function checkProgram(input: Pick<ProgramInput, "command" | "args" | "env">): McpStdioServer {
  const invalid = (why: string) => new ValidationError(why, "connector.program_invalid", { detail: why });
  const command = input.command.trim();
  if (!command) throw invalid("The program's command is empty");
  if (command.length > LIMITS.command) throw invalid("The program's command is too long");
  const args = input.args ?? [];
  if (args.length > LIMITS.args || args.some((a) => a.length > LIMITS.arg))
    throw invalid("Too many or too long arguments");
  const env: Record<string, string> = {};
  // Windows reads a name in any case: two names apart only by their case are one variable there.
  const seen = new Set<string>();
  for (const { name, value } of input.env ?? []) {
    if (!ENV_NAME.test(name)) throw invalid(`${name} isn't a variable name`);
    if (seen.has(name.toUpperCase())) throw invalid(`${name} is there twice`);
    seen.add(name.toUpperCase());
    if (LOADERS.has(name.toUpperCase()) || name.toUpperCase().startsWith("DYLD_")) {
      throw invalid(`${name} would load code the command doesn't show`);
    }
    if (value.length > LIMITS.value) throw invalid(`${name} is too long`);
    env[name] = value;
  }
  if (Object.keys(env).length > LIMITS.env) throw invalid("Too many variables");
  if ([command, ...args, ...Object.values(env)].some((w) => w.includes(NUL))) throw invalid("A word holds a NUL");
  return { command, args, env };
}

/** The person's own connected computers, and whether each can take a program now (managers of connectors only). */
export async function programComputers(
  deps: Pick<ConnectorDeps, "db" | "machines">,
  actorId: string,
  orgId: string,
): Promise<{ id: string; name: string; available: boolean }[]> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const hub = deps.machines;
  if (!hub) return [];
  const rows = await deps.db
    .select({ id: machines.id, name: machines.name })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.pairedByUserId, actorId),
        eq(machines.kind, "connected"),
        isNull(machines.deletedAt),
      ),
    )
    .orderBy(asc(machines.name));
  const out: { id: string; name: string; available: boolean }[] = [];
  for (const row of rows) {
    const status = await hub.status(row.id);
    out.push({ ...row, available: status !== null && programRefusal(status, actorId) === null });
  }
  return out;
}

/** The computer as the hub sees it, or its refusal in words; `actorId` when a person registers. */
async function eligible(
  hub: MachineCaller,
  machineId: string,
  actorId?: string,
): Promise<{ refused: string } | { status: MachineStatus }> {
  const status = await hub.status(machineId);
  if (!status) return { refused: "The computer this program ran on was removed." };
  const refusal = programRefusal(status, actorId);
  return refusal ? { refused: programRefusalText(refusal, status.name) } : { status };
}

/** What a computer's refusal or failure said, for a person or the agent; null for anything else (a bug). */
/**
 * The program's session with its variables' values out of all it says: a call's answer, its tools' descriptions and a
 * failure's words (a refusal quoting its token), in every form a value is written. They are secrets the person typed
 * once: the runner redacts only the agent's own, so a program that prints one would hand it to the agent and the
 * stored tools.
 */
async function programSession(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope | null,
  program: McpStdioServer,
): Promise<McpSession> {
  const values = Object.entries(program.env ?? {}).flatMap(([name, value]) =>
    writtenForms(value).map((form) => ({ name, value: form })),
  );
  const clean = (text: string) => redactSecrets(text, values);
  const masked = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Error) {
        for (const part of ["message", "stack"] as const) {
          const text = error[part] ?? "";
          const safe = clean(text);
          if (safe !== text) error[part] = safe;
        }
      }
      throw error;
    }
  };
  const session = await masked(() => connectOnComputer(hub, machineId, agent, program));
  return {
    ...session,
    listTools: async () =>
      (await masked(() => session.listTools())).map((tool) =>
        tool.description === undefined ? tool : { ...tool, description: clean(tool.description) },
      ),
    callTool: async (...call) => {
      const result = await masked(() => session.callTool(...call));
      return { ...result, content: clean(result.content) };
    },
  };
}

function computerWords(error: unknown): string | null {
  if (
    error instanceof MachineRequestError ||
    error instanceof MachineOfflineError ||
    error instanceof MachinePausedError
  ) {
    return error.message;
  }
  return null;
}

/**
 * Registers a program on a computer the person paired (`manage_connectors`): checked, listed there once for no agent
 * (so a program that the computer holds or can't start is never stored), then stored as a custom server whose tools
 * wait for a level, given to no agent yet.
 */
export async function connectComputerProgram(
  deps: CustomDeps,
  actorId: string,
  orgId: string,
  input: ProgramInput,
): Promise<CustomServerView> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const program = checkProgram(input);
  const machine = await getMachine(deps.db, orgId, input.machineId);
  if (!machine || !deps.machines) throw new NotFoundError("Computer not found", "machine.not_found");
  const hub = deps.machines;
  const found = await eligible(hub, machine.id, actorId);
  if ("refused" in found) {
    throw new ConflictError(found.refused, "connector.program_computer", { computer: machine.name });
  }
  let listed: McpTool[];
  let info: ReturnType<NonNullable<McpSession["serverInfo"]>> = null;
  try {
    const session = await programSession(hub, machine.id, null, program);
    listed = await session.listTools();
    info = session.serverInfo?.() ?? null;
  } catch (error) {
    const said = computerWords(error);
    if (said === null) throw error;
    throw new ValidationError(`The program didn't start on ${machine.name}: ${said}`, "connector.program_failed", {
      computer: machine.name,
      detail: said,
    });
  }
  const label = input.label?.trim() || info?.title || info?.name || program.command;
  const { connection } = await storeCustomConnection(deps, {
    orgId,
    actorId,
    serverUrl: programServerUrl(machine.id),
    label,
    authType: PROGRAM_AUTH,
    secret: { program },
    grantEveryone: false,
  });
  // The tools it just listed: the program isn't started a second time.
  const once: McpSession = {
    listTools: async () => listed,
    callTool: async () => ({ content: "", isError: true }),
    serverInfo: () => info,
    close: async () => {},
  };
  await syncCustomTools({ ...deps, connect: async () => once }, connection).catch(() => {});
  return serverView(deps.db, orgId, connection.id);
}

/**
 * Opens a registered program's listing (Atualizar, a changed tool) on its computer for no agent; any other address
 * goes to `connect`. The computer must still take programs; who asks is the manager's route's to check.
 */
export function withComputerPrograms(
  connect: McpConnect,
  deps: Pick<ConnectorDeps, "db" | "keyWrappers" | "machines">,
): McpConnect {
  return async (connection, headers) => {
    const machineId = programMachineOf(connection.serverUrl);
    if (!machineId) return connect(connection, headers);
    const row = await storedProgram(deps.db, connection.orgId, connection.serverUrl);
    const program = row ? (await openConnectionSecret(deps.keyWrappers, row))?.program : undefined;
    if (!program || !deps.machines) throw new Error("This program isn't registered on a computer here.");
    const found = await eligible(deps.machines, machineId);
    if ("refused" in found) throw new Error(found.refused);
    return programSession(deps.machines, machineId, null, program);
  };
}

async function storedProgram(db: Database, orgId: string | undefined, serverUrl: string) {
  if (!orgId) return null;
  const [row] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        eq(connectorConnections.serverUrl, serverUrl),
        isNull(connectorConnections.revokedAt),
      ),
    );
  return row ?? null;
}

/** A program's tools as its last listing stored them: offered to a turn without starting it. */
export async function storedProgramTools(db: Database, connection: { id: string; orgId: string }): Promise<McpTool[]> {
  const pins = await db
    .select()
    .from(connectorToolPins)
    .where(and(eq(connectorToolPins.orgId, connection.orgId), eq(connectorToolPins.connectionId, connection.id)));
  const hints = await db
    .select({
      name: customTools.name,
      readOnlyHint: customTools.readOnlyHint,
      destructiveHint: customTools.destructiveHint,
    })
    .from(customTools)
    .where(and(eq(customTools.connectionId, connection.id), isNull(customTools.removedAt)));
  const byName = new Map(hints.map((h) => [h.name, h]));
  return pins.flatMap((p) => {
    const hint = byName.get(p.toolName);
    if (!hint) return [];
    return [
      {
        name: p.toolName,
        description: p.description,
        inputSchema: p.inputSchema,
        readOnlyHint: hint.readOnlyHint,
        destructiveHint: hint.destructiveHint,
      },
    ];
  });
}

/**
 * One call of a program's tool, on its computer, as the run's agent. A computer that is offline, paused, removed or
 * no longer takes programs, and whatever the computer refused, is the tool's answer: the agent hears why and the run
 * goes on.
 */
export async function callProgramTool(
  deps: Pick<ConnectorDeps, "keyWrappers" | "machines">,
  connection: Parameters<typeof openConnectionSecret>[1],
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId">,
  name: string,
  input: Record<string, unknown>,
): Promise<McpCallResult> {
  const machineId = programMachineOf(connection.serverUrl);
  const refused = (content: string): McpCallResult => ({ content, isError: true });
  if (!machineId || !deps.machines) return refused("Programs on computers aren't available on this server.");
  const found = await eligible(deps.machines, machineId);
  if ("refused" in found) return refused(found.refused);
  const program = (await openConnectionSecret(deps.keyWrappers, connection).catch(() => null))?.program;
  if (!program) return refused("This program's settings can't be read. Its owner registers it again.");
  const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
  const scope: AgentScope = {
    id: ctx.agentId,
    handle: agent?.handle ?? "agent",
    ...(agent?.name ? { name: agent.name } : {}),
  };
  try {
    const session = await programSession(deps.machines, machineId, scope, program);
    return await session.callTool(name, input);
  } catch (error) {
    const said = computerWords(error);
    if (said === null) throw error;
    return refused(said);
  }
}
