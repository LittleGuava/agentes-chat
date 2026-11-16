import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HelperStep } from "../../runner/desktop-helper";
import {
  fromUia,
  fromUiaWindows,
  type UiaApp,
  type UiaNode,
  type UiaSnapshot,
  type UiaWindow,
  type WinReplies,
  type WinReply,
  winHelperCommand,
  winHelperSourceLine,
  winSteps,
} from "../../runner/desktop-helper-win";
import { desktopLook, desktopRefs } from "../../runner/desktop-tree";

const SOURCE = path.join(import.meta.dir, "..", "..", "runner", "desktop-helper-win.cs");

// A made-up Windows desktop at 1920×1080: Notepad with its Save As dialog in front, the taskbar on top.
// Synthetic on purpose: a recording of a real desktop would carry its owner's titles and files.
const win = (w: Partial<UiaWindow> & Pick<UiaWindow, "hwnd" | "stack" | "className" | "box">): UiaWindow => ({
  active: false,
  topmost: false,
  tool: false,
  process: "Notepad",
  title: "",
  pid: 4100,
  ...w,
});
const node = (n: Partial<UiaNode> & Pick<UiaNode, "id" | "parent" | "type">): UiaNode => ({
  index: -1,
  children: 0,
  name: "",
  box: null,
  offscreen: false,
  enabled: true,
  focused: false,
  password: false,
  patterns: [],
  ...n,
});

function desktop(): UiaSnapshot {
  const windows = [
    win({ hwnd: 10, stack: 0, className: "Progman", process: "explorer", pid: 900, box: [0, 0, 1920, 1080] }),
    win({ hwnd: 20, stack: 1, className: "Notepad", title: "notes.txt - Notepad", box: [100, 100, 900, 700] }),
    win({ hwnd: 30, stack: 2, className: "#32770", title: "Save As", active: true, box: [300, 250, 500, 300] }),
    win({
      hwnd: 40,
      stack: 3,
      className: "Shell_TrayWnd",
      process: "explorer",
      pid: 900,
      topmost: true,
      box: [0, 1032, 1920, 48],
    }),
  ];
  const notepad: UiaApp = {
    pid: 4100,
    name: "Notepad",
    nodes: [
      node({ id: "42.20", parent: null, type: "Window", name: "notes.txt - Notepad", box: [100, 100, 900, 700] }),
      node({ id: "42.20.1", parent: "42.20", type: "TitleBar", name: "notes.txt - Notepad", box: [100, 100, 900, 30] }),
      node({ id: "42.20.2", parent: "42.20", type: "MenuBar", box: [100, 130, 900, 24] }),
      node({
        id: "42.20.3",
        parent: "42.20.2",
        type: "MenuItem",
        name: "File",
        box: [104, 132, 40, 20],
        patterns: ["ExpandCollapse"],
        expand: "collapsed",
      }),
      node({
        id: "42.20.4",
        parent: "42.20",
        type: "Document",
        name: "Text editor",
        box: [110, 180, 880, 600],
        patterns: ["Value", "Text"],
        value: "the secret plan\nsecond line",
        readOnly: false,
      }),
      node({ id: "42.30", parent: null, type: "Window", name: "Save As", box: [300, 250, 500, 300] }),
      node({ id: "42.30.1", parent: "42.30", type: "Pane", box: [300, 280, 500, 270] }),
      node({
        id: "42.30.2",
        parent: "42.30.1",
        type: "Edit",
        name: "File name:",
        box: [400, 300, 300, 24],
        focused: true,
        patterns: ["Value"],
        value: "notes.txt",
        readOnly: false,
      }),
      node({
        id: "42.30.3",
        parent: "42.30.1",
        type: "ComboBox",
        name: "Save as type:",
        box: [400, 330, 300, 24],
        patterns: ["Value", "ExpandCollapse"],
        value: "Text Documents (*.txt)",
        readOnly: true,
        expand: "collapsed",
      }),
      node({
        id: "42.30.4",
        parent: "42.30.1",
        type: "Edit",
        name: "Password",
        box: [400, 360, 300, 24],
        password: true,
        patterns: ["Value"],
        value: "hunter2",
        readOnly: false,
      }),
      node({
        id: "42.30.5",
        parent: "42.30.1",
        type: "CheckBox",
        name: "Remember",
        box: [400, 390, 120, 20],
        patterns: ["Toggle"],
        toggle: "on",
      }),
      node({
        id: "42.30.6",
        parent: "42.30.1",
        type: "Button",
        name: "Bold",
        box: [540, 390, 40, 20],
        patterns: ["Toggle"],
        toggle: "on",
      }),
      node({ id: "42.30.7", parent: "42.30.1", type: "Button", name: "Save", box: [600, 500, 90, 28] }),
      node({
        id: "42.30.8",
        parent: "42.30.1",
        type: "Button",
        name: "Cancel",
        box: [700, 500, 90, 28],
        enabled: false,
      }),
      node({ id: "42.30.9", parent: "42.30.1", type: "Button", name: "Hidden", box: [0, 0, 10, 10], offscreen: true }),
      node({
        id: "42.30.10",
        parent: "42.30.1",
        type: "Window",
        name: "Replace?",
        box: [420, 420, 200, 60],
      }),
      node({ id: "42.30.11", parent: "42.30.10", type: "Button", name: "Yes", box: [430, 450, 60, 24] }),
    ],
  };
  const explorer: UiaApp = {
    pid: 900,
    name: "explorer",
    nodes: [
      node({ id: "42.40", parent: null, type: "Pane", name: "Taskbar", box: [0, 1032, 1920, 48] }),
      node({ id: "42.40.1", parent: "42.40", type: "Button", name: "Start", box: [880, 1036, 40, 40] }),
    ],
  };
  return { screen: [1920, 1080], windows, apps: [notepad, explorer], ms: 12 };
}

