# 0215. A local MCP program on a connected computer

- Status: Proposed (built: the runner's op and the engine's session over it; registering one in a workspace is Later)
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
