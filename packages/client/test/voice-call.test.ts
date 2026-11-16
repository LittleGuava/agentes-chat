import { describe, expect, test } from "bun:test";
import {
  CALL_NO_ANSWER_MS,
  CALL_SENDING_MS,
  CALL_SETTLE_MS,
  type CallMessage,
  type CallState,
  callBusy,
  callReply,
  callStep,
  startCall,
} from "../src/lib/voice-call";

/** A voice call's loop (ADR 0198): listen, send the take, wait for the agent, read each reply, listen again. */

const person = (id: string, clientId?: string, local?: "pending"): CallMessage => ({
  id,
  clientId: clientId ?? null,
  author: { type: "person" },
  ...(local ? { local } : {}),
});
const agent = (id: string): CallMessage => ({ id, author: { type: "agent" } });

/** Runs the events in order from a call just started at 0. */
function play(...events: ((s: CallState) => CallState)[]) {
  return events.reduce((s, e) => e(s), startCall(0));
}
const took =
  (clientId: string, now = 10) =>
  (s: CallState) =>
    callStep(s, { type: "took", clientId, now });
const seen =
  (messages: CallMessage[], busy: boolean, now: number) =>
  (s: CallState): CallState =>
    callStep(s, { type: "seen", messages, busy, now });
const spoken = (now: number) => (s: CallState) => callStep(s, { type: "spoken", now });
const tick = (now: number) => (s: CallState) => callStep(s, { type: "tick", now });

const history = [person("old-1"), agent("old-2")];

describe("a turn that gets an answer", () => {
  test("the take is found by its clientId, and only replies after it are read, in order, then it listens", () => {
    const sending = play(took("c1"), seen([...history, person("local-c1", "c1", "pending")], false, 20));
    expect(sending.phase).toBe("sending");

    const waiting = play(took("c1"), seen([...history, person("m1", "c1")], true, 30));
    expect(waiting.phase).toBe("waiting");
    expect(waiting.take).toEqual({ clientId: "c1", messageId: "m1", shown: true });

    const answered = [...history, person("m1", "c1"), agent("r1"), agent("r2")];
    const speaking = play(took("c1"), seen([...history, person("m1", "c1")], true, 30), seen(answered, true, 40));
    expect(speaking.phase).toBe("speaking");
    expect(callReply(speaking)).toBe("r1");

    const second = spoken(50)(speaking);
    expect(callReply(second)).toBe("r2");
    // Seen again: nothing read twice.
    expect(callReply(seen(answered, true, 55)(second))).toBe("r2");

    const done = play(() => second, spoken(60), seen(answered, false, 61), tick(61 + CALL_SETTLE_MS - 1));
    expect(done.phase).toBe("waiting");
    expect(tick(61 + CALL_SETTLE_MS)(done).phase).toBe("listening");
  });

  test("a run still working after a reply keeps the call waiting for more", () => {
    const answered = [person("m1", "c1"), agent("r1")];
    const s = play(took("c1"), seen(answered, true, 20), spoken(30), tick(30 + CALL_SETTLE_MS * 3));
    expect(s.phase).toBe("waiting");
    const more = seen([...answered, agent("r2")], true, 40_000)(s);
    expect(callReply(more)).toBe("r2");
  });
});

describe("ways the loop can't stall", () => {
  test("nothing said, refused or too short: back to listening", () => {
    const s = play(took("c1"), (x) => callStep(x, { type: "dropped", now: 20 }));
    expect(s.phase).toBe("listening");
    expect(s.take).toBeNull();
  });

  test("a take whose bubble went away without a message (dropped as silent, refused) is over", () => {
    const shown = play(took("c1"), seen([...history, person("local-c1", "c1", "pending")], false, 20));
    expect(shown.phase).toBe("sending");
    expect(seen(history, false, 30)(shown).phase).toBe("listening");
    // Before its bubble ever showed, an empty list says nothing yet.
    expect(play(took("c1"), seen(history, false, 20)).phase).toBe("sending");
  });

  test("a run that ends without a message ends the wait once things are quiet", () => {
    const posted = [person("m1", "c1")];
    const s = play(took("c1"), seen(posted, true, 20), seen(posted, false, 30), tick(30 + CALL_SETTLE_MS));
    expect(s.phase).toBe("listening");
  });

  test("with no run at all, the wait ends after a minute", () => {
    const posted = [person("m1", "c1")];
    const s = play(took("c1"), seen(posted, false, 20), tick(20 + CALL_SETTLE_MS * 10));
    expect(s.phase).toBe("waiting");
    expect(tick(20 + CALL_NO_ANSWER_MS)(s).phase).toBe("listening");
  });

  test("a take whose message never comes stops sending", () => {
    const s = play(took("c1", 10), tick(10 + CALL_SENDING_MS - 1));
    expect(s.phase).toBe("sending");
    expect(tick(10 + CALL_SENDING_MS)(s).phase).toBe("listening");
  });

  test("interrupting listens at once and forgets what was still to read", () => {
    const answered = [person("m1", "c1"), agent("r1"), agent("r2")];
    const s = play(took("c1"), seen(answered, true, 20), (x) => callStep(x, { type: "interrupt", now: 30 }));
    expect(s.phase).toBe("listening");
    expect(callReply(s)).toBeNull();
    // A late reply to that take isn't read over the person.
    expect(seen([...answered, agent("r3")], false, 40)(s).phase).toBe("listening");
  });

  test("hanging up ends it for good", () => {
    const s = play(
      took("c1"),
      (x) => callStep(x, { type: "hangUp" }),
      seen([person("m1", "c1"), agent("r1")], true, 20),
    );
    expect(s.phase).toBe("ended");
  });

  test("a take is only taken while listening", () => {
    const s = play(took("c1"), took("c2", 20));
    expect(s.take?.clientId).toBe("c1");
  });
});

test("busy: a run thinking or working; one waiting on a person's decision hands the turn back", () => {
  expect(callBusy([{ status: "thinking" }])).toBe(true);
  expect(callBusy([{ status: "queued" }, { status: "failed" }])).toBe(true);
  expect(callBusy([{ status: "running" }])).toBe(true);
  expect(callBusy([{ status: "waiting_approval" }, { status: "failed" }])).toBe(false);
  expect(callBusy([])).toBe(false);
});