describe("fromUia: the person's desktop as ADR 0062's snapshot", () => {
  test("windows keep their stack, and the taskbar, the desktop, dialogs and menus get their types", () => {
    const windows = fromUiaWindows([
      ...desktop().windows,
      win({ hwnd: 50, stack: 4, className: "#32768", box: [104, 152, 200, 300] }),
      win({ hwnd: 60, stack: 5, className: "tooltips_class32", box: [10, 10, 80, 20] }),
    ]);
    expect(windows.map((w) => [w.xid, w.stack, w.types, w.override])).toEqual([
      [10, 0, ["desktop"], false],
      [20, 1, ["normal"], false],
      [30, 2, ["dialog"], false],
      [40, 3, ["dock"], false],
      [50, 4, ["popup_menu"], true],
      [60, 5, ["tooltip"], true],
    ]);
    expect(windows[1]).toMatchObject({
      class: ["Notepad", "Notepad"],
      title: "notes.txt - Notepad",
      pid: 4100,
      box: [100, 100, 900, 700],
    });
  });

  test("ADR 0062's look writes it as screen text: the taskbar first, then the windows front to back", () => {
    const look = desktopLook(fromUia(desktop()), desktopRefs());
    expect(look.snapshot.split("\n")).toEqual([
      '- toolbar "Panel"',
      '  - button "Start" [ref=e1]',
      '- dialog "Save As" [active, ref=e2]',
      '  - textbox "File name:" [focused, ref=e3]: "notes.txt"',
      '  - combobox "Save as type:" [collapsed, ref=e4]: "Text Documents (*.txt)"',
      '  - textbox "Password" [password, ref=e5]',
      '  - checkbox "Remember" [checked, ref=e6]',
      '  - button "Bold" [pressed, ref=e7]',
      // No indexes from the app: top to bottom, left to right.
      '  - dialog "Replace?"',
      '    - button "Yes" [ref=e8]',
      '  - button "Save" [ref=e9]',
      '  - button "Cancel" [disabled, ref=e10]',
      '- window "notes.txt - Notepad" [ref=e11]',
      "  - menubar",
      '    - menuitem "File" [collapsed, ref=e12]',
    ]);
    expect(look.address).toBe("desktop://notepad/dialog");
    expect(look.title).toBe("Save As");
    // The document under the dialog is covered at its center: neither it nor its text is in the look.
    expect(look.snapshot).not.toContain("secret plan");
    // A password field's value never reaches the look, even when a reader sent it.
    expect(look.snapshot).not.toContain("hunter2");
  });

  test("an element is named by its process and runtime id, with no space in either, and editable when its value is", () => {
    const look = desktopLook(fromUia(desktop()), desktopRefs());
    expect(look.targets.e3).toMatchObject({
      node: ["uia:4100", "42.30.2"],
      window: 30,
      app: "Notepad",
      editable: true,
      extents: [400, 300, 300, 24],
    });
    expect(look.targets.e4?.editable).toBeUndefined();
    expect(look.targets.e6).toMatchObject({ role: "checkbox", checked: true });
    expect(look.targets.e11).toMatchObject({ xid: 20, window: 20 });
  });

  test("an uncovered document shows its text as lines, and an app that didn't answer says so", () => {
    const snap = desktop();
    snap.windows = snap.windows.filter((w) => w.hwnd !== 30);
    for (const app of snap.apps) app.nodes = app.nodes?.filter((n) => !n.id.startsWith("42.30"));
    const notepad = snap.windows.find((w) => w.hwnd === 20);
    if (notepad) notepad.active = true;
    snap.apps.push({ pid: 7000, name: "Frozen", error: "didn't answer" });
    snap.windows.push(
      win({ hwnd: 70, stack: 4, className: "Frozen", process: "Frozen", pid: 7000, box: [50, 50, 20, 20] }),
    );
    const lines = desktopLook(fromUia(snap), desktopRefs()).snapshot.split("\n");
    expect(lines).toContain('  - document "Text editor" [ref=e5]');
    expect(lines).toContain('    - text "the secret plan"');
    expect(lines).toContain('- window "Frozen" [ref=e2]: its app didn\'t answer: find targets on the screen image');
  });
});

