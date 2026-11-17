import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

/**
 * "Mostrar quem escolheu o agente" over HTTP (ADR 0074 addendum 2026-11-16): the workspace's switch, off by default,
 * read by every member, changed only by who configures the workspace.
 */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

test("off by default, an admin turns it on, every member reads it and a member can't change it", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" } })).json()) as {
    organization: { id: string };
  };
  const settings = `/api/app/organizations/${created.organization.id}/settings`;
  const member = await joinByInvitation(t, owner, created.organization.id, "member@example.com");
  const read = async (b: typeof owner) =>
    ((await (await b(settings)).json()) as { routerCaption: boolean }).routerCaption;

  expect(await read(owner)).toBe(false);
  expect(await read(member)).toBe(false);
  expect((await member(settings, { method: "PATCH", json: { routerCaption: true } })).status).toBe(403);
  const saved = await owner(settings, { method: "PATCH", json: { routerCaption: true } });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { routerCaption: boolean }).routerCaption).toBe(true);
  expect(await read(member)).toBe(true);
  expect((await owner(settings, { method: "PATCH", json: { routerCaption: "yes" } })).status).toBe(400);
  expect(await read(member)).toBe(true);
});
