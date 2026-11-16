import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const confirm = (email: string) =>
  t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, email));
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("an admin names the domain; a confirmed account at it finds the workspace and joins with a click", async () => {
  // Open sign-up: a domain doesn't open a closed one (ADR 0068 §5), so Caio signs up as on an open server.
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@acme.test");
  const { orgId } = await seedOrg(owner);
  const domains = `/api/app/organizations/${orgId}/join-domains`;

  // The owner's address isn't confirmed yet: the domain isn't theirs to name.
  expect(await errorCode(await owner(domains, { json: { domain: "acme.test" } }))).toBe("join_domain.not_yours");
  await confirm("owner@acme.test");
  const publicDomain = await owner(domains, { json: { domain: "gmail.com" } });
  expect(publicDomain.status).toBe(400);
  expect(await errorCode(publicDomain)).toBe("join_domain.public");
  // Same-origin JSON only, as every write here.
  expect((await owner(domains, { json: { domain: "acme.test" }, origin: "https://evil.example" })).status).toBe(403);
  const added = await owner(domains, { json: { domain: "@Acme.test" } });
  expect(added.status).toBe(200);
  const domain = (await added.json()) as { id: string; domain: string };
  expect(domain.domain).toBe("acme.test");
  expect(((await (await owner(domains)).json()) as { domains: unknown[] }).domains).toHaveLength(1);

  const caio = browser(t);
  await signUp(caio, "caio@acme.test");
  // Not confirmed: nothing to see, nothing to join.
  expect(await (await caio("/api/app/domain-workspaces")).json()).toEqual({ workspaces: [] });
  expect((await caio(`/api/app/domain-workspaces/${orgId}/join`, { json: {} })).status).toBe(403);
  // A member who isn't an admin can't read the domains.
  expect((await caio(domains)).status).toBe(403);

  await confirm("caio@acme.test");
  expect(await (await caio("/api/app/domain-workspaces")).json()).toEqual({
    workspaces: [{ id: orgId, name: "Acme", logo: null }],
  });
  const joined = await caio(`/api/app/domain-workspaces/${orgId}/join`, { json: {} });
  expect(joined.status).toBe(200);
  expect(await joined.json()).toEqual({ orgId });
  expect((await caio(`/api/app/organizations/${orgId}/members`)).status).toBe(200);

  expect((await owner(`${domains}/${domain.id}`, { method: "DELETE" })).status).toBe(204);
  expect(((await (await owner(domains)).json()) as { domains: unknown[] }).domains).toEqual([]);
});
