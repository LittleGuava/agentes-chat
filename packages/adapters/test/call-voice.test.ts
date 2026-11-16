import { expect, test } from "bun:test";
import { createCallVoice, SpeechError } from "../src";

/** Text to speech for voice calls (ADR 0198): a server in the OpenAI speech format. */

type Call = { url: string; init: RequestInit };

function server(answer: () => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });

test("no address, no engine: calls stay off", () => {
  expect(createCallVoice({})).toBeNull();
  expect(createCallVoice({ baseUrl: "  " })).toBeNull();
});

test("the words go to /audio/speech with the model, the voice, the key and the workspace; the audio comes back", async () => {
  const s = server(mp3);
  const voice = createCallVoice(
    { baseUrl: "http://tts.test/v1/", apiKey: "own-key", model: "kokoro", voice: "pf_dora" },
    { fetch: s.fetch },
  );
  expect(voice?.defaultVoice).toBe("pf_dora");
  const out = await voice?.speak({ text: "Oi, tudo certo.", voice: "pf_dora", orgId: "org-1" });
  expect(out).toEqual({ audio: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg" });
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]?.url).toBe("http://tts.test/v1/audio/speech");
  expect(s.calls[0]?.init.method).toBe("POST");
  expect(s.calls[0]?.init.headers).toEqual({
    "content-type": "application/json",
    authorization: "Bearer own-key",
    "x-agentes-org": "org-1",
  });
  expect(JSON.parse(String(s.calls[0]?.init.body))).toEqual({
    model: "kokoro",
    input: "Oi, tudo certo.",
    voice: "pf_dora",
    response_format: "mp3",
  });
});

test("OpenAI's own defaults when the server names no model or voice, and no key header without a key", async () => {
  const s = server(mp3);
  const voice = createCallVoice({ baseUrl: "http://tts.test/v1" }, { fetch: s.fetch });
  expect(voice?.defaultVoice).toBe("alloy");
  await voice?.speak({ text: "Oi", voice: "alloy" });
  expect(JSON.parse(String(s.calls[0]?.init.body)).model).toBe("tts-1");
  expect(s.calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
});

test("a refused key, a busy server and an answer that isn't audio are speech errors", async () => {
  const kinds: string[] = [];
  for (const answer of [
    () => new Response("no", { status: 401 }),
    () => new Response("later", { status: 503 }),
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
  ]) {
    const voice = createCallVoice({ baseUrl: "http://tts.test/v1" }, { fetch: server(answer).fetch });
    const error = await voice?.speak({ text: "Oi", voice: "alloy" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechError);
    kinds.push((error as SpeechError).reason);
  }
  expect(kinds).toEqual(["auth", "busy", "refused"]);
});
