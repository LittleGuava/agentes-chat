import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { cancelRun } from "./cancel";
import { postRefusal, requireChannelAccess } from "./channels";
import { deliverNotice, publishDelivery } from "./delivery";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { cutText } from "./format";
import { mediaOf } from "./media";
import { getMessage, MAX_MESSAGE_LENGTH, type Message, type MessageView, messageView } from "./messages";
import { can } from "./organizations";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { type AgentRun, replyThreadOf } from "./runs";
import { enqueueIndex } from "./search";
import { closedRefusal } from "./standing";
import { syncWikiLinks, withWikiLinks } from "./wiki-links";

const { agentRuns, messages, users } = schema;

/** How long after sending its author may still edit a message (ADR 0207). */
export const MESSAGE_EDIT_WINDOW_MS = 24 * 3600_000;

/** How much of each version the agent's notice of an edit carries: the message itself has the whole new text. */
const NOTICE_VERSION_CHARS = 4000;

export interface EditMessageResult {
  message: MessageView;
  /** With `redo`: the runs that answer the new text (new, or the agent's task already at work it joined). */
  runs: { agentId: string; runId: string }[];
}

/**
 * A person edits the text of a message they sent (`PATCH …/messages/{messageId}`, ADR 0207), within a day. Its
 * mentions stay as they were: an edit wakes and notifies nobody. A message an agent already took (a run started on it,
 * or it reached an agent's task at work) isn't changed under its answer: that takes `redo`, "Editar e refazer a
 * resposta", on the last message a person sent in that conversation. Then each agent that took it hears of the edit
 * through a `message_edited` notice (what it said, what it says now) that starts its new answer, after its run still
 * on the old text stops; the answers already given stay. Audited without the text.
 */
