import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineRequest, RunnerFrame, WireBrainEvent } from "@agenteschat/adapters/machine-protocol";
import type { BrainManager } from "../../runner/brain";
import { beginCheckpoint, restoreCheckpoint } from "../../runner/checkpoints";
import { type HandlerContext, handleRequest } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { hasGit, removeDirs, tempDir } from "./helpers";

/** ADR 0193: a shadow git records the turn's folder before and after; undo and redo put back only what it changed. */

const AGENT = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
// Real git, several calls per snapshot: a busy Windows runner takes seconds.
setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

// The test's own git reads no config of the person's (a signing program among them).
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "agentes-checkpoints-test.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
    },
  }).trimEnd();

function setup() {
  const folder = tempDir("cp-folder-");
  const store = tempDir("cp-store-");
  dirs.push(folder, store);
  const at = (rel: string) => path.join(folder, ...rel.split("/"));
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
  };
  const read = (rel: string) => (existsSync(at(rel)) ? readFileSync(at(rel), "utf8") : null);
  return { folder, store, at, write, read, opts: { dir: store, agentId: AGENT } };
}

describe.skipIf(!hasGit)("file checkpoints", () => {
  test("undo puts back what the turn changed, created and deleted; redo does the turn again", async () => {
    const { folder, write, read, opts, at } = setup();
    write("a.txt", "one");
    write("gone.txt", "keep me");
    write("src/b.txt", "bee");
    const open = await beginCheckpoint({ ...opts, folder });
    expect(open).not.toBeNull();
    // The turn.
    write("a.txt", "two");
    rmSync(at("gone.txt"));
    write("src/new.txt", "fresh");
    const cp = await open?.finish();
    expect(cp?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(cp?.count).toBe(3);
    expect([...(cp?.paths ?? [])].sort()).toEqual(["a.txt", "gone.txt", "src/new.txt"]);

    const undone = await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(undone.status).toBe("restored");
    expect(read("a.txt")).toBe("one");
    expect(read("gone.txt")).toBe("keep me");
    expect(read("src/new.txt")).toBeNull();
    expect(read("src/b.txt")).toBe("bee");

    const redone = await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "redo" });
    expect(redone.status).toBe("restored");
    expect(read("a.txt")).toBe("two");
    expect(read("gone.txt")).toBeNull();
    expect(read("src/new.txt")).toBe("fresh");
  });

  test("a turn that changed nothing has no checkpoint", async () => {
    const { folder, write, opts } = setup();
    write("a.txt", "one");
    const open = await beginCheckpoint({ ...opts, folder });
    expect(await open?.finish()).toBeNull();
  });

  test("the folder's own repository is never touched", async () => {
    const { folder, write, opts } = setup();
    write("a.txt", "one");
    git(folder, "init", "-q", "--initial-branch=main");
    git(folder, "add", "a.txt");
    git(folder, "commit", "-q", "-m", "first");
    const before = {
      head: git(folder, "rev-parse", "HEAD"),
      status: git(folder, "status", "--porcelain"),
      index: readFileSync(path.join(folder, ".git", "index")),
      refs: git(folder, "for-each-ref"),
    };
    const open = await beginCheckpoint({ ...opts, folder });
    write("a.txt", "two");
    const cp = await open?.finish();
    expect(cp?.paths).toEqual(["a.txt"]);
    expect(git(folder, "status", "--porcelain")).toBe(" M a.txt");
    await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(git(folder, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(folder, "status", "--porcelain")).toBe(before.status);
    expect(readFileSync(path.join(folder, ".git", "index")).equals(before.index)).toBe(true);
    expect(git(folder, "for-each-ref")).toBe(before.refs);
  });

  test("a repository inside the folder is recorded too", async () => {
    const { folder, write, read, opts } = setup();
    write("notes.md", "n");
    write("repos/app/main.ts", "v1");
    git(path.join(folder, "repos", "app"), "init", "-q");
    const open = await beginCheckpoint({ ...opts, folder });
    write("repos/app/main.ts", "v2");
    write("notes.md", "n2");
    const cp = await open?.finish();
    expect([...(cp?.paths ?? [])].sort()).toEqual(["notes.md", "repos/app/main.ts"]);
    await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(read("repos/app/main.ts")).toBe("v1");
    expect(read("notes.md")).toBe("n");
  });

  test("a repository the turn creates or deletes inside the folder doesn't sink the rest", async () => {
    const { folder, write, read, opts, at } = setup();
    write("notes.md", "n");
    write("old/repo.txt", "r");
    git(at("old"), "init", "-q");
    const open = await beginCheckpoint({ ...opts, folder });
    // The turn starts a project of its own (no commit yet) and drops the old one.
    write("fresh/index.ts", "x");
    git(at("fresh"), "init", "-q");
    rmSync(at("old"), { recursive: true, force: true });
    write("notes.md", "n2");
    const cp = await open?.finish();
    expect(cp?.paths).toEqual(["notes.md"]);
    expect((await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" })).status).toBe("restored");
    expect(read("notes.md")).toBe("n");
  });

  test("a lock a killed git left in a shadow doesn't stop the next checkpoint", async () => {
    const { folder, write, store, opts } = setup();
    write("a.txt", "one");
    const first = await beginCheckpoint({ ...opts, folder });
    await first?.finish();
    const shadows = path.join(store, readdirSync(store)[0] ?? "", "shadows");
    for (const s of readdirSync(shadows)) writeFileSync(path.join(shadows, s, "index.lock"), "");
    const open = await beginCheckpoint({ ...opts, folder });
    write("a.txt", "two");
    expect((await open?.finish())?.paths).toEqual(["a.txt"]);
  });

  test("a file changed after the turn stops the undo before anything is written", async () => {
    const { folder, write, read, opts } = setup();
    write("a.txt", "one");
    write("b.txt", "bee");
    const open = await beginCheckpoint({ ...opts, folder });
    write("a.txt", "two");
    write("b.txt", "bee2");
    const cp = await open?.finish();
    write("b.txt", "a person's edit");
    const out = await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(out).toEqual({ status: "conflict", paths: ["b.txt"] });
    expect(read("a.txt")).toBe("two");
    expect(read("b.txt")).toBe("a person's edit");
  });

  test("bytes come back as they were, whatever the folder's attributes say", async () => {
    const { folder, write, at, opts } = setup();
    write(".gitattributes", "* text=auto eol=lf\n");
    writeFileSync(at("crlf.txt"), "one\r\ntwo\r\n");
    const open = await beginCheckpoint({ ...opts, folder });
    writeFileSync(at("crlf.txt"), "changed\n");
    const cp = await open?.finish();
    await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(readFileSync(at("crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
  });

  test("ignored and excluded files are neither recorded nor put back", async () => {
    const { folder, write, read, opts } = setup();
    write(".gitignore", "secret.out\n");
    write("secret.out", "s1");
    write("node_modules/pkg/index.js", "dep1");
    write("a.txt", "one");
    const open = await beginCheckpoint({ ...opts, folder });
    write("secret.out", "s2");
    write("node_modules/pkg/index.js", "dep2");
    write("a.txt", "two");
    const cp = await open?.finish();
    expect(cp?.paths).toEqual(["a.txt"]);
    await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" });
    expect(read("a.txt")).toBe("one");
    expect(read("secret.out")).toBe("s2");
    expect(read("node_modules/pkg/index.js")).toBe("dep2");
  });

  test("while a turn runs in the folder the answer is busy; an unknown id is gone", async () => {
    const { folder, write, opts } = setup();
    write("a.txt", "one");
    const first = await beginCheckpoint({ ...opts, folder });
    write("a.txt", "two");
    const cp = await first?.finish();
    const second = await beginCheckpoint({ ...opts, folder });
    expect((await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" })).status).toBe("busy");
    await second?.finish();
    expect((await restoreCheckpoint({ ...opts, id: cp?.id ?? "", direction: "undo" })).status).toBe("restored");
    expect(await restoreCheckpoint({ ...opts, id: "0".repeat(32), direction: "undo" })).toEqual({
      status: "gone",
      paths: [],
    });
    expect((await restoreCheckpoint({ ...opts, id: "HEAD~1", direction: "undo" })).status).toBe("gone");
  });

  test("a home folder is never recorded, and a snapshot past its budget gives the turn none", async () => {
    const { folder, write, opts } = setup();
    expect(await beginCheckpoint({ ...opts, folder: os.homedir() })).toBeNull();
    write("a.txt", "one");
    expect(await beginCheckpoint({ ...opts, folder, budgetMs: 1 })).toBeNull();
    // Nothing is left open: the next turn's checkpoint works.
    const open = await beginCheckpoint({ ...opts, folder });
    write("a.txt", "two");
    expect((await open?.finish())?.paths).toEqual(["a.txt"]);
  });

  test("a brain turn's done event says what it changed, and checkpoint.restore undoes it as the agent", async () => {
    const ws = tempDir("cp-ws-");
    const home = tempDir("cp-home-");
    dirs.push(ws, home);
    const agent = { id: AGENT, handle: "dev", name: "Dev" };
    const folder = await agentWorkspace(ws, agent);
    writeFileSync(path.join(folder, "a.txt"), "one");
    const frames: RunnerFrame[] = [];
    let editing = "two";
    const brains = {
      turn: async (_req: unknown, o: { folder: string; emit: (e: WireBrainEvent) => void }) => {
        writeFileSync(path.join(o.folder, "a.txt"), editing);
        const done: WireBrainEvent = { type: "done", text: "edited" };
        o.emit(done);
        return done;
      },
    } as unknown as BrainManager;
    const ctx: HandlerContext = {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      brains,
      checkpointsDir: path.join(home, "checkpoints"),
    };
    const turn = (mode?: "plan" | "work") =>
      ({
        op: "brain.turn",
        runId: "run-00000001",
        kind: "claude_code",
        session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
        cwd: "",
        system: "",
        prompt: "edit it",
        mcp: { token: "t" },
        ...(mode ? { permissions: { mode } } : {}),
        agent,
      }) as MachineRequest;
    const scope = { signal: new AbortController().signal, output: () => {}, emit: (f: RunnerFrame) => frames.push(f) };
    const reply = (await handleRequest(ctx, turn(), scope)) as { final: WireBrainEvent };
    const streamed = frames.find((f) => f.type === "brain.event" && f.event.type === "done");
    const final = reply.final.type === "done" ? reply.final : null;
    expect(final?.checkpoint?.paths).toEqual(["a.txt"]);
    expect(streamed?.type === "brain.event" && streamed.event.type === "done" && streamed.event.checkpoint).toEqual(
      final?.checkpoint ?? false,
    );
    // The stream ends after its final event.
    expect(frames.at(-1)?.type).toBe("brain.done");

    const restore = (id: string, direction: "undo" | "redo") =>
      handleRequest(ctx, { op: "checkpoint.restore", id, direction, agent } as MachineRequest, scope);
    expect(await restore(final?.checkpoint?.id ?? "", "undo")).toEqual({ status: "restored", paths: ["a.txt"] });
    expect(readFileSync(path.join(folder, "a.txt"), "utf8")).toBe("one");

    // A plan turn changes nothing on purpose: no checkpoint is taken.
    editing = "three";
    const plan = (await handleRequest(ctx, turn("plan"), scope)) as { final: WireBrainEvent };
    expect(plan.final.type === "done" && plan.final.checkpoint).toBeFalsy();
  });
});
