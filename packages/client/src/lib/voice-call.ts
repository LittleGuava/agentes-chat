import type { Message } from "../api/types";

/**
 * A voice call with an agent, by turns (ADR 0198): the app listens, sends the take as a voice message, waits for the
 * agent, reads each reply aloud, and listens again. This is the whole loop as a pure function of what the app sees, so
 * the web and the phone share it and it can't stall: every wait has a way out.
 */

export type CallPhase = "listening" | "sending" | "waiting" | "speaking" | "ended";

export interface CallState {
  phase: CallPhase;
  /**
   * The take on its way: its clientId, then the id of the message the server posted for it. `shown`: its bubble was
   * seen, so a list without it means it was dropped (`voice.dropped` and refusals take the bubble away).
   */
  take: { clientId: string; messageId: string | null; shown: boolean } | null;
  /** Agent replies after the take, in the server's order, still to be read: the head is being read. */
  queue: string[];
  /** Replies already queued or read: never twice. */
  heard: string[];
  /** A run worked on the take: its end is the end of the answer. */
  sawWork: boolean;
  /** A reply to this take was queued. */
  answered: boolean;
  /** Whether a run works here now, as last seen. */
  busy: boolean;
  /** Since when nothing is queued and no run works (this device's clock). */
  quietSince: number | null;
  /** When this phase began. */
  since: number;
}

/** What the call reads of a message: the conversation's own list, in the server's order. */
export type CallMessage = Pick<Message, "id"> & {
  author: Pick<Message["author"], "type">;
} & Partial<Pick<Message, "clientId" | "local">>;

export type CallEvent =
  /** A take went (its clientId is the voice message's). */
  | { type: "took"; clientId: string; now: number }
  /** The take didn't: nothing said, refused, too short or silent. */
  | { type: "dropped"; now: number }
  /** The conversation now: its messages and whether a run works in it (`callBusy`). */
  | { type: "seen"; messages: readonly CallMessage[]; busy: boolean; now: number }
  /** The reply at the head was read, failed, or had nothing to read. */
  | { type: "spoken"; now: number }
  /** The person takes the turn: stop reading and listen. */
  | { type: "interrupt"; now: number }
  | { type: "tick"; now: number }
  | { type: "hangUp" };

/** Quiet this long after the last run stopped (and nothing to read): the answer is over. */
export const CALL_SETTLE_MS = 1500;
/** No run at all for this long after the take was posted: no answer is coming. */
export const CALL_NO_ANSWER_MS = 60_000;
/** A take whose message hasn't come in this long: it isn't coming. */
export const CALL_SENDING_MS = 120_000;

export const startCall = (now: number): CallState => ({
  phase: "listening",
  take: null,
  queue: [],
  heard: [],
  sawWork: false,
  answered: false,
  busy: false,
  quietSince: null,
  since: now,
});

/** The reply being read now, if any. */
export const callReply = (s: CallState): string | null => (s.phase === "speaking" ? (s.queue[0] ?? null) : null);

/** A run works for the call: thinking, queued or running. One waiting on a person's decision hands the turn back. */
export const callBusy = (runs: readonly { status: string }[]) =>
  runs.some((r) => r.status === "thinking" || r.status === "queued" || r.status === "running");

const listening = (s: CallState, now: number): CallState => ({
  ...s,
  phase: "listening",
  take: null,
  queue: [],
  sawWork: false,
  answered: false,
  quietSince: null,
  since: now,
});

/** Where the call stands after what it saw. */
function settle(s: CallState, now: number): CallState {
  if (s.phase === "sending") return now - s.since >= CALL_SENDING_MS ? listening(s, now) : s;
  if (s.phase !== "waiting" && s.phase !== "speaking") return s;
  if (s.queue.length > 0) {
    return s.phase === "speaking" ? { ...s, quietSince: null } : { ...s, phase: "speaking", quietSince: null };
  }
  const waiting: CallState = s.phase === "waiting" ? s : { ...s, phase: "waiting" };
  if (s.busy) return { ...waiting, quietSince: null };
  const quietSince = s.quietSince ?? now;
  const over = s.sawWork || s.answered ? now - quietSince >= CALL_SETTLE_MS : now - waiting.since >= CALL_NO_ANSWER_MS;
  return over ? listening(waiting, now) : { ...waiting, quietSince };
}

/** The take's message once the server posted it, and the agent replies after it not heard yet. */
function see(s: CallState, messages: readonly CallMessage[], busy: boolean, now: number): CallState {
  const take = s.take;
  if (!take) return { ...s, busy };
  if (s.phase === "sending") {
    const mine = messages.some((m) => m.clientId === take.clientId);
    if (!mine) return take.shown ? listening({ ...s, busy }, now) : { ...s, busy };
    if (!take.shown) return see({ ...s, take: { ...take, shown: true } }, messages, busy, now);
  }
  const at = messages.findIndex((m) =>
    take.messageId ? m.id === take.messageId : !m.local && m.clientId === take.clientId,
  );
  if (at < 0) return { ...s, busy };
  const heard = new Set(s.heard);
  const fresh = messages
    .slice(at + 1)
    .filter((m) => m.author.type === "agent" && !m.local && !heard.has(m.id))
    .map((m) => m.id);
  const posted = s.phase === "sending";
  return {
    ...s,
    phase: posted ? "waiting" : s.phase,
    since: posted ? now : s.since,
    take: { ...take, messageId: messages[at]?.id ?? null },
    queue: [...s.queue, ...fresh],
    heard: [...s.heard, ...fresh],
    answered: s.answered || fresh.length > 0,
    sawWork: s.sawWork || busy,
    busy,
  };
}

export function callStep(s: CallState, e: CallEvent): CallState {
  if (e.type === "hangUp") return { ...s, phase: "ended", queue: [] };
  if (s.phase === "ended") return s;
  switch (e.type) {
    case "took":
      if (s.phase !== "listening") return s;
      return {
        ...s,
        phase: "sending",
        take: { clientId: e.clientId, messageId: null, shown: false },
        queue: [],
        sawWork: false,
        answered: false,
        quietSince: null,
        since: e.now,
      };
    case "dropped":
      return s.phase === "sending" ? listening(s, e.now) : s;
    case "seen":
      return settle(see(s, e.messages, e.busy, e.now), e.now);
    case "spoken":
      return s.phase === "speaking" ? settle({ ...s, queue: s.queue.slice(1) }, e.now) : s;
    case "interrupt":
      return listening(s, e.now);
    case "tick":
      return settle(s, e.now);
  }
}
