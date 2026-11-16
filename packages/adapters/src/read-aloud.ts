import { refuse, SpeechError, type SpeechFetch } from "./speech";

/**
 * Text to speech behind one interface (ADR 0209): an engine turns an agent's reply into audio. ElevenLabs, or a
 * server of one's own speaking the OpenAI speech format, so the words stay on the machine. Errors are `SpeechError`s,
 * as for voice messages: `auth` a refused key, `busy` worth another try, `refused` this text or voice.
 */
export interface ReadAloudInput {
  text: string;
  /** The engine's voice id: the agent's, else the server's default. */
  voice: string;
  /** The workspace it is for: only a server of one's own is told, to route or count by it. */
  orgId?: string;
}

export interface ReadAloudEngine {
  readonly id: ReadAloudEngineId;
  readonly model: string;
  /** The voice used when neither the agent nor the server names one. */
  readonly defaultVoice: string;
  /** The most characters one request takes. */
  readonly maxChars: number;
  speak(input: ReadAloudInput): Promise<{ audio: Uint8Array; contentType: string }>;
}

export const READ_ALOUD_ENGINES = ["elevenlabs", "local"] as const;
export type ReadAloudEngineId = (typeof READ_ALOUD_ENGINES)[number];

export interface ReadAloudCredentials {
  apiKey?: string;
  /** `local`: the base of a server speaking the OpenAI format (`http://tts:8880/v1`). */
  baseUrl?: string;
  /** `local`: the model it loads. */
  model?: string;
  /** The server's own default voice, over the engine's. */
  voice?: string;
}

/** A voice id as engines name them: ElevenLabs' ids, or a server's names like `pf_dora`. */
export const READ_ALOUD_VOICE = /^[A-Za-z0-9_.-]{1,100}$/;

const TIMEOUT_MS = 60_000;

async function audioOf(res: Response, name: string) {
  if (!res.ok) throw await refuse(res, name);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "audio/mpeg";
  if (!contentType.startsWith("audio/")) throw new SpeechError("refused", `${name} answered ${contentType}, not audio`);
  return { audio: new Uint8Array(await res.arrayBuffer()), contentType };
}

function elevenLabs(apiKey: string, voice: string | undefined, http: SpeechFetch): ReadAloudEngine {
  return {
    id: "elevenlabs",
    model: "eleven_flash_v2_5",
    // The voice ElevenLabs' own quickstart uses.
    defaultVoice: voice ?? "JBFqnCBsd6RMkjVDRZzb",
    maxChars: 40_000,
    async speak(input) {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`;
      const res = await http(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: input.text, model_id: "eleven_flash_v2_5" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return audioOf(res, "ElevenLabs");
    },
  };
}

function openAiFormat(credentials: ReadAloudCredentials & { baseUrl: string }, http: SpeechFetch): ReadAloudEngine {
  const base = credentials.baseUrl.replace(/\/+$/, "");
  const model = credentials.model ?? "tts-1";
  return {
    id: "local",
    model,
    defaultVoice: credentials.voice ?? "alloy",
    maxChars: 4096,
    async speak(input) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (credentials.apiKey) headers.authorization = `Bearer ${credentials.apiKey}`;
      if (input.orgId) headers["x-agentes-org"] = input.orgId;
      const res = await http(`${base}/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: input.text, voice: input.voice, response_format: "mp3" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return audioOf(res, "The speech server");
    },
  };
}

/** The engine for `id`, or null without what it needs (a key, an address). */
export function createReadAloudEngine(
  id: ReadAloudEngineId,
  credentials: ReadAloudCredentials,
  options: { fetch?: SpeechFetch } = {},
): ReadAloudEngine | null {
  const http = options.fetch ?? fetch;
  const voice = credentials.voice?.trim() || undefined;
  if (id === "elevenlabs") return credentials.apiKey ? elevenLabs(credentials.apiKey, voice, http) : null;
  const baseUrl = credentials.baseUrl?.trim();
  return baseUrl ? openAiFormat({ ...credentials, baseUrl, voice }, http) : null;
}
