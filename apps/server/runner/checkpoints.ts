import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHECKPOINT_LIMITS,
  type CheckpointRestoreReply,
  isCheckpointId,
  type TurnCheckpoint,
} from "@agenteschat/adapters/machine-protocol";
import { HARDENED_GIT_ARGS } from "./git-guard";
import { isInside } from "./paths";

/**
 * File checkpoints per turn (ADR 0193). Before and after a work turn the runner records the turn's folder in a git
 * repository of its own (a shadow, under the runner's home), never in the folder's: every call sets `GIT_DIR` to the
 * shadow and `GIT_WORK_TREE` to the folder, with a config of its own and no system config, so nothing of the folder's
 * or the person's git (hooks, filters, attributes, programs) takes part. A repository inside the folder gets a shadow
 * of its own, since the outer one only sees a link to it. Best effort: any failure means no checkpoint, never a
 * failed or held turn.
 */

/** Never recorded: rebuilt from elsewhere, or binary and large, or a secret (`info/exclude` of every shadow). */
const EXCLUDES = [
  "node_modules/",
  "bower_components/",
  ".pnpm-store/",
  ".yarn/cache/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".gradle/",
  "Pods/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  ".terraform/",
  "*.log",
  "*.tmp",
  "*.swp",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.bmp",
  "*.tiff",
  "*.ico",
  "*.icns",
  "*.psd",
  "*.mp3",
  "*.mp4",
  "*.mov",
  "*.mkv",
  "*.webm",
  "*.wav",
  "*.flac",
  "*.ogg",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.tgz",
  "*.bz2",
  "*.xz",
  "*.7z",
  "*.rar",
  "*.jar",
  "*.iso",
  "*.dmg",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.parquet",
  "*.onnx",
  "*.safetensors",
  "*.gguf",
];

/** Folders never walked looking for a repository inside the turn's folder. */
const SKIP_DIRS = new Set(
  EXCLUDES.filter((e) => e.endsWith("/"))
    .map((e) => e.slice(0, -1))
    .filter((e) => !e.includes("/")),
);

/** Attributes the folder's `.gitattributes` may set that would change bytes on the way back: unset for every path. */
const ATTRIBUTES = "* -text -eol -filter -ident -working-tree-encoding\n";

/** The shadows' own config (`GIT_CONFIG_GLOBAL`; no system config is read). */
const GITCONFIG = [
  "[core]",
  "\tautocrlf = false",
  "\tsafecrlf = false",
  "\tquotepath = false",
  "\tlongpaths = true",
  "[gc]",
  "\tauto = 0",
  "[commit]",
  "\tgpgsign = false",
  "[advice]",
  "\taddEmbeddedRepo = false",
  "",
].join("\n");

/** How long each snapshot (before and after the turn) may take before the turn goes on without a checkpoint. */
export const SNAPSHOT_BUDGET_MS = 20_000;
/** How long, and how many per agent, checkpoints are kept on the computer. */
export const KEEP_MS = 7 * 24 * 3600_000;
export const KEEP_PER_AGENT = 100;
/** Repositories inside the turn's folder that get a shadow of their own, and how deep they are looked for. */
const MAX_NESTED = 16;
const NESTED_DEPTH = 3;
const GIT_TIMEOUT_MS = 120_000;
/** A shadow collects its garbage after a drop at most this often. */
const GC_EVERY_MS = 3600_000;

export interface CheckpointStore {
  /** The runner's `checkpoints` folder (its home's; the worker's in system mode). */
  dir: string;
  agentId: string;
}

/** A checkpoint taken before a turn; `finish` takes the second snapshot after it. */
export interface OpenCheckpoint {
  id: string;
  finish(): Promise<TurnCheckpoint | null>;
}

/** One recorded folder of a checkpoint: the turn's own (`rel` "") or a repository inside it. */
interface RootRecord {
  rel: string;
  path: string;
  /** The repositories inside it, relative to it: recorded by their own shadows, left out of this one. */
  inner: string[];
  shadow: string;
  before: string;
  after: string;
}

