import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  type lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { parseExecutors } from "@agenteschat/adapters/machine-protocol";
import { binaryRefusal, useBinaries } from "../../runner/binaries";
import { normalizeStored } from "../../runner/config";
import { configFromGrant } from "../../runner/daemon";
import {
  cachedCodexVersion,
  cliSpawn,
  detectExecutors,
  findOnWindowsPath,
  resolveCommand,
} from "../../runner/executors";
import type { DeviceGrant } from "../../runner/pairing";
import type { WorkerState } from "../../runner/supervisor";
import { executorCommand, taskProgram } from "../../runner/tasks";
import { WorkerLink } from "../../runner/worker";
import { waitFor } from "./helpers";

const windows = process.platform === "win32";
let root = "";
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentes-binaries-"));
  savedPath = process.env.PATH;
});

afterEach(() => {
  useBinaries({});
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

/** A program that prints `said` for any argument (a `.cmd` on Windows, a shell script elsewhere). */
function fakeCli(dir: string, name: string, said: string, marker?: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, windows ? `${name}.cmd` : name);
  const mark = marker ? (windows ? `echo ran> "${marker}"\r\n` : `echo ran > '${marker}'\n`) : "";
  writeFileSync(file, windows ? `@echo off\r\n${mark}echo ${said}\r\n` : `#!/bin/sh\n${mark}echo '${said}'\n`);
  if (!windows) chmodSync(file, 0o755);
  return file;
}

/** A PATH holding only a decoy CLI of the same name, which leaves `marker` behind if anything starts it. */
function decoyOnPath(name: string) {
  const marker = path.join(root, `${name}-decoy-ran`);
  const dir = path.join(root, "path");
  fakeCli(dir, name, "0.0.1 (decoy)", marker);
  process.env.PATH = dir;
  return { dir, marker };
}

test("the config keeps an absolute path per known brain and drops everything else", () => {
  const abs = windows ? "C:\\tools\\claude.cmd" : "/opt/claude/bin/claude";
  const stored = normalizeStored({
    binaries: { claude: abs, codex: "relative/codex", grok: `${abs}\0x`, someone: abs, cursor: 7 },
  });
  expect(stored.binaries).toEqual({ claude: abs });
  expect(normalizeStored({ binaries: { codex: "codex" } }).binaries).toBeUndefined();
  expect(normalizeStored({ binaries: "/opt/claude" }).binaries).toBeUndefined();
});

test("every way the runner starts a brain's CLI by name takes the configured binary, never the PATH's", () => {
  const pinned = fakeCli(path.join(root, "pinned"), "claude", "2.1.300 (Claude Code)");
  const decoy = decoyOnPath("claude");
  useBinaries({ claude: pinned });

  expect(resolveCommand("claude", decoy.dir)).toBe(pinned);
  expect(findOnWindowsPath("claude", decoy.dir)).toBe(pinned);
  const run = cliSpawn(["claude"], ["--version"], decoy.dir);
  expect([run.file, ...run.args].join(" ")).toContain(pinned);
  // Another command of the same PATH is found as before.
  expect(resolveCommand("codex", decoy.dir)).toBe("codex");
});

test("hello reports the configured binary's own version and its path; the PATH's CLI never runs", async () => {
  const pinned = fakeCli(path.join(root, "pinned"), "codex", "codex-cli 0.130.0");
  const decoy = decoyOnPath("codex");
  useBinaries({ codex: pinned });

  const { found } = await detectExecutors();
  expect(found.codex).toEqual({ version: "codex-cli 0.130.0", binary: pinned });
  expect(existsSync(decoy.marker)).toBe(false);
  // What the server keeps of it.
  expect(parseExecutors(JSON.parse(JSON.stringify(found))).codex).toEqual({
    version: "codex-cli 0.130.0",
    binary: pinned,
  });
});

test("a configured binary that isn't there is reported as one that can't start, and the PATH's isn't used instead", async () => {
  const gone = path.join(root, "nowhere", windows ? "codex.cmd" : "codex");
  const decoy = decoyOnPath("codex");
  useBinaries({ codex: gone });

  const { found } = await detectExecutors();
  expect(found.codex).toBeUndefined();
  expect(found.broken?.codex).toContain(gone);
  expect(existsSync(decoy.marker)).toBe(false);
  expect(findOnWindowsPath("codex", decoy.dir)).toBeNull();
});

test("a configured binary that can't run starts as a missing program would, never the PATH's of that name", async () => {
  const decoy = decoyOnPath("codex");
  useBinaries({ codex: path.join(root, "nowhere", windows ? "codex.cmd" : "codex") });
  // A Codex turn asks its version this way: not installed, not "couldn't tell" (which a turn retries).
  expect(await cachedCodexVersion()()).toBeUndefined();
  expect(existsSync(decoy.marker)).toBe(false);
});

test("a look that can't tell keeps the last one only when it was of the same binary", async () => {
  const unsure = async () => ({ status: null, stdout: "", error: new Error("timed out") });
  const prev = { codex: { version: "codex-cli 0.130.0", binary: "/opt/codex/codex" } };
  // Back to the PATH's: the pinned one's look says nothing about it.
  expect((await detectExecutors(unsure, prev, {}, () => false, {})).found.codex).toBeUndefined();
  // Still the same binary: its last look stands.
  expect((await detectExecutors(unsure, prev, {}, () => false, { codex: "/opt/codex/codex" })).found.codex).toEqual(
    prev.codex,
  );
});

test("a configured wrapper that doesn't answer --version as its CLI does is one that can't start, not a missing CLI", async () => {
  const wrapper = fakeCli(path.join(root, "wrap"), "agent", "starting my wrapper");
  decoyOnPath("agent");
  useBinaries({ cursor: wrapper });
  const { found } = await detectExecutors();
  expect(found.cursor).toBeUndefined();
  expect(found.broken?.cursor).toContain(wrapper);
  expect(found.broken?.cursor).toContain("--version");
});

test.skipIf(windows)("a configured file that isn't executable is refused", async () => {
  const file = path.join(root, "codex");
  writeFileSync(file, "#!/bin/sh\necho 1.0.0\n");
  chmodSync(file, 0o644);
  expect(binaryRefusal(file)).toMatch(/executable/i);
  useBinaries({ codex: file });
  expect((await detectExecutors()).found.broken?.codex).toMatch(/executable/i);
});

test("Codex's version kept for its turns is asked again when its binary changes", async () => {
  const one = fakeCli(path.join(root, "one"), "codex", "codex-cli 0.130.0");
  const two = fakeCli(path.join(root, "two"), "codex", "codex-cli 0.131.0");
  decoyOnPath("codex");
  const version = cachedCodexVersion();
  useBinaries({ codex: one });
  expect(await version()).toBe("codex-cli 0.130.0");
  useBinaries({ codex: two });
  expect(await version()).toBe("codex-cli 0.131.0");
});

test("a background task's line starts the configured binary, quoted for its shell", () => {
  const pinned = fakeCli(path.join(root, "pinned dir"), "codex", "codex-cli 0.130.0");
  useBinaries({ codex: pinned });
  const program = taskProgram("codex");
  expect(program).toBeDefined();
  const line = executorCommand("codex", { ...(program ? { program } : {}) });
  expect(line.startsWith(program ?? "")).toBe(true);
  expect(line).toContain("pinned dir");
  useBinaries({});
  expect(executorCommand("codex", {}).startsWith("codex exec")).toBe(true);
});

test("agentes-runner binaries sets, lists and unsets a brain's binary in the config, and refuses one that can't run", () => {
  const home = path.join(root, "home");
  const pinned = fakeCli(path.join(root, "pinned"), "codex", "codex-cli 0.130.0");
  const cli = (...args: string[]) => {
    const r = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, "../../runner/main.ts"), ...args, "--home", home],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const stored = () => normalizeStored(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).binaries;

  expect(cli("binaries", "set", "codex", pinned).code).toBe(0);
  expect(stored()).toEqual({ codex: pinned });
  expect(cli("binaries", "list").out).toContain(pinned);

  const missing = cli("binaries", "set", "claude", path.join(root, "nowhere", "claude"));
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("isn't there");
  expect(cli("binaries", "set", "someone", pinned).code).toBe(1);
  expect(stored()).toEqual({ codex: pinned });

  expect(cli("binaries", "unset", "codex").code).toBe(0);
  expect(stored()).toBeUndefined();
}, 60_000);

