import { afterEach, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

/**
 * Where an account is signed in (ADR 0006, addendum 2026-11-15): the person lists their sessions by device, signs one
 * out, or every one but this; a browser's pushes go with its session (ADR 0071). No session token is answered.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const PASSWORD = "correct horse battery";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

interface Listed {
  sessions: {
    id: string;
    current: boolean;
    device: { kind: string; browser: string | null; os: string | null };
    ip: string | null;
    signedInAt: string;
    lastActiveAt: string;
  }[];
}

/** A browser signed in to `email` with this user agent. */
async function signedIn(email: string, userAgent: string) {
  const b = browser(t);
  const res = await b("/api/auth/sign-in/email", {
    json: { email, password: PASSWORD },
    headers: { "user-agent": userAgent },
  });
  expect(res.status).toBe(200);
  return b;
}

const list = async (b: Browser) => {
  const res = await b("/api/app/account/sessions");
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
};

const meStatus = async (b: Browser) => (await b("/api/app/me")).status;

/** Ana signed up on a laptop's Chrome, then signed in on her iPhone's Safari; Bia, invited, on her own browser. */
async function anaOnTwoDevices() {
  t = await createTestServer();
  const laptop = browser(t);
  await signUp(laptop, "ana@example.com");
  const created = await laptop("/api/app/organizations", { json: { name: "Padaria" } });
  const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
  const bia = await joinByInvitation(t, laptop, orgId, "bia@example.com");
  await laptop("/api/auth/sign-out", { json: {} });
  const desk = await signedIn("ana@example.com", CHROME_WINDOWS);
  const phone = await signedIn("ana@example.com", SAFARI_IPHONE);
  return { desk, phone, bia };
}

function webSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    platform: "web",
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") },
    locale: "pt-BR",
  };
}

describe("account sessions", () => {
  test("lists each device the account is signed in on, this one first and marked, with no token", async () => {
    const { desk } = await anaOnTwoDevices();
    const body = await list(desk);
    expect(body.sessions.map((s) => [s.current, s.device])).toEqual([
      [true, { kind: "browser", browser: "Chrome", os: "Windows" }],
      [false, { kind: "browser", browser: "Safari", os: "iPhone" }],
    ]);
    const tokens = (await t.db.select({ token: schema.sessions.token }).from(schema.sessions)).map((r) => r.token);
    const raw = JSON.stringify(body);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(raw).not.toContain(token);
    expect(Object.keys(body.sessions[0] ?? {}).sort()).toEqual([
      "current",
      "device",
      "id",
      "ip",
      "lastActiveAt",
      "signedInAt",
    ]);
  });

  test("signing out another session ends it and the pushes its browser turned on", async () => {
    const { desk, phone } = await anaOnTwoDevices();
    expect((await phone("/api/app/push/devices", { json: webSubscription("https://push.example/phone") })).status).toBe(
      204,
    );
    expect((await desk("/api/app/push/devices", { json: webSubscription("https://push.example/desk") })).status).toBe(
      204,
    );
    const other = (await list(desk)).sessions.find((s) => !s.current);
    const res = await desk(`/api/app/account/sessions/${other?.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await meStatus(phone)).toBe(401);
    expect(await meStatus(desk)).toBe(200);
    expect((await list(desk)).sessions.map((s) => s.current)).toEqual([true]);
    const left = await t.db.select({ token: schema.pushDevices.token }).from(schema.pushDevices);
    expect(left.map((d) => d.token)).toEqual(["https://push.example/desk"]);
  });

  test("this session isn't signed out here, and someone else's is no one's to end", async () => {
    const { desk, bia } = await anaOnTwoDevices();
    const own = (await list(desk)).sessions.find((s) => s.current);
    const mine = await desk(`/api/app/account/sessions/${own?.id}`, { method: "DELETE" });
    expect(mine.status).toBe(409);
    expect(((await mine.json()) as { error: { code: string } }).error.code).toBe("session.current");
    expect(await meStatus(desk)).toBe(200);
    const hers = (await list(bia)).sessions[0];
    expect((await desk(`/api/app/account/sessions/${hers?.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await meStatus(bia)).toBe(200);
    expect((await desk("/api/app/account/sessions/nothing-here", { method: "DELETE" })).status).toBe(404);
  });

  test("signing out every other session keeps this one and other people's", async () => {
    const { desk, phone, bia } = await anaOnTwoDevices();
    const tablet = await signedIn("ana@example.com", SAFARI_IPHONE);
    const res = await desk("/api/app/account/sessions/sign-out-others", { json: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedOut: 2 });
    expect(await meStatus(phone)).toBe(401);
    expect(await meStatus(tablet)).toBe(401);
    expect(await meStatus(desk)).toBe(200);
    expect(await meStatus(bia)).toBe(200);
    expect((await list(desk)).sessions).toHaveLength(1);
  });

  test("a session past its date isn't listed", async () => {
    const { desk } = await anaOnTwoDevices();
    const other = (await list(desk)).sessions.find((s) => !s.current);
    await t.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.id, other?.id ?? ""));
    expect((await list(desk)).sessions.map((s) => s.current)).toEqual([true]);
  });

  test("signed out: 401", async () => {
    t = await createTestServer();
    expect((await browser(t)("/api/app/account/sessions")).status).toBe(401);
  });

  test("Better Auth's own session list and revocations, which take and answer tokens, are off over HTTP", async () => {
    const { desk } = await anaOnTwoDevices();
    expect((await desk("/api/auth/list-sessions")).status).toBe(404);
    for (const path of ["/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]) {
      expect((await desk(`/api/auth${path}`, { json: { token: "x" } })).status).toBe(404);
    }
    expect(await meStatus(desk)).toBe(200);
  });
});
