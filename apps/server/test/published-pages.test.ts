import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** Public pages over HTTP (ADR 0211): the pages host serves a page's address and nothing else, with its own policy. */

const PAGES = "http://pages.test";
const TOKEN = "A".repeat(43);
let t: TestServer;
afterEach(() => t?.close());

/** The owner's workspace with an html file whose page is live at `TOKEN`. */
async function withPage(env: Record<string, string> = { PUBLISHED_PAGES_URL: PAGES }) {
  t = await createTestServer({ env });
  const owner = browser(t);
  const me = await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const created = await owner(`/api/app/organizations/${orgId}/artifacts`, {
    json: { title: "Proposta", channelId, content: { kind: "html", html: "<h1>Proposta</h1><script>1</script>" } },
  });
  expect(created.status).toBe(201);
  const file = (await created.json()) as { id: string };
  const [page] = await t.db
    .insert(schema.publishedPages)
    .values({ orgId, artifactId: file.id, version: 1, token: TOKEN, createdByType: "agent", createdById: agentId })
    .returning();
  if (!page) throw new Error("no page");
  return { owner, me, orgId, file, page };
}

test("the pages host answers the page with its own policy, no cookie, and nothing else", async () => {
  await withPage();
  for (const path of [`/p/${TOKEN}/`, `/p/${TOKEN}`]) {
    const res = await t.app.request(`${PAGES}${path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Proposta</h1><script>1</script>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toStartWith("sandbox allow-scripts allow-forms;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  // Nothing else on that host: not the API, not the app, not another token.
  for (const path of ["/api/health", "/api/app/me", "/", "/login", `/p/${"B".repeat(43)}/`, `/p/${TOKEN}/x`]) {
    const res = await t.app.request(`${PAGES}${path}`);
    expect({ path, status: res.status }).toEqual({ path, status: 404 });
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  expect((await t.app.request(`${PAGES}/p/${TOKEN}/`, { method: "POST" })).status).toBe(404);
  // The app's host never serves a page.
  expect((await t.app.request(`/p/${TOKEN}/`)).status).toBe(404);
  expect((await t.app.request("/api/health")).status).toBe(200);
});

test("without a pages host nothing is served", async () => {
  await withPage({});
  expect((await t.app.request(`${PAGES}/p/${TOKEN}/`)).status).toBe(404);
  expect((await t.app.request(`/p/${TOKEN}/`)).status).toBe(404);
});

test("the file's readers list the page and take it down; then its address stops at once", async () => {
  const { owner, orgId, file, page } = await withPage();
  const list = await owner(`/api/app/organizations/${orgId}/published-pages?artifactId=${file.id}`);
  expect(await list.json()).toEqual({
    pages: [
      expect.objectContaining({
        id: page.id,
        artifactId: file.id,
        title: "Proposta",
        version: 1,
        url: `${PAGES}/p/${TOKEN}/`,
      }),
    ],
  });
  const gone = await owner(`/api/app/organizations/${orgId}/published-pages/${page.id}`, { method: "DELETE" });
  expect(gone.status).toBe(204);
  expect((await t.app.request(`${PAGES}/p/${TOKEN}/`)).status).toBe(404);
  expect(await (await owner(`/api/app/organizations/${orgId}/published-pages`)).json()).toEqual({ pages: [] });
  const again = await owner(`/api/app/organizations/${orgId}/published-pages/${page.id}`, { method: "DELETE" });
  expect(again.status).toBe(404);
});
