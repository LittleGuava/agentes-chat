# 0202. The person's own Chrome: an agent works, with the person's sign-ins, in a tab of its own in a Chrome they lend it

- Status: Accepted (2026-11-15; built: the runner and the wire, runner protocol 82. Run against a fake Chrome speaking the DevTools protocol on a loopback port (`apps/server/test/runner/fake-chrome.ts`), through the runner's request handler and through the desktop app's control channel; and against a throwaway headless Google Chrome 157 on Windows 11 (a new profile folder, port 0): lent by `/json/version` and by `DevToolsActivePort`'s path, a page opened and read, a redirect off the agent's sites blanked, listed and disconnected. Not yet run: a person's headed Chrome, a runner paired with a real server. Not built: the agent's tools, the server's audit rows, the apps' screens; see Later.)
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
- That includes the agents themselves. Outside system mode every agent's commands and computer brains run as the person's own OS user (ADR 0057 is what separates them), so any agent with commands on (`access.tools.commands`) on that computer can dial the port and speak raw DevTools to the whole browser, whether or not it was lent it. The tab of its own and the five methods hold only for the runner's path. This slice adds no guard against it: the port is open because the person opened it, before and apart from any lending. What the app must do about it (warn when commands are on for any agent, or refuse to lend then) is decided with the app's screen (Later).

## Later

- **The agent's tools** (engine): `my_chrome_open` and `my_chrome_read` in a tool source of their own, offered only to a run whose authority is the person who paired the computer and lent the Chrome (`authority.ts`; `drivesComputer`), never to a routine or an unattended run, never on another person's request, and only when that computer's runner is at protocol 82 or later. Page text through `untrustedBlock`. Each call a `tool.call` audit row (`agent-audit.ts`) with the host, and a team action (ADR 0064) for anything that changes a page.
- **Acting on the page**: click, fill and press in the agent's tab, through the screen layer (ADR 0054) as a `ScreenSurface` of its own (refs from an accessibility snapshot taken by the runner on that attachment), never a raw method. Typing a Vault login there (ADR 0144) needs its own decision.
- **The apps**: the desktop app's "Lend my Chrome" (agent, port, time; what it means, said plainly; the live session and Disconnect), the machine page on the web and the phone listing and ending sessions (`mychrome.list`, `mychrome.disconnect`), and a `hello` field so the apps know the runner can.
- **Finding the port**: reading `DevToolsActivePort` from a profile folder the person points at, instead of typing a port; how newer Chrome asks the person to allow debugging of a running browser, once checked.
- **Popups**: letting the agent follow a page its tab opened, attached only when its opener is the agent's tab.
- **A live view** of the agent's tab for people watching from the apps (`Page.startScreencast` on its attachment).
- **macOS and Windows specifics**: starting Chrome with a debugging port and a profile folder of the person's from the desktop app, with Chrome's own warning shown.
