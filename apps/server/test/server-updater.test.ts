import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

// The server's side of updates from the app (ADR 0200), against the folders the updater shares with it. The updater
// itself is played here by writing its files: deploy/updater/updater.test.ts tests the real one.
const root = mkdtempSync(join(tmpdir(), "agentes-server-updater-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

let folders = 0;

/** An updater's folders; `alive` says it is running, as its loop does every few seconds. */
function updater(alive = true) {
  folders += 1;
  const dir = join(root, `updater-${folders}`);
  mkdirSync(join(dir, "status"), { recursive: true });
  const status = (run: Record<string, unknown> | string) =>
    writeFileSync(join(dir, "status", "status.json"), typeof run === "string" ? run : JSON.stringify(run));
  if (alive) writeFileSync(join(dir, "status", "alive"), "");
  return {
    dir,
    status,
    request: join(dir, "requests", "request"),
    stale: () => {
      const longAgo = new Date(Date.now() - 5 * 60_000);
      utimesSync(join(dir, "status", "alive"), longAgo, longAgo);
    },
  };
}

async function server(env: Record<string, string>) {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const other = browser(t);
  await signUp(other, "other@example.com");
  return { owner, other };
}

const updated = {
  state: "updated",
  step: null,
  reason: null,
  startedAt: "2026-11-15T12:00:00Z",
  finishedAt: "2026-11-15T12:03:10Z",
  from: "sha256:0123456789abcdef",
  to: "sha256:fedcba9876543210",
};

describe("updating the server from the app", () => {
  test("the owner asks for an update: a request that says nothing is left for the updater", async () => {
    const u = updater();
    const { owner } = await server({ SERVER_UPDATER_DIR: u.dir });
    const before = await owner("/api/app/server-updater");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ helper: "ready", requested: false, canUpdate: true, run: null });

    const asked = await owner("/api/app/server-updater", { method: "POST", json: {} });
    expect(asked.status).toBe(202);
    expect(await asked.json()).toMatchObject({ helper: "ready", requested: true, canUpdate: false });
    expect(existsSync(u.request)).toBe(true);
    expect(readFileSync(u.request, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);

    // A second press while it waits changes nothing.
    const again = await owner("/api/app/server-updater", { method: "POST", json: {} });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("update_in_progress");
  });

  test("shows the updater's last run, and allows another once it ended", async () => {
    const u = updater();
    u.status(updated);
    const { owner } = await server({ SERVER_UPDATER_DIR: u.dir });
    expect(await (await owner("/api/app/server-updater")).json()).toEqual({
      helper: "ready",
      requested: false,
      canUpdate: true,
      run: updated,
    });
  });

  test("no request while a run is going", async () => {
    const u = updater();
    u.status({ ...updated, state: "running", step: "backing_up", finishedAt: null, to: null });
    const { owner } = await server({ SERVER_UPDATER_DIR: u.dir });
    const view = (await (await owner("/api/app/server-updater")).json()) as { canUpdate: boolean; run: unknown };
    expect(view).toMatchObject({ canUpdate: false, run: { state: "running", step: "backing_up" } });
    const asked = await owner("/api/app/server-updater", { method: "POST", json: {} });
    expect(asked.status).toBe(409);
    expect(existsSync(u.request)).toBe(false);
  });

  test("an updater that isn't running gets no request", async () => {
    const u = updater();
    u.stale();
    const { owner } = await server({ SERVER_UPDATER_DIR: u.dir });
    expect(await (await owner("/api/app/server-updater")).json()).toMatchObject({ helper: "absent", canUpdate: false });
    const asked = await owner("/api/app/server-updater", { method: "POST", json: {} });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: { code: string } }).error.code).toBe("updater_absent");
    expect(existsSync(u.request)).toBe(false);

    const never = updater(false);
    await t?.close();
    const again = await server({ SERVER_UPDATER_DIR: never.dir });
    expect(await (await again.owner("/api/app/server-updater")).json()).toMatchObject({ helper: "absent" });
  });

  test("a status file it can't read is no run", async () => {
    const u = updater();
    u.status({ ...updated, state: "exploded" });
    const { owner } = await server({ SERVER_UPDATER_DIR: u.dir });
    expect(await (await owner("/api/app/server-updater")).json()).toMatchObject({ run: null });
    u.status("not json");
    expect(await (await owner("/api/app/server-updater")).json()).toMatchObject({ run: null });
  });

  test("only the installation's owner: anyone else gets 404 and leaves nothing", async () => {
    const u = updater();
    const { other } = await server({ SERVER_UPDATER_DIR: u.dir });
    expect((await other("/api/app/server-updater")).status).toBe(404);
    expect((await other("/api/app/server-updater", { method: "POST", json: {} })).status).toBe(404);
    expect(existsSync(u.request)).toBe(false);
  });

  test("without SERVER_UPDATER_DIR there is nothing to update with", async () => {
    const { owner } = await server({});
    expect((await owner("/api/app/server-updater")).status).toBe(404);
    expect((await owner("/api/app/server-updater", { method: "POST", json: {} })).status).toBe(404);
  });

  test("never on agentes.chat itself", async () => {
    const u = updater();
    const origin = "https://agentes.chat";
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin, SERVER_UPDATER_DIR: u.dir } });
    const first = browser(t);
    const signedUp = await first("/api/auth/sign-up/email", {
      json: { email: "first@example.com", password: "correct horse battery", name: "First" },
      origin,
    });
    expect(signedUp.status).toBe(200);
    expect((await first("/api/app/server-updater")).status).toBe(404);
    expect((await first("/api/app/server-updater", { method: "POST", json: {}, origin })).status).toBe(404);
    expect(existsSync(u.request)).toBe(false);
  });
});
