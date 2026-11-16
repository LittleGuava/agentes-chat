# 0206. What an agent's computer reaches off loopback: private networks and metadata closed by the runner

- Status: Proposed
- Date: 2026-11-15
- Extends: ADR 0030 (isolation on connected computers, its level 2), ADR 0096 (the runner's nftables table),
  ADR 0101 (network options left to the deployment), ADR 0169 (containers' traffic is the agent's)
- Would amend: ADR 0101 ("the deployment must filter private destinations": the runner would do it on the host
  network) and ADR 0169 §6 and its Consequences ("no private range or metadata address (the operator's rules)")

## Context

Two kinds of code reach the network for an agent.

- **The server's own tools** (`web_fetch`, connectors, model endpoints, databases, email) go through
  `packages/engine/src/net-guard.ts`: a name is resolved once, every address it resolves to must be public
  (`isBlockedAddress`), and the connection goes to the address that was checked. A private, loopback, link-local or
  metadata address is refused, whatever name or redirect leads there.
- **An agent's computer** (ADR 0025) runs its brain's CLI (Claude Code, Codex, Cursor, Grok, Antigravity, OpenCode,
  Copilot), every command that CLI runs, the agent's Chrome (ADR 0040), its desktop and terminal (ADR 0058), its
  background tasks (ADR 0029) and its containers (ADR 0169). None of that goes through `net-guard`.

What holds on a computer today, by mode:

| | Loopback and the computer's own addresses | Local container and VM networks | Private ranges (LAN, VPC, tailnet) | Link-local and cloud metadata |
|---|---|---|---|---|
| System mode (ADR 0057), host network | Only the agent's own listeners, DNS and the listed services (ADR 0096) | Refused, but for what is published on the computer's other addresses (`agent_out`, bridges and veths that are not uplinks) | Open | Open |
| System mode with `networkLauncher` or `networkMark` (ADR 0101) | As above | As above | The deployment's job | The deployment's job |
| Single-user mode (the agent runs as the person who paired the computer) | Open | Open | Open | Open |
| macOS and Windows | Open | Open | Open | Open |
| agentes.chat Cloud | As system mode | As system mode | Its own guard (uid-keyed, outside core) | Its own guard |

ADR 0030's addendum and ADR 0101 left the filter of private destinations to the deployment: the runner names no
provider and a deployment with its own routing knows its networks better. ADR 0169 then wrote that an agent's
containers reach "no private range or metadata address (the operator's rules)". A self-hosted operator who installs
`--system` on a cloud VM and writes no rules has none: an agent on that computer reaches the provider's metadata
service and every address of its private network.

Brains with a sandbox of their own don't close this either. Codex's seccomp refuses every connection or none (its
turns run without the network, its background tasks with it); Cursor's, Grok's and Antigravity's sandboxes are about
their own tools, not about addresses (ADR 0169). The runner sets no address rule in any of them.

Isolation is per agent, not per turn. An agent's processes outlive a turn by design: background tasks, dev servers on
its own ports (ADR 0096), its desktop, its containers, its browser and its sign-ins. ADR 0030's level 2 (a process
sandbox per agent, bubblewrap or Seatbelt) is proposed and not built.

## Threats

What an attacker wants here is to make an agent reach something it was never meant to reach. The usual way in is
prompt injection (ADR 0117): a page, an email, an issue or a tool result that tells the agent to fetch an address. An
agent that runs code can open any socket; it doesn't need a tool built for it.

1. **Cloud metadata.** `169.254.169.254` (AWS, GCP, Azure, Oracle, DigitalOcean and others),
   `fd00:ec2::254` (AWS over IPv6), `100.100.100.200` (Alibaba) and `metadata.google.internal` hand out the VM's
   instance credentials, its user data (often secrets) and its identity. One request from an agent can turn into the
   operator's cloud account. This is the worst one, and nothing an agent legitimately does needs it: an agent that
   should act on a cloud gets a scoped key through `request_secret` or the Vault (ADR 0027, 0144), never the host's
   role.
2. **The private network.** A VPC's or a LAN's databases, admin panels, routers, a Kubernetes API, other servers'
   unauthenticated ports, a tailnet. On a person's own computer this is often the point (the dev server on
   `192.168.1.20`); on a server it is a pivot.
