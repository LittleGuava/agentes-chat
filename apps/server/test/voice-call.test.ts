import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/**
 * A voice call over HTTP (ADR 0198): a take goes as a voice message, the agent answers as always, and its reply comes
 * back as audio from the text-to-speech server. The speech servers are fakes, by address.
 */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TTS = "http://tts.test/v1";

function speechServers() {
  const read: { text: string; voice: string; org: string | null }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(TTS)) {
      const body = JSON.parse(String(init?.body)) as { input: string; voice: string };
      const headers = (init?.headers ?? {}) as Record<string, string>;
      read.push({ text: body.input, voice: body.voice, org: headers["x-agentes-org"] ?? null });
      return new Response(new TextEncoder().encode(`mp3 of ${body.input}`), {
        headers: { "content-type": "audio/mpeg" },
      });
    }
    // Groq, for the take's words.
    return Response.json({ text: "Como está o deploy?" });
  }) as unknown as typeof globalThis.fetch;
  return { read, fetch };
}

async function start(env: Record<string, string> = { VOICE_CALL_SPEECH_URL: TTS, VOICE_CALL_SPEECH_VOICE: "pf_dora" }) {
  const servers = speechServers();
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", GROQ_API_KEY: "groq-key-1234", ...env },
    speechFetch: servers.fetch,
    reply: () => ({ chunks: ["O deploy terminou **bem**.\n\n```sh\nbun test\n```"] }),
  });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const dm = ((await (await api("/dms", { json: { agentId } })).json()) as { channelId: string }).channelId;
  return { server, owner, api, orgId, dm, read: servers.read };
}

type Listed = { id: string; body: string; clientId?: string | null; author: { type: string } };

test("a take becomes a voice message, the agent answers, and its reply comes back read aloud", async () => {
  const { server, api, orgId, dm, read } = await start();
  const settings = (await (await api("/settings")).json()) as { voiceCallAvailable: boolean };
  expect(settings.voiceCallAvailable).toBe(true);

  const form = new FormData();
  form.set("file", new File([new Uint8Array(32)], "voice.webm"));
  form.set("durationMs", "2000");
  form.set("clientId", "take-1");
  expect((await api(`/channels/${dm}/voice`, { method: "POST", body: form })).status).toBe(202);
  await server.drain();
  await server.drain();

  const { messages } = (await (await api(`/channels/${dm}/messages`)).json()) as { messages: Listed[] };
  const take = messages.findIndex((m) => m.clientId === "take-1");
  expect(messages[take]?.body).toBe("Como está o deploy?");
  const reply = messages.slice(take + 1).find((m) => m.author.type === "agent");
  if (!reply) throw new Error("the agent didn't answer");

  const res = await api(`/messages/${reply.id}/speech`, { json: {} });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe("mp3 of O deploy terminou bem.");
  expect(read).toEqual([{ text: "O deploy terminou bem.", voice: "pf_dora", org: orgId }]);

  // The take itself is a person's: nothing to read back.
  const own = await api(`/messages/${messages[take]?.id}/speech`, { json: {} });
  expect(own.status).toBe(422);
  expect(((await own.json()) as { error: { code: string } }).error.code).toBe("voice_call.not_agent");
});

test("someone outside the conversation hears nothing", async () => {
  const { server, api, orgId, dm } = await start();
  await api(`/channels/${dm}/messages`, { json: { body: "oi" } });
  await server.drain();
  const { messages } = (await (await api(`/channels/${dm}/messages`)).json()) as { messages: Listed[] };
  const reply = messages.find((m) => m.author.type === "agent");
  if (!reply) throw new Error("the agent didn't answer");
  const stranger = browser(server);
  await signUp(stranger, "stranger@example.com");
  const res = await stranger(`/api/app/organizations/${orgId}/messages/${reply.id}/speech`, { json: {} });
  expect([403, 404]).toContain(res.status);
});

test("without a text-to-speech server there are no calls", async () => {
  const { server, api, dm } = await start({});
  expect(((await (await api("/settings")).json()) as { voiceCallAvailable: boolean }).voiceCallAvailable).toBe(false);
  await api(`/channels/${dm}/messages`, { json: { body: "oi" } });
  await server.drain();
  const { messages } = (await (await api(`/channels/${dm}/messages`)).json()) as { messages: Listed[] };
  const reply = messages.find((m) => m.author.type === "agent");
  const res = await api(`/messages/${reply?.id}/speech`, { json: {} });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("voice_call.unavailable");
});
