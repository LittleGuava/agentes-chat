# 0187. An agent's own REST API, with a key per agent

- Status: Accepted
- Date: 2026-11-15
- Code: `packages/db/src/schema/agent-api.ts` and migration `0277_agent_api_keys.sql`; `packages/engine/src/agent-api.ts`
  (keys, the bearer gate, sending and reading a result); the waits shared with `/mcp` in
  `packages/engine/src/apps/tools.ts` (`waitForTask`); `apps/server/src/routes/agent-api.ts` (`/api/agents/v1/*`),
  `apps/server/src/routes/app/agent-api-keys.ts` (the keys' management API); tests `apps/server/test/agent-api.test.ts`;
  the card `apps/web/src/pages/agent/ApiCard.tsx` and the key's room in the apps `apps/web/src/pages/ChannelPage.tsx`
  (`useAgentKeyRoom`), tests `apps/web/test/agent-api-card.test.tsx`

## Context

A script, a CI job or another company's backend wants to ask one agent something and read its answer: "summarize
this ticket", "is the deploy safe?". `/mcp` (ADR 0119) already lets a person's AI app act as them, but it speaks
JSON-RPC and MCP's tool calls, needs a personal token that reaches every agent the person can talk to, and posts in
the person's own conversation with the agent. A plain HTTP call with a key that opens one agent and nothing else is
what such callers expect, and what other agent products offer.

## Decision

1. **A key belongs to one agent.** `agent_api_keys` holds it: the workspace, the agent, the person who created it,
   a name, the last four characters to tell keys apart, an expiry (30, 90 or 365 days, or none), when it was last used,
   and when and by whom it was revoked. The secret is `agk_` and 43 base62 characters, shown once, stored only as its
   sha256 (like ADR 0119 §5's tokens: enough for 32 random bytes, and it survives an `AGENTES_SECRET` rotation). The
   prefix is its own, so `/mcp` refuses an agent key and this API refuses `aga_`/`agp_`. At most 10 live keys per
   agent.

2. **Who manages it.** The agent's owner or anyone with `manage_agents` lists, creates and revokes its keys, and the
   creator must be able to talk to the agent (`canTalkTo`), or the key would be useless. A key with no expiry needs a
   sign-in in the last 10 minutes (403 `reauth.sign_in`), as a personal token does. Revoking is now, by the creator
   or anyone who manages the agent.

3. **Authority is the creator's.** A message sent with a key is posted as the person who created it, so everything
   downstream already knows who is behind the run (`authority.ts`: authorship is the proof, nothing new to trust):
   the run acts within the agent's permissions on that person's behalf, and approvals and questions go to them. On
   every call the key is checked again: the creator is still a member and their account is in use, the workspace is
   open (`workRefusal`), the agent exists, isn't archived or held (`standingRefusal`), the creator can still talk to
   it and still manages it. A refusal past authentication is 403 with the reason's code, never a silent success.

4. **A conversation of the key's own.** Each key has one private room (`kind = 'dm'`, `dm_key` `apikey|a:<agent>|k:<key>|u:<creator>`,
   created at its first message) whose members are the agent and the creator. What callers send never mixes with the
   person's own DM with the agent, and the agent's reply draws only on that room (plus what the agent knows anyway),
   so a key can't read the person's private conversation back through the agent. The creator is a member so the
   approval and question cards the run posts there are theirs to answer: an approval also on the Approvals page, and
   the result's `approval_url` links the card. The room is left out of the DM list (`listDms`), so it adds no unread
   count there. An agent's reply there doesn't ring the creator (`notifyMessage`): the caller reads it; the cards
   notify through their own flows as everywhere.

5. **The API.** On the main origin, under `/api/agents/v1`, bearer only (no cookie, no `Origin` check: a browser page
   holds no key), in the OpenAPI document with an `agentKey` bearer scheme.
   - `POST /api/agents/v1/{agent}/messages` with `{ "message": "…", "wait_seconds": 0–45, "idempotency_key": "…" }`.
     `{agent}` is the key's agent, by id or handle; any other agent answers like an unknown key (401), so a key can't
     probe the workspace's agents. The message is posted in the key's room with `meta.via` (`kind: "app"`, the key's
     name, `apiKeyId`; the agent reads "sent by X through <name>, an app connected to agentes.chat"), `meta.readOutside`
     (ADR 0117: the text comes from outside, so learning treats it as outside content), and the idempotency key as
     its `clientId` (the same key on the same API key sends once). Waits up to `wait_seconds` (default 30) for the
     run, through the same `waitForTask` as `/mcp`'s `send_to_agent`: at most 45 s, its slots per person, workspace
     and process shared with the apps the creator connected, ended when the caller hangs up. 200 with the result
     when the run reached a state to act on, 202 while it still runs.
   - `GET /api/agents/v1/{agent}/messages/{messageId}?wait_seconds=` reads a result, waiting the same way. Only a
     message this key sent (its room and its `meta.via.apiKeyId`, both set by the server); anything else is 404.
   - The result: `message_id`, `status` (`done`, `waiting_approval`, `waiting_input`, `failed`, `canceled`,
     `no_run`, `still_running`), `reply` (`id`, `text` cleaned of hidden characters and capped at 8,000 characters,
     `truncated`, `attachments` by name and link, `url`), `approval_url`, `detail`, `error`, `poll_after_seconds`
     or `retry_after_seconds`, and `conversation_url`.
   - Errors in the API's own JSON shape (`{ error: { code, message } }`): 400, 401 `agent_api.unauthorized` (with
     `WWW-Authenticate: Bearer`), 403 with the refusal's code, 404, 413 (the body cap), 429 with `Retry-After`.

