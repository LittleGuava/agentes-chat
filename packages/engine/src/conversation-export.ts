import { and, asc, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { type ArtifactDeps, artifactFile, cleanFileName, fileRefOf } from "./artifacts";
import { recordAudit } from "./audit";
import { requireChannelAccess } from "./channels";
import { zip } from "./docx";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { readableBody, voiceOf } from "./message-preview";
import { fileIdsOf } from "./messages";
import { quietNoticeSql } from "./notices";

const { messages, users, agents, channelMembers, artifacts, artifactVersions } = schema;

/*
 * A conversation's transcript for whoever reads it (ADR 0055 addendum 2026-11-15): a channel, a DM or one thread, as
 * Markdown or JSON, optionally zipped with its files. Read under `requireChannelAccess`, the one check for reading a
 * conversation (ADR 0151: an administrator reads every channel, never someone else's DM). Only what the chat shows a
 * person leaves: the author's name, the time and the words `readableBody` gives; never `meta`, runs or usage.
 */

/** Caps of one export. Mutable for tests only. */
export const TRANSCRIPT_LIMITS = {
  /** The latest messages kept; older ones are left out and the transcript says it was cut. */
  messages: 5000,
  /** Files in a zip. */
  files: 200,
  /** Bytes of files in a zip: built in memory on the server's thread, so kept modest. */
  fileBytes: 50 * 1024 * 1024,
};

export const TRANSCRIPT_FORMATS = ["markdown", "json"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** Why a file on a message isn't in the zip. */
export type TranscriptFileLeftOut = "unreadable" | "too_large" | "unsupported" | "too_many";

export interface TranscriptFile {
  id: string;
  title: string;
  /** Its entry in the zip. */
  path?: string;
  leftOut?: TranscriptFileLeftOut;
}

export interface TranscriptMessage {
  id: string;
  /** The thread's root for a reply; null for a top-level message. */
  threadId: string | null;
  at: string;
  editedAt: string | null;
  /** `name` null: an author who left (the account or the agent was deleted). */
  author: { type: "person" | "agent"; id: string | null; name: string | null };
  text: string;
  /** A voice message's length (its words aren't kept as text, ADR 0100). */
  voice?: { durationMs: number };
  files: TranscriptFile[];
}

export interface ConversationTranscript {
  version: 1;
  conversation: { id: string; kind: string; name: string };
  thread: { id: string } | null;
  exportedAt: string;
  /** Older messages past `TRANSCRIPT_LIMITS.messages` were left out. */
  truncated: boolean;
  messages: TranscriptMessage[];
}

/** The transcript of a conversation, or of one of its threads, as `userId` reads it. */
export async function conversationTranscript(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
  options: { threadId?: string; now?: Date } = {},
): Promise<ConversationTranscript> {
  const { channel } = await requireChannelAccess(db, userId, orgId, channelId);
  const scope = and(
    eq(messages.orgId, orgId),
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
  );
  if (options.threadId) {
    const [root] = await db
      .select({ id: messages.id, threadId: messages.threadId })
      .from(messages)
      .where(and(scope, eq(messages.id, options.threadId)));
    if (!root || root.threadId) throw new NotFoundError("Thread not found");
  }
  const limit = TRANSCRIPT_LIMITS.messages;
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      authorAgentId: messages.authorAgentId,
      body: messages.body,
      meta: messages.meta,
      personName: users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, and(eq(agents.id, messages.authorAgentId), eq(agents.orgId, orgId)))
    .where(
      and(
        scope,
        options.threadId
          ? sql`(${messages.id} = ${options.threadId} or ${messages.threadId} = ${options.threadId})`
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const lines = rows
    .slice(0, limit)
    .reverse()
    .flatMap((r): TranscriptMessage[] => {
      const text = readableBody(r.body, r.meta);
      const voice = voiceOf(r.meta);
      const files = fileTitles(r.meta);
      if (!text && !voice && files.length === 0) return [];
      const agent = r.authorType === "agent";
      return [
        {
          id: r.id,
          threadId: r.threadId,
          at: r.createdAt.toISOString(),
          editedAt: r.editedAt?.toISOString() ?? null,
          author: {
            type: agent ? "agent" : "person",
            id: agent ? r.authorAgentId : r.authorUserId,
            name: (agent ? r.agentName : r.personName) ?? null,
          },
          text,
          ...(voice ? { voice: { durationMs: voice.durationMs } } : {}),
          files,
        },
      ];
    });
  return {
    version: 1,
    conversation: {
      id: channel.id,
      kind: channel.kind,
      name: channel.kind === "dm" ? await dmName(db, orgId, channelId, userId) : channel.name,
    },
    thread: options.threadId ? { id: options.threadId } : null,
    exportedAt: (options.now ?? new Date()).toISOString(),
    truncated,
    messages: options.threadId ? lines : underRoots(lines),
  };
}

/** The files on a message as the post wrote them (`meta.artifacts`: id and title). */
function fileTitles(meta: Record<string, unknown>): TranscriptFile[] {
  const titles = new Map(
    (Array.isArray(meta.artifacts) ? (meta.artifacts as { id?: unknown; title?: unknown }[]) : []).map((f) => [
      f?.id,
      typeof f?.title === "string" ? f.title : "",
    ]),
  );
  return fileIdsOf(meta).map((id) => ({ id, title: titles.get(id) ?? "" }));
}

/** Each reply right after its root, roots in time order; a reply whose root is past the cut stays at its time. */
function underRoots(lines: TranscriptMessage[]): TranscriptMessage[] {
  const roots = new Set(lines.filter((m) => !m.threadId).map((m) => m.id));
  const replies = new Map<string, TranscriptMessage[]>();
  for (const m of lines)
    if (m.threadId && roots.has(m.threadId)) replies.set(m.threadId, [...(replies.get(m.threadId) ?? []), m]);
  return lines.flatMap((m) => (!m.threadId ? [m, ...(replies.get(m.id) ?? [])] : roots.has(m.threadId) ? [] : [m]));
}

/** A DM by who else is in it (people and agents), as its exporter sees it in the sidebar. */
async function dmName(db: Database, orgId: string, channelId: string, userId: string) {
  const rows = await db
    .select({ person: users.name, agent: agents.name })
    .from(channelMembers)
    .leftJoin(users, eq(users.id, channelMembers.userId))
    .leftJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        sql`${channelMembers.userId} is distinct from ${userId}`,
      ),
    )
    .orderBy(asc(channelMembers.createdAt));
  const names = rows.flatMap((r) => ((r.person ?? r.agent) ? [(r.person ?? r.agent) as string] : []));
  return names.join(", ") || "dm";
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const quoted = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The transcript as Markdown: a title, then each message as its author in bold, the time, its words and its files.
 * Replies are quoted under their root. No sentence of ours, so it reads the same in any language.
 */
export function transcriptMarkdown(t: ConversationTranscript): string {
  const title = t.conversation.kind === "channel" ? `#${t.conversation.name}` : t.conversation.name;
  const parts = [`# ${title}`];
  if (t.truncated) parts.push("…");
  for (const m of t.messages) {
    const lines = [`**${m.author.name ?? "—"}** · ${stamp(m.at)}`];
    if (m.text) lines.push(m.text);
    if (m.voice) lines.push(`🎤 ${duration(m.voice.durationMs)}`);
    for (const f of m.files) lines.push(f.path ? `📎 [${f.title || f.path}](${encodeURI(f.path)})` : `📎 ${f.title}`);
    const block = lines.join("\n");
    parts.push(m.threadId ? quoted(block) : block);
  }
  return `${parts.join("\n\n")}\n`;
}

/** `name` for a file: letters, digits and dashes (a header and every file system take it). */
const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "conversation";

/** What may go into the zip, by id: kind and size of the file now, for files not in the trash. */
async function storedSizes(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, { kind: string; size: number }>();
  const rows = await db
    .select({ id: artifacts.id, kind: artifacts.kind, size: artifactVersions.size })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, artifacts.currentVersion)),
    )
    .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, ids), isNull(artifacts.deletedAt)));
  return new Map(rows.map((r) => [r.id, { kind: r.kind, size: Number(r.size) }]));
}

