import type { AgentQuestion, QuestionItem, QuestionItemAnswer } from "../api/types";

/** Whether an agent's question waits on this person: it is for them, or for anyone in the conversation. */
export const questionWaitsOn = (q: Pick<AgentQuestion, "requestedForUserId">, meId: string | null | undefined) =>
  !q.requestedForUserId || q.requestedForUserId === meId;

/**
 * A card of several questions, or of one where several may be picked (ADR 0008 addendum 2026-11-15), the same on the
 * web and the phone: each question takes its picks and words, and the card sends them together once every question
 * has an answer. Pure.
 */

/** The questions a card asks: its `items`, or the one question of a card that has none. */
export const questionItems = (q: Pick<AgentQuestion, "text" | "choices" | "items">): QuestionItem[] =>
  q.items && q.items.length > 0 ? q.items : [{ question: q.text, choices: q.choices }];

export interface QuestionDraft {
  /** Each question's picks, in its choices' order. */
  picks: string[][];
  /** What was written for each question. */
  written: string[];
}

export const emptyQuestionDraft = (items: readonly QuestionItem[]): QuestionDraft => ({
  picks: items.map(() => []),
  written: items.map(() => ""),
});

/** A tap on a choice: it toggles where several may be picked; elsewhere it is the one pick, and tapped again none. */
export function toggleChoice(
  draft: QuestionDraft,
  items: readonly QuestionItem[],
  index: number,
  choice: string,
): QuestionDraft {
  const item = items[index];
  if (!item?.choices?.includes(choice)) return draft;
  const had = draft.picks[index] ?? [];
  const on = had.includes(choice);
  const next = item.multiSelect
    ? item.choices.filter((c) => (c === choice ? !on : had.includes(c)))
    : on
      ? []
      : [choice];
  return { ...draft, picks: draft.picks.map((p, i) => (i === index ? next : p)) };
}

export const writeAnswer = (draft: QuestionDraft, index: number, text: string): QuestionDraft => ({
  ...draft,
  written: draft.written.map((w, i) => (i === index ? text : w)),
});

const answered = (draft: QuestionDraft, i: number) =>
  (draft.picks[i]?.length ?? 0) > 0 || Boolean(draft.written[i]?.trim());

/** How many questions still have neither a pick nor words. */
export const unansweredCount = (items: readonly QuestionItem[], draft: QuestionDraft) =>
  items.filter((_, i) => !answered(draft, i)).length;

/** What the card sends (`answers`, one per question in order), or null while a question has no answer. */
export function draftAnswers(
  items: readonly QuestionItem[],
  draft: QuestionDraft,
): { choices: string[]; text?: string }[] | null {
  if (unansweredCount(items, draft) > 0) return null;
  return items.map((_, i) => {
    const text = draft.written[i]?.trim();
    return { choices: draft.picks[i] ?? [], ...(text ? { text } : {}) };
  });
}

/** One question's answer in words: the picks, and what was written beside them. */
const saidOf = (a: QuestionItemAnswer | undefined) => {
  const picked = a?.choices.join(", ") ?? "";
  return picked && a?.text ? `${picked} (${a.text})` : picked || a?.text || "";
};

/** An answered card's lines, each question with what was said; null when it was answered in words (a reply). */
export function answeredLines(
  q: Pick<AgentQuestion, "text" | "choices" | "items" | "answers">,
): { question: string; said: string }[] | null {
  if (!q.items?.length || !q.answers?.length) return null;
  return q.items.map((item, i) => ({ question: item.question, said: saidOf(q.answers?.[i]) }));
}
