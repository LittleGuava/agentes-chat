import { and, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { isAutoModel, isCustomModel, MODEL_CATALOG, modelProvider } from "@agenteschat/providers";
import { planOf } from "@agenteschat/providers/plans";
import { type Agent, getAgent } from "./agents";
import { recordAudit } from "./audit";
import { autoProvider } from "./auto-model";
import { agentBrainAccess, brainModelOptions, brainOf } from "./brain-settings";
import type { BrainKind } from "./brains/types";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { modelInfoFor } from "./credentials";
import { NotFoundError, ValidationError } from "./errors";
import { getMachine } from "./machines";
import { can } from "./organizations";
import { isRightHand } from "./right-hand";
import type { AgentRun } from "./runs";

/**
 * A model chosen for one agent in one conversation alone (ADR 0032, addendum 2026-11-15). The conversation is a thread
 * (its root message) or a channel as a whole (a DM); a thread with none of its own takes its channel's. Only a model
 * the agent already thinks with in the same way: its API key's provider, or its computer brain's own list. The run
 * thinks with it; who pays, the budget and every other setting stay the agent's.
 */

/** Where a conversation model applies: the channel, and the thread inside it (null: the channel as a whole). */
export interface ConversationPlace {
  channelId: string;
  threadId?: string | null;
}

export interface ConversationModelOption {
  value: string;
  label: string;
}

export interface ConversationModelView {
  agentId: string;
  channelId: string;
  threadId: string | null;
  /** The brain the choice is for: the agent's own. */
  brain: BrainKind;
  /** This conversation's own choice; null: none here. */
  model: string | null;
  /** A thread's channel's choice, which applies while the thread has none of its own. */
  inherited: string | null;
  /** The name of the model that applies here (its own, else the inherited one); null: the agent's own. */
  label: string | null;
  /** What may be chosen here: empty when the agent's AI has no other model to offer (an endpoint's, the right hand). */
  options: ConversationModelOption[];
  /** The caller may change it: an admin who manages agents, or the agent's owner. */
  canEdit: boolean;
}

/**
 * The provider whose key an API agent thinks with, so another of its models runs on the same key: its model's maker,
 * or on Automático its key's line. An endpoint's model runs only on its endpoint, so it has no other.
 */
async function apiLine(db: Executor, agent: Agent): Promise<string | null> {
  if (isCustomModel(agent.model)) return null;
  const provider = isAutoModel(agent.model) ? await autoProvider(db, agent) : modelProvider(agent.model);
  return provider && provider !== "custom" ? provider : null;
}

/** The models an agent may be given in a conversation, with the way it thinks now. */
async function optionsFor(db: Database, agent: Agent): Promise<ConversationModelOption[]> {
  if (isRightHand(agent)) return [];
  const brain = brainOf(agent.brain);
  if (brain === "model") {
    const line = await apiLine(db, agent);
    if (!line) return [];
    return Object.entries(MODEL_CATALOG)
      .filter(([id, m]) => m.provider === line && (m.pick !== false || id === agent.model))
      .map(([id, m]) => ({ value: id, label: m.label }));
  }
  return computerOptions(db, agent, brain);
}

/**
 * A computer brain's models as the agent's account serves them: a coding plan's own (ADR 0032 §5, amended
 * 2026-10-31: "only that plan's models"), else what the brain offers on its computer. Never Automático: a conversation
 * pins a model.
 */
async function computerOptions(db: Database, agent: Agent, brain: BrainKind): Promise<ConversationModelOption[]> {
  if (brain === "claude_code" && agent.brainAccountId) {
    const [account] = await db
      .select({ provider: schema.machineAccounts.provider })
      .from(schema.machineAccounts)
      .where(and(eq(schema.machineAccounts.orgId, agent.orgId), eq(schema.machineAccounts.id, agent.brainAccountId)));
    const plan = planOf(account?.provider);
    if (plan) return plan.claudeCode.models.map((m) => ({ value: m.id, label: m.label }));
  }
  const machine = agent.machineId ? await getMachine(db, agent.orgId, agent.machineId) : null;
  return brainModelOptions(brain, machine)
    .filter((o) => !isAutoModel(o.value))
    .map((o) => ({ value: o.value, label: o.label }));
}

/** The model as stored for `brain`, or a `ValidationError` when the agent can't think with it the way it thinks now. */
async function checkedModel(db: Database, agent: Agent, brain: BrainKind, value: string): Promise<string> {
  if (isAutoModel(value)) throw new ValidationError("A conversation's model is a model", "brain.invalid_model");
  if (brain === "model") {
    const line = await apiLine(db, agent);
    const info = line ? await modelInfoFor(db, value, agent.orgId) : undefined;
    if (!line || !info || info.provider !== line || isCustomModel(value)) {
      throw new ValidationError("Choose one of the models of the agent's own key", "brain.invalid_model");
    }
    return value;
  }
  if (!(await computerOptions(db, agent, brain)).some((o) => o.value === value)) {
    throw new ValidationError("Choose one of the models its account serves", "brain.invalid_model", { brain });
  }
  return value;
}

const choicesKey = (orgId: string, agentId: string, channelId: string) => `${orgId}:${agentId}:${channelId}`;

/**
 * The choice that applies to `run`: its thread's, else its channel's, for the brain the agent thinks with now. Every
 * run reads it before its model call, so the agent's choices in a channel (the channel's own and its threads', few)
 * are kept in the process's cache: a run on a warm cache makes no statement for them.
 */
async function storedChoice(
  db: Executor,
  agent: Agent,
  channelId: string,
  threadId: string | null,
): Promise<{ own: string | null; inherited: string | null }> {
  const all = (await caches.conversationModels.getOrLoad(choicesKey(agent.orgId, agent.id, channelId), () =>
    db
      .select({
        id: schema.conversationModels.conversationId,
        model: schema.conversationModels.model,
        brain: schema.conversationModels.brain,
      })
      .from(schema.conversationModels)
      .where(
        and(
          eq(schema.conversationModels.orgId, agent.orgId),
          eq(schema.conversationModels.agentId, agent.id),
          eq(schema.conversationModels.channelId, channelId),
        ),
      ),
  )) as { id: string; model: string; brain: string }[];
  const brain = brainOf(agent.brain);
  const rows = all.filter((r) => r.brain === brain);
  const own = rows.find((r) => r.id === (threadId ?? channelId))?.model ?? null;
  const inherited = threadId ? (rows.find((r) => r.id === channelId)?.model ?? null) : null;
  return { own, inherited };
}

/**
 * The agent as a run in this conversation thinks: the conversation's model in place of its own (`model` for the API
 * brain, `brainModel` for a computer brain), else the agent as it is. A choice made for another brain than the one it
 * thinks with now, or one its key no longer serves, is passed over. The right hand thinks with each person's own AI.
 */
export async function withConversationModel(
  db: Executor,
  agent: Agent,
  run: Pick<AgentRun, "channelId">,
  threadId: string | null,
): Promise<Agent> {
  if (isRightHand(agent)) return agent;
  const { own, inherited } = await storedChoice(db, agent, run.channelId, threadId);
  const model = own ?? inherited;
  if (!model || model === (brainOf(agent.brain) === "model" ? agent.model : agent.brainModel)) return agent;
  if (brainOf(agent.brain) !== "model") return { ...agent, brainModel: model };
  const line = await apiLine(db, agent);
  return line && modelProvider(model) === line ? { ...agent, model } : agent;
}

/** The thread must be a message of the channel: a choice never lands in another conversation. */
async function checkPlace(db: Database, orgId: string, place: ConversationPlace): Promise<string | null> {
  const threadId = place.threadId ?? null;
  if (!threadId) return null;
  const [root] = await db
    .select({ channelId: schema.messages.channelId })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.id, threadId)));
  if (!root || root.channelId !== place.channelId) throw new NotFoundError("Thread not found");
  return threadId;
}

