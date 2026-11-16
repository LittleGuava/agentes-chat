import type { BlobStoreResolver, ReadAloudEngine } from "@agenteschat/adapters";
import { and, type Database, eq, gte, isNull, lt, schema, sql } from "@agenteschat/db";
import { plainLines } from "@agenteschat/ui/markdown";
import { requireChannelAccess } from "./channels";
import { NotFoundError, ValidationError } from "./errors";
import { readableBody } from "./message-preview";

const { readAloudClips, messages, agents } = schema;

/**
 * Agents' replies read aloud (ADR 0209). One engine, the server's; the audio is made once per reply, voice and text,
 * kept on the workspace's storage as a cache, and served to whoever can read the channel.
 */
export interface ReadAloudDeps {
  db: Database;
  blobs: BlobStoreResolver;
  /** Null: reading aloud is off on this server (`READ_ALOUD_ENGINE=off`). */
  engine: ReadAloudEngine | null;
  /** agentes.chat's own servers only; null everywhere else. 0 turns it off. */
  limits: { personCharsPerDay: number } | null;
  /** Days the audio is kept (`READ_ALOUD_CACHE_DAYS`, at least 1, so a day's fair use still sees every row). */
  cacheDays: number;
}

/** The most characters read from one reply. */
export const READ_ALOUD_MAX_CHARS = 5000;
const DAY_MS = 24 * 3600_000;

const FILE = {
  id: readAloudClips.id,
  orgId: readAloudClips.orgId,
  storageConfigId: readAloudClips.storageConfigId,
  blobKey: readAloudClips.blobKey,
};

/**
 * The words of a reply as a person reads them: none for a voice message, a server-written line or a notice for the agent
 * (`readableBody`), and only prose (paragraphs, list items, quotes), so code, tables and headings aren't spelled out.
 * A long one stops at the last sentence that fits.
 */
export function spokenText(body: string, meta: Record<string, unknown> | null | undefined, max = READ_ALOUD_MAX_CHARS) {
  // A line the server wrote shows in the reader's language (`bodyCode`): its stored English isn't what they read.
  if (typeof meta?.bodyCode === "string") return "";
  const text = plainLines(readableBody(body, meta)).join("\n");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return (end > max / 2 ? cut.slice(0, end + 1) : cut).trim();
}

async function hash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function charsSince(db: Database, userId: string, since: Date) {
  const [row] = await db
    .select({ n: sql<string>`coalesce(sum(${readAloudClips.chars}), 0)` })
    .from(readAloudClips)
    .where(and(eq(readAloudClips.userId, userId), gte(readAloudClips.createdAt, since)));
  return Number(row?.n ?? 0);
}

/** Reads an agent's reply aloud, or finds it already read: the clip to play. */
export async function readAloud(
  deps: ReadAloudDeps,
  userId: string,
  orgId: string,
  messageId: string,
): Promise<{ clipId: string }> {
  const { db, engine } = deps;
  if (!engine) throw new ValidationError("Reading aloud is off on this server", "read_aloud.unavailable");
  const [message] = await db
    .select({
      channelId: messages.channelId,
      authorType: messages.authorType,
      body: messages.body,
      meta: messages.meta,
      voice: agents.readAloudVoice,
    })
    .from(messages)
    .leftJoin(agents, and(eq(agents.orgId, messages.orgId), eq(agents.id, messages.authorAgentId)))
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!message) throw new NotFoundError();
  await requireChannelAccess(db, userId, orgId, message.channelId);
  if (message.authorType !== "agent") throw new ValidationError("Only an agent's reply", "read_aloud.not_agent");
  const text = spokenText(message.body, message.meta, Math.min(READ_ALOUD_MAX_CHARS, engine.maxChars));
  if (!text) throw new ValidationError("Nothing to read in this message", "read_aloud.no_words");
  const voice = message.voice ?? engine.defaultVoice;
  const key = await hash(JSON.stringify([engine.id, engine.model, voice, text]));
  const found = async () => {
    const [row] = await db
      .select(FILE)
      .from(readAloudClips)
      .where(
        and(eq(readAloudClips.orgId, orgId), eq(readAloudClips.messageId, messageId), eq(readAloudClips.key, key)),
      );
    return row ?? null;
  };
  const place = await deps.blobs.forOrg(orgId);
  const cached = await found();
  if (cached?.storageConfigId === place.storageConfigId) return { clipId: cached.id };
  // Left on the workspace's former storage: a cache isn't moved, it's made again where new files go.
  if (cached) await forget(deps, cached);

  const limit = deps.limits?.personCharsPerDay ?? 0;
  if (limit > 0 && (await charsSince(db, userId, new Date(Date.now() - DAY_MS))) >= limit) {
    throw new ValidationError("Too much read aloud today", "read_aloud.limit");
  }
  const { audio, contentType } = await engine.speak({ text, voice, orgId });
  const id = crypto.randomUUID();
  const blobKey = `${place.prefix}read-aloud/${id}`;
  await place.store.put(blobKey, audio, { contentType });
  const [row] = await db
    .insert(readAloudClips)
    .values({
      id,
      orgId,
      channelId: message.channelId,
      messageId,
      key,
      userId,
      engine: engine.id,
      voice,
      chars: text.length,
      storageConfigId: place.storageConfigId,
      blobKey,
      contentType,
      size: audio.length,
    })
    .onConflictDoNothing()
    .returning({ id: readAloudClips.id });
  if (row) return { clipId: row.id };
  // Two people asked at once: the other one's audio stands.
  await place.store.delete(blobKey).catch(() => undefined);
  const winner = await found();
  if (!winner) throw new NotFoundError();
  return { clipId: winner.id };
}

