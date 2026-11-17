# 0215. A local MCP program on a connected computer

- Status: Proposed (built: the runner's op, the engine's session over it, and registering a program on a person's
  computer, addendum 2026-11-17)
- Date: 2026-11-15
- Extends: ADR 0025 (connected computers), ADR 0053 §3 (the command policy on a computer)
- Code: protocol `MCP_STDIO_PROTOCOL` and the `mcp.stdio` op in `packages/adapters/src/machine-protocol.ts`; runner
  `apps/server/runner/mcp-stdio.ts` (`runStdioMcp`, `argvLine`), `handlers.ts` (`doMcpStdio`); engine
  `packages/engine/src/connectors/computer-mcp.ts` (`connectOnComputer`), `machine-hub.ts` (`requestTimeoutMs`); tests
  `apps/server/test/runner/mcp-stdio.test.ts` (a fake stdio server, `fake-stdio-mcp.mjs`),
  `apps/server/test/computer-mcp.test.ts` (the engine's session against the runner's handler)

## Context

Many MCP servers ship as a program that speaks MCP over its standard input and output (`npx -y <package>`,
`uvx <package>`), meant to run beside the files, tools and sign-ins it works with. A workspace's custom connectors
reach MCP servers over Streamable HTTP at a public HTTPS address. A separate proposal runs a stdio program on the
server's own machine, turned on by the operator; it leaves a connected computer out on purpose, since running a
program there needs its own protocol and permission design. This ADR is that design.

A connected computer already runs the agent's commands (`exec`), as the agent's own OS user in system mode, each one
first checked by the command policy (ADR 0053 §3). A stdio MCP program is one more command the agent's work starts:
it should run under the same rules, never as the runner's own user or as root.

## Decision

1. **One op per MCP operation.** `mcp.stdio` (from `MCP_STDIO_PROTOCOL` = 69) carries the program (`command`, `args`,
   explicit `env`, optional `cwd` in the agent's folder) and one call: `tools/list` or `tools/call`. The runner starts
   the program, speaks the MCP handshake (`initialize`, `notifications/initialized`), makes the call (every page of a
   listing, at most 20), and stops the program and everything it started before answering. Nothing stays running
   between calls: no session to leak, no process a hold must account for, the same lifecycle the server-side stdio
   proposal gives its own sessions. A program that is slow to start pays for it on every call; a long-lived session
   is Later.
2. **As the agent, under the command policy.** `OP_ROUTES` sends it to the agent's worker in system mode, so the
   program runs as the agent's own OS user; elsewhere it runs as the runner's user, like `exec`. It needs the
   computer's "commands" switch (`requireTool`). Before starting, the argument vector is written as one POSIX command
   line, each word quoted when it holds anything but plain characters (`argvLine`), and that line meets
   `commandApproval` the way `exec` does: `never` is `not_allowed`, a hold is `approval_needed` (nothing ran). The line
   judged is exactly the argv started: the program starts with that argv and no shell, so an argument holding `;` or
   `$(…)` is one literal word in both. The policy reads a quoted word that names a held command (a deploy written in
   an argument) as that command, so a harmless program can be held, never let through. A person's approval of a held
   program is Later; until then a held one doesn't run, and the agent reads that it can't be approved from there
   (`ASK_ABOUT_MCP`), not to make the call again.
3. **Its environment is explicit.** The program gets a short allow-list of the runner's environment (where programs
   and the home are, the locale, temp folders; on Windows the system folders; the computer's proxies and trusted
   certificates, `NETWORK_ENV`; the agent's own containers socket, `CONTAINER_HOST`/`DOCKER_HOST`, as its commands get
   it) plus the `env` the request names. Not the agent's secrets, not the runner's token or anything else in its
   environment. The policy judges the argv, not the `env` (`PATH`, `NODE_OPTIONS` change what runs): the `env` comes
   from whoever registers the connector, never from the agent. Its standard error is read and dropped, never logged
   or sent.
