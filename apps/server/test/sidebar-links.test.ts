import { afterEach, expect, test } from "bun:test";
import { SIDEBAR_LINK_LIMIT, sidebarLinkUrl } from "@agenteschat/engine";
import {
  SIDEBAR_LINK_LIMIT as APP_LIMIT,
  SIDEBAR_LINK_TITLE_MAX as APP_TITLE_MAX,
  sidebarLinkUrl as appLinkUrl,
} from "../../../packages/client/src/lib/sidebar-links";
import { SIDEBAR_LINK_TITLE_MAX } from "../../../packages/engine/src/sidebar-links";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

interface Link {
  id: string;
  title: string;
  url: string;
}

/** A new workspace, set up (one still in its onboarding would come back instead of another). */
async function workspace(b: ReturnType<typeof browser>, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  const orgId = created.organization.id;
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  return orgId;
}

const ADDRESSES = [
  "https://example.com",
  "https://example.com/a path?q=1#x",
  "HTTPS://Example.com:8443/board",
  "http://example.com",
  "javascript:alert(1)",
  "data:text/html,hi",
  "https://user:secret@example.com",
  "https://",
  "example.com",
  "ftp://example.com",
  ` https://example.com/${"a".repeat(2048)}`,
];

test("the apps check an address as the server does, and know the same limits", () => {
  expect(APP_LIMIT).toBe(SIDEBAR_LINK_LIMIT);
  expect(APP_TITLE_MAX).toBe(SIDEBAR_LINK_TITLE_MAX);
  for (const address of ADDRESSES) expect(appLinkUrl(address)).toBe(sidebarLinkUrl(address));
});

test("an address is https with a host and no password, kept as the URL parser writes it", () => {
  expect(sidebarLinkUrl("https://example.com")).toBe("https://example.com/");
  expect(sidebarLinkUrl("  HTTPS://Example.com:8443/board ")).toBe("https://example.com:8443/board");
  expect(sidebarLinkUrl("https://example.com/a path")).toBe("https://example.com/a%20path");
  for (const bad of [
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:secret@example.com",
    "https://:secret@example.com",
    "https://",
    "example.com",
    "ftp://example.com",
    "",
    `https://example.com/${"a".repeat(2048)}`,
  ])
    expect(sidebarLinkUrl(bad)).toBeNull();
});

test("links in the sidebar: each person's own, per workspace, https only, at most the limit", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const path = `/api/app/organizations/${orgId}/me/sidebar/links`;
  const links = async (b = owner, p = path) => ((await (await b(p)).json()) as { links: Link[] }).links;
  const add = (json: unknown, b = owner, p = path) => b(p, { json });

  expect(await links()).toEqual([]);

  const saved = await add({ title: "  CRM ", url: "https://crm.example.com/board" });
  expect(saved.status).toBe(200);
  const [crm] = ((await saved.json()) as { links: Link[] }).links;
  expect(crm).toMatchObject({ title: "CRM", url: "https://crm.example.com/board" });
  expect(await links()).toEqual([crm as Link]);

  // Only https with a host, no password in it; a title of 1 to 60 characters. Refused with a code the apps say in
  // words, nothing kept.
  for (const [bad, code] of [
    [{ title: "x", url: "http://example.com" }, "sidebar_link.url"],
    [{ title: "x", url: "javascript:alert(1)" }, "sidebar_link.url"],
    [{ title: "x", url: "data:text/html,hi" }, "sidebar_link.url"],
    [{ title: "x", url: "https://user:secret@example.com" }, "sidebar_link.url"],
    [{ title: "x", url: "example.com" }, "sidebar_link.url"],
    [{ title: "x", url: `https://example.com/${"a".repeat(2040)}` }, "sidebar_link.url"],
    [{ title: "   ", url: "https://example.com" }, "sidebar_link.title"],
    [{ title: "x".repeat(61), url: "https://example.com" }, "sidebar_link.title"],
    [{ url: "https://example.com" }, "invalid_request"],
  ] as const) {
    const refused = await add(bad);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(code);
  }
  expect(await links()).toEqual([crm as Link]);

  // Up to the limit, in the order they were added; one more is refused and nothing changes.
  for (let i = 2; i <= SIDEBAR_LINK_LIMIT; i++)
    expect((await add({ title: `Link ${i}`, url: `https://example.com/${i}` })).status).toBe(200);
  const full = await links();
  expect(full.map((l) => l.title)).toEqual([
    "CRM",
    ...Array.from({ length: SIDEBAR_LINK_LIMIT - 1 }, (_, i) => `Link ${i + 2}`),
  ]);
  const over = await add({ title: "One more", url: "https://example.com/more" });
  expect(over.status).toBe(409);
  expect(((await over.json()) as { error: { code: string } }).error.code).toBe("sidebar_link.full");
  expect(await links()).toEqual(full);

  // Removing one makes room again; the others keep their order.
  const removed = await owner(`${path}/${crm?.id}`, { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect(((await removed.json()) as { links: Link[] }).links).toEqual(full.slice(1));
  expect((await add({ title: "Status", url: "https://status.example.com" })).status).toBe(200);
  expect((await links()).at(-1)).toMatchObject({ title: "Status", url: "https://status.example.com/" });

  // Someone else in the workspace has their own, and can't remove the owner's.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await links(member)).toEqual([]);
  expect((await add({ title: "Mine", url: "https://mine.example.com" }, member)).status).toBe(200);
  const ownersFirst = (await links())[0] as Link;
  expect((await member(`${path}/${ownersFirst.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await links())[0]).toEqual(ownersFirst);
  expect((await links(member)).map((l) => l.title)).toEqual(["Mine"]);

  // So does the owner in another workspace, and an id that isn't one is refused, not a failure.
  const other = await workspace(owner, "Beta");
  expect(await links(owner, `/api/app/organizations/${other}/me/sidebar/links`)).toEqual([]);
  expect((await owner(`${path}/not-an-id`, { method: "DELETE" })).status).toBe(400);

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(path)).status).toBe(403);
  expect((await add({ title: "x", url: "https://example.com" }, stranger)).status).toBe(403);
});

test("two links added at once when one place is left: one is kept, the other refused", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const path = `/api/app/organizations/${orgId}/me/sidebar/links`;
  for (let i = 1; i < SIDEBAR_LINK_LIMIT; i++)
    await owner(path, { json: { title: `Link ${i}`, url: `https://example.com/${i}` } });
  const statuses = (
    await Promise.all(["a", "b"].map((x) => owner(path, { json: { title: x, url: `https://example.com/${x}` } })))
  ).map((r) => r.status);
  expect(statuses.sort()).toEqual([200, 409]);
  expect(((await (await owner(path)).json()) as { links: Link[] }).links).toHaveLength(SIDEBAR_LINK_LIMIT);
});
