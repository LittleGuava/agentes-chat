import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { moveAgentToGroup } from "./agent-groups";
import { type Agent, createAgent, freeHandle, getAgent, takenHandles } from "./agents";
import { setAgentAppearance } from "./appearance";
import { setAgentAudience } from "./audience";
import { setAgentBrain } from "./brain-settings";
import { isComputerBrain } from "./brains/types";
import { setAgentBrowserDomains } from "./browser/settings";
import { connectorGrantValidator } from "./connectors/connections";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { agentRepositoryList, setAgentRepositories } from "./git/repos";
import { setAgentComputerTarget } from "./machines";
import { isCommandApproval } from "./missions";
import { can, requirePermission } from "./organizations";
import { setReportsTo } from "./reporting";
import { isRightHand, rightHandPermanent } from "./right-hand";
import { setAgentSkills } from "./skills";
import { AgentHeldError, standingRefusal } from "./standing";
import { isBuiltinScope, listAgentScopes, setAgentScopes } from "./tools/scopes";
import { orgDefaultAgentBudget } from "./usage";

/*
 * "Duplicar" on an agent: a new agent with the same settings, made by whoever duplicates it and owned by them. Every
 * part goes through the call that sets it on any agent, with that call's own check of who may: what they couldn't set
 * on an agent of theirs stays as a new agent starts, and the copy says which parts (`skipped`).
 *
 * Never copied: what the agent lived rather than what it was set to be. Its memory and what it learned (notes,
 * agent-made skills), its conversations, channels and DMs, its routines (a copy would fire the same work twice), its
 * status, its missions and computer sessions, what people approved for good for it, its mailboxes and databases (only
 * their owners give them, ADR 0038 and 0039), its browser profile and the repositories it merges in without asking.
 */

const { agents, agentSkills, skills } = schema;

/** A part of the agent its copy didn't take, because the person duplicating it may not set it. */
export type DuplicateSkipped =
  /** What it may use (connections and tools): only who manages agents grants access. */
  | "access"
  /** How much it asks before acting (ADR 0173). */
  | "approvals"
  /** A budget over the workspace's default. */
  | "budget"
  /** Its autonomy brakes (ADR 0131). */
  | "brakes"
  /** Who thinks for it: its computer, or a plan that may not think for the copy (ADR 0059). */
  | "ai"
  /** Who it reports to and its group in the sidebar. */
  | "team";

export interface DuplicatedAgent {
  agent: Agent;
  skipped: DuplicateSkipped[];
}

/** A refusal of one part of the copy: the copy keeps how a new agent starts there. Anything else is a real failure. */
const refused = (error: unknown) =>
  error instanceof ForbiddenError ||
  error instanceof ConflictError ||
  error instanceof ValidationError ||
  error instanceof NotFoundError;

/** The longest name an agent takes (the API's). */
const NAME_MAX = 80;

/**
 * `POST …/agents/{agentId}/duplicate`: who may create agents and edit this one (an admin, or its owner). `name` is the
 * copy's, in the person's language (default "{name} (copy)"); its handle is the first free one after the original's.
 */
