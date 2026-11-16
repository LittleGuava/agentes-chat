import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { DecidedBy, Message, MessageReceipts } from "../src/api/types";
import { pickedByLine, routerPickOf } from "../src/lib/routing";
import { seedReceipts } from "../src/realtime/receipts";

function translator(lng: string): TFunction {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t.bind(i18n) as TFunction;
}

const ADA = "a-ada";
const THEO = "a-theo";

const message = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u-ana" },
  body: "o build passou?",
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: "2026-11-16T12:00:00.000Z",
  ...over,
});

/** A person's message an agent answered in run `r1`, picked as `decidedBy` says. */
const asked = (decidedBy: DecidedBy | undefined, over: Partial<MessageReceipts> = {}) =>
  message("p1", {
    receipts: {
      seenBy: [ADA, THEO],
      pickedBy: [ADA],
      handled: [{ agentId: ADA, runId: "r1", status: "done" }],
      ...(decidedBy ? { decidedBy } : {}),
      ...over,
    },
  });

const reply = (over: Partial<Message> = {}) =>
  message("m1", { author: { type: "agent", id: ADA }, body: "Passou.", agentRunId: "r1", ...over });

/** The receipts as the app holds them after reading the conversation. */
const read = (...messages: Message[]) => seedReceipts({}, messages);

describe("which step picked the agent behind a reply (ADR 0074 addendum 2026-11-16)", () => {
  test("Jev, a small model or a plan picked it: that decision", () => {
    expect(routerPickOf(read(asked({ step: "jev" }), reply()), reply())).toEqual({ step: "jev" });
    const model: DecidedBy = { step: "model", model: "claude-haiku-5-5", provider: "anthropic" };
    expect(routerPickOf(read(asked(model), reply()), reply())).toEqual(model);
    const plan: DecidedBy = { step: "plan", brand: "claude", ownerId: "u-ana" };
    expect(routerPickOf(read(asked(plan), reply()), reply())).toEqual(plan);
  });

  test("a rule's pick, a mention, a decision from before and another run: nothing to say", () => {
    // A rule already has its own line in the receipt, and no AI picked.
    expect(routerPickOf(read(asked({ step: "rule", rule: "reply" }), reply()), reply())).toBeNull();
    // The person called the agent by name: no step picked it.
    const mentioned = message("p1", {
      mentionedAgentIds: [ADA],
      receipts: { seenBy: [ADA], pickedBy: [ADA], handled: [{ agentId: ADA, runId: "r1", status: "done" }] },
    });
    expect(routerPickOf(read(mentioned, reply()), reply())).toBeNull();
    expect(routerPickOf(read(asked(undefined), reply()), reply())).toBeNull();
    // A run no message here was routed to (a routine's, another conversation's).
    expect(routerPickOf(read(asked({ step: "jev" })), reply({ agentRunId: "r9" }))).toBeNull();
    expect(routerPickOf(read(asked({ step: "jev" })), reply({ agentRunId: null }))).toBeNull();
  });

  test("only the reply of the agent the step picked, never a person's message or another agent's", () => {
    const receipts = read(asked({ step: "jev" }));
    expect(routerPickOf(receipts, message("p2", { agentRunId: "r1" }))).toBeNull();
    expect(routerPickOf(receipts, reply({ author: { type: "agent", id: THEO } }))).toBeNull();
  });

  test("a run a mention started, that a routed message then reached, answers a mention: nothing to say", () => {
    const mentioned = message("p0", {
      mentionedAgentIds: [ADA],
      receipts: { seenBy: [ADA], pickedBy: [ADA], handled: [{ agentId: ADA, runId: "r1", status: "done" }] },
    });
    // The person's next message mentioned nobody: Jev picked Ada, whose run r1 took it in.
    const routedIn = message("p1", {
      receipts: {
        seenBy: [ADA],
        pickedBy: [ADA],
        handled: [{ agentId: ADA, runId: "r1", status: "done" }],
        decidedBy: { step: "jev" },
      },
    });
    expect(routerPickOf(read(mentioned, routedIn, reply()), reply())).toBeNull();
    expect(routerPickOf(read(routedIn, mentioned, reply()), reply())).toBeNull();
  });
});

describe("the words under the reply", () => {
  const names = {
    meId: "u-ana",
    person: (id: string) => (id === "u-bruno" ? "Bruno" : "?"),
    model: (id: string) => (id === "claude-haiku-5-5" ? "Claude Haiku 5.5" : null),
  };

  test("the ones the receipt said before the addendum of 2026-11-03, in Portuguese and English", () => {
    const pt = translator("pt-BR");
    expect(pickedByLine(pt, { step: "jev" }, names)).toBe("Escolhido pelo Jev");
    expect(pickedByLine(pt, { step: "model", model: "claude-haiku-5-5", provider: "anthropic" }, names)).toBe(
      "Escolhido pelo Claude Haiku 5.5",
    );
    expect(pickedByLine(pt, { step: "plan", brand: "claude", ownerId: "u-ana" }, names)).toBe(
      "Escolhido pelo seu plano do Claude",
    );
    expect(pickedByLine(pt, { step: "plan", brand: "chatgpt", ownerId: "u-bruno" }, names)).toBe(
      "Escolhido pelo plano do ChatGPT de Bruno",
    );
    const en = translator("en");
    expect(pickedByLine(en, { step: "jev" }, names)).toBe("Picked by Jev");
    expect(pickedByLine(en, { step: "plan", brand: "claude", ownerId: "u-bruno" }, names)).toBe(
      "Picked by Bruno's Claude plan",
    );
  });

  test("a model the catalog can't name yet says nothing rather than an id", () => {
    const pt = translator("pt-BR");
    expect(pickedByLine(pt, { step: "model", model: "x-unknown", provider: "openai" }, names)).toBeNull();
  });
});
