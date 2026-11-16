import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Announcements (ADR 0056, addendum on announcements): the operator publishes, each person sees and closes. */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const HOUR = 3600_000;

let t: TestServer;
/** The operator API with a token, a method and a JSON body. */
let op: (path: string, init?: { method?: string; json?: unknown; token?: string }) => Promise<Response>;
let acme: string;
let other: string;
let owner: Browser;
let admin: Browser;
let member: Browser;
let stranger: Browser;

type Shown = { id: string; title: string; body: string; link: { url: string; label: string | null } | null };
type Listed = Shown & { audience: string; orgId: string | null; dismissals: number; endsAt: string | null };

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN, ALLOW_SIGNUP: "true" } });
  const app = createOperatorApp(
    { db: t.db, config: t.config, version: "test", log: createLogger("error") },
    TOKEN,
    READ,
  );
  op = async (path, { method, json, token = TOKEN } = {}) =>
    app.request(`/api/operator/v1${path}`, {
      method: method ?? (json === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  owner = browser(t);
  await signUp(owner, "owner@acme.test");
  acme = (await seedOrg(owner)).orgId;
  admin = await joinByInvitation(t, owner, acme, "admin@acme.test", { role: "admin" });
  member = await joinByInvitation(t, owner, acme, "member@acme.test");
  stranger = browser(t);
  await signUp(stranger, "someone@other.test");
  other = (await seedOrg(stranger)).orgId;
});

afterAll(() => t.close());

async function publish(json: Record<string, unknown>) {
  const res = await op("/announcements", { json: { title: "Maintenance tonight", body: "", ...json } });
  expect(res.status).toBe(201);
  return (await res.json()) as Listed;
}

/** What a person is shown in a workspace now, by title. */
async function shown(b: Browser, orgId: string) {
  const res = await b(`/api/app/organizations/${orgId}/announcements`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { announcements: Shown[] }).announcements.map((a) => a.title);
}

const dismiss = (b: Browser, orgId: string, id: string) =>
  b(`/api/app/organizations/${orgId}/announcements/${id}/dismiss`, { json: {} });

test("one for everyone reaches every member of every workspace, with its words and its link", async () => {
  const made = await publish({
    title: "Everyone: new search",
    body: "Search now finds files too.\nTry it in the header.",
    link: { url: "https://example.com/news/search", label: null },
    audience: "everyone",
  });
  expect(made).toMatchObject({ audience: "everyone", orgId: null, endsAt: null, dismissals: 0 });
  for (const b of [owner, admin, member]) expect(await shown(b, acme)).toContain("Everyone: new search");
  expect(await shown(stranger, other)).toContain("Everyone: new search");
  const res = await member(`/api/app/organizations/${acme}/announcements`);
  const { announcements } = (await res.json()) as { announcements: Shown[] };
  expect(announcements.find((a) => a.id === made.id)).toMatchObject({
    body: "Search now finds files too.\nTry it in the header.",
    link: { url: "https://example.com/news/search", label: null },
  });
  // Nobody reads another workspace's.
  expect((await member(`/api/app/organizations/${other}/announcements`)).status).toBe(403);
});

test("one for admins reaches the owner and the admins of the workspace on screen, never a member", async () => {
  const made = await publish({ title: "Admins: billing moves", audience: "admins" });
  expect(await shown(owner, acme)).toContain("Admins: billing moves");
  expect(await shown(admin, acme)).toContain("Admins: billing moves");
  expect(await shown(stranger, other)).toContain("Admins: billing moves");
  expect(await shown(member, acme)).not.toContain("Admins: billing moves");
  expect((await dismiss(member, acme, made.id)).status).toBe(404);
});

test("one for a workspace reaches its members alone", async () => {
  await publish({ title: "Acme: your computer moves", audience: "workspace", orgId: acme });
  for (const b of [owner, admin, member]) expect(await shown(b, acme)).toContain("Acme: your computer moves");
  expect(await shown(stranger, other)).not.toContain("Acme: your computer moves");
});

test("only within its period", async () => {
  const now = Date.now();
  await publish({ title: "Later", audience: "everyone", startsAt: new Date(now + HOUR).toISOString() });
  await publish({
    title: "Over",
    audience: "everyone",
    startsAt: new Date(now - 2 * HOUR).toISOString(),
    endsAt: new Date(now - HOUR).toISOString(),
  });
  const live = await publish({ title: "Until tomorrow", audience: "everyone", endsAt: new Date(now + 24 * HOUR) });
  expect(live.endsAt).not.toBeNull();
  const titles = await shown(member, acme);
  expect(titles).toContain("Until tomorrow");
  expect(titles).not.toContain("Later");
  expect(titles).not.toContain("Over");
});

test("closed by one person stays closed for them in every workspace, edited or not, and shows to the rest", async () => {
  const made = await publish({ title: "Closable", audience: "everyone" });
  expect((await dismiss(owner, acme, made.id)).status).toBe(204);
  // Again changes nothing.
  expect((await dismiss(owner, acme, made.id)).status).toBe(204);
  expect(await shown(owner, acme)).not.toContain("Closable");
  expect(await shown(member, acme)).toContain("Closable");
  // The owner's own other workspace.
  const own = await seedOrg(owner);
  expect(await shown(owner, own.orgId)).not.toContain("Closable");

  const edited = await op(`/announcements/${made.id}`, {
    method: "PUT",
    json: { title: "Closable, edited", body: "More words", audience: "everyone" },
  });
  expect(edited.status).toBe(200);
  expect(await shown(owner, acme)).not.toContain("Closable, edited");
  expect(await shown(member, acme)).toContain("Closable, edited");

  const list = (await (await op("/announcements")).json()) as { announcements: Listed[]; more: boolean };
  expect(list.announcements.find((a) => a.id === made.id)).toMatchObject({ title: "Closable, edited", dismissals: 1 });
  expect(list.more).toBe(false);
});

test("removed, it is gone for everyone", async () => {
  const made = await publish({ title: "Removable", audience: "everyone" });
  expect(await shown(member, acme)).toContain("Removable");
  expect((await op(`/announcements/${made.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await shown(member, acme)).not.toContain("Removable");
  expect((await op(`/announcements/${made.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await dismiss(member, acme, made.id)).status).toBe(404);
  const missing = await op(`/announcements/${UNKNOWN}`, { method: "PUT", json: { title: "x", audience: "everyone" } });
  expect(missing.status).toBe(404);
});

test("one for a workspace goes when the workspace goes", async () => {
  const gone = await seedOrg(owner);
  const made = await publish({ title: "Short-lived workspace", audience: "workspace", orgId: gone.orgId });
  await t.db.delete(schema.organizations).where(eq(schema.organizations.id, gone.orgId));
  const left = await t.db.select().from(schema.announcements).where(eq(schema.announcements.id, made.id));
  expect(left).toEqual([]);
});

test("what it may say, who it may be for and when are checked before anything is stored", async () => {
  const bad = async (json: Record<string, unknown>, code = "invalid_request") => {
    const res = await op("/announcements", { json: { title: "Fine", audience: "everyone", ...json } });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
      code === "not_found" ? 404 : 400,
      code,
    ]);
  };
  await bad({ title: "" });
  await bad({ title: "Two\nlines" });
  await bad({ body: "x".repeat(601) });
  await bad({ link: { url: "http://example.com/plain", label: null } });
  await bad({ link: { url: "https://user:pass@example.com/", label: null } });
  await bad({ link: { url: "javascript:alert(1)", label: null } });
  await bad({ link: { url: "https://example.com/", label: "x".repeat(41) } });
  await bad({ audience: "workspace" });
  await bad({ audience: "everyone", orgId: acme });
  await bad({ audience: "workspace", orgId: UNKNOWN }, "not_found");
  const now = Date.now();
  await bad(
    { startsAt: new Date(now).toISOString(), endsAt: new Date(now - HOUR).toISOString() },
    "announcement.period",
  );
  await bad({ endsAt: new Date(now - HOUR).toISOString() }, "announcement.period");
  const titles = ((await (await op("/announcements")).json()) as { announcements: Listed[] }).announcements.map(
    (a) => a.title,
  );
  expect(titles).not.toContain("Fine");
});

test("the read-only token lists them and changes none", async () => {
  expect((await op("/announcements", { token: READ })).status).toBe(200);
  expect((await op("/announcements", { token: READ, json: { title: "No", audience: "everyone" } })).status).toBe(403);
  const made = await publish({ title: "Kept", audience: "everyone" });
  expect((await op(`/announcements/${made.id}`, { token: READ, method: "DELETE" })).status).toBe(403);
});
