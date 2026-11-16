import { describe, expect, test } from "bun:test";
import { markForEndpointHost, PROVIDER_MARKS } from "../src/brand/marks";

describe("markForEndpointHost", () => {
  test("a maker's own API host shows its mark", () => {
    expect(markForEndpointHost("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(markForEndpointHost("https://api.openai.com/v1")).toBe("openai");
    expect(markForEndpointHost("https://api.anthropic.com")).toBe("claude");
    expect(markForEndpointHost("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("gemini");
    expect(markForEndpointHost("https://api.moonshot.ai/v1")).toBe("kimi");
    expect(markForEndpointHost("https://api.moonshot.cn/v1")).toBe("kimi");
    expect(markForEndpointHost("https://api.z.ai/api/paas/v4")).toBe("zai");
    expect(markForEndpointHost("https://api.minimax.io/v1")).toBe("minimax");
    expect(markForEndpointHost("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(markForEndpointHost("https://opencode.ai/zen/v1")).toBe("opencode");
    expect(markForEndpointHost("https://api.x.ai/v1")).toBe("xai");
    expect(markForEndpointHost("https://api.mistral.ai/v1")).toBe("mistral");
    expect(markForEndpointHost("https://api.groq.com/openai/v1")).toBe("groq");
    expect(markForEndpointHost("https://api.llama.com/compat/v1")).toBe("meta");
    expect(markForEndpointHost("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("alibaba");
  });

  test("a subdomain the pattern allows matches, one it doesn't stays generic", () => {
    expect(markForEndpointHost("https://us.api.openai.com/v1")).toBe("openai");
    expect(markForEndpointHost("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("alibaba");
    expect(markForEndpointHost("https://ws-1.cn-beijing.maas.aliyuncs.com/v1")).toBe("alibaba");
    expect(markForEndpointHost("https://eu.openrouter.ai/api/v1")).toBe("openrouter");
    expect(markForEndpointHost("https://oss.aliyuncs.com")).toBe("custom");
    expect(markForEndpointHost("https://staging.api.deepseek.com/v1")).toBe("custom");
  });

  test("only the host counts: case, a trailing dot and a port don't matter, the path and user name never match", () => {
    expect(markForEndpointHost("https://API.DeepSeek.com/v1")).toBe("deepseek");
    expect(markForEndpointHost("https://api.deepseek.com./v1")).toBe("deepseek");
    expect(markForEndpointHost("https://api.deepseek.com:443/v1")).toBe("deepseek");
    expect(markForEndpointHost("http://api.openai.com:8080/v1")).toBe("openai");
    expect(markForEndpointHost("  https://api.x.ai/v1  ")).toBe("xai");
    expect(markForEndpointHost("https://gateway.example.com/api.openai.com/v1")).toBe("custom");
    expect(markForEndpointHost("https://api.openai.com@evil.example/v1")).toBe("custom");
  });

  test("a look-alike host keeps the generic icon", () => {
    expect(markForEndpointHost("https://api.openai.com.evil.example/v1")).toBe("custom");
    expect(markForEndpointHost("https://notapi.openai.com/v1")).toBe("custom");
    expect(markForEndpointHost("https://xapi.deepseek.com/v1")).toBe("custom");
    expect(markForEndpointHost("https://evilopenrouter.ai/v1")).toBe("custom");
  });

  test("a host without a mark of its own keeps the generic icon: Azure, Vertex, local servers", () => {
    expect(markForEndpointHost("https://my-resource.openai.azure.com/openai/v1")).toBe("custom");
    expect(markForEndpointHost("https://us-central1-aiplatform.googleapis.com/v1")).toBe("custom");
    expect(markForEndpointHost("http://localhost:11434/v1")).toBe("custom");
    expect(markForEndpointHost("http://127.0.0.1:1234/v1")).toBe("custom");
    expect(markForEndpointHost("http://[::1]:8000/v1")).toBe("custom");
    expect(markForEndpointHost("https://litellm.internal.example/v1")).toBe("custom");
  });

  test("an address that isn't one keeps the generic icon", () => {
    expect(markForEndpointHost("")).toBe("custom");
    expect(markForEndpointHost(null)).toBe("custom");
    expect(markForEndpointHost(undefined)).toBe("custom");
    expect(markForEndpointHost("api.deepseek.com")).toBe("custom");
    expect(markForEndpointHost("not a url")).toBe("custom");
    expect(markForEndpointHost("ftp://api.deepseek.com")).toBe("custom");
    expect(markForEndpointHost("https://")).toBe("custom");
  });

  test("every mark it answers is one the kit draws", () => {
    for (const url of ["https://api.deepseek.com", "https://api.openai.com", "https://nothing.example"])
      expect(Object.hasOwn(PROVIDER_MARKS, markForEndpointHost(url))).toBe(true);
  });
});
