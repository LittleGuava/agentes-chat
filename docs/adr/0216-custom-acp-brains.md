# 0216. Custom ACP brains: a computer's owner declares any Agent Client Protocol agent for agents to think with

- Status: Accepted (2026-11-15; built: the runner, the wire protocol, the engine, the server's API and the apps' "Quem pensa", addendum 2026-11-15). Run against a fake ACP agent in the runner's tests (`apps/server/test/runner/fake-acp.mjs`); not yet run against a real one.
- Date: 2026-11-15
- Extends: ADR 0032 (computer brains), ADR 0053 §3 (permission profiles), ADR 0132 (the OpenCode brain, whose ACP client this reuses), ADR 0137 §4 (the right hand's locked turn)

## Context

Every computer brain so far is one CLI we know by name (Claude Code, Codex, Cursor, OpenCode, Grok Build, the Antigravity CLI, the Copilot CLI), each with its own flags, files and events read from its own help and sources. Many other coding agents speak the Agent Client Protocol (agentclientprotocol.com, protocol version 1) over standard input and output: Zed-style agent servers, Mistral's `vibe-acp`, wrappers people write themselves. Since protocol 64 the runner already drives OpenCode over ACP (`acp.ts`, `brain-opencode.ts`), and nothing in that client knows which agent is on the other end.

A computer's owner who has such an agent installed and signed in has no way to let their agents think with it: the list of brains is fixed in code.

## Decision

1. **A ninth computer brain, `acp`** (`BrainKind` `acp`, `BRAIN_NAMES` and `BRAIN_PLAN_NAMES` "ACP agent"), on the same `brain.turn` as Codex, Cursor and OpenCode (`AcpBrain` in `brains/codex.ts`). It is not one CLI but any number the computer declares: the agent names which one with **`agents.brain_engine`** (text, null for every other brain; migration 0309), cleared whenever the agent's brain kind or computer changes, like `brain_account_id`. The model id stays in `brain_model` (ACP agents' ids hold `/` and `:`, so the engine never rides inside it).

2. **Declared on the computer, never from the server.** The runner's `config.json` takes `acpEngines`, written by the computer's owner by hand (the same file as `agentTmpOnDisk`, ADR 0185):

   ```json
   { "acpEngines": [{ "id": "vibe", "name": "Mistral Vibe", "command": "/home/me/.local/bin/vibe-acp", "args": [], "env": { "VIBE_HOME": "/home/me/.vibe" } }] }
   ```

   `id`: `^[a-z0-9][a-z0-9-]{0,31}$`, unique; `name`: up to 60 characters; `command`: the executable (a full path, or a name looked up on the PATH as for every CLI, `cliSpawn`); `args`: up to 32 strings; `env`: up to 32 names and values added to the agent's environment for that process. At most 8 engines (`ACP_ENGINE_LIMITS`). An entry that breaks a rule is left out and the rest load (`parseAcpEngines`). The runner reads them when it starts: a change takes a restart. The server can't add, change or read a command: a command the server could set would be a way to run anything on every computer.

3. **What crosses the wire** (runner protocol 71, `ACP_ENGINE_PROTOCOL`):
   - `hello.executors.acp` (and `executors.changed`): `[{ id, name, models? }]`. Never the command, its arguments or its environment. `models` are `{ id, label? }` (`CursorModelInfo`), at most 60 per engine.
   - `brain.turn` `kind: "acp"` with `engine: <id>`; `model` is any id the engine listed (the runner passes it as is). An `engine` the computer doesn't declare is refused (`acp_engine_missing`).
   - The server keeps the list in `machines.executors.acp`, parsed once where it enters (`parseExecutors`).
   - The app API lists them apart from the CLIs: `GET …/agents/{id}/brain` has an `acp` field (`acpBrainOption`: available or why, and the engines with their models), and `options` keeps the CLIs only. The apps take every kind in `options` for a plan's and read an unknown one as Claude's (`planOfKind`), so an `acp` row there would show a second "own sign-in" under Claude on every app already installed.

4. **Models come from the agent itself.** With each executors look (`cachedExecutors`, every 10 minutes and on "Check again"), the runner opens each engine once with no prompt (`initialize`, then `session/new` in an empty folder of its own, `acpLook`, 20 seconds at most) and reads its models from the answer: `configOptions`' `model` select (`options[].value`, `name`), else the unstable `models.availableModels` (`modelId`, `name`). An engine that doesn't answer is still announced, with no models (its own default model). A model is chosen per turn with `session/set_config_option` (`configId: "model"`) when the session listed that option, else `session/set_model`; one the agent refuses ends the turn with what it said.

5. **A turn** (`brain-acp.ts`, `runAcpTurn`): one process per turn, the engine's command and arguments in the turn's folder, driven through `acp.ts` like OpenCode's: `initialize`, `session/new` with our bridge in `mcpServers` (stdio `agentes-runner mcp --run <run>` or the bridge's URL with the token as a bearer, `opencodeBridge`), the model, then `session/prompt` with the engine's context leading the first message of a session (ACP has no system prompt). Our session → the agent's session lives in `<runner home>/brain/acp-sessions.json`, per engine and folder; a stored one is resumed (`session/resume`, else `session/load` when the agent says it can) and one the agent no longer has starts over with the context. The events are OpenCode's (`OpencodeTurnReader`, which reads only ACP's own updates): `agent_message_chunk` streams the text, a tool call that ended is an executed `tool_call` (our bridge's left out when the agent names it `<server>_<tool>`, `<server>-<tool>` or `mcp__<server>__<tool>`), the prompt's `usage` is the person's (`source: "plan"`). A turn that hears nothing for 5 minutes with no tool running stops and says why. Failures: `acp_failed`, `acp_engine_missing`, `acp_missing` (the command isn't there), `plan_limit` and `not_logged_in` by the agent's words. `acp_failed` is the agent's own failure, as every CLI's (`CLI_CODES` in `runs.ts`), never the computer's; a routine of an agent on one says it thinks there (`routines.ts`), not through the API.

