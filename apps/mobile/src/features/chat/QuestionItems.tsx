import type { QuestionItem } from "@agenteschat/client";
import { type QuestionDraft, toggleChoice, writeAnswer } from "@agenteschat/client/lib/agent-questions";
import { MAX_MESSAGE_LENGTH } from "@agenteschat/client/lib/message-length";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { PromptForm } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";

/**
 * A card of several questions, or of one where several may be picked (ADR 0008 addendum 2026-11-15): each question
 * stacked with its choices as full-width toggles (a check once picked) and "Outra resposta" opening a sheet for words,
 * which then show under it; a question without choices is that button alone. Nothing is sent from here: the card's
 * "Enviar respostas" sends every answer at once.
 */
export function QuestionItems({
  items,
  draft,
  onChange,
  disabled,
}: {
  items: readonly QuestionItem[];
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const write = (i: number, item: QuestionItem) =>
    sheet.open(
      <PromptForm
        title={item.question}
        placeholder={t("mobile.chat.question.placeholder")}
        submitLabel={t("common.save")}
        initial={draft.written[i] ?? ""}
        allowEmpty
        limit={{ max: MAX_MESSAGE_LENGTH, fix: t("mobile.choices.tooLongFix") }}
        onSubmit={(text) => {
          onChange(writeAnswer(draft, i, text));
          sheet.close();
        }}
      />,
    );
  return (
    <View style={styles.items}>
      {items.map((item, i) => {
        const written = draft.written[i]?.trim();
        return (
          <View key={item.question} style={styles.item}>
            <View>
              <Text variant="callout">{item.question}</Text>
              {item.multiSelect && <Text variant="footnote">{t("question.pickSeveral")}</Text>}
            </View>
            {item.choices?.map((choice) => {
              const on = draft.picks[i]?.includes(choice) ?? false;
              return (
                <Pressable
                  key={choice}
                  disabled={disabled}
                  onPress={() => onChange(toggleChoice(draft, items, i, choice))}
                  accessibilityRole={item.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked: on, disabled }}
                  style={({ pressed }) => [
                    styles.opt,
                    { backgroundColor: on ? c.ink : c.sunken },
                    pressed && styles.optPressed,
                  ]}
                >
                  {on && <Icon name="check" size={16} color={c.bg} />}
                  <Text variant="callout" style={[styles.optText, { color: on ? c.bg : c.ink }]}>
                    {choice}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              disabled={disabled}
              onPress={() => write(i, item)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.opt,
                styles.other,
                { borderColor: c.line2 },
                pressed && styles.optPressed,
              ]}
            >
              <Text variant="callout" tone={written ? "ink" : "muted"} style={styles.optText}>
                {written || (item.choices ? t("ask.otherAnswer") : t("question.answer"))}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** A closed card of several questions: each question, and what was said to it when it was answered from the card. */
export function QuestionLines({ lines }: { lines: readonly { question: string; said: string }[] }) {
  return (
    <View style={styles.items}>
      {lines.map((line) => (
        <View key={line.question}>
          <Text variant="small">{line.question}</Text>
          {line.said ? <Text variant="callout">{line.said}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  items: { gap: 16 },
  item: { gap: 8 },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  optText: { flexShrink: 1 },
  optPressed: { transform: [{ scale: 0.98 }] },
  other: { backgroundColor: "transparent", borderWidth: 1 },
});
