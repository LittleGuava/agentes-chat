import {
  HELPER_ROOT_PATH,
  type HelperApp,
  type HelperAppEntry,
  type HelperBox,
  type HelperErrorCode,
  type HelperNode,
  type HelperNodeRef,
  type HelperRegion,
  type HelperReplies,
  type HelperSettle,
  type HelperSnapshot,
  type HelperStep,
  type HelperWindow,
} from "./desktop-helper";
import HELPER_SOURCE from "./desktop-helper-win.cs" with { type: "text" };

/**
 * The Windows desktop helper (ADR 0201 §4): `desktop-helper-win.cs`, C#
 * compiled by Windows PowerShell 5.1's `Add-Type` when it starts, reading the
 * person's desktop through UI Automation and sending input with `SendInput`.
 * It speaks ADR 0062's JSON lines (the same envelope, ops and error codes),
 * with two differences: `snapshot` and `extents` answer with UI Automation's
 * own facts, which `fromUia` turns into the `HelperSnapshot` that
 * `desktopLook` reads, and a key step is a chord of virtual-key codes, which
 * `winSteps` makes from the X key names the screen layer uses.
 *
 * Nothing serves it yet: the runner keeps desktop use off on Windows until
 * the person's switch and consent exist (ADR 0201 §7).
 */

/**
 * `powershell.exe … -Command <bootstrap>`: the command that starts a helper.
 * Windows PowerShell 5.1 is on every Windows 10 and 11; `-NoProfile` keeps the
 * person's profile scripts out. A command line holds at most 32,767
 * characters, so the source goes on stdin's first line (`winHelperSourceLine`)
 * and the same reader then carries the requests. With `dry`, it reads the
 * desktop and sends nothing to it (ADR 0201 §6).
 */
export function winHelperCommand(options: { dry?: boolean } = {}): string[] {
  const bootstrap = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$r=New-Object IO.StreamReader([Console]::OpenStandardInput(),(New-Object Text.UTF8Encoding $false))",
    "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.ReadLine()))",
    "Add-Type -TypeDefinition $s -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase,System.Drawing,System.Web.Extensions",
    `exit [AgentesDesktop.Helper]::Run($r,${options.dry ? "$true" : "$false"})`,
  ].join(";");
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    bootstrap,
  ];
}

/** The helper's source as the first line of its stdin: base64, so no character of it ends the line early. */
export function winHelperSourceLine(): string {
  return `${Buffer.from(HELPER_SOURCE, "utf8").toString("base64")}\n`;
}

/** A top-level window, as `EnumWindows` and DWM have it. */
export interface UiaWindow {
  /** Its handle: what `activate` takes. */
  hwnd: number;
  /** Its place in the stack, 0 at the bottom. */
  stack: number;
  /** The foreground window. */
  active: boolean;
  topmost: boolean;
  /** `WS_EX_TOOLWINDOW`: kept off the taskbar. */
  tool: boolean;
  /** Its window class (`Notepad`, `#32770`, `Shell_TrayWnd`…). */
  className: string;
  /** Its process's name, without `.exe`. */
  process: string;
  title: string;
  pid: number | null;
  /** DWM's extended frame bounds: what it covers, without the invisible resize borders. */
  box: HelperBox;
}

/** An element of a window's control view, from one `BuildUpdatedCache`. */
export interface UiaNode {
  /** Its runtime id, joined with dots. */
  id: string;
  /** Null for the window's own element. */
  parent: string | null;
  /** Its index among its parent's children; -1 for the window's own element. */
  index: number;
  children: number;
  /** The control type's name (`Button`, `Edit`, `MenuItem`…). */
  type: string;
  name: string;
  box: HelperBox | null;
  offscreen: boolean;
  enabled: boolean;
  focused: boolean;
  password: boolean;
  /** The patterns it supports: Invoke, Value, Text, Toggle, ExpandCollapse, SelectionItem. */
  patterns: string[];
  /** An edit's, a document's, a combo box's or a spinner's value, capped. Never a password field's. */
  value?: string;
  /** The value pattern's read-only flag, when it has one. */
  readOnly?: boolean;
  toggle?: "on" | "off" | "indeterminate";
  expand?: "collapsed" | "expanded" | "partial" | "leaf";
  selected?: boolean;
}

/** A process's windows read, or why they weren't: "didn't answer" (2 s), "no tree". */
export interface UiaApp {
  pid: number;
  name: string;
  nodes?: UiaNode[];
  error?: string;
}

export interface UiaSnapshot {
  /** The primary monitor in physical pixels; its top left is (0, 0). */
  screen: [width: number, height: number];
  /** Bottom to top. */
  windows: UiaWindow[];
  apps: UiaApp[];
  ms: number;
}

