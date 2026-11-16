import { and, type Executor, eq, schema } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import { claudeCodeModel, planOf } from "@agenteschat/providers/plans";
import type { Agent } from "../agents";
import type { MachineStatus } from "../machine-hub";
import { isRightHand } from "../right-hand";
import type { AgentRun } from "../runs";
import { brainSessionId } from "./claude-code";
import { reserveChainOf } from "./reserve-chain";
import {
  type BrainPlan,
  brainEffortFor,
  brainModelFor,
  computerBrainUnavailable,
  planIsOwners,
  sessionUsed,
  storedPlanUsage,
} from "./select";
import { type BrainAccount, type BrainKind, type ComputerBrainKind, isComputerBrain } from "./types";

/**
 * Whether this run may think with a reserve: a conversation's. Never background work (a routine waits for its own
 * plan, ADR 0053 §6.4, leaving the reserves to people's replies as ADR 0118 §8 does), a mission's main session (its
 * brain is the mission's), nor the team's right hand (ADR 0137 §7: it thinks with its owner's plan or says why not).
 */
export const mayUseReserve = (
  agent: Pick<Agent, "builtin">,
  run: Pick<AgentRun, "background"> & { workId?: string | null },
  plan: Pick<BrainPlan, "missionId">,
) => !run.background && !run.workId && !plan.missionId && !isRightHand(agent);

/** What a reply says about the reserve that gave it (`meta.brainReserve`), kept on the run's transcript. */
export interface ReserveRecord {
  /** Its place in the chain: a reserve that can't go on hands the run to the ones after it. */
  index: number;
  /** The agent's own AI, which couldn't answer. */
  from: { brain: BrainKind; account?: string };
  /** The reserve thinking for it now. */
  to: { brain: ComputerBrainKind; account: string; accountId: string; model?: string };
  /** Why its own AI couldn't answer (`RESERVE_CODES`), and when its limit resets when that is known. */
  code: string;
  resetsAt?: string;
}

type ReserveDeps = { db: Executor; machines?: { status(machineId: string): Promise<MachineStatus | null> } };

/**
 * The plan of the reserve at `index` for this run, when it can think now (else null): its account on the agent's
 * computer, its model, and a session of its own (named by the run and the account, so the run picks it up again).
 * `current`: the plan the run had, whose model a reserve of the same brain keeps.
 */
export async function reservePlan(
  deps: ReserveDeps,
  agent: Agent,
  run: AgentRun,
  current: Pick<BrainPlan, "kind" | "model">,
  index: number,
  now = Date.now(),
): Promise<BrainPlan | null> {
  const entry = reserveChainOf(agent.brainFallbackChain)[index];
  const machineId = agent.machineId;
  if (!entry || !machineId || !deps.machines) return null;
  const { machineAccounts } = schema;
  const [row] = await deps.db
    .select({
      id: machineAccounts.id,
      kind: machineAccounts.kind,
      label: machineAccounts.label,
      status: machineAccounts.status,
      provider: machineAccounts.provider,
    })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, agent.orgId),
        eq(machineAccounts.id, entry.accountId),
        eq(machineAccounts.machineId, machineId),
      ),
    );
  if (!row || !isComputerBrain(row.kind) || row.id === agent.brainAccountId) return null;
  const kind = row.kind;
  // A sign-in still in progress or an account being removed can't think: as good as signed out (`brainAccountFor`).
  const account: BrainAccount = {
    id: row.id,
    label: row.label,
    status: row.status === "active" ? "active" : "signed_out",
    ...(row.provider ? { provider: row.provider } : {}),
  };
  // Its own model, else the one the run thinks with when it is the same brain, else that brain's default. "Automático"
  // was decided for the agent's own plan: a reserve runs its brain's default instead.
  const asked = entry.model ?? (current.kind === kind ? current.model : null) ?? null;
  const chosen = brainModelFor(kind, { brain: kind, brainModel: asked && !isAutoModel(asked) ? asked : null });
  const model = kind === "claude_code" && chosen ? claudeCodeModel(planOf(account.provider), chosen) : chosen;
  const [status, usage, ownersPlan] = await Promise.all([
    deps.machines.status(machineId).catch(() => null),
    storedPlanUsage(deps.db, agent.orgId, machineId, kind, account.id).catch(() => null),
    planIsOwners(deps.db, { orgId: agent.orgId, ownerUserId: agent.ownerUserId }, machineId, account),
  ]);
  if (computerBrainUnavailable(kind, machineId, status, now, account, ownersPlan, usage, model)) return null;
  const id = brainSessionId(agent.id, `${run.id}:reserve:${account.id}`, kind);
  const effort = brainEffortFor(agent, kind);
  return {
    kind,
    ...(model ? { model } : {}),
    session: { id, resume: await sessionUsed(deps.db, run, kind, id), machineId, cwd: "" },
    account,
    ...(effort ? { effort } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** The first reserve after `after` (its index; -1 for the first) that can think now, with its place in the chain. */
export async function nextReserve(
  deps: ReserveDeps,
  agent: Agent,
  run: AgentRun,
  current: Pick<BrainPlan, "kind" | "model">,
  after: number,
): Promise<{ index: number; plan: BrainPlan } | null> {
  const chain = reserveChainOf(agent.brainFallbackChain);
  for (let index = after + 1; index < chain.length; index++) {
    const plan = await reservePlan(deps, agent, run, current, index);
    if (plan) return { index, plan };
  }
  return null;
}
