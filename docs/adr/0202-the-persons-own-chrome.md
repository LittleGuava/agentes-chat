# 0202. The person's own Chrome: an agent works, with the person's sign-ins, in a tab of its own in a Chrome they lend it

- Status: Accepted (2026-11-15; built: the runner and the wire, runner protocol 82. Run against a fake Chrome speaking the DevTools protocol on a loopback port (`apps/server/test/runner/fake-chrome.ts`), through the runner's request handler and through the desktop app's control channel; and against a throwaway headless Google Chrome 157 on Windows 11 (a new profile folder, port 0): lent by `/json/version` and by `DevToolsActivePort`'s path, a page opened and read, a redirect off the agent's sites blanked, listed and disconnected. Not yet run: a person's headed Chrome, a runner paired with a real server. The guard, the agent's tools and the apps' screens: see the addendum of 2026-11-16.)
- Date: 2026-11-15
- Extends: ADR 0025 (connected computers), ADR 0036 (access lives on the machine; the control channel), ADR 0040 (the agent browser), ADR 0133 (agents' browsers on Google Chrome)
- Amends: ADR 0133's "the person's own Chrome profile is never read or changed", which stays true of every agent's own browser; this ADR adds a separate way in, only by the person's hand, described below

## Context

An agent's browser has its own profile on the computer (ADR 0040, 0133): a person who wants it signed in to a site signs it in there, through the live view or the desktop. Some sites make that hard or wrong: a bank or an internal tool behind a device check, a sign-in with a hardware key, a session the person doesn't want copied into another profile. What the person has is their own Chrome, already signed in. They want to lend it to an agent for a while, to fetch something ("my orders this month", "the invoice on the supplier's portal"), and watch it do it.

That Chrome holds everything the person is signed in to. Whatever reaches it reaches their mail, their bank and their work accounts, so the decision is mostly about what may never happen:

- No agent may reach it without the person deciding so, on that computer, at that moment, for that agent.
- An agent may never see or drive the person's own tabs, read their cookies or storage, or list what they have open.
- A computer shared by agents' OS users (system mode, ADR 0057) has no "person's Chrome" to lend: anything there is reachable by every agent's user.
- The person must be able to see what happened and end it at any time.

Chrome's side: Chrome is reached with the DevTools protocol on a debugging port. Chrome 136 stopped honouring `--remote-debugging-port` on the default profile folder (Google's "Changes to remote debugging switches to improve security", 2025): debugging needs `--user-data-dir` pointing elsewhere, whose cookies are encrypted with another key. So a person who lends Chrome by port lends a Chrome started on a profile folder of their own choosing, signed in there; their default profile stays out of reach this way. Whether and how newer Chrome lets a person allow debugging of the browser they already have open was not checked for this ADR and is not relied on.

## Decision

### 1. Lending: the person, on the computer, through the desktop app only

The person starts Chrome with remote debugging on a loopback port and, in the desktop app on that computer, lends it to one agent for a time. The app sends the runner `mychrome.connect` on its control channel (ADR 0036 §3: stdin of the runner it spawned, no socket, no port): the agent, the port, the minutes (1 to 480, `MY_CHROME_MAX_MINUTES`), and optionally the browser endpoint's path when Chrome serves no `/json/version` (the second line of its `DevToolsActivePort`).

- Only a runner the desktop app started (`agentes-runner app`) can be lent a Chrome: a runner running as a service (`agentes-runner start`) has no control channel, so nothing lends it one.
- The server has no op that connects one. It can list (`mychrome.list`) and end (`mychrome.disconnect`), never start: as with folders and tools (ADR 0036 v0.2), the server can only reduce what the machine allows.
- One agent per Chrome at a time; lending to a second agent is refused until the first is disconnected. Lending again to the same agent replaces its session, only once the new Chrome answered as one: a wrong port leaves the session it had. Who holds a Chrome is checked again right before a session is kept, so two lent at once can't both get it.
- Nothing is written to disk. The consent lives in the runner's memory and ends when its time runs out (a timer, and a check on every use), when the person disconnects, when the server disconnects it, when Chrome closes, and when the runner stops or restarts.
- Never in system mode: `connect` and every `mychrome.*` op are refused there (`not_allowed`). The ops are routed to the root process (`OP_ROUTES` `machine`), never to an agent's worker, and refused before anything else.

### 2. Only the loopback, only a person's Chrome

- The runner dials `ws://127.0.0.1:<port><path>` and nothing else. The path is read from `/json/version`'s `webSocketDebuggerUrl` (only its path: whatever host it names is ignored) or given by the app, and must be a browser endpoint (`/devtools/browser/<id>`); a page's endpoint is refused before anything is dialed.
- The port of a Chrome this runner started for an agent or a browser profile (ADR 0110) is refused (`BrowserManager.ownPorts`): lending it would hand one agent another's browser.
- Whatever answers must say it is Chrome or Chromium (`Browser.getVersion`), or the connection closes.

### 3. A tab of its own, and a closed vocabulary

The runner speaks the DevTools protocol to that Chrome itself (`apps/server/runner/my-chrome.ts`), never through `agent-browser`: `agent-browser` attaches to the first tab it finds (ADR 0040 §19), which here would be one of the person's.

- The first page opens a new tab in a window of its own (`Target.createTarget` with `newWindow`), so the person's windows never change under them, and the runner attaches to that tab alone (`Target.attachToTarget`, flat). Every page command goes on that attachment.
- The runner sends five methods and no others: `Browser.getVersion`, `Target.createTarget`, `Target.attachToTarget`, `Page.navigate`, `Runtime.evaluate`. It never lists targets (`Target.getTargets`, `setDiscoverTargets`, `setAutoAttach`), never reads cookies or storage, never activates or closes one of the person's tabs. The tests hold this: every command the fake Chrome receives is checked against the five, every attachment against a tab the runner created, every session id against an attachment the runner made, and no parameter ever names the person's tab.
- The agent never sends a method or a script. `Runtime.evaluate` runs one fixed expression of the runner's own (the page's ready state, address, title and, for `read`, its visible text, capped at `MY_CHROME_TEXT_MAX`).
- A page that tab opens (`window.open`, a link with `target=_blank`) is the person's: the runner never attaches to it, and the agent can't drive it.
- A tab the person closes is forgotten (`Target.detachedFromTarget`): the next `open` makes a new one.
- Disconnecting closes the connection and leaves the agent's tab where it is: it is in the person's browser, and may show something they want to keep.

