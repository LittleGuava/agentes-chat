/**
 * The agents' work in a folder of this computer (ADR 0204): what to download is planned here, as a pure function of
 * the server's list, the manifest of what the app wrote and what the folder holds; the native side only writes what a
 * plan asked, and only while the folder is still as the plan saw it. Nothing goes up and nothing is ever deleted.
 */

import type { Host } from "../host/types";

/** One file of the server's list (`GET …/drive-sync`). */
export interface RemoteFile {
  id: string;
  version: number;
  /** The same from one version to the next. */
  name: string;
  format: "csv" | "patch" | null;
  agent: { id: string; name: string };
  conversation: { id: string; name: string; dm: boolean };
}

/** What the app wrote for one file: where (relative to the folder), which version, and the hash of those bytes. */
export interface ManifestEntry {
  path: string;
  version: number;
  sha256: string;
  /** The last version written next to a copy the person changed. */
  copied?: number;
}
export type Manifest = Record<string, ManifestEntry>;

/** The folder: every file in it (relative paths) and the hashes of the paths asked. */
export interface LocalScan {
  files: string[];
  hashes: Record<string, string>;
}

export type SyncAction =
  /** Write where nothing is. */
  | { kind: "new"; file: RemoteFile; path: string }
  /** Replace the app's own copy, only while it still has the hash `expect`. */
  | { kind: "replace"; file: RemoteFile; path: string; expect: string }
  /** The person changed their copy: the new version goes next to it, where nothing is. */
  | { kind: "copy"; file: RemoteFile; path: string };

const MAX_NAME = 80;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Characters no Windows file name may hold, and control characters. */
const forbidden = (c: string) => '<>:"/\\|?*'.includes(c) || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127;

const splitExt = (name: string): [string, string] => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
};
const trimEnd = (s: string) => s.replace(/[. ]+$/, "");

/**
 * A name every system takes as one file or folder: no separators, reserved characters or control characters, no
 * trailing dot or space, no `.`/`..`, no reserved Windows name, at most 80 characters with the extension kept.
 */
export function safeName(raw: string, fallback: string): string {
  const cleaned = [...raw.normalize("NFC")].map((c) => (forbidden(c) ? "_" : c)).join("");
  let name = trimEnd(cleaned.trim());
  if (name.length > MAX_NAME) {
    const [stem, ext] = splitExt(name);
    name = ext.length < 16 ? trimEnd(stem.slice(0, MAX_NAME - ext.length)) + ext : trimEnd(name.slice(0, MAX_NAME));
  }
  if (!name || name === "." || name === "..") return fallback;
  return RESERVED.test(name) ? `_${name}` : name;
}

const key = (path: string) => path.toLowerCase();