3. **The computer itself.** Already closed in system mode by ADR 0096, for loopback, the computer's own addresses
   and its local bridges. Listed so a new rule never reopens it.
4. **Names and redirects.** A public name that resolves to a private address, a redirect to one, a DNS answer that
   changes between check and connect (rebinding), and the same address spelled another way (IPv4-mapped IPv6,
   decimal, NAT64). A filter on names or URLs loses to these; a filter on the address the kernel connects to does
   not.
5. **Whatever bypasses a cooperative proxy.** A program that ignores `HTTPS_PROXY`, opens a raw socket, speaks a
   protocol that isn't HTTP (SSH, Postgres, Redis, QUIC over UDP) or sends WebRTC UDP goes around anything that only
   asks clients to use it.
6. **Work left behind across turns.** A process an injected turn starts keeps running after it (a task, a listener)
   and is there with the agent's next turn and its secrets. Per-agent isolation doesn't stop that; only a box per turn
   would.

Out of scope: data leaving to public addresses (ADR 0117's egress half), the code sandbox's network modes
(ADR 0021), the server's own `net-guard`, abstract Unix sockets between agents (ADR 0096 Consequences).

## Options

### A. Keep it in the deployment (today)

The runner keeps refusing loopback, local bridges and other agents (ADR 0096), and says nothing off loopback.

- **Covers:** whatever the operator writes. The Cloud already does it.
- **Cost:** nothing to build. A paragraph in `SELF_HOSTING.md` with an nft snippet would at least say it.
- **Against:** the default is open. Most self-hosted operators will never write the rules, and the threat they don't
  know about is the one that costs them an account. ADR 0169 already reads as if the rules were there.

### B. The runner's nftables table refuses them, keyed on the agent as ADR 0096 keys it

Add the rules to the chain that already holds every agent's new connections: `agent_out` in `inet agentes_runner`,
reached for a socket made in `agents.slice` or opened by an agent's uid outside it. The agent is told by the cgroup
its socket was made in, as in ADR 0096, so a setuid-root program an agent runs is still that agent, and a container's
traffic through pasta is its agent's (ADR 0169 §6). A host-network container whose user inside isn't root opens
sockets as a subordinate id from 65536 up, but still inside the agent's slice, so the cgroup match takes it too.

- **Covers:** every process of every agent in system mode on the host network, every protocol, TCP and UDP, every
  brain, Chrome, tasks, desktops and containers, by the address the kernel connects to. Names, redirects, rebinding
  and alternate spellings don't matter (threat 4). Nothing in a client can skip it (threat 5): agents hold no
  `CAP_NET_ADMIN` or `CAP_NET_RAW` (ADR 0101, 0169).
- **Doesn't cover:** single-user mode (the agent is the person; a rule on their uid would catch the person too, and
  the runner isn't root there), macOS and Windows, and traffic inside a namespace from `networkLauncher` (it never
  crosses the host's output hook; it is forwarded).
- **Cost:** small to build: one set per family, a few rules, the config below, cases in CI's `isolation-root` job and
  in the worker's start probe. Nothing at run time but a set lookup on each new connection. The real cost is
  breaking agents that use the LAN today, which the defaults below handle.
- **Sharp edges:** the resolver may be on a private or metadata address (AWS's `169.254.169.253` and the VPC's `.2`;
  on GCP the resolver is the metadata server itself, `169.254.169.254`; on Azure `168.63.129.16`), so resolvers are
  let through on port 53 only, never on 80. Azure's `168.63.129.16` is in a public range and serves more than DNS, so
  it goes in the metadata set by address. An endpoint the runner hands the CLIs (`ENDPOINT_ENV`: the proxy and base
  URL of an account) may be private; it is let through on its address and port, as the loopback table already does.
  In nftables an `accept` in one base chain doesn't stop another table's chain on the same hook while a `drop` is
  final, so the runner's refusal stands whatever a deployment's table accepts; the exemption for `networkMark`
  (ADR 0101) stays ahead of it, since a marked packet was already filtered by the deployment. An address let through
  that is itself a proxy (an account's endpoint, an operator's allowed host) reaches whatever that proxy reaches,
  metadata included: the kernel sees only the proxy's address. That is a known limit; a proxy the operator lets
  agents use is the operator's to filter.

### C. An egress proxy run by the runner

An HTTP `CONNECT` and SOCKS5 gate in the runner, one per agent, that resolves names itself and connects only to
allowed addresses; `HTTPS_PROXY`/`ALL_PROXY` in the agent's environment and `--proxy-server` with
`--proxy-bypass-list=<-loopback>` on its Chrome.

- **Covers:** works in single-user mode and on macOS and Windows; sees host names, so it could later enforce
  per-agent allow lists like the code sandbox's (ADR 0021) and count where an agent goes.
- **Doesn't cover, on its own:** anything that doesn't use it (threat 5). A variable is a request, not a wall: an
  agent that runs code opens a socket directly. For Chrome alone it holds, because the runner owns Chrome's flags and
  refuses an agent's own proxy flags (`FORBIDDEN_FLAGS` in `browser.ts`), but the agent's shell can still start
  another browser. It becomes a wall only inside a network namespace whose sole way out is the gate.
- **Cost:** large: a proxy to keep correct (CONNECT, plain HTTP, WebSockets, HTTP/2 over CONNECT, SOCKS UDP or no
  QUIC), authentication so other local users can't use it as an open relay, a hop on every request, and SSH, git
  over SSH and database clients broken unless each gets its own way through.

### Per turn

A box per turn (a mount, PID and network namespace for one turn's CLI and everything it starts, its only way out the
gate of option C) closes threat 6 and makes C a wall. It also ends at every turn what agents keep on purpose today:
tasks, dev servers other turns use, the desktop, containers and the browser. It is ADR 0030's level 2 with the
network part filled in, and fits agents that choose protected mode and unattended routines (ADR 0053), not every
agent by default.

## Decision (proposed)

B is the default wall in system mode; A stays the contract where the deployment owns the network; C is built only
as the single door of a namespace (a per-turn or protected-mode box) or for the managed browser in single-user mode,
never as a control on its own.

### Address sets, from one list

One list of ranges in `@agenteschat/adapters`, from which `net-guard`'s `isBlockedAddress`, the runner's
`publicAddress` (`runner/egress.ts`) and the nft sets are all derived, so the three never disagree. Today they
differ: `isBlockedAddress` refuses `192.0.0.0/16` and IPv6 multicast, `publicAddress` misses `192.0.0.0/16` and
reads only `2000::/3` as public IPv6. The list is the union of what both refuse now, so the server's guard gets no
looser and the runner's gets stricter. Two sets:

- **metadata**, never opened by any setting: `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200`
  (already in `100.64.0.0/10`, named for clarity), `168.63.129.16`;
- **private**: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `172.16.0.0/12`, `192.0.0.0/16`, `192.168.0.0/16`,
  `198.18.0.0/15`, `224.0.0.0/3` (multicast and reserved), `fc00::/7`, `ff00::/8`, `64:ff9b:1::/48`.

Loopback stays ADR 0096's. IPv4-mapped addresses leave as IPv4 packets and meet the IPv4 sets.

### What crosses the boundary

The runner's root-owned `config.json` (not an env var: it is the computer's, like `services` and `networkMark`):