export async function editMessage(
  deps: { db: Database; pubsub: PubSub },
  userId: string,
  orgId: string,
  messageId: string,
  input: { body: string; redo?: boolean },
): Promise<EditMessageResult> {
  const { db } = deps;
  const found = await getMessage(db, orgId, messageId);
  if (!found || found.deletedAt) throw new NotFoundError("Message not found");
  const { membership, workspace } = await requireChannelAccess(db, userId, orgId, found.channelId);
  const closed = closedRefusal(membership.standing);
  if (closed) throw closed;
  if (!can(membership, "post")) throw postRefusal(workspace);
  if (found.authorType !== "person" || found.authorUserId !== userId)
    throw new ForbiddenError("Only its author can edit a message", "message.edit_not_yours");
  if (!editable(found.meta)) throw new ConflictError("This message can't be edited", "message.not_editable");
  if (Date.now() - found.createdAt.getTime() > MESSAGE_EDIT_WINDOW_MS)
    throw new ConflictError("This message is too old to edit", "message.edit_expired");
  const body = input.body.trim();
  const files = Array.isArray(found.meta.artifacts) && found.meta.artifacts.length > 0;
  if (body === "" && !files && !mediaOf(found.meta)) throw new ValidationError("Message is empty");
  if (body.length > MAX_MESSAGE_LENGTH)
    throw new ValidationError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters`, "message.too_long", {
      length: body.length,
      max: MAX_MESSAGE_LENGTH,
    });
  if (body === found.body) return { message: await viewOf(db, orgId, found), runs: [] };

  const taken = await runsThatTook(db, found);
  if (taken.length > 0 && !input.redo)
    throw new ConflictError(
      "An agent already answered this message: edit it and redo the answer",
      "message.edit_answered",
    );
  if (input.redo && (await saidSince(db, found)))
    throw new ConflictError(
      "Only the last message in the conversation can be edited and answered again",
      "message.redo_not_latest",
    );

  const agentIds = [...new Set(taken.map((r) => r.agentId))];
  const edited = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ body, editedAt: new Date() })
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.id, found.id),
          eq(messages.createdAt, found.createdAt),
          isNull(messages.deletedAt),
          // Taken by an agent since it was read above: a plain edit would change it under its answer.
          input.redo
            ? undefined
            : sql`not exists (select 1 from ${agentRuns} r where r.org_id = ${orgId}::uuid and r.trigger_message_id = ${found.id}::uuid)
              and not (${messages.meta} ? 'steeredRunIds')`,
        ),
      )
      .returning();
    if (!row) return null;
    await syncWikiLinks(tx, orgId, { type: "message", id: row.id, channelId: row.channelId }, body);
    await enqueueIndex(tx, { orgId, kind: "message", sourceId: row.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "message.edited",
      target: { type: "message", id: row.id },
      channelId: row.channelId,
      // Lengths, never the words: an admin reads the log, not every conversation.
      details: {
        before: found.body.length,
        after: body.length,
        redo: input.redo === true,
        ...(input.redo ? { agentIds } : {}),
      },
    });
    return row;
  });
  if (!edited)
    throw new ConflictError(
      "An agent already answered this message: edit it and redo the answer",
      "message.edit_answered",
    );
  await publishChannelEvent(deps.pubsub, {
    type: "message.edited",
    channelId: edited.channelId,
    messageId: edited.id,
    threadId: edited.threadId,
    body: edited.body,
    editedAt: (edited.editedAt ?? new Date()).toISOString(),
  });
  const runs = input.redo ? await answerAgain(deps, userId, found, edited, taken) : [];
  return { message: await viewOf(db, orgId, edited), runs };
}

/** A voice message's words are its recording's, an answer to an agent's question was already taken, a notice isn't a person's. */
function editable(meta: Record<string, unknown>) {
  return meta.voice === undefined && meta.answersQuestionId === undefined && meta.notice === undefined;
}

async function viewOf(db: Database, orgId: string, m: Message) {
  const [view] = (await withWikiLinks(db, orgId, [messageView(m)])) as [MessageView];
  return view;
}

/** The runs that took the message: started on it, or the agent's task at work it was sent into (`meta.steeredRunIds`). */
async function runsThatTook(db: Database, m: Message): Promise<AgentRun[]> {
  const steered = Array.isArray(m.meta.steeredRunIds)
    ? m.meta.steeredRunIds.filter((id): id is string => typeof id === "string")
    : [];
  const own = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, m.orgId), eq(agentRuns.triggerMessageId, m.id), eq(agentRuns.background, false)));
  const into =
    steered.length > 0
      ? await db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, m.orgId), inArray(agentRuns.id, steered)))
      : [];
  return [...own, ...into.filter((r) => !own.some((o) => o.id === r.id))];
}

/** Whether a person wrote in the same conversation (the thread, or the timeline) after this message. */
async function saidSince(db: Database, m: Message) {
  const [later] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, m.orgId),
        eq(messages.channelId, m.channelId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
        gt(messages.createdAt, m.createdAt),
        m.threadId ? eq(messages.threadId, m.threadId) : isNull(messages.threadId),
      ),
    )
    .limit(1);
  return later !== undefined;
}

/**
 * Each agent that took the message answers it again: its run still on the old text stops (only one started on this
 * message; a task it was sent into goes on and reads the notice at its next step), then a `message_edited` notice
 * where it answered starts its new run, in a fresh stretch since a person asked (ADR 0089). The notice's `runId` ties
 * the new run to the person, as the old one was (`authority.ts`).
 */
async function answerAgain(
  deps: { db: Database; pubsub: PubSub },
  userId: string,
  before: Message,
  after: Message,
  taken: AgentRun[],
) {
  const { db } = deps;
  for (const run of taken)
    if (run.triggerMessageId === before.id && (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status))
      await cancelRun(deps, userId, before.orgId, run.id, { tell: false }).catch((error: unknown) => {
        // It ended meanwhile: nothing left to stop.
        if (!(error instanceof ConflictError)) throw error;
      });
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const name = person?.name ?? "A person";
  const text = `It said:\n${cutText(before.body, NOTICE_VERSION_CHARS)}\n\nIt now says:\n${cutText(after.body, NOTICE_VERSION_CHARS)}`;
  const answering: { agentId: string; runId: string }[] = [];
  const seen = new Set<string>();
  for (const run of taken) {
    if (seen.has(run.agentId)) continue;
    seen.add(run.agentId);
    const delivered = await db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: before.orgId,
        agentId: run.agentId,
        channelId: run.channelId,
        threadId: replyThreadOf(run),
        hop: before.hop,
        stretchId: null,
        notice: {
          kind: "message_edited",
          text,
          from: name,
          refs: { runId: run.id, messageId: before.id, personId: userId, personName: name },
        },
        start: { granted: Bun.randomUUIDv7() },
      }),
    );
    await publishDelivery(deps.pubsub, delivered);
    const [created] = delivered.runs;
    const runId = created?.id ?? (await joinedBy(db, before.orgId, delivered.message.id));
    if (runId) answering.push({ agentId: run.agentId, runId });
  }
  return answering;
}

/** The agent's task at work a notice joined (it reads it at its next step). */
async function joinedBy(db: Database, orgId: string, noticeId: string) {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), sql`${noticeId}::uuid = any(${agentRuns.pendingMessageIds})`))
    .limit(1);
  return run?.id ?? null;
}