6. **Permissions** (ADR 0053 §3). We know nothing of an unknown agent's tools, so the runner can't keep it to reads, and nothing ensures it asks before acting:
   - `work`: every `session/request_permission` is answered with the agent's own allow option (`allow_once`, else `allow_always`). Refusing would leave it unable to do anything. The boundary is the agent's folder and the computer's user, as for OpenCode (ADR 0132), which has no sandbox either.
   - `plan` is refused, by the engine before the turn and by the runner (`acp_profile`): a read-only turn can't be kept read-only. So is `chat` (the right hand's locked turn, ADR 0137 §4): its tools can't be locked to ours. The right hand is never offered one (`RIGHT_HAND_NO_BRAINS`, as for Copilot), and a save that names it is refused. An agent that always asks (ADR 0173) gets a `plan` turn from every brain but Claude Code, so with this brain it gets a clear refusal instead, never a work turn it didn't ask for.
   - No account (`AccountKind` doesn't change): an ACP agent keeps its own sign-in, made by its owner in a terminal on the computer. A turn with an `account` is refused.
   - Its switch is the computer's commands switch (`access.tools.commands`): declaring an engine is already the owner's choice, and a switch of its own would need one per engine.
   - The engine's environment is the agent's (its secrets included) with the sign-ins of the other brains left out (`withoutSignIns`), then the engine's own `env`: an engine never thinks with a key another brain holds.

7. **Not in system mode yet.** In system mode (ADR 0058 §10) a turn runs in the agent's worker, as the agent's user, which doesn't read root's `config.json`. The runner announces no engines there, so nobody can choose one, and a turn that comes anyway is refused (`acp_engine_missing`).

8. **No live steering**: `brain.steer` answers `unsupported` (ACP has no standard way to take a message mid-turn). Messages wait for the turn's end, as with Cursor.

9. **What this first part leaves for later**:
   - ~~The apps: choosing an engine and its model in "Quem pensa"~~: done, see the addendum below.
   - System mode (§7): root hands the worker the declared engines with each turn.
   - The right hand, `plan` turns and agents that always ask (§6), if an agent's tools can ever be known before its first call (ACP's `session/new` lists none).
   - Re-detect models on demand from the apps (today: the executors look and "Check again").
   - One ACP turn loop shared with OpenCode's: `runOpencodeTurn` stays as it is for now; `runAcpTurn` reuses its reader, bridge and error helpers.

## Consequences

- An owner can bring any ACP agent without a release of ours, and it is never chosen from the server: nothing on the server can make a computer run a new command.
- What such an agent does on the computer is the agent's business: we don't read its help, flags or files. Its `work` turns have the same reach as an OpenCode turn.
- One more column on `agents` (migration 0309).

## Addendum 2026-11-15: the apps

- **Shared rules** in `packages/client/src/lib/acp.ts`: the engines a view offers (`acpEngines`: none unless `acp.available`), the one in use (`acpEngineOf`, one no longer declared kept by its id), the sentence that says what thinks ("Devstral 3 pelo Mistral Vibe", its name alone on its own default) and the model list (`acpModelRows`: the engine's own default first, as "no model saved", then each model it offered; no Automático). `modelRows`/`modelInput` in `brain-picker.ts` hand an `acp` view to them, so the web and the phone read the same list.
- **Not a plan.** `AiChoice` stays the plans and the key, which Connect an AI and onboarding offer; `ThinkChoice` (`AiChoice | "acp"`) is what an agent thinks with (`aiChoiceOf`). An ACP agent is never connected from the apps (it is declared in the runner's `config.json`), so nothing that lists plans to connect sees it.
- **Web** ("Quem pensa", `pages/agent/brain/state.tsx`): each declared engine is a row of kind `engine` under "Agentes ACP" on "Trocar de conta", with the kit's `plug` icon for a mark: an engine may be any maker's agent, and a maker's mark only ever says which provider something is (ADR 0059). Switching saves `{brain: "acp", engine, model: null}`; "Desfazer" puts the engine back. Its model screen lists `acpModelRows`; no effort ramp follows it, "Usar em outros agentes" and "Atende outras pessoas" on a plan are left out (the setup copy has no ACP kind, and there is no plan of ours to share).
- **Phone** (`features/ai/AgentAiScreen.tsx`): an "Agentes ACP" section of rows that save at a tap (`acpRows`, `acpInput`), and the model row opening the same list, without the effort dock.
- **Waiting for its computer**, an agent on `acp` is named "ACP" (`brainName`, the phone's `BRAIN_NAME`: an outage carries no engine's name), and its wait note's switch is the computer's commands (`waitToolOff`).
- **Never Claude.** The agent list's `brain` line carries `engine` (the declared name) and, for a model the engine offered, its label; `brainLine`, the agent page's cell, the phone's profile and the "on someone else's plan" question say the engine's name where a plan's would go, and no maker's mark.
