import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { grantScopes } from "@agenteschat/engine";
import type { ModelRequest } from "@agenteschat/providers";
import { createFakeImages } from "@agenteschat/providers/testing";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

// `generate_image` through the running server (ADR 0213): a person's message, the agent's model calls the tool, and
// the reply carries the picture's card, the Drive keeps it and the agent's usage records it.

let t: TestServer;
afterEach(() => t.close());

/** The model: on the person's message it asks for a picture; once it is made, it answers in words. */
const model = (req: ModelRequest) =>
  JSON.stringify(req.messages.at(-1)?.content).includes("Made the image")
    ? { chunks: ["Aqui está."] }
    : { chunks: [], toolUses: [{ name: "generate_image", input: { prompt: "A red rocket over a calm sea" } }] };

test("a person asks for a picture: it is made on the workspace's OpenAI key and comes with the reply", async () => {
  const images = createFakeImages("openai");
  t = await createTestServer({ reply: model, images: { openai: images } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "drive:write" }]);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const key = await api("/credentials", {
    json: { provider: "openai", label: "images", apiKey: "sk-openai-img-0042" },
  });
  expect(key.status).toBeLessThan(300);

  await api(`/channels/${channelId}/messages`, { json: { body: "@dev faz uma imagem de um foguete" } });
  await t.drain();

  expect(images.calls.map((c) => c.apiKey)).toEqual(["sk-openai-img-0042"]);
  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: {
      author: { type: string };
      body: string;
      meta?: { artifacts?: { id: string }[] };
      usage?: { model: string };
    }[];
  };
  const reply = timeline.messages.find((m) => m.author.type === "agent" && m.body.includes("Aqui está"));
  const [file] = await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.orgId, orgId));
  expect(file?.kind).toBe("file");
  expect(reply?.meta?.artifacts?.map((a) => a.id)).toEqual([file?.id ?? ""]);
  // The reply's own line names its model, not the picture's.
  expect(reply?.usage?.model).toBe("claude-sonnet-5-5");
  const usage = await t.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.model, "gpt-image-2"));
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ orgId, agentId, provider: "openai", costNanoUsd: 53_000_000 });
});