6. **Limits.** Per address before the key is read, 120 a minute. Per key, 60 requests a minute and 2,000 a day;
   sending, 20 a minute and 500 a day. A message is at most 20,000 characters. Waits share `/mcp`'s slots, so a busy
   script can't hold more of the server than the person's own apps could; past them the answer is `still_running`
   with `retry_after_seconds` at once.

7. **Audit.** `agent_api.key_created`, `agent_api.key_revoked` (a system actor with a reason when the server
   revoked) and `agent_api.message_sent`, each with the key's name (`details.app`), the agent and the key's id;
   Configurações › Auditoria says them in words. Never the secret.

8. **When a key ends by itself.** The creator leaving the workspace, and a password reset (or an email change
   undone), revoke their keys with their apps and tokens (`revokeMemberApps`, `revokeUserApps`). The agent deleted
   (rows cascade) or archived (refused at the call). Expiry is checked at every call; revoked and expired rows are
   purged 30 days later with the apps' hourly cleanup (`purgeApps`).

9. **Self-host parity.** On in every edition, no new environment variable: the API is wherever the server is.

## Later

- The key's card on the phone (the web's is in the addendum below).
- A per-workspace switch for the API, if owners ask for one (like ADR 0119 §12, default-allow, every send audited).
- A conversation per call (or a thread per call, chosen with a `conversation` field), for callers that want
  unrelated requests kept apart.
- Streaming the reply (SSE) for callers that want words as they come.
- Confining what a run started through a key may do (fewer tools than the person's own run), if keys end up handed to
  people the creator wouldn't trust with their own access.

## Addendum 2026-11-16: the key's card and its room in the web app

1. **The card.** Configurações on the agent's page has "API do agente" for whoever manages the agent (the same rule
   as §2): its live keys by name, the secret's last four, who made each and when, the expiry and the last use, never
   a secret; "Criar chave" with a name and how long it lasts, the secret then shown once in a dialog that closes only
   after a copy (or asks first), with the `curl` ready to paste with that secret; "Revogar" after a confirmation; and
   a `curl` with a placeholder for the secret under the list.
2. **The address is the server's.** `GET …/agents/{agentId}/api-keys` answers `{ keys, endpoint }`: `endpoint` is
   `PUBLIC_URL` with `/api/agents/v1/{agentId}/messages`, by the agent's id so a rename of its handle never breaks a
   script that pasted it. The page's own origin isn't used: behind a proxy or in development it isn't the address a
   script reaches.
3. **The room opens where its links already point.** `conversation_url`, a reply's `url`, a notification and "Copiar
   link" all name the room as `/org/{org}/c/{channel}`, and the channel page found nothing there (a `dm` room outside
   both lists). Rather than a route of its own and every link rewritten, the channel page asks
   `GET …/agent-key-rooms/{channelId}` when a channel is in neither list, and opens the room as the agent's
   conversation, its line saying it is the key's ("Conversa da chave de API …"). The answer is the agent, the key and
   its name, only for the key's maker (the room's only person): anyone else, an admin included, gets 404, as a DM is
   nobody else's to read (ADR 0151). A revoked key's room stays readable to its maker by the name the key had.
4. **From the card.** Each key lists `roomId`, the room's channel once a message was sent with it, only for the
   viewer's own keys; its row's menu then has "Abrir conversa". A key nobody used has no room, so nothing to open.

## Consequences

- A script can talk to one agent with one key, in plain HTTP, as the person who made the key: no MCP client, no
  token that reaches every agent.
- The key is as powerful as its creator's access through that agent: whoever holds it reads what the agent can read
  for that person, through its replies. The card has to say so, and the audit log and the room show every call.
- All calls with one key share its room: what earlier calls said is in the context of later ones, and a message sent
  while the agent still works on the one before joins that run, so two calls at once can get one answer between
  them. Callers with unrelated requests at once use one key each until a conversation per call exists.
- One more room per key; the DM list hides them, so a person with many keys sees no clutter, and finds a key's
  conversation through its row on the agent's page, a card's link or `conversation_url` (addendum §3, §4).
- A channel address that is neither a channel nor a DM of the person costs one more request before "not found": the
  lookup of a key's room.
