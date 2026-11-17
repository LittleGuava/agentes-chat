import { afterEach, beforeEach, expect, test } from "bun:test";
import { createArtifact } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

/** The desktop app asks with the main window's session, as the phone does: our cookie, no Origin, the app's header. */
const APP = { origin: null, headers: { "x-agentes-client": "mobile" } };

test("the desktop app lists the agents' files of a conversation and downloads one as the list says (ADR 0204)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const deps = t.engine.artifacts;
  if (!deps) throw new Error("the test server has no artifacts");
  const table = await createArtifact(deps, { type: "agent", agentId, channelId }, orgId, {
    title: "Vendas",
    content: { kind: "table", columns: ["mês", "total"], rows: [["março", "12"]] },
  });

  const listed = await owner(`/api/app/organizations/${orgId}/drive-sync?channelIds=${channelId}`, APP);
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    files: { id: string; name: string; version: number; format: string | null; agent: { name: string } }[];
    truncated: boolean;
  };
  expect(body).toMatchObject({
    truncated: false,
    files: [{ id: table.id, name: "Vendas.csv", version: 1, format: "csv", agent: { name: "Dev" } }],
  });

  const file = await owner(`/api/app/organizations/${orgId}/artifacts/${table.id}/file?version=1&format=csv`, APP);
  expect(file.status).toBe(200);
  expect(await file.text()).toContain("março,12");

  // The list needs the conversations, as ids.
  expect((await owner(`/api/app/organizations/${orgId}/drive-sync`, APP)).status).toBe(400);
  expect((await owner(`/api/app/organizations/${orgId}/drive-sync?channelIds=general`, APP)).status).toBe(400);
  // Without a session, nothing.
  expect((await browser(t)(`/api/app/organizations/${orgId}/drive-sync?channelIds=${channelId}`, APP)).status).toBe(
    401,
  );
});
