# 0193. File checkpoints per turn: undo what a computer brain changed in its folder

- Status: Accepted (2026-11-15; built: runner, protocol 73, engine, the shared client, the web and the phone app's
  receipts). Run with real git in the runner's tests on Windows 11; not yet run through a paired computer and the
  apps' screens.
- Date: 2026-11-15
- Extends: ADR 0025 (connected computers), ADR 0032 (computer brains), ADR 0037 round 2 (act with undo: receipts with
  "Desfazer" under the reply)

## Context

A computer brain (Claude Code, Codex and the others of ADR 0032) edits files on the computer with its own tools. The
server sees none of those edits one by one, and nothing could put a folder back as it was before a turn. Act with undo
(ADR 0037) gives the reply a receipt per change the agent made with our tools, each with "Desfazer"; file edits on a
computer had no receipt and no way back.

## Decision

1. **A checkpoint around each work turn, on the computer.** Before a `brain.turn` whose permission mode is `work`
   (never `plan` or `chat`, which change nothing), the runner records the turn's folder (the request's `cwd`, resolved
   as the brain resolves it) in a git repository of its own, a *shadow*, and records it again after the turn. The
   user's own `.git` is never read, written or locked: every git call sets `GIT_DIR` to the shadow and
   `GIT_WORK_TREE` to the folder, with its own config (`GIT_CONFIG_GLOBAL` to the shadow's file, `GIT_CONFIG_NOSYSTEM`)
   and the runner's `HARDENED_GIT_ARGS`, so no hook, filter or program of the folder's or the person's runs. Shadows
   live in the runner's home, `checkpoints/` (the worker's home in system mode, as the agent's own user), never inside
   a workspace.
2. **What a snapshot holds.** Every file `git add -A` takes in the folder, the folder's own `.gitignore` honoured,
   minus a fixed list of what is rebuilt or binary and large (dependencies, build output, caches, logs, media,
   archives, databases, `.env` files and keys), written to the shadow's `info/exclude`. Byte for byte: `core.autocrlf`
   off and `info/attributes` unsets `text`, `eol`, `filter` and `ident`, so a `.gitattributes` in the folder changes
   nothing on the way back. A git repository inside the folder (a checkout in the agent's folder) has a shadow of its
   own: up to 16 of them, found up to 3 folders down, so its files are recorded too (the outer one only sees a link).
   The repositories inside are looked for again on every snapshot: one the turn creates (`git init`, no commit yet)
   or deletes is left out of the outer shadow and never sinks the rest, though its own files are not recorded by
   that turn. A home folder, a filesystem's root, Desktop, Documents and Downloads are never recorded.
3. **Best effort, bounded.** No git, a folder refused, a git call that fails or takes longer than its budget (20 s
   before the turn, 20 s after it): the turn runs as it would have, with no checkpoint. Past the budget the runner
   stops waiting but lets the git call finish, never killing it (a killed git leaves its `index.lock` behind on
   Windows); a lock no git of the runner holds is removed before the next call on that shadow. A turn that ended in
   an error is recorded after it too (its files can still be put back by hand later), but only a turn that ends with
   an answer says so. A repository inside the folder that can't be recorded is left out; the turn's own folder can't
   be.
4. **The turn's answer says what changed.** The `done` event of a turn whose files changed carries
   `checkpoint: { id, count, paths }` (protocol 73): `id` is 32 hex characters the runner chose, `count` how many
   files changed, `paths` the first 20 of them relative to the turn's folder. The runner holds back the final event
   until the second snapshot is taken, so the event the engine ends the turn on has it.
5. **A receipt with undo.** The engine records the checkpoint as an agent action of kind `files.changed` (target
   `files`, the checkpoint's id; params `count` and `paths`; `after.machineId`), which goes on the reply like any other
   receipt (ADR 0037): the person the agent worked for, its owner or an admin may undo it, then redo it, while its
   window is open. Its window is 24 hours (the runner keeps checkpoints for 7 days), and opens again on every undo or
   redo.
6. **Undo and redo on the computer.** `checkpoint.restore { id, direction }` (protocol 73, run as the agent's own user
   in system mode) puts each file the turn changed back as it was before the turn (`undo`), or as the turn left it
   (`redo`), and nothing else: never a `clean` or a reset of the whole folder, so ignored and excluded files stay.
   Before writing anything it compares those files with how the turn left them (`undo`) or how they were before it
   (`redo`); any that differs means someone changed it since, and nothing is written (`conflict`, with the paths). A
   file the turn created is deleted on undo, only when it is still inside the folder. While a turn of the agent runs
   in that folder the answer is `busy`; an id the computer no longer has is `gone`. A runner older than protocol 73
   (taken back to an earlier version) is never asked: the change reads as expired. Commits, pushes and anything
   outside the folder are not undone.
7. **Kept small.** Each checkpoint is two refs in its shadow (`refs/checkpoints/<id>/before|after`); commits have no
   parents, so a ref dropped frees what only it held. The runner keeps a checkpoint's record for 7 days and at most
   100 per agent, drops the older ones' refs, and collects a shadow's garbage after drops.

## Consequences

- Undoing a turn's edits is one click under its reply, on the web and the phone, through the same receipts and rules
  as the agent's other changes.
- A large folder costs a snapshot before and after each turn; git's index makes the second and later ones cheap, and
  the exclude list keeps dependencies out.
- A folder whose files a turn changes on purpose for good (a database file, a build) is not recorded where excluded.
- A snapshot records the folder, not the agent: two turns at once in the same folder (two agents of one computer, or
  a person editing while the agent works) each count the other's changes as theirs, and undoing one puts those back
  too. A file changed after the turn stops the undo (`conflict`), so nothing changed since is lost.

## Later

- Turns a shared sign-in runs as root in system mode (`account-brains.ts`) and mission tasks get no checkpoint yet.
- A size cap per file (a large file the exclude list doesn't name is recorded whole).
- Showing a turn's diff before undoing it.
