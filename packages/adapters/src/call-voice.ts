import { refuse, SpeechError, type SpeechFetch } from "./speech";

/**
 * Text to speech for voice calls (ADR 0198): an agent's reply as audio. The least a call needs, so ADR 0209's
 * `ReadAloudEngine` fits it as it is. Errors are `SpeechError`s, as for voice messages: `auth` a refused key, `busy`
 * worth another try, `refused` this text or voice.
 */
export interface CallVoice {
  readonly id: string;
  /** The voice used when nobody names one. */
  readonly defaultVoice: string;
  /** The most characters one request takes. */
  readonly maxChars: number;
  speak(input: { text: string; voice: string; orgId?: string }): Promise<{ audio: Uint8Array; contentType: string }>;
}

export interface CallVoiceSettings {
  /** The base of a server speaking the OpenAI speech format (`https://api.openai.com/v1`, `http://tts:8880/v1`). */
  baseUrl?: string;
  apiKey?: string;
  /** Default `tts-1`. */
  model?: string;
  /** Default `alloy`. */
  voice?: string;
}

const TIMEOUT_MS = 60_000;

/** The engine for these settings, or null without an address: calls are off. */
export function createCallVoice(settings: CallVoiceSettings, options: { fetch?: SpeechFetch } = {}): CallVoice | null {
  const base = settings.baseUrl?.trim().replace(/\/+$/, "");
  if (!base) return null;
  const http = options.fetch ?? fetch;
  const model = settings.model?.trim() || "tts-1";
  return {
    id: "openai-format",
    defaultVoice: settings.voice?.trim() || "alloy",
    maxChars: 4096,
    async speak(input) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
      if (input.orgId) headers["x-agentes-org"] = input.orgId;
      const res = await http(`${base}/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: input.text, voice: input.voice, response_format: "mp3" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await refuse(res, "The speech server");
      const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "audio/mpeg";
      if (!contentType.startsWith("audio/")) {
        throw new SpeechError("refused", `The speech server answered ${contentType}, not audio`);
      }
      return { audio: new Uint8Array(await res.arrayBuffer()), contentType };
    },
  };
}
