import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gt, ne, or, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { personOfMessage } from "./authority";
import { getChannelCached } from "./context";
import { deliverNotice, publishDelivery } from "./delivery";
import { eligibleChannelAgents } from "./dispatch";
import { isAgentOnlyDm, openPersonAgentDm } from "./dms";
import { cutText } from "./format";
import type { Notice } from "./notices";
import { getMembership } from "./organizations";
import { isRightHandId, rightHandReader } from "./right-hand";
import { defineLodiLane } from "./right-hand-lane";
import { lodiFor, lodiSwitches, saidOnce } from "./right-hand-proactive";
import { forPeople } from "./run-resume";
import { type AgentRun, replyThreadOf, runErrorDetail } from "./runs";
import type { ToolDefinition, ToolSource } from "./tools/types";

/**
 * "Cuidar das falhas" (ADR 0177 addendum 2026-11-15): a conversation task that failed for a cause a later try may pass
 * becomes an incident in the right hand's DM with the person behind it, and the right hand may try it again
 * (`retry_run`), within limits so a crash loop stays one incident and not a storm.
 *
 * - `raiseIncident`, from `reportRunFailure`: a `run_incident` notice only the right hand reads, once per failed run,
 *   whose `refs.runId` is the failed run, so its turn is that person's (`authority.ts`, `returnsTo`). At most
 *   `INCIDENT_WAKES_AN_HOUR` of them a person an hour start a turn; the rest wait for its next one.
 * - `retry_run`: a `run_retry` notice in the failed run's conversation, as its agent, whose `refs.runId` is the failed
 *   run: the new run is the same person's, on the same request, in a fresh stretch. Once per failed run, `RUN_RETRIES`
 *   per chain, `RETRIES_AN_HOUR` a person an hour.
 * - The workspace's switch (`organization_settings.incidents`) stops both.
 *
 * No model is called from here: the right hand's turn decides.
 */

/** How many incident notices a person an hour start a turn of the right hand. */
export const INCIDENT_WAKES_AN_HOUR = 3;
/** How many times one failed request is tried again: the try after that, failed, is explained, not retried. */
export const RUN_RETRIES = 2;
/** How many retries the right hand starts for one person in an hour. */
export const RETRIES_AN_HOUR = 3;

export const RETRY_RUN_TOOL = "retry_run";

const HOUR_MS = 3_600_000;

const { agentRuns, messages } = schema;

/** Why a task failed, when a later try may pass it, by what its stored error says. */
export type IncidentCause = "provider" | "computer" | "cli" | "interrupted" | "empty";

/** The cause in words, for the right hand and the agent that tries again. */
const CAUSE_WORDS: Record<IncidentCause, string> = {
  provider: "its AI provider kept failing until the task gave up (an outage, a rate limit or a timeout)",
  computer: "its computer failed or stopped answering",
  cli: "its coding program on the computer stopped before it answered",
  interrupted: "the server restarted in the middle of it",
  empty: "its AI gave an empty answer",
};

/** A provider's outage that outlasted every wait, unless the provider refused the key itself: no wait passes that. */
const KEY_REFUSED: ReadonlySet<string> = new Set([
  "run.provider_no_credit",
  "run.provider_invalid_key",
  "run.provider_no_access",
  "run.provider_model_unavailable",
  "run.our_error",
]);

const BY_CODE: Readonly<Record<string, IncidentCause>> = {
  "run.computer_failed": "computer",
  "run.computer_timeout": "computer",
  "run.brain_interrupted": "computer",
  "run.cli_failed": "cli",
  "run.cli_closed": "cli",
  "run.cli_stopped": "cli",
  "run.interrupted": "interrupted",
  "run.empty_reply": "empty",
};

/**
 * The cause of a run's stored error when another try may pass it, else null: an allowlist, so a sign-in, a key, a
 * budget, a setting or an error of ours that already repeated is never retried.
 */
export function incidentCause(error: string | null | undefined): IncidentCause | null {
  const detail = runErrorDetail(error);
  if (!error || !detail) return null;
  if (error.startsWith("gave_up:")) return KEY_REFUSED.has(detail.errorCode) ? null : "provider";
  return BY_CODE[detail.errorCode] ?? null;
}

/** Whether the workspace has the switch on (no row: on). */
export const incidentsOn = async (db: Executor, orgId: string) => (await lodiSwitches(db, orgId)).incidents;