interface CheckpointRecord {
  v: 1;
  folder: string;
  createdAt: string;
  roots: RootRecord[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const agentDir = (s: CheckpointStore) => path.join(s.dir, sha(s.agentId));
const shadowDir = (s: CheckpointStore, key: string) => path.join(agentDir(s), "shadows", key);
const recordFile = (s: CheckpointStore, id: string) => path.join(agentDir(s), "turns", `${id}.json`);
const refOf = (id: string, side: "before" | "after") => `refs/checkpoints/${id}/${side}`;
const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  gitProbe ??= new Promise((resolve) => {
    execFile("git", ["--version"], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
  return gitProbe;
}

/** A home folder, a filesystem's root and the folders people keep their own things in are never recorded. */
export function refusedFolder(real: string): string | null {
  if (path.parse(real).root === real) return "the root of a filesystem";
  const home = (() => {
    try {
      return realpathSync.native(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  if (same(real, home)) return "a home folder";
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    if (same(real, path.join(home, name))) return `the ${name} folder`;
  }
  return null;
}

/** Git as this shadow: nothing of the person's environment or config, and the runner's hardened flags. */
function gitEnv(store: CheckpointStore, shadow: string, worktree: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    GIT_DIR: shadow,
    GIT_WORK_TREE: worktree,
    GIT_CONFIG_GLOBAL: path.join(agentDir(store), "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "agentes.chat checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@agentes.invalid",
    GIT_COMMITTER_NAME: "agentes.chat checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@agentes.invalid",
  };
}

function runGit(
  args: string[],
  o: { env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal; input?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error("checkpoint budget spent"));
    const child = execFile(
      "git",
      [...HARDENED_GIT_ARGS, ...args],
      {
        cwd: o.cwd,
        env: o.env,
        windowsHide: true,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout);
      },
    );
    if (o.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(o.input);
    }
  });
}

/**
 * One git operation at a time per shadow (its index lock would fail the other). Past `signal` the caller stops
 * waiting, but the git already running is let finish, never killed: a killed git leaves its `index.lock` behind on
 * Windows, and the next operation on that shadow waits for it anyway.
 */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    const spent = () => reject(new Error("checkpoint budget spent"));
    if (signal.aborted) return spent();
    signal.addEventListener("abort", spent, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", spent));
  });
}

/** Shadows a turn in progress holds: a restore there answers `busy`. */
const openShadows = new Map<string, number>();
const hold = (key: string, n: 1 | -1) => {
  const left = (openShadows.get(key) ?? 0) + n;
  if (left > 0) openShadows.set(key, left);
  else openShadows.delete(key);
};

/** The git repositories inside `folder` (relative to it, `/`-separated), as they are on disk now. */
async function reposIn(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (abs: string, rel: string, depth: number) => {
    if (depth > NESTED_DEPTH || found.length >= MAX_NESTED) return;
    let items: import("node:fs").Dirent[];
    try {
      items = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (!item.isDirectory() || item.name === ".git" || SKIP_DIRS.has(item.name)) continue;
      const childAbs = path.join(abs, item.name);
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (existsSync(path.join(childAbs, ".git"))) {
        if (found.length >= MAX_NESTED) return;
        found.push(childRel);
      }
      await walk(childAbs, childRel, depth + 1);
    }
  };
  await walk(folder, "", 1);
  return found;
}

/** The turn's folder and the repositories inside it, each a folder of its own to record. */
async function rootsOf(folder: string): Promise<{ rel: string; path: string; inner: string[] }[]> {
  const roots: { rel: string; path: string; inner: string[] }[] = [
    { rel: "", path: folder, inner: [] },
    ...(await reposIn(folder)).map((rel) => ({ rel, path: path.join(folder, ...rel.split("/")), inner: [] })),
  ];
  for (const root of roots) {
    const prefix = root.rel ? `${root.rel}/` : "";
    root.inner = roots.filter((r) => r !== root && r.rel.startsWith(prefix)).map((r) => r.rel.slice(prefix.length));
  }
  return roots;
}

async function ensureShadow(
  store: CheckpointStore,
  key: string,
  worktree: string,
  inner: string[],
  signal?: AbortSignal,
) {
  const shadow = shadowDir(store, key);
  const env = gitEnv(store, shadow, worktree);
  await mkdir(shadow, { recursive: true, mode: 0o700 });
  await writeFile(path.join(agentDir(store), "gitconfig"), GITCONFIG, { mode: 0o600 });
  if (!existsSync(path.join(shadow, "HEAD"))) {
    await runGit(["init", "--quiet", "--template="], { env, cwd: worktree, ...(signal ? { signal } : {}) });
  }
  // Only this process writes this shadow, one operation at a time (`serialize`): a lock here is one a git that
  // died (or was killed) left behind, and would refuse every later snapshot.
  await rm(path.join(shadow, "index.lock"), { force: true });
  await mkdir(path.join(shadow, "info"), { recursive: true });
  // The repositories inside it now, besides those recorded: one the turn created (with no commit yet `git add`
  // refuses it) or deleted must not sink this snapshot.
  inner = [...new Set([...inner, ...(await reposIn(worktree))])];
  // The runner's own folder, when it sits inside the turn's, is never recorded.
  const own = isInside(worktree, store.dir)
    ? [`/${path.relative(worktree, store.dir).split(path.sep).join("/")}/`]
    : [];
  const nested = inner.map((rel) => `/${rel.replace(/[\\*?[\]#! ]/g, "\\$&")}/`);
  await writeFile(path.join(shadow, "info", "exclude"), `${[...EXCLUDES, ...own, ...nested].join("\n")}\n`);
  await writeFile(path.join(shadow, "info", "attributes"), ATTRIBUTES);
  return { shadow, env };
}

/** Records the folder as it is now: a parentless commit of its tree. */
async function snapshot(env: NodeJS.ProcessEnv, worktree: string, signal?: AbortSignal) {
  const o = { env, cwd: worktree, ...(signal ? { signal } : {}) };
  await runGit(["add", "--all", "--", "."], o);
  const tree = (await runGit(["write-tree"], o)).trim();
  const commit = (await runGit(["commit-tree", tree, "-m", "checkpoint"], o)).trim();
  return { tree, commit };
}

/** The files that differ between two commits or trees (repositories inside left out: they have shadows of their own). */
async function changedPaths(env: NodeJS.ProcessEnv, worktree: string, from: string, to: string) {
  const out = await runGit(["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to], { env, cwd: worktree });
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const head = fields[i] ?? "";
    const file = fields[i + 1] ?? "";
    const [srcMode, dstMode] = head.replace(/^:/, "").split(" ");
    if (srcMode === "160000" || dstMode === "160000" || !file) continue;
    paths.push(file);
  }
  return paths;
}

const withBudget = (ms: number) => AbortSignal.timeout(Math.max(0, ms));

/** A folder recorded before the turn. */
type Taken = { rel: string; path: string; inner: string[]; key: string; tree: string; commit: string };

/**
 * Before a work turn in `folder`: records it (and the repositories inside it), or null when it can't (no git, a
 * folder never recorded, the budget spent, a git failure). The turn runs either way.
 */
export async function beginCheckpoint(
  o: CheckpointStore & { folder: string; budgetMs?: number },
): Promise<OpenCheckpoint | null> {
  const budget = o.budgetMs ?? SNAPSHOT_BUDGET_MS;
  let folder: string;
  try {
    folder = realpathSync.native(o.folder);
    if (!statSync(folder).isDirectory() || refusedFolder(folder)) return null;
  } catch {
    return null;
  }
  if (budget <= 0 || !(await gitAvailable())) return null;
  const store: CheckpointStore = { dir: o.dir, agentId: o.agentId };
  const id = randomBytes(16).toString("hex");
  const held: string[] = [];
  const release = () => {
    for (const key of held.splice(0)) hold(key, -1);
  };
  const before: Taken[] = [];
  try {
    const signal = withBudget(budget);
    const roots = await rootsOf(folder);
    for (const root of roots) {
      const key = sha(root.path);
      hold(key, 1);
      held.push(key);
      const taken = await serialize(
        key,
        async () => {
          const { env } = await ensureShadow(store, key, root.path, root.inner, signal);
          const snap = await snapshot(env, root.path, signal);
          await runGit(["update-ref", refOf(id, "before"), snap.commit], { env, cwd: root.path, signal });
          return snap;
        },
        signal,
      ).catch((err) => {
        // A repository inside that can't be recorded is left out; the turn's own folder can't be.
        if (root.rel === "" || signal.aborted) throw err;
        return null;
      });
      if (taken) before.push({ ...root, key, ...taken });
    }
  } catch {
    release();
    await dropRefs(store, id, before).catch(() => {});
    return null;
  }
  return {
    id,
    finish: async () => {
      try {
        return await finishCheckpoint(store, id, folder, before, budget);
      } catch {
        await dropRefs(store, id, before).catch(() => {});
        return null;
      } finally {
        release();
      }
    },
  };
}

async function finishCheckpoint(
  store: CheckpointStore,
  id: string,
  folder: string,
  before: Taken[],
  budget: number,
): Promise<TurnCheckpoint | null> {
  const signal = withBudget(budget);
  const roots: RootRecord[] = [];
  const paths: string[] = [];
  for (const b of before) {
    // A repository inside the folder the turn deleted (or that can't be read) is left out; the others still count.
    if (b.rel && !existsSync(path.join(b.path, ".git"))) continue;
    const changed = await serialize(
      b.key,
      async () => {
        const { env } = await ensureShadow(store, b.key, b.path, b.inner, signal);
        const after = await snapshot(env, b.path, signal);
        if (after.tree === b.tree) return null;
        const files = await changedPaths(env, b.path, b.commit, after.commit);
        if (files.length === 0) return null;
        await runGit(["update-ref", refOf(id, "after"), after.commit], { env, cwd: b.path, signal });
        return { after: after.commit, files };
      },
      signal,
    ).catch((err) => {
      if (b.rel === "" || signal.aborted) throw err;
      return null;
    });
    if (!changed) continue;
    roots.push({ rel: b.rel, path: b.path, inner: b.inner, shadow: b.key, before: b.commit, after: changed.after });
    for (const f of changed.files) paths.push(b.rel ? `${b.rel}/${f}` : f);
  }
  if (roots.length === 0) {
    await dropRefs(store, id, before);
    return null;
  }
  // The roots that didn't change keep no ref.
  await dropRefs(
    store,
    id,
    before.filter((b) => !roots.some((r) => r.shadow === b.key)),
  );
  const record: CheckpointRecord = { v: 1, folder, createdAt: new Date().toISOString(), roots };
  await mkdir(path.dirname(recordFile(store, id)), { recursive: true, mode: 0o700 });
  await writeFile(recordFile(store, id), JSON.stringify(record), { mode: 0o600 });
  void pruneCheckpoints(store).catch(() => {});
  return {
    id,
    count: paths.length,
    paths: paths.filter((p) => p.length <= CHECKPOINT_LIMITS.path).slice(0, CHECKPOINT_LIMITS.paths),
  };
}

async function dropRefs(store: CheckpointStore, id: string, roots: { key: string; path: string }[]) {
  for (const r of roots) {
    const shadow = shadowDir(store, r.key);
    if (!existsSync(path.join(shadow, "HEAD"))) continue;
    const env = gitEnv(store, shadow, r.path);
    await serialize(r.key, async () => {
      for (const side of ["before", "after"] as const) {
        await runGit(["update-ref", "-d", refOf(id, side)], { env, cwd: r.path }).catch(() => {});
      }
    });
  }
}

async function readRecord(store: CheckpointStore, id: string): Promise<CheckpointRecord | null> {
  try {
    const r = JSON.parse(await readFile(recordFile(store, id), "utf8")) as CheckpointRecord;
    return r?.v === 1 && Array.isArray(r.roots) ? r : null;
  } catch {
    return null;
  }
}

/**
 * `checkpoint.restore`: the turn's files as they were before it (`undo`) or as it left them (`redo`), and nothing
 * else. Any of them that differs from what the other side expects stops it before a file is written (`conflict`).
 */
export async function restoreCheckpoint(
  o: CheckpointStore & { id: string; direction: "undo" | "redo" },
): Promise<CheckpointRestoreReply> {
  const gone: CheckpointRestoreReply = { status: "gone", paths: [] };
  if (!isCheckpointId(o.id)) return gone;
  const store: CheckpointStore = { dir: o.dir, agentId: o.agentId };
  const record = await readRecord(store, o.id);
  if (!record) return gone;
  if (record.roots.some((r) => openShadows.has(r.shadow))) return { status: "busy", paths: [] };
  if (!(await gitAvailable())) return gone;
  const plans: { root: RootRecord; env: NodeJS.ProcessEnv; files: string[]; to: string }[] = [];
  const conflicts: string[] = [];
  for (const root of record.roots) {
    if (!existsSync(root.path) || !existsSync(path.join(shadowDir(store, root.shadow), "HEAD"))) return gone;
    const [expected, to] = o.direction === "undo" ? [root.after, root.before] : [root.before, root.after];
    const checked = await serialize(root.shadow, async () => {
      const { env } = await ensureShadow(store, root.shadow, root.path, root.inner ?? []);
      const files = await changedPaths(env, root.path, root.before, root.after);
      const now = await snapshot(env, root.path);
      const moved = new Set(await changedPaths(env, root.path, expected, now.commit));
      return { env, files, conflicts: files.filter((f) => moved.has(f)) };
    }).catch(() => null);
    if (!checked) return gone;
    for (const f of checked.conflicts) conflicts.push(root.rel ? `${root.rel}/${f}` : f);
    plans.push({ root, env: checked.env, files: checked.files, to });
  }
  if (conflicts.length > 0) return { status: "conflict", paths: conflicts.slice(0, CHECKPOINT_LIMITS.paths) };
  const written: string[] = [];
  for (const p of plans) {
    if (p.files.length === 0) continue;
    // `restore` writes what `to` has and removes what it hasn't, and never writes through a link out of the folder.
    await serialize(p.root.shadow, () =>
      runGit(
        ["restore", `--source=${p.to}`, "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { env: p.env, cwd: p.root.path, input: `${p.files.join("\0")}\0` },
      ),
    );
    for (const f of p.files) written.push(p.root.rel ? `${p.root.rel}/${f}` : f);
  }
  return { status: "restored", paths: written.slice(0, CHECKPOINT_LIMITS.paths) };
}

const lastGc = new Map<string, number>();

/** Drops what is older than `KEEP_MS` or past the newest `KEEP_PER_AGENT`, then collects the shadows it touched. */
export async function pruneCheckpoints(store: CheckpointStore, now = Date.now()) {
  const dir = path.join(agentDir(store), "turns");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const records: { id: string; at: number; roots: RootRecord[] }[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    const r = isCheckpointId(id) ? await readRecord(store, id) : null;
    const at = r ? Date.parse(r.createdAt) : Number.NaN;
    records.push({ id, at: Number.isFinite(at) ? at : 0, roots: r?.roots ?? [] });
  }
  records.sort((a, b) => b.at - a.at);
  const drop = records.filter((r, i) => i >= KEEP_PER_AGENT || now - r.at > KEEP_MS);
  const touched = new Map<string, string>();
  for (const r of drop) {
    if (r.roots.some((root) => openShadows.has(root.shadow))) continue;
    await dropRefs(
      store,
      r.id,
      r.roots.map((root) => ({ key: root.shadow, path: root.path })),
    );
    await rm(path.join(dir, `${r.id}.json`), { force: true });
    for (const root of r.roots) touched.set(root.shadow, root.path);
  }
  for (const [key, worktree] of touched) {
    if (now - (lastGc.get(key) ?? 0) < GC_EVERY_MS || !existsSync(worktree)) continue;
    lastGc.set(key, now);
    const env = gitEnv(store, shadowDir(store, key), worktree);
    await serialize(key, () => runGit(["gc", "--prune=now", "--quiet"], { env, cwd: worktree })).catch(() => {});
  }
}
