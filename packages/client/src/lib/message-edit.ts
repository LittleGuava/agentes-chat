import type { Message } from "../api/types";

/** How long after sending its author may still edit a message (mirrors `MESSAGE_EDIT_WINDOW_MS`, ADR 0207). */
export const MESSAGE_EDIT_WINDOW_MS = 24 * 3600_000;

/**
 * What a person may do to a message they sent (ADR 0207): `edit` its text, or, once an agent took it (a run answers
 * it, or it reached an agent's task at work), only `redo`: edit it and have the agents answer the new text. Null: not
 * theirs, still on its way, too old, or a kind whose words aren't edited (a voice message, an answer to an agent's
 * question, a notice). The server checks the same and says why it refuses.
 */
export function editOffer(
  message: Pick<Message, "author" | "createdAt" | "meta" | "receipts" | "local">,
  me: string,
  now = Date.now(),
): "edit" | "redo" | null {
  if (message.local || message.author.type !== "person" || message.author.id !== me) return null;
  if (now - Date.parse(message.createdAt) > MESSAGE_EDIT_WINDOW_MS) return null;
  const meta = message.meta ?? {};
  if (meta.voice !== undefined || meta.answersQuestionId !== undefined || meta.notice !== undefined) return null;
  return (message.receipts?.handled.length ?? 0) > 0 ? "redo" : "edit";
}
