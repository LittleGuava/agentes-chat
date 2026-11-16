import { afterEach, expect, test } from "bun:test";
import { count, eq, schema } from "@agenteschat/db";
import { VOICE_MAX_BYTES } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Dictation over HTTP (ADR 0100 addendum): the words come back to the box, no message is posted, no audio is kept. */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A fake Groq: the words of any recording. */
const groq = (async () => Response.json({ text: "Ada, puxa as vendas" })) as unknown as typeof fetch;

async function start(env: Record<string, string> = {}, origin?: string) {
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", GROQ_API_KEY: "groq-key-1234", ...env },
    speechFetch: groq,
    signedBlobs: false,
  });
  t = server;
  const owner = browser(server);
  if (!origin) {
    await signUp(owner, "owner@example.com");
    const { orgId, channelId } = await seedOrg(owner);
    return { server, owner, orgId, channelId };
  }
  // On agentes.chat's own address (fair use is only there), every write says it comes from there.
  await owner("/api/auth/sign-up/email", {
    json: { email: "owner@example.com", password: "correct horse battery", name: "Owner" },
    origin,
  });
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" }, origin })).json()) as {
    organization: { id: string };
    generalChannelId: string;
  };
  return { server, owner, orgId: created.organization.id, channelId: created.generalChannelId };
}

function dictate(b: Browser, orgId: string, channelId: string, over: Record<string, string> = {}, origin?: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(32)], "voice.webm"));
  form.set("durationMs", "2000");
  form.set("language", "pt");
  for (const [key, value] of Object.entries(over)) form.set(key, value);
  return b(`/api/app/organizations/${orgId}/channels/${channelId}/voice/dictation`, {
    method: "POST",
    body: form,
    ...(origin ? { origin } : {}),
  });
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const messageCount = async (server: TestServer, orgId: string) =>
  (await server.db.select({ n: count() }).from(schema.messages).where(eq(schema.messages.orgId, orgId)))[0]?.n ?? 0;

test("answers the words and posts no message", async () => {
  const { server, owner, orgId, channelId } = await start();
  const before = await messageCount(server, orgId);
  const res = await dictate(owner, orgId, channelId);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "Ada, puxa as vendas" });
  expect(await messageCount(server, orgId)).toBe(before);
  const [clip] = await server.db.select().from(schema.voiceClips).where(eq(schema.voiceClips.orgId, orgId));
  expect(clip).toMatchObject({ status: "dictated", size: 0, blobKey: "", messageId: null });
});

test("only who may write in the conversation, and only with voice on", async () => {
  const { server, owner, orgId, channelId } = await start();
  const stranger = browser(server);
  await signUp(stranger, "stranger@example.com");
  expect([403, 404]).toContain((await dictate(stranger, orgId, channelId)).status);

  const member = await joinByInvitation(server, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const { roles } = (await (await owner(`${org}/roles`)).json()) as { roles: { id: string; kind: string }[] };
  const everyone = roles.find((r) => r.kind === "everyone")?.id ?? "";
  await owner(`${org}/channels/${channelId}/permissions`, {
    method: "PUT",
    json: { target: { type: "role", id: everyone }, allow: [], deny: ["post"] },
  });
  expect((await dictate(member, orgId, channelId)).status).toBe(403);

  await owner(`${org}/settings`, { method: "PATCH", json: { voiceMessages: false } });
  const off = await dictate(owner, orgId, channelId);
  expect(off.status).toBe(409);
  expect(await errorCode(off)).toBe("voice.unavailable");
});

test("what isn't audio is refused", async () => {
  const { owner, orgId, channelId } = await start();
  const form = new FormData();
  form.set("file", new File([new Uint8Array(32)], "page.html"));
  form.set("durationMs", "2000");
  const res = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/voice/dictation`, {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await errorCode(res)).toBe("voice.bad_type");
});

test("on agentes.chat, dictation and voice messages share one fair-use budget", async () => {
  const origin = "https://app.agentes.chat";
  const { owner, orgId, channelId } = await start(
    { PUBLIC_URL: origin, VOICE_LIMIT_PERSON_MINUTES_PER_DAY: "1" },
    origin,
  );
  expect((await dictate(owner, orgId, channelId, { durationMs: "90000" }, origin)).status).toBe(200);
  const again = await dictate(owner, orgId, channelId, {}, origin);
  expect(again.status).toBe(429);
  expect(await errorCode(again)).toBe("voice_limit");
  const allowed = await owner(`/api/app/organizations/${orgId}/voice/allowed`, { origin });
  expect(await allowed.json()).toEqual({ allowed: false });
});

test("a recording past the size is refused even when the request states no length", async () => {
  const { owner, orgId, channelId } = await start();
  const chunk = new Uint8Array(1024 * 1024);
  let left = VOICE_MAX_BYTES / chunk.length + 2;
  const res = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/voice/dictation`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left-- > 0) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  });
  expect(res.status).toBe(413);
  expect(await errorCode(res)).toBe("voice.too_large");
});
