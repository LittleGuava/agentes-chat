import { describe, expect, test } from "bun:test";
import type { AgentQuestion, QuestionItem } from "../src/api/types";
import {
  answeredLines,
  draftAnswers,
  emptyQuestionDraft,
  questionItems,
  toggleChoice,
  unansweredCount,
  writeAnswer,
} from "../src/lib/agent-questions";

const items: QuestionItem[] = [
  { question: "Qual ambiente?", choices: ["staging", "production"] },
  { question: "Quais serviços?", choices: ["api", "workers", "web"], multiSelect: true },
  { question: "Alguma janela?", choices: null },
];

const card = (over: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q1",
  agentId: "a1",
  channelId: "c1",
  threadId: null,
  messageId: "m1",
  text: "Qual ambiente?\nQuais serviços?\nAlguma janela?",
  choices: null,
  items,
  status: "open",
  answer: null,
  answeredByUserId: null,
  ...over,
});

describe("a question card's draft", () => {
  test("a card from before several questions is its one question", () => {
    expect(questionItems(card({ items: undefined, text: "Qual ambiente?", choices: ["a", "b"] }))).toEqual([
      { question: "Qual ambiente?", choices: ["a", "b"] },
    ]);
    expect(questionItems(card())).toBe(items);
  });

  test("one pick replaces the other, or clears when tapped again; several picks toggle", () => {
    let d = emptyQuestionDraft(items);
    d = toggleChoice(d, items, 0, "staging");
    d = toggleChoice(d, items, 0, "production");
    expect(d.picks[0]).toEqual(["production"]);
    expect(toggleChoice(d, items, 0, "production").picks[0]).toEqual([]);

    d = toggleChoice(d, items, 1, "web");
    d = toggleChoice(d, items, 1, "api");
    d = toggleChoice(d, items, 1, "workers");
    d = toggleChoice(d, items, 1, "web");
    // In the card's order, whatever order they were tapped in.
    expect(d.picks[1]).toEqual(["api", "workers"]);
  });

  test("nothing is sent until every question has a pick or words; then each answer in its place", () => {
    let d = emptyQuestionDraft(items);
    expect(draftAnswers(items, d)).toBeNull();
    expect(unansweredCount(items, d)).toBe(3);
    d = toggleChoice(d, items, 0, "production");
    d = toggleChoice(d, items, 1, "api");
    d = writeAnswer(d, 2, "   ");
    // Blank words answer nothing.
    expect(draftAnswers(items, d)).toBeNull();
    expect(unansweredCount(items, d)).toBe(1);
    d = writeAnswer(d, 2, " depois das 22h ");
    d = writeAnswer(d, 1, "sem o cron");
    expect(draftAnswers(items, d)).toEqual([
      { choices: ["production"] },
      { choices: ["api"], text: "sem o cron" },
      { choices: [], text: "depois das 22h" },
    ]);
  });

  test("answered from the card: each question with what was said; answered in words: no lines", () => {
    expect(
      answeredLines(
        card({
          status: "answered",
          answers: [
            { choices: ["production"], text: null },
            { choices: ["api", "web"], text: "sem o cron" },
            { choices: [], text: "depois das 22h" },
          ],
        }),
      ),
    ).toEqual([
      { question: "Qual ambiente?", said: "production" },
      { question: "Quais serviços?", said: "api, web (sem o cron)" },
      { question: "Alguma janela?", said: "depois das 22h" },
    ]);
    expect(answeredLines(card({ status: "answered", answer: "production e api" }))).toBeNull();
  });
});
