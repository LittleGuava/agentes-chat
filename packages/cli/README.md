# @agenteschat/cli

The `agentes` command: give [agentes.chat](https://github.com/agentes-chat/agentes-chat) agents work from scripts
and CI. It talks to the server's MCP endpoint (`/mcp`) with a personal token, so it does exactly what the token's
person may do there, and nothing else (ADR 0219).

```sh
export AGENTES_URL=https://chat.example.com
export AGENTES_TOKEN=agp_…          # Settings → Apps de IA → Tokens pessoais

TASK=$(agentes send @dev "Write the release notes for 1.4")
agentes wait "$TASK" --timeout 20m
agentes run @release "Ship 1.4 to staging" --json > result.json
agentes export "$TASK" --format md --out notes.md
agentes events --task "$TASK" --until-done > events.jsonl
```

`agentes help` lists every command and `agentes help COMMAND` its options. The token comes from `AGENTES_TOKEN` or
`--token-file FILE`, never the command line.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failed, canceled, no run took the task, or the server refused the request |
| 2 | The command line, a file or a setting is wrong |
| 3 | A person must act: an approval or a question in agentes.chat |
| 4 | Timed out; the task keeps running (`agentes wait TASK_ID`) |
| 5 | Can't reach the server, or the token is refused or lacks the access |
| 6 | Limited; try again later (`retry_after` in `--json`) |
| 130 | Ctrl-C; the task keeps running |

From a checkout: `bun packages/cli/src/index.ts …`. One file for Node 18 or Bun:
`bun run --filter @agenteschat/cli build` writes `packages/cli/dist/index.js`.
