import type { QuestionItem } from "@agenteschat/client";
import { type QuestionDraft, toggleChoice, writeAnswer } from "@agenteschat/client/lib/agent-questions";
import { Icon, Textarea, type TextLimit } from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A card of several questions, or of one where several may be picked (ADR 0008 addendum 2026-11-15): each question
 * stacked with its choices as toggles (a check in the key's place once picked) and "Outra resposta" opening a field
 * for words; a question without choices is its field. Nothing is sent from here: the card's footer sends every answer
 * at once, once each question has one.
 */
export function QuestionItems({
  items,
  draft,
  onChange,
  disabled,
  limit,
}: {
  items: readonly QuestionItem[];
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
  disabled: boolean;
  limit: TextLimit;
}) {
  const { t } = useTranslation();
  const id = useId();
  // The questions whose "Outra resposta" is open: one with words already keeps its field.
  const [writing, setWriting] = useState<ReadonlySet<number>>(new Set());
  return (
    <div className="rq__items">
      {items.map((item, i) => {
        const legend = `${id}-q${i}`;
        const field = !item.choices || writing.has(i) || Boolean(draft.written[i]);
        return (
          <fieldset key={item.question} className="rq__item-q" disabled={disabled} aria-labelledby={legend}>
            <p className="rq__q" id={legend}>
              {item.question}
              {item.multiSelect && <small className="rq__q-hint">{t("question.pickSeveral")}</small>}
            </p>
            {item.choices && (
              <div className="rq__choices">
                {item.choices.map((choice) => {
                  const on = draft.picks[i]?.includes(choice) ?? false;
                  return (
                    <button
                      key={choice}
                      type="button"
                      className="rq__choice"
                      data-on={on || undefined}
                      aria-pressed={on}
                      onClick={() => onChange(toggleChoice(draft, items, i, choice))}
                    >
                      <span className="rq__key" aria-hidden="true">
                        {on && <Icon name="check" size={14} />}
                      </span>
                      <span className="rq__choice-text">{choice}</span>
                    </button>
                  );
                })}
                {!field && (
                  <button
                    type="button"
                    className="rq__choice rq__choice--other"
                    onClick={() => setWriting(new Set(writing).add(i))}
                  >
                    <span className="rq__key" aria-hidden="true">
                      <Icon name="edit" size={14} />
                    </span>
                    <span className="rq__choice-text">{t("ask.otherAnswer")}</span>
                  </button>
                )}
              </div>
            )}
            {field && (
              <div className="rq__field">
                <Textarea
                  rows={1}
                  autoGrow
                  autoFocus={Boolean(item.choices)}
                  value={draft.written[i] ?? ""}
                  limit={limit}
                  placeholder={item.choices ? t("ask.otherAnswer") : t("question.placeholder")}
                  aria-label={item.choices ? t("ask.otherAnswer") : t("question.placeholder")}
                  onChange={(e) => onChange(writeAnswer(draft, i, e.target.value))}
                />
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** A closed card of several questions: each question, and what was said to it when it was answered from the card. */
export function QuestionAnswers({ lines }: { lines: readonly { question: string; said: string }[] }) {
  return (
    <dl className="rq__answers">
      {lines.map((line) => (
        <div key={line.question}>
          <dt>{line.question}</dt>
          {line.said && <dd>{line.said}</dd>}
        </div>
      ))}
    </dl>
  );
}
