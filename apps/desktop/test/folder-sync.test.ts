import { describe, expect, test } from "bun:test";
import {
  applyWritten,
  conversationsOf,
  type FolderSyncChoice,
  type FolderSyncFetch,
  type FolderSyncPort,
  type LocalScan,
  type Manifest,
  planFolderSync,
  type RemoteFile,
  runFolderSync,
  type SyncAction,
  safeName,
  startFolderSync,
  statusOf,
} from "../src/control/folder-sync";

const DM = "Mensagens diretas";

const file = (over: Partial<RemoteFile> = {}): RemoteFile => ({
  id: "a1",
  version: 1,
  name: "Relatório.md",
  format: null,
  agent: { id: "ag1", name: "Dev" },
  conversation: { id: "c1", name: "general", dm: false },
  ...over,
});

const empty: LocalScan = { files: [], hashes: {} };
const plan = (files: RemoteFile[], manifest: Manifest = {}, local: LocalScan = empty) =>
  planFolderSync({ files, manifest, local, dmFolder: DM });
const where = (actions: SyncAction[]) => actions.map((a) => `${a.kind} ${a.path}`);

/** What the folder holds after the app wrote the manifest's files as they were, plus `extra`. */
const untouched = (manifest: Manifest, extra: Record<string, string> = {}): LocalScan => {
  const hashes = { ...Object.fromEntries(Object.values(manifest).map((e) => [e.path, e.sha256])), ...extra };
  return { files: Object.keys(hashes), hashes };
};

describe("the plan (ADR 0204)", () => {
  test("a new file goes to <agent>/<conversation>/<name>, only where nothing is", () => {
    const actions = plan([file()]);
    expect(actions).toEqual([{ kind: "new", file: file(), path: "Dev/general/Relatório.md" }]);
  });

  test("a new version over an untouched copy replaces it, while the copy still has the hash written", () => {
    const m = applyWritten({}, { kind: "new", file: file(), path: "Dev/general/Relatório.md" }, "h1");
    expect(m).toEqual({ a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } });
    expect(plan([file()], m, untouched(m))).toEqual([]);
    const v2 = file({ version: 2 });
    expect(plan([v2], m, untouched(m))).toEqual([
      { kind: "replace", file: v2, path: "Dev/general/Relatório.md", expect: "h1" },
    ]);
  });

  test("a new version over a copy the person edited lands next to it, once per version", () => {
    let m: Manifest = { a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } };
    const edited: LocalScan = { files: ["Dev/general/Relatório.md"], hashes: { "Dev/general/Relatório.md": "mine" } };
    const v2 = file({ version: 2 });
    const actions = plan([v2], m, edited);
    expect(actions).toEqual([{ kind: "copy", file: v2, path: "Dev/general/Relatório (v2).md" }]);
    m = applyWritten(m, actions[0] as SyncAction, "h2");
    // The person's copy is still theirs; the version is marked copied.
    expect(m.a1).toEqual({ path: "Dev/general/Relatório.md", version: 1, sha256: "h1", copied: 2 });
    const after: LocalScan = { files: [...edited.files, "Dev/general/Relatório (v2).md"], hashes: edited.hashes };
    expect(plan([v2], m, after)).toEqual([]);
    expect(where(plan([file({ version: 3 })], m, after))).toEqual(["copy Dev/general/Relatório (v3).md"]);
  });

  test("a file in the way that the app didn't write is never overwritten, in any letter case", () => {
    const local: LocalScan = { files: ["dev/GENERAL/RELATÓRIO.md"], hashes: {} };
    expect(where(plan([file()], {}, local))).toEqual(["new Dev/general/Relatório (2).md"]);
  });

  test("nothing is ever deleted: a file gone from the Drive or a conversation no longer chosen stays", () => {
    const m: Manifest = { a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } };
    expect(plan([], m, untouched(m))).toEqual([]);
  });

  test("a copy the person deleted stays deleted", () => {
    const m: Manifest = { a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } };
    expect(plan([file({ version: 2 })], m, empty)).toEqual([]);
  });

  test("the path is kept by the file's id: renaming the agent, the conversation or the file moves nothing", () => {
    const m: Manifest = { a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } };
    const renamed = file({ name: "Relatório final.md", agent: { id: "ag1", name: "Devin" } });
    expect(plan([renamed], m, untouched(m))).toEqual([]);
    expect(where(plan([{ ...renamed, version: 2 }], m, untouched(m)))).toEqual(["replace Dev/general/Relatório.md"]);
  });

  test("two files with the same name each get their own path, the same way every time", () => {
    const twins = [file({ id: "b2" }), file({ id: "a1" })];
    expect(where(plan(twins))).toEqual(["new Dev/general/Relatório.md", "new Dev/general/Relatório (2).md"]);
    expect(plan(twins).map((a) => a.file.id)).toEqual(["a1", "b2"]);
  });

  test("a conversation with the agent alone goes to the agent's direct messages folder", () => {
    const dm = file({ conversation: { id: "c2", name: "dm-ana-dev", dm: true } });
    expect(where(plan([dm]))).toEqual([`new Dev/${DM}/Relatório.md`]);
  });

  test("names that can't be files become safe ones", () => {
    const odd = file({
      name: "a:b?*.md",
      agent: { id: "ag1", name: "CON" },
      conversation: { id: "c", name: "..", dm: false },
    });
    expect(where(plan([odd]))).toEqual(["new _CON/c/a_b__.md"]);
  });
});