```ts
interface RunnerConfig {
  // …existing fields
  /** Private destinations for agents off loopback (ADR 0206). Absent: "refuse" on a new install. */
  privateDestinations?: "refuse" | "allow";
  /** Opened even when private destinations are refused: "10.0.0.5", "192.168.1.0/24", "10.0.0.5:5432/tcp", "[fd12::1]:443/tcp". Never a metadata address. */
  allowDestinations?: string[];
}
```

`privateNetwork` is not reused: the runner already has it, meaning a launcher or a mark is configured.

`RulesetInput` (`loopback-guard.ts`) gains `refusePrivate: boolean`, `allow: string[]` (the parsed elements),
`resolvers: string[]` (the nameservers in `/etc/resolv.conf` that fall in either set, reloaded when it changes, as
the uplinks are) and the endpoints already read from `ENDPOINT_ENV`. `agent_out` gains, after the bridge rule and in
this order: resolvers on port 53 accept, the metadata sets refuse, the allow set and the endpoints accept, and the
private sets refuse when `refusePrivate`. Metadata comes before the allow set, so an allowed range that holds a
metadata address (a tailnet's `100.64.0.0/10` holds `100.100.100.200`) never opens it; parsing the config also
names such an entry in the runner's log.

The runner's `hello` (machine protocol, next protocol number) gains:

```ts
egressGuard?: { metadata: "refused" | "deployment" | "open"; private: "refused" | "allowed" | "deployment" | "open" };
```

`deployment` where `networkLauncher` is set (the namespace is the deployment's, ADR 0101); `open` in single-user
mode and on macOS and Windows. With `networkMark` and no launcher the agent is on the host network: the sets apply to
its unmarked traffic and `egressGuard` says what they do there, while marked traffic stays the deployment's, filtered
before it was marked (ADR 0101). The computer's page and `computer_status` say it in words, so an operator sees what is
open instead of reading this ADR.

### Defaults and upgrade

- Metadata is refused on every system-mode computer on the host network, new or upgraded. Nothing an agent does
  needs it; an operator who gave agents the instance role on purpose gives them a scoped key instead.
- Private destinations are refused on a new `--system` install. An upgrade writes `"privateDestinations": "allow"`
  into the config once, so no agent that uses the LAN today breaks silently; the computer's page shows it as open and
  links to the switch.
- Single-user mode, macOS and Windows stay open: the agent there is the person, on the person's own network.

## Phases

0. **Say it.** `SELF_HOSTING.md` states what is open today, with an nft snippet that refuses the metadata set to the
   agents' slice. No code; can ship before the rest.
1. **One list and the metadata wall.** The shared range list, `net-guard` and `publicAddress` read from it; metadata
   refused in `agent_out` with the resolver and endpoint exceptions; the worker's start probe checks that a
   connection from the agent to `169.254.169.254:80` is refused before any of its processes starts; new cases in
   `isolation-root` on both kernels, over IPv4 and IPv6, from the agent, a setuid-root copy, a rootless container and
   a host-network container; `hello.egressGuard`.
2. **Private destinations.** `privateDestinations`, `allowDestinations`, the upgrade step, the computer's page and
   `computer_status`, `SELF_HOSTING.md`.
3. **Inside a namespace,** only if a deployment asks: the runner loads the same chain in each agent's namespace
   (`nsenter --net`, as `account-check.ts` already reads counters there), with the deployment's say. The Cloud keeps
   its own guard either way.
4. **The managed browser in single-user mode.** A SOCKS5 gate per browser in the runner, Chrome launched through it
   (`--proxy-server`, `--proxy-bypass-list=<-loopback>`, `disable_non_proxied_udp`), metadata refused, private
   allowed by default. It guards the browser tools, not the agent's shell, and says so.
5. **A box per turn,** in its own ADR as ADR 0030's level 2 on Linux: bubblewrap with a network namespace whose only
   way out is the runner's gate, for agents in protected mode and for routines, saying up front what it ends at every
   turn.

## Consequences

- An agent on a self-hosted Linux computer in system mode can no longer read its cloud's metadata, whatever the
  operator wrote, and reaches the private network only where the operator says so.
- `SELF_HOSTING.md`, ADR 0101 and ADR 0169 stop putting the metadata filter on the operator for the host network.
- Agents that used private addresses on a new install fail with a refused connection; the computer's page, the
  probe's message and `computer_status` say which setting opens them.
- Single-user mode, macOS and Windows stay as open as today until phase 4, and then only for the browser.
- Threat 6 stays open until phase 5.
- The deployment keeps the namespaces it makes; the runner's table doesn't see inside them.

## Open questions

- `64:ff9b::/96`: on a NAT64 network it carries public IPv4, and a NAT64 that translates to private addresses is the
  network's fault. Left open in the private set; `net-guard` doesn't refuse it either.
- Whether any operator needs metadata opened for agents (an opt-in), against keeping it closed with no switch. The
  proposal is no switch.
- Whether the upgrade should write `allow` or stop and ask on the computer's page.
- Whether the list of metadata addresses outside link-local (`168.63.129.16`) is complete for the providers the
  docs name; checked on each before phase 1 ships.
