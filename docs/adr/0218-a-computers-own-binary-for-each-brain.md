# 0218. A computer's own binary for each brain

- Status: Accepted (built: the runner, the protocol's `binary` and the desktop app's Tools page; the site's computer
  page is Later)
- Date: 2026-11-15
- Code: runner `binaries.ts` (`useBinaries`, `binaryFor`, `binaryRefusal`), `executors.ts` (`resolveCommand`,
  `findOnWindowsPath`, `detectExecutors`, `cachedCodexVersion`), `config.ts` (`binaries`, `parseBinaries`),
  `daemon.ts`, `supervisor.ts` and `worker.ts` (`worker.state`'s `binaries`), `tasks.ts` (`taskProgram`), `main.ts`
  (`agentes-runner binaries`); protocol `RunnerExecutorInfo.binary` (`parseExecutors`); desktop
  `windows/prefs/Tools.tsx`; tests `binaries.test.ts`

## Context

The runner finds every coding CLI (Claude Code, Codex, Cursor's `agent`, OpenCode, Grok Build, `agy`, Copilot) by its
name on the PATH it sees. Whoever runs a computer sometimes wants another one than the PATH's: a version pinned while a
newer one misbehaves, a build of their own, or a wrapper that sets something up before it starts the real CLI. Changing
the PATH for that changes it for every program the runner and the agents start, and the desktop app or a system
service may not even read the person's shell profile.

## Decision

1. **A path per brain, in the runner's own config.** `"binaries": { "claude": "/opt/claude-2.1.300/claude" }` in
   `config.json` (keys: `claude`, `codex`, `cursor`, `opencode`, `grok`, `antigravity`, `copilot`), set by hand or with
   `agentes-runner binaries set <cli> <path>` / `unset <cli>` / `list`. Only absolute paths are kept; anything else is
   dropped when the file is read. Changes apply while the runner runs, like every other setting there. It is never an
   env var of the server, never a message from the server, and never something an agent can ask for: the server only
   ever learns which path is in use. Pairing again keeps it (`configFromGrant`), and a grant's fields never reach it.
   In user mode the runner keeps agents' commands out of its home (`command-policy`'s `runnerHome`), though the OS
   doesn't, as for the account folders; in system mode the config is root's.
2. **One place decides.** `binaryFor(command)` answers for a CLI's bare name; `resolveCommand` and
   `findOnWindowsPath`, which every turn, sign-in, usage probe, version check and route call goes through, ask it first.
   A background task's line names the program `taskProgram` gives it, the same way. Everything else (`rg`, `git`) is
   found as before. A configured binary that can't run resolves to a folder nobody can add to (`refusedPath`: under
   procfs on Linux, the NUL device on Windows, `/var/empty` on a Mac), so its start fails with `ENOENT`, as every
   brain reads a missing CLI. On Windows, Cursor's, Grok's and `agy`'s turns start their program with no shell, so
   only an `.exe` there, as from the PATH; the others take a `.cmd` wrapper too.
3. **Checked at every use, never a silent fallback.** A path that isn't a file, or isn't executable, is refused
   (`binaryRefusal`): `hello` lists that CLI under `executors.broken` with the reason, it isn't run, and the PATH's CLI
   of that name is not used in its place, since the person chose not to use it.
4. **System mode: root's file, the agents' to run.** Root runs the CLI too (version checks, sign-ins, the shared Claude
   sign-in's probes) and each agent runs it as its own user. So there the file and every folder above it must be
   root's alone and no links (`trustedRootFile`, as the network launcher), and runnable by others (the execute bit for
   others on the file, the search bit on each folder). A symlink is refused: point at its target (`readlink -f`). The
   supervisor hands the map to each agent's worker in `worker.state`; the worker never reads it from a file of its own.
5. **What `hello` says.** `RunnerExecutorInfo.binary` is the configured path of a CLI that runs from one, next to the
   version that binary reported. A wrapper must pass `--version` (and `auth status`, `models`) through, or it is
   reported like any CLI that doesn't answer as its maker's would. The desktop app's Tools page shows the path under
   that CLI. No protocol bump: an older server drops the field.
6. **A change is seen at once, used by every process started after it.** A change to `binaries` looks for the CLIs
   again at once (the fresh look of "Check again") and Codex's version kept for its turns is asked again. A brain
   process already open (a warm Claude Code, a Codex app-server) keeps its binary until it ends at its idle time
   (`brainIdleMinutes`) or the runner restarts, as the other brain settings apply to processes started from then on.

## Later

- The site's computer page and the phone show the path to admins and the person who paired it, as `cliErrors`.
- Setting it from the desktop app's Tools page (a file picker per CLI).
- Arguments before the CLI's own (a wrapper that takes flags): a wrapper script covers it today.
- Closing warm brain processes on a change, so even an open session moves to the new binary at its next turn.

## Consequences

- One map in one module; no call site passes a binary around.
- In system mode a binary under a person's home (`/root`, `/home/x`) is refused; it belongs in `/opt` or
  `/usr/local`.
