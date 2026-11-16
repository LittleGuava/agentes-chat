import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
let told = "";
beforeEach(async () => {
  told = "";
  t = await createTestServer({
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        told = last;
        return { chunks: ["Ok."] };
      }
      return {
        chunks: [],
        toolUses: [
          {
            name: "ask_user",
            input: {
              why: "I need a person's answer before I go on: this decides what I change next.",
              questions: [
                { question: "Qual ambiente?", choices: ["staging", "production"] },
                { question: "Quais serviços?", choices: ["api", "workers", "web"], multiSelect: true },
              ],
            },
          },
        ],
      };
    },
  });
});
afterEach(() => t.close());

test("questions API: a card of several questions is answered all at once, and the agent hears each answer", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  await api(`/channels/${channelId}/messages`, { json: { body: "@dev deploy it" } });
  await t.drain();
  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { meta: { questionId?: string } }[];
  };
  const id = timeline.messages.find((m) => m.meta.questionId)?.meta.questionId;

  expect(await (await api(`/questions/${id}`)).json()).toMatchObject({
    id,
    status: "open",
    choices: null,
    items: [
      { question: "Qual ambiente?", choices: ["staging", "production"] },
      { question: "Quais serviços?", choices: ["api", "workers", "web"], multiSelect: true },
    ],
  });
  // Every question needs its answer.
  expect((await api(`/questions/${id}/answer`, { json: { answers: [{ choices: ["production"] }] } })).status).toBe(400);
  const res = await api(`/questions/${id}/answer`, {
    json: { answers: [{ choices: ["production"] }, { choices: ["api", "web"], text: "sem o cron" }] },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "answered",
    answer: "Qual ambiente? production\nQuais serviços? api, web (sem o cron)",
    answers: [
      { choices: ["production"], text: null },
      { choices: ["api", "web"], text: "sem o cron" },
    ],
  });
  await t.drain();
  expect(told).toContain('\\"picked\\":[\\"api\\",\\"web\\"],\\"wrote\\":\\"sem o cron\\"');
});
