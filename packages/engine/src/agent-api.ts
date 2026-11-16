import type { GifProvider, PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gt, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { TOKEN_EXPIRY_DAYS } from "./apps/grants";
import { revokeAgentApiKeys, revokeMemberApps } from "./apps/revoke";
import { type AppTaskStatus, appsLinkTo, waitForTask } from "./apps/tools";
import { randomBase62 } from "./apps/urls";
import { audienceError, canTalkTo, speakerOf } from "./audience";
import { recordAudit } from "./audit";
import { sha256 } from "./crypto";
import { agentKeyRoomKey, agentKeyRoomOf, openAgentKeyRoom } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import type { Judge } from "./judge";
import { getMessage, postPersonMessage } from "./messages";
import { can, getMembership, type Membership, requireActiveMembership } from "./organizations";
import { accountInUse, standingRefusal, workRefusal } from "./standing";
import type { Talker } from "./talker";

const { agentApiKeys, auditLog, channels, users } = schema;
type AgentApiKey = typeof agentApiKeys.$inferSelect;

/**
 * An agent's own REST API (ADR 0187): a key per agent, made by whoever manages the agent, that sends messages as
 * the person who made it into a room of the key's own and reads the agent's answers.
 */

export const AGENT_KEY_PREFIX = "agk_";
export const AGENT_API_LIMITS = { keysPerAgent: 10, nameChars: 60, messageChars: 20_000, waitSeconds: 45 } as const;
export const AGENT_KEY_EXPIRY_DAYS = TOKEN_EXPIRY_DAYS;

export interface AgentApiKeyView {
  id: string;
  name: string;
  lastFour: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdBy: { id: string; name: string };
  /** The key's conversation, for its maker once a message was sent with it; null otherwise (a DM only its maker reads). */
  roomId: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const live = () =>
  and(isNull(agentApiKeys.revokedAt), or(isNull(agentApiKeys.expiresAt), gt(agentApiKeys.expiresAt, new Date())));
const manages = (membership: Membership, agent: Pick<Agent, "ownerUserId">, userId: string) =>
  can(membership, "manage_agents") || agent.ownerUserId === userId;

/** The agent, when the person may manage its keys: its owner or anyone with `manage_agents`. */
async function managedAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!manages(membership, agent, actorId))
    throw new ForbiddenError("Only an admin or the agent's owner manages its API keys", "agent_api.not_manager");
  return { membership, agent };
}

/** The agent's live keys (neither revoked nor expired), newest first, never their secrets. */
export async function listAgentApiKeys(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<AgentApiKeyView[]> {
  await managedAgent(db, actorId, orgId, agentId);
  const rows = await db
    .select({ key: agentApiKeys, creatorName: users.name })
    .from(agentApiKeys)
    .innerJoin(users, eq(users.id, agentApiKeys.createdByUserId))
    .where(and(eq(agentApiKeys.orgId, orgId), eq(agentApiKeys.agentId, agentId), live()))
    .orderBy(desc(agentApiKeys.createdAt));
  const roomKeys = rows
    .filter((r) => r.key.createdByUserId === actorId)
    .map((r) => agentKeyRoomKey(agentId, r.key.id, actorId));
  const rooms = roomKeys.length
    ? await db
        .select({ id: channels.id, dmKey: channels.dmKey })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.dmKey, roomKeys)))
    : [];
  const roomOf = new Map(rooms.map((r) => [r.dmKey, r.id]));
  return rows.map((r) => ({
    ...viewOf(r.key, r.creatorName),
    roomId: roomOf.get(agentKeyRoomKey(agentId, r.key.id, r.key.createdByUserId)) ?? null,
  }));
}

/**
 * The agent and key an API key's room belongs to (ADR 0187), so the apps open it as that key's conversation: only for
 * the person who made the key, the room's only person; anyone else, an admin included, finds nothing (a DM, ADR 0151).
 */