export interface WinHello {
  /** Null when Windows gives no screen size. */
  screen: [width: number, height: number] | null;
  /** UI Automation answers. */
  a11y: boolean;
  /** No event-driven settle yet (ADR 0201 §9). */
  damage: false;
  runtime: string;
  /** Per-monitor DPI aware: boxes, input and captures all in physical pixels. */
  dpiAware: boolean;
  /** The secure desktop (lock screen, UAC) is in front: nothing to read or act on. */
  locked: boolean;
  dry: boolean;
  missing: string[];
  problem?: string;
}

/** ADR 0062's steps, with a key as a chord of virtual-key codes (`winSteps`). */
export type WinStep = Exclude<HelperStep, { key: string }> | { keys: number[] };

export interface WinRequests {
  hello: Record<string, never>;
  snapshot: { scope?: "front" | "all"; textMax?: number; skip?: number[] };
  extents: { nodes: HelperNodeRef[] };
  input: { steps: WinStep[]; settle?: HelperSettle };
  capture: { region?: HelperRegion; quality?: number };
  apps: Record<string, never>;
}

export interface WinReplies {
  hello: WinHello;
  snapshot: UiaSnapshot;
  extents: { boxes: Record<string, HelperBox | null>; windows: UiaWindow[] };
  /** `sent` only in dry mode: what each step would have sent, never its text. */
  input: { ms: number; settled?: boolean; changed?: boolean; sent?: string[] };
  capture: HelperReplies["capture"];
  apps: HelperAppEntry[];
}

export type WinOp = keyof WinRequests;

/** ADR 0062's reply envelope and error codes, with the Windows helper's data. */
export type WinReply<K extends WinOp = WinOp> =
  | { id: number; ok: true; data: WinReplies[K] }
  | { id: number | null; ok: false; code: HelperErrorCode; error: string };

