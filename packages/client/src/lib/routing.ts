import type { TFunction } from "i18next";
import type { AiRouting, AiStatus, DecidedBy, Message } from "../api/types";
import type { ReceiptsState, ReceiptView } from "../realtime/receipts";
import { agentGrammar } from "./grammar";
import { planLabel } from "./no-ai";
import { providerLabel } from "./providers";

/**
 * Whether something reads this person's messages that mention nobody (Jev, a small model, or their own plan), so an
 * agent set to answer on its own can join in (ADR 0074). An older server says nothing: as before, yes.
 */
export const picksForMe = (routing: AiRouting | undefined) =>
  !routing || routing.mine === "jev" || routing.mine === "model" || routing.mine === "plan";

/** What "On its own" means for this person's messages: the topic, only replies and follow-ups, or only mentions. */
export const replyAloneKey = (routing: AiRouting | undefined) =>
  picksForMe(routing)
    ? "channelMembers.replyAloneHelp"
    : routing?.mine === "off"
      ? "channelMembers.replyAloneOff"
      : "channelMembers.replyAloneRules";

/**
 * The line on who picks the agents now, by `ai-status`: its key and words. Null while it loads, in a workspace with
 * no AI, and for a small model the catalog can't name.
 */
export function routingLineOf(status: AiStatus | undefined, modelLabel: (id: string) => string | null) {
  const routing = status?.any ? status.routing : undefined;
  if (!routing) return null;
  if (routing.by === "model") {
    const model = routing.model ? modelLabel(routing.model) : null;
    return model ? { key: "routing.by.model" as const, params: { model } } : null;
  }
  if (routing.by === "rules" && routing.noSmallModel)
    return { key: "routing.by.noSmall" as const, params: { provider: providerLabel(routing.noSmallModel) } };
  return { key: `routing.by.${routing.by}` as const, params: {} };
}

/** Why the agent was picked, as the receipt's last line: the rule it followed (ADR 0074). */
export interface Decider {
  rule: Exclude<Extract<DecidedBy, { step: "rule" }>["rule"], "coordinator" | "alone">;
  text: string;
}

/**
 * The receipt's last line, once a rule picked an agent ("Uma resposta para a Ada"). Null when an AI picked (Jev, a
 * small model, a plan: which one means nothing to most people, the decision stays stored), for `alone` (a person with
 * nobody else here: the reason adds nothing for them, it stays stored), for a decision for nobody (the line under the
 * message says it) and one made before the server said who decided.
 */
export function deciderOf(t: TFunction, view: ReceiptView, names: { agent: (id: string) => string }): Decider | null {
  const by = view.decidedBy;
  const status = view.status;
  const first =
    status && status.kind !== "nobody" && status.kind !== "no_ai" && status.kind !== "platform_cap"
      ? status.agents[0]
      : undefined;
  if (by?.step !== "rule" || by.rule === "alone" || first === undefined) return null;
  // A coordinator's pick (before ADR 0137) reads as the default it was.
  const rule = by.rule === "coordinator" ? "default" : by.rule;
  return { rule, text: t(`receipts.by.${rule}`, agentGrammar(names.agent(first))) };
}

/** A step of the router that is an AI: Jev, the workspace's small model, the author's own plan (ADR 0074). */
export type AiPick = Exclude<DecidedBy, { step: "rule" }>;

/**
 * The AI step that picked the agent behind a reply, for the line under it when the workspace shows it (ADR 0074
 * addendum 2026-11-16): the decision on the message nobody mentioned whose receipt follows this reply's run for this
 * agent. Null for a rule's pick (the receipt already says why), a decision from before the server said who decided, a
 * run no message here was routed to, and a run any message mentioned this agent into: that reply answers a mention
 * too, and a reply to a mention never wears the line.
 */
export function routerPickOf(receipts: ReceiptsState, message: Pick<Message, "author" | "agentRunId">): AiPick | null {
  const agentId = message.author.type === "agent" ? message.author.id : null;
  const runId = message.agentRunId;
  if (!agentId || !runId) return null;
  let pick: AiPick | null = null;
  for (const id in receipts) {
    const receipt = receipts[id];
    if (receipt?.runOf?.[agentId] !== runId) continue;
    if (receipt.mentioned?.includes(agentId)) return null;
    const by = receipt.decidedBy;
    if (!pick && by && by.step !== "rule") pick = by;
  }
  return pick;
}

/**
 * The words the receipt said before the addendum of 2026-11-03 ("Escolhido pelo Jev", "Escolhido pelo Claude Haiku
 * 5.5", "Escolhido pelo seu plano do Claude"). Null for a model the catalog can't name yet.
 */
export function pickedByLine(
  t: TFunction,
  by: AiPick,
  names: { meId: string | null | undefined; person: (userId: string) => string; model: (id: string) => string | null },
): string | null {
  if (by.step === "jev") return t("routing.picked.jev");
  if (by.step === "model") {
    const model = names.model(by.model);
    return model ? t("routing.picked.model", { model }) : null;
  }
  const brand = planLabel(t, by.brand);
  return by.ownerId === names.meId
    ? t("routing.picked.planYours", { brand })
    : t("routing.picked.planOf", { brand, person: names.person(by.ownerId) });
}

/**
 * A person's mention of everyone that one agent answered for all of them, or that asked nothing of them
 * (`meta.everyoneShape`): one quiet line under the message, "5 agentes viram · Ada respondeu por todos", never one
 * reply each. Its words and who it shows, or null for any other message.
 */
export function everyoneLineOf(
  t: TFunction,
  meta: Record<string, unknown> | null | undefined,
  view: ReceiptView,
  names: { agent: (id: string) => string },
): { text: string; hint: string; faces: string[] } | null {
  const shape = meta?.everyoneShape as { answer?: unknown; by?: unknown } | undefined;
  if (shape?.answer !== "one" && shape?.answer !== "none") return null;
  if (view.seen.length < 2) return null;
  const by = shape.answer === "one" && typeof shape.by === "string" && view.seen.includes(shape.by) ? shape.by : null;
  const seen = t("receipts.everyone.seen", { count: view.seen.length });
  if (!by) return { text: seen, hint: t("receipts.everyone.hintNone"), faces: view.seen };
  const answered = view.status?.kind === "handled" && view.status.agents.includes(by);
  const name = names.agent(by);
  const who = t(answered ? "receipts.everyone.answered" : "receipts.everyone.answering", { name });
  return {
    text: `${seen} · ${who}`,
    hint: t("receipts.everyone.hintOne", { name }),
    // The one who answers first.
    faces: [by, ...view.seen.filter((id) => id !== by)],
  };
}
