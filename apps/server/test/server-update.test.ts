import { afterEach, describe, expect, test } from "bun:test";
import { CHECK_EVERY_MS, createUpdateCheck, RETRY_AFTER_MS } from "../src/server-update";
import { version } from "../src/version";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const REPO = "agentes-chat/agentes-chat";
const LIST = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const NEWER = "999.0.0";
const releases = [
  { tag_name: "desktop-v1000.0.0", draft: false, prerelease: false, published_at: "2026-11-14T00:00:00Z" },
  { tag_name: `v${NEWER}`, draft: false, prerelease: false, published_at: "2026-11-13T00:00:00Z" },
];

/** A fake GitHub that records every request: what was asked, how, and whether anything went with it. */
function fakeGithub(answer: () => Response = () => Response.json(releases)) {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ?? null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("the check", () => {
  test("asks GitHub once per 12 hours, with a GET that carries nothing", async () => {
    const github = fakeGithub();
    let clock = 0;
    const check = createUpdateCheck({ repo: REPO, fetch: github.fetch, now: () => clock });
    const [a, b] = await Promise.all([check.latest(), check.latest()]);
    expect(a?.version).toBe(NEWER);
    expect(b).toEqual(a);
    expect(github.calls).toEqual([{ url: LIST, method: "GET", body: null, auth: null }]);
    clock += CHECK_EVERY_MS - 1;
    await check.latest();
    expect(github.calls).toHaveLength(1);
    clock += 1;
    await check.latest();
    expect(github.calls).toHaveLength(2);
  });

  test("a failure keeps the version last seen and asks again an hour later", async () => {
    let up = true;
    const github = fakeGithub(() => (up ? Response.json(releases) : new Response("rate limited", { status: 403 })));
    let clock = 0;
    const check = createUpdateCheck({ repo: REPO, fetch: github.fetch, now: () => clock });
    expect((await check.latest())?.version).toBe(NEWER);
    up = false;
    clock += CHECK_EVERY_MS;
    expect((await check.latest())?.version).toBe(NEWER);
    clock += RETRY_AFTER_MS - 1;
    await check.latest();
    expect(github.calls).toHaveLength(2);
    clock += 1;
    await check.latest();
    expect(github.calls).toHaveLength(3);
  });

  test("a network error is no release, never an error", async () => {
    const check = createUpdateCheck({
      repo: REPO,
      fetch: (async (_input: string | URL | Request): Promise<Response> => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    expect(await check.latest()).toBeNull();
  });
});

describe("GET /api/app/server-update", () => {
  async function server(env: Record<string, string> = {}, github = fakeGithub()) {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env }, desktopFetch: github.fetch });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const other = browser(t);
    await signUp(other, "other@example.com");
    return { owner, other, github };
  }

  test("the installation's owner hears of a newer release, with its notes and the update command", async () => {
    const { owner, other, github } = await server({ INSTALL_MODE: "docker" });
    expect((await other("/api/app/server-update")).status).toBe(404);
    // Nobody but the owner makes the server ask.
    expect(github.calls).toHaveLength(0);
    const res = await owner("/api/app/server-update");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version,
      latest: {
        version: NEWER,
        publishedAt: "2026-11-13T00:00:00Z",
        notesUrl: `https://github.com/${REPO}/releases/tag/v${NEWER}`,
      },
      updateAvailable: true,
      install: "docker",
      command: [
        `curl -fsSLO https://raw.githubusercontent.com/${REPO}/v${NEWER}/docker-compose.yml`,
        "docker compose pull",
        "docker compose up -d",
      ].join("\n"),
    });
    expect(github.calls.map((c) => c.url)).toEqual([LIST]);
  });

  test("with UPDATE_CHECK=off, in the desktop app's server and on agentes.chat nobody has it and nothing is asked", async () => {
    const quiet: Record<string, string>[] = [{ UPDATE_CHECK: "off" }, { INSTALL_MODE: "desktop" }];
    for (const env of quiet) {
      const { owner, github } = await server(env);
      expect((await owner("/api/app/server-update")).status).toBe(404);
      expect(github.calls).toHaveLength(0);
      await t?.close();
      t = null;
    }
    const github = fakeGithub();
    const origin = "https://agentes.chat";
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin }, desktopFetch: github.fetch });
    const first = browser(t);
    const signedUp = await first("/api/auth/sign-up/email", {
      json: { email: "first@example.com", password: "correct horse battery", name: "First" },
      origin,
    });
    expect(signedUp.status).toBe(200);
    expect((await first("/api/app/server-update")).status).toBe(404);
    expect(github.calls).toHaveLength(0);
  });
});