const DOCKS = new Set(["Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);
const DESKTOPS = new Set(["Progman", "WorkerW"]);
/** Popups whose app's tree says what they show, like X11's override-redirect menus. */
const POPUPS = new Set(["#32768", "Xaml_WindowedPopupClass", "Microsoft.UI.Content.PopupWindowSiteBridge"]);
const TOOLTIPS = new Set(["tooltips_class32"]);

function typesOf(w: UiaWindow): string[] {
  if (DOCKS.has(w.className)) return ["dock"];
  if (DESKTOPS.has(w.className)) return ["desktop"];
  if (TOOLTIPS.has(w.className)) return ["tooltip"];
  if (POPUPS.has(w.className)) return ["popup_menu"];
  if (w.className === "#32770") return ["dialog"];
  return ["normal"];
}

/** Windows as ADR 0062's `HelperWindow`: the handle as its id, the class and process as its WM_CLASS. */
export function fromUiaWindows(windows: readonly UiaWindow[]): HelperWindow[] {
  return windows.map((w) => {
    const types = typesOf(w);
    return {
      xid: w.hwnd,
      stack: w.stack,
      active: w.active,
      override: types[0] === "popup_menu" || types[0] === "tooltip",
      class: [w.className, w.process],
      title: w.title,
      pid: w.pid,
      box: w.box,
      types,
    };
  });
}

/** Control types as the AT-SPI role names `desktopLook` reads (ADR 0201 §4). */
const ROLES: Record<string, string> = {
  Button: "push button",
  SplitButton: "push button menu",
  CheckBox: "check box",
  RadioButton: "radio button",
  ComboBox: "combo box",
  Edit: "text",
  Document: "document text",
  Hyperlink: "link",
  Image: "image",
  List: "list",
  ListItem: "list item",
  DataItem: "list item",
  DataGrid: "table",
  Table: "table",
  Calendar: "table",
  Menu: "menu",
  MenuBar: "menu bar",
  MenuItem: "menu item",
  ProgressBar: "progress bar",
  ScrollBar: "scroll bar",
  Slider: "slider",
  Spinner: "spin button",
  StatusBar: "status bar",
  Tab: "page tab list",
  TabItem: "page tab",
  Text: "label",
  ToolBar: "tool bar",
  AppBar: "tool bar",
  ToolTip: "tool tip",
  Tree: "tree",
  TreeItem: "tree item",
  Header: "panel",
  HeaderItem: "column header",
  TitleBar: "title bar",
  Separator: "separator",
  Thumb: "separator",
  Pane: "panel",
  Group: "grouping",
  SemanticZoom: "panel",
  Custom: "unknown",
};

/** AT-SPI state bits (`AtspiStateType`), as `desktopLook` reads them. */
const BIT = {
  CHECKED: 4,
  EDITABLE: 7,
  ENABLED: 8,
  EXPANDABLE: 9,
  EXPANDED: 10,
  FOCUSED: 12,
  MULTI_LINE: 17,
  SELECTED: 23,
  SENSITIVE: 24,
  SHOWING: 25,
  INDETERMINATE: 32,
} as const;

function roleOf(n: UiaNode): string {
  const toggles = n.patterns.includes("Toggle");
  if (n.type === "Window") return n.parent === null ? "frame" : "dialog";
  if (n.type === "Edit") return n.password ? "password text" : "text";
  if (n.type === "Button" && toggles) return "toggle button";
  if (n.type === "MenuItem" && toggles) return "check menu item";
  return ROLES[n.type] ?? "unknown";
}

function statesOf(n: UiaNode, writable: boolean): [number, number] {
  const on: number[] = [];
  if (!n.offscreen && n.box && n.box[2] > 0 && n.box[3] > 0) on.push(BIT.SHOWING);
  if (n.enabled) on.push(BIT.ENABLED, BIT.SENSITIVE);
  if (n.focused) on.push(BIT.FOCUSED);
  if (n.toggle === "on" || (n.type === "RadioButton" && n.selected)) on.push(BIT.CHECKED);
  if (n.toggle === "indeterminate") on.push(BIT.INDETERMINATE);
  if (n.expand === "collapsed" || n.expand === "expanded" || n.expand === "partial") on.push(BIT.EXPANDABLE);
  if (n.expand === "expanded" || n.expand === "partial") on.push(BIT.EXPANDED);
  if (n.selected) on.push(BIT.SELECTED);
  if (writable) on.push(BIT.EDITABLE);
  if (n.type === "Document") on.push(BIT.MULTI_LINE);
  let low = 0;
  let high = 0;
  for (const bit of on) {
    if (bit < 32) low |= 1 << bit;
    else high |= 1 << (bit - 32);
  }
  return [low >>> 0, high >>> 0];
}

function nodeOf(n: UiaNode): HelperNode {
  const writable = n.patterns.includes("Value") && n.readOnly === false;
  const ifaces = ["Component"];
  if (n.patterns.some((p) => p === "Invoke" || p === "Toggle" || p === "ExpandCollapse" || p === "SelectionItem")) {
    ifaces.push("Action");
  }
  if (n.value !== undefined) ifaces.push("Text");
  if (writable) ifaces.push("EditableText");
  return {
    path: n.id,
    // The window's own element sits under the app's root, as an app's windows do on AT-SPI.
    parent: n.parent ?? HELPER_ROOT_PATH,
    index: n.index,
    children: n.children,
    role: roleOf(n),
    name: n.name,
    states: statesOf(n, writable),
    ifaces,
    ...(n.box ? { box: n.box } : {}),
    // Never a password field's value, whatever the helper sent.
    ...(n.value !== undefined && !n.password ? { text: n.value } : {}),
  };
}

/** The bus an element is named by: its process (`HelperNodeRef[0]`). */
export const uiaBus = (pid: number) => `uia:${pid}`;

/** UI Automation's facts as ADR 0062's snapshot: each process an app, its windows under the root. */
export function fromUia(raw: UiaSnapshot): HelperSnapshot {
  const apps: HelperApp[] = raw.apps.map((a) => ({
    bus: uiaBus(a.pid),
    pid: a.pid,
    name: a.name,
    ...(a.nodes ? { nodes: a.nodes.map(nodeOf) } : {}),
    ...(a.error ? { error: a.error } : {}),
  }));
  return { screen: raw.screen, windows: fromUiaWindows(raw.windows), apps, ms: raw.ms };
}

/** X key names (ADR 0062's `key` steps) as Windows virtual-key codes. Case doesn't matter. */
const KEYS: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  control_l: 0x11,
  control_r: 0x11,
  alt: 0x12,
  alt_l: 0x12,
  alt_r: 0x12,
  shift: 0x10,
  shift_l: 0x10,
  shift_r: 0x10,
  super: 0x5b,
  super_l: 0x5b,
  super_r: 0x5c,
  win: 0x5b,
  return: 0x0d,
  enter: 0x0d,
  kp_enter: 0x0d,
  tab: 0x09,
  iso_left_tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  page_up: 0x21,
  prior: 0x21,
  page_down: 0x22,
  next: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  space: 0x20,
  menu: 0x5d,
  print: 0x2c,
  // The US layout's keys; another layout puts other characters on them.
  minus: 0xbd,
  equal: 0xbb,
  comma: 0xbc,
  period: 0xbe,
  slash: 0xbf,
  semicolon: 0xba,
  apostrophe: 0xde,
  bracketleft: 0xdb,
  bracketright: 0xdd,
  backslash: 0xdc,
  grave: 0xc0,
};

function vkOf(name: string): number {
  const lower = name.toLowerCase();
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase().charCodeAt(0);
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (f) return 0x6f + Number(f[1]);
  const vk = KEYS[lower];
  if (vk === undefined) throw new Error(`no Windows key for "${name}"`);
  return vk;
}

/** ADR 0062's steps for the Windows helper: key names become chords, the rest go as they are. Throws on a key it can't name. */
export function winSteps(steps: readonly HelperStep[]): WinStep[] {
  return steps.map((s) => ("key" in s ? { keys: s.key.split("+").map(vkOf) } : s));
}
