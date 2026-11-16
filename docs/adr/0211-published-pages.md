# 0211. Publishing a page to a public address

- Status: Accepted (first slice built)
- Date: 2026-11-15
- Extends: ADR 0019 (an agent's page runs apart from the app), ADR 0157 (sharing a file stays inside the workspace),
  ADR 0015 and 0173 (approvals), ADR 0053 (who is behind a run)
- Code: config `PUBLISHED_PAGES_URL` (`packages/config/src/schema.ts`, checked in `loadConfig`); schema
  `packages/db/src/schema/published-pages.ts` (`published_pages`); engine `packages/engine/src/published-pages.ts`
  (`publishPage`, `unpublishPage`, `listPublishedPages`, `publishedPageHtml`, `createPublishedPageToolSource`);
  `artifacts.ts` (`pageHtmlAt`); `limits.ts` (`PUBLISHED_PAGES_MAX`); `tools/run-policy.ts` (`publish_page` in
  `ELSEWHERE`); `access.ts` (under `drive:write`); server `apps/server/src/http/published-pages.ts`
  (`publishedPages`, `PUBLISHED_PAGE_CSP`), `http/front-door.ts` (`frontDoor`, from `start.ts`), `app.ts`, `routes/app/published-pages.ts`; client
  `api/queries.ts` (`usePublishedPages`, `useUnpublishPage`), `lib/approval-words.ts`, `lib/activity.ts`; web
  `components/artifacts/PublishedPageSection.tsx` in `ShareDialog.tsx`; migration `0291_published_pages.sql`

## Context

Agents make pages (`create_artifact` of kind `html`): a report, a small calculator, a landing draft. People asked to
show one to someone outside the workspace: a client, a friend, a reviewer with no account. Sharing a file (ADR 0157)
only widens who inside the workspace sees it, by design, and a downloaded `.html` has to be sent and opened by hand.

A page an agent wrote is untrusted (ADR 0019): it may have been led astray by something it read. Inside the app it
runs in a sandboxed frame with no network. On a public address it would run as a top-level document that anyone
opens, so the address it runs on decides what it can reach.

## Decision

### 1. Off unless the server names an origin of its own for pages

`PUBLISHED_PAGES_URL` turns it on: the base URL pages are served from, such as `https://pages.example.net`. Unset
(the default): no tool, no route, no section in the apps. The server refuses to boot when its host is
`PUBLIC_URL`'s host. A page served on the app's own origin would run with the app's cookies one `fetch` away, and a
policy can't stop a script from navigating the top window to an address that carries what it read
(`location = …`): on the app's origin that is phishing under the product's own name. A host of its own, ideally on a
registrable domain of its own (not a subdomain sharing the app's cookies), keeps a page out of every session.

The same server answers both hosts (the reverse proxy keeps the `Host` header), and it splits them by host:

- the pages host answers `GET`/`HEAD` on `/p/<token>` and `/p/<token>/` and nothing else, a plain 404 for every
  other path, `/api/*` and the WebSocket upgrades included: `Bun.serve`'s front door (`http/front-door.ts`) sends
  it to the HTTP app before any socket is opened, and native mode (`ownHostsOnly`) counts it as one of its names;
- the app's host answers 404 on `/p/*`, never the page.

### 2. What a page's answer carries

Every page is served as `text/html; charset=utf-8` with:

- `Content-Security-Policy`, sent as a header so nothing in the page can remove it: `sandbox allow-scripts
  allow-forms` (no `allow-same-origin`: every workspace's pages share one origin, and none reads another's
  storage), the policy pages have inside the app (`default-src 'none'`, inline scripts and styles, `data:`/`blob:`
  pictures, media and fonts, `form-action 'none'`, `base-uri 'none'`), and `frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `X-Robots-Tag: noindex`, `Cache-Control: no-store` (a revoked page stops at once) and never a `Set-Cookie`.

A page is self-contained, as every page an agent writes already is ("inline every script, style, image and font").

### 3. A page is one Drive file at one version

`published_pages` (`org_id`, `artifact_id`, `version`, `token`, who published it and in which run, who revoked it
and when). A page shows the version that was approved, not the file's latest: an `update_artifact` after the
approval never goes public by itself. Publishing the same file again moves its page to the new version and keeps
its address, so running it twice ends in the same state. A revoked page's address never comes back; publishing
the file again gives a new one.

The token is 32 random bytes in base64url: the address is the only thing that finds a page. Only an `html` file
(`create_artifact` of kind `html`, `untrusted` by birth) is published.

The address answers the same 404 for an unknown token, a revoked page, a file in the trash or gone, and a
workspace that is suspended, held or being deleted (`openOrg`): which of them it is would say something about a
workspace to anyone holding an old link.

### 4. The agent's tool asks a person

`publish_page` (scope `drive:write`), listed only when the server has `PUBLISHED_PAGES_URL`:

- input `artifact_id` and `version`, both required: the approval card names the version, and the call that runs
  after "Aprovar" publishes that version, whatever the file became in between;
- `sensitive`: it asks the agent's owner and administrators, as other actions that leave the workspace. At the
  approvals level `never` it runs without a card (ADR 0173, amended 2026-11-12: `never` is absolute). The audit
  row and the page's row say who and which run;
- "Aprovar sempre" keeps the tool for that agent, as for every built-in tool that asks (ADR 0173 §11): kept
  by target only for a connected app's tool today (`rememberKinds`), so one rule then covers every page the
  agent publishes, still each for a person who asked and who reads the file;
- refused, at every level, to a run nobody is behind (a routine's, the agent's own, one outside text woke): the run
  policy refuses it like `share_artifact`. The person behind the run must read the file where it lives or through
  its sharing, so a page never shows what the person who asked can't see;
- the answer gives the address, which the agent passes on.

### 5. Limits

Publishing writes no bytes, so storage limits (ADR 0079) don't move: the page reads the version already stored.
A page is never larger than a page file may be (`ARTIFACT_LIMITS.htmlBytes`, 2 MB), and `PUBLISHED_PAGES_MAX` keeps
a workspace at 100 live pages; past that the tool says to take one down first. A file's page moving to another
version doesn't count again.

### 6. Taking a page down

Whoever reads the file, and every administrator, sees the file's public page in Compartilhar (its address,
Copiar link and Despublicar), and `GET …/published-pages` lists them (administrators: every page of the workspace;
the page is public, so its title is no secret; others: the pages of files they read). `DELETE
…/published-pages/{id}` revokes at once. Moving the file to the trash, deleting the workspace, a suspension or a
hold stop it too. Each publish and revoke is an audit row (`artifact.page_published`,
`artifact.page_unpublished`, in words in Auditoria) with the file and the version, never the title.

## Later

- A folder: several files under one address (`/p/<token>/<path>`), with a policy that lets the page load its own
  files and nothing else. The address already ends in `/` so relative links work then.
- People publishing from the viewer without an agent, and a list of every public page in Configurações.
- A page that follows the file's latest version (each new version asking again).
- "Aprovar sempre" kept per file for our own tools (`rememberTarget` without a connection).
- The approval card naming the file, not only the version.
- A server whose `PUBLISHED_PAGES_URL` is unset again shows no pages; set again, the live ones answer again.
- The operator taking a page down (abuse reports on agentes.chat Cloud), and a cap the billing service sets.
- The phone app's section in its share sheet.

## Consequences

- A self-hosted server needs a second host name pointed at it to use this, and its proxy must pass `Host`.
- An agent at `never` publishes without a person: the audit and Compartilhar are where people see it.
- A page can't fetch anything or keep anything in the browser (no storage without `allow-same-origin`): a page
  that needs data carries it inline.
