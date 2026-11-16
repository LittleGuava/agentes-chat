# 0201. Host computer use: an agent on the person's own Windows or Mac desktop

- Status: Proposed (2026-11-15; built: the Windows helper and the runner's pure reading of its replies, §4–§7. Not wired: no runner serves it, no switch, no consent, no tools; §9 says what comes next)
- Date: 2026-11-15
- Extends: ADR 0062 (desktop computer use: the screen layer on a desktop, the helper's JSON lines, the tree as screen text), ADR 0058 (agent desktops, who drives a computer), ADR 0036 (switches on the machine, set only at the computer), ADR 0066 (the desktop app runs the runner), ADR 0027 (secrets and redaction)
- Changes ADR 0062 §3's last line ("Mac and Windows runners have none") once §3 below is built: until then it holds.
- Code: `apps/server/runner/desktop-helper-win.cs` (the helper), `apps/server/runner/desktop-helper-win.ts` (its command, request and reply types, `fromUia`, `winSteps`)

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

The runner keeps answering `desktopUse: { available: false }` on Windows and macOS (ADR 0062 §3) until §2 and §3 are built: the helper is reachable from no run.

### 8. macOS

The same shape with the Mac's APIs: the AX API (`AXUIElementCopyMultipleAttributeValues` per element, the system-wide element for the focused app, the window list from `CGWindowListCopyWindowInfo`), input with `CGEventPost`, captures with ScreenCaptureKit. macOS asks the person for Accessibility and Screen Recording per signed app, so the helper ships inside the signed desktop app (a small Swift program), not as source, and the app's onboarding asks for both with words for each.

### 9. Later

- The runner: `DesktopManager` serving host use (one helper for the computer, the switch and the session's consent checked on every request), `hello.desktopUse` saying `host: true`, and a protocol number for it.
- The engine: availability, the consent request card and its decision, the tools under ADR 0058's `desktop:use` for the pairer's own runs.
- The desktop app: the `hostDesktop` switch, the band and the tray while an agent holds the screen, Stop, and the stop on the person's own input (low-level hooks without the injected flag).
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
