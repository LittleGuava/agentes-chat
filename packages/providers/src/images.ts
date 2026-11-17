import { ProviderError, shortSaid } from "./types";

/**
 * Image generation for every brain (ADR 0213): a provider makes one picture from words. Provider-neutral; only the
 * Model Gateway calls it (`gateway.generateImage`), on the workspace's own key for that provider, and records what it
 * cost on the agent's budget.
 */

/** The providers that make images, in the order the gateway picks the first one the workspace has a key for. */
export const IMAGE_PROVIDERS = ["openai", "gemini"] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDERS)[number];

/** A picture's proportions as an agent asks for them; each provider turns it into a size it takes. */
export const IMAGE_SHAPES = ["square", "portrait", "landscape"] as const;
export type ImageShape = (typeof IMAGE_SHAPES)[number];

const SIZES: Record<ImageShape, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };

/** One picture, decoded, at most this big: anything larger is refused before it reaches storage. */
export const IMAGE_BYTES_MAX = 10 * 1024 * 1024;
/** The words of a request, at most. */
export const IMAGE_PROMPT_CHARS = 4000;

export interface ImageRequest {
  model: string;
  prompt: string;
  shape: ImageShape;
  signal?: AbortSignal;
}

export interface ImageResult {
  bytes: Uint8Array;
  /** `image/png`, `image/jpeg` or `image/webp`, read from the bytes themselves. */
  contentType: string;
  /** The model that answered. */
  model: string;
  /** Tokens the provider reported, when it did (recorded, never priced: the price is per picture). */
  inputTokens: number;
  outputTokens: number;
}

export interface ImageProvider {
  readonly id: string;
  generate(
    request: ImageRequest,
    key: { apiKey: string; organization?: string; project?: string },
  ): Promise<ImageResult>;
}

export interface ImageModel {
  provider: ImageProviderId;
  /** Nano-USD per picture, by its shape. */
  nanoUsd: Record<ImageShape, number>;
}

/**
 * Image models by id, priced per picture (verify before billing customers), read on 2026-11-15: OpenAI's gpt-image-2 at
 * `medium` quality, $0.053 square and $0.041 portrait or landscape (developers.openai.com, image generation guide's
 * output cost table; the prompt's few text tokens are left out); Google's gemini-2.5-flash-image, $0.039 a picture up to
 * 1024×1024 on the Standard tier (aistudio.google.com/docs/pricing; deprecated, shut down on 2027-03-15). The picture's
 * price is what the agent's budget is held for and charged.
 */
export const IMAGE_MODELS: Record<string, ImageModel> = {
  "gpt-image-2": { provider: "openai", nanoUsd: { square: 53_000_000, portrait: 41_000_000, landscape: 41_000_000 } },
  "gemini-2.5-flash-image": {
    provider: "gemini",
    nanoUsd: { square: 39_000_000, portrait: 39_000_000, landscape: 39_000_000 },
  },
};

/** The model each provider makes pictures with. */
export const IMAGE_MODEL_OF: Record<ImageProviderId, string> = {
  openai: "gpt-image-2",
  gemini: "gemini-2.5-flash-image",
};

/** What one picture of `model` in `shape` costs, in nano-USD; 0 for a model not in `IMAGE_MODELS`. */
export const imageCostNanoUsd = (model: string, shape: ImageShape) => IMAGE_MODELS[model]?.nanoUsd[shape] ?? 0;

/** A picture's type from its first bytes (PNG, JPEG, WebP); null for anything else. */
export function imageTypeOf(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? 0;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** A picture's bytes from base64, checked: a known type and within `IMAGE_BYTES_MAX`. */
export function imageFromBase64(b64: unknown): { bytes: Uint8Array; contentType: string } {
  if (typeof b64 !== "string" || b64 === "") throw new ProviderError("the provider sent no image", false);
  // Base64 takes 4 characters for 3 bytes: a string this long can only decode past the cap.
  if (b64.length > Math.ceil((IMAGE_BYTES_MAX * 4) / 3) + 4) {
    throw new ProviderError("the provider's image is larger than 10 MB", false);
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const contentType = imageTypeOf(bytes);
  if (!contentType) throw new ProviderError("the provider sent something that isn't a PNG, JPEG or WebP image", false);
  return { bytes, contentType };
}

/** Retryable as the text adapters say it: rate limits, overload and the network. */
const retryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * The OpenAI Images API (`POST /images/generations`), which Google also serves for Gemini's image models on its
 * OpenAI-compatible address. One picture a call, returned as base64 in the answer, never a link to fetch.
 * `legacyBase64`: the server wants `response_format: "b64_json"` (Google's); OpenAI's GPT image models refuse it.
 */
function createImagesApi(options: {
  id: ImageProviderId;
  baseURL: string;
  legacyBase64: boolean;
  fetch?: typeof fetch;
}): ImageProvider {
  const http = options.fetch ?? fetch;
  return {
    id: options.id,
    async generate(request, key) {
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        size: SIZES[request.shape],
        n: 1,
        ...(options.legacyBase64 ? { response_format: "b64_json" } : { quality: "medium", output_format: "png" }),
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${key.apiKey}`,
        ...(key.organization ? { "openai-organization": key.organization } : {}),
        ...(key.project ? { "openai-project": key.project } : {}),
      };
      let res: Response;
      try {
        res = await http(`${options.baseURL}/images/generations`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch {
        if (request.signal?.aborted) throw new ProviderError("the image took too long or was stopped", false, 408);
        throw new ProviderError("could not reach provider", true);
      }
      const json = (await res.json().catch(() => null)) as {
        data?: { b64_json?: string }[];
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        const said = shortSaid(json?.error?.message ?? "");
        throw new ProviderError(
          `${options.id} image generation failed (HTTP ${res.status}, model ${request.model})`,
          retryableStatus(res.status),
          res.status,
          undefined,
          said || undefined,
        );
      }
      const image = imageFromBase64(json?.data?.[0]?.b64_json);
      return {
        ...image,
        model: typeof json?.model === "string" && json.model ? json.model : request.model,
        inputTokens: Math.max(0, Math.round(json?.usage?.input_tokens ?? 0)),
        outputTokens: Math.max(0, Math.round(json?.usage?.output_tokens ?? 0)),
      };
    },
  };
}

/** OpenAI's images, on the workspace's OpenAI key. */
export const createOpenAIImages = (options: { baseURL?: string; fetch?: typeof fetch } = {}) =>
  createImagesApi({
    id: "openai",
    baseURL: options.baseURL ?? "https://api.openai.com/v1",
    legacyBase64: false,
    fetch: options.fetch,
  });

/** Gemini's images through Google's OpenAI-compatible address, on the workspace's Gemini key. */
export const createGeminiImages = (options: { baseURL?: string; fetch?: typeof fetch } = {}) =>
  createImagesApi({
    id: "gemini",
    baseURL: options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    legacyBase64: true,
    fetch: options.fetch,
  });

/** The server's image providers, one per entry of `IMAGE_PROVIDERS`. */
export function createImageProviders(): Record<ImageProviderId, ImageProvider> {
  return { openai: createOpenAIImages(), gemini: createGeminiImages() };
}
