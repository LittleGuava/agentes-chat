import type { Message } from "../api/types";

/** Where a reply read aloud plays from (ADR 0209). `base` is the server for the phone app (`""` on the web). */
export function readAloudAudioUrl(orgId: string, clipId: string, base = "") {
  const path = `/api/app/organizations/${encodeURIComponent(orgId)}/read-aloud/${encodeURIComponent(clipId)}/audio`;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Whether a message shows "Ouvir" (ADR 0209 §2): an agent's reply in its own words. A line the server wrote
 * (`bodyCode`, shown in the reader's language) and a voice message have none, and the server would refuse them.
 */
export function readAloudOffered(message: Pick<Message, "author" | "body" | "meta" | "local">) {
  if (message.local || message.author.type !== "agent") return false;
  const meta = message.meta;
  if (typeof meta?.bodyCode === "string" || meta?.voice) return false;
  return message.body.trim() !== "";
}
