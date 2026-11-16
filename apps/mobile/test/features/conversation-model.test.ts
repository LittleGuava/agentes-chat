import { describe, expect, test } from "bun:test";
import type { ConversationModel } from "@agenteschat/client";
import {
  AGENT_OWN,
  conversationAgents,
  conversationModelChoices,
  conversationModelNow,
} from "@agenteschat/client/lib/conversation-model";
import { agent, translator } from "./fixtures";

/*
 * "Modelos nesta conversa" on the phone (ADR 0032, addendum 2026-11-15): the channel's or thread's "…" lists its
 * agents with what each thinks with here, and each opens its choices, the default first.
 */

const view = (over: Partial<ConversationModel> = {}): ConversationModel => ({
  agentId: "a1",
  channelId: "c1",
  threadId: null,
  brain: "model",
  model: null,
  inherited: null,
  label: null,
  options: [
    { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ],
  canEdit: true,
  ...over,
});

describe("models in this conversation", () => {
  test("the agents here are its members' agents, the team's right hand aside, in the members' order", () => {
    const ada = agent({ id: "a1", name: "Ada" });
    const atlas = agent({ id: "a2", name: "Atlas" });
    const hand = agent({ id: "a3", name: "Jev", builtin: "right_hand" });
    const byId = new Map([ada, atlas, hand].map((a) => [a.id, a]));
    const members = [
      { type: "person" as const, id: "u1" },
      { type: "agent" as const, id: "a2" },
      { type: "agent" as const, id: "a3" },
      { type: "agent" as const, id: "a1" },
      // An agent gone since: no row.
      { type: "agent" as const, id: "a9" },
    ];
    expect(conversationAgents(members, byId).map((a) => a.name)).toEqual(["Atlas", "Ada"]);
  });

  test("the choices start with the agent's default, and the one in force is checked", async () => {
    const t = await translator("pt-BR");
    expect(conversationModelChoices(t, view())).toEqual([
      { value: AGENT_OWN, label: "Padrão do agente" },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ]);
    expect(conversationModelNow(t, view())).toBe("Padrão do agente");
    expect(conversationModelNow(t, view({ model: "claude-opus-5-5", label: "Claude Opus 5.5" }))).toBe(
      "Claude Opus 5.5",
    );
  });

  test("in a thread with none of its own, the default is the channel's choice and says so", async () => {
    const t = await translator("pt-BR");
    const thread = view({ threadId: "m1", inherited: "claude-opus-5-5", label: "Claude Opus 5.5" });
    expect(conversationModelChoices(t, thread)[0]).toEqual({
      value: AGENT_OWN,
      label: "Como no canal (Claude Opus 5.5)",
    });
    expect(conversationModelNow(t, thread)).toBe("Como no canal (Claude Opus 5.5)");
    const own = { ...thread, model: "claude-haiku-5-5", label: "Claude Haiku 5.5" };
    expect(conversationModelNow(t, own)).toBe("Claude Haiku 5.5");
    expect(conversationModelChoices(t, own)[0]?.label).toBe("Como no canal (Claude Opus 5.5)");
  });

  test("in English too", async () => {
    const t = await translator("en");
    expect(conversationModelChoices(t, view())[0]?.label).toBe("Agent's default");
    const thread = view({ threadId: "m1", inherited: "claude-haiku-5-5", label: "Claude Haiku 5.5" });
    expect(conversationModelNow(t, thread)).toBe("As in the channel (Claude Haiku 5.5)");
  });
});