describe("safeName", () => {
  test.each([
    ["Relatório de março.md", "Relatório de março.md"],
    ['a/b\\c|d<e>f"g', "a_b_c_d_e_f_g"],
    ["tab\there", "tab_here"],
    ["nome. . ", "nome"],
    ["  espaços  ", "espaços"],
    ["aux.md", "_aux.md"],
    ["LPT1", "_LPT1"],
    ["com9.txt", "_com9.txt"],
    ["console.md", "console.md"],
    [".", "x"],
    ["..", "x"],
    ["", "x"],
    ["...", "x"],
  ])("%j → %j", (raw, safe) => {
    expect(safeName(raw, "x")).toBe(safe);
  });

  test("a long name is cut to 80 characters and keeps its extension", () => {
    const long = `${"a".repeat(200)}.pdf`;
    const safe = safeName(long, "x");
    expect(safe.length).toBe(80);
    expect(safe.endsWith(".pdf")).toBe(true);
  });
});

describe("a pass", () => {
  /** The folder as a map, the server as a list: writes check what they were told to expect, as the app does. */
  function fakePort(files: RemoteFile[]) {
    const disk = new Map<string, string>();
    const fetched: string[] = [];
    const port: FolderSyncPort = {
      list: async () => files,
      scan: async (hash) => ({
        files: [...disk.keys()],
        hashes: Object.fromEntries(hash.flatMap((p) => (disk.has(p) ? [[p, disk.get(p) as string]] : []))),
      }),
      fetch: async (action) => {
        const there = disk.get(action.path);
        if (action.kind === "replace" ? there !== action.expect : there !== undefined) throw new Error("changed");
        const sha = `${action.file.id}@${action.file.version}`;
        disk.set(action.path, sha);
        fetched.push(action.path);
        return sha;
      },
    };
    return { port, disk, fetched };
  }

  test("writes what the plan says, keeps the manifest after each write, and a second pass does nothing", async () => {
    const files = [file(), file({ id: "a2", name: "Vendas.csv", format: "csv" })];
    const { port, fetched } = fakePort(files);
    const saved: Manifest[] = [];
    const first = await runFolderSync(port, {}, (m) => saved.push(m), { dmFolder: DM });
    expect(first).toMatchObject({ written: 2, failed: 0, more: false });
    expect(fetched).toEqual(["Dev/general/Relatório.md", "Dev/general/Vendas.csv"]);
    expect(saved.length).toBe(2);
    expect(saved[1]).toEqual(first.manifest);
    const second = await runFolderSync(port, first.manifest, (m) => saved.push(m), { dmFolder: DM });
    expect(second).toMatchObject({ written: 0, failed: 0 });
  });

  test("a write the folder refused leaves the manifest as it was, for the next pass to plan again", async () => {
    const { port, disk } = fakePort([file({ version: 2 })]);
    const m: Manifest = { a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" } };
    disk.set("Dev/general/Relatório.md", "h1");
    const racing: FolderSyncPort = {
      ...port,
      fetch: async (action) => {
        disk.set(action.path, "saved just now");
        return port.fetch(action);
      },
    };
    const pass = await runFolderSync(racing, m, () => {}, { dmFolder: DM });
    expect(pass).toMatchObject({ written: 0, failed: 1, manifest: m });
    expect(disk.get("Dev/general/Relatório.md")).toBe("saved just now");
  });

  test("only the copies a new version may replace are hashed", async () => {
    const files = [file({ version: 2 }), file({ id: "a2", name: "b.md" })];
    const { port } = fakePort(files);
    const hashed: string[][] = [];
    const m: Manifest = {
      a1: { path: "Dev/general/Relatório.md", version: 1, sha256: "h1" },
      a2: { path: "Dev/general/b.md", version: 1, sha256: "h2" },
      gone: { path: "Dev/general/c.md", version: 1, sha256: "h3" },
    };
    await runFolderSync(
      {
        ...port,
        scan: async (hash) => {
          hashed.push(hash);
          return port.scan(hash);
        },
      },
      m,
      () => {},
      {
        dmFolder: DM,
      },
    );
    expect(hashed).toEqual([["Dev/general/Relatório.md"]]);
  });

  test("a pass told to stop writes nothing more", async () => {
    const files = ["a", "b", "c"].map((id) => file({ id, name: `${id}.md` }));
    const { port, fetched } = fakePort(files);
    let stop = false;
    const stopping: FolderSyncPort = {
      ...port,
      fetch: async (action) => {
        stop = true;
        return port.fetch(action);
      },
    };
    const pass = await runFolderSync(stopping, {}, () => {}, { dmFolder: DM, stopped: () => stop });
    expect(fetched).toEqual(["Dev/general/a.md"]);
    expect(pass).toMatchObject({ written: 1, more: true });
  });

  test("at most maxWrites per pass", async () => {
    const files = ["a", "b", "c"].map((id) => file({ id, name: `${id}.md` }));
    const { port } = fakePort(files);
    const pass = await runFolderSync(port, {}, () => {}, { dmFolder: DM, maxWrites: 2 });
    expect(pass).toMatchObject({ written: 2, more: true });
  });
});

describe("the popover's timer", () => {
  const CHOICE: FolderSyncChoice = { on: true, server: "https://agentes.example.com", orgId: "o1", channelIds: ["c1"] };

  /** The app's native side as the timer sees it: what it was asked, a folder in memory. */
  function fakeHost(files: RemoteFile[]) {
    const asked: FolderSyncFetch[] = [];
    const folder = new Map<string, string>();
    const listed: string[][] = [];
    return {
      asked,
      listed,
      host: {
        folderSyncList: async (_server: string, _org: string, channelIds: string[]) => {
          listed.push(channelIds);
          return files;
        },
        folderSyncScan: async (hash: string[]) => ({
          files: [...folder.keys()],
          hashes: Object.fromEntries(hash.flatMap((p) => (folder.has(p) ? [[p, folder.get(p) as string]] : []))),
        }),
        folderSyncFetch: async (request: FolderSyncFetch) => {
          asked.push(request);
          const sha = `sha-${request.version}`;
          folder.set(request.path, sha);
          return sha;
        },
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  test("without a choice, with no conversation chosen or turned off, nothing is asked of the server", async () => {
    for (const choice of [null, { ...CHOICE, channelIds: [] }, { ...CHOICE, on: false }]) {
      const { host, listed } = fakeHost([file()]);
      const errors: unknown[] = [];
      const stop = startFolderSync({
        host,
        choice: () => choice,
        manifest: () => ({}),
        save: () => {},
        dmFolder: () => DM,
        onError: (_c, e) => errors.push(e),
      });
      await settle();
      stop();
      expect(listed).toEqual([]);
      expect(errors).toEqual([]);
    }
  });

  test("a new version replaces the app's copy, asked with the hash the app wrote", async () => {
    let files = [file()];
    const { host, asked } = fakeHost([]);
    const listing = { ...host, folderSyncList: async () => files };
    let kept: Manifest = {};
    const pass = async () => {
      const stop = startFolderSync({
        host: listing,
        choice: () => CHOICE,
        manifest: () => kept,
        save: (_c, m) => {
          kept = m;
        },
        dmFolder: () => DM,
      });
      await settle();
      stop();
    };
    await pass();
    files = [file({ version: 2 })];
    await pass();
    expect(asked.map((r) => [r.version, r.path, r.expect])).toEqual([
      [1, "Dev/general/Relatório.md", null],
      [2, "Dev/general/Relatório.md", "sha-1"],
    ]);
  });

  test("a pass at once asks the native side by ids and a relative path, and keeps the manifest per workspace", async () => {
    const { host, asked } = fakeHost([file({ format: "csv", name: "Vendas.csv" })]);
    const kept = new Map<string, Manifest>();
    const stop = startFolderSync({
      host,
      choice: () => CHOICE,
      manifest: (c) => kept.get(c.orgId) ?? {},
      save: (c, m) => kept.set(c.orgId, m),
      dmFolder: () => DM,
    });
    await settle();
    stop();
    expect(asked).toEqual([
      {
        server: CHOICE.server,
        orgId: "o1",
        artifactId: "a1",
        version: 1,
        format: "csv",
        path: "Dev/general/Vendas.csv",
        expect: null,
      },
    ]);
    expect(kept.get("o1")).toEqual({ a1: { path: "Dev/general/Vendas.csv", version: 1, sha256: "sha-1" } });
  });

  test("a server out of reach is reported and the timer keeps going", async () => {
    const errors: unknown[] = [];
    const { host } = fakeHost([]);
    const down = { ...host, folderSyncList: async () => Promise.reject(new Error("status 502")) };
    const stop = startFolderSync({
      host: down,
      choice: () => CHOICE,
      manifest: () => ({}),
      save: () => {},
      dmFolder: () => DM,
      every: 1,
      onError: (_c, e) => errors.push(e),
    });
    await settle();
    stop();
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("the timer's news", () => {
  const CHOICE: FolderSyncChoice = { on: true, server: "https://agentes.example.com", orgId: "o1", channelIds: ["c1"] };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const host = (list: () => Promise<RemoteFile[]>) => ({
    folderSyncList: list,
    folderSyncScan: async () => ({ files: [], hashes: {} }),
    folderSyncFetch: async (r: FolderSyncFetch) => `sha-${r.version}`,
  });

  test("a changed choice runs a pass at once, and each pass says how it went", async () => {
    let kick = () => {};
    const passes: { orgId: string; written: number }[] = [];
    let choice: FolderSyncChoice | null = null;
    const stop = startFolderSync({
      host: host(async () => [file()]),
      choice: () => choice,
      manifest: () => ({}),
      save: () => {},
      dmFolder: () => DM,
      every: 60_000,
      kick: (run) => {
        kick = run;
        return () => {};
      },
      onPass: (c, pass) => passes.push({ orgId: c.orgId, written: pass.written }),
    });
    await settle();
    expect(passes).toEqual([]);
    choice = CHOICE;
    kick();
    await settle();
    stop();
    expect(passes).toEqual([{ orgId: "o1", written: 1 }]);
  });

  test("a pass the server didn't answer is reported with its choice", async () => {
    const failed: string[] = [];
    const stop = startFolderSync({
      host: host(async () => Promise.reject(new Error("status 502"))),
      choice: () => CHOICE,
      manifest: () => ({}),
      save: () => {},
      dmFolder: () => DM,
      onError: (c) => failed.push(c.orgId),
    });
    await settle();
    stop();
    expect(failed).toEqual(["o1"]);
  });
});

describe("the last pass, as Preferences shows it", () => {
  const CHOICE: FolderSyncChoice = { on: true, server: "https://agentes.example.com", orgId: "o1", channelIds: ["c1"] };
  const at = new Date("2026-11-15T12:00:00.000Z");

  test("a pass that ran says what it wrote and what it couldn't, for the workspace it ran on", () => {
    expect(statusOf(CHOICE, { written: 3, failed: 1 }, at)).toEqual({
      server: CHOICE.server,
      orgId: "o1",
      at: "2026-11-15T12:00:00.000Z",
      written: 3,
      failed: 1,
      unreachable: false,
    });
  });

  test("a pass that couldn't reach the server wrote nothing", () => {
    expect(statusOf(CHOICE, "unreachable", at)).toEqual({
      server: CHOICE.server,
      orgId: "o1",
      at: "2026-11-15T12:00:00.000Z",
      written: 0,
      failed: 0,
      unreachable: true,
    });
  });
});

describe("the conversations to choose from", () => {
  const channels = {
    channels: [
      { id: "c2", name: "vendas", isMember: true },
      { id: "c1", name: "general", isMember: true },
      { id: "c3", name: "anúncios", isMember: false },
    ],
  };
  const dms = {
    dms: [
      { channelId: "d1", with: { type: "agent", id: "g1", name: "Dev", handle: "dev" } },
      { channelId: "d2", with: { type: "person", id: "u1", name: "Ana", handle: null } },
    ],
  };

  test("channels by name, then the direct messages with agents; a person's DM has no agent's files", () => {
    expect(conversationsOf(channels, dms)).toEqual([
      { id: "c3", name: "anúncios", dm: false },
      { id: "c1", name: "general", dm: false },
      { id: "c2", name: "vendas", dm: false },
      { id: "d1", name: "Dev", dm: true },
    ]);
  });

  test("an answer that isn't what the server sends gives nothing, never a guess", () => {
    expect(conversationsOf({ channels: [{ id: 1 }] }, null)).toEqual([]);
    expect(conversationsOf("<html>", { dms: "x" })).toEqual([]);
  });
});
