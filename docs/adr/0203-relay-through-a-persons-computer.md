# 0203. Sites that refuse data centers open through a person's own computer

- Status: Accepted (2026-11-15; built: the protocol, the person's grant on their computer from the runner's command line and from the desktop app's Preferences › Sites, the tunnel on that computer, the pairing on the server, the agent's browser sending the granted sites through it and taking a new list, open tunnels closing when their site is removed, lenders that are away leaving the agent's list, and the web showing which computer lends which site (2026-11-16). Run on loopback sockets with fakes, and once with a real Chrome: Google Chrome on Windows 11 took the `data:` proxy script and sent `CONNECT jobs.example.com:443` to the entrance, whose tunnel reached an exit with a fake resolver and a site on 127.0.0.1, which got a TLS ClientHello. Nothing has crossed a running server and two runners yet; see "Not yet run")
- Date: 2026-11-15
- Extends: ADR 0025 (connected computers), ADR 0036 §8 (access lives on the computer), ADR 0040 (the agent browser), ADR 0058 §11 (data sockets), ADR 0101 (a computer's network)

## Context

Agents browse from the computer they work on. For the workspace's own computer, and for most self-hosted servers, that is an address in a data center. A growing set of sites answers those addresses with a wall: a sign-in that never finishes, a page of puzzles, "unusual traffic", or a plain refusal (job boards, some banks' portals, marketplaces, social networks). The same request from a home connection goes through.

Most workspaces already have such a connection at hand: a person paired their own computer (ADR 0025) and it sits on their home or office network. This decision lets a person lend that connection to the agents they choose, for the sites they choose, and nothing else.

What it must not become:

- A way into the person's network. The computer that lends its connection must never reach its own LAN, its router, its loopback or any private address for an agent.
- A general proxy. Only the sites the person listed, and only for the agents they listed.
- A window into the traffic. Neither the person's computer nor the server should be able to read what the agent does on the site.
- Something the server can turn on. As with folders and tools (ADR 0036 §8), the grant lives on the computer; the server only reads it, and can't widen it.

## Decision

### 1. The grant: per site and per agent, on the person's computer

`RunnerAccess` gains `relay`: a list of `{ site, agents }`, the same shape as a folder grant (`RunnerFolderGrant`), read by the same `grantedTo` (an agent's id, or `*` for every agent). `site` is a domain the person typed, normalized by `relaySite` (lower case, no scheme, path, port or trailing dot, at least two labels, letters, digits and hyphens only; never an IP address, `localhost` or a name under `.local`, `.internal`, `.home.arpa`, `.lan` and the like, which only a local network uses). A site covers itself and every name under it at a dot (`example.com` covers `www.example.com`, never `badexample.com`): `relayCovers`. At most `RELAY_LIMITS.sites` (50) sites per computer.

The person grants from the computer: `agentes-runner relay allow <site> --agent <id>` (or `--every-agent`), `relay remove <site> [--agent <id>]`, `relay list`. The agents that use a site lent here work on another computer, which this one's `agents` frame doesn't list, so an agent is named by its id (`relayAgentIds`; a handle works only for an agent listed here). It writes the runner's `config.json` like `folders` does, and a running runner reports it with `access.changed`.

The desktop app does the same from **Preferences › Sites**, beside Folders: add a site, pick who opens it through this computer ("Every agent" or agents by name, with the computer each works on), remove it. It asks its own runner over the control channel (`relay.add`, `relay.remove`, `relay.setAgents`; a name that isn't a public site is `invalid_site`), so the decision stays on the person's computer. The names come from the server: the `agents` frame carries `lendable`, the workspace's agents that work on another computer (at most `RELAY_LENDABLE_MAX`), only to a person's own `connected` computer outside system mode, and the runner hands that list to the app in its status. An app on a runner older than protocol 83 asks for an update instead. The server stores it in `machines.access` (a JSON column; no migration) and never sends a frame that adds to it: `access.reduce` keeps it, and `widens` counts it.

### 2. The way bytes go

Two runners and the server, no new listener anywhere a network can reach:

```
agent's Chrome ──PAC──▶ entrance (127.0.0.1, computer A) ══data socket══▶ server (pairs) ══data socket══▶ exit (computer B) ──TCP 443──▶ site
```

- **Computer A** (where the agent's browser runs) gets, in its `agents` frame, `relay`: the sites some other computer of the workspace grants that agent and could carry now (`MachineAgent.relay`; a lender that is offline, paused, on an older protocol or in system mode doesn't count, so its sites leave the list while it is away and the agent's Chrome opens them directly). When an agent has any, the runner starts its **entrance**: a TCP listener bound to `127.0.0.1` on a port the system picks, and starts that agent's Chrome with `--proxy-pac-url` set to a `data:` PAC script (`relayPac`) that sends those sites to `PROXY 127.0.0.1:<port>` and everything else `DIRECT`. Chrome reads that flag only at its start, so a running Chrome restarts on a new list, where it was and on the page it showed, once it is due (`relayRestartDue`): the script differs from the one it started with, the list held still and the agent left the browser alone for `RELAY_SETTLE_MS` (30 s), and nobody uses it now (a command queued, its start, a person watching). The browser's minute sweep checks it (`restartOnRelay`), so a lender that sleeps and wakes doesn't restart a Chrome twice in a row. The new list reaches A whenever it changes: a grant changes, a lender says hello, goes offline, is paused or resumed, or is removed (`publishMachineAgentsChanged`).
- For each connection, the entrance reads the head of the request (at most `RELAY_LIMITS.headBytes`, within `headTimeoutMs`), takes only `CONNECT <host>:443`, checks the host is one of the agent's sites, and sends `relay.want { callId, agentId, host }` to the server. Anything else is answered `403` and closed.
- **The server** checks that the agent belongs to the workspace and works on A (`agents.machine_id`), and picks a computer B (`pickRelay`): another computer of the same workspace, `connected` (paired by a person; never the server's own `host` computer nor the workspace's `managed` one), online on protocol 83 or later, not paused, not in system mode, whose stored `access.relay` grants that host to that agent. It mints two stream ids, asks B for `relay.open { streamId, agentId }`, and answers A `relay.ready { callId, ok: true, streamId }`, or `ok: false` with a code (`relay_none`, `relay_offline`, `relay_refused`). Both runners dial a data socket (ADR 0058 §11) naming their id; the stream broker hands sockets it doesn't know to `claim`, where the relay pairs the two and copies bytes between them. An id serves once, only from the computer it was minted for, and lapses after `pairTimeoutMs` unpaired; a tunnel ends at `tunnelBytes` either way, after `idleMs` with nothing sent, or when either socket closes.
- **Computer B** never listens. On `relay.open` it dials its data socket and reads, from that tunnel only, the head A forwarded: an HTTP `CONNECT`. It decides by its own access, never by what the server or A said: the host must be covered by a site granted to that agent here and the port must be 443. It resolves the host once, refuses unless every address it got is public (`publicAddress`, the same rule the network observation uses), connects to the first, answers `200 Connection Established` and copies bytes until either end closes. At most `RELAY_LIMITS.tunnels` (16) at once; a paused computer opens none.

Only port 443 goes through, so what crosses A's runner, the server and B is TLS between the agent's Chrome and the site: none of them sees a page, a cookie or a password. The site sees B's public address.

### 3. The wire (protocol 83, `RELAY_PROTOCOL`)

- `RunnerAccess.relay?: { site: string; agents: string[] }[]` in `hello.access` and `access.changed`.
- `MachineAgent.relay?: string[]` in the `agents` frame: only to a runner on protocol 83 or later.
- `lendable?: { id, handle, name, look?, machine }[]` in the `agents` frame, same rule: whom this computer may lend a site to (§1). The runner's control channel to the desktop app gains `relay.add`, `relay.remove` and `relay.setAgents`, and its status `lendable`.
- Runner → server: `{ type: "relay.want", callId, agentId, host }`. Server → runner: `{ type: "relay.ready", callId, ok: true, streamId } | { type: "relay.ready", callId, ok: false, error: { code, message } }`.
- Server → runner request: `{ op: "relay.open", streamId, agentId }`, answered `{ opened: true }` once the data socket is ready.
- The data socket's binary frames are the tunnel's bytes, nothing else.

The shared rules (`relayHost`, `relaySite`, `relayCovers`, `relaySitesFor`, `parseRelayGrants`, `relayPac`, `readConnectHead`, `RELAY_LIMITS`) live in `@agenteschat/adapters/machine-protocol`, so the runner, the engine and the tests use one copy.

### 4. Consent, abuse and personal data

- **Opt in, per site, per agent, revocable at the computer.** Nothing is lent until the person runs `relay allow`; removing a site stops new tunnels at once (B checks its own access on every `relay.open`) and closes the ones open for it: B's exits and A's entrance each keep their open tunnels and check them again on every change of the list (`recheck`), closing those no site covers any longer.
- **Abuse.** The site sees the person's address for what the agent does, so a misbehaving agent can get that address rate limited or blocked. The limits in §2 cap one tunnel and how many run at once; only the sites the person named go through; only port 443; never a private address. A person who lends their connection is answerable to their own provider for it, which is why the grant is theirs alone to make.
- **Who reaches the entrance.** It listens on loopback only, but on a single-user computer any process of the runner's user (an agent's shell commands too) can reach it, as it can reach that user's files. What it gets is the same as the agent's Chrome: a tunnel to the sites lent to the agent whose listener it is, decided again by the person's computer.
- **Personal data (LGPD, GDPR).** An IP address tied to a person is personal data. The person consents to lending it by granting at their computer, for named sites and agents. The server stores the grant (sites and agent ids) with the computer's access, as it stores folders, and logs no address, host or byte count per tunnel beyond the runner's own log. The workspace's administrators can see the grant as they see a computer's folders: the computer's page lists each site and who opens it through it, read only, since only the person changes it on their computer. Whoever sees an agent's computer on its page (its owner, administrators) sees which sites it opens through whose computer, and whether that computer is away (`GET …/agents/{id}/computer`, `relay`).

### 5. What changes where

- `packages/adapters/src/machine-protocol.ts`: `RELAY_PROTOCOL`, `MACHINE_PROTOCOL_VERSION` 83, the types and frames above, `parseAccess` reading `relay`, the shared rules.
- `packages/db/src/schema/machines.ts`: `MachineAccess.relay` (type only).
- `packages/adapters/src/runner-control.ts`: the control requests and `ControlStatus.lendable`. `apps/desktop/src/windows/prefs/Sites.tsx`: Preferences › Sites. `apps/web/src/components/Machines.tsx` (`SitesCard`) and `AgentComputer.tsx` (`AgentRelaySites`): the web's read.
- `apps/server/runner/access.ts`: `allowRelaySite`, `removeRelaySite`, `setRelayAgents`; `copy` and `widens` carry it; `parseAgents` reads the `agents` frame's `relay`. `main.ts`: `agentes-runner relay`.
- `apps/server/runner/relay.ts`: the exit (`serveRelayExit`, `RelayExits` for the count), the entrance (`RelayEntrance`) and its questions to the server (`RelayWants`). `handlers.ts`: `relay.open` (a `machine` op, refused in system mode). `connection.ts`: `relay.ready`. `daemon.ts`: both, on a single-user runner. `browser.ts`: the PAC flag in `chromeLaunchArgs`, read at each start of the agent's Chrome (`relayPac`), and the restart on a new list (`relayChanged`, `restartOnRelay`).
- `packages/engine/src/relay.ts`: `pickRelay`, `relaySitesOf` (ready lenders only), `withRelaySites`, `relayLendable`, `agentRelaySites`, `siteRelayHooks`, `createSiteRelay` (the want, the pairing behind `claim`), `siteRelayFromDb`. `machine-hub.ts`: `setRelayHooks`, `relay.want` frames, the `agents` frame's `relay` and its new copy when a computer's grant changes. `apps/server/src/engine.ts`: the broker's `claim` asks the browser's live view, then the relay. `apps/server/src/routes/machines.ts`: `MachineAccess.relay` in the API's description.

## Not yet run

- A page loaded end to end and the whole path across a running server and two runners (the Chrome check above stopped at the TLS handshake, on a site with no certificate for that name). The tests cover each piece on loopback sockets with a fake site: the exit and the entrance with an in-memory link and a real data socket to a loopback server, the pairing with fake sockets, and the hub on PGlite with two fake runners.
- Windows and macOS as B: the exit uses Node's own DNS and sockets, nothing platform specific, but it has only run in tests.
- The restart of a running Chrome on a new list and the runner's calls on a change of the list: the rule (`relayRestartDue`) and each end's `recheck` are tested, but no test drives the browser manager's `relayChanged`/`restartOnRelay`, nor the daemon calling `recheck` and `relayChanged` when a list changes.
- Preferences › Sites and the web's two lists have run in DOM tests, not on a real screen.

## Later

- System mode on A: the agent's Chrome runs as its own user under a worker, so the entrance must live in that worker and dial through root's data sockets.
- Several B computers for one site (today the first that grants it), and choosing the one whose owner asked.
- Per-person and per-day caps on bytes and tunnels, and an audit row per day of what each computer lent.
- The agent's own words: telling the agent, when a site fails, that a person could lend their connection for it, and a request card for it.
- Ports other than 443 (none until a site needs it).
- The web's computer page opening Preferences › Sites in the desktop app (it needs the app's list of tabs it may open), and the app's tab on the server's own `host` computer, where it shows no agents to lend to.

## Alternatives considered

- **A commercial residential proxy** behind an env var: cheaper to build, but it lends a stranger's connection, costs per gigabyte, and puts every page through a third party's TLS terminator or at least its logs. It can still come later as an adapter.
- **B listening on a port** reachable from A: needs the person's router opened or a VPN; the server's data sockets already reach every connected computer.
- **The server terminating TLS** to filter by URL: it would read every page and password. Filtering by host at the CONNECT is enough for the person's consent, and keeps the bytes opaque.
