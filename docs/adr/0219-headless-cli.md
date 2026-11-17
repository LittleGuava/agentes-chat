# 0219. A command line for scripts and CI, on the MCP server

- Status: Proposed
- Date: 2026-11-15
- Extends: ADR 0119 (agentes.chat as a remote MCP server); revisits ADR 0055's "a CLI" left out
- Code: `packages/cli` (`@agenteschat/cli`, the `agentes` command: `src/cli.ts` the commands, `src/client.ts` the
  JSON-RPC calls and how each answer becomes an exit code, `src/args.ts` options and durations, `src/exit.ts` the
  exit codes, `src/index.ts` the process); tests `packages/cli/test/*`, `apps/server/test/cli.test.ts`

## Context

A script, a CI job or another agent wants what a person does in the chat: give an agent a job, wait for it, keep
what it said. ADR 0055 left "a CLI" out because writing to a workspace from it needed a sign-in the app API doesn't
have. ADR 0119 has since given the workspace one: a personal token (`agp_`, Settings → Apps de IA → Tokens pessoais),
for one person in one workspace, on `/mcp` only, with `read`, `write` or `manage` access, an expiry, audited and
revocable. The MCP tools already send a task as the person, wait for its run, and read a conversation, with every
permission the person's own and the waits held by the server. What's missing is the program around them: a shell
can't speak JSON-RPC by hand, and a CI step needs one answer it can parse and an exit code that says how it went.

## Decision

1. **A new package, not a subcommand of the server.** `apps/server/src/main.ts` is the image's entrypoint and runs
   where the database is (`migrate`, `password-link`, `telemetry`); a CI runner has none of that, only an address and
   a token. `packages/cli` (`@agenteschat/cli`, bin `agentes`) is a client with no runtime dependency: global `fetch`
   and Node's own modules, built into one file (`bun run --filter @agenteschat/cli build`, Node 18 or Bun). It imports
   nothing from the server's packages, so it can't drift into calling the engine. AGPL-3.0-only like the rest
   (`packages/setup` stays the one MIT package). It is `private` until a release workflow like `release-setup.yml`
   publishes it.

2. **A thin client of `/mcp`, nothing new on the server.** Each command is one or more `tools/call` requests on
   `PUBLIC_URL/mcp` (stateless, so no `initialize`), with `Authorization: Bearer <token>`. Whatever the token can't do
   the server refuses, exactly as for any MCP client: a `read` token can't send, the person's channel and agent
   checks hold, sends are audited as `apps.message_sent` with the token's name as the app, the limits of ADR 0119 §8
   apply. No route, table, migration or environment variable is added.