/** A reply's audio, for who can read its channel: a signed link where the store has them, else the bytes. */
export async function readAloudAudio(
  deps: Pick<ReadAloudDeps, "db" | "blobs">,
  userId: string,
  orgId: string,
  clipId: string,
): Promise<{ url: string } | { body: Uint8Array; contentType: string }> {
  const [clip] = await deps.db
    .select({ ...FILE, channelId: readAloudClips.channelId, contentType: readAloudClips.contentType })
    .from(readAloudClips)
    .innerJoin(
      messages,
      and(
        eq(messages.orgId, readAloudClips.orgId),
        eq(messages.id, readAloudClips.messageId),
        isNull(messages.deletedAt),
      ),
    )
    .where(and(eq(readAloudClips.id, clipId), eq(readAloudClips.orgId, orgId)));
  if (!clip) throw new NotFoundError();
  await requireChannelAccess(deps.db, userId, orgId, clip.channelId);
  const store = await storeOf(deps, clip);
  if (store) {
    const url = await store.signedUrl(clip.blobKey, { expiresInSeconds: 300 });
    if (url) return { url };
    const object = await store.get(clip.blobKey);
    if (object) return { body: object.body, contentType: clip.contentType };
  }
  // Its file is gone: the row goes too, so the next listen makes it again.
  await forget(deps, clip);
  throw new NotFoundError();
}

type ClipFile = { id: string; orgId: string; storageConfigId: string | null; blobKey: string };

/** The store a clip was written to, or null when those storage settings were removed (its file went with them). */
async function storeOf(deps: Pick<ReadAloudDeps, "blobs">, clip: ClipFile) {
  return deps.blobs.forConfig(clip.orgId, clip.storageConfigId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
}

/** A clip that can't play: its row goes, and its file if it can. */
async function forget(deps: Pick<ReadAloudDeps, "db" | "blobs">, clip: ClipFile) {
  const store = await storeOf(deps, clip).catch(() => null);
  await store?.delete(clip.blobKey).catch(() => undefined);
  await deps.db.delete(readAloudClips).where(eq(readAloudClips.id, clip.id));
}

/** Each clip's file, then its row. `strict`: a failure throws (its job retries); else that row waits for the next sweep. */
async function drop(deps: Pick<ReadAloudDeps, "db" | "blobs">, clips: ClipFile[], strict: boolean) {
  let dropped = 0;
  for (const clip of clips) {
    try {
      const store = await storeOf(deps, clip);
      await store?.delete(clip.blobKey);
    } catch (error) {
      if (strict) throw error;
      continue;
    }
    await deps.db.delete(readAloudClips).where(eq(readAloudClips.id, clip.id));
    dropped++;
  }
  return dropped;
}
const SWEEP_PAGE = 200;

/**
 * The sweep: audio older than `cacheDays` goes, row and file, a page at a time while pages come full. Any file that
 * can't go stops it, so a storage that refuses waits for the next hour instead of being asked again and again.
 */
export async function sweepReadAloud(deps: Pick<ReadAloudDeps, "db" | "blobs" | "cacheDays">) {
  const before = new Date(Date.now() - Math.max(1, deps.cacheDays) * DAY_MS);
  let total = 0;
  for (;;) {
    const page = await deps.db
      .select(FILE)
      .from(readAloudClips)
      .where(lt(readAloudClips.createdAt, before))
      .orderBy(readAloudClips.createdAt)
      .limit(SWEEP_PAGE);
    const dropped = await drop(deps, page, false);
    total += dropped;
    if (page.length < SWEEP_PAGE || dropped < page.length) return total;
  }
}

/** A deleted channel's audio leaves storage now (a failure throws, so its job retries). */
export async function dropChannelReadAloud(
  deps: Pick<ReadAloudDeps, "db" | "blobs">,
  orgId: string,
  channelId: string,
) {
  const clips = await deps.db
    .select(FILE)
    .from(readAloudClips)
    .where(and(eq(readAloudClips.orgId, orgId), eq(readAloudClips.channelId, channelId)));
  await drop(deps, clips, true);
}