export async function duplicateAgent(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
  options: { name?: string } = {},
): Promise<DuplicatedAgent> {
  const { db, pubsub } = deps;
  const membership = await requirePermission(db, actorId, orgId, "create_agents");
  const source = await getAgent(db, orgId, agentId);
  if (!source || source.archivedAt) throw new NotFoundError("Agent not found");
  if (isRightHand(source)) throw rightHandPermanent("duplicated");
  const admin = can(membership, "manage_agents");
  if (!admin && source.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can duplicate it", "agent.not_owner");
  }
  // A held agent stays held: its copy would be the same agent without the hold.
  const standing = await standingRefusal(db, orgId, source.id);
  if (standing instanceof AgentHeldError) throw standing;

  const skipped = new Set<DuplicateSkipped>();
  const overDefault =
    source.monthlyBudgetNanoUsd != null && source.monthlyBudgetNanoUsd > (await orgDefaultAgentBudget(db, orgId));
  if (!admin && overDefault) skipped.add("budget");
  const brakes = Object.keys(source.autonomyBrakes).length > 0;
  if (!admin && brakes) skipped.add("brakes");
  if (!admin && source.approvalsLevel !== "risky") skipped.add("approvals");
  const name = (options.name?.trim() || `${source.name} (copy)`).slice(0, NAME_MAX);
  const extras = source.setup ?? null;
  const copy = await createAgent(
    db,
    actorId,
    orgId,
    {
      name,
      handle: freeHandle(source.handle, await takenHandles(db, orgId)),
      role: source.role,
      instructions: source.instructions,
      model: source.model,
      credentialId: source.credentialId,
      mediaReplies: source.mediaReplies,
      ...(admin || !overDefault ? { monthlyBudgetNanoUsd: source.monthlyBudgetNanoUsd } : {}),
      ...(admin && brakes ? { autonomyBrakes: source.autonomyBrakes } : {}),
      ...(admin ? { approvalsLevel: source.approvalsLevel } : {}),
      ...(isCommandApproval(source.missionCommandApproval) ? { autonomy: source.missionCommandApproval } : {}),
      setup: { role: extras?.role ?? null, starter: extras?.starter ?? null, apps: extras?.apps ?? null },
    },
    { model: source.model },
    { duplicateOf: source.id, pubsub },
  );
  const attempt = async (part: DuplicateSkipped | null, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      if (!refused(error)) throw error;
      if (part) skipped.add(part);
    }
  };

  // Who thinks for it: its computer first (an account is a folder on one computer), then its brain on it, with the
  // same account only where that plan may think for the copy's owner (ADR 0059). Never taken from the original.
  const computer = source.machineId !== copy.machineId;
  if (computer && source.machineId) {
    const machineId = source.machineId;
    await attempt("ai", () => setAgentComputerTarget({ db, pubsub }, actorId, orgId, copy.id, machineId));
  }
  const onComputer = (await getAgent(db, orgId, copy.id))?.machineId === source.machineId;
  const brain = {
    speed: source.brainSpeed,
    contextTokens: source.contextTokens,
    fallback: source.brainFallback,
    extraUsage: source.brainExtraUsage,
  };
  if (isComputerBrain(source.brain) && !onComputer) skipped.add("ai");
  else if (isComputerBrain(source.brain)) {
    const plan = {
      ...brain,
      brain: source.brain,
      model: source.brainModel,
      effort: source.brainEffort,
      account: source.brainAccountId,
    };
    await attempt("ai", () => setAgentBrain({ db }, actorId, orgId, copy.id, plan, { remember: false }));
  } else if (brain.speed !== "standard" || brain.contextTokens !== null) {
    await attempt("ai", () => setAgentBrain({ db }, actorId, orgId, copy.id, brain, { remember: false }));
  }

  // Who it answers, after its brain: a move onto a plan narrows it, and the original's is what the copy keeps. Never
  // skipped: a copy left answering everyone would be wider than its original.
  await setAgentAudience(db, actorId, orgId, copy.id, {
    mode: source.audienceMode,
    userIds: source.audienceUserIds,
    roleIds: source.audienceRoleIds,
    consultable: source.consultable,
  });
  if (source.appearance) {
    const look = source.appearance;
    await attempt(null, () => setAgentAppearance(db, actorId, orgId, copy.id, look));
  }

  // What it may use. Grants that no longer name a scope that exists (a connector's catalog changed) stay behind.
  const grants = await listAgentScopes(db, orgId, source.id);
  if (admin) {
    const valid = [];
    for (const grant of grants) {
      const problem = grant.connectionId
        ? await connectorGrantValidator(db, orgId, grant)
        : isBuiltinScope(grant.scope)
          ? null
          : "unknown";
      if (!problem) valid.push(grant);
    }
    await setAgentScopes(db, actorId, orgId, copy.id, valid, connectorGrantValidator);
  } else if (grants.length > 0) skipped.add("access");

  // Its skills, the team's and the duplicating person's own: never one an agent wrote (what it learned) nor another
  // person's (only they give it to an agent).
  const skillRows = await db
    .select({ skillId: agentSkills.skillId, enabled: agentSkills.enabled, ownerUserId: skills.ownerUserId })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, source.id),
        eq(skills.origin, "person"),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(asc(agentSkills.createdAt));
  const skillInput = skillRows
    .filter((s) => !s.ownerUserId || s.ownerUserId === actorId)
    .map(({ skillId, enabled }) => ({ skillId, enabled }));
  if (skillInput.length > 0) await setAgentSkills(db, actorId, orgId, copy.id, skillInput);

  // Where it may work: its repositories (empty = every one) and the sites its browser may open.
  const repositories = await agentRepositoryList(db, orgId, source.id);
  if (repositories.length > 0) {
    await attempt("access", () => setAgentRepositories(db, actorId, orgId, copy.id, repositories));
  }
  if (source.browserAllowedDomains?.length) {
    const domains = source.browserAllowedDomains;
    await attempt("access", () => setAgentBrowserDomains(db, undefined, actorId, orgId, copy.id, domains));
  }

  // Its place in the team: who it reports to and its group, right after the original.
  const team = source.reportsToAgentId !== null || source.groupId !== null;
  if (team && !admin) skipped.add("team");
  if (team && admin) {
    if (source.reportsToAgentId) {
      const to = source.reportsToAgentId;
      await attempt("team", () =>
        setReportsTo({ db, pubsub }, actorId, orgId, [{ agentId: copy.id, reportsToAgentId: to }]),
      );
    }
    if (source.groupId) {
      const groupId = source.groupId;
      const placed = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.groupId, groupId), isNull(agents.archivedAt)))
        .orderBy(asc(agents.groupPosition), asc(agents.createdAt));
      const index = placed.filter((a) => a.id !== copy.id).findIndex((a) => a.id === source.id) + 1;
      await attempt("team", () => moveAgentToGroup({ db, pubsub }, actorId, orgId, copy.id, { groupId, index }));
    }
  }

  await publishAgentsChanged(pubsub, orgId);
  const agent = await getAgent(db, orgId, copy.id);
  if (!agent) throw new NotFoundError("Agent not found");
  return { agent, skipped: [...skipped] };
}