/** How many times the request behind `run` was already tried again: its trigger's `run_retry` notice says. */
async function attemptOf(db: Executor, run: Pick<AgentRun, "orgId" | "triggerMessageId">) {
  const [trigger] = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  const notice = trigger?.meta.notice as { kind?: unknown; refs?: Record<string, unknown> } | undefined;
  if (notice?.kind !== "run_retry") return 0;
  const n = Number(notice.refs?.attempt);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** One of `max` slots of the hour for `key`, while any is left (a fixed hour, the server's clock). */
async function takeSlot(tx: Executor, orgId: string, key: string, max: number) {
  const hour = Math.floor(Date.now() / HOUR_MS);
  for (let n = 1; n <= max; n++) if (await saidOnce(tx, orgId, `${key}:${hour}:${n}`)) return true;
  return false;
}

/** Where a run was, in words: a channel by name, else a direct conversation; in a thread or not. */
function placeOf(channel: { kind: string; name: string }, run: Pick<AgentRun, "threadRootId" | "triggerMessageId">) {
  const where = channel.kind === "dm" ? "a direct conversation" : `#${channel.name}`;
  return replyThreadOf(run) ? `a thread in ${where}` : where;
}

/**
 * A conversation run failed for good (`reportRunFailure`, after its person was notified): the right hand hears it as
 * an incident in its DM with the person at the root of the request, when the cause may pass, the switch is on and it
 * may talk to them. Not its own runs, long work's (`endWork` and Continuar own those), nor the agents' DM. The caller
 * leaves out a run another agent's mention woke: that agent hears it and decides. Returns whether it was told.
 */
export async function raiseIncident(deps: { db: Database; pubsub?: PubSub }, run: AgentRun, reason: string) {
  const { db } = deps;
  const cause = incidentCause(reason);
  if (!cause || run.background || run.workId) return false;
  if (!(await incidentsOn(db, run.orgId))) return false;
  const person = await personOfMessage(db, run.orgId, run.triggerMessageId);
  if (!person) return false;
  const lodi = await lodiFor(db, run.orgId, person);
  if (!lodi || lodi.id === run.agentId) return false;
  const [agent, channel] = await Promise.all([
    getAgentCached(db, run.orgId, run.agentId),
    getChannelCached(db, run.orgId, run.channelId),
  ]);
  if (!agent || !channel || isAgentOnlyDm(channel)) return false;
  const attempt = await attemptOf(db, run);
  const left = Math.max(0, RUN_RETRIES - attempt);
  const tried = attempt > 0 ? ` It was already tried again ${attempt === 1 ? "once" : `${attempt} times`}.` : "";
  const notice: Notice = {
    kind: "run_incident",
    from: `@${agent.handle}`,
    // The server's own words only: the stored error and the request may carry outside words.
    text: `@${agent.handle}'s task in ${placeOf(channel, run)} failed: ${CAUSE_WORDS[cause]}. Run id: ${run.id}.${tried} Retries left: ${left}.`,
    refs: {
      runId: run.id,
      agentId: agent.id,
      agentHandle: agent.handle,
      channelId: run.channelId,
      cause,
      attempt: String(attempt),
      retriesLeft: String(left),
    },
  };
  const delivered = await db.transaction(async (tx) => {
    if (!(await saidOnce(tx, run.orgId, `right_hand.incident:${run.id}`))) return null;
    const wake = await takeSlot(tx, run.orgId, `right_hand.incident_wake:${person}`, INCIDENT_WAKES_AN_HOUR);
    const dm = await openPersonAgentDm(tx, run.orgId, person, lodi.id);
    return deliverNotice(tx, {
      orgId: run.orgId,
      agentId: lodi.id,
      channelId: dm.id,
      threadId: null,
      hop: 0,
      stretchId: null,
      notice,
      // Without its @handles: the stored words never mention, and so never start, an agent.
      body: forPeople(notice),
      wake,
      trigger: "dm",
    });
  });
  if (delivered) await publishDelivery(deps.pubsub, delivered).catch(() => {});
  return Boolean(delivered);
}

/** A refusal the right hand reads. */
const refused = (content: string) => ({ content, isError: true });

/** Rolls the retry's transaction back with what the right hand reads. */
class RetryRefused extends Error {}

/**
 * `retry_run`: the failed run's agent is asked to try again where it failed, for the same person. Only for a run whose
 * incident was told in this DM, by someone who may stop it, while its agent may still answer that person there and
 * hasn't worked there since. Audited.
 */
async function retryRun(
  deps: { pubsub?: PubSub },
  ctx: Parameters<ToolDefinition["execute"]>[1],
  runId: string,
  why: string,
) {
  const { db, orgId } = ctx;
  const person = await rightHandReader(ctx);
  if (!person) return refused("Only in your private conversation with the person whose task failed.");
  if (!(await incidentsOn(db, orgId))) return refused("Retrying failed tasks is turned off in this workspace.");
  const [told] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, ctx.channelId),
        eq(messages.authorAgentId, ctx.agentId),
        sql`${messages.meta}->'notice'->>'kind' = 'run_incident'`,
        sql`${messages.meta}->'notice'->'refs'->>'runId' = ${runId}`,
      ),
    )
    .limit(1);
  if (!told) return refused("No incident about that run was told here: only a task that failed for this person.");
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (run?.status !== "failed") return refused("That task isn't a failed one anymore.");
  if ((await personOfMessage(db, orgId, run.triggerMessageId)) !== person)
    return refused("That task is someone else's.");
  const membership = await getMembership(db, person, orgId);
  const agent = await getAgentCached(db as Database, orgId, run.agentId);
  // Still a member, and the task's own person (above): the one who may ask for it again.
  if (!membership || !agent) return refused("That task can't be tried again.");
  if ((await eligibleChannelAgents(db, orgId, run.channelId, [run.agentId], { requesterUserId: person })).length === 0)
    return refused(`@${agent.handle} can't answer this person there anymore.`);
  const attempt = (await attemptOf(db, run)) + 1;
  if (attempt > RUN_RETRIES)
    return refused(
      `It was already tried again ${RUN_RETRIES} times: don't retry it. Tell them in a sentence or two what keeps failing.`,
    );
  // Where it is tried again: under the failed task's own root (its request, or its thread's), which a run always reads
  // whole, so the request is in the new run's context however much the channel said since.
  const threadId = run.threadRootId;
  const mainTimeline = replyThreadOf(run) === null;
  const [since] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, run.agentId),
        eq(agentRuns.channelId, run.channelId),
        ne(agentRuns.id, run.id),
        gt(agentRuns.createdAt, run.createdAt),
        // The same conversation: its thread, and for a task of the main timeline that timeline too (a run there
        // answers its own trigger).
        mainTimeline
          ? or(eq(agentRuns.threadRootId, threadId), sql`${agentRuns.threadRootId} = ${agentRuns.triggerMessageId}`)
          : eq(agentRuns.threadRootId, threadId),
      ),
    )
    .limit(1);
  if (since) return refused(`@${agent.handle} has worked there since: trying again could redo it. Don't retry it.`);
  const lodi = await getAgentCached(db as Database, orgId, ctx.agentId);
  const lodiName = lodi?.name ?? "The team's right hand";
  const said = cutText(why.replace(/\s+/g, " ").trim(), 300);
  const notice: Notice = {
    kind: "run_retry",
    from: lodiName,
    // Server words only: the right hand's own line ("why") goes to the audit log, never into another agent's turn.
    text: `Your task here failed. ${lodiName} asked you to try it again.`,
    refs: {
      runId: run.id,
      byAgentId: ctx.agentId,
      byAgentName: lodiName,
      attempt: String(attempt),
    },
  };
  try {
    const delivered = await db.transaction(async (tx) => {
      if (!(await saidOnce(tx, orgId, `right_hand.incident_retry:${run.id}`)))
        throw new RetryRefused("It was already tried again. Don't retry it.");
      if (!(await takeSlot(tx, orgId, `right_hand.incident_retries:${person}`, RETRIES_AN_HOUR)))
        throw new RetryRefused(
          `You already tried ${RETRIES_AN_HOUR} tasks again for this person this hour. Tell them what failed instead.`,
        );
      const out = await deliverNotice(tx, {
        orgId,
        agentId: run.agentId,
        channelId: run.channelId,
        threadId,
        // A fresh stretch, as a person's own ask: the limits here are this file's.
        hop: 0,
        stretchId: null,
        notice,
        body: forPeople(notice),
        trigger: run.trigger === "dm" ? "dm" : "mention",
      });
      const [again] = out.runs;
      if (!again) throw new RetryRefused(`@${agent.handle} couldn't start it again there.`);
      await recordAudit(tx, {
        orgId,
        actor: { type: "agent", id: ctx.agentId },
        action: "run.retried",
        target: { type: "agent_run", id: again.id },
        details: { agentId: run.agentId, retries: run.id, attempt, ...(said ? { why: said } : {}) },
        runId: ctx.runId,
        channelId: run.channelId,
        onBehalfOfUserId: person,
      });
      return out;
    });
    await publishDelivery(deps.pubsub, delivered).catch(() => {});
  } catch (error) {
    if (error instanceof RetryRefused) return refused(error.message);
    throw error;
  }
  const left = RUN_RETRIES - attempt;
  return {
    content: `@${agent.handle} is trying it again where it failed (try ${attempt} of ${RUN_RETRIES}${left === 0 ? ", the last" : ""}). What comes of it stays in that conversation: if it fails again, you'll hear of it here.`,
  };
}

/**
 * `retry_run`: the right hand's, in the core group, while the workspace's switch is on. It refuses anywhere but a
 * person's own DM with it (`rightHandReader`), as `team_status` does.
 */
export function createIncidentToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: RETRY_RUN_TOOL,
    description:
      "Try a failed task again, for the person you are talking to here: the same agent, where it failed, on the same request. Only a task an incident told you about here, when its cause may pass by itself and it has retries left.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The failed task's run id, from the incident." },
        why: { type: "string", description: "One short line for the audit log: why it is tried again." },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Try a failed task again" }),
    async execute(input, ctx) {
      const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return refused("run_id must be the failed task's run id.");
      return retryRun(deps, ctx, runId, typeof input.why === "string" ? input.why : "");
    },
  };
  return {
    name: "incidents",
    tools: async (ctx) =>
      (await isRightHandId(ctx.db, ctx.orgId, ctx.agentId)) && (await incidentsOn(ctx.db, ctx.orgId)) ? [tool] : [],
  };
}

/** The lane: its switch on the right hand's page. Its work starts from `reportRunFailure`, not a job. */
export const incidentsLane = defineLodiLane({ switch: "incidents", live: true, jobs: {} });
