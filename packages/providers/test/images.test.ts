import { describe, expect, test } from "bun:test";
import {
  createGeminiImages,
  createOpenAIImages,
  IMAGE_BYTES_MAX,
  imageCostNanoUsd,
  imageFromBase64,
  ProviderError,
} from "../src";
import { FAKE_PNG } from "../src/fake";

// Image providers (ADR 0213): the OpenAI Images API, which Google also serves for Gemini on its OpenAI-compatible
// address. One picture a call, as base64, checked to be a picture before it goes anywhere.

const PNG_B64 = Buffer.from(FAKE_PNG).toString("base64");

/** A transport that answers `body` with `status` and keeps what it was asked. */
function transport(status: number, body: unknown) {
  const asked: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("OpenAI", () => {
  test("asks for one picture of the shape's size, on the key, and returns its bytes", async () => {
    const t = transport(200, { data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 20, output_tokens: 1056 } });
    const result = await createOpenAIImages({ fetch: t.fetch }).generate(
      { model: "gpt-image-2", prompt: "A rocket", shape: "landscape" },
      { apiKey: "sk-test", project: "proj_1" },
    );
    expect(t.asked[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(t.asked[0]?.headers).toMatchObject({ authorization: "Bearer sk-test", "openai-project": "proj_1" });
    expect(t.asked[0]?.body).toEqual({
      model: "gpt-image-2",
      prompt: "A rocket",
      size: "1536x1024",
      n: 1,
      quality: "medium",
      output_format: "png",
    });
    expect(result).toMatchObject({
      contentType: "image/png",
      model: "gpt-image-2",
      inputTokens: 20,
      outputTokens: 1056,
    });
    expect([...result.bytes]).toEqual([...FAKE_PNG]);
  });

  test("a refusal names the provider, its status and model, and keeps the provider's words apart", async () => {
    const t = transport(400, { error: { message: "Your request was rejected by the safety system." } });
    const failed = await createOpenAIImages({ fetch: t.fetch })
      .generate({ model: "gpt-image-2", prompt: "x", shape: "square" }, { apiKey: "sk-test" })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).message).toBe("openai image generation failed (HTTP 400, model gpt-image-2)");
    expect((failed as ProviderError).said).toContain("safety system");
    expect((failed as ProviderError).retryable).toBe(false);
  });
});

describe("Gemini", () => {
  test("goes to Google's OpenAI-compatible address and asks for base64", async () => {
    const t = transport(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await createGeminiImages({ fetch: t.fetch }).generate(
      { model: "gemini-2.5-flash-image", prompt: "A rocket", shape: "square" },
      { apiKey: "AIza-test" },
    );
    expect(t.asked[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/images/generations");
    expect(t.asked[0]?.body).toMatchObject({ response_format: "b64_json", size: "1024x1024", n: 1 });
    expect(t.asked[0]?.body.quality).toBeUndefined();
    expect(result).toMatchObject({ contentType: "image/png", inputTokens: 0, outputTokens: 0 });
  });
});

describe("what comes back", () => {
  test("only a PNG, JPEG or WebP within 10 MB", () => {
    expect(imageFromBase64(PNG_B64).contentType).toBe("image/png");
    expect(() => imageFromBase64(Buffer.from("<html>no</html>").toString("base64"))).toThrow("isn't a PNG");
    expect(() => imageFromBase64(undefined)).toThrow("no image");
    expect(() => imageFromBase64("A".repeat(Math.ceil((IMAGE_BYTES_MAX * 4) / 3) + 8))).toThrow("larger than 10 MB");
  });

  test("a picture's price is its model's, by shape", () => {
    expect(imageCostNanoUsd("gpt-image-2", "square")).toBe(53_000_000);
    expect(imageCostNanoUsd("gpt-image-2", "portrait")).toBe(41_000_000);
    expect(imageCostNanoUsd("gemini-2.5-flash-image", "landscape")).toBe(39_000_000);
    expect(imageCostNanoUsd("unknown", "square")).toBe(0);
  });
});