test("pairing again, with any server, keeps the computer's own binaries; a server's grant never brings any", () => {
  const binaries = { claude: "/opt/claude/claude" };
  const input = (server: string) => ({
    server,
    // What a server could put in its answer: only its own fields are read.
    grant: {
      machineId: "m2",
      token: "t",
      name: "n",
      org: { id: "o", name: "O" },
      binaries: { codex: "/tmp/evil" },
    } as unknown as DeviceGrant,
    workspace: "/w",
    tools: { claude: true, codex: true, commands: true },
    desktop: false,
  });
  const prev = { server: "https://a.example.com", machineId: "m", binaries };
  expect(configFromGrant(prev, input("https://b.example.com")).binaries).toEqual(binaries);
  expect(configFromGrant(null, input("https://b.example.com")).binaries).toBeUndefined();
});

test("an agent's worker takes the binaries only from root's worker.state, an absolute path per known brain", async () => {
  const fromRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, new PassThrough());
  const states: WorkerState[] = [];
  link.onState = (s) => states.push(s);
  fromRoot.write(
    `${JSON.stringify({
      type: "worker.state",
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
      paused: { paused: false },
      limits: { maxConcurrentTasks: 3, taskMaxSeconds: 3600, brainIdleMinutes: 10, brainMaxProcesses: 3 },
      binaries: { claude: "/opt/claude/claude", codex: "codex", someone: "/opt/x" },
    })}\n`,
  );
  await waitFor(() => states.length === 1);
  expect(states[0]?.binaries).toEqual({ claude: "/opt/claude/claude" });
});