export async function agentKeyRoom(db: Database, actorId: string, orgId: string, channelId: string) {
  await requireActiveMembership(db, actorId, orgId);
  const [room] = await db
    .select({ dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId), eq(channels.kind, "dm")));
  const of = agentKeyRoomOf(room?.dmKey);
  if (!of || of.userId !== actorId) throw new NotFoundError("Conversation not found");
  // A revoked key's room stays its maker's to read, by the name the key had; purged, it is the API's.
  const [key] = await db
    .select({ name: agentApiKeys.name })
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.orgId, orgId), eq(agentApiKeys.id, of.keyId)));
  return { agentId: of.agentId, keyId: of.keyId, keyName: key?.name ?? null };
}

const viewOf = (key: AgentApiKey, creatorName: string): Omit<AgentApiKeyView, "roomId"> => ({
  id: key.id,
  name: key.name,
  lastFour: key.lastFour,
  createdAt: key.createdAt.toISOString(),
  expiresAt: iso(key.expiresAt),
  lastUsedAt: iso(key.lastUsedAt),
  createdBy: { id: key.createdByUserId, name: creatorName },
});

/**
 * A new key for the agent (`agk_` and 43 base62 characters): the secret is returned here once and stored only as its
 * hash. Its maker must be able to talk to the agent, or the key would open nothing.
 */
export async function createAgentApiKey(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { name: string; expiresInDays: (typeof AGENT_KEY_EXPIRY_DAYS)[number] | null },
) {
  const { membership, agent } = await managedAgent(db, actorId, orgId, agentId);
  const refusal = workRefusal(membership.standing);
  if (refusal) throw refusal;
  if (agent.archivedAt) throw new ConflictError("This agent is archived", "agent_api.agent_archived");
  if (!canTalkTo(agent, actorId, speakerOf(membership))) throw await audienceError(db, agent);
  const name =
    input.name
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .slice(0, AGENT_API_LIMITS.nameChars) || "API";
  const [{ n = 0 } = {}] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.orgId, orgId), eq(agentApiKeys.agentId, agentId), live()));
  if (n >= AGENT_API_LIMITS.keysPerAgent)
    throw new ConflictError(
      `At most ${AGENT_API_LIMITS.keysPerAgent} API keys per agent. Revoke one first.`,
      "agent_api.key_limit",
      { limit: AGENT_API_LIMITS.keysPerAgent },
    );
  const secret = `${AGENT_KEY_PREFIX}${randomBase62(43)}`;
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const key = await db.transaction(async (tx) => {
    const [key] = await tx
      .insert(agentApiKeys)
      .values({
        orgId,
        agentId,
        createdByUserId: actorId,
        name,
        tokenHash: sha256(secret),
        lastFour: secret.slice(-4),
        expiresAt,
      })
      .returning();
    if (!key) throw new Error("key not stored");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent_api.key_created",
      target: { type: "agent_api_key", id: key.id },
      details: { app: name, agentId, keyId: key.id, expiresAt: iso(expiresAt) },
    });
    return key;
  });
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  return { key: { ...viewOf(key, me?.name ?? ""), roomId: null } satisfies AgentApiKeyView, secret };
}

/** Revokes a key now: its maker, or anyone who manages the agent. */
export async function revokeAgentApiKey(db: Database, actorId: string, orgId: string, agentId: string, keyId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [key] = await db
    .select()
    .from(agentApiKeys)
    .where(
      and(
        eq(agentApiKeys.id, keyId),
        eq(agentApiKeys.orgId, orgId),
        eq(agentApiKeys.agentId, agentId),
        isNull(agentApiKeys.revokedAt),
      ),
    );
  const agent = key ? await getAgent(db, orgId, agentId) : null;
  if (!key || !agent || (key.createdByUserId !== actorId && !manages(membership, agent, actorId)))
    throw new NotFoundError("Key not found");
  await db.transaction((tx) => revokeAgentApiKeys(tx, eq(agentApiKeys.id, key.id), { type: "person", id: actorId }));
}

// ── The bearer gate ──────────────────────────────────────────────────────────