3. **Which server, as whom.** `--url URL` or `AGENTES_URL` (the server's address; `/mcp` is added unless given).
   The token comes from `AGENTES_TOKEN` or `--token-file FILE`; there is no `--token` flag, since other programs on
   the computer can read a command line. The token is never printed. Plain `http://` works (a LAN server, ADR 0119
   §11); to a host that isn't this computer it prints a warning that the token travels unencrypted.

4. **Commands.**

   | Command | Tools | What it does |
   |---|---|---|
   | `send AGENT TEXT` | `send_to_agent` (`wait_seconds: 0`) | Sends and returns the `task_id`. `--channel ID` posts in a channel with the agent mentioned, `--thread ID` continues a thread, `--key KEY` makes a retry safe (the same key sends once). |
   | `run AGENT TEXT` | `send` then `wait` | Sends, then waits for the task until `--timeout` (10 minutes). |
   | `wait TASK_ID` | `wait_for_reply` | Waits on a task already sent. |
   | `export TASK_ID` (or `--thread ID`, `--channel ID`) | `read_conversation` | Writes the conversation as JSON or Markdown (`--format md`) to stdout or `--out FILE`. |
   | `events` (`--task ID`, `--thread ID` or `--channel ID`) | `wait_for_reply`, `read_conversation` | New messages, and a task's status changes, as JSON lines; `--until-done` ends with the task. |

   The text is the next word, `--message-file FILE`, or `-` for standard input. Durations are `90`, `90s`, `5m`, `2h`.
   `send` and `run` always send an `idempotency_key` (`--key`, else a random one per invocation), so the client can
   resend after a dropped connection without posting twice.

5. **Waiting is the server's.** `wait` calls `wait_for_reply` for up to 45 s at a time (the server holds the request
   and answers when the task changes) until the task stops being `still_running` or the time is up: one request in
   flight, never a tight loop. A `still_running` answered at once because the person's waits are all taken carries
   `retry_after_seconds`, and the client sleeps that long. A dropped connection, a 5xx or a 429 inside the time
   is retried after a pause (the 429's `Retry-After`); a refused token ends it at once.

6. **Output.** Plain lines by default: the reply's text on stdout, where it stands on stderr. `--json`: exactly one
   JSON document on stdout, a failure included (`{ "ok": false, "error", "exitCode" }`), the tools' own fields
   otherwise (`task_id`, `status`, `reply`…). Text others wrote stays in `untrusted_text` fields, as the tools return
   it: a script piping a reply into a model knows it is content. `--quiet` drops the stderr lines.

7. **Exit codes**, fixed by a test:

   | Code | Meaning |
   |---|---|
   | 0 | Done |
   | 1 | The task failed, was canceled or no run took it (`no_run`), or a tool refused the request |
   | 2 | The command line, a file or a setting is wrong |
   | 3 | A person must act: an approval or a question (`waiting_approval`, `waiting_input`) |
   | 4 | Timed out; the task keeps running (`agentes wait TASK_ID` picks it up) |
   | 5 | Can't reach the server, the token is refused or lacks the access, or it isn't an agentes.chat server |
   | 6 | Limited (429, JSON-RPC `-32013`, or a send limit's `retry_after`); try again later |
   | 130 | Interrupted (Ctrl-C); the task keeps running |

   Codes come from structured signals only (HTTP status, JSON-RPC error code, `isError`, the result's `status`),
   never from an error's words.

8. **`export` doesn't lose text quietly.** `read_conversation` returns 50 messages at a time within a 48,000-character
   budget, older ones cut to 2,000. Export pages back with `before` (deduplicating by id: a thread's root comes with
   every page) up to `--limit` (200, at most 2,000), and reads each cut message again alone (`before` its newer
   neighbour, `limit: 1`), so it comes whole. One still cut (over 48,000) keeps `truncated: true`, and the export
   says how many. Each read retries a limit on its own, up to 2 minutes. Files are links into the app, as the tools give them; their bytes are not downloaded.

9. **`events` is polling, within the token's day.** MCP here has no stream (ADR 0119 §7). A running task is followed
   with `wait_for_reply` held 45 s by the server and a read after each (two requests every 45 s, 3,840 a day); once
   it has settled, and on a channel or thread, it is a read every `--interval` (30 s, never less: a grant has 5,000
   requests a day, and one every 30 s is 2,880). The first read only marks what exists, except for `--task`, which
   prints its conversation from the task's own message on.

10. **Ids are checked before any request.** A task, thread or channel id is a UUID; anything else (an empty `$TASK`
    in a script) exits 2, so it never reads as a failed task (1) or a refused token (5).

## Consequences

- A CI job can run `agentes run @release "Ship 1.4 to staging" --json` with a `write` token and act on the exit code.
- Everything the CLI does is an MCP client's request: it gets the same audit rows, limits and refusals, and any
  change to the tools' shapes is a change to the CLI's output. `apps/server/test/cli.test.ts` runs it against the
  app in memory, and once as a process against a real HTTP listener.
- The CLI can't decide an approval or change a setting, because no tool can (ADR 0119 §7).

## Later

- Publishing `@agenteschat/cli` to npm through a tagged release workflow, like the setup's.
- `agents` and `channels` lists (`list_agents`, `list_channels`), `tasks` (`list_recent_tasks`).
- Server-held waits for new messages (a cursor on `read_conversation`, or a stream), so `events` stops polling.
- Downloading attached files into the export (needs a file read on `/mcp`).
- `agentes migrate` from ADR 0055 (bundles from other products), on `manage` tokens and the import tools.
