import type { TFunction } from "i18next";
import type { Agent, ConversationModel } from "../api/types";
import { isRightHand } from "./right-hand";

/**
 * A model for one conversation (ADR 0032, addendum 2026-11-15), as the web's headers and the phone's sheets show it.
 */

/** The value of "the agent's default" among the choices (a select takes "" as an option). */
export const AGENT_OWN = "";

/** The agents a conversation's models are for: its members' agents still here, the team's right hand aside. */
export function conversationAgents(
  members: readonly { type: "person" | "agent"; id: string }[],
  agentById: ReadonlyMap<string, Agent>,
): Agent[] {
  return members.flatMap((m) => {
    const agent = m.type === "agent" ? agentById.get(m.id) : undefined;
    return agent && !isRightHand(agent) ? [agent] : [];
  });
}

/** The default's words: in a thread its channel's choice while it applies there, else the agent's own. */
function defaultLabel(t: TFunction, view: ConversationModel): string {
  if (!view.inherited) return t("brain.picker.conversation.default");
  const model = view.options.find((o) => o.value === view.inherited)?.label ?? view.inherited;
  return t("brain.picker.conversation.inherited", { model });
}

/** The choices in order: the default first, then the agent's other models. */
export function conversationModelChoices(t: TFunction, view: ConversationModel): { value: string; label: string }[] {
  return [{ value: AGENT_OWN, label: defaultLabel(t, view) }, ...view.options];
}

/** What the agent thinks with here, in words. */
export function conversationModelNow(t: TFunction, view: ConversationModel): string {
  if (view.model) return view.label ?? view.model;
  return defaultLabel(t, view);
}

/** What a saved choice says: the model the agent now thinks with here, or that it is back on its own. */
export function conversationModelSaved(t: TFunction, agentName: string, saved: ConversationModel): string {
  return saved.model && saved.label
    ? t("brain.picker.conversation.saved", { agent: agentName, model: saved.label })
    : t("brain.picker.conversation.reset", { agent: agentName });
}
