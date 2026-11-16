import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { answerQuestion, drainOutbox, listMessages, postPersonMessage, ValidationError } from "../src";
import { type Fixture, setup } from "./fixtures";

// The first test pays for migrating the PGlite template.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const why = "I need a person's answer before I go on: this decides what I change next.";
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const toolResultOf = (req: ModelRequest | undefined) => {
  const content = req?.messages.at(-1)?.content;
  const block = Array.isArray(content) ? content.find((b) => b.type === "tool_result") : undefined;
  const inner = block && "content" in block ? block.content : "";
  return typeof inner === "string" ? inner : JSON.stringify(inner);
};

const deploy = {
  why,
  questions: [
    { question: "Qual ambiente?", choices: ["staging", "production"] },
    { question: "Quais serviços reinicio?", choices: ["api", "workers", "web"], multiSelect: true },
    { question: "Alguma janela de horário?" },
  ],
};

/** Asks `input` for "deploy it", then says it is done once it hears back. */
const asking = (input: Record<string, unknown>) => (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  if (last.includes("deploy it")) return { chunks: [], toolUses: [{ name: "ask_user", input }] };
  return { chunks: ["Feito."] };
};

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const questions = () => f.db.select().from(schema.agentQuestions);
const runs = () => f.db.select().from(schema.agentRuns);

describe("ask_user with several questions", () => {
  test("one card asks them all; one answer resumes the run with each question's answer, as data", async () => {
    f = await setup({ askUser: true, reply: asking(deploy) });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("waiting_input");
    const [q] = await questions();
    // The old columns still read as one question answered in words: an app from before this shows that.
    expect(q).toMatchObject({
      text: "Qual ambiente?\nQuais serviços reinicio?\nAlguma janela de horário?",
      choices: null,
      status: "open",
    });
    expect(q?.items).toEqual([
      { question: "Qual ambiente?", choices: ["staging", "production"] },
      { question: "Quais serviços reinicio?", choices: ["api", "workers", "web"], multiSelect: true },
      { question: "Alguma janela de horário?", choices: null },
    ]);
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = main.find((m) => m.id === q?.messageId);
    expect((card?.meta.question as { items?: unknown[] } | undefined)?.items).toHaveLength(3);

    const answered = await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", {
      answers: [{ choices: ["production"] }, { choices: ["api", "workers"] }, { text: "depois das 22h" }],
    });
    expect(answered).toMatchObject({ status: "answered", answeredByUserId: f.owner.id });
    expect(answered.answers).toEqual([
      { choices: ["production"], text: null },
      { choices: ["api", "workers"], text: null },
      { choices: [], text: "depois das 22h" },
    ]);
    expect(answered.answer).toBe(
      "Qual ambiente? production\nQuais serviços reinicio? api, workers\nAlguma janela de horário? depois das 22h",
    );
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("done");
    const result = toolResultOf(f.provider.calls.at(-1)?.request);
    const json = result.slice(result.indexOf("["));
    expect(JSON.parse(json)).toEqual([
      { question: "Qual ambiente?", picked: ["production"] },
      { question: "Quais serviços reinicio?", picked: ["api", "workers"] },
      { question: "Alguma janela de horário?", picked: [], wrote: "depois das 22h" },
    ]);
  });

  test("the answer must answer every question, with the card's own choices, one pick where only one is allowed", async () => {
    f = await setup({ askUser: true, reply: asking(deploy) });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    const answer = (input: Parameters<typeof answerQuestion>[4]) =>
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", input);

    // One question left without an answer.
    await expect(answer({ answers: [{ choices: ["production"] }, { choices: ["api"] }, {}] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // Fewer answers than questions.
    await expect(answer({ answers: [{ choices: ["production"] }] })).rejects.toBeInstanceOf(ValidationError);
    // Two picks where only one is allowed.
    await expect(
      answer({ answers: [{ choices: ["production", "staging"] }, { choices: ["api"] }, { text: "já" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A pick that isn't one of its choices.
    await expect(
      answer({ answers: [{ choices: ["dev"] }, { choices: ["api"] }, { text: "já" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A card of several questions has no single choice to pick.
    await expect(answer({ choice: "production" })).rejects.toBeInstanceOf(ValidationError);
    expect((await questions())[0]?.status).toBe("open");
  });

  test("a reply in the conversation answers the whole card in words", async () => {
    f = await setup({ askUser: true, reply: asking(deploy) });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    await post("production, só a api, depois das 22h");
    await drainOutbox(f.db, f.handlers);
    expect((await questions())[0]).toMatchObject({
      status: "answered",
      answer: "production, só a api, depois das 22h",
      answers: null,
    });
    expect(toolResultOf(f.provider.calls.at(-1)?.request)).toContain(
      "The person answered: production, só a api, depois das 22h",
    );
  });

  test("one question with several picks keeps its choices for older apps, which still answer with one", async () => {
    f = await setup({
      askUser: true,
      reply: asking({
        why,
        question: "Quais serviços reinicio?",
        choices: ["api", "workers", "web"],
        multiSelect: true,
      }),
    });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    expect(q).toMatchObject({ text: "Quais serviços reinicio?", choices: ["api", "workers", "web"] });
    expect(q?.items).toEqual([
      { question: "Quais serviços reinicio?", choices: ["api", "workers", "web"], multiSelect: true },
    ]);
    const answered = await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", {
      choice: "workers",
    });
    expect(answered).toMatchObject({ answer: "workers", answers: [{ choices: ["workers"], text: null }] });
  });

  test("a single question with one pick is stored and answered exactly as before", async () => {
    f = await setup({
      askUser: true,
      reply: asking({ why, questions: [{ question: "Qual ambiente?", choices: ["staging", "production"] }] }),
    });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    expect(q).toMatchObject({ text: "Qual ambiente?", choices: ["staging", "production"], items: null });
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", {
      answers: [{ choices: ["staging"] }],
    });
    await drainOutbox(f.db, f.handlers);
    expect((await questions())[0]).toMatchObject({ answer: "staging", answers: null });
    expect(toolResultOf(f.provider.calls.at(-1)?.request)).toContain("The person answered: staging");
  });

  test("a card that is unclear is refused in words, with nothing posted", async () => {
    const refusals: string[] = [];
    const tries: Record<string, unknown>[] = [
      { why, question: "Qual ambiente?", questions: [{ question: "Qual janela?" }] },
      { why },
      { why, questions: [{ question: "Qual ambiente?" }, { question: "Uma nota sem pergunta" }] },
      { why, questions: [{ question: `${"Contexto longo. ".repeat(25)}Posso seguir?` }] },
    ];
    f = await setup({
      askUser: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("tool_result")) refusals.push(toolResultOf(req));
        const next = tries[refusals.length];
        if (!next) return { chunks: ["Ok."] };
        return { chunks: [], toolUses: [{ name: "ask_user", input: next }] };
      },
    });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toEqual([]);
    expect(refusals[0]).toContain("either `question` or `questions`");
    expect(refusals[1]).toContain("either `question` or `questions`");
    expect(refusals[2]).toContain("Not asked: this asks nothing");
    expect(refusals[3]).toContain("this question is");
  });
});
