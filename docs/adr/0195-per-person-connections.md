# 0195. A connection can use each person's own account

- Status: Accepted (first slice: services through Composio)
- Date: 2026-11-15
- Code: schema `packages/db/src/schema/connectors.ts` (`connector_connections.per_person`, `connector_personal_accounts`,
  `oauth_states.for_person`); engine `packages/engine/src/connectors/personal.ts` (`setPerPerson`,
  `beginPersonalConnect`, `completePersonalConnect`, `disconnectPersonal`, `personalAccountFor`, `personalRefusal`,
  `dropAccountsOfLeaver`, job `connector.personal.forget`), `organizations.ts` (`removeMember`, `deleteAccount`),
  `connectors/mcp.ts` (a per-person connection's tools: `checkCall` and `execute`), `connectors/connections.ts`
  (`completeOAuth`, `revokeConnection`), `connectors/custom.ts` (`listCustomServers`: `perPerson`, `mine`),
  `workspace-deletion.ts` (`revokeGrants`); routes `apps/server/src/routes/app/connectors.ts`
  (`PUT …/connectors/{connectionId}/per-person`, `POST`/`DELETE …/connectors/{connectionId}/mine`); the viewer's own
  account as words `packages/client/src/lib/connected.ts` (`mineOf`, `mineText`, `connectsMine`); web
  `apps/web/src/components/Connectors.tsx`; phone `apps/mobile/src/features/connectors/ConnectionScreen.tsx`
  (`MineGroup`); tests `packages/engine/test/personal-connections.test.ts`

## Context

A workspace connects an app once (ADR 0016, 0099, 0107) and every call an agent makes through it goes as that one
account. That fits a team's shared Slack or a company Drive. It doesn't fit an app where each person has their own
account and wants an agent to work in it: "find the contract in my Drive", "what's on my calendar tomorrow". Today a
workspace can only connect one person's account and let every agent act in it for everyone, or connect nothing.

Other assistants let each member connect their own account, and a call goes through the account of whoever asked.
Here, "whoever asked" already has one answer: who is behind a run (ADR 0053, `authority.ts`). A run a person asked
for, directly or through a chain of agents, is that person's; a routine's run and an unattended run have nobody
behind them, and ADR 0053 §1 says a routine's run never acts as its creator.

## Decision

1. **A workspace connection may be per person.** `connector_connections.per_person` (default false). Someone who
   manages connectors turns it on for a connection; its tools, their classification, the agents' grants and the
   approval rules stay on the workspace connection, as they are. What changes is whose account a call goes through:
   never the workspace connection's own account, always the account of the person behind the run. The workspace
   connection's account is still used to list its tools.

2. **Each person connects their own account.** `connector_personal_accounts`: one live row per connection and person
   (`org_id`, `connection_id`, `owner_user_id`, the account at the provider, `account_label`, `status`, `last_error`,
   `revoked_at`; unique on connection and owner while live). Any member may connect their own account to a
   per-person connection ("Connect my account") and disconnect it; nobody else sees it beyond the account's name in
   their own listing, and nobody else can use it. Connecting again replaces it: the old account goes away at the
   provider.

3. **The Tool Gateway resolves the account from who is behind the run, before anything else happens.** A per-person
   connection's tools carry a `checkCall`, which the gateway runs before it asks anyone or runs anything
   (`checkToolCall`), and `execute` resolves it again (an approval may come much later). `personalAccountFor` reads
   the run's authority (`runAuthorityById`) and answers with the account or a refusal the agent reads:

   | Behind the run | Result |
   | --- | --- |
   | A person, still a member, with a live account here | The call goes through their account |
   | A person with no account here | Refused (`connector.personal_missing`): they must connect their own account in Settings › Connectors and MCPs |
   | A person whose account stopped working | Refused (`connector.personal_needs_reconnect`): they reconnect it there |
   | A routine's run | Refused (`connector.personal_routine`): a routine's run never acts as its creator (ADR 0053 §1) |
   | Nobody (unattended) | Refused (`connector.personal_nobody`): only a run a person asked for can use their account |

   A refusal is a tool result with `isError`, never an approval card: no one approves a call that can't run. The card
   and the tool's description name the service ("Google Drive"), not the workspace connection's name, which may hold
   another person's address.

4. **A person's account failing is that person's.** When the provider says a personal account stopped working, only
   that row is marked to reconnect; the workspace connection and everyone else's accounts keep working.

5. **What crosses the boundary.** The app API adds, on each custom server (`GET …/connectors/custom`), `perPerson`
   (boolean) and `mine` (`{ accountLabel: string | null, status: "active" | "needs_reconnect" } | null`: the caller's
   own account only). `PUT …/connectors/{connectionId}/per-person` takes `{ perPerson: boolean }` (managers of
   connectors; a connection that isn't through Composio is refused, `connector.per_person_unsupported`).
   `POST …/connectors/{connectionId}/mine` takes `{ returnTo? }` and answers `{ authorizeUrl }` (any member);
   the provider's return comes back through the existing OAuth callback and `oauth/complete`, whose state row says
   `for_person`, so the person finishing it needs no right to manage connectors, only to be the member who started
   it. It lands with `outcome=personal` (`oauth/complete` answers `personal: true`): the workspace got no new
   account, so the apps only say it connected. `DELETE …/connectors/{connectionId}/mine` disconnects one's own
   account. No secret ever reaches a client.

6. **Lifecycle.** Disconnecting the workspace connection, or turning per person off, drops every personal account of
   it at the provider (best effort, never revoking a shared grant, as ADR 0107 does). Deleting the workspace drops
   them with its other grants (`revokeGrants`). A person who leaves the workspace or is removed (`removeMember`), or
   deletes their agentes.chat account (`deleteAccount`, before the user row, whose deletion would take the rows and
   leave nothing here that knows the accounts), loses their own accounts and the sign-ins they started and never
   finished there (`dropAccountsOfLeaver`): the rows go in the same transaction, and a job
   (`connector.personal.forget`, no `org_id`, so it outlives a workspace deleted meanwhile) has Composio forget the
   accounts. Composio may be down: the job retries for about 30 days, and an account already gone there is no error,
   so the job running twice or dying halfway ends the same. Until then the gateway refuses the account anyway: its
   row is gone, and the person is no longer a member.

7. **First slice: services through Composio.** A personal account there is a Composio connected account made by a
   Connect Link under the workspace's Composio user (`org_<orgId>`), so its calls count against the workspace's
   monthly Composio cap like any other (ADR 0107 §7). Nothing about the account crosses to our database but its id
   and its name.

## Consequences

- An agent with a per-person connection does what each person can do in their own account, for that person only,
  and says clearly what's missing otherwise. A person's answer can still land in a shared channel if that's where
  they asked: the run replies where it was asked, as for any tool.
- A personal account runs within the agent's grants and approvals (ADR 0016, 0015): the agent's level of approvals
  and the tools' classification decide whether a call asks, as they do on the workspace account.
- A per-person connection is useless to routines until the decision below in Later is taken; a routine that needs a
  person's account fails with a clear refusal it can report through `hand_off`.

## Later

- **Routines with their creator's account.** ADR 0053 §1 forbids it today. A future decision may let a routine's
  creator allow it explicitly for one routine, as ADR 0144 §2 lets a routine use the Vault keys its creator allowed,
  with the same audit. That needs its own amendment of ADR 0053.
- **Per-person servers by address.** MCP servers with their own OAuth, and catalog connectors (GitHub), need the
  token refresh and its lock (`refreshing_until`) per personal row, and sealing bound to it. API keys per person too.
- **Per-person mailboxes.** Gmail and Outlook are mailboxes here (ADR 0038, `mail/accounts.ts`), not connectors: a
  mailbox per person is a decision of its own over that model (who reads, routines on received mail).
- **A sign-in finishing while its person leaves.** One that finishes in the instant of the removal may write its row
  after the removal's transaction. The gateway still refuses it (no member), and the workspace's deletion forgets it,
  but until then it stays at Composio. Checking membership under the `org-members` lock when the row is written
  closes it.
- **Composio's webhook and the reconcile tick** (`markComposioAccountBroken`, `reconcileComposioConnectors`) should
  mark and heal personal rows too; today a personal account is marked when a call fails and healed by reconnecting.
- **The phone's managers' switch.** On the phone everyone connects and disconnects their own account on the
  connection's screen; turning a connection per person (or back) is still done on the web or the desktop app.
- **Per-agent consent.** A person may want only some agents to use their account; today every agent the workspace
  granted the connection may, for the person who asked.