4. **What leaves the computer is bounded and redacted.** One message from the program is at most 8 MiB; the whole call
   has a deadline (`timeoutSeconds`, 1 to 300, default 60) after which the program and its children are killed and the
   op fails `timed_out`; the hub waits that deadline plus 30 s (`requestTimeoutMs`), so the computer's own answer is
   the one heard. The agent's secret values are redacted in every string of the answer, as from a command's output
   (each string, not the reply's JSON, where a value with quotes or a newline is written escaped). A request
   the program makes of the client (`roots/list`, `sampling/createMessage`, an elicitation) is refused with JSON-RPC
   `-32601`, `ping` alone answered: the computer asks nobody and samples no model.
5. **The engine sees an ordinary MCP session.** `connectOnComputer(hub, machineId, agent, server)` returns the same
   `McpSession` the HTTP transport returns, its tools and results read by the same functions (`mcpToolOf`,
   `mcpCallResultOf` in `connectors/mcp.ts`), so the connector tool source, scopes, approvals, the audit log
   and the Tool Gateway apply unchanged: the gateway stays the boundary. An older runner is refused with the same
   update words as other ops.

## Later

- **Registering one** (depends on the server-side stdio proposal's form and its encrypted program settings): a
  connector bound to one connected computer (`machine_id` beside the encrypted command), with `McpConnect` resolving it
  through `connectOnComputer`. Registering needs `manage_connectors` and also `requireComputerDriver` on that computer
  (`machines.ts`): running a program on someone's computer is that computer's owner's decision, not only the workspace
  administrators'. The listing at registration runs as the agent the connector is first granted to, never as the
  runner's own user or root.
- **Which agent.** A connector call carries no agent today (`McpConnect(connection, headers)`); the calling agent's
  scope has to reach the computer connector's session so each call runs as the agent that made it.
- An approval card for a held program, the way `exec` takes `approved`.
- A long-lived session per agent and program, with tool list changes, if starting per call proves too slow.
- Windows `.cmd`/`.bat` launchers (`npx.cmd`) need a shell to start; this slice starts no shell, so on Windows the
  program is named by its `.exe`.

## Addendum (2026-11-17): registering a program on a computer

This settles the first two items of Later. A person registers a stdio MCP program on a computer they connected, from
the usual connect flow, and agents use its tools like any other connector's.

Code: `packages/engine/src/connectors/computer-programs.ts` (`programRefusal`, `checkProgram`, `programComputers`,
`connectComputerProgram`, `withComputerPrograms`, `storedProgramTools`, `callProgramTool`), `program-url.ts`;
`dropComputerPrograms` in `connections.ts`, called by `detachMachine` (`machines.ts`); routes
`GET …/connectors/program-computers` and `POST …/connectors/custom/program` in
`apps/server/src/routes/app/connectors-custom.ts`; `MCP_STDIO_LISTING_PROTOCOL` (87); client `parseMcpProgram`,
`commandWords`, `commandLine` in `packages/client/src/lib/mcp-paste.ts`; web `apps/web/src/components/ConnectProgram.tsx`
and the way to choose in `ConnectFlow.tsx`; tests `packages/engine/test/computer-programs.test.ts`,
`apps/server/test/computer-programs.test.ts` (the real runner handler and the fake stdio program over the hub's
socket), `apps/web/test/connect-program.test.tsx`.

1. **A connection like the others, no new table.** The program is a `connector_connections` row: `server_url` is
   `computer://<machineId>/<id>` (the computer it runs on, and an id of its own so two programs on one computer are
   two connectors), `auth_type` is `computer`, and the sealed secret (ADR 0007, the same envelope as a key or request
   headers) holds `program: { command, args, env }`. `header_names` holds the variables' names, so the row and the
   list show them; their values live only in the secret and never come back to any client. Tools, levels, pins,
   scopes per agent, approvals and the audit log are the custom connector's (`custom_tools`, `connector_tool_pins`),
   unchanged. Changing a program is registering it again: the command and the values aren't shown to edit.
2. **Who and where.** Registering needs `manage_connectors` and is refused unless the computer is one the person
   paired (`kind` connected, `paired_by_user_id`), outside system mode, with Commands on (`execAllowed` and its
   `commands` switch), online, unpaused, and on protocol 87 or later (`programRefusal`, one rule, also read for each
   call). Running a program on a person's computer is that person's decision: an administrator can't register one on
   someone else's. System mode is left out: there every op runs as an agent's own user in its worker, and a program
   registered for no agent would have nowhere to run (Later, with which agent's user lists it).
3. **Listing without an agent.** From protocol 87 `mcp.stdio` takes `tools/list` with no `agent`, outside system mode:
   the runner starts the program in its own workspace, as the computer's user (the user every command of an agent runs
   as there), under the same command policy (`commandApproval`). A `tools/call` still needs its agent. An older runner
   is refused before anything is sent. The listing runs once, at registration and on "Update"; turns read the stored
   tools, so no program starts to plan a turn.
4. **Each call is the calling agent's.** A tool call goes through the Tool Gateway like any connector's, then
   `callProgramTool` asks the computer to run the program as the run's agent (the scope of §5 of the decision), under
   that computer's command policy. A computer that is offline, paused, no longer eligible or gone answers the call
   with a tool error in words (`isError`), never a thrown failure: the run goes on and the agent tells the person.
   The program's own variables are secrets of the connection, not of the agent, so §4's redaction doesn't know them:
   the engine's `programSession` redacts their values from all the program says, a call's answer, its tools'
   descriptions (stored and put in prompts) and a failure's words (a refusal quoting its token), as written and as
   JSON writes them (`writtenForms`, shared with the HTTP connector's masking; `[secret:NAME]`). A value shorter than
   4 characters is not redacted, as for the agent's secrets; a tool's name and input schema, and the program's own
   name and title (`serverInfo`, the label when the person gives none), are kept as the program sent them.
5. **A program starts with no agent.** The connection is stored with no agent's scope (`grantEveryone: false`), its
   tools wait for a level like any server by address, and the end of connecting says so. Code the person may not
   have read doesn't start in every agent's turn by default.
6. **Variables that load other code are refused.** A name must look like an environment variable, once each in any
   case (Windows reads `Token` and `TOKEN` as one), and, in any case too,
   `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`, `PYTHONPATH`,
   `PYTHONHOME`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `BASH_ENV`, `ENV` and
   `JAVA_TOOL_OPTIONS` aren't accepted: the policy judges the argv, and these change what that argv runs.
7. **Removing the computer removes its programs.** `detachMachine` revokes every program connection bound to it, with
   their agent scopes and approval rules, recorded in the audit log as the system's, and the connection caches are
   dropped: no agent keeps a tool that points at a computer that's gone.
8. **The web.** The connect flow of a server by address shows "How it runs" (By address, Program on this computer)
   when the person has a computer that can run one now. A pasted `claude mcp add … -- <command>` or an `mcpServers`
   entry with a `command`, refused before, offers "Use as a program" there, with the command, its name and its
   variables filled in (a placeholder value comes empty, for the person to type). With no such computer the paste is
   refused in words as before. The phone lists a program like any connector, with no Reconnect or other account
   (`accountActions`), and its variables by name where a server by address shows its headers
   (`programVariablesLine`); registering one is on the web.

**Not as a bridge to a service whose calls a person decides.** A service's locks (ADR 0016, addendum 2026-11-17: it
signs in, every call asks, tools are withheld) go by the host of a connection's address, and a program's address is
its computer's. A bridge to such a service (`npx mcp-remote https://mcp.agentcard.sh/mcp`) would list every tool and
call each with no question asked. So a program whose command, arguments or variables hold an address on a locked host
is refused when it is registered (400 `connector.program_service`, the host in `params.service`), and again when it
is listed or called (`programService`, read from its words each time, so a service locked later closes the programs
that reach it). The guard reads an address, nothing else: it doesn't see one a script of the computer's own hides, nor
a program that reaches the same service with no address in its words (a vendor's own stdio server, should one exist).
Those are the computer's owner's own command, as any command there is, and their tools get only the levels a manager
gives them.

**Why it doesn't wait for the server-side stdio proposal.** That proposal runs a stdio program on the server's own
machine, switched on by the operator, with its rows on a `stdio://` address. A program on a person's computer is a
different decision: the person who owns the computer chooses, its command policy judges, nothing new runs on the
server. Neither needs the other's tables or code: this design adds no column and no migration, and its rows are told
apart by their `computer://` scheme and their `auth_type`, so neither's addresses collide with the other's.

**If both land.** They are two ways of the same "connect an MCP server" flow, chosen by where the program runs. The
choice above grows a third option, "On the server", shown only where the operator turned that on, and a pasted command
offers the person's computer first when one can run it, the server's when it can't. Each keeps its own resolver
(`withComputerPrograms` looks only at `computer://`), so one wrapping the other's `McpConnect` changes nothing for
either.