/** `dir/stem[ tag][ (n)].ext`, the first free of `taken` (paths compared without letter case, as Windows and macOS do). */
function freePath(dir: string, name: string, taken: Set<string>, tag: string | null): string {
  const [stem, ext] = splitExt(name);
  const base = tag ? `${stem} ${tag}` : stem;
  for (let n = 1; ; n++) {
    const candidate = `${dir}/${base}${n === 1 ? "" : ` (${n})`}${ext}`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
}

/** A version the app hasn't written or copied yet for a file it already wrote. */
const isNewer = (file: RemoteFile, entry: ManifestEntry) => file.version > Math.max(entry.version, entry.copied ?? 0);

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What to write this pass, in the order of the files' ids (the same plan every time for the same inputs). */
export function planFolderSync(input: {
  files: RemoteFile[];
  manifest: Manifest;
  local: LocalScan;
  /** The folder of an agent's direct messages, in the person's language. */
  dmFolder: string;
}): SyncAction[] {
  const { manifest, local } = input;
  const taken = new Set([...local.files, ...Object.values(manifest).map((e) => e.path)].map(key));
  const files = [...input.files].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const actions: SyncAction[] = [];
  for (const file of files) {
    const entry = manifest[file.id];
    if (!entry) {
      const agent = safeName(file.agent.name, safeName(file.agent.id, "agent"));
      const conversation = file.conversation.dm
        ? safeName(input.dmFolder, "dm")
        : safeName(file.conversation.name, safeName(file.conversation.id, "conversation"));
      const name = safeName(file.name, safeName(file.id, "file"));
      actions.push({ kind: "new", file, path: freePath(`${agent}/${conversation}`, name, taken, null) });
      continue;
    }
    if (!isNewer(file, entry)) continue;
    const there = local.hashes[entry.path];
    // Deleted by the person: it stays deleted.
    if (there === undefined) continue;
    if (there === entry.sha256) {
      actions.push({ kind: "replace", file, path: entry.path, expect: entry.sha256 });
      continue;
    }
    const path = freePath(folderOf(entry.path), baseOf(entry.path), taken, `(v${file.version})`);
    actions.push({ kind: "copy", file, path });
  }
  return actions;
}

/** The manifest once `action` wrote bytes whose SHA-256 is `sha256`. */
export function applyWritten(manifest: Manifest, action: SyncAction, sha256: string): Manifest {
  const { file } = action;
  if (action.kind === "copy") {
    const entry = manifest[file.id];
    return entry ? { ...manifest, [file.id]: { ...entry, copied: file.version } } : manifest;
  }
  return { ...manifest, [file.id]: { path: action.path, version: file.version, sha256 } };
}

/** What a pass needs from the app around it (the native side in the real app, a fake in tests). */
export interface FolderSyncPort {
  list(): Promise<RemoteFile[]>;
  scan(hash: string[]): Promise<LocalScan>;
  /** Writes the action's file; resolves with the SHA-256 written, rejects when the folder moved on. */
  fetch(action: SyncAction): Promise<string>;
}

export interface FolderSyncPass {
  manifest: Manifest;
  written: number;
  failed: number;
  /** The plan had more than this pass wrote. */
  more: boolean;
}

/** One pass: list, look, plan, write; the manifest is kept after each write, so a pass cut short loses nothing. */
export async function runFolderSync(
  port: FolderSyncPort,
  manifest: Manifest,
  save: (manifest: Manifest) => void,
  options: {
    dmFolder: string;
    maxWrites?: number;
    /** The timer stopped: no write starts after this says so. */
    stopped?: () => boolean;
  },
): Promise<FolderSyncPass> {
  const files = await port.list();
  // Only a copy a new version may replace is read for its hash: the rest of the folder is only listed.
  const replaceable = files.flatMap((f) => {
    const entry = manifest[f.id];
    return entry && isNewer(f, entry) ? [entry.path] : [];
  });
  const local = await port.scan(replaceable);
  const actions = planFolderSync({ files, manifest, local, dmFolder: options.dmFolder });
  const max = options.maxWrites ?? 50;
  let current = manifest;
  let written = 0;
  let failed = 0;
  for (const action of actions.slice(0, max)) {
    if (options.stopped?.()) return { manifest: current, written, failed, more: true };
    try {
      current = applyWritten(current, action, await port.fetch(action));
      save(current);
      written++;
    } catch {
      // The folder changed under the plan, or the download failed: the next pass plans it again from what is there.
      failed++;
    }
  }
  return { manifest: current, written, failed, more: actions.length > max };
}

/** What `Host.folderSyncFetch` takes: ids and a path relative to the folder, never a full path (the native side builds both). */
export interface FolderSyncFetch {
  server: string;
  orgId: string;
  artifactId: string;
  version: number;
  format: "csv" | "patch" | null;
  path: string;
  expect: string | null;
}

/** The conversations this computer downloads, of one workspace (Preferences › Agents' files). */
export interface FolderSyncChoice {
  /** Downloading, or off with the choice kept for when it's on again. */
  on: boolean;
  server: string;
  orgId: string;
  channelIds: string[];
}

/** The pass's port on the app's native side. */
export function hostPort(
  host: Pick<Host, "folderSyncList" | "folderSyncScan" | "folderSyncFetch">,
  choice: FolderSyncChoice,
): FolderSyncPort {
  return {
    list: () => host.folderSyncList(choice.server, choice.orgId, choice.channelIds),
    scan: (hash) => host.folderSyncScan(hash),
    fetch: (action) =>
      host.folderSyncFetch({
        server: choice.server,
        orgId: choice.orgId,
        artifactId: action.file.id,
        version: action.file.version,
        format: action.file.format,
        path: action.path,
        expect: action.kind === "replace" ? action.expect : null,
      }),
  };
}

export const FOLDER_SYNC_EVERY_MS = 5 * 60_000;

/**
 * A pass now and every `every` ms while a choice is on, one at a time; `kick` runs one at once (a changed choice), or
 * right after the pass under way. The manifest is kept per server and workspace. Returns the stop, after which a pass
 * under way starts no other write.
 */
export function startFolderSync(deps: {
  host: Pick<Host, "folderSyncList" | "folderSyncScan" | "folderSyncFetch">;
  choice: () => FolderSyncChoice | null;
  manifest: (choice: FolderSyncChoice) => Manifest;
  save: (choice: FolderSyncChoice, manifest: Manifest) => void;
  dmFolder: () => string;
  every?: number;
  /** Subscribes `run` to what should start a pass at once; returns the unsubscribe. */
  kick?: (run: () => void) => () => void;
  onPass?: (choice: FolderSyncChoice, pass: FolderSyncPass) => void;
  /** A pass that failed as a whole (the server out of reach, signed out): it runs again at the next tick. */
  onError?: (choice: FolderSyncChoice, error: unknown) => void;
}): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    const choice = deps.choice();
    if (stopped || !choice?.on || choice.channelIds.length === 0) return;
    running = true;
    try {
      const pass = await runFolderSync(
        hostPort(deps.host, choice),
        deps.manifest(choice),
        (m) => deps.save(choice, m),
        { dmFolder: deps.dmFolder(), stopped: () => stopped },
      );
      deps.onPass?.(choice, pass);
    } catch (error) {
      deps.onError?.(choice, error);
    } finally {
      running = false;
    }
    if (again && !stopped) {
      again = false;
      void tick();
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.every ?? FOLDER_SYNC_EVERY_MS);
  const unkick = deps.kick?.(() => void tick());
  return () => {
    stopped = true;
    clearInterval(timer);
    unkick?.();
  };
}

