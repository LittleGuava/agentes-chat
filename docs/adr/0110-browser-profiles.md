# 0110. Browser profiles: named, shared logins that agents are granted

- Status: Accepted (phase 1 built: single mode, the server, the web and the phone's list); amended 2026-11-15 (a
  person's own browser in their DM, see the addendum)
- Date: 2026-11-01
- Amends: ADR 0040 §4 ("one browser per agent" becomes "one own browser per agent, plus the profiles it is granted"), ADR 0057 (a system-mode runner refuses profiles until phase 2)
- Code: `packages/engine/src/browser/profiles.ts` (CRUD, grants, the turn, a person's control), `browser/tools.ts` (`browser_profile`, `runBrowserProfile`, the turn on every command, `profile_busy`, the lost-turn look), `browser/live.ts` (the live view keyed `profile:<id>`), `runs.ts` (`releaseProfileTurns`), `tools/permission.ts` (a profile as a `request_permission` unit), `apps/server/src/routes/app/browser-profiles.ts`, `apps/server/runner/browser.ts` and `handlers.ts` (`handleProfileBrowser`), `packages/adapters/src/machine-protocol.ts` (`BROWSER_PROFILE_PROTOCOL` 34), migration 0160, web `components/browser/BrowserProfiles.tsx` and the agent's browser dialog in `pages/agent/Work.tsx`, phone `ProfilesSection` in `MachineScreen.tsx` and `ProfileLoginScreen.tsx`

## Context

A workspace wants several agents to share one login (five bots on one company WhatsApp; WhatsApp links at most four devices, so each agent logging in on its own can't work). Letting an agent manage Chrome profiles itself on its desktop fails where it matters: in system mode another agent's profile is unreadable by design, nothing says which agent may use which login, and the fast `browser_*` tools only ever open the agent's own profile.

## Decision

1. **A profile is a workspace object on one computer** (`browser_profiles`: name unique among live profiles ignoring case, `machine_id` set once). Who may use it is a join table (`browser_profile_grants`, cascading with the agent and the profile), and each agent may have a default (`agents.browser_profile_id`; null is its own browser). A new profile is granted to nobody until chosen, and "all tools" never covers one.
2. **Permissions.** Any member sees the list (names and who may use each). Creating, renaming, choosing the agents and deleting take `manage_connectors`, and only for agents the person may edit (`manage_agents` or their own). Driving it (Fazer login, opening a site) also takes `control_computers`. Watching it live: its drivers and the owners of the agents granted it, never the person behind a run (a profile shows a whole account). An agent's owner chooses its default among the profiles it has and asks for another ("Pedir mais um perfil", a `browser_profile_request` inbox line for the people who grant), never grants one. The agent itself asks through `request_permission`, where each profile it lacks is a unit (`browser-profile:<id>`), decided by admins as every request is. Audit rows: `browser_profile.created`, `.renamed`, `.granted`, `.revoked`, `.default_set`, `.control`, `.deleted`.
3. **One driver at a time: the turn.** Every command in a profile takes or renews the turn (`held_by_run_id`, `held_by_agent_id`, `held_until`, `held_since`) in one UPDATE that also checks the grant. There is no cache: a revoke on any replica refuses the very next command. The turn lasts 2 minutes past the last command and ends with the run (`transitionRun` to a final state). Another agent's command waits up to 60 s (polling each second), then answers `profile_busy` with who holds it and since when; the waiting card says so (`agent.browser.waiting`). A revoke or a delete sends the run back to its own browser with the reason.
4. **A command whose run lost the turn is not run.** A run that held the profile before and finds that someone else took it since (`agent_runs.browser_profile_turn_at`, and `held_since` reset on a new holder) doesn't send its command: it looks at the page and answers with it, so an approved "send" never lands in another chat. A new turn also forgets what the run knew of the page.
5. **A person's control is the same turn.** Fazer login takes the turn for the person (`held_by_user_id`), from an agent too, never from another person, and starts the profile's Chrome. Watching renews it; Devolver ends it, and a person who left lets it lapse after 2 minutes. The live view, the input and the hand-back reuse the agent browser's machinery with the key `profile:<id>` in place of an agent's id (frames from the runner carry it), and the person's control reads as a take over in the same shape. No `browser_handoffs` row: the profile row is the record, and the audit row says who took it.
6. **One switch tool.** `browser_profile({ name })` (or `"own"`) sets the run's browser (`agent_runs.browser_profile_id` / `browser_profile_own`); every `browser_*` call then goes to that profile's computer and session. "What you can do" lists the agent's browsers by name. Files stay out in phase 1: `browser_upload` and `browser_screenshot` are refused in a profile, since its folder isn't the agent's.
7. **The runner keys sessions by profile.** A `browser.*` op with `profile: { id }` (protocol 34) runs in the session `profile:<id>`: one Chrome per profile in `<runner home>/browser-profiles/<id>`, outside every agent folder, with the existing warm start, idle stop, crash cleanup and command queue. A profile's Chrome is always headless (a desktop request is ignored and Browser on the desktop is refused): on an agent's display its own tools could read the shared account. Before a Chrome starts, stale `Singleton*` lock files are removed unless a Chrome this runner recorded still holds the folder, so a profile restored onto another computer opens. `browser.profile.delete` stops its Chrome and removes its folder. The desktop app's tray doesn't list profiles.
8. **Single mode only in phase 1, hidden elsewhere.** On a system-mode computer (every Cloud computer) the feature doesn't exist: no "Perfis do navegador" on its page (web and phone), no profile choice in the agent's browser dialog, no `browser_profile` tool or profile lines in the prompt, no chip, no grant through `request_permission`. Decided per computer from the mode the runner reported (`machines.executors.mode`, trusted from the first hello), so a workspace with both kinds shows profiles only on its single-mode ones. Behind the hidden UI the server refuses every profile call about such a computer (400 `browser_profile.system_mode`) and lists none of its profiles, and the runner refuses every op with a profile. "Atualize o computador" (a runner older than protocol 34) shows only on a single-mode computer. On a single-mode computer the grant decides which agents are offered a profile; an agent with a terminal runs as the same user and could reach the folder anyway, and the page says that too. Phase 2 gives each profile its own OS user (`ap-<id8>`), worker and port pair.

## Consequences

- A profile's Chrome counts toward the computer's live browser cap like an agent's.
- No fairness rule: a holder keeps the turn until its run ends or 2 idle minutes. A queue (or a "hand over after 5 minutes when someone waits") comes if a long holder starves others.
- Agents never answer an outside channel on their own: no always-open profile and no watcher. A routine a person set up ("every 5 minutes, answer the shop's chats") opens it when it runs.
- Left for later: phase 2 (system mode, a Cloud pin of the runner), uploads and shared screenshots in a profile, "Sair de todas as contas", backups of closed profiles, phone creation and grants, the profile chip on the phone's cards, a per-profile manager.

## Addendum (2026-11-15): signed-in sites, and "Sair" per site

A profile holds a whole account per site and nothing showed which. Its page now lists the sites the profile is signed in to, with **Sair** on each, so a person can drop one account (a WhatsApp linked by mistake, a test login) without deleting the profile and every other login with it.

1. **Protocol 68 (`BROWSER_SITES_PROTOCOL`).** Two ops, only with `profile: { id }` (the agent's own browser is refused, `bad_request`): `browser.sites` answers `{ sites: { site, cookies, storage }[] }`, and `browser.sites.forget` with `site` answers what it removed (`cookies`, `storage`) and the list after. Never a cookie's name or value, never what a site stored: only hosts and counts cross the wire. Both start the profile's Chrome when it isn't running (the browser switch must be on, as for any command) and take their place in the session's queue.
2. **What the runner reads, as measured on Chrome 157.** Cookies come from Chrome itself, on the runner's own DevTools socket (`Storage.getCookies` on the browser's target). What sites keep besides cookies (local storage, IndexedDB, caches, service workers) has no listing in DevTools: the origins come from the profile's `Default/WebStorage/QuotaManager` (its `buckets` table). Chrome keeps that database locked while it runs ("database is locked" right after it started), but not its bytes: the runner reads a copy of the file (and its journal), removed at once. Chrome removes an origin's row there when all of its data is cleared, so a site left by "Sair" leaves the list.
3. **A site is as wide as a real cookie.** A host belongs to the widest domain cookie (`Domain=`) that covers it (`accounts.google.com` under a `.google.com` cookie is `google.com`); a host-only cookie or an origin no domain cookie covers is its own site. No public-suffix list: nothing is grouped wider than the cookies themselves say. Ports and schemes don't split a site.
4. **Sair.** Every cookie of the site is deleted one by one (`Network.deleteCookies` on a tab's session, with its partition key when it has one), then every origin of the site with stored data is cleared (`Storage.clearDataForOrigin` with `all` on a tab's session: on the browser's target Chrome refuses it). Measured: both stay gone after Chrome quits and starts again. A tab still open on that site may write again; the page says the site is out only when the list after says so.
5. **Who, and the turn.** Listing and Sair take what driving the profile takes (`manage_connectors` with `control_browsers`, `requireProfileDriver`), never in a system-mode computer (the feature is hidden there, §8). The list is asked for when the person opens it, never with the profiles' list (each ask may start a Chrome). Sair is refused (409 `browser_profile.busy`) while an agent's run holds the turn or another person is in control; otherwise it takes the person's control for the moment it runs and gives it back. Audit row `browser_profile.site_signed_out` (`name`, `site`, `cookies`, `storage`). A computer older than protocol 68 says "Atualize o computador".
6. **Later:** the same list for an agent's own browser (its Browser dialog; in system mode the op runs in the agent's worker), "Sair de todas as contas", the phone's profile screen, and sessionStorage of tabs left open (gone when the tab closes anyway).

## Addendum 2026-11-15: a person's own browser in their DM

The agent's own browser is shared by everyone who talks to it, so a site one person signed in to in their DM opened
signed in for the next person who asked the agent to browse. In a DM, the agent's browser is now that person's own.

1. **When.** A run's browser commands go to a person's own browser of the agent when nothing else is chosen (no
   `browser_profile` switch to a workspace profile and no workspace profile as the agent's default, which still win:
   they are the workspace's deliberate shared logins), and the run is in the DM where that person is the one reader
   (`soleReader`) of an agent others may talk to as well (`audience_mode` other than `owner`). Who is behind the run
   doesn't matter: whatever the run reads goes to that one reader. Channels, group conversations, an agent only its
   owner talks to and the right hand (whose seats keep each person apart already, ADR 0175) keep what they had.
   `browser_profile({ name: "own" })` in such a DM is the person's own browser, never the agent's shared one.
2. **A personal row, not a grant.** It is a `browser_profiles` row with `agent_id` and `person_user_id` set (migration
   0302), one live row per agent, person and computer (partial unique index), made on the run's first browser command
   on the computer the agent's own browser would run on (a mission's computer gets its own, and neither removes the
   other), with `on conflict do nothing` for two first commands at once. Its
   name is the person's. It has no grant: the turn's statement accepts the row's own agent (`usableBy`), so it never
   reaches `agentBrowserProfiles`, the `browser_profile` enum, "What you can do", `request_permission`'s units or the
   workspace's list, and renaming, granting, choosing it as a default and deleting it answer not found. Workspace
   profile names stay unique among workspace profiles only. Everything else is a profile's: the runner session
   `profile:<id>` and its Chrome in the profile's folder (protocol 34), the turn, the live view keyed `profile:<id>`,
   and a person's control.
3. **Its person alone.** Watching and driving it (Fazer login, opening a site, the input, Devolver) take being that
   person, with `own_browsers` like their own seat (ADR 0175 §3); an admin, the agent's owner and whoever manages
   connectors are refused, since it holds that person's sign-ins. The run's card learns it from
   `GET …/runs/{runId}/personal-browser` (only for someone who reads the run's conversation, and only their own) and
   shows it as a profile the viewer may drive.
4. **What changes in a DM.** `browser_ask_person` doesn't open a take over there: the agent is told to tell the person
   what to do and that they use Fazer login on the card. A Vault login is checked there as in the agent's own
   browser, not against a profile's grantees. Files stay the agent's own, unlike a workspace profile's (§6): its
   commands carry `profile: { id, personal: true }` with the real `agent` (protocol 70), and the runner reads uploads
   and writes screenshots, PDFs and downloads in that agent's folder while Chrome and its sign-ins stay in the
   profile's. The runner learns that folder from the agent's commands and keeps it until it stops; the person's own
   Fazer login carries no agent, so a download they make before the agent's first command since the runner started
   lands in the profile's folder. The agent's folder is one for everyone already (its files were shared in the DM before), so nothing new crosses
   between people: only the sign-ins are kept apart.
5. **Where it can't be.** No row is made and the DM keeps the agent's own browser, exactly as before, where its
   Chrome would not be the person's alone or not the agent's in full: a system-mode computer (§8, every Cloud
   computer); a runner older than protocol 70 (its files would land in the profile's folder); and an agent whose
   Chrome shows on its desktop (`browserOnDesktop`: `desktop:use` on a computer that serves desktops, ADR 0058 §7).
   There the window would be on the agent's one desktop, which whoever watches or controls it sees and which
   `desktop_do` in any other person's run reads, so that person's signed-in window would reach everyone; a Chrome of
   one's own on the desktop needs a desktop per agent and person (the right hand's seats do that, ADR 0175), so such
   an agent keeps one shared, windowed browser in DMs, with no sign-in kept apart, and the card says nothing of a
   personal one. These change only with a setting or the computer (an update, the mode, `desktop:use`, the computer's
   desktop switch, its desktop becoming unavailable), not from one command to the next; when one does, the DM's
   browser changes with it and sign-ins don't follow, and a personal row stays, unused, until it applies again. Where the computer can't be read now (offline), the command
   waits or fails as the agent's own would, never falling back to the shared browser.

Later: the same in system mode (phase 2, or a seat-like OS user per agent and person as ADR 0175 gives the right
hand); the same for an agent whose Chrome is on its desktop (a desktop per agent and person); removing a person's browsers (rows and folders) when they
leave the workspace, delete their account or the agent leaves a computer; two runs of the agent in the same DM taking
turns instead of the second waiting (`profile_busy`), as in any profile; refusing a take over of the agent's shared browser asked from a
DM; a label for it in the apps instead of the person's name; the phone's card; warming it instead of the agent's own
Chrome when a DM run starts.
