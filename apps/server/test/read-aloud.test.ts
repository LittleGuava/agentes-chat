import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** Agents' replies read aloud over HTTP (ADR 0209): the switch, making the audio once, playing it, the agent's voice. */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A fake ElevenLabs: MP3 bytes for any text, and the voices it was asked for. */
function elevenLabs() {
  const voices: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    voices.push(decodeURIComponent(String(url).split("/text-to-speech/")[1]?.split("?")[0] ?? ""));
    return new Response(new Uint8Array([0xff, 0xfb, 7, 7]), { headers: { "content-type": "audio/mpeg" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fake, voices };
}

async function start(env: Record<string, string>) {
  const fake = elevenLabs();
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", ELEVENLABS_API_KEY: "xi-key-1234", ...env },
    speechFetch: fake.fetch,
    signedBlobs: false,
  });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const [reply] = await server.db
    .insert(schema.messages)
    .values({
      orgId: seeded.orgId,
      channelId: seeded.channelId,
      authorType: "agent",
      authorAgentId: seeded.agentId,
      body: "O deploy **passou**.",
    })
    .returning();
  if (!reply) throw new Error("no reply");
  return { server, owner, fake, ...seeded, replyId: reply.id };
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("off by default: a voice key alone reads nothing aloud", async () => {
  const { owner, orgId, replyId } = await start({});
  const on = (await (await owner(`/api/app/organizations/${orgId}/read-aloud`)).json()) as { available: boolean };
  expect(on.available).toBe(false);
  const res = await owner(`/api/app/organizations/${orgId}/messages/${replyId}/read-aloud`, { json: {} });
  expect(res.status).toBe(409);
  expect(await errorCode(res)).toBe("read_aloud.unavailable");
});

test("a reply is read once, in its agent's voice, and played with ranges", async () => {
  const { owner, orgId, agentId, replyId, fake } = await start({ READ_ALOUD_ENGINE: "elevenlabs" });
  const on = (await (await owner(`/api/app/organizations/${orgId}/read-aloud`)).json()) as { available: boolean };
  expect(on.available).toBe(true);

  const patched = await owner(`/api/app/organizations/${orgId}/agents/${agentId}`, {
    method: "PATCH",
    json: { readAloudVoice: "pNInz6obpgDQGcFmaJgB" },
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { readAloudVoice: string | null }).readAloudVoice).toBe("pNInz6obpgDQGcFmaJgB");

  const ask = () => owner(`/api/app/organizations/${orgId}/messages/${replyId}/read-aloud`, { json: {} });
  const first = await ask();
  expect(first.status).toBe(200);
  const { clipId } = (await first.json()) as { clipId: string };
  expect(((await (await ask()).json()) as { clipId: string }).clipId).toBe(clipId);
  expect(fake.voices).toEqual(["pNInz6obpgDQGcFmaJgB"]);

  const audio = await owner(`/api/app/organizations/${orgId}/read-aloud/${clipId}/audio`);
  expect(audio.status).toBe(200);
  expect(audio.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 7, 7]));
  const part = await owner(`/api/app/organizations/${orgId}/read-aloud/${clipId}/audio`, {
    headers: { range: "bytes=0-1" },
  });
  expect(part.status).toBe(206);
});

test("a stranger can't read or play it, and a bad voice is refused", async () => {
  const { server, owner, orgId, agentId, replyId } = await start({ READ_ALOUD_ENGINE: "elevenlabs" });
  const stranger = browser(server);
  await signUp(stranger, "stranger@example.com");
  const res = await stranger(`/api/app/organizations/${orgId}/messages/${replyId}/read-aloud`, { json: {} });
  expect(res.status).toBe(403);
  const { clipId } = (await (
    await owner(`/api/app/organizations/${orgId}/messages/${replyId}/read-aloud`, { json: {} })
  ).json()) as { clipId: string };
  expect((await stranger(`/api/app/organizations/${orgId}/read-aloud/${clipId}/audio`)).status).toBe(403);
  const bad = await owner(`/api/app/organizations/${orgId}/agents/${agentId}`, {
    method: "PATCH",
    json: { readAloudVoice: "../../etc" },
  });
  expect(bad.status).toBe(400);
});

test("an engine that fails says so without its words", async () => {
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", ELEVENLABS_API_KEY: "xi-key-1234", READ_ALOUD_ENGINE: "elevenlabs" },
    speechFetch: (async () => new Response("quota of account 42 exceeded", { status: 429 })) as unknown as typeof fetch,
    signedBlobs: false,
  });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const [reply] = await server.db
    .insert(schema.messages)
    .values({ orgId, channelId, authorType: "agent", authorAgentId: agentId, body: "Oi" })
    .returning();
  const res = await owner(`/api/app/organizations/${orgId}/messages/${reply?.id}/read-aloud`, { json: {} });
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(text).toContain("read_aloud.busy");
  expect(text).not.toContain("account 42");
  expect(
    await errorCode(
      await owner(`/api/app/organizations/${orgId}/messages/${crypto.randomUUID()}/read-aloud`, { json: {} }),
    ),
  ).toBe("not_found");
});
