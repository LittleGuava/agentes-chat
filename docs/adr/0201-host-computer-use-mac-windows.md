# 0201. Host computer use: an agent on the person's own Windows or Mac desktop

- Status: Proposed (2026-11-15; built: the Windows helper and the runner's pure reading of its replies, §4–§7. Wired on Windows on 2026-11-16, see the addendum: the switch, consent in the desktop app, the stop on the person's own input, protocol 81 and the tools for the pairer's own runs. macOS and the rest of §9 stay later)
- Date: 2026-11-15
- Extends: ADR 0062 (desktop computer use: the screen layer on a desktop, the helper's JSON lines, the tree as screen text), ADR 0058 (agent desktops, who drives a computer), ADR 0036 (switches on the machine, set only at the computer), ADR 0066 (the desktop app runs the runner), ADR 0027 (secrets and redaction)
- Changes ADR 0062 §3's last line ("Mac and Windows runners have none") once §3 below is built: until then it holds.
- Code: `apps/server/runner/desktop-helper-win.cs` (the helper), `apps/server/runner/desktop-helper-win.ts` (its command, request and reply types, `fromUia`, `winSteps`), `apps/server/runner/host-desktop.ts` (`windowsHost`, `HostConsent`), `apps/server/runner/desktop.ts` (`DesktopManager` with a host), `packages/engine/src/desktop/status.ts` (the host branch), the desktop app's `windows/Popover.tsx` (`ScreenRequestCard`, `ScreenBanner`) and `windows/prefs/Tools.tsx`

## Context

ADR 0062 lets an agent use a desktop of its own on a connected Linux computer: an Xtigervnc session per agent, read through AT-SPI and driven with xdotool, available only where the agent is its own OS user. People who run the desktop app on Windows or a Mac ask for something else: the agent working in the apps already open on their own screen, signed in as them (an accounting program, a desktop ERP, an app with no web version), while they watch.

That is a different screen with a different owner:

- There is no agent desktop to give: the screen is the person's signed-in session, the only one the computer has.
- There is no OS user to isolate the agent in. The runner on a person's own computer is single-user (ADR 0058 §10): it, its token and the agents' commands already run as the person.
- Windows and macOS have their own accessibility APIs and input paths, and macOS asks the person for permissions per app.

### Measured (Windows 11 Pro 26300, a 3440×1440 primary monitor and one more, 14 top-level windows; Windows PowerShell 5.1.26100, .NET Framework 4.8; a person's own session, read only)

| What | Result |
| --- | --- |
| Starting the helper: `powershell.exe` up, the source compiled by `Add-Type` (C# 5 with UIAutomationClient, System.Web.Extensions and System.Drawing), `hello` answered | 1.35–1.77 s |
| A look of what is in front (an Electron app in the foreground, 457 elements with the taskbars), one `BuildUpdatedCache` per window | 338 ms the first time, then 47–51 ms |
| The same look as screen text through ADR 0062's `desktopLook`, unchanged | 2–5 ms: 229 lines, 115 refs; no replacement character in the reply |
| Every window (12 apps, about 1,950 elements), read one window after another with 2 s each | 2.7–6.4 s, longer each time: a read that missed its time kept running, and the next look started another |
| Every window, all read at once under one 2 s deadline, a late read waited on again instead of doubled | 0.7–2.3 s; one or two Chromium windows past the deadline, said as `didn't answer` |
| A JPEG of the primary screen (3440×1440, q70) / a 480×300 region | 193 ms, 273–431 KB / 8–12 ms |
| The Start menu's shortcuts | 47–151 ms, 327 |

No action was sent to that desktop: the actions were run against the helper's dry mode (§6).

### Alternatives considered

- **A second desktop for the agent on Windows** (a hidden `CreateDesktop`, or a second session over RDP): apps run once per user and per session, so the person's signed-in apps aren't there; the reason to ask is the person's own apps.
- **Screenshots only** (providers' computer-use loops): a model turn per action and no exact targets. UI Automation and AX give names and boxes for most native apps, as AT-SPI does on Linux.
- **A compiled helper shipped with the runner** (a .NET or Rust executable): one more signed binary per architecture in the runner's release. Windows PowerShell 5.1 and .NET Framework 4.8 are on every Windows 10 and 11, and `Add-Type` compiles C# 5 at start in about a second. A shipped binary stays possible if the compile time or a locked-down machine (Constrained Language Mode, AppLocker) turns out to matter.
- **PowerShell code calling UI Automation directly**: correct, but a tree of a few thousand elements through PowerShell's pipeline and `ConvertTo-Json` takes seconds; the C# does the same work in the runtime.

## Decision

### 1. What it is

Host computer use is an agent using the person's own signed-in desktop on their own Windows (now) or Mac (later) computer, through the same screen layer as ADR 0062: the look as screen text, plans, targets in words, checks and reports. The agent's own Linux desktop (ADR 0062) is unchanged.

### 2. Where it can run

- Only on a computer that a person paired for themselves, in the runner's single-user mode, running in their own signed-in session: the desktop app's runner (ADR 0066). Never in system mode, never on the workspace's own computer, never on a computer that serves agents of people other than its pairer.
- Only for agents and runs that the computer's pairer (ADR 0058's `drivesComputer`) allowed, and only for runs that person asked for (ADR 0053's authority is that person). Routines, unattended runs and other people's runs don't get it in the first version.

### 3. Consent replaces the OS user

ADR 0062 §3 requires the agent's own OS user because a shared display would put every agent's secrets and the runner's token in reach. On a person's own computer the runner, its token and the agents' commands are already the person's; what host use adds is the person's screen and keyboard. So the guard is the person, every time:

- **A switch on the computer, off by default.** `hostDesktop`, set only in the desktop app on that computer, like ADR 0036's switches: the server can't turn it on.
- **Consent per session.** A run that needs the screen asks the computer's pairer in the conversation (a request card, decided only by that person); a yes holds for that run, at most 30 minutes, and ends with it.
- **Always visible, always stoppable.** While an agent holds the screen the desktop app shows it on the screen itself (a band at the top edge, the tray icon) with Stop. Any input of the person's own (mouse or keyboard events without Windows' injected flag, read by low-level hooks) pauses the agent at its next step, as ADR 0062's "a person took control"; Windows has no SIGUSR1, so the helper reads a stop from its own hook rather than a signal.
- **Never typing secrets.** As ADR 0062 §11: delivered secrets are never typed into a native app; sign-ins are the person's.
- **The locked screen and the secure desktop are never touched.** Windows refuses input to the secure desktop (UAC, Ctrl+Alt+Del, the lock screen) and to elevated windows from an unelevated process (UIPI). The helper sees the secure desktop (the input desktop isn't `Default`) and answers `unavailable`; UIPI drops the input without saying so (neither `SendInput`'s return nor its last error tells), so an elevated window in front is not detected yet (§9). The runner never runs elevated.
- **Audited.** Each session's start, end and who stopped it go to the audit log; each step goes on the message as ADR 0062 §11 says.
- Screen text stays untrusted and is redacted before it leaves the computer (ADR 0062 §4, ADR 0027).

### 4. The Windows helper

- C# 5 source (`desktop-helper-win.cs`) compiled by Windows PowerShell 5.1's `Add-Type` when the helper starts: nothing added to the runner's bundle or its release. The command is `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <bootstrap>`; a command line holds at most 32,767 characters, so the source goes as the first line of stdin, in base64, and the same reader then carries the JSON lines.
- It makes its process per-monitor DPI aware before any other call, so UI Automation's boxes, window rectangles, input and captures all speak physical pixels.
- **The look.** Windows from `EnumWindows` (visible, not cloaked by DWM, not minimized, with a size; boxes from DWM's extended frame bounds, without the invisible resize borders), bottom to top; the trees of the foreground window, the windows above it and the taskbars (`scope: "front"`), or of every window (`"all"`). One `BuildUpdatedCache` per window over the control view, with every property the look needs cached, then a walk of the cached children in memory: the analogue of AT-SPI's `GetItems` (ADR 0062 §4), never one cross-process call per element. The windows are read at once under one 2 s deadline, and each keeps at most 4,000 elements; a window past the deadline is `"didn't answer"` and found on the image only. UI Automation can't cancel a read, so one that missed the deadline is waited on again by the next look rather than started twice. Values are read only for edits, documents, combo boxes and spinners, capped (`textMax`), and never for password fields; an edit or a document with no value but a text pattern is read through it, live, at most 20 times a look.
- It keeps the elements of its last look, so `extents` and `fill` reach them again; one that is gone is `null` or `stale`.
- **The same protocol, with two differences.** Requests and replies are ADR 0062's: one JSON object a line, `{ id, op, … }` in and `{ id, ok, data }` or `{ id, ok: false, code, error }` out, the same ops (`hello`, `snapshot`, `extents`, `input`, `capture`, `apps`) and error codes, elements named by `[bus, path]` (`uia:<pid>` and the element's runtime id). The differences:
  - `snapshot` and `extents` answer with UI Automation's own facts (`UiaSnapshot`: control types, properties, patterns), which the runner turns into ADR 0062's `HelperSnapshot` with `fromUia`. The CI runs on Linux: the mapping is tested only where it is TypeScript, as ADR 0062 §9 keeps filtering and guards in the runner.
  - A key step goes as a chord of virtual-key codes (`{ keys: number[] }`), which the runner makes from ADR 0062's key names (`ctrl+s`, `Return`, `alt+F4`) with `winSteps`; every other step is ADR 0062's `HelperStep` as it is.
- **The mapping** (`fromUia`): control types become the AT-SPI role names `desktopLook` reads (Button → push button, a button with a toggle → toggle button, Edit → text or password text, CheckBox → check box, MenuItem → menu item or check menu item, TabItem → page tab, DataItem → list item, a Window inside another → dialog, Pane, Group and Custom → layout containers), properties become AT-SPI state bits (not off-screen → SHOWING, enabled → ENABLED and SENSITIVE, focus, toggle, expand and collapse, selection, a writable value → EDITABLE and the `EditableText` interface), each process is one app (`uia:<pid>`) whose windows sit under the root, and the taskbars are docks: ADR 0062's `desktopLook` then writes the person's desktop as screen text unchanged, refs, occlusion, escaping and redaction included.
- **Input** with `SendInput`: points as the cursor set and then the buttons; text as Unicode key events (`KEYEVENTF_UNICODE`), so any letter goes as typed with no clipboard (the reason ADR 0062 pastes on X11); `fill` through the value pattern, read back, `mismatch` when it differs; a window brought forward by its handle. A `SendInput` that takes fewer events than it was given is `failed`; one that UIPI drops looks taken (§3). The whole request is checked before any step runs: a malformed step does nothing.
- **Settling** waits for quiet for a fixed time, and for a new foreground window after a launch; DXGI's desktop duplication, which reports changed rectangles as XDamage does, is §9.
- `capture` is a JPEG of the primary screen or a region (GDI); `apps` lists the Start menu's shortcuts, and `launch` starts one by its id; `open` opens an absolute path with its app.

### 5. Where the screen is

The primary monitor, at (0, 0) in Windows' own coordinates. Windows on other monitors are outside the screen, and `desktopLook` leaves them out.

### 6. A dry mode for tests

Started with `dry`, the helper reads the desktop as usual but sends nothing: each input step is checked and answered with what it would have sent (event counts, never the text). Its tests on Windows run that way, so a test never clicks or types on a developer's own desktop.

### 7. Not available until it is wired

The runner keeps answering `desktopUse: { available: false }` on Windows and macOS (ADR 0062 §3) until §2 and §3 are built: the helper is reachable from no run. (Built on Windows: the addendum says how the host is told apart without changing this answer.)

### 8. macOS

The same shape with the Mac's APIs: the AX API (`AXUIElementCopyMultipleAttributeValues` per element, the system-wide element for the focused app, the window list from `CGWindowListCopyWindowInfo`), input with `CGEventPost`, captures with ScreenCaptureKit. macOS asks the person for Accessibility and Screen Recording per signed app, so the helper ships inside the signed desktop app (a small Swift program), not as source, and the app's onboarding asks for both with words for each.

### 9. Later

- ~~The runner, the engine and the desktop app's wiring~~: built on Windows, see the addendum.
- A session that ends with the run that asked for it (today it ends by its 30 minutes, Stop, the switch, the lock or the runner's end).
- The band at the screen's top edge, outside the app's own menu (today: the tray's dot, the menu's band and the notification).
- The web and phone apps saying the computer serves the person's screen (today: only the desktop app on that computer).
- Settling by DXGI desktop duplication's dirty rectangles; the screen re-checked by events (`StructureChanged`) instead of a fresh cache.
- Several monitors.
- An elevated window in front told apart before acting (its process can't be opened for its integrity level from an unelevated one), so input UIPI would drop is refused as `failed`.
- Windows that cover without drawing (transparent overlays, click-through layers) left out of the stack: today they count as covering, and what they lie over is left out of the look.
- The macOS helper (§8).
- An eval of Box and Choice on recorded Windows scenes (ADR 0062's `eval:desktop:micro`), with no person's data in them.

## Consequences

- An agent will be able to work in the person's own Windows apps with ADR 0062's screen layer, tools and reports, once §9's wiring is built.
- Nothing about the agent's Linux desktop changes; the Windows helper is a second implementation of its protocol, with the two differences in §4.
- The guard is the person's consent and presence, not an OS boundary: a person who says yes lets the agent act as them on their screen for that run.
- Starting the helper costs Windows PowerShell's start and a C# compile, about a second and a half, once per helper.
- Chromium and Electron windows are the slow ones, as on Linux: a look with one in front can take the whole 2 s the first time.

## Addendum (2026-11-16): wired on Windows

What §9 listed for the runner, the engine and the desktop app is built for Windows, with these decisions. macOS (§8) stays later.

### Protocol 81 and a field of its own

- The runner says it serves the person's screen in `hello.hostDesktop` (an availability, as `desktopUse`), not in `desktopUse`: `desktopUse` keeps meaning the agents' own Linux desktops and stays `available: false` on Windows (§7). An older server ignores the new field, and a server reading an older runner sees none: both fail closed. `MACHINE_PROTOCOL_VERSION` and `HOST_DESKTOP_PROTOCOL` are 81; the server keeps the field in `machines.executors.hostDesktop` (jsonb, no migration).
- `RunnerTools.hostDesktop` is the switch (§3), off by default. It is set only from the desktop app's control channel on that computer: the server's `access.allow` refuses it, and so does the CLI's `tools enable hostDesktop` (`APP_ONLY_TOOLS`), because a terminal command can be run by anything already running as the person, and the switch is the person's own decision in the app.
- The runner serves it only on win32, outside system mode, and only with a desktop app connected to its control channel (`mode === "app"`): without one there is nobody to ask, and the ask is refused at once.

### Consent in the desktop app, not in the conversation

§3 put the ask in the conversation as a request card. It is on the computer instead: the server can't answer it, a person can't answer it from another device, and the one who answers is the one in front of the screen. When a run first asks for the screen, the runner holds the request and the desktop app shows a card (Allow, Not now) in its tray menu, raises a notification and puts the dot on the tray icon; the agent's tool call waits for the answer, at most 90 seconds, then is refused with words the agent can say to the person. A yes is a session of that agent on the screen for at most 30 minutes; one agent holds the screen at a time, and another one's ask is refused while it does. The consent lives only in the runner's memory: a restart ends it.

### The server: only the pairer's own runs

`agentDesktopUseStatus` takes the run. On a computer whose `executors.hostDesktop` is available, at protocol 81 or later, not the workspace's own (`kind = managed`): the tools are offered only with the switch and Commands on, and only when the run's authority (ADR 0053) is a person who is the computer's pairer. A routine, an unattended run or another person's run gets nothing (`not_the_owner`), and a call made anyway reaches no computer. The tools are ADR 0062's `desktop_do`, `desktop_read` and `desktop_screenshot`, unchanged.

### The person's own input

The helper reads the person's mouse and keyboard with low-level hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`) on a thread of its own, skipping events with Windows' injected flag (its own `SendInput`). Input of the person's in the last 1.5 s, or during a request, stops that request's input where it is (`stopped`): the agent is told the person moved and may try again, and the session goes on. The click on Allow is the person's own input, so the runner tells the helper to forget it (`forget`) before the first action after a yes. Stop in the app ends the session at once and stops the helper.

The hooks are what antivirus software looks for in keyloggers: the helper keeps only the time of the last event, never which key, and runs only while a session needs it. A helper whose hooks were refused (an antivirus, a policy) says so in its hello (`watching: false`), and the runner then serves no screen at all, with words that say why: without the hooks the person's input couldn't stop the agent.

### Refusals

- Typing into a password field (the focused element, or a step's target by ref or point) is refused before any input, as is `fill` into one: secrets are the person's (§3).
- Keys that lock or leave the session (`super+l`, `ctrl+alt+Delete`, `ctrl+shift+Escape`) are refused, and the Start menu, the taskbar and Explorer's own windows join the session apps that ADR 0062 never acts on.
- A locked screen or the secure desktop (`unavailable`) ends the session, as Stop does.
- `desktop.text` (session screening, ADR 0076) is refused on the person's own screen.

### Audit

Each ask, yes, no, expiry and end (Stop, the switch, the lock, its 30 minutes) is a line in the computer's activity (`screen` entries, shown in the desktop app's Activity). Each call goes through the Tool Gateway like any other: `desktop_do` is a `tool.call` row in the workspace's audit log, and its steps go on the message (ADR 0062 §11).

### Verified, and not

Every test runs the helper in its dry mode (§6), and the runner's tests use a fake helper: no click, key or hook was sent to or set on a real desktop while building this. The hooks are compiled and started only outside dry mode, so a person's input stopping an agent is proven only through the helper's dry `person` op, and the whole flow only with fakes.
