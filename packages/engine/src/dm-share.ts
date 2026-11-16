import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { postRefusal, requireChannelAccess } from "./channels";
import { openDm } from "./dms";
import { NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated, publishUserEvent } from "./events";
import { insertMessageWithRuns, type MessageView, messageView } from "./messages";
import { can } from "./organizations";
import { closedRefusal } from "./standing";
import { withWikiLinks } from "./wiki-links";

const { channels, channelMembers, messages, agents, users } = schema;

/**
 * A DM with an agent shared as a read-only copy (ADR 0151, addendum 2026-11-15): the talk as it stood, kept in the
 * message that carries it (`meta.sharedDm`). It names no conversation, so nothing in it opens the DM.
 */
export interface SharedDm {
  agent: { id: string; name: string; handle: string };
  /** Lines in the copy, and the earlier ones left out past the limits. */
  count: number;
  omitted: number;
  lines: SharedDmLine[];
}

export interface SharedDmLine {
  author: { type: "person" | "agent"; id: string; name: string };
  at: string;
  body: string;
  /** A reply in one of the DM's threads. */
  inThread?: true;
  /** The line was longer than `DM_SHARE_LIMITS.lineChars`. */
  cut?: true;
}

export type ShareDmTarget = { channelId: string } | { userId: string };

/** The copy rides in a message: these keep it the size of one (`MAX_MESSAGE_LENGTH`). */
export const DM_SHARE_LIMITS = { lines: 300, lineChars: 4_000, totalChars: 100_000, noteChars: 2_000 };

/**
 * What isn't talk, by the meta key that marks it: words the server writes (cards, notices the agent reads, memory
 * lines, a run cut short), approvals, questions and secret requests waiting on a click, a person's help asked in the
 * browser, missions' cards, long work's progress lines, a computer's state, GIFs, stickers and voice. A notice stays
 * out except the agent's own words that people read (a routine's report, a fast reply); `readableBody` shows those two
 * the same way.
 */
const NOT_TALK = [
  "bodyCode",
  "actionCard",
  "approvalId",
  "questionId",
  "secretRequestId",
  "browserHandoff",
  "noAi",
  "autonomyNote",
  "movedOn",
  "interrupted",
  "brainInterrupted",
  "workUpdate",
  "machineOffline",
  "machineTaskResumed",
  "deviceWait",
  "missionStart",
  "missionLink",
  "missionPlan",
  "missionReview",
  "missionSetup",
  "missionReport",
  "consultation",
  "taskConversation",
  "media",
  "voice",
  "issueWork",
  "issueWorkStart",
  "issueTaken",
  "sharedDm",
] as const;
const TALK_NOTICES = ["routine_handoff", "talker_reply"] as const;

const talkSql = (meta: SQL): SQL =>
  sql`not (${meta} ?| array[${sql.join(
    NOT_TALK.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]) and (not (${meta} ? 'notice') or ${meta}->'notice'->>'kind' in (${sql.join(
    TALK_NOTICES.map((k) => sql`${k}`),
    sql`, `,
  )}))`;

/** A message's shared copy, if it carries one. */
export function sharedDmOf(meta: Record<string, unknown> | null | undefined): SharedDm | null {
  const s = meta?.sharedDm as Partial<SharedDm> | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.lines) || !s.agent || typeof s.agent.name !== "string")
    return null;
  return {
    agent: s.agent,
    count: typeof s.count === "number" ? s.count : s.lines.length,
    omitted: typeof s.omitted === "number" ? s.omitted : 0,
    lines: s.lines,
  };
}

async function isMember(db: Database, orgId: string, channelId: string, userId: string) {
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    );
  return Boolean(row);
}

/** The agent of `userId`'s DM `dmId`. Not theirs, or not a DM: not found. A DM with a person is refused. */
async function agentOfDm(db: Database, userId: string, orgId: string, dmId: string) {
  const [dm] = await db
    .select({ dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.id, dmId), eq(channels.orgId, orgId), eq(channels.kind, "dm")));
  const parts = (dm?.dmKey ?? "").split("|");
  if (!dm || !parts.includes(`u:${userId}`) || !(await isMember(db, orgId, dmId, userId)))
    throw new NotFoundError("Conversation not found");
  const agentId = parts.find((p) => p.startsWith("a:"))?.slice(2);
  // A DM between people holds the other one's words: theirs to share, not one side's.
  if (parts.length !== 2 || !agentId) {
    throw new ValidationError("Only a conversation with an agent can be shared", "dm_share.not_agent_dm");
  }
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Conversation not found");
  return agent;
}

