/**
 * What the desktop app downloads to a person's folder (ADR 0204): the agents' files in the Drive of the conversations
 * the person chose, as far as `listArtifacts` lets that person read them.
 */
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { type ArtifactKind, type ArtifactView, listArtifacts } from "./artifacts";

/** The kinds that make a file on disk; blocks, polls and choices live in their conversation. */
const SYNCED = ["document", "table", "diff", "html", "diagram", "file"] as const;
type SyncedKind = (typeof SYNCED)[number];
const isSynced = (kind: ArtifactKind): kind is SyncedKind => (SYNCED as readonly string[]).includes(kind);

/** The extension a kind takes on disk; a table goes down as CSV and a diff as a patch, the formats a person opens. */
const EXTENSION: Record<Exclude<SyncedKind, "file">, string> = {
  document: "md",
  table: "csv",
  diff: "patch",
  html: "html",
  diagram: "mmd",
};
const FORMAT: Partial<Record<SyncedKind, "csv" | "patch">> = { table: "csv", diff: "patch" };

/** At most this many files per call, the most recently updated first. */
export const DRIVE_SYNC_MAX = 1000;
const PAGE = 200;

export interface DriveSyncFile {
  id: string;
  kind: SyncedKind;
  version: number;
  /** A name that stays the same from one version to the next: an upload's own name, else the title and an extension. */
  name: string;
  /** The download's export (`/file?format=`); null: the bytes as stored. */
  format: "csv" | "patch" | null;
  agent: { id: string; name: string };
  conversation: { id: string; name: string; dm: boolean };
  updatedAt: string;
}

export async function driveSyncList(
  db: Database,
  userId: string,
  orgId: string,
  channelIds: string[],
): Promise<{ files: DriveSyncFile[]; truncated: boolean }> {
  if (channelIds.length === 0) return { files: [], truncated: false };
  const seen: ArtifactView[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += PAGE) {
    const page = await listArtifacts(db, { type: "person", userId }, orgId, {
      channelIds,
      who: "agents",
      limit: PAGE,
      offset,
    });
    seen.push(...page);
    if (page.length < PAGE) break;
    if (seen.length >= DRIVE_SYNC_MAX) {
      truncated = true;
      break;
    }
  }
  const picked = seen.filter((a) => a.inDrive && a.channelId && a.createdBy.type === "agent" && isSynced(a.kind));
  if (picked.length > DRIVE_SYNC_MAX) truncated = true;
  const rows = picked.slice(0, DRIVE_SYNC_MAX);
  if (rows.length === 0) return { files: [], truncated };

  const agentIds = [...new Set(rows.map((a) => a.createdBy.id))];
  const chosen = [...new Set(rows.map((a) => a.channelId as string))];
  const uploads = rows.filter((a) => a.kind === "file").map((a) => a.id);
  const [agents, channels, names] = await Promise.all([
    db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, agentIds))),
    db
      .select({ id: schema.channels.id, name: schema.channels.name, kind: schema.channels.kind })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), inArray(schema.channels.id, chosen))),
    uploads.length
      ? db
          .select({
            artifactId: schema.artifactVersions.artifactId,
            version: schema.artifactVersions.version,
            fileName: schema.artifactVersions.fileName,
          })
          .from(schema.artifactVersions)
          .where(and(eq(schema.artifactVersions.orgId, orgId), inArray(schema.artifactVersions.artifactId, uploads)))
      : Promise.resolve([]),
  ]);
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const channel = new Map(channels.map((c) => [c.id, c]));
  const uploadName = new Map(names.map((n) => [`${n.artifactId}:${n.version}`, n.fileName]));

  const files = rows.flatMap((a): DriveSyncFile[] => {
    const where = channel.get(a.channelId as string);
    const by = agentName.get(a.createdBy.id);
    if (!where || by === undefined || !isSynced(a.kind)) return [];
    const name =
      a.kind === "file" ? (uploadName.get(`${a.id}:${a.version}`) ?? a.title) : `${a.title}.${EXTENSION[a.kind]}`;
    return [
      {
        id: a.id,
        kind: a.kind,
        version: a.version,
        name,
        format: FORMAT[a.kind] ?? null,
        agent: { id: a.createdBy.id, name: by },
        conversation: { id: where.id, name: where.name, dm: where.kind === "dm" },
        updatedAt: a.updatedAt,
      },
    ];
  });
  return { files, truncated };
}
