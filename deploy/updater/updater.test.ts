import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Each run starts bash and several stand-ins, which takes seconds on some machines.
setDefaultTimeout(60_000);

const script = resolve(import.meta.dir, "updater.sh");
const dir = mkdtempSync(join(tmpdir(), "agentes-updater-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "bin");

// A stand-in for docker that records every call. The stack runs `cid1`, created from the reference in `ref` with the
// image `sha256:old`; a pull moves the reference to `sha256:new`. Files in the state make things fail: `pull-fails`,
// `dump-fails`, `dump-empty`, `no-app`, and `unhealthy` lists the image ids that never get healthy.
beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
state=$STUB_STATE
if [[ $1 == compose && \${2:-} == --project-directory ]]; then
  [[ $3 == "$STUB_PROJECT" ]] || { echo "wrong project folder: $3" >&2; exit 9; }
  [[ \${COMPOSE_PROJECT_NAME:-} == stack ]] || { echo "no project name" >&2; exit 7; }
  set -- compose "\${@:4}"
fi
printf '%s\\n' "docker $*" >>"$state/calls"
id_of() { awk -v tag="$1" '$1 == tag { id = $2 } END { if (id == "") exit 1; print id }' "$state/tags"; }
tag() { { grep -v "^$1 " "$state/tags" || true; echo "$1 $2"; } >"$state/tags.new" && mv "$state/tags.new" "$state/tags"; }
ref=$(cat "$state/ref")
case "$*" in
"compose ps -q agentes") [[ -f $state/no-app ]] || echo cid1 ;;
'inspect --format {{index .Config.Labels "com.docker.compose.project"}} helper') echo stack ;;
"inspect --format {{.Image}} cid1") echo sha256:old ;;
"inspect --format {{.Config.Image}} cid1") echo "$ref" ;;
"compose pull --quiet agentes") [[ ! -f $state/pull-fails ]] && { [[ -n \${STUB_PULL_SAME:-} ]] || tag "$ref" sha256:new; } ;;
"image inspect --format {{.Id}} "*) id_of "$5" ;;
"tag "*) tag "$3" "$(id_of "$2" || echo "$2")" ;;
"compose stop agentes") ;;
"compose exec -T postgres pg_dump "*)
  [[ ! -f $state/dump-fails ]] || exit 1
  [[ -f $state/dump-empty ]] || printf 'THE-DATABASE-BEFORE' ;;
"compose exec -T postgres dropdb "* | "compose exec -T postgres createdb "*) ;;
"compose exec -T postgres pg_restore "*) cat >"$state/restored" ;;
"compose up --detach --wait "*)
  running=$(id_of "$ref")
  ! grep -qx "$running" "$state/unhealthy" 2>/dev/null ;;
*) echo "unexpected: docker $*" >&2; exit 8 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
});

let runs = 0;