/** Where the copy goes: a channel the person is a member of, or their DM with a person (opened if new). */
async function placeFor(db: Database, userId: string, orgId: string, dmId: string, to: ShareDmTarget) {
  const notHere = () =>
    new ValidationError("Share it in a channel or with a person", "dm_share.target", { kind: "channel" });
  if ("userId" in to) return (await openDm(db, userId, orgId, { userId: to.userId })).id;
  if (to.channelId === dmId) throw notHere();
  // Read as an administrator without joining (ADR 0151 §5) is not where they talk: join it first.
  if (!(await isMember(db, orgId, to.channelId, userId))) throw new NotFoundError("Channel not found");
  const { channel } = await requireChannelAccess(db, userId, orgId, to.channelId);
  if (channel.kind !== "channel") throw notHere();
  return channel.id;
}

/** The DM's talk, oldest first: the latest lines that fit `DM_SHARE_LIMITS`, and how many earlier ones didn't. */
async function linesOf(db: Database, orgId: string, dmId: string) {
  const where = and(
    eq(messages.orgId, orgId),
    eq(messages.channelId, dmId),
    isNull(messages.deletedAt),
    inArray(messages.authorType, ["person", "agent"]),
    sql`btrim(${messages.body}) <> ''`,
    talkSql(sql`${messages.meta}`),
  );
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(messages).where(where);
  const rows = await db
    .select({
      body: messages.body,
      createdAt: messages.createdAt,
      threadId: messages.threadId,
      authorType: messages.authorType,
      userId: messages.authorUserId,
      agentId: messages.authorAgentId,
      personName: users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(DM_SHARE_LIMITS.lines);
  const lines: SharedDmLine[] = [];
  let chars = 0;
  for (const r of rows) {
    const cut = r.body.length > DM_SHARE_LIMITS.lineChars;
    const body = cut ? r.body.slice(0, DM_SHARE_LIMITS.lineChars) : r.body;
    if (chars + body.length > DM_SHARE_LIMITS.totalChars) break;
    chars += body.length;
    const agent = r.authorType === "agent";
    lines.push({
      author: {
        type: agent ? "agent" : "person",
        id: (agent ? r.agentId : r.userId) ?? "",
        name: (agent ? r.agentName : r.personName) ?? "",
      },
      at: new Date(r.createdAt).toISOString(),
      body,
      ...(r.threadId ? { inThread: true as const } : {}),
      ...(cut ? { cut: true as const } : {}),
    });
  }
  return { lines: lines.reverse(), omitted: Math.max(0, total - lines.length) };
}

/**
 * Shares the person's DM with an agent as a read-only copy, posted by them with a note in a channel they belong to or
 * in their DM with a person (ADR 0151, addendum 2026-11-15). The DM stays as it is, closed to everyone else; the copy
 * is the talk as it stands now, and nothing deletes it, so the apps confirm first. It wakes no agent and isn't
 * searched: only the note is the message's text.
 */
export async function shareDm(
  deps: { db: Database; pubsub: PubSub },
  userId: string,
  orgId: string,
  dmId: string,
  input: { to: ShareDmTarget; note: string; clientId?: string | null },
): Promise<{ channelId: string; message: MessageView }> {
  const { db } = deps;
  const agent = await agentOfDm(db, userId, orgId, dmId);
  const note = input.note.trim();
  if (!note || note.length > DM_SHARE_LIMITS.noteChars) {
    throw new ValidationError("Write a note of up to 2000 characters", "dm_share.note", {
      max: DM_SHARE_LIMITS.noteChars,
    });
  }
  const { lines, omitted } = await linesOf(db, orgId, dmId);
  if (lines.length === 0) throw new ValidationError("This conversation has nothing to share yet", "dm_share.empty");
  const channelId = await placeFor(db, userId, orgId, dmId, input.to);
  const { membership, workspace } = await requireChannelAccess(db, userId, orgId, channelId);
  const closed = closedRefusal(membership.standing);
  if (closed) throw closed;
  if (!can(membership, "post")) throw postRefusal(workspace);
  const sharedDm: SharedDm = { agent, count: lines.length, omitted, lines };
  const { message, duplicate } = await db.transaction(async (tx) => {
    const written = await insertMessageWithRuns(
      tx,
      {
        orgId,
        channelId,
        author: { type: "person", userId },
        body: note,
        clientId: input.clientId,
        meta: { sharedDm, ...(input.clientId ? { clientId: input.clientId } : {}) },
      },
      // A copy to read: it starts no run and reaches none in progress (`message.posted` routes it to nobody).
      { startRuns: false, deliver: false },
    );
    if (!written.duplicate) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "dm.shared",
        target: { type: "message", id: written.message.id },
        channelId,
        details: { agentId: agent.id, toChannelId: channelId, lines: lines.length, omitted },
      });
    }
    return written;
  });
  const [view] = (await withWikiLinks(db, orgId, [messageView(message)])) as [MessageView];
  await publishMessageCreated(deps.pubsub, view);
  if (!duplicate) {
    for (const mentioned of message.mentionedUserIds) {
      await publishUserEvent(deps.pubsub, orgId, mentioned, {
        type: "mention",
        channelId,
        messageId: message.id,
        threadId: null,
        byUserId: userId,
      });
    }
  }
  return { channelId, message: view };
}
