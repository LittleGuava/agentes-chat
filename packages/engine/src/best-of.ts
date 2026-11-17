import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, inArray, like, schema, sql } from "@agenteschat/db";
import { costNanoUsd, modelInfo } from "@agenteschat/providers";
import { currentHandles } from "./agents";
import { canTalkTo, speakerOf } from "./audience";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { stopRun } from "./cancel";
import { sha256 } from "./crypto";
import { deliverNotice, publishDelivery } from "./delivery";
import { createAgentRuns } from "./dispatch";
import { ForbiddenError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { insertMessageWithRuns, type Message, messageView, parseMentionHandles } from "./messages";
import { can, type Membership } from "./organizations";
import { enqueue } from "./outbox";
import { rightHandReaches } from "./right-hand";
import { type AgentRun, isTerminal } from "./runs";
import { effectiveAgentBudget, monthStartUtc } from "./usage";

const { agents, agentBudgetPeriods, agentRuns, channelMembers, channels, messages, usageRecords } = schema;

/**
 * Best of N (ADR 0192): `/burst N <request>` runs the agent N times on the same request, each attempt in a private
 * room of its own, then one more turn of the agent in the conversation compares what came back and answers once with
 * the best (or a merge of the best parts).
 */
export const BURST_MAX_ATTEMPTS = 3;
export const BURST_MIN_ATTEMPTS = 2;
/** Without a number, it tries this many times. */
export const BURST_DEFAULT_ATTEMPTS = 3;
/** After this long the attempts that finished are compared and the rest stop: an attempt can't hold it forever. */
export const BURST_DEADLINE_MS = 30 * 60_000;
/** The job that compares: once per attempt that ends (`burstAttemptEnded`), and once at the deadline. */
export const BURST_JUDGE_JOB = "burst.judge";
/** What an attempt still working at the deadline is stopped with (its run's error). */
export const BURST_DEADLINE = "burst_deadline";
/** How much of each attempt the comparing turn reads. */
export const BURST_DRAFT_MAX_CHARS = 8_000;
/** What one attempt usually costs when the agent has too few runs to average: what a chat turn reads and writes. */
export const TYPICAL_ATTEMPT = { inputTokens: 12_000, outputTokens: 1_500 } as const;
/** How far back an agent's runs are averaged, and how many it needs for the average to count. */
const HISTORY_DAYS = 30;
const HISTORY_MIN_RUNS = 3;

export const BURST_ERRORS = {
  attempts: "burst.attempts",
  noRequest: "burst.no_request",
  needsAgent: "burst.needs_agent",
  unreachable: "burst.agent_unreachable",
  computerBrain: "burst.computer_brain",
  overBudget: "burst.over_budget",
  plainOnly: "burst.plain_only",
  missionThread: "burst.mission_thread",
} as const;

export interface BurstCommand {
  attempts: number;
  /** What each attempt is asked: the message after `/burst N`, as the person wrote it. */
  request: string;
}

const COMMAND = /^\s*\/burst(?=\s|$)\s*(?:(\d+)(?=\s|$))?\s*([\s\S]*)$/i;

/** `/burst N <request>` (N optional); null when the message isn't the command. Throws when it can't run. */
export function parseBurstCommand(body: string): BurstCommand | null {
  const match = COMMAND.exec(body);
  if (!match) return null;
  const attempts = match[1] === undefined ? BURST_DEFAULT_ATTEMPTS : Number(match[1]);
  if (!Number.isInteger(attempts) || attempts < BURST_MIN_ATTEMPTS || attempts > BURST_MAX_ATTEMPTS)
    throw new ValidationError(
      `/burst runs ${BURST_MIN_ATTEMPTS} to ${BURST_MAX_ATTEMPTS} attempts`,
      BURST_ERRORS.attempts,
      { min: BURST_MIN_ATTEMPTS, max: BURST_MAX_ATTEMPTS },
    );
  const request = (match[2] ?? "").trim();
  // Only the agent's handle is no request.
  if (!request.replace(/(^|\s)@[\w-]+/g, "").trim())
    throw new ValidationError("Say what to try after /burst", BURST_ERRORS.noRequest);
  return { attempts, request };
}

/**
 * An attempt's room (`channels.dm_key`), in the routine rooms' family (`isRoutineRoomKey`): a private conversation of
 * one agent that no person is in, kept out of people's lists, of agents' searches and of what an agents' DM means.
 * Its key names no routine (`|r:`), so nothing takes it for one.
 */
export const burstRoomKey = (agentId: string, burstId: string, attempt: number) =>
  `${burstRoomPrefix(agentId, burstId)}${attempt}`;
const burstRoomPrefix = (agentId: string, burstId: string) => `routine|a:${agentId}|burst:${burstId}|n:`;
const BURST_ROOM = /^routine\|a:[0-9a-f-]{36}\|burst:([0-9a-f-]{36})\|n:\d+$/i;

/** The burst an attempt's room belongs to (its person's message id), or null for any other conversation. */
export const burstOfRoom = (dmKey: string | null | undefined) => (dmKey ? (BURST_ROOM.exec(dmKey)?.[1] ?? null) : null);

/** What a `/burst` message carries (`meta.burst`): the agent asked and how many attempts. */
export interface BurstMeta {
  agentId: string;
  attempts: number;
}

function burstMetaOf(meta: Record<string, unknown> | null | undefined): BurstMeta | null {
  const b = meta?.burst as Partial<BurstMeta> | undefined;
  return b && typeof b.agentId === "string" && typeof b.attempts === "number" ? (b as BurstMeta) : null;
}

/**
 * What one of the agent's runs costs, in nano-USD: its average over its last 30 days of calls on the workspace's keys
 * (at least 3 runs), else its model's price for a typical chat turn; 0 when its model has no price (its calls never
 * use a budget up, as in the Model Gateway).
 */
export async function attemptCost(db: Executor, agent: { id: string; orgId: string; model: string }, now = new Date()) {
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const [row] = await db
    .select({
      runs: sql<number>`count(distinct ${usageRecords.runId})::int`,
      cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, agent.orgId),
        eq(usageRecords.agentId, agent.id),
        eq(usageRecords.kind, "agent"),
        gte(usageRecords.createdAt, since),
        sql`${usageRecords.runId} is not null`,
      ),
    );
  const runs = Number(row?.runs ?? 0);
  if (runs >= HISTORY_MIN_RUNS) return Math.ceil(Number(row?.cost ?? 0) / runs);
  if (!modelInfo(agent.model)) return 0;
  return costNanoUsd(agent.model, { ...TYPICAL_ATTEMPT, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/**
 * Whether the whole burst fits what is left of the agent's budget this month: every attempt and the comparing turn,
 * against what the Model Gateway reads (spent and reserved, `agent_budget_periods`; the month's calls before its first
 * reservation). Checked once, before anything starts; two bursts started at the same moment both read the same room
 * (the gateway still holds every call).
 */
async function requireBurstBudget(db: Database, agent: typeof agents.$inferSelect, attempts: number) {
  const each = await attemptCost(db, agent);
  if (each === 0) return;
  const now = new Date();
  const budget = await effectiveAgentBudget(db, agent);
  const [period] = await db
    .select({ spent: agentBudgetPeriods.spentNanoUsd, reserved: agentBudgetPeriods.reservedNanoUsd })
    .from(agentBudgetPeriods)
    .where(
      and(
        eq(agentBudgetPeriods.agentId, agent.id),
        eq(agentBudgetPeriods.periodStart, monthStartUtc(now).toISOString().slice(0, 10)),
      ),
    );
  const used =
    period !== undefined
      ? period.spent + period.reserved
      : Number(
          (
            await db
              .select({ total: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
              .from(usageRecords)
              .where(
                and(
                  eq(usageRecords.orgId, agent.orgId),
                  eq(usageRecords.agentId, agent.id),
                  eq(usageRecords.kind, "agent"),
                  gte(usageRecords.createdAt, monthStartUtc(now)),
                ),
              )
          )[0]?.total ?? 0,
        );
  const needed = each * (attempts + 1);
  const left = Math.max(0, budget - used);
  if (needed > left) {
    const usd = (n: number) => Math.round(n / 1e7) / 100;
    throw new ValidationError(
      `${agent.name}'s budget has $${usd(left)} left this month. ${attempts} attempts and the comparison need about $${usd(needed)}`,
      BURST_ERRORS.overBudget,
      { agentName: agent.name, attempts, neededUsd: usd(needed), leftUsd: usd(left) },
    );
  }
}

/**
 * The agent a `/burst` is for: the agent of a DM with one, else the one agent the message names among this
 * conversation's members. It must be one the person can talk to and that answers through the API: a computer brain's
 * attempts would share one folder on one computer (ADR 0192, Later).
 */
async function burstAgent(
  db: Database,
  input: { orgId: string; userId: string; channel: { id: string; kind: string }; membership: Membership; body: string },
) {
  // Who a mention here reaches: the conversation's agents, and the workspace's right hand in any channel (ADR 0137).
  const here = sql`${input.channel.id}::uuid`;
  const reachable = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.orgId, input.orgId),
        sql`${agents.archivedAt} is null`,
        sql`${agents.deletedAt} is null`,
        sql`(exists (select 1 from ${channelMembers} cm where cm.agent_id = ${agents.id} and cm.channel_id = ${here})
          or ${rightHandReaches(sql`${agents}`, here)})`,
      ),
    );
  const handles = await currentHandles(db, input.orgId, parseMentionHandles(input.body));
  const named = reachable.filter((a) => handles.includes(a.handle));
  const candidates = named.length > 0 ? named : input.channel.kind === "dm" ? reachable : [];
  const agent = candidates.length === 1 ? candidates[0] : undefined;
  if (!agent)
    throw new ValidationError("Name the one agent that should try it (@handle)", BURST_ERRORS.needsAgent, {
      named: candidates.length,
    });
  if (!can(input.membership, "talk_to_agents") || !canTalkTo(agent, input.userId, speakerOf(input.membership)))
    throw new ForbiddenError(`You can't talk to ${agent.name}`, BURST_ERRORS.unreachable, { agentName: agent.name });
  if (isComputerBrain(agent.brain))
    throw new ValidationError(
      `${agent.name} works on a computer: /burst runs only agents that answer through the API`,
      BURST_ERRORS.computerBrain,
      { agentName: agent.name },
    );
  return agent;
}

/** Opens one attempt's room: private, only the agent in it. */
async function openBurstRoom(tx: Executor, orgId: string, agentId: string, burstId: string, attempt: number) {
  const dmKey = burstRoomKey(agentId, burstId, attempt);
  const [room] = await tx
    .insert(channels)
    .values({
      orgId,
      name: `burst-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
      visibility: "private",
      kind: "dm",
      dmKey,
    })
    .returning();
  if (!room) throw new Error("could not open the attempt's room");
  await tx.insert(channelMembers).values({ orgId, channelId: room.id, agentId });
  return room;
}

/**
 * Posts a `/burst` message (from `postPersonMessage`, past its access checks): the message as the person wrote it,
 * with no run of its own, and in the same transaction one room, brief and run per attempt, and the deadline's job. The
 * brief is the person's (`authority.ts`: a person is behind every attempt, as behind the message). Refused before
 * anything is written when it can't run.
 */
export async function postBurst(
  deps: { db: Database; pubsub: PubSub },
  input: {
    userId: string;
    orgId: string;
    channel: { id: string; kind: string };
    membership: Membership;
    body: string;
    threadId?: string | null;
    clientId: string | null;
    command: BurstCommand;
    /** A quote, files, a GIF or "reply in the panel" came with it: the attempts couldn't read them, so it's refused. */
    withExtras?: boolean;
  },
): Promise<{ message: Message; duplicate: boolean }> {
  const { db } = deps;
  const { userId, orgId, command } = input;
  if (input.withExtras)
    throw new ValidationError("/burst takes only words: no files, quote or GIF", BURST_ERRORS.plainOnly);
  // A mission's thread has its own rules on who makes its agent act (ADR 0029): a burst stays out of it.
  if (input.threadId) {
    const [mission] = await db
      .select({ id: schema.missions.id })
      .from(schema.missions)
      .where(and(eq(schema.missions.orgId, orgId), eq(schema.missions.threadRootId, input.threadId)));
    if (mission) throw new ValidationError("/burst can't run in a mission's thread", BURST_ERRORS.missionThread);
  }
  const agent = await burstAgent(db, input);
  await requireBurstBudget(db, agent, command.attempts);
  const posted = await db.transaction(async (tx) => {
    const { message, duplicate } = await insertMessageWithRuns(
      tx,
      {
        orgId,
        channelId: input.channel.id,
        threadId: input.threadId,
        author: { type: "person", userId },
        body: input.body,
        clientId: input.clientId,
        meta: {
          burst: { agentId: agent.id, attempts: command.attempts } satisfies BurstMeta,
          ...(input.clientId ? { clientId: input.clientId } : {}),
        },
      },
      { startRuns: false },
    );
    if (duplicate) return { message, duplicate };
    for (let attempt = 1; attempt <= command.attempts; attempt++) {
      const room = await openBurstRoom(tx, orgId, agent.id, message.id, attempt);
      const { message: brief } = await insertMessageWithRuns(
        tx,
        {
          orgId,
          channelId: room.id,
          threadId: null,
          author: { type: "person", userId },
          body: command.request,
          meta: { burstAttempt: { id: message.id, attempt, of: command.attempts } },
        },
        { startRuns: false, deliver: false },
      );
      const [run] = await createAgentRuns(tx, brief, [agent.id], "mention");
      if (!run) throw new Error("an attempt's run did not start");
    }
    await enqueue(tx, {
      orgId,
      kind: BURST_JUDGE_JOB,
      payload: { messageId: message.id, deadline: true },
      dedupeKey: `${BURST_JUDGE_JOB}:deadline:${message.id}`,
      runAt: new Date(Date.now() + BURST_DEADLINE_MS),
    });
    return { message, duplicate };
  });
  caches.scopes.deletePrefix(`${orgId}:${agent.id}:visible`);
  if (!posted.duplicate) await publishMessageCreated(deps.pubsub, messageView(posted.message));
  return posted;
}

/** An attempt ended (any way the executor ends it): the burst checks whether every attempt has. */
export async function burstAttemptEnded(db: Executor, run: Pick<AgentRun, "id" | "orgId">, dmKey: string | null) {
  const burstId = burstOfRoom(dmKey);
  if (!burstId) return;
  await enqueue(db, {
    orgId: run.orgId,
    kind: BURST_JUDGE_JOB,
    payload: { messageId: burstId },
    dedupeKey: `${BURST_JUDGE_JOB}:${burstId}:${run.id}`,
  });
}

/** The comparing turn's notice: the drafts, one per attempt, in their order. */
function draftsText(attempts: { run: AgentRun; reply: string | null }[]) {
  return attempts
    .map(({ run, reply }, i) =>
      reply?.trim()
        ? `## Attempt ${i + 1}\n${reply.length > BURST_DRAFT_MAX_CHARS ? `${reply.slice(0, BURST_DRAFT_MAX_CHARS)}\n[… cut]` : reply}`
        : `## Attempt ${i + 1}\n(It did not finish: ${run.status === "canceled" ? "stopped" : run.status === "done" ? "it wrote nothing" : run.status}.)`,
    )
    .join("\n\n");
}

/**
 * Compares a burst's attempts, once (`BURST_JUDGE_JOB`): when every attempt has ended, or at its deadline (the ones
 * still working stop, what finished is compared). The drafts reach the agent as a notice only it reads, in the
 * conversation and thread the person asked in, and wake its run there; that run answers the person. The rooms close.
 * Holds the person's message while it decides, so two checks at once deliver one notice.
 */
export async function judgeBurst(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  messageId: string,
  options: { deadline?: boolean } = {},
) {
  const { db } = deps;
  const [asked] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  const burst = burstMetaOf(asked?.meta);
  if (!asked || !burst) return;
  const rooms = await db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), like(channels.dmKey, `${burstRoomPrefix(burst.agentId, messageId)}%`)));
  if (rooms.length === 0) return;
  const runsOf = () =>
    db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          inArray(
            agentRuns.channelId,
            rooms.map((r) => r.id),
          ),
        ),
      );
  const attemptOf = new Map(rooms.map((r) => [r.id, Number(r.dmKey?.split("|n:")[1] ?? 0)]));
  const inOrder = (rows: AgentRun[]) =>
    rows.sort((a, b) => (attemptOf.get(a.channelId) ?? 0) - (attemptOf.get(b.channelId) ?? 0));
  let runs = inOrder(await runsOf());
  if (runs.some((r) => !isTerminal(r.status))) {
    if (!options.deadline) return;
    for (const run of runs.filter((r) => !isTerminal(r.status)))
      await stopRun(deps, orgId, run, "dm", { type: "system", reason: BURST_DEADLINE }).catch(() => null);
    runs = inOrder(await runsOf());
  }
  const replyIds = runs.flatMap((r) => (r.status === "done" && r.replyMessageId ? [r.replyMessageId] : []));
  const replies = replyIds.length
    ? await db
        .select({ id: messages.id, body: messages.body })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, replyIds)))
    : [];
  const bodyOf = new Map(replies.map((r) => [r.id, r.body]));
  const attempts = runs.map((run) => ({
    run,
    reply: run.replyMessageId ? (bodyOf.get(run.replyMessageId) ?? null) : null,
  }));
  const finished = attempts.filter((a) => a.reply?.trim()).length;
  const delivered = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${messages} where ${messages.id} = ${messageId}::uuid for update`);
    const [already] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.channelId, asked.channelId),
          sql`${messages.meta}->'notice'->>'kind' = 'burst_results'`,
          sql`${messages.meta}->'notice'->'refs'->>'burstId' = ${messageId}`,
        ),
      );
    if (already) return null;
    await tx
      .update(channels)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(channels.orgId, orgId),
          inArray(
            channels.id,
            rooms.map((r) => r.id),
          ),
        ),
      );
    const first = runs[0];
    return deliverNotice(tx, {
      orgId,
      agentId: burst.agentId,
      channelId: asked.channelId,
      threadId: asked.threadId,
      // A person is behind it (the attempts' briefs are theirs): the run it wakes answers at hop 1, a stretch of its own.
      hop: 0,
      stretchId: null,
      notice: {
        kind: "burst_results",
        text: draftsText(attempts),
        refs: {
          burstId: messageId,
          attempts: String(burst.attempts),
          finished: String(finished),
          ...(first ? { runId: first.id } : {}),
        },
      },
    });
  });
  if (delivered) {
    caches.scopes.deletePrefix(`${orgId}:${burst.agentId}:visible`);
    await publishDelivery(deps.pubsub, delivered);
  }
}