describe("winSteps: ADR 0062's steps for the Windows helper", () => {
  test("key names become virtual-key chords, modifiers first", () => {
    const keys = (key: string) => winSteps([{ key }]);
    expect(keys("ctrl+s")).toEqual([{ keys: [0x11, 0x53] }]);
    expect(keys("Return")).toEqual([{ keys: [0x0d] }]);
    expect(keys("alt+F4")).toEqual([{ keys: [0x12, 0x73] }]);
    expect(keys("shift+Tab")).toEqual([{ keys: [0x10, 0x09] }]);
    expect(keys("ctrl+shift+Escape")).toEqual([{ keys: [0x11, 0x10, 0x1b] }]);
    expect(keys("super")).toEqual([{ keys: [0x5b] }]);
    expect(keys("Page_Down")).toEqual([{ keys: [0x22] }]);
    expect(keys("Next")).toEqual([{ keys: [0x22] }]);
    expect(keys("BackSpace")).toEqual([{ keys: [0x08] }]);
    expect(keys("ctrl+A")).toEqual([{ keys: [0x11, 0x41] }]);
    expect(keys("7")).toEqual([{ keys: [0x37] }]);
    expect(keys("F12")).toEqual([{ keys: [0x7b] }]);
  });

  test("every other step goes as it is", () => {
    const steps: Exclude<HelperStep, { key: string }>[] = [
      { move: [1, 2] },
      { click: [3, 4], button: 3, count: 2 },
      { drag: [1, 2, 3, 4] },
      { type: "Olá, ÇÃO" },
      { fill: ["uia:4100", "42.30.2"], text: "x" },
      { scroll: [5, 6], dy: 3 },
      { activate: 20 },
      { launch: "user:Notepad.lnk" },
      { open: "C:\\Users\\me\\a.txt" },
      { pause: 50 },
    ];
    expect(winSteps(steps)).toEqual(steps);
  });

  test("a key it can't name refuses the whole request", () => {
    expect(() => winSteps([{ type: "a" }, { key: "ctrl+Hyper_L" }])).toThrow(/Hyper_L/);
    expect(() => winSteps([{ key: "ctrl+" }])).toThrow();
  });
});

describe("the helper's command", () => {
  test("Windows PowerShell with no profile starts it, and the source goes on stdin's first line", () => {
    const command = winHelperCommand();
    expect(command.slice(0, 7)).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    // A Windows command line holds at most 32,767 characters: the source can't go in it.
    expect(command.join(" ").length).toBeLessThan(2000);
    expect(winHelperCommand({ dry: true }).join(" ")).toContain("$true");
    const line = winHelperSourceLine();
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const source = readFileSync(SOURCE, "utf8");
    expect(Buffer.from(line.slice(0, -1), "base64").toString("utf8")).toBe(source);
    expect(/^[\t\r\n\x20-\x7e]*$/.test(source)).toBe(true);
  });
});

// The helper itself, on a Windows computer only (the CI runs on Linux). In dry mode: it reads the desktop
// and sends nothing to it, so these never click or type on the developer's own screen (ADR 0201 §6).
const onWindows = process.platform === "win32";
const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

async function talk(
  lines: (object | string)[],
): Promise<{ replies: WinReply[]; out: string; err: string; code: number }> {
  const proc = Bun.spawn(winHelperCommand({ dry: true }), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  // One write for the source and every request: lines must survive however the pipe splits them.
  const requests = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  proc.stdin.write(`${winHelperSourceLine()}${requests}\n`);
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const replies = out
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as WinReply);
  return { replies, out, err, code };
}