/** A host whose stack runs `ref`, and the helper's folders. */
function host(ref = "ghcr.io/agentes-chat/agentes:latest") {
  runs += 1;
  const root = join(dir, `host-${runs}`);
  const paths = {
    state: join(root, "stub"),
    project: join(root, "project"),
    statusDir: join(root, "status"),
    requests: join(root, "requests"),
    data: join(root, "data"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  writeFileSync(join(paths.state, "ref"), ref);
  writeFileSync(join(paths.state, "tags"), `${ref} sha256:old\n`);
  writeFileSync(join(paths.state, "calls"), "");
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    STUB_STATE: paths.state,
    STUB_PROJECT: paths.project,
    UPDATER_PROJECT_DIR: paths.project,
    UPDATER_STATUS_DIR: paths.statusDir,
    UPDATER_REQUESTS_DIR: paths.requests,
    UPDATER_DATA_DIR: paths.data,
    UPDATER_APP_UID: "",
    COMPOSE_PROJECT_NAME: "stack",
  };
  return {
    ...paths,
    set: (name: string, content = "") => writeFileSync(join(paths.state, name), content),
    ask: () => writeFileSync(join(paths.requests, "request"), "anything at all --image evil:latest\n"),
    /** One pass of the helper's loop: what `watch` does every few seconds. */
    tick(extra: Record<string, string> = {}) {
      writeFileSync(join(paths.state, "calls"), "");
      const run = Bun.spawnSync(["bash", script, "tick"], { env: { ...env, ...extra } });
      const calls = readFileSync(join(paths.state, "calls"), "utf8").split("\n").filter(Boolean);
      return { code: run.exitCode, out: `${run.stdout}${run.stderr}`, calls };
    },
    status: () => JSON.parse(readFileSync(join(paths.statusDir, "status.json"), "utf8")) as Record<string, unknown>,
    tagOf: (name: string) =>
      readFileSync(join(paths.state, "tags"), "utf8")
        .split("\n")
        .findLast((line) => line.startsWith(`${name} `))
        ?.split(" ")[1],
    dumps: () => readdirSync(join(paths.data, "backups")).filter((name) => name.endsWith(".dump")),
  };
}

const kinds = (calls: string[]) =>
  calls.map((call) =>
    call
      .replace(/^docker compose exec -T postgres (\w+).*/, "$1")
      .replace(/^docker compose (\w+).*/, "$1")
      .replace(/^docker (tag|inspect|image inspect).*/, "$1"),
  );

describe("deploy/updater/updater.sh", () => {
  test("without a request it only says it is there", () => {
    const h = host();
    const run = h.tick();
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([]);
    expect(existsSync(join(h.statusDir, "alive"))).toBe(true);
    expect(existsSync(join(h.statusDir, "status.json"))).toBe(false);
  });

  test("updates: pulls, stops, copies the database, starts the new image and waits for its health", () => {
    const h = host();
    h.ask();
    const run = h.tick();
    expect(run.code).toBe(0);
    expect(kinds(run.calls)).toEqual([
      "ps",
      "inspect",
      "inspect",
      "pull",
      "image inspect",
      "tag",
      "stop",
      "pg_dump",
      "up",
    ]);
    expect(run.calls).toContain("docker tag sha256:old agentes-updater:previous");
    expect(run.calls.at(-1)).toMatch(/^docker compose up --detach --wait --wait-timeout 300 --no-deps agentes$/);
    expect(h.status()).toMatchObject({
      state: "updated",
      step: null,
      reason: null,
      from: "sha256:old",
      to: "sha256:new",
    });
    expect(h.dumps()).toHaveLength(1);
    expect(readFileSync(join(h.data, "backups", h.dumps()[0] as string), "utf8")).toBe("THE-DATABASE-BEFORE");
    // The request is gone, whatever it said: it never chose an image.
    expect(existsSync(join(h.requests, "request"))).toBe(false);
    expect(run.calls.join("\n")).not.toContain("evil");
  });

  test("finds the stack's project name on its own container, as Compose labelled it", () => {
    const h = host();
    h.ask();
    const run = h.tick({ COMPOSE_PROJECT_NAME: "", HOSTNAME: "helper" });
    expect(run.calls[0]).toBe('docker inspect --format {{index .Config.Labels "com.docker.compose.project"}} helper');
    expect(h.status()).toMatchObject({ state: "updated" });
  });

  test("a failed pull stops nothing", () => {
    const h = host();
    h.set("pull-fails");
    h.ask();
    const run = h.tick();
    expect(kinds(run.calls)).toEqual(["ps", "inspect", "inspect", "pull"]);
    expect(h.status()).toMatchObject({ state: "failed", reason: "pull" });
  });

  test("a pull with nothing newer is `current` and stops nothing", () => {
    const h = host();
    h.ask();
    const run = h.tick({ STUB_PULL_SAME: "1" });
    expect(run.code).toBe(0);
    expect(kinds(run.calls)).toEqual(["ps", "inspect", "inspect", "pull", "image inspect"]);
    expect(h.status()).toMatchObject({ state: "current", reason: null, from: "sha256:old", to: "sha256:old" });
    expect(existsSync(join(h.data, "backups"))).toBe(false);
  });

  test("a reference pinned by digest is never moved", () => {
    const h = host("ghcr.io/agentes-chat/agentes@sha256:abc");
    h.ask();
    const run = h.tick();
    expect(kinds(run.calls)).toEqual(["ps", "inspect", "inspect"]);
    expect(h.status()).toMatchObject({ state: "pinned", reason: null });
  });

  test("no running app is refused before anything is pulled", () => {
    const h = host();
    h.set("no-app");
    h.ask();
    const run = h.tick();
    expect(kinds(run.calls)).toEqual(["ps"]);
    expect(h.status()).toMatchObject({ state: "failed", reason: "no_app" });
  });

  test("a copy that fails puts the previous image back and starts it, without touching the database", () => {
    const h = host();
    h.set("dump-fails");
    h.ask();
    const run = h.tick();
    expect(kinds(run.calls)).toEqual([
      "ps",
      "inspect",
      "inspect",
      "pull",
      "image inspect",
      "tag",
      "stop",
      "pg_dump",
      "tag",
      "up",
    ]);
    expect(run.calls).toContain("docker tag agentes-updater:previous ghcr.io/agentes-chat/agentes:latest");
    expect(run.calls.join("\n")).not.toMatch(/dropdb|pg_restore/);
    expect(h.tagOf("ghcr.io/agentes-chat/agentes:latest")).toBe("sha256:old");
    expect(h.status()).toMatchObject({ state: "failed", reason: "backup" });
  });

  test("an empty copy counts as a failed one", () => {
    const h = host();
    h.set("dump-empty");
    h.ask();
    const run = h.tick();
    expect(run.calls.join("\n")).not.toMatch(/dropdb|pg_restore/);
    expect(h.status()).toMatchObject({ state: "failed", reason: "backup" });
    expect(h.tagOf("ghcr.io/agentes-chat/agentes:latest")).toBe("sha256:old");
  });

  test("a new image that never gets healthy: the copy comes back, then the previous image", () => {
    const h = host();
    h.set("unhealthy", "sha256:new\n");
    h.ask();
    const run = h.tick();
    expect(kinds(run.calls)).toEqual([
      "ps",
      "inspect",
      "inspect",
      "pull",
      "image inspect",
      "tag",
      "stop",
      "pg_dump",
      "up",
      "stop",
      "dropdb",
      "createdb",
      "pg_restore",
      "tag",
      "up",
    ]);
    expect(readFileSync(join(h.state, "restored"), "utf8")).toBe("THE-DATABASE-BEFORE");
    expect(h.tagOf("ghcr.io/agentes-chat/agentes:latest")).toBe("sha256:old");
    expect(h.status()).toMatchObject({
      state: "rolled_back",
      reason: "unhealthy",
      from: "sha256:old",
      to: "sha256:new",
    });
  });

  test("a way back that fails too is `failed` and keeps the copy for a person", () => {
    const h = host();
    h.set("unhealthy", "sha256:new\nsha256:old\n");
    h.ask();
    h.tick();
    expect(h.status()).toMatchObject({ state: "failed", reason: "rollback" });
    expect(h.dumps()).toHaveLength(1);
  });

  test("after any run, the next request waits for the cooldown", () => {
    const h = host();
    h.ask();
    h.tick();
    h.ask();
    const waiting = h.tick();
    expect(waiting.calls).toEqual([]);
    expect(existsSync(join(h.requests, "request"))).toBe(true);
    const later = h.tick({ UPDATER_COOLDOWN_SECONDS: "0" });
    expect(later.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(h.requests, "request"))).toBe(false);
    // A run that only found the same image counts too: requests in a row can't make it pull on every pass.
    const same = host();
    same.ask();
    same.tick({ STUB_PULL_SAME: "1" });
    expect(same.status().state).toBe("current");
    same.ask();
    expect(same.tick({ STUB_PULL_SAME: "1" }).calls).toEqual([]);
  });

  test("a request left as a folder is consumed like a file", () => {
    const h = host();
    mkdirSync(join(h.requests, "request", "inside"), { recursive: true });
    h.tick();
    expect(existsSync(join(h.requests, "request"))).toBe(false);
    expect(h.status().state).toBe("updated");
  });

  test("an update it never finished while pulling: the app was still running, nothing is undone", () => {
    const h = host();
    writeFileSync(join(h.data, "run"), "step=pulling\nref=\nold=\nnew=\ndump=\nstarted=2026-11-15T12:00:00Z\n");
    const run = h.tick();
    expect(run.calls).toEqual([]);
    expect(h.status()).toMatchObject({ state: "interrupted" });
    expect(existsSync(join(h.data, "run"))).toBe(false);
  });

  test("an update it never finished whose way back fails too is `failed`, never `interrupted`", () => {
    const h = host();
    mkdirSync(join(h.data, "backups"), { recursive: true });
    const dump = join(h.data, "backups", "before-20261115T120000Z.dump");
    writeFileSync(dump, "THE-COPY");
    h.set("tags", "ghcr.io/agentes-chat/agentes:latest sha256:new\nagentes-updater:previous sha256:old\n");
    h.set("unhealthy", "sha256:old\n");
    writeFileSync(
      join(h.data, "run"),
      `step=starting\nref=ghcr.io/agentes-chat/agentes:latest\nold=sha256:old\nnew=sha256:new\ndump=${dump}\nstarted=2026-11-15T12:00:00Z\n`,
    );
    h.tick();
    expect(h.status()).toMatchObject({ state: "failed", reason: "rollback" });
  });

  test("keeps the three newest copies", () => {
    const h = host();
    mkdirSync(join(h.data, "backups"), { recursive: true });
    for (const stamp of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
      writeFileSync(join(h.data, "backups", `before-${stamp}.dump`), "old");
    }
    h.ask();
    h.tick();
    expect(h.dumps().sort()).toEqual([
      "before-20260102T000000Z.dump",
      "before-20260103T000000Z.dump",
      expect.stringMatching(/^before-\d{8}T\d{6}Z\.dump$/),
    ]);
  });

  test("an update it never finished before the new image started: the previous image comes back, the database untouched", () => {
    const h = host();
    h.set("tags", "ghcr.io/agentes-chat/agentes:latest sha256:new\nagentes-updater:previous sha256:old\n");
    writeFileSync(
      join(h.data, "run"),
      "step=backing_up\nref=ghcr.io/agentes-chat/agentes:latest\nold=sha256:old\nnew=sha256:new\ndump=\nstarted=2026-11-15T12:00:00Z\n",
    );
    const run = h.tick();
    expect(kinds(run.calls)).toEqual(["tag", "up"]);
    expect(h.tagOf("ghcr.io/agentes-chat/agentes:latest")).toBe("sha256:old");
    expect(h.status()).toMatchObject({ state: "interrupted", step: null, from: "sha256:old", to: "sha256:new" });
    expect(existsSync(join(h.data, "run"))).toBe(false);
  });

  test("an update it never finished after the new image started: the whole way back, with the copy", () => {
    const h = host();
    mkdirSync(join(h.data, "backups"), { recursive: true });
    const dump = join(h.data, "backups", "before-20261115T120000Z.dump");
    writeFileSync(dump, "THE-COPY");
    h.set("tags", "ghcr.io/agentes-chat/agentes:latest sha256:new\nagentes-updater:previous sha256:old\n");
    writeFileSync(
      join(h.data, "run"),
      `step=starting\nref=ghcr.io/agentes-chat/agentes:latest\nold=sha256:old\nnew=sha256:new\ndump=${dump}\nstarted=2026-11-15T12:00:00Z\n`,
    );
    const run = h.tick();
    expect(kinds(run.calls)).toEqual(["stop", "dropdb", "createdb", "pg_restore", "tag", "up"]);
    expect(readFileSync(join(h.state, "restored"), "utf8")).toBe("THE-COPY");
    expect(h.status()).toMatchObject({ state: "interrupted" });
  });
});