/** One conversation the person may choose (Preferences › Agents' files). */
export interface Conversation {
  id: string;
  /** A channel's name; the agent's name for a direct conversation with one. */
  name: string;
  dm: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const listOf = (body: unknown, key: string): unknown[] | null => {
  const list = isRecord(body) ? body[key] : null;
  return Array.isArray(list) ? list : null;
};
const byName = (a: Conversation, b: Conversation) => a.name.localeCompare(b.name);

/**
 * What `GET …/channels` and `GET …/dms` answered, as the conversations to choose from: channels by name, then the
 * direct conversations with an agent (one between people has no agent's files). An answer of another shape gives none.
 */
export function conversationsOf(channels: unknown, dms: unknown): Conversation[] {
  const rooms = listOf(channels, "channels");
  const direct = listOf(dms, "dms");
  if (!rooms || !direct) return [];
  const named = rooms.flatMap((c): Conversation[] =>
    isRecord(c) && typeof c.id === "string" && typeof c.name === "string"
      ? [{ id: c.id, name: c.name, dm: false }]
      : [],
  );
  const withAgents = direct.flatMap((d): Conversation[] => {
    const other = isRecord(d) && isRecord(d.with) ? d.with : null;
    return isRecord(d) && typeof d.channelId === "string" && other?.type === "agent" && typeof other.name === "string"
      ? [{ id: d.channelId, name: other.name, dm: true }]
      : [];
  });
  return [...named.sort(byName), ...withAgents.sort(byName)];
}

/** How the last pass went, as the popover keeps it for Preferences. */
export interface FolderSyncStatus {
  server: string;
  orgId: string;
  at: string;
  written: number;
  failed: number;
  /** The server didn't answer the list (out of reach, signed out). */
  unreachable: boolean;
}

/** A pass's ending (`startFolderSync`'s `onPass`, or `onError`: the server out of reach) as Preferences shows it. */
export function statusOf(
  choice: FolderSyncChoice,
  pass: Pick<FolderSyncPass, "written" | "failed"> | "unreachable",
  at: Date,
): FolderSyncStatus {
  const ran = pass === "unreachable" ? { written: 0, failed: 0 } : pass;
  return {
    server: choice.server,
    orgId: choice.orgId,
    at: at.toISOString(),
    written: ran.written,
    failed: ran.failed,
    unreachable: pass === "unreachable",
  };
}

/** The app's storage: the choice (Preferences writes it), how the last pass went and each workspace's manifest. */
export const FOLDER_SYNC_PREF = "folderSync";
export const FOLDER_SYNC_STATUS_PREF = "folderSync.status";
export const manifestPref = (choice: FolderSyncChoice) => `folderSync.manifest.${choice.server}|${choice.orgId}`;
