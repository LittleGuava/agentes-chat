# 0205. The phone's own apps as an agent's tools, starting with the contacts

- Status: Accepted (2026-11-15; built: the server side, the first tool `phone_find_contact` and the phone app's API, tested with a fake phone. 2026-11-16: the phone app's side, addendum below; it reaches phones with the next native build)
- Date: 2026-11-15
- Extends: ADR 0035 (the phone app), ADR 0053 (who is behind a run), ADR 0117 (outside text reaches models only framed)

## Context

People keep the names, numbers and addresses they use most on their phone. When someone asks an agent "send Maria the report" or "what's João's number?", the agent has nothing to look in but the workspace: the Vault's contacts (ADR 0144) hold what people saved for the team, not each person's own address book. OpenMausBot lets the phone register the apps it allows and answer jobs its bots send it; we want the same, in our own shape.

"Phone" already means something else here: ADR 0042 phones are devices plugged into a computer that agents test apps on (`phone_screenshot`, `phone_logs`, named with `phone`). This ADR is about the phone of the person talking to the agent, through the agentes.chat app on it.

What must hold:

- Nothing on a phone is reachable until its person turns it on, from that phone.
- Only the person's own request reaches their phone, and what comes back is read by them alone.
- As little as possible leaves the phone, and it isn't kept longer than the turn needs.
- The phone app may be closed, in a pocket or on an old version: a run never waits on it for long.
- PostgreSQL is the only dependency (ADR 0005): the queue is rows, the signal is the pub/sub we have.

## Decision

1. **The person's yes, per workspace, from the phone.** `phone_tool_grants` (`org_id`, `user_id`, `tools`, `device_name`, `updated_at`; one row per person and workspace) says which of the phone's apps their agents may use: `contacts` for now (`PHONE_TOOLS`). Only the phone app sets it: `PUT /api/app/organizations/{orgId}/phone/tools` with `{ tools, deviceName }`, refused without `X-Agentes-Client: mobile` (`phone.app_only`, 403); an empty list deletes the row. `GET` on the same path reads it back. One phone holds it: turning it on from another phone moves the name (several phones per person is Later). Leaving the workspace deletes it (`removeMember`), and so do deleting the account or the workspace (foreign keys).

