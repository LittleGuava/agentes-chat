# 0192. Best of N: `/burst` tries a request several times and answers once with the best

- Status: Accepted (2026-11-15; first slice built: the engine, the apps' refusals and the comparing turn, tested on in-memory PGlite with the fake model. Not yet run against a real model or in the apps' composer)
- Date: 2026-11-15
- Extends: ADR 0008 (runs), ADR 0053 §4 (the routine room, whose family the attempts' rooms join), ADR 0097 (how a turn ends), the Model Gateway's budget (ADR 0007)

## Context

A model's answer varies from one try to the next: a slogan, a plan, a SQL query or a summary is sometimes much better on the second try than on the first. People already ask an agent "try again" and compare by hand. What they want is to ask once, have the agent try a few times on its own, each try unaware of the others, and get one answer: the best of them, or the best parts of them put together.

Nothing in the product does this. A conversation holds one active run per agent (`startOrJoinRun`), so a second message joins the first run instead of trying again; a routine's background run (`agent_runs.background`) has nobody behind it, never posts and keeps a routine's bounds (ADR 0053), so it is the wrong vehicle for a person's request; and long work (ADR 0121) moves one run out of the conversation, it doesn't start several.

## Decision

### 1. The command

A person's message that starts with `/burst` (`parseBurstCommand`, `packages/engine/src/best-of.ts`) is `/burst [N] <request>`:

- `N` is 2 or 3 (`BURST_MIN_ATTEMPTS`, `BURST_MAX_ATTEMPTS`); without it, 3. Anything else is refused (`burst.attempts`).
- The request is what follows, as written; only an agent's handle is no request (`burst.no_request`).
- The agent: in a DM with one agent, that one; elsewhere the one agent the message names among those who answer there, the conversation's members or the right hand, who answers in any channel (`rightHandReaches`; `burst.needs_agent` for none or several).
- The person must be able to talk to it, as for any message (`talk_to_agents` and the agent's audience, `canTalkTo`; `burst.agent_unreachable`).
- The agent must answer through the API: a computer brain's attempts would share one working folder on one computer and step on each other's files (`burst.computer_brain`; Later).
- Words only: a `/burst` with files, a quote, a GIF or opening a thread is refused (`burst.plain_only`), since the brief carries the request's text and nothing else yet.
- Not in a mission's thread (`burst.mission_thread`): a mission's thread has its own lead and runs (missions, ADR 0029), and its answer must come from them.

A refusal is a domain error with its code and params (`ValidationError`/`ForbiddenError`), thrown by `postPersonMessage` before anything is written: nothing is posted, the composer keeps the text and the apps say why in every language (`errors.burst.*`, mapped in `packages/client/src/lib/errors.ts`).

### 2. The budget, checked for the whole burst first

Before anything starts, the attempts and the comparing turn (N + 1 runs) must fit what is left of the agent's budget this month, as the Model Gateway reads it: spent plus reserved in `agent_budget_periods`, or the month's calls before its first reservation (`requireBurstBudget`). One run's cost is the agent's average over its last 30 days (at least 3 runs with usage), else its model's catalog price for a typical chat turn (12,000 tokens in, 1,500 out; `TYPICAL_ATTEMPT`). A model with no price costs 0 here, as its calls never use a budget up in the gateway. Refused, `burst.over_budget` says what is left and about what the burst needs, in US dollars.

This is a check, not a reservation: two bursts started at the same moment both read the same room. The gateway still holds every single call to the budget, so the worst case is a burst whose last turns stop on the budget like any run.

### 3. Each attempt in a room of its own

In the same transaction as the person's message (`postBurst`):

- The message is written as typed, with `meta.burst = { agentId, attempts }` and no run of its own (`insertMessageWithRuns` with `startRuns: false`); its `message.posted` routes to nobody, not even by its mention (`jobs.ts`).
- Per attempt: a private room with only the agent in it, `dm_key = routine|a:{agentId}|burst:{messageId}|n:{attempt}` (`burstRoomKey`). It joins the routine rooms' family (`isRoutineRoomKey`), so it is kept out of people's lists, out of agents' searches and out of what "an agents' DM" means, with no new predicate at those places; it names no routine (no `|r:`), so nothing reads it as one (`routineReportChannel` finds none).
- In the room, the brief: the request, written as the person (`meta.burstAttempt = { id, attempt, of }`), and a normal run of the agent on it (`trigger: mention`, **not** `background`). "In the background" in the request means out of the conversation, not ADR 0053's flag: a person is behind each attempt (`authority.ts` walks to the brief's author), so it works with that person's permissions, like the message they wrote. An approval or a question it raises is asked in the attempt's room, which no person reads: that attempt waits until the deadline stops it (Later).
- A deadline job (`burst.judge`, `deadline: true`, 30 minutes, `BURST_DEADLINE_MS`).

No attempt sees another: each room's history is its own brief and its own work, and each has its own conversation for the brain's session.

### 4. The comparison, once

`burst.judge` (`judgeBurst`) runs when an attempt ends (the executor's `finished`, for a run in a burst room, enqueues one per attempt that ends: `burstAttemptEnded`) and at the deadline:

- Until every attempt has ended (done, failed or stopped) it does nothing; at the deadline it stops the ones still going (`stopRun`, system actor, error `burst_deadline`) and goes on with what came back.
- It holds the person's message (`for update`) and delivers once: a second check finds the notice already there.
- The drafts reach the agent as a notice only it reads, `burst_results` (`AGENT_ONLY_NOTICES`, mirrored in the apps), in the conversation and thread the person asked in, through `deliverNotice`: one section per attempt, each cut to 8,000 characters, an attempt that didn't finish said so. The agent reads them inside the outside-content envelope (`untrustedBlock`): they are its own drafts, but they may quote what it read. `refs.runId` names the first attempt's run, so the run the notice wakes has the same person behind it.
- That run answers the person (`BURST_GUIDANCE`: the best draft as its answer, or a merge when clearly better; no list of drafts; none came back: say so and offer to try again). It is a normal run in the conversation, at hop 1 in a stretch of its own, and may not pass (the notice isn't one that only informs, `reply-policy.ts`).
- The rooms are archived.

### Data across the boundary

- `messages.meta.burst`: `{ agentId: string, attempts: number }` on the person's message.
- `messages.meta.burstAttempt`: `{ id: string, attempt: number, of: number }` on each brief.
- `messages.meta.notice`: `{ kind: "burst_results", text, refs: { burstId, attempts, finished, runId } }`.
- Outbox job `burst.judge`: `{ messageId, deadline?: true }`, dedupe `burst.judge:deadline:{messageId}` and `burst.judge:{messageId}:{runId}`.
- No migration, no new table, no env var, no change to the computer's protocol.

## Consequences

- One request costs N + 1 runs of the agent, and the person waits for the slowest attempt (or the deadline).
- The `/burst` message itself has no run, so a read that looks for "a person's message no run answered" sees it as unanswered until the comparing turn's reply comes; the operator's explanation (`operatorExplainMessage`, `UNANSWERED`) doesn't know bursts yet.
- The attempts' rooms are private conversations no person reads, like a routine's room: their runs show in the task manager and the audit log like any other run. Each burst leaves 2 or 3 archived rows in `channels`.
- Long work (ADR 0121) never moves an attempt: `movableRun` skips agent-only rooms.
- An attempt stopped outside the executor (a person stopping it in the task manager) is counted at the deadline, not at once; and there is no way yet to stop a whole burst from the conversation.

## Later

- Computer brains: an attempt per working folder (worktrees), and the plan's limits instead of money.
- The composer: `/burst` in the command list, with N and the agent picked there; a line under the message while the attempts work ("Tentando 3 vezes…"), and the drafts on demand.
- A prompt line telling each attempt it is one of N and must not ask the person (now an attempt that asks waits on that person until the deadline).
- Reserving the burst's budget in the gateway instead of checking it.
- Files, a quote and a GIF carried into each attempt's brief.
- Splitting a request into different parts that run in parallel and merge (the other meaning of "burst"), on the same rooms and comparing turn.
