import type { CallVoice } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { plainLines } from "@agenteschat/ui/markdown";
import { requireChannelAccess } from "./channels";
import { NotFoundError, ValidationError } from "./errors";
import { readableBody } from "./message-preview";

const { messages } = schema;

/**
 * Voice calls (ADR 0198): the person speaks in voice messages (ADR 0100) and hears each agent reply read aloud. The
 * server's half is only the audio of a reply, made when asked and never kept.
 */
export interface VoiceCallDeps {
  db: Database;
  /** Null: calls are off on this server (no `VOICE_CALL_SPEECH_URL`). */
  voice: CallVoice | null;
}

/** The most characters read from one reply. */
export const VOICE_CALL_MAX_CHARS = 4000;

/**
 * The words of a reply as a person reads them: none for a voice message, a notice for the agent or a line the server
 * wrote (`bodyCode`, shown in the reader's language), and only prose, so code, tables and headings aren't spelled out.
 * A long one stops at the last sentence that fits.
 */
export function spokenWords(
  body: string,
  meta: Record<string, unknown> | null | undefined,
  max = VOICE_CALL_MAX_CHARS,
): string {
  if (typeof meta?.bodyCode === "string") return "";
  const text = plainLines(readableBody(body, meta)).join("\n");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return (end > max / 2 ? cut.slice(0, end + 1) : cut).trim();
}

/** An agent's reply as audio, for someone who can read its channel. */
export async function speakReply(
  deps: VoiceCallDeps,
  userId: string,
  orgId: string,
  messageId: string,
): Promise<{ audio: Uint8Array; contentType: string }> {
  const { db, voice } = deps;
  if (!voice) throw new ValidationError("Voice calls are off on this server", "voice_call.unavailable");
  const [message] = await db
    .select({
      channelId: messages.channelId,
      authorType: messages.authorType,
      body: messages.body,
      meta: messages.meta,
    })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!message) throw new NotFoundError();
  await requireChannelAccess(db, userId, orgId, message.channelId);
  if (message.authorType !== "agent") throw new ValidationError("Only an agent's reply", "voice_call.not_agent");
  const text = spokenWords(message.body, message.meta, Math.min(VOICE_CALL_MAX_CHARS, voice.maxChars));
  if (!text) throw new ValidationError("Nothing to read in this message", "voice_call.no_words");
  return voice.speak({ text, voice: voice.defaultVoice, orgId });
}
