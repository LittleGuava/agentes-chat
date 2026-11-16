# 0214. Health: failures grouped into issues

- Status: Accepted (first slice built: four sources, the web's Health section and the operator's read)
- Date: 2026-11-15
- Code: `packages/engine/src/health-signature.ts` (`normalizeFailure`, `failureSignature`),
  `packages/engine/src/health.ts` (`scanHealth`, `listHealthIssues`, `HEALTH_SCAN_JOB`), schema
  `packages/db/src/schema/health.ts`, route `apps/server/src/routes/app/health-issues.ts`, operator
  `apps/server/src/operator/health.ts`, web `apps/web/src/components/Health.tsx`; tests
  `packages/engine/test/health-signature.test.ts`, `health.test.ts`, `apps/server/test/health-issues.test.ts`,
  `packages/client/test/health-lib.test.ts`, `apps/web/test/health.test.tsx`

## Context

When something keeps failing in a workspace, the evidence is spread over rows nobody reads together: a tool that
answers an error on every call (`agent_run_steps`), runs that end on a timeout or a provider's refusal
(`agent_runs.error`), jobs that sit in the queue or died after their tries (`outbox`), a run that cost far more than
the others (`usage_records`). Each screen shows one row at a time: the conversation shows one failed run, the audit
log one failed call. Nobody sees that the same error happened 300 times since Tuesday, nor when it started.

The daily stall-and-noise report (ADR 0089, addendum 2026-10-31) counts what agents did not do, for the operators,
by email. This is the other half: what broke, for the workspace's own admins, grouped so that one cause is one line.

## Decision

1. **An issue is a group of failures with one signature.** A signature is a hash of the failure's kind, its tool (when
   it has one) and its normalized text: the first line, credentials masked (`redactCredentials`), then URLs, email
   addresses, UUIDs, long hex ids, absolute paths, quoted values and numbers each replaced by a placeholder
   (`<url>`, `<email>`, `<id>`, `<hex>`, `<path>`, `<q>`, `<n>`), whitespace collapsed, at most 160 characters. "no
   layer 12" and "no layer 104" are one issue. The normalized text is the issue's `title`; the raw text is never
   stored.
2. **Kinds and where each comes from.** All read from rows the server already writes, by plain code, no model call:
   - `tool_error`: a `tool_result` step with `isError`, minus the gateway's own refusals (`data.refusal`, and the
     codes it gives a refused call: `tool.not_allowed`, `tool.credential`, `tool.why_missing`, `autonomy`, `team`,
     `team.action_seen`, `approval.ahead_refused`, `secret.connector_first`), and minus the results of a secret or a
     question a person declined (`data.secretRequestId`, `data.questionId`). A refusal is the policy working, and a
     person's answer is theirs to give: neither is a failure. Grouped by tool and normalized text.
   - `timeout` and `run_failed`: a run that ended `failed`. Its stored error is read with `runErrorDetail`, so the
     signature is the stable code (`run.provider_timeout`, `run.cli_failed`…) plus one name (the provider, brain or
     model it names) and one text (the normalized detail, or a wrong key's provider). A code with `timeout` in it is a
     `timeout`. A person's stop is no failure. The apps word the code with `runErrorText`, the same words the
     conversation shows, from that name and that text.
   - `queue_stalled` and `job_failed`: an outbox job of the workspace still `pending` five minutes after it was due,
     or `failed` after its last try (its normalized `lastError`). Grouped by job kind. A stalled job's occurrence is
     dated when a scan found it: one due longer ago than occurrences are kept would otherwise be found and counted
     again at every scan. Still stalled 14 days later, it counts once more. The scan itself runs through
     the outbox, so it sees starved kinds and dead jobs, not a dead worker: when no worker runs, no scan runs either.
     Jobs without a workspace (`org_id` null) are left to the operator's job list (ADR 0056).
   - `cost_spike`: a run that ended having cost the workspace more than $5 (`usage_records` billed to `org`; the
     platform's own calls and a plan's estimates are not the workspace's money). Grouped by agent.
3. **Counted once, whatever runs it.** Each failure has an occurrence key (the step's, run's or job's id). A scan
   rereads a trailing window (two hours; a day of runs for the run-based kinds, found through `agent_runs.created_at`,
   which has an index) and inserts occurrences with `ON CONFLICT DO NOTHING`; an issue's `count`, `first_at` and
   `last_at` move only by what was inserted, in one transaction per issue. Running a scan twice, on two replicas or after a
   retry, leaves the same state. Occurrences older than 14 days are deleted by the scan; the issue keeps its count.
4. **A job through the outbox.** The workers' `healthScan` tick queues `health.scan` every five minutes, with its
   window in the dedupe key, so several replicas queue it once.
5. **Who sees it.** `GET /api/app/organizations/{orgId}/health-issues`, for who has `view_audit`: who may read what
   agents did may read what kept failing. The titles hold no raw text, and normalized text stays with them. An issue lists its three latest
   examples as references only: when, which agent, which run. Never the conversation, whose audience is its own
   (ADR 0151). The web shows it as Settings › Health, next to Audit.
6. **The operator reads facts.** `GET /api/operator/v1/orgs/{orgId}/health-issues` returns kind, signature, tool,
   count, first and last time and agent, never the title: normalized text may still hold a word someone typed.

## Consequences

- The workspace's admins see what keeps failing, how often and since when, without reading conversations.
- Two tables (`health_issues`, `health_occurrences`), both the workspace's and deleted with it.
- A tool error whose run started more than a day before the scan is not counted: steps are found through their run.
- Each scan reads the last day's runs of every workspace (by `agent_runs.created_at`) and their failed steps, and at
  most 5,000 rows of each source, in no order: a window with more failures than that counts only some of them.

## Later

- The phone app's section.
- A cost spike relative to the agent's usual run, instead of a fixed $5.
- Dismissing or resolving an issue, and telling the admins (notification) when a new one starts or one jumps.
- Instance issues (jobs without a workspace) for the operator, and a list across workspaces.
- Stalled run inboxes and runs queued too long, apart from their jobs.
- A partial index on failed `tool_result` steps, so a scan needs no pass through the day's runs; reading each source
  in order, past the 5,000 rows.
