import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { channels } from "./chat";
import { machines } from "./machines";
import { organizations } from "./tenancy";

export type MeetingStatus = "joining" | "waiting" | "in_call" | "ended" | "failed";

/** A piece of what was said (ADR 0199 §4): from the start of the capture, and the words; who, when the page says. */
export interface MeetingTranscriptLine {
  speaker: string;
  atMs: number;
  text: string;
}

/**
 * An online meeting an agent was sent to take notes in (ADR 0199): from the request until its notes notice. Live
 * (`joining`, `waiting`, `in_call`) at most once per agent, since its browser has one page in front.
 */
export const agentMeetings = pgTable(
  "agent_meetings",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Where it was asked: the notes come back there. */
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: uuid(),
    runId: uuid(),
    /** The person who sent it (a run a person is behind): the notes name them. */
    requestedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    platform: text().$type<"google_meet" | "jitsi">().notNull(),
    /** The address rebuilt from the parsed link, never the text the model gave. */
    url: text().notNull(),
    displayName: text().notNull(),
    status: text().$type<MeetingStatus>().notNull().default("joining"),
    /** Why it failed or ended early (`timed_out`, the page's refusal). */
    error: text(),
    joinedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    noticeMessageId: uuid(),
    /** The computer that hears it (ADR 0199 §4): where "Leave" stops the capture and closes the browser. */
    machineId: uuid().references(() => machines.id, { onDelete: "set null" }),
    /** What was said so far, a line per piece as its words come (the audio itself is never kept). */
    transcript: jsonb().$type<MeetingTranscriptLine[]>().notNull().default([]),
    /** What the speech engines billed for its pieces, in nano-USD (zero on a server of one's own). */
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_meetings_one_live").on(t.agentId).where(sql`${t.status} in ('joining', 'waiting', 'in_call')`),
    index().on(t.orgId, t.createdAt),
  ],
);