/** `GET …/agents/{id}/conversation-model`: whoever reads the conversation sees it; who may change it is told. */
export async function getConversationModel(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  place: ConversationPlace,
): Promise<ConversationModelView> {
  const { workspace } = await requireChannelAccess(db, userId, orgId, place.channelId);
  const threadId = await checkPlace(db, orgId, place);
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const { own, inherited } = await storedChoice(db, agent, place.channelId, threadId);
  const applies = own ?? inherited;
  const brain = brainOf(agent.brain);
  const options = isRightHand(agent) ? [] : await optionsFor(db, agent);
  const label = applies
    ? (options.find((o) => o.value === applies)?.label ?? MODEL_CATALOG[applies]?.label ?? applies)
    : null;
  const canEdit = !isRightHand(agent) && (can(workspace, "manage_agents") || agent.ownerUserId === userId);
  return {
    agentId,
    channelId: place.channelId,
    threadId,
    brain,
    model: own,
    inherited,
    label,
    options: canEdit ? options : [],
    canEdit,
  };
}

/**
 * `PUT …/agents/{id}/conversation-model`: an admin or the agent's owner who reads the conversation gives the agent
 * another model there, or `model: null` back to its own. Audited.
 */
export async function setConversationModel(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  input: ConversationPlace & { model: string | null },
): Promise<ConversationModelView> {
  const { agent } = await agentBrainAccess(db, userId, orgId, agentId);
  if (isRightHand(agent)) {
    throw new ValidationError("The team's right hand thinks with each person's own AI", "brain.right_hand");
  }
  await requireChannelAccess(db, userId, orgId, input.channelId);
  const threadId = await checkPlace(db, orgId, input);
  const conversationId = threadId ?? input.channelId;
  const brain = brainOf(agent.brain);
  const where = and(
    eq(schema.conversationModels.agentId, agent.id),
    eq(schema.conversationModels.conversationId, conversationId),
  );
  const [before] = await db
    .select({ model: schema.conversationModels.model, brain: schema.conversationModels.brain })
    .from(schema.conversationModels)
    .where(where);
  const model = input.model === null ? null : await checkedModel(db, agent, brain, input.model);
  await db.transaction(async (tx) => {
    if (model === null) await tx.delete(schema.conversationModels).where(where);
    else {
      const values = { brain, model, setByUserId: userId, updatedAt: new Date() };
      await tx
        .insert(schema.conversationModels)
        .values({ orgId, agentId: agent.id, channelId: input.channelId, conversationId, ...values })
        .onConflictDoUpdate({
          target: [schema.conversationModels.agentId, schema.conversationModels.conversationId],
          set: values,
        });
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "agent.conversation_model_changed",
      target: { type: "agent", id: agent.id },
      channelId: input.channelId,
      details: {
        ...(threadId ? { threadId } : {}),
        brain,
        from: before?.brain === brain ? before.model : null,
        to: model,
      },
    });
  });
  caches.conversationModels.delete(choicesKey(orgId, agent.id, input.channelId));
  return getConversationModel(db, userId, orgId, agentId, input);
}