2. **Who and where.** A run reaches a phone only when a person is behind it (`runPerson`, ADR 0053: never a routine's run, an agent's own work or a mission task's call through the bridge), in that person's own DM with the agent (`personAgentDmKey`), with `contacts` on. Anywhere else the tool isn't listed, and a call is refused with why (`phoneOwner`, checked on every listing and every call). A shared channel is left out because the answer is part of the conversation: everyone in the channel would read the person's contacts. A DM is the person's own (administrators read every channel but never a DM, ADR 0151); who else may see a run's steps there is what ADR 0128 and 0151 already say for any run. The run policy (`run-policy.ts`) lists `phone_find_contact` among the reads, so an agent that always asks (ADR 0173) doesn't ask for it.

3. **A job queue the phone answers.** A call adds a `phone_jobs` row (`org_id`, `user_id`, `agent_id`, `run_id`, `kind`, `input`, `status`, `result`, `error`, `created_at`, `expires_at`, `finished_at`) and publishes `{ type: "phone.job", jobId }` on the person's realtime topic (`userTopic`, forwarded to every socket of theirs as a `user` event). The event carries only the id: the app lists what is pending and answers each job.

   - `GET /api/app/organizations/{orgId}/phone/jobs` → `{ jobs: [{ id, kind: "find_contact", input: { query }, agent: { id, name }, createdAt, expiresAt }] }`, oldest first, the person's pending jobs that haven't run out.
   - `POST /api/app/organizations/{orgId}/phone/jobs/{jobId}` with one of
     - `{ outcome: "done", contacts: [{ name, phones: string[], emails: string[] }] }`: at most `PHONE_CONTACTS_MAX` (5) contacts, each with at most `PHONE_CONTACT_VALUES_MAX` (5) numbers and addresses; a name is 1–200 characters, a number 1–40, an address 1–254;
     - `{ outcome: "declined" }`: the person said no on the phone;
     - `{ outcome: "failed", error }`: the phone couldn't (the OS permission is off, say), 1–300 characters.

     → 204. The first answer wins: a job already answered or past `expiresAt` is a 409 `phone.job_closed`; another person's or another workspace's is a 404 `phone.job_not_found`. Both routes need `X-Agentes-Client: mobile` too. The answer is validated once, by the route; the engine trusts it.

   The answer wakes the waiting tool through a server-side topic (`phoneJobTopic`), and the tool reads the row every second anyway, since the answer may reach another replica. When the job closes (answered, run out or stopped) another `phone.job` event lets the person's other open apps drop it. No lease: two phones of one person may both run a job, and the second answer is refused (a lease is Later, with several phones).

4. **The first tool: `phone_find_contact`.** `{ query }`, a name or part of one, 2–100 characters after collapsing spaces (`PHONE_QUERY_MIN`, so one call can't list the whole address book), at most `PHONE_SEARCHES_PER_RUN` (5) searches a run, counted from the run's jobs. It waits for the phone at most `PHONE_JOB_TIMEOUT_MS` (60 s, well inside the bridge's six minutes for a computer brain's call), stops waiting when the run is stopped (`ToolContext.signal`), and closes the job as `expired` either way, so a late answer is refused. The matches reach the model inside `untrustedBlock("phone contacts", …)` and the call is `readsOutside` (ADR 0117): a contact's name is text anyone who ever sent the person a vCard could have written. Declined, failed and expired each say what to do instead (ask the person in the chat). The chat shows it as "searching your phone's contacts" (`searchingContacts`), not as testing on a phone.

5. **What leaves the phone, and where it stays.** The phone runs the search itself (on iOS and Android, through `expo-contacts`) and sends only the matches' names, numbers and addresses, never the rest of the address book, photos, notes, birthdays or addresses. On the server the job's `result` is wiped as soon as the tool has read it; the rest of the row (the search, how it ended) counts the run's searches and is deleted after a day, when the person's next search starts. What the tool answered is part of the run's transcript and its steps like any tool result, and lives and goes as the conversation does. The audit log keeps no row for a search that answered, a built-in read (`auditsCall`); one refused or failed (refused here, run out, the phone's error) gets its `tool.call` row with the search as `auditInput` keeps it. Nothing is sent to a model but the agent's own, through the Model Gateway.

6. **Confirmation on the phone.** A read the person turned on runs without asking each time: it is their own request, in their own DM, read-only and capped. Any later tool that sends or changes something from the phone (a text message, a call, a calendar event) asks on the phone itself, per call: the phone shows what will go and to whom, and only the person's tap there sends it. Our approval cards in the chat don't stand in for it: the phone is where the person sees the real recipient. The phone may also decline a read (`declined`), for instance if its person turned on a per-search prompt.

7. **No computer protocol change.** The phone talks to the app API and the realtime socket it already has; the runner protocol is untouched (no protocol number taken).

## Later

- **Several phones** also settles a race kept for now: two phones of one person with the app open both answer, and one without the system's permission answers `failed` and may come first.
- **Waking the phone**: a push (`push.ts`) when a job starts and no socket of the person's is open, so a phone in a pocket can answer in time; until then the app must be open.
- **More tools**: the calendar (`expo-calendar`) to read the day and propose events, texts and calls with the confirmation in §6, each its own switch in `PHONE_TOOLS`.
- **Several phones**: a phone id in the grant, a lease on a job (`POST …/jobs/{id}/lease`), and the person choosing which phone answers.
- **Shared channels**: the answer posted only to the person (an ephemeral card) so an agent in a channel can use it too.
- **A workspace switch** for admins to turn phone tools off for everyone.
- **A per-search prompt** on the phone for people who want to see each search before anything leaves it.

## Consequences

- A new pair of tables (migration `0306_phone_tools`), with `org_id` like every tenant table and cascades from the workspace, the person and the agent.
- Until a phone runs a build with `expo-contacts`, no grant can be made and the tool is never listed: the server side is dormant, not half-working.
- A run may wait up to a minute on a phone that never answers; the tool says so, and the agent asks the person in the chat instead.

## Addendum (2026-11-16): the phone app's side

- **Where.** Você › Preferências has a row, "Contatos do celular", for the workspace open in the app (as "Respostas dos agentes"), pushing a page with one switch and a footer saying what leaves the phone: only in this workspace and on this phone, up to 5 matches, each a name, numbers and emails (`apps/mobile/src/features/phone-tools/PhoneToolsPage.tsx`, route `app/(app)/me/phone-tools.tsx`). The row shows only where the build has the native module and the server answers `GET …/phone/tools`; an older server (404) or build hides it.
- **The system's permission, only when the person turns it on.** Turning the switch on reads the permission: granted saves at once, askable shows the system's prompt, refused for good says so with a way to the phone's Settings (`consentStep`). Nothing is saved without the permission. Turning it off saves an empty list (the server deletes the row); the system's permission stays as the person left it. The switch shows on only while the server has the yes and this phone the permission (`switchOn`, read again when the app comes back to the front): after a reinstall, on another phone or with the permission taken back in Settings it shows off, and turning it on asks the system again.
- **Answering.** `usePhoneJobs`, mounted once with the app's stack, runs only while contacts are on here: it lists the jobs on mounting, on each `phone.job` event and when the app comes back to the front, one pass at a time, and answers each job once (`answerPhoneJobs`). A job is answered with `contactsAnswer`, a pure function over the phone's address book: every word of the search in the name, in any order, accents and case aside; the first 5 matches; per contact at most 5 numbers and 5 emails, trimmed, without repeats, a value longer than the server takes left out whole. A permission taken back in the phone's Settings answers `failed` saying so; an address book that can't be read answers `failed` with its error. An answer the server refused (`phone.job_closed`, `phone.job_not_found`: the job ended, or another phone answered first) is dropped; one lost on the way (no connection, the server down) goes again on a pass 5 s later.
- **The book is read whole, on the phone.** `Contact.getAllDetails` with only the name, phones and emails fields and no name filter: the systems' own filters disagree (Android's is one `LIKE '%…%'` on the display name, so accents count and words must come in order; iOS's `predicateForContacts(matchingName:)` is another rule), and the same search must find the same people on every phone. The book never leaves the phone; only `contactsAnswer`'s matches do.
- **Native access behind an interface.** `ContactsAccess` (`contacts-access.ts`) is the permission, the prompt and the search; the real one (`contacts.ts`) loads `expo-contacts` only where its native module (`ExpoContactsNext`) exists, so an app built before it keeps working, and tests hand in a fake.
- **The build.** `expo-contacts` is a native module: phones get this with a new native build. Its plugin sets iOS's `NSContactsUsageDescription` to our words; on Android it asks `READ_CONTACTS` and `WRITE_CONTACTS`, and `android.blockedPermissions` drops the second, since the app only reads.