### 4. What an agent may do: `mychrome.act`

Protocol 82, on behalf of the request's agent, only while the person lent that agent a Chrome:

- `{ kind: "open", url }`: only `http:` and `https:` (`file:`, `chrome:`, `javascript:`, `view-source:`, `data:` and the rest refused, as `isWebPage` decides for the agent browser), only on the agent's sites (`allowedDomains`, the agent browser's own `domainAllowed`). The page is checked again once it loaded: a redirect off the agent's sites blanks the tab (`about:blank`) and is refused without reading it. Answers the address and title it ended on.
- `{ kind: "read" }`: the agent's tab's address, title and visible text, checked against the agent's sites first (a page that moved off them on its own isn't read). The text is the page's, untrusted: the engine wraps it in `untrustedBlock` like any page text (ADR 0117).
- Actions run one at a time per agent. A paused computer refuses them (`NEW_WORK_OPS`); listing and disconnecting still go and are never refused for room (`PEOPLE_OPS`).

### 5. What the person sees

Each step is a line of the computer's activity log (`kind: "access"`), which the desktop app shows: lent, opened `<host>`, read `<host>`, refused `<host>` and why, ended and why. Only hosts, never paths or queries (an address may carry a token), never page text.

### 6. Wire

`packages/adapters/src/machine-protocol.ts`: `MY_CHROME_PROTOCOL = 82`, `MyChromeAction`, `MyChromeTab`, `MyChromeSession` (agent, port, Chrome's product line, connected and expiry times, the agent's own tabs), ops `mychrome.act` (`action`, `allowedDomains`), `mychrome.list`, `mychrome.disconnect` (`agentId`, or all), and their replies. `packages/adapters/src/runner-control.ts`: `mychrome.connect`, `mychrome.list`, `mychrome.disconnect`. The server never sends `mychrome.*` to a runner below protocol 82 (a gate for the tools of Later).

## Consequences

- A person can let an agent use sites as themselves without copying a sign-in into the agent's profile, and end it at once.
- The person's default profile isn't reachable this way (Chrome 136): the Chrome they lend runs on a profile folder they chose and signed in to. That is the safer shape, and the one this ADR builds on.
- An agent using the person's Chrome acts as the person on those sites. Everything an agent does there carries the person's name, so the consent is per agent, per time, on the computer, and every step is in the activity log.
- The person's Chrome, started with a debugging port, is reachable by any program the person runs as themselves on that computer for as long as it runs that way, ours or not. That is Chrome's own property; the app must say so when it asks (Later).
- That includes the agents themselves. Outside system mode every agent's commands and computer brains run as the person's own OS user (ADR 0057 is what separates them), so any agent with commands on (`access.tools.commands`) on that computer can dial the port and speak raw DevTools to the whole browser, whether or not it was lent it. The tab of its own and the five methods hold only for the runner's path. The guard against it is the addendum's §8.

## Addendum (2026-11-16): the guard, the agent's tools and the apps

### 8. The guard: no lending while any agent here may run programs

Outside system mode, an agent that may run programs runs them as the person, and a program the person runs reaches the debugging port with no tab of its own. Refusing to lend only while *another* agent has commands on isn't enough: the agent lent the Chrome could dial the port itself. So:

- The runner refuses `mychrome.connect` (`not_allowed`, before dialing anything, and again right before a session is kept) while Commands or any coding CLI switch (Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Copilot) is on in that runner (`myChromeGuard` in `daemon.ts`). The coding CLIs count because each runs commands of its own in the agent's folder even with Commands off. The control channel gains the code `not_allowed`.
- Turning one of them on while a Chrome is lent gives it back at once ("given back: an agent here may run programs now").
- A runner knows only its own switches, and each organization on the computer has its own runner, whose agents run as the same person. The other half is the desktop app's, the parent of every runner that can be lent a Chrome (§1): Lend stays off while any organization's runner has one on (Commands is each one's own switch), and when a runner's access shows one of them newly on, however it went on (Preferences, a new pairing's first tools, the web), the app sends every runner `mychrome.disconnect`. That is the one place every runner's access reaches the app (`DesktopStore`, on `access.changed` and each status).
- Every agent's own browser is kept off a lent Chrome's port (`BrowserManager.lentPorts`, `reachesLentChrome`): `http://127.0.0.1:<port>/json/list` would list the person's tabs and their DevTools endpoints, with a site list or without.
- Not covered, and said in the app's ⓘ: any other program the person runs while Chrome listens on a port. That is Chrome's own property (Consequences).

A narrower guard (only an agent other than the lent one) was rejected for the reason above. A stronger one (lending only in system mode, where agents are separate OS users) isn't possible: in system mode there is no person's Chrome to lend (§1).

### 9. Who holds it reaches the server

`hello.myChrome` (always said at protocol 82, empty when nothing is lent) and the frame `mychrome.changed` (the whole list, after a lending starts or ends) carry agent ids and expiry times only (`parseMyChromeLent`: never a port or an address). The hub keeps them in `machines.executors.myChrome` (`storeMachineMyChrome`, no migration). A hello without it (an older runner) drops what was kept. The machine view shows it as `myChrome` only while the computer answers, outside system mode, and only lendings that haven't ended.

### 10. The agent's tools

`my_chrome_open` (`url`) and `my_chrome_read`, under `browser:use`, in their own tool source (`packages/engine/src/browser/my-chrome.ts`), sending `mychrome.act` with the agent's own sites (`browserAllowedDomains`). They are offered, and checked again on every call (`myChromeLending`), only while all of these hold:

- the agent's computer is at protocol 82 or later, not in system mode, and connected by a person (`pairedByUserId`);
- that computer says this agent holds the lent Chrome until a time still ahead;
- the run's authority (`runAuthorityById`) is a person, and that person is the one who connected the computer: never a routine's run, an unattended run, or a run another person started.

The page's text reaches the model inside `untrustedBlock` (`my_chrome:<host>`). Each call is a `tool.call` audit row, written by the Tool Gateway like every built-in browser tool (area `browser`), with the person behind the run, and never the page's text. `my_chrome_read` only looks (`LOOKS_ONLY`). `my_chrome_open` asks first for an agent that always asks, since a page opened signed in as the person can act. They have no row of their own on the access page: they go on and off with Browser (`UNLISTED_TOOLS`).

### 11. The apps

- Desktop app, Preferences › Tools › Your Chrome (`LendChrome.tsx`): the agent (from the runners that can lend: an older runner, `bad_request`, or one in system mode, `not_allowed`, is left out), the port, the minutes, Lend; each lending with its end time and port, and Disconnect. While a program switch is on, only why (`lendBlockers`).
- Web, the agent's fact sheet: a row "Lent browser" with whose it is and until when (`lentChromeUntil`), for whoever sees the agent's computer.

## Later

- **The phone and the machine page**: listing and ending lendings there (`mychrome.list`, `mychrome.disconnect` through the server).
- **A team action** (ADR 0064) for a page opened in the person's Chrome, once the agent can act on pages there.
- **Acting on the page**: click, fill and press in the agent's tab, through the screen layer (ADR 0054) as a `ScreenSurface` of its own (refs from an accessibility snapshot taken by the runner on that attachment), never a raw method. Typing a Vault login there (ADR 0144) needs its own decision.
- **The apps**: the desktop app's "Lend my Chrome" (agent, port, time; what it means, said plainly; the live session and Disconnect), the machine page on the web and the phone listing and ending sessions (`mychrome.list`, `mychrome.disconnect`), and a `hello` field so the apps know the runner can.
- **Finding the port**: reading `DevToolsActivePort` from a profile folder the person points at, instead of typing a port; how newer Chrome asks the person to allow debugging of a running browser, once checked.
- **Popups**: letting the agent follow a page its tab opened, attached only when its opener is the agent's tab.
- **A live view** of the agent's tab for people watching from the apps (`Page.startScreencast` on its attachment).
- **macOS and Windows specifics**: starting Chrome with a debugging port and a profile folder of the person's from the desktop app, with Chrome's own warning shown.
