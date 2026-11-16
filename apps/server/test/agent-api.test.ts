import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { openWaits, sha256 } from "@agenteschat/engine";
import { connectApp, mcp } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Here is the launch copy."] }) });
});
afterEach(() => t.close());

async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { b, ownerId, ...seeded };
}

type Created = { key: { id: string; name: string; lastFour: string; expiresAt: string | null }; secret: string };

async function createKey(
  b: ReturnType<typeof browser>,
  orgId: string,
  agentId: string,
  input: { name?: string; expiresInDays?: number | null } = {},
) {
  return b(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys`, {
    json: { name: input.name ?? "CI bot", expiresInDays: input.expiresInDays === undefined ? 30 : input.expiresInDays },
  });
}

const send = (bearer: string | null, agent: string, body: Record<string, unknown>, ip = "203.0.113.9") =>
  t.app.request(`/api/agents/v1/${agent}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const result = (bearer: string, agent: string, messageId: string, wait = 0) =>
  t.app.request(`/api/agents/v1/${agent}/messages/${messageId}?wait_seconds=${wait}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });

type Result = {
  message_id: string;
  status: string;
  reply?: { id: string; text: string; truncated: boolean; url: string };
  conversation_url: string;
};

describe("keys", () => {
  test("whoever manages the agent creates a key, shown once, stored as a hash, listed without its secret", async () => {
    const { b, orgId, agentId, ownerId } = await setup();
    const res = await createKey(b, orgId, agentId);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Created;
    expect(created.secret).toMatch(/^agk_[0-9A-Za-z]{43}$/);
    expect(created.key.lastFour).toBe(created.secret.slice(-4));
    expect(created.key.expiresAt).not.toBeNull();
    const [row] = await t.db.select().from(schema.agentApiKeys);
    expect(row?.tokenHash).toBe(sha256(created.secret));
    expect(JSON.stringify(row)).not.toContain(created.secret);
    const list = (await (await b(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys`)).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({ id: created.key.id, name: "CI bot", createdBy: { id: ownerId } });
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent_api.key_created"));
    expect(audit[0]?.details).toMatchObject({ app: "CI bot", agentId });
  });

  test("a member who doesn't manage the agent can't create or list its keys", async () => {
    const { b, orgId, agentId } = await setup();
    const member = await joinByInvitation(t, b, orgId, "member@example.com");
    expect((await createKey(member, orgId, agentId)).status).toBe(403);
    expect((await member(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys`)).status).toBe(403);
  });

  test("revoked, expired, for another agent, a personal token, or no bearer: 401, and /mcp refuses the key", async () => {
    const { b, orgId, agentId } = await setup();
    const { secret, key } = (await (await createKey(b, orgId, agentId)).json()) as Created;
    const none = await send(null, agentId, { message: "hi" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    // Another agent by id or handle answers like an unknown key: a key can't probe the workspace's agents.
    expect((await send(secret, "00000000-0000-4000-8000-000000000000", { message: "hi" })).status).toBe(401);
    expect((await send(secret, "someone", { message: "hi" })).status).toBe(401);
    // The MCP endpoint takes only its own tokens, and this API only its own keys.
    expect((await mcp(t, secret, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const app = await connectApp(t, b, orgId);
    expect((await send(app.access, agentId, { message: "hi" })).status).toBe(401);

    await t.db
      .update(schema.agentApiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.agentApiKeys.id, key.id));
    expect((await send(secret, agentId, { message: "hi" })).status).toBe(401);
    await t.db.update(schema.agentApiKeys).set({ expiresAt: null }).where(eq(schema.agentApiKeys.id, key.id));
    expect((await send(secret, "@dev", { message: "hi", wait_seconds: 0 })).status).toBe(202);

    const revoked = await b(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys/${key.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);
    expect((await send(secret, agentId, { message: "hi" })).status).toBe(401);
    const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent_api.key_revoked"));
    expect(audit).toHaveLength(1);
  });

  test("the creator leaving the workspace ends their keys", async () => {
    const { b, orgId, agentId } = await setup();
    const admin = await joinByInvitation(t, b, orgId, "admin@example.com", { role: "admin" });
    const adminId = ((await (await admin("/api/app/me")).json()) as { user: { id: string } }).user.id;
    const created = await createKey(admin, orgId, agentId);
    expect(created.status).toBe(201);
    const { secret } = (await created.json()) as Created;
    expect((await send(secret, agentId, { message: "hi", wait_seconds: 0 })).status).toBe(202);
    expect((await b(`/api/app/organizations/${orgId}/members/${adminId}`, { method: "DELETE" })).status).toBe(204);
    expect((await send(secret, agentId, { message: "hi", wait_seconds: 0 })).status).toBe(401);
    const [row] = await t.db.select().from(schema.agentApiKeys);
    expect(row?.revokedAt).not.toBeNull();
  });

  test("past the key, a maker who no longer manages the agent, an archived agent or a paused workspace: 403, nothing sent", async () => {
    const { b, orgId, agentId } = await setup();
    const admin = await joinByInvitation(t, b, orgId, "admin@example.com", { role: "admin" });
    const adminId = ((await (await admin("/api/app/me")).json()) as { user: { id: string } }).user.id;
    const { secret } = (await (await createKey(admin, orgId, agentId)).json()) as Created;
    const posted = async () => (await t.db.select().from(schema.messages)).length;
    const refused = async (code: string) => {
      const before = await posted();
      const res = await send(secret, agentId, { message: "hi", wait_seconds: 0 });
      expect({ status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code }).toEqual({
        status: 403,
        code,
      });
      expect(await posted()).toBe(before);
    };

    // A plain member again: the key stays, but opens nothing while its maker doesn't manage the agent.
    expect(
      (await b(`/api/app/organizations/${orgId}/members/${adminId}/roles`, { method: "PUT", json: { roleIds: [] } }))
        .status,
    ).toBe(200);
    await refused("agent_api.not_manager");
    const [still] = await t.db.select().from(schema.agentApiKeys);
    expect(still?.revokedAt).toBeNull();

    const { secret: own } = (await (await createKey(b, orgId, agentId, { name: "Own" })).json()) as Created;
    const ownRefused = async (code: string) => {
      const before = await posted();
      const res = await send(own, agentId, { message: "hi", wait_seconds: 0 });
      expect({ status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code }).toEqual({
        status: 403,
        code,
      });
      expect(await posted()).toBe(before);
    };
    await t.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, agentId));
    await ownRefused("agent_api.agent_archived");
    await t.db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, agentId));
    await t.db.update(schema.organizations).set({ standing: "hold" }).where(eq(schema.organizations.id, orgId));
    const before = await posted();
    const paused = await send(own, agentId, { message: "hi", wait_seconds: 0 });
    expect(paused.status).toBe(403);
    expect(await posted()).toBe(before);
  });
});

describe("messages", () => {
  test("a message goes to the key's own room as its creator, and the reply comes back", async () => {
    const { b, orgId, agentId, ownerId } = await setup();
    const { secret, key } = (await (await createKey(b, orgId, agentId)).json()) as Created;
    const sent = await send(secret, agentId, { message: "Write the launch copy", wait_seconds: 0 });
    expect(sent.status).toBe(202);
    const s = (await sent.json()) as Result;
    expect(s.status).toBe("still_running");

    const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, s.message_id));
    expect(message?.authorUserId).toBe(ownerId);
    expect(message?.meta.via).toEqual({ kind: "app", name: "CI bot", apiKeyId: key.id });
    expect(message?.meta.readOutside).toBe(true);
    const [room] = await t.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, message?.channelId ?? ""));
    expect(room?.kind).toBe("dm");
    expect(room?.visibility).toBe("private");
    expect(room?.dmKey).toBe(`apikey|a:${agentId}|k:${key.id}|u:${ownerId}`);
    expect(s.conversation_url).toBe(`${ORIGIN}/org/${orgId}/c/${room?.id}`);
    // Not the person's own DM with the agent, and not in their DM list.
    const { dms } = (await (await b(`/api/app/organizations/${orgId}/dms`)).json()) as { dms: { channelId: string }[] };
    expect(dms.map((d) => d.channelId)).not.toContain(room?.id);
    const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent_api.message_sent"));
    expect(audit[0]?.details).toMatchObject({ app: "CI bot", agentId, keyId: key.id });

    const waiting = result(secret, agentId, s.message_id, 20);
    await Bun.sleep(50);
    await t.drain();
    const done = await waiting;
    expect(done.status).toBe(200);
    const d = (await done.json()) as Result;
    expect(d.status).toBe("done");
    expect(d.reply?.text).toBe("Here is the launch copy.");
    expect(openWaits()).toBe(0);
    // The agent read where it came from.
    expect(JSON.stringify(t.provider.calls.at(-1)?.request.messages)).toContain(
      "through CI bot, an app connected to agentes.chat",
    );
    // The caller reads the reply: the creator isn't rung for it.
    const rung = await t.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, ownerId), eq(schema.notifications.kind, "agent_reply")));
    expect(rung).toHaveLength(0);

    // A second message stays in the same room.
    const again = (await (await send(secret, "dev", { message: "Shorter", wait_seconds: 0 })).json()) as Result;
    const [second] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, again.message_id));
    expect(second?.channelId).toBe(room?.id);
  });

  test("a result is read only by the key that sent it", async () => {
    const { b, orgId, agentId, channelId } = await setup();
    const one = (await (await createKey(b, orgId, agentId, { name: "One" })).json()) as Created;
    const two = (await (await createKey(b, orgId, agentId, { name: "Two" })).json()) as Created;
    const sent = (await (await send(one.secret, agentId, { message: "hi", wait_seconds: 0 })).json()) as Result;
    expect((await result(one.secret, agentId, sent.message_id)).status).toBe(202);
    expect((await result(two.secret, agentId, sent.message_id)).status).toBe(404);
    const [general] = await t.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));
    if (general) expect((await result(one.secret, agentId, general.id)).status).toBe(404);
    expect((await result(one.secret, agentId, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  test("the same idempotency key sends once; a bad body is 400", async () => {
    const { b, orgId, agentId } = await setup();
    const { secret } = (await (await createKey(b, orgId, agentId)).json()) as Created;
    const body = { message: "Deploy notes", wait_seconds: 0, idempotency_key: "run-42" };
    const first = (await (await send(secret, agentId, body)).json()) as Result;
    const second = (await (await send(secret, agentId, body)).json()) as Result;
    expect(second.message_id).toBe(first.message_id);
    expect((await send(secret, agentId, { message: "" })).status).toBe(400);
    expect((await send(secret, agentId, { message: "x".repeat(20_001) })).status).toBe(400);
    expect((await send(secret, agentId, { message: "hi", wait_seconds: 46 })).status).toBe(400);
  });

  test("sending is limited per key: 429 with Retry-After", async () => {
    const { b, orgId, agentId } = await setup();
    const { secret } = (await (await createKey(b, orgId, agentId)).json()) as Created;
    for (let i = 0; i < 20; i++)
      expect((await send(secret, agentId, { message: `n${i}`, wait_seconds: 0 })).status).toBe(202);
    const limited = await send(secret, agentId, { message: "one more", wait_seconds: 0 });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("the OpenAPI document describes the API with its bearer scheme", async () => {
    const doc = (await (await t.app.request("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths)).toContain("/agents/v1/{agent}/messages");
    expect(Object.keys(doc.paths)).toContain("/agents/v1/{agent}/messages/{messageId}");
    expect(doc.components.securitySchemes.agentKey).toEqual({ type: "http", scheme: "bearer" });
  });
});

describe("the key's card and its room", () => {
  type Listed = { keys: { id: string; roomId: string | null }[]; endpoint: string };
  const listOf = async (b: ReturnType<typeof browser>, orgId: string, agentId: string) =>
    (await (await b(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys`)).json()) as Listed;

  test("the list says where to send, and the room of each of my keys once it has one", async () => {
    const { b, orgId, agentId } = await setup();
    const admin = await joinByInvitation(t, b, orgId, "admin@example.com", { role: "admin" });
    const mine = (await (await createKey(b, orgId, agentId, { name: "Mine" })).json()) as Created;
    const theirs = (await (await createKey(admin, orgId, agentId, { name: "Theirs" })).json()) as Created;

    const before = await listOf(b, orgId, agentId);
    // This server's own address, with the agent's id: a rename of its handle doesn't break a script.
    expect(before.endpoint).toBe(`${ORIGIN}/api/agents/v1/${agentId}/messages`);
    expect(before.keys.map((k) => k.roomId)).toEqual([null, null]);

    const sentMine = (await (await send(mine.secret, agentId, { message: "hi", wait_seconds: 0 })).json()) as Result;
    await send(theirs.secret, agentId, { message: "hi", wait_seconds: 0 });
    const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, sentMine.message_id));
    const after = await listOf(b, orgId, agentId);
    // Only the maker reads a key's room: another manager's key shows none to me.
    expect(Object.fromEntries(after.keys.map((k) => [k.id, k.roomId]))).toEqual({
      [mine.key.id]: message?.channelId ?? "",
      [theirs.key.id]: null,
    });
  });

  test("a key's room opens by its channel for its maker only: the agent and the key, nothing for anyone else", async () => {
    const { b, orgId, agentId, channelId } = await setup();
    const admin = await joinByInvitation(t, b, orgId, "admin@example.com", { role: "admin" });
    const { secret, key } = (await (await createKey(b, orgId, agentId, { name: "Deploy bot" })).json()) as Created;
    const sent = (await (await send(secret, agentId, { message: "hi", wait_seconds: 0 })).json()) as Result;
    const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, sent.message_id));
    const room = message?.channelId ?? "";
    const lookUp = (who: ReturnType<typeof browser>, channel: string) =>
      who(`/api/app/organizations/${orgId}/agent-key-rooms/${channel}`);

    const found = await lookUp(b, room);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ agentId, keyId: key.id, keyName: "Deploy bot" });
    // An admin reads every channel, never a DM (ADR 0151): nor a key's room.
    expect((await lookUp(admin, room)).status).toBe(404);
    // Any other conversation isn't a key's room.
    expect((await lookUp(b, channelId)).status).toBe(404);
    expect((await lookUp(b, "00000000-0000-4000-8000-000000000000")).status).toBe(404);

    // Revoked, its room stays readable to its maker, by the name it had.
    await b(`/api/app/organizations/${orgId}/agents/${agentId}/api-keys/${key.id}`, { method: "DELETE" });
    expect(await (await lookUp(b, room)).json()).toEqual({ agentId, keyId: key.id, keyName: "Deploy bot" });
  });
});
