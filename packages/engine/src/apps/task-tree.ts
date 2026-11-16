import { and, type Executor, gte, inArray, notInArray, or, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { consultationWait, type HeldHandOff, handOffsHeld } from "../consultations";
import { ValidationError } from "../errors";
import { outageParkedOf } from "../runs";

const { agentConsultations, agentRuns, messages, outbox } = schema;

/**
 * A task's whole job, for an app waiting on it (ADR 0119 addendum 2026-11-15): the runs the task started, every
 * question and note they sent to other agents (and theirs in turn), the runs a result coming back started, and the
 * runs an agent's message woke. Read from explicit links, never from the stretch, which a person's decision renews
 * mid-job.
 */

type RunRow = typeof agentRuns.$inferSelect;

/** How a node joined the job. */
export type TreeVia = "task" | "question" | "note" | "heads_up" | "result" | "mention";

export type TreeState =
  | "queued"
  | "working"
  | "waiting_computer"
  | "waiting_provider"
  | "waiting_agents"
  | "waiting_approval"
  | "waiting_input"
  | "not_started"
  | "done"
  | "failed"
  | "canceled"
  | "expired";

export interface TreeNode {
  /** The question's or note's id for a hand-off (stable before its run starts), else the run's. */
  id: string;
  parentId: string | null;
  via: TreeVia;
  agentId: string;
  run: RunRow | null;
  state: TreeState;
  /** Whether the job waits for it: everything but a heads-up. */
  holds: boolean;
  /** Closed, but its result hasn't reached the run that sent it yet. */
  reportPending: boolean;
}

export interface TaskTree {
  nodes: TreeNode[];
  truncated: boolean;
  /** Every conversation a run of the job works in, to listen to. */
  channelIds: string[];
  /** The task's message, or one a run of the job wrote, is still being routed (`message.posted`): it may wake an agent. */
  routing: boolean;
}

/** More than any stretch lets agents start on their own (ADR 0089). */
export const TREE_MAX_NODES = 100;

const STILL_ON: ReadonlySet<TreeState> = new Set([
  "queued",
  "working",
  "waiting_computer",
  "waiting_provider",
  "waiting_agents",
  "not_started",
]);

/** Where a run stands. An unknown status is `failed`. */
function runState(run: RunRow): TreeState {
  switch (run.status) {
    case "queued":
      return "queued";
    case "running":
      return run.waitingMachineId ? "waiting_computer" : "working";
    case "waiting_approval":
      return "waiting_approval";
    case "waiting_input": {
      const wait = consultationWait({ ...run, outage: outageParkedOf(run) });
      return wait === "computer" ? "waiting_computer" : wait === "outage" ? "waiting_provider" : "waiting_input";
    }
    case "done":
    case "canceled":
      return run.status;
    default:
      return "failed";
  }
}

/** A question or note: its run's state while it is open, then how it closed. */
function handOffState(h: HeldHandOff, run: RunRow | null): TreeState {
  if (h.status === "answered") return "done";
  if (h.status === "expired" || h.status === "failed") return h.status;
  if (!run) return "not_started";
  const state = runState(run);
  // Its run ended, however, and the row isn't closed yet: it waits on what it handed on, or closes in a moment
  // (`settleOwed`, `onConsultedRunStopped`). Still open, so still on.
  return state === "done" || state === "failed" || state === "canceled" ? "waiting_agents" : state;
}

/**
 * Runs started by a message one of `byRunIds` wrote (an agent it woke), or started or joined by a notice for one of
 * them (what came back from a colleague), since `since`. Only a notice counts when it joined a run: an agent's message
 * that joins another agent's run there is that run's business, not this job's.
 */
async function runsWokenBy(db: Executor, orgId: string, byRunIds: string[], since: Date, seen: string[]) {
  const forRun = sql<string | null>`${messages.meta} -> 'notice' -> 'refs' ->> 'runId'`;
  const forTree = sql`${forRun} in (${sql.join(
    byRunIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const notHandOff = sql`not exists (select 1 from ${agentConsultations} hc
    where hc.org_id = ${messages.orgId} and hc.message_id = ${messages.id})`;
  const rows = await db
    .select({ run: agentRuns, byRunId: messages.agentRunId, forRunId: forRun })
    .from(agentRuns)
    .innerJoin(
      messages,
      and(
        sql`${messages.orgId} = ${agentRuns.orgId}`,
        or(
          and(
            sql`${messages.id} = ${agentRuns.triggerMessageId}`,
            or(
              // A question or note is the hand-off's own message: its run is followed (or not, a heads-up) there.
              and(inArray(messages.agentRunId, byRunIds), notHandOff),
              forTree,
            ),
          ),
          and(sql`${messages.id} = any(${agentRuns.pendingMessageIds})`, forTree),
        ),
      ),
    )
    .where(
      and(
        sql`${agentRuns.orgId} = ${orgId}::uuid`,
        gte(agentRuns.createdAt, since),
        gte(messages.createdAt, since),
        notInArray(agentRuns.id, seen),
      ),
    )
    .orderBy(agentRuns.createdAt, agentRuns.id);
  return rows.map((r) => ({
    run: r.run,
    by: (r.forRunId && byRunIds.includes(r.forRunId) ? r.forRunId : r.byRunId) as string,
    via: (r.forRunId && byRunIds.includes(r.forRunId) ? "result" : "mention") as TreeVia,
  }));
}

/** Whether `message.posted` still has to route the task's message or one the runs `runIds` wrote since `since`. */
async function stillRouting(db: Executor, orgId: string, taskId: string, runIds: string[], since: Date) {
  const [row] = await db
    .select({ id: outbox.id })
    .from(outbox)
    .innerJoin(
      messages,
      sql`${messages.orgId} = ${outbox.orgId} and ${messages.id}::text = ${outbox.payload} ->> 'messageId'`,
    )
    .where(
      and(
        sql`${outbox.orgId} = ${orgId}::uuid`,
        sql`${outbox.kind} = 'message.posted'`,
        inArray(outbox.status, ["pending", "processing"]),
        gte(messages.createdAt, since),
        runIds.length > 0
          ? or(sql`${messages.id} = ${taskId}::uuid`, inArray(messages.agentRunId, runIds))
          : sql`${messages.id} = ${taskId}::uuid`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The job of the task `message`, from its `roots` (the runs it started or joined), breadth first, at most
 * `TREE_MAX_NODES` nodes. A heads-up's colleague is listed, its own work isn't followed.
 */
export async function readTaskTree(
  db: Executor,
  message: { id: string; orgId: string; channelId: string; createdAt: Date },
  roots: RunRow[],
): Promise<TaskTree> {
  const nodes: TreeNode[] = [];
  const seen = new Set<string>();
  const channelIds = new Set([message.channelId]);
  let truncated = false;
  const add = (node: TreeNode) => {
    if (nodes.length >= TREE_MAX_NODES) {
      truncated = true;
      return false;
    }
    nodes.push(node);
    if (node.run) channelIds.add(node.run.channelId);
    return true;
  };
  /** Each run to follow, by the node it is under. */
  let frontier = new Map<string, string>();
  for (const run of roots) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const node = { id: run.id, parentId: null, via: "task" as const, agentId: run.agentId, run, holds: true };
    if (add({ ...node, state: runState(run), reportPending: false })) frontier.set(run.id, run.id);
  }
  while (frontier.size > 0 && !truncated) {
    const ids = [...frontier.keys()];
    const next = new Map<string, string>();
    const handOffs = await handOffsHeld(db, message.orgId, ids);
    const targetIds = [...new Set(handOffs.flatMap((h) => (h.targetRunId ? [h.targetRunId] : [])))];
    const targets = new Map(
      (targetIds.length > 0 ? await db.select().from(agentRuns).where(inArray(agentRuns.id, targetIds)) : []).map(
        (r) => [r.id, r],
      ),
    );
    for (const h of handOffs) {
      const run = (h.targetRunId && targets.get(h.targetRunId)) || null;
      const added = add({
        id: h.id,
        parentId: frontier.get(h.askerRunId) ?? null,
        via: h.headsUp ? "heads_up" : h.kind,
        agentId: h.targetAgentId,
        run,
        state: handOffState(h, run),
        holds: !h.headsUp,
        reportPending: h.reportPending,
      });
      if (added && run && !h.headsUp && !seen.has(run.id)) {
        seen.add(run.id);
        next.set(run.id, h.id);
      }
    }
    for (const woken of await runsWokenBy(db, message.orgId, ids, message.createdAt, [...seen])) {
      if (seen.has(woken.run.id)) continue;
      seen.add(woken.run.id);
      const node = { id: woken.run.id, parentId: frontier.get(woken.by) ?? null, via: woken.via };
      if (
        add({
          ...node,
          agentId: woken.run.agentId,
          run: woken.run,
          state: runState(woken.run),
          holds: true,
          reportPending: false,
        })
      )
        next.set(woken.run.id, woken.run.id);
    }
    frontier = next;
  }
  const routing = await stillRouting(db, message.orgId, message.id, [...seen], message.createdAt);
  return { nodes, truncated, channelIds: [...channelIds], routing };
}

export type TreeVerdict =
  | { kind: "working" }
  | { kind: "person"; status: "waiting_approval" | "waiting_input"; node: TreeNode & { run: RunRow } }
  /** Nothing holds it: `last` is the newest run in the task's conversation, `runs` all of them, newest first. */
  | { kind: "settled"; last: RunRow; runs: RunRow[] };

/**
 * Where the job stands: a run anywhere in it waiting on a person ends the wait (an approval first); anything still
 * on, or a result still on its way back, keeps it working; otherwise it is settled.
 */
export function treeVerdict(tree: TaskTree, channelId: string): TreeVerdict {
  const held = tree.nodes.filter((n) => n.holds);
  for (const status of ["waiting_approval", "waiting_input"] as const) {
    const node = held.find((n) => n.state === status && n.run);
    if (node) return { kind: "person", status, node: node as TreeNode & { run: RunRow } };
  }
  if (tree.routing || held.some((n) => STILL_ON.has(n.state) || n.reportPending)) return { kind: "working" };
  const runs = tree.nodes
    .flatMap((n) => (n.run && n.run.channelId === channelId && n.via !== "question" && n.via !== "note" ? [n.run] : []))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  const [last] = runs;
  return last ? { kind: "settled", last, runs } : { kind: "working" };
}

// ── The cursor ───────────────────────────────────────────────────────────────

const CODES: Record<TreeState, string> = {
  queued: "q",
  working: "r",
  waiting_computer: "c",
  waiting_provider: "o",
  waiting_agents: "g",
  waiting_approval: "a",
  waiting_input: "i",
  not_started: "n",
  done: "d",
  failed: "f",
  canceled: "x",
  expired: "e",
};
const STATES = new Map(Object.entries(CODES).map(([state, code]) => [code, state as TreeState]));

/** A node's key in a cursor: the random end of its UUIDv7 (its start is a timestamp, shared within a millisecond). */
const keyOf = (id: string) => id.replace(/-/g, "").slice(-12);
const taskKey = (taskId: string) => keyOf(taskId).slice(-8);

const cursorShape = z
  .object({ t: z.string().length(8), n: z.record(z.string().regex(/^[0-9a-f]{12}$/), z.string().length(1)) })
  .strict();

/** What the app passes back to keep watching: each node's state as this result saw it, tied to the task. */
export function treeCursor(taskId: string, nodes: Pick<TreeNode, "id" | "state">[]): string {
  const n = Object.fromEntries(nodes.map((node) => [keyOf(node.id), CODES[node.state]]));
  return Buffer.from(JSON.stringify({ t: taskKey(taskId), n })).toString("base64url");
}

/** The states a cursor saw, by node key. A cursor of another task, or garbage, is refused. */
export function readTreeCursor(cursor: string, taskId: string): Map<string, TreeState> {
  let parsed: z.infer<typeof cursorShape> | null = null;
  try {
    const out = cursorShape.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (out.success) parsed = out.data;
  } catch {
    // Not JSON: refused below.
  }
  if (!parsed || parsed.t !== taskKey(taskId))
    throw new ValidationError("This cursor belongs to another task or is damaged. Wait again without cursor.");
  const seen = new Map<string, TreeState>();
  for (const [key, code] of Object.entries(parsed.n)) {
    const state = STATES.get(code);
    if (state) seen.set(key, state);
  }
  return seen;
}

/** The nodes that are new or changed since a cursor, in the tree's order. */
export function treeChanges(before: Map<string, TreeState>, nodes: Pick<TreeNode, "id" | "state">[]) {
  return nodes.flatMap((node) => {
    const previous = before.get(keyOf(node.id)) ?? null;
    return previous === node.state ? [] : [{ id: node.id, state: node.state, previous }];
  });
}
