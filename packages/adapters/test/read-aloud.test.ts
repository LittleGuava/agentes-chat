import { describe, expect, test } from "bun:test";
import { createReadAloudEngine } from "../src/read-aloud";
import { SpeechError, type SpeechFetch } from "../src/speech";

type Call = { url: string; init?: RequestInit };

function fake(...answers: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers.shift() ?? new Response(new Uint8Array([1]));
  }) as unknown as SpeechFetch;
  return { fetch, calls };
}

const mp3 = () => new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { headers: { "content-type": "audio/mpeg" } });
const json = (call: Call | undefined) => JSON.parse(String(call?.init?.body));
const header = (call: Call | undefined, name: string) => new Headers(call?.init?.headers).get(name);

describe("createReadAloudEngine", () => {
  test("ElevenLabs: the voice in the path, flash v2.5, MP3, the key in its header", async () => {
    const f = fake(mp3());
    const engine = createReadAloudEngine("elevenlabs", { apiKey: "xi-key" }, { fetch: f.fetch });
    const out = await engine?.speak({ text: "Olá", voice: "JBFqnCBsd6RMkjVDRZzb" });
    expect(out).toEqual({ audio: new Uint8Array([0xff, 0xfb, 1, 2]), contentType: "audio/mpeg" });
    expect(f.calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128",
    );
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(header(f.calls[0], "xi-api-key")).toBe("xi-key");
    expect(json(f.calls[0])).toEqual({ text: "Olá", model_id: "eleven_flash_v2_5" });
    expect(engine?.defaultVoice).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  test("a server of one's own in the OpenAI format, with the workspace in a header", async () => {
    const f = fake(mp3());
    const engine = createReadAloudEngine(
      "local",
      { baseUrl: "http://tts:8880/v1/", model: "kokoro", apiKey: "k" },
      { fetch: f.fetch },
    );
    await engine?.speak({ text: "Oi", voice: "pf_dora", orgId: "org-1" });
    expect(f.calls[0]?.url).toBe("http://tts:8880/v1/audio/speech");
    expect(json(f.calls[0])).toEqual({ model: "kokoro", input: "Oi", voice: "pf_dora", response_format: "mp3" });
    expect(header(f.calls[0], "authorization")).toBe("Bearer k");
    expect(header(f.calls[0], "x-agentes-org")).toBe("org-1");
    expect(engine?.defaultVoice).toBe("alloy");
  });

  test("no key, or no address, is no engine", () => {
    expect(createReadAloudEngine("elevenlabs", {})).toBeNull();
    expect(createReadAloudEngine("local", { apiKey: "k" })).toBeNull();
  });

  test("a refused key says so, and never carries it", async () => {
    const f = fake(new Response("bad key", { status: 401 }));
    const engine = createReadAloudEngine("elevenlabs", { apiKey: "secret-key" }, { fetch: f.fetch });
    const error = await engine?.speak({ text: "Oi", voice: "v" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechError);
    expect((error as SpeechError).reason).toBe("auth");
    expect((error as SpeechError).message).not.toContain("secret-key");
  });

  test("an answer that isn't audio is refused", async () => {
    const f = fake(Response.json({ error: "x" }));
    const engine = createReadAloudEngine("elevenlabs", { apiKey: "k" }, { fetch: f.fetch });
    await expect(engine?.speak({ text: "Oi", voice: "v" })).rejects.toBeInstanceOf(SpeechError);
  });
});