/** Live parts of the chat (ADR 0113), not files: nothing to download. */
const NOT_FILES = new Set(["block", "poll", "choices"]);

/**
 * The files of a transcript into zip entries, each read through `artifactFile` (its own visibility check) and named
 * in the transcript by its entry; what the exporter can't read, what is past the caps and live parts stay out, named
 * with why.
 */
async function attachFiles(deps: ArtifactDeps, userId: string, orgId: string, t: ConversationTranscript) {
  const ids = [...new Set(t.messages.flatMap((m) => m.files.map((f) => f.id)))];
  const sizes = await storedSizes(deps.db, orgId, ids);
  const outcome = new Map<string, Pick<TranscriptFile, "path" | "leftOut">>();
  const entries: [string, Uint8Array][] = [];
  let bytes = 0;
  for (const id of ids) {
    const stored = sizes.get(id);
    const ref = stored ? await fileRefOf(deps.db, userId, orgId, id) : null;
    if (!stored || !ref) {
      outcome.set(id, { leftOut: "unreadable" });
      continue;
    }
    if (NOT_FILES.has(stored.kind)) {
      outcome.set(id, { leftOut: "unsupported" });
      continue;
    }
    if (entries.length >= TRANSCRIPT_LIMITS.files) {
      outcome.set(id, { leftOut: "too_many" });
      continue;
    }
    if (bytes + stored.size > TRANSCRIPT_LIMITS.fileBytes) {
      outcome.set(id, { leftOut: "too_large" });
      continue;
    }
    const file = await artifactFile(deps, userId, orgId, id).catch((error: unknown) => {
      if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ValidationError)
        return null;
      throw error;
    });
    if (!file) {
      outcome.set(id, { leftOut: "unreadable" });
      continue;
    }
    let name: string;
    try {
      name = cleanFileName(file.filename);
    } catch {
      name = "file";
    }
    const path = `files/${String(entries.length + 1).padStart(3, "0")}-${name}`;
    entries.push([path, file.body]);
    bytes += file.body.byteLength;
    outcome.set(id, { path });
  }
  const messages = t.messages.map((m) => ({
    ...m,
    files: m.files.map((f) => ({ ...f, ...outcome.get(f.id) })),
  }));
  return { transcript: { ...t, messages }, entries };
}

