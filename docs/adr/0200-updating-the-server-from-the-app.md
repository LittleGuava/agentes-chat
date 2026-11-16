# 0200. Updating a self-hosted server from the app, with a copy of the data and the way back

- Status: Accepted (2026-11-15; built: the helper's script and image recipe, the compose service, the server's side and the web's card. Not yet run against a real Docker host: see "Not yet verified")
- Date: 2026-11-15
- Extends: ADR 0005 (Postgres as the only dependency), ADR 0060 §5 (the installation's pinned owner)

## Context

A self-hosted server is updated by hand today: download `docker-compose.yml` again, `docker compose pull && docker compose up -d` (top of `docker-compose.yml`). Migrations run on boot. If the new version never gets healthy, nothing goes back: the person has to find the previous image and, if a migration ran, a dump to restore. Many owners never update, and the ones who do take the risk alone.

They should be able to press a button in Settings. But pulling an image and recreating a container needs the Docker daemon, and whoever reaches the daemon's socket is root on the host. The app's container is the part of the system that talks to the internet, runs agents' tools and reads outside text: it must never get the socket, not even read-only (a read-only bind of the socket still lets every API call through).

## Decision

1. **A helper beside the app, never the app itself.** An optional `updater` service in `docker-compose.yml` (profile `updater`, off by default) is the only container with `/var/run/docker.sock`. It mounts the compose folder read-only at `/project` and runs `docker compose --project-directory /project` with the stack's own project name (`COMPOSE_PROJECT_NAME`, which Compose fills in), so it sees the same `.env` and profiles a person's `docker compose` does. Its script is `deploy/updater/updater.sh`, its image `deploy/updater/Dockerfile` (the Docker CLI with the Compose plugin, bash, nothing else).

2. **A request is a file, and it says nothing.** The app and the helper share two volumes and no network: `update-requests` (the app writes `request` there) and `update-status` (the helper writes `status.json` and touches `alive`; the app mounts it read-only). The helper never reads what the request contains: it cannot choose an image, a version, a tag, a flag or a path. It only ever updates the `agentes` service to whatever its image reference (`AGENTES_IMAGE` in `.env`) points at in the registry now. So whoever can write that file (the app, or something that took over the app's process) can cause at most what the owner would have pressed for: one stop, copy and start, and the way back when the new version fails.

3. **What one update does** (`updater.sh run`), each step written to `status.json` as it starts:
   - `pulling`: reads the running container's image id and reference. A reference pinned by digest (`@sha256:`) is never moved: `pinned`, nothing stopped. `docker compose pull agentes`; the same image id as the running one is `current`, nothing stopped. A failed pull is `failed` (`pull`), nothing stopped.
   - The running image is tagged `agentes-updater:previous`, so the way back exists before anything stops.
   - `stopping`: `docker compose stop agentes`, so the copy holds every write.
   - `backing_up`: `pg_dump -Fc` of the `agentes` database into the helper's own volume (`update-backups`), refused if empty. The three newest copies are kept. A copy that fails puts the previous image back under the reference and starts it: `failed` (`backup`), the database untouched.
   - `starting`: `docker compose up --detach --wait --no-deps agentes` with the new image, waiting on the image's health check (`UPDATER_WAIT_SECONDS`, 300 by default: migrations run on boot). Healthy is `updated`.
   - `rolling_back`, when it isn't healthy: stop the app, drop and recreate the database from the copy (`dropdb --force`, `createdb`, `pg_restore --exit-on-error`), never before the copy was checked; put the previous image back under the reference; start it and wait. Healthy is `rolled_back` (`unhealthy`); otherwise `failed` (`rollback`), with the copy kept for a person.

4. **Limits the helper enforces, whoever asks.** One run at a time. After any run (one that only found the same image too), the next request waits (the file stays where it is) until `UPDATER_COOLDOWN_SECONDS` (240) have passed, so requests in a row can't make it pull on every pass. A request is consumed (file or folder) before its run starts, so any number of requests in a row cause one run.

5. **An update the helper never finished.** Every run writes its step to a run file in `update-backups` (which the app never mounts) before it does it. If the helper itself stops mid-run (the host restarts, someone stops it), its next start finds that file and finishes the way back instead of leaving the app stopped: while `pulling` the app was still running, so nothing is undone; at `stopping` or `backing_up` it puts the previous image back and starts it (the database was only read); at `starting` or `rolling_back` it runs the whole way back with the copy. The status says `interrupted`, or `failed` (`rollback`) when that way back fails too.

6. **Who sees the button.** Only the installation's pinned owner (ADR 0060 §5, as for the usage report), never on agentes.chat itself, and only when the server has `SERVER_UPDATER_DIR` (the folder both volumes are mounted under in the app, `/updater` in `docker-compose.yml`). Everyone else, and a server without it, gets 404. `GET /api/app/server-updater` says whether the helper is there (its `alive` file touched within a minute), whether a request is waiting, and the last run's state; `POST /api/app/server-updater` writes the request, 409 while the helper is absent, a request waits or a run is going. The rules for what the app shows and allows are one pure function in the engine (`serverUpdateView`); the files are read and checked once, in the adapter (`createFileServerUpdater`).

7. **Not a module and not a network service.** The server's side is an adapter switched on by an env var (CLAUDE.md: external services optional, behind an interface); without `SERVER_UPDATER_DIR` the server has no updater and the app no card.

## The data that crosses

`<SERVER_UPDATER_DIR>/requests/request`: any content (the app writes the time it was asked; the helper ignores it).

`<SERVER_UPDATER_DIR>/status/status.json`, written only by the helper:

```json
{
  "state": "running | updated | current | pinned | rolled_back | failed | interrupted",
  "step": "pulling | stopping | backing_up | starting | rolling_back | null",
  "reason": "pull | backup | unhealthy | rollback | no_app | null",
  "startedAt": "2026-11-15T12:00:00Z",
  "finishedAt": "2026-11-15T12:03:10Z | null",
  "from": "sha256:… | null",
  "to": "sha256:… | null"
}
```

A file that doesn't parse, or a state the server doesn't know, reads as no status.

## Consequences

- An owner updates from Settings › General. The app goes away for the stop, the copy and the start, then comes back on its own (Caddy's and Tailscale's page already waits for it).
- A version that never gets healthy no longer strands the server: the previous image and the data it ran on come back.
- The helper is root on the host by nature (it holds the socket). Its whole surface toward the app is "a file exists". It never listens on a port.
- Uploaded files (the `files` volume) aren't copied: an update doesn't change them, and a migration doesn't touch them.
- Writes made while the new version was up, before it failed its health check, are lost by the way back (the app was not healthy, so few if any).

## Not yet verified

- The helper's image is not published yet: until CI builds `ghcr.io/agentes-chat/updater`, `SELF_HOSTING.md` says to build it from `deploy/updater` and set `AGENTES_UPDATER_IMAGE`.
- The script is tested against a stand-in for `docker` that records every call (`deploy/updater/updater.test.ts`), not against a real daemon: the project name and folder as seen from inside the helper, `--wait` on the image's health check, and `pg_restore` of a real dump need a run on a real host.
- The `update-requests` volume is made writable for the app's user by the helper at its start (`UPDATER_APP_UID`, 1000 by default, the `bun` user of the image); not yet seen on a real host.

## Later

- CI builds and publishes the helper's image (multi-arch, as the backup image), and its job in CI's Docker test runs one real update and one real way back.
- A version check before the button (the newer image's version label against the running one), so the app says what it would update to; another branch adds a notice of a newer server version, which this card should reuse rather than repeat.
- Never trying again, from the app, an image that already failed here, until a person runs it by hand.
- The phone app's and the desktop app's card.
- Updating Postgres, the backup, speech and embeddings services, and the helper itself.
- Refusing to start when the disk has no room for one more copy.
- An entry in the audit log (today the server's log says who asked); the audit log is per workspace and an update is the installation's.