/** Who a call acts as, once its key and everything behind it checked out (ADR 0187 §3). */
export interface AgentKeyCaller {
  keyId: string;
  keyName: string;
  orgId: string;
  /** The key's maker: messages are theirs, and so are the run's approvals and questions. */
  userId: string;
  agent: Agent;
}

/** The live key a bearer names, or null (401). Never reads cookies, and takes no other kind of token. */
export async function authenticateAgentKey(db: Database, header: string | undefined | null) {
  const raw = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? "";
  if (!raw.startsWith(AGENT_KEY_PREFIX)) return null;
  const [key] = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.tokenHash, sha256(raw)), live()));
  return key ?? null;
}

/**
 * The second half of the gate, after the key's own rate limit: the agent in the path is the key's (by id or handle;
 * any other is null, like an unknown key), the maker's account is in use and they are still a member (a member who
 * left loses their keys here, null), the workspace is open and the agent isn't held or archived, and the maker still
 * manages the agent and may talk to it. A refusal past the key is thrown (403 with its code).
 */
export async function agentKeyCaller(db: Database, key: AgentApiKey, agentRef: string): Promise<AgentKeyCaller | null> {
  const agent = await getAgent(db, key.orgId, key.agentId);
  const handle = agentRef.replace(/^@/, "").toLowerCase();
  if (!agent || (agentRef !== agent.id && handle !== agent.handle.toLowerCase())) return null;
  const [maker] = await db.select({ open: accountInUse }).from(users).where(eq(users.id, key.createdByUserId));
  if (!maker?.open) throw new ForbiddenError("This agentes.chat account can't be used right now", "agent_api.account");
  const membership = await getMembership(db, key.createdByUserId, key.orgId);
  if (!membership) {
    await db.transaction((tx) => revokeMemberApps(tx, key.orgId, key.createdByUserId));
    return null;
  }
  const refusal = await standingRefusal(db, key.orgId, agent.id);
  if (refusal) throw refusal;
  if (agent.archivedAt) throw new ForbiddenError("This agent is archived", "agent_api.agent_archived");
  if (!manages(membership, agent, key.createdByUserId))
    throw new ForbiddenError("The key's maker no longer manages this agent", "agent_api.not_manager");
  if (!canTalkTo(agent, key.createdByUserId, speakerOf(membership))) throw await audienceError(db, agent);
  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(agentApiKeys.id, key.id),
        or(isNull(agentApiKeys.lastUsedAt), lt(agentApiKeys.lastUsedAt, new Date(Date.now() - 60_000))),
      ),
    );
  return { keyId: key.id, keyName: key.name, orgId: key.orgId, userId: key.createdByUserId, agent };
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface AgentApiDeps {
  db: Database;
  pubsub: PubSub;
  publicUrl: string;
  judge?: Judge;
  talker?: Talker;
  gifs?: GifProvider | null;
  /** Wakes the in-process workers after a send (the agent starts sooner than at the next poll). */
  wakeWorkers?: () => void;
}

/** What a call answers: where the run of a message stands, and the agent's reply once there is one. */
export interface AgentApiResult {
  message_id: string;
  status: AppTaskStatus;
  reply?: {
    id: string;
    text: string;
    truncated: boolean;
    attachments: { name: string; url: string }[];
    url: string;
  };
  approval_url?: string;
  detail?: string;
  error?: string;
  poll_after_seconds?: number;
  retry_after_seconds?: number;
  conversation_url: string;
}

type Stored = NonNullable<Awaited<ReturnType<typeof getMessage>>>;

/**
 * Posts a message as the key's maker in the key's room, marked as sent through the key and as outside content
 * (ADR 0117), once per idempotency key, then waits up to `waitSeconds` for its run (`/mcp`'s own waits).
 */