/** A file system of `lstat` answers: each path's owner, mode and kind. */
function fakeStat(entries: Record<string, { uid: number; mode: number; dir?: boolean; link?: boolean }>) {
  return ((p: string) => {
    const e = entries[p];
    if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return {
      uid: e.uid,
      mode: e.mode,
      isFile: () => !e.dir && !e.link,
      isDirectory: () => Boolean(e.dir),
      isSymbolicLink: () => Boolean(e.link),
    } as Stats;
  }) as unknown as typeof lstatSync;
}

test.skipIf(windows)("system mode: only a file root alone can change, that agents' users can run", () => {
  const good = {
    "/": { uid: 0, mode: 0o755, dir: true },
    "/opt": { uid: 0, mode: 0o755, dir: true },
    "/opt/claude": { uid: 0, mode: 0o755, dir: true },
    "/opt/claude/claude": { uid: 0, mode: 0o755 },
  };
  const file = "/opt/claude/claude";
  expect(binaryRefusal(file, { system: true, stat: fakeStat(good) })).toBeNull();
  // A folder others can write: an agent could swap the file root runs.
  expect(
    binaryRefusal(file, { system: true, stat: fakeStat({ ...good, "/opt": { uid: 0, mode: 0o777, dir: true } }) }),
  ).toMatch(/root/i);
  // A person's own file.
  expect(
    binaryRefusal(file, {
      system: true,
      stat: fakeStat({ ...good, "/opt/claude/claude": { uid: 1000, mode: 0o755 } }),
    }),
  ).toMatch(/root/i);
  // A link: its target is what counts.
  expect(
    binaryRefusal(file, {
      system: true,
      stat: fakeStat({ ...good, "/opt/claude/claude": { uid: 0, mode: 0o777, link: true } }),
    }),
  ).toMatch(/root/i);
  // Root's alone, but agents' users can't reach it (a folder under /root).
  expect(
    binaryRefusal(file, {
      system: true,
      stat: fakeStat({ ...good, "/opt/claude": { uid: 0, mode: 0o700, dir: true } }),
    }),
  ).toMatch(/agents/i);
  expect(
    binaryRefusal(file, { system: true, stat: fakeStat({ ...good, "/opt/claude/claude": { uid: 0, mode: 0o750 } }) }),
  ).toMatch(/agents/i);
});