export interface ConversationExport {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

/**
 * `GET …/channels/{channelId}/export`: a conversation (or one thread) as Markdown or JSON, zipped with its files when
 * `files`, for a person who reads it. One audit row with ids and counts, never the conversation's name or words: the
 * audit log is read by people who may not read this conversation.
 */
export async function exportConversation(
  deps: { db: Database; artifacts?: ArtifactDeps },
  userId: string,
  orgId: string,
  channelId: string,
  options: { format: TranscriptFormat; threadId?: string; files?: boolean; now?: Date },
): Promise<ConversationExport> {
  let transcript = await conversationTranscript(deps.db, userId, orgId, channelId, options);
  let entries: [string, Uint8Array][] = [];
  if (options.files) {
    if (!deps.artifacts) throw new ValidationError("files are not configured on this server");
    ({ transcript, entries } = await attachFiles(deps.artifacts, userId, orgId, transcript));
  }
  const markdown = options.format === "markdown";
  const text = markdown ? transcriptMarkdown(transcript) : `${JSON.stringify(transcript, null, 2)}\n`;
  const day = transcript.exportedAt.slice(0, 10);
  const base = `${slug(transcript.conversation.name)}${options.threadId ? "-thread" : ""}-${day}`;
  const ext = markdown ? "md" : "json";
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "conversation.exported",
    target: { type: "channel", id: channelId },
    channelId,
    details: {
      threadId: options.threadId ?? null,
      format: options.format,
      files: options.files === true,
      messages: transcript.messages.length,
      attached: entries.length,
    },
  });
  if (!options.files)
    return {
      body: new TextEncoder().encode(text),
      contentType: markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      filename: `${base}.${ext}`,
    };
  return {
    body: zip([[`transcript.${ext}`, text], ...entries]),
    contentType: "application/zip",
    filename: `${base}.zip`,
  };
}