describe.skipIf(!onWindows)("the helper on this Windows computer (dry)", () => {
  test("it answers each line in order, refuses what is malformed before doing anything, and never repeats typed text", async () => {
    const { replies, out, err, code } = await talk([
      { id: 1, op: "hello" },
      "not json",
      { id: 2, op: "frobnicate" },
      { id: 3, op: "input", steps: [{ click: [10, 10] }, { click: ["x", 1] }] },
      {
        id: 4,
        op: "input",
        steps: [
          { move: [5, 5] },
          { click: [5, 5], button: 3, count: 2 },
          { type: "senha: Olá7Q\n" },
          { keys: [0x11, 0x53] },
        ],
        settle: { quietMs: 10, capMs: 50 },
      },
      { id: 5, op: "input", steps: [{ fill: ["uia:1", "42.1"], text: "Olá7Q" }] },
      { id: 6, op: "extents", nodes: [["uia:1", "42.1"]] },
      // Windows' process ids run past any screen coordinate.
      { id: 7, op: "snapshot", scope: "front", skip: [123_456, 4_000_000] },
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).not.toContain("\uFFFD");
    expect(replies.map((r) => r.id)).toEqual([1, null, 2, 3, 4, 5, 6, 7]);
    expect(replies[7]).toMatchObject({ ok: true });
    expect(replies[0]).toMatchObject({ ok: true, data: { a11y: true, dry: true, dpiAware: true, damage: false } });
    const first = replies[0];
    if (!first?.ok) throw new Error(JSON.stringify(first));
    const hello = first.data as WinReplies["hello"];
    expect(hello.screen?.every((n) => n > 0)).toBe(true);
    expect(replies[1]).toMatchObject({ ok: false, code: "bad_request" });
    expect(replies[2]).toMatchObject({ ok: false, code: "bad_request" });
    // The first click is fine, the second isn't: nothing is sent at all.
    expect(replies[3]).toMatchObject({ ok: false, code: "bad_request" });
    expect(replies[4]).toMatchObject({
      ok: true,
      data: { sent: ["move 5,5", "click 5,5 button 3 x2", "unicode 12 + return 1", "chord 2"] },
    });
    // An element no look of this helper gave is stale, never guessed.
    expect(replies[5]).toMatchObject({ ok: false, code: "stale" });
    expect(replies[6]).toMatchObject({ ok: true, data: { boxes: { "uia:1 42.1": null } } });
    expect(out).not.toContain("Olá7Q");
  }, 60_000);

  test("its look of the real desktop becomes screen text, and its elements answer extents", async () => {
    const proc = Bun.spawn(winHelperCommand({ dry: true }), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    const reader = proc.stdout.getReader();
    let buffered = "";
    const next = async (): Promise<WinReply> => {
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the helper ended");
        buffered += new TextDecoder().decode(value);
      }
      const at = buffered.indexOf("\n");
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      return JSON.parse(line) as WinReply;
    };
    proc.stdin.write(`${winHelperSourceLine()}${JSON.stringify({ id: 1, op: "snapshot", scope: "front" })}\n`);
    await proc.stdin.flush();
    const reply = await next();
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    const raw = reply.data as WinReplies["snapshot"];
    expect(raw.windows.length).toBeGreaterThan(0);
    expect(raw.windows.filter((w) => w.active).length).toBeLessThanOrEqual(1);
    const snap = fromUia(raw);
    const look = desktopLook(snap, desktopRefs());
    expect(look.screen.width).toBe(raw.screen[0]);
    expect(typeof look.snapshot).toBe("string");
    // An element of that look is found again by its process and runtime id; an unknown one is null.
    const app = snap.apps.find((a) => (a.nodes?.length ?? 0) > 0);
    const nodes = [...(app?.nodes ?? []).slice(0, 1).map((n) => [app?.bus, n.path]), ["uia:1", "0.0"]];
    proc.stdin.write(`${JSON.stringify({ id: 2, op: "extents", nodes })}\n`);
    await proc.stdin.flush();
    const extents = await next();
    if (!extents.ok) throw new Error(JSON.stringify(extents));
    const { boxes, windows } = extents.data as WinReplies["extents"];
    expect(Object.keys(boxes)).toHaveLength(nodes.length);
    expect(boxes["uia:1 0.0"]).toBeNull();
    expect(windows.length).toBeGreaterThan(0);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, 60_000);
});
