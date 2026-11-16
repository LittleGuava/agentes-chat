import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ActiveRun } from "../src/api/types";
import { FIRST_REPLY_RESCUE_MS, firstReplyRescue } from "../src/lib/first-reply";
import { applyChannelEvent, emptyStreams, reconcileRuns, type StreamsState } from "../src/realtime/streams";

/**
 * "Switch AI" when the first reply doesn't come: a run whose AI has sent nothing since it was set to work, for long
 * enough, offers the person who asked to switch the agent's AI (or to see its status), and the offer goes the moment
 * anything of the AI arrives.
 */

const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const at = (ms: number) => setSystemTime(new Date(T0 + ms));
afterEach(() => setSystemTime());

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const ev = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as Ev;
const running = ev({ type: "agent.run", status: "running" });

const asker = { askedByMe: true, ownsAgent: false, admin: false };
const rescueAt = (s: StreamsState, ms: number, who = asker) => {
  const run = s.runs.r1;
  return run ? firstReplyRescue(run, who, T0 + ms) : null;
};

/** The run set to work at T0, nothing from its AI since. */
const startedAtT0 = () => {
  at(0);
  return applyChannelEvent(emptyStreams, running, T0);
};

describe("a run whose AI sends nothing", () => {
  test("offers nothing before the limit, and the rescue once it passes", () => {
    const s = startedAtT0();
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS - 1)).toBeNull();
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS)).toEqual({ action: "status", ms: FIRST_REPLY_RESCUE_MS });
  });

  test("its owner or an admin who asked is offered to switch its AI; anyone else, its status", () => {
    const s = startedAtT0();
    const ms = FIRST_REPLY_RESCUE_MS + 5000;
    expect(rescueAt(s, ms, { ...asker, ownsAgent: true })?.action).toBe("switchAi");
    expect(rescueAt(s, ms, { ...asker, admin: true })?.action).toBe("switchAi");
    expect(rescueAt(s, ms)?.action).toBe("status");
  });

  test("only the person who asked sees it", () => {
    const s = startedAtT0();
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS * 2, { askedByMe: false, ownsAgent: true, admin: true })).toBeNull();
  });

  test("a run a person is stopping, or one that failed, offers nothing", () => {
    let s = startedAtT0();
    const r = s.runs.r1;
    if (!r) throw new Error("no row");
    s = { ...s, runs: { r1: { ...r, stopping: true } } };
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS * 2)).toBeNull();
    s = applyChannelEvent(startedAtT0(), ev({ type: "run.finished", status: "failed", error: "boom" }), T0 + 1000);
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS * 2)).toBeNull();
  });
});

describe("anything from its AI ends the rescue", () => {
  const outputs: [string, Ev][] = [
    ["it writes", ev({ type: "agent.typing" })],
    ["a server that still streams", ev({ type: "agent.delta", text: "Oi" })],
    ["a tool call", ev({ type: "agent.tool", tool: "github_list_prs", toolUseId: "t1" })],
    ["a computer brain's own call", ev({ type: "agent.step", tool: "Read" })],
    ["a command's output", ev({ type: "agent.tool.output", stream: "stdout", text: "ok" })],
    ["a browser profile it waits for", ev({ type: "agent.browser.waiting", wait: null })],
    [
      "a message it posts on its way",
      ev({
        type: "message.created",
        messageId: "fast-1",
        message: {
          id: "fast-1",
          channelId: "c1",
          threadId: "m1",
          agentRunId: "r1",
          author: { type: "agent", id: "ada" },
          meta: { talker: true },
        },
      }),
    ],
  ];
  for (const [what, event] of outputs) {
    test(what, () => {
      const s = applyChannelEvent(startedAtT0(), event, T0 + FIRST_REPLY_RESCUE_MS + 1000);
      expect(s.runs.r1).toBeDefined();
      expect(rescueAt(s, FIRST_REPLY_RESCUE_MS * 3)).toBeNull();
    });
  }

  test("news that isn't its AI's (a message read into the run, a steer) keeps the rescue", () => {
    let s = startedAtT0();
    s = applyChannelEvent(s, ev({ type: "agent.run.steered", messageId: "m2" }), T0 + 10_000);
    s = applyChannelEvent(s, ev({ type: "agent.run.read", messageIds: ["m2"] }), T0 + 20_000);
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS)?.action).toBe("status");
  });
});

describe("when the count starts", () => {
  test("a run back at work after a wait counts from then, not from its first start", () => {
    let s = startedAtT0();
    s = applyChannelEvent(s, ev({ type: "agent.typing" }), T0 + 5000);
    s = applyChannelEvent(s, ev({ type: "agent.run", status: "waiting_input" }), T0 + 10_000);
    s = applyChannelEvent(s, running, T0 + 60_000);
    expect(rescueAt(s, 60_000 + FIRST_REPLY_RESCUE_MS - 1)).toBeNull();
    expect(rescueAt(s, 60_000 + FIRST_REPLY_RESCUE_MS)?.ms).toBe(FIRST_REPLY_RESCUE_MS);
  });

  test("waiting in line isn't its AI's silence", () => {
    at(0);
    const s = applyChannelEvent(emptyStreams, ev({ type: "agent.run", status: "queued" }), T0);
    expect(rescueAt(s, FIRST_REPLY_RESCUE_MS * 2)).toBeNull();
  });

  test("the guess made on sending, before the server says anything, offers nothing", () => {
    at(0);
    const s = applyChannelEvent(emptyStreams, ev({ type: "agent.thinking", runId: null }), T0);
    const guess = Object.values(s.runs)[0];
    expect(guess?.provisional).toBe(true);
    expect(guess ? firstReplyRescue(guess, asker, T0 + FIRST_REPLY_RESCUE_MS * 2) : "none").toBeNull();
  });

  test("a row read from the server, or kept through a read, offers nothing: this device may have missed its output", () => {
    const active: ActiveRun = { ...base, status: "running", workingMs: FIRST_REPLY_RESCUE_MS * 2 };
    const read = reconcileRuns(emptyStreams, "c1", [active], T0);
    expect(rescueAt(read, FIRST_REPLY_RESCUE_MS * 3)).toBeNull();
    const kept = reconcileRuns(startedAtT0(), "c1", [active], T0 + 30_000);
    expect(kept.runs.r1).toBeDefined();
    expect(rescueAt(kept, FIRST_REPLY_RESCUE_MS * 3)).toBeNull();
  });
});