export async function sendWithAgentKey(
  deps: AgentApiDeps,
  caller: AgentKeyCaller,
  input: { message: string; waitSeconds: number; idempotencyKey?: string },
  signal?: AbortSignal,
): Promise<AgentApiResult> {
  const { db } = deps;
  const room = await openAgentKeyRoom(db, caller.orgId, caller.userId, caller.agent.id, caller.keyId);
  const message = await postPersonMessage(
    { db, pubsub: deps.pubsub, judge: deps.judge, talker: deps.talker, gifs: deps.gifs },
    caller.userId,
    caller.orgId,
    room.id,
    {
      body: input.message,
      clientId: input.idempotencyKey
        ? `apikey:${sha256(`${caller.keyId}:${input.idempotencyKey}`).slice(0, 40)}`
        : null,
      // The maker's request, with their permissions, but written by a program that may carry text from anywhere:
      // outside content for learning and for what the run relays (ADR 0117, ADR 0120).
      meta: { via: { kind: "app", name: caller.keyName, apiKeyId: caller.keyId }, readOutside: true },
    },
  );
  const [already] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, caller.orgId),
        eq(auditLog.action, "agent_api.message_sent"),
        eq(auditLog.targetId, message.id),
      ),
    )
    .limit(1);
  if (!already)
    await recordAudit(db, {
      orgId: caller.orgId,
      actor: { type: "person", id: caller.userId },
      action: "agent_api.message_sent",
      target: { type: "message", id: message.id },
      details: { app: caller.keyName, agentId: caller.agent.id, keyId: caller.keyId },
      channelId: room.id,
    });
  deps.wakeWorkers?.();
  const stored = (await getMessage(db, caller.orgId, message.id)) as Stored;
  return resultOf(deps, caller, stored, input.waitSeconds, signal);
}

/** Where a message this key sent stands, waiting up to `waitSeconds`. Anything else is not found. */
export async function agentKeyResult(
  deps: AgentApiDeps,
  caller: AgentKeyCaller,
  messageId: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<AgentApiResult> {
  const message = await getMessage(deps.db, caller.orgId, messageId);
  const via = message?.meta?.via as { apiKeyId?: unknown } | undefined;
  const [room] = message
    ? await deps.db
        .select({ dmKey: channels.dmKey })
        .from(channels)
        .where(and(eq(channels.orgId, caller.orgId), eq(channels.id, message.channelId)))
    : [];
  if (
    !message ||
    message.deletedAt ||
    message.authorUserId !== caller.userId ||
    via?.apiKeyId !== caller.keyId ||
    room?.dmKey !== agentKeyRoomKey(caller.agent.id, caller.keyId, caller.userId)
  )
    throw new NotFoundError("No message with this id was sent with this key");
  return resultOf(deps, caller, message, waitSeconds, signal);
}

async function resultOf(
  deps: AgentApiDeps,
  caller: AgentKeyCaller,
  message: Stored,
  waitSeconds: number,
  signal: AbortSignal | undefined,
): Promise<AgentApiResult> {
  const seconds = Math.max(0, Math.min(waitSeconds, AGENT_API_LIMITS.waitSeconds));
  const state = (await waitForTask(deps, caller, message, caller.agent.id, seconds, signal)) as {
    status: AppTaskStatus;
    reply?: {
      id: string;
      untrusted_text: string;
      truncated: boolean;
      attachments: { name: string; url: string }[];
      url: string;
    };
    approval_url?: string;
    detail?: string;
    error?: string;
    poll_after_seconds?: number;
    retry_after_seconds?: number;
  };
  const { reply } = state;
  return {
    message_id: message.id,
    status: state.status,
    ...(reply
      ? {
          reply: {
            id: reply.id,
            text: reply.untrusted_text,
            truncated: reply.truncated,
            attachments: reply.attachments,
            url: reply.url,
          },
        }
      : {}),
    ...(state.approval_url ? { approval_url: state.approval_url } : {}),
    ...(state.detail ? { detail: state.detail } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.poll_after_seconds ? { poll_after_seconds: state.poll_after_seconds } : {}),
    ...(state.retry_after_seconds ? { retry_after_seconds: state.retry_after_seconds } : {}),
    conversation_url: appsLinkTo(deps, caller.orgId, message.channelId),
  };
}
