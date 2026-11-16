import { expect, test } from "bun:test";
import type { Message } from "../src/api/types";
import { editOffer, MESSAGE_EDIT_WINDOW_MS } from "../src/lib/message-edit";

const now = Date.parse("2026-11-15T12:00:00Z");
const mine = (over: Partial<Message> = {}) =>
  ({
    author: { type: "person", id: "ana" },
    createdAt: new Date(now - 60_000).toISOString(),
    meta: {},
    ...over,
  }) as Message;

test("my message nobody answered: Edit", () => {
  expect(editOffer(mine(), "ana", now)).toBe("edit");
});

test("my message an agent took: only Edit and redo", () => {
  const answered = mine({
    receipts: {
      seenBy: ["dev"],
      pickedBy: ["dev"],
      handled: [{ agentId: "dev", runId: "r1", status: "done" }],
      blocked: [],
    },
  });
  expect(editOffer(answered, "ana", now)).toBe("redo");
  const atWork = mine({
    receipts: {
      seenBy: ["dev"],
      pickedBy: ["dev"],
      handled: [{ agentId: "dev", runId: "r1", status: "running" }],
      blocked: [],
    },
  });
  expect(editOffer(atWork, "ana", now)).toBe("redo");
});

test("not offered on someone else's, an agent's, one on its way, a day old, a voice message or an answer", () => {
  expect(editOffer(mine(), "bia", now)).toBeNull();
  expect(editOffer(mine({ author: { type: "agent", id: "dev" } }), "ana", now)).toBeNull();
  expect(editOffer(mine({ local: "pending" }), "ana", now)).toBeNull();
  expect(
    editOffer(mine({ createdAt: new Date(now - MESSAGE_EDIT_WINDOW_MS - 1).toISOString() }), "ana", now),
  ).toBeNull();
  expect(editOffer(mine({ meta: { voice: { clipId: "c" } } }), "ana", now)).toBeNull();
  expect(editOffer(mine({ meta: { answersQuestionId: "q" } }), "ana", now)).toBeNull();
});
