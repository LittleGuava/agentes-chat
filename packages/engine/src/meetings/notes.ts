import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { deliverNotice, publishDelivery } from "../delivery";
import { MEETING_PLATFORM_NAMES, MEETING_TRANSCRIPT_MAX_CHARS } from "./links";

/** Live states of a meeting (`agent_meetings_one_live`): one per agent at a time. */
export const LIVE_MEETING = ["joining", "waiting", "in_call"] as const;

/** One piece of what was said: who spoke (as the meeting's page names them), from when, and the words. */
export interface MeetingLine {
  speaker: string;
  /** From the start of the capture. */
  atMs: number;
  text: string;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const speakerOf = (l: MeetingLine) => l.speaker.replace(/\s+/g, " ").trim();

/**
 * The transcript as the agent reads it: `[mm:ss] Speaker: words`, one line per piece, empty pieces left out. A piece
 * nobody is named for (the computer hears the call, not who speaks) is `[mm:ss] words`.
 */
export function meetingTranscriptText(lines: MeetingLine[]): string {
  return lines
    .filter((l) => l.text.trim())
    .map((l) => {
      const who = speakerOf(l);
      return `[${clock(l.atMs)}] ${who ? `${who}: ` : ""}${l.text.trim().replace(/\s+/g, " ")}`;
    })
    .join("\n");
}

/** Who spoke, in the order they first did; only those the transcript names. */
export const meetingSpeakers = (lines: MeetingLine[]) => [
  ...new Set(lines.filter((l) => l.text.trim() && speakerOf(l)).map(speakerOf)),
];

export interface FinishMeetingInput {
  orgId: string;
  meetingId: string;
  transcript: MeetingLine[];
  /** Why it ended, when not because the call did (`left`, `timed_out`). */
  reason?: string;
}

/**
 * The meeting ended (ADR 0199 §7): it leaves its live state and, in the same transaction, a `meeting_ended` notice
 * carries the transcript to the agent in the conversation it was asked in, which writes the notes as its reply. A
 * second call finds it ended and posts nothing. Returns the notice's message id, or null when nothing was posted.
 */
export async function finishMeeting(
  db: Database,
  pubsub: PubSub | undefined,
  input: FinishMeetingInput,
): Promise<{ noticeMessageId: string } | null> {
  const t = schema.agentMeetings;
  const out = await db.transaction(async (tx) => {
    const [meeting] = await tx
      .update(t)
      .set({ status: "ended", endedAt: new Date(), ...(input.reason ? { error: input.reason } : {}) })
      .where(and(eq(t.orgId, input.orgId), eq(t.id, input.meetingId), inArray(t.status, [...LIVE_MEETING])))
      .returning();
    if (!meeting) return null;
    const full = meetingTranscriptText(input.transcript);
    const cut = full.length > MEETING_TRANSCRIPT_MAX_CHARS;
    const text = cut ? full.slice(0, MEETING_TRANSCRIPT_MAX_CHARS) : full;
    const platform = MEETING_PLATFORM_NAMES[meeting.platform];
    const minutes = meeting.joinedAt
      ? Math.max(1, Math.round((Date.now() - meeting.joinedAt.getTime()) / 60_000))
      : null;
    const speakers = meetingSpeakers(input.transcript);
    const delivered = await deliverNotice(tx, {
      orgId: meeting.orgId,
      agentId: meeting.agentId,
      channelId: meeting.channelId,
      threadId: meeting.threadId,
      hop: 0,
      stretchId: null,
      notice: {
        kind: "meeting_ended",
        text,
        from: platform,
        refs: {
          meetingId: meeting.id,
          platform: meeting.platform,
          url: meeting.url,
          ...(cut ? { cutAt: String(MEETING_TRANSCRIPT_MAX_CHARS), length: String(full.length) } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
      // For people: no transcript and no names here, so nobody's words can mention (and wake) an agent.
      body: `Meeting ended (${platform}${minutes ? `, ${minutes} min` : ""}${
        speakers.length > 0 ? `, ${speakers.length} ${speakers.length === 1 ? "person" : "people"} spoke` : ""
      }). Notes follow.`,
      readOutside: true,
    });
    await tx.update(t).set({ noticeMessageId: delivered.message.id }).where(eq(t.id, meeting.id));
    return delivered;
  });
  if (!out) return null;
  await publishDelivery(pubsub, out).catch(() => {});
  return { noticeMessageId: out.message.id };
}
