# 0177. Lodi acts first

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR 0137 (§2: it posts nothing unless someone writes to it, with one exception, §9), ADR 0172 (what waits on
  a person)

## Context

The right hand answered when asked and posted one card by itself: "Semana da equipe", for admins, plus the same card
every day for whoever asked for it. Everything else that goes wrong in a workspace waited for a person to notice: an
AI sign-in that ended, approvals piling up, a task handed over that never came back, a person who joined and was
greeted by nobody.

Seven things change that. Each is small, calls no model unless a person is waiting for the answer, and has a switch.
They share one foundation, built first, so the seven can be built side by side.

## Decision

### 0. What they share

**A person's choice** lives in `organization_members.team_week` (the column keeps its name) and is read in one place,
`packages/engine/src/right-hand-prefs.ts`:

| Field | What | Default |
|---|---|---|
| `dayOff`, `dayHour` | "Resumo do dia", everyone's, in the person's own time zone (else the workspace's) | on, 9h |
| `weekOff`, `day`, `weekHour` | "Semana da equipe", an administrator's, in the workspace's time zone | on, Friday 17h |
| `digestOff` | the summary of approvals waiting (§4) | on |
| `remindOff` | reminders of what was agreed (§5) | on |
| `muted` | suggestions this person put away for good (§3), the newest 200 | none |

The writer merges (`team_week || patch`), so a key a version does not know survives a save.

**Who had stopped the card gets nothing new.** Rows saved before the two cards were told apart hold `off`, `daily` and
one `hour`. They are read as what they meant: `off` stops both cards, `daily` is the day's card in place of the week's
at that hour, and any other saved row has the day's card off, since it was off unless asked for. Only a row that
never chose gets the day's card by default. `off` was "nothing comes by itself" when it was the only switch, so it
also reads as the approvals summary and the reminders off (§4, §5), until the row holds a word of its own for each. The same rules exist once in SQL (`lodiPrefsSql`), and a test holds the
two together.

**App builds from before** still send and read `off`, `daily` and `hour`. `GET …/team-week` answers them beside the new
fields (`off` only when nothing comes, `daily` when the day's card comes alone, `hour` of the card that build shows),
and a `PUT` that carries them is applied as that build meant it: `off: true` stops both cards, the approvals summary
and the reminders, so its one switch still stops everything, and `off: false` starts the one card that build draws (the week's for an administrator, the day's
for anyone else), never a card the person has no control for there. The row keeps those three beside the new keys, so
a server of the version before reads the same choice. Two saves at once take turns on the member's row.

**New app builds on a server from before** (a self-hosted server not yet updated) read its `off`, `daily` and `hour`
and save in the same words (`legacyPatch`, `packages/client/src/lib/right-hand-prefs.ts`): that server keeps one card,
so a stop stops it and a start picks which one comes.

**Two slots.** The worker's `rightHand` tick (every 10 minutes) queues the week's card as `team_week.post` and the
day's as `team_day.post`, each with `period` in its payload: the day's for every member who has it on, the week's for
administrators, one job per person and day and one per person and week (the dedupe key). On the day an
administrator's weekly card is due they get that card alone. The statement keeps only members within the six hours
after their slot who have no job for that card yet (it rebuilds the dedupe key and looks it up), and asks who
administers only for those, on a day a weekly card may be due. So a tick reads who it may queue, and they are queued a
thousand per statement. Both kinds and `team_watch.check` are long jobs (ADR 0053 §10): a card for every member at the
same hour never stands in front of a message's routing.

The day's card has a kind of its own because a server of the version before knows `team_week.post` and would read a
day's job as a week's. While both versions run, that server fails a `team_day.post` job it claims (no handler), and
that person's card of that day is not sent.

**Helpers** (`right-hand-proactive.ts`): `lodiFor` (the right hand, or null in a closed workspace, when it is archived,
or when it may not talk to that person), `postFromLodi` (one message in a person's DM, in their language, ringing only
when asked, said once), `saidOnce` (a finished outbox row whose dedupe key is the memory, stored with the workspace
and a prefix no job uses), `setCardOnMessage`, `lodiSwitches`. A message that rings names its person on itself
(`meta.forUserId`): nobody asked for it, so no run says whose inbox it belongs in. No new table: what was done once is
an outbox key, what was told once is an inbox group key, what was put away is on the card's message. The one
migration (0265) adds
the two workspace switches and an index on `agent_consultations (org_id, channel_id)`, which finds the hand-over of a
task by the task's conversation (§5).

**One thing tells one thing.** Where two of the seven, or one of them and a notice from before, would say the same,
one yields, and which is written with the feature: the watch keeps no row for what another notice already says of
that very thing (§1), its reminder leaves approvals to the approvals summary when one of its cards holds them (§1,
§4), the day's card lists no approval for who that summary serves and rings for nothing the inbox already rang for
(§2), the summary grows the card the right hand posted when asked instead of adding one (§4), and a handed task's
end is told in the DM with its inbox row read and is left out of the day's card (§2, §5).

**Lanes.** Each feature below that runs by itself is one file that calls `defineLodiLane` (`right-hand-lane.ts`) with
its switch, whether it is built (`live`), its outbox jobs, its sweep and its block of the right hand's prompt. The
server reads the list in four places: the job handlers, the worker's sweep, the prompt, and the switches. A lane that
is not `live` is wired and does nothing, and its switch shows nowhere: not on the page, not in `set_team_week` or
`update_workspace`, not in the prompt. A lane whose prompt block fails adds none and is reported: the right hand
still answers.

**Switches.** On the right hand's page, web and phone, one group "O que o Lodi faz por conta própria": the day's card
with its hour (everyone), the week's card with its day and hour (administrators), then one switch per live lane. Two
are the workspace's (`organization_settings.team_watch` and `welcome_people`, migration 0265, on by default and on
with no settings row), saved by who configures the workspace, and say so under their name. The right hand flips the
person's own when asked (`set_team_week`: `card`, `off`, `day`, `hour`, and `digest`, `reminders` once live) and the
workspace's through `update_workspace`.

**New row kinds on the card** travel in `card.moreRows`. Builds from before never read it, and a kind they do not know
would break their card. The apps draw `rows` then `moreRows`, known kinds only.

### 1. Team watch ("Cuidar da equipe")

A sweep with no model call (`team-watch.ts`). It fixes what is safe and tells the one person who can act, through
"Esperando você" (ADR 0172), never in a DM message.

- Tells, as one notification kind `team_watch` with the right hand as actor and the cause in `latest.reason`:

  | Cause | When | Who hears it | Opens |
  |---|---|---|---|
  | `sign_in` | a plan is signed out, an agent thinks with it, and its last turn was over 20 minutes ago | the plan's owner, nobody else | the AI accounts |
  | `connector` | an app to reconnect for over 20 minutes | who connected it while they manage connectors, else the first who does | Connectors |
  | `mailbox` | a mailbox to reconnect for over 20 minutes | its owner, nobody else | Connectors |
  | `database` | its password was refused | who connected it while they manage connectors, else the first who does | Connectors (on the web, also from the phone, which has no screen for it) |
  | `budget_out` | an agent's month is used up | its owner if they manage agents, else the workspace's owner | the agent |
  | `budget_low` | 80% used and the month's pace would end it early | the same | the agent |
  | `computer` | a brought computer gone over 30 minutes while a run waits for it | who paired it, else the first who configures the workspace | the computer |

  One open row per person and cause: it lists everything of that cause that is theirs (`latest.names`, `count`), is
  rewritten in place as the list changes and is done only once nothing of it is wrong any more: a thing stays listed
  for as long as its own status says it is wrong. `latest.text` is the whole sentence, the cause and the one way
  out, in the reader's language, so a build from before the kind shows it as it is. A new row comes only for a
  problem that person was never told (a finished outbox row per person, thing and episode), so one put away with
  "Feito" does not return, and at most three new rows a person a day. Every cause waits on the person but
  `budget_low`, which stops nothing yet: a plain row that reaches no device. The kind has no notice category of its
  own, so a waiting row pushes as anything waiting does.
- An episode, and the 20 minutes, are read from a time that a write leaving the thing as wrong as it was cannot
  move, where its row keeps one: a plan's last turn (its row is rewritten by every usage report of its computer), a
  computer's last contact, a budget's month and amount. An app, a mailbox and a database keep no such time, so the
  last change of their row stands for it. A mark repeated on an app or a mailbox that already waits to be
  reconnected moves nothing (`markToReconnect`, `markNeedsReconnect`: the first refusal's text stays in
  `last_error`), so a provider saying it twice is one episode. Renaming one that still needs reconnecting reads as a
  new episode, which changes nothing while its row is open and tells it once more after a "Feito". A column with the
  time it broke would make that exact.
- No row for what another notice of that person says of the same thing since the problem began, whichever came
  first (a row of the right hand's leaves when the other notice arrives):

  | Cause | Kinds that already say it | Tied to the thing by |
  |---|---|---|
  | `sign_in` | `run_failed`, `routine_failed` or `widget_failed` with the reason `not_logged_in` | an agent it names thinks with that plan |
  | `budget_out` | `run_failed`, `routine_failed` or `widget_failed` with the reason `budget_exceeded` | it names that agent |
  | `computer` | `routine_stalled`, `device.waiting`, or `run_failed` with the reason `machine_offline` | its computer, or an agent it names works on it |

  A routine paused as failing and a widget that stopped keep their own notices (`routine_paused`, `widget_failed`)
  and get no row here.
- Fixes, silent but for the audit log:
  - A routine's first failure after a good run, for a cause outside it (`OUTSIDE_RUN_ERRORS`, read from its agent
    run's stored error: the provider down, slow or over its rate, an error of ours, its computer, a restart), is
    queued once more 15 minutes later when it is scheduled and its next slot is over an hour away. That happens where
    the failure is recorded (`routine-ledger.ts`), not in the sweep, so the `routine_failed` notice is held exactly
    when a retry was queued and sent when the retry fails too. A widget's routine is retried the same way and keeps
    its `widget_failed` row, which reaches no device and leaves with the good update.
  - A scheduled routine paused as `failing` whose last five failures were all outside it is resumed, from 30 minutes
    to a day after the pause, once its agent can think now, with the right hand as actor in the audit log.
  - Both happen once between two good runs of the routine, so one that keeps failing is neither retried nor resumed
    in a loop. A failure held for a retry is told at the streak's next failure, whichever run that is, once. A person
    who presses "Rodar agora" while the retry waits gets their run now and the retry gives way to it. After a resume
    the routine's next failure is told as any first failure: the fix did not hold.
- Reminds: once a day per person, in their own daytime (9 to 18 in their time zone), of the approvals, questions and
  secret requests they left unread for over four hours. The oldest comes back on top with one push that says how
  many still wait (`latest.still`, read by `push.ts`), and all of them are marked reminded, so none is reminded
  twice. Approvals are left to the approvals summary (§4) only when one of its cards holds them: the reminder asks
  it to post or grow its card then, so approvals that came before the summary existed get one, quietly. Someone the
  right hand may not write to, with fewer than it sums up, or past its two cards of the day, is reminded of approvals
  like anything else.
- Old news is nobody's: a sign-in, an app, a mailbox, a database or a computer already wrong for over seven days
  when it is first looked at is not told (it is listed in a row only once one of its cause is open for something
  newer), and an ask left unread for over seven days is not reminded of. So the day the watch starts in a workspace
  tells nothing that stood there for weeks. A budget is told for the month it is in.
- The sweep queues a check only for what the check would act on, every 10 minutes while something is new (it
  began or its row moved within a day, or a person is due their reminder) and once an hour while everything only
  stands as it was (a problem told and not fixed, a budget, a paused routine). With the switch turned off or the
  right hand archived, one last check closes the rows it had open. What they said is not told again when the switch
  comes back on.
- It never raises a budget, reconnects, signs in or moves agents, and resumes only a pause for `failing`. Rows carry
  names and a cause, nothing from a DM, a vault, memory or a mailbox. A computer's row names the computer, never the
  agents waiting for it.

### 2. The daily brief ("Resumo do dia")

The day's card for everyone, from stored data.

- It posts only when something is the reader's and new: something waits on them, a run they asked for or of an agent
  they own is stuck, their agent finished work they did not ask for themselves, a task they made was closed by an
  agent, a how-to of their agent is ready to become a skill. Counts across the workspace never post it, an
  administrator's included: the team's view is the week's card. What they asked for themselves answered them where
  they asked, so it is counted on a card that goes out and never posts one.
- A run is the reader's when its agent is theirs, or when they wrote the message that started it or the first message
  of its thread. That is one statement for all their runs. Work one agent passed to another outside that thread shows
  on its owner's card only.
- Rows: approvals of the agents their inbox says are asking, one row that counts what else waits on them (it opens
  "Esperando você" and stores inbox ids, never a question's words), what is stuck and why (up to three, one of six
  causes and one button to its conversation or task, never run text), then their agents' how-tos and stalled steps of
  a task they made. Five at most. Money, channel, routine and unanswered rows stay on the week's card.
- Stuck is a run that failed with no good run after it in the same conversation, or one parked for four hours or more
  on a plan, a budget or a computer. A run a person stopped or a restart cut is neither. A held run's cause is what
  it waits on: a budget (a long work paused on the agent's budget included), a plan's limit, a sign-in that ended,
  a computer away or full. Any other wait (a computer a person paused, a plan its owner did not share) reads as
  "the conversation shows what".
- The card keeps what was still open when it went out (`seen`). The next day's card posts only for something not in
  it, so what waits or is held is said once. It rings only for a run newly held, which told nobody yet. What waits
  on the reader rang when it was asked (and the watch reminds of it, §1), and a run that failed told its person when
  it did (the inbox's `run_failed`): both are on the card without a second ring. What only finished posts without
  ringing.
- For someone the approvals summary serves (it is on for them and it counts three or more waiting, §4), the card
  lists no approval and approvals alone never post it: they are on that summary's card, with its buttons. The count
  of what waits still includes them.
- A how-to is offered only when it was learned where the reader reads, by the rule of the agent's memory page: one
  worked out in another person's DM with their agent, or in a private channel they are not in, stays there.
- It covers from the last day's card to its slot, three days back at most, so a day with no card is not lost. A run
  counts on the day it ended, so one still working at the slot is on the next card (one that began more than three
  days before the window is on none). Its job is found again by the slot kept on the card, whatever the window was.
- A task counts as closed by an agent when its last change of status in the window is an agent's, to done, on both
  cards. A person closing it, or a comment on a closed task, is not. On the day's card a task whose end the right
  hand already holds for the reader (§5: the notice in their DM with it, `taskEndToldSql`) is not counted: that end
  is told there, once. What it holds for one person hides nothing on anyone else's card.
- Nothing from a conversation the reader cannot read: an administrator reads every channel and never another
  person's DM.

### 3. Suggestions on "Semana da equipe"

Two more rows on an administrator's weekly card, never on the day's: an agent idle for 28 days with no routine and no
open task (archive it), and an agent on a large model whose work is light (one tier down, never the smallest). One of
each per card, applied as the admin who clicks, with Undo. The offer to archive is checked again at the tap: an agent
that ran, got a routine or a task since reads "no longer applies" and is not archived. A row can be put away alone: for good and for every admin
on those two, per person on unanswered questions. One left alone returns after four weeks at most. Both are counted
over all runs, private conversations included, so these rows never name a channel or link a run. Archiving is never
part of "Aplicar as N".

- A suggestion rides a card that goes out anyway. A week with nothing else to say posts no card and makes no
  proposal, so a dormant workspace hears nothing. While one suggestion of a kind from the reader's last four weeks
  of cards is undecided, no other agent is offered the same: at most one proposal of each kind waits on a person.

- Light work: 20 or more finished runs in four weeks, nine in ten of them with two model calls and 800 output tokens
  at most. A run with no recorded usage never counts as light. The next model down is the provider's middle one (for
  Claude Code, `sonnet` in place of `opus`).
- Each administrator's card carries a proposal of its own: a settings proposal the right hand makes for a person is
  shown to nobody else until that person sends it on, so one shared row would be hidden from the others. Putting a
  row away refuses the reader's proposal as them and closes the copies on the other cards. An agent is never offered
  the same suggestion again once anyone decided it, applied and undone included.
- Unanswered questions in a team take two people asking. Put away, that channel is muted for that person
  (`muted`). On the wire a row is put away with `{ rowId, skip: true }`, and a body that mixes a row with the card's
  own `dismiss` is refused, so it is never read as "Agora não". The card keeps rows put away in `skipped`, apart
  from `done`: builds from before read any row in `done` as applied. A row put away is not applied afterwards.
- The two reasons reach the apps as `whyCode` `idle` and `light_work`, with the English sentence in `why` for builds
  from before them.

### 4. Approvals digest ("Resumir aprovações esperando")

When three or more approvals a person was told about wait on them, one card from the right hand in their DM, 10 to 20
minutes after the newest: the routine ones listed with one button for all, each risky one as its own card. The server
decides which are routine (never a merge, deploy, delete, send or publish, a command, unproven SQL, a mailbox's, or a
tool whose job is asking) and the one-tap decision skips anything else. The card is updated in place for 12 hours,
then a new one replaces it, two a person a day at most. It never rings and adds no inbox row. The right hand decides
nothing. The card it posted in that DM when the person asked what waits is the same card: the summary grows that one
in place, keeping its line, and never posts a second beside it. On the phone each routine request reads its name,
the agent that asked and what it holds, as on the web.

As built, routine takes two words and errs towards "read it by itself". The approval's row (`routineCall`,
`tools/gateway.ts`): only a connected app's named action that no word of its name marks as a send, a post, a delete,
a payment, a merge or a deploy, as changing who gets in, or as running whatever its input says, and SQL the Postgres
guard proved read-only when it asked. Then the connection (`routineIds`, `approvals.ts`), because a row does not say
why its call asked: the tool must still be listed there as a plain write, so one an admin set to ask every time or
turned off, one our rules or the judge would have ask, one marked sensitive and one its server says destroys keep
their own card whatever their name. At the default level a person's run asks a connected app's call only when its
tool is marked to ask, so nothing there is routine but proven SQL reads: the group is for work nobody watched and for
agents that always ask. Composio's executor is never routine, since no record vouches for the actions its input
names. On the web and on the phone the group's tap is recorded as made from the card (`CardVia`). Every tool of ours stays on its own card, whatever it does: a command on the agent's computer, the browser,
tasks, the workspace's people, keys and settings. Fewer than two routine ones make no group. The older card is not
marked when a new one is posted: it keeps showing what it listed, each approval in its present state. A card lists 50
at most, and a full one lets go of what was decided first, never of what still waits.

### 5. Follow-through ("Lembrar o que combinamos")

- A task the right hand handed to an agent for a person is followed to its end: when it is done or canceled after the
  hand-over was reported back, the right hand is woken once per hand-over in that person's DM. Not when they made the
  change themselves, asked the run that made it in their own words, it did so for them or asked the agent that did in
  a later turn of theirs, and not while the hand-over's own report is still to come, or came after the change or
  within five minutes before it (that report tells the end). An agent's background work that ends the task counts
  too. The inbox row of the same change (`issueStatusGroup`) is marked read for them when a turn starts: it sends no
  push and counts in no badge, so one thing tells them, and it stays in their list, so a turn that fails or passes
  still leaves the news. The next day's card does not count that task again (§2).
- A handed task is looked at a day after the hand-over, then daily, seven looks in all. One that has not changed and
  whose conversation was quiet for four hours is said once per task with what it waits on, read from the task's own
  conversation: the people something there waits on (also while the hand-over is still out), else its agent's run
  paused on something no inbox shows. Never said: a task that waits on the requester (their inbox has it), a hand-over
  that failed or was never taken (told when it closed), and a task whose hand-over was reported back and that nobody
  closed (the person heard the report, and what is left of it is theirs).
- What the right hand is told is a notice only it reads (`wait_result` with `refs.task`, agent-only on every build),
  which names the run that handed the task over, so the turn it starts is that person's own: their permissions, and
  the AI that answers them in that DM.
- A commitment with a time becomes a plain reminder, said in one line. A run at that time only when the person asked
  the right hand to do something then. It keeps at most three by itself in one DM, a rule of its prompt, which also
  lists the ones waiting there. A reminder a person asks for in words has no such cap.
- At most three wakes a person a day, in their own time zone. Past it the notice is written and read with the next
  turn, and the inbox row stays. Each wake is one turn on the AI that answers that person in their DM with the right
  hand, through the gateway, budget checked and cost recorded: their own AI for it when they chose one, else the
  workspace's as it serves them, which may be a plan of another person that serves everyone. It is the payer of any
  message they write there themselves. The looks and the reminders call no model.
- The person's switch stops all of it: the task's end, the looks and the reminders it sets by itself.

### 6. Welcome ("Dar boas-vindas a quem entra")

One stored message from the right hand when a person joins a workspace, by an invitation or an approved request: what
do they look after here, and it sets up their first agent with them. Under it the onboarding's areas to tap, without
"something else" (typing is that answer), and none at all for someone whose account already holds an area. Then an
ordinary conversation: a tap is their own message.

- Never for the workspace's creator or any other owner (an owner has the first-run checklist at the top of that
  conversation), on a rejoin, when they wrote first, with the switch off, or while the workspace is on hold (nothing
  would answer them). The job's key is spent either way: nobody is greeted later for having been missed.
- While they are new (a member who is not an owner, 30 days, no agent of their own) and the switch is on, the right
  hand's prompt in their DM says so: one agent with a first task, never the team interview, then the way to connect an
  AI. It holds that person's own area and nothing of anyone else.
- Until they answer the greeting, the top of that conversation, drawn by the app, shows only the way to connect an
  AI: not how agents should talk to them, not the line to build the team. So they are asked one thing at a time. Once
  they answered, it asks what it asks anyone. The apps tell this from the newest page of messages alone (the greeting
  loaded and no message of the person after it), and ask nothing while that page loads for anyone but an owner.
- The greeting calls no model and rings as any new message does: one row in the newcomer's inbox, and its push.

### 7. Action cards

Two more changes the right hand starts as a card, only on a person's request: inviting people (every address and role
on the card, sent as whoever applies it) and removing an API key. Neither applies at once, and a build that does not
word such a card may not apply it: the click says which action it knows (`knows`), and the server refuses without it
(`action_card.update_app`). A plan's sign-in is removed on its own screen. On the phone the people card applies each
row as on the web, and on both a row offers its button only once the roles it names are loaded. There is no switch: nothing happens without a tap.

- **Invites.** The right hand's `offer_invites` posts this card (every other agent's still opens the invite dialog),
  and it is the turn's one ask. Someone who may invite hears before any card which addresses already belong to a
  member or hold an open invitation. Someone who may not learns nothing of it and sends the card on: its inbox row
  names who asked, every address and every role, and whoever applies it gives only roles they may give. Applied, the
  receipt names who was invited and the card says who was already a member. An address that already held an
  invitation is said only in the answer to the tap of whoever applied it, who may invite: the card and receipt the
  conversation reads never say it. With nobody new at the tap it is refused (`action_card.nobody_new`) and the card
  stays for a dismiss. The inbox row of a card sent on says that its person asks for a change in the workspace
  (`notifications.what.changeRequestAction`), never that they ask for a new agent. Once a card is applied the apps
  read the invitations and the keys again.
- **What the card names, at the tap.** A role renamed or deleted since the card was posted refuses the tap
  (`action_card.changed`) and the card, still pending, takes the roles as they are now, to be read again. Only the
  name is compared: what a role may do is not on the card. The same for a key renamed since its card was posted
  (a key replaced under the same id may take a new name). A refused tap makes the app read the card again, so
  whoever opened it from their inbox, outside its conversation, sees it as it is now before a second tap. A
  workspace on hold or being deleted refuses the tap with its own reason and leaves the card as it was, the asker's
  own included.
- **API keys.** Only someone who manages keys gets the card, and only in their own conversation with the right hand:
  a key's name stays out of conversations others read. A key an agent thinks with, or the workspace's default key, is
  refused before any card, and again at the tap if an agent came to think with it since. The card never releases
  agents from a key, as the key's screen can.

## Consequences

- Everyone gets the day's card by default, which was opt-in. It ships only together with §2, whose rule keeps it to
  days with something of the reader's own.
- A person's worst day is bounded per feature (one day's card, one week's card, two digests, three watch rows, one
  reminder push, three follow-through wakes, one welcome ever).
- Something a person was asked reaches their devices twice at most: when it is asked, and in the watch's one
  reminder of the day if they left it unread for four hours. The next morning's card lists it without a ring. With
  three or more approvals and the summary on, nothing rings after each approval's own notice.
- The watch's tells, and the right hand's turn on a handed task's end, come at any hour, as agents' own replies do.
  Only the reminder keeps to the person's daytime.
- No model call anywhere except §5's wakes and turns a person starts.
- `team_week` holds more than the weekly card. Renaming the column would be a migration that buys nothing.

## Addendum (2026-11-15): a retry is the failure it retried

§1's retry of a routine's first outside failure stays as decided: the right hand's, with "Cuidar da equipe" on, 15
minutes later, for a scheduled routine whose next slot is over an hour away, once between two good runs. Three things
change in how its outcome is counted and told.

- The retry's routine run is marked by its `dedupe_key`, `retry:<the failed routine run's id>`, with the `schedule`
  trigger (`routineRetryRunKey`, `isRoutineRetryRun` in `routine-state.ts`). An event's own key never comes with a
  scheduled run, so nothing else reads as a retry, and the unique key on `(routine_id, dedupe_key)` holds one retry
  per failed run whatever path closes that run, and however often. No migration.
- The retry's failure is the failure it retried: `failures_in_row` stays where the first failure put it (at least 1,
  `failuresAfter`), so a routine is paused as `failing` after five failed slots, not after two and a half. A widget's
  routine reads the same rule when it decides whether this failure is the one that pauses it. A run a person started
  in the retry's place, or the next slot when the retry never ran, is a failure of its own and counts as before.
- The held failure, told when the retry fails too, says so: `routine_failed` carries `latest.retried`, and its
  headline reads "couldn't run a routine, even after one more try" on the web, "Routine failed after one more try" on
  the phone and "A routine didn't finish, even after one more try" in the push. The line under it is still the coded
  reason. A held failure told at a person's run or at the next slot says nothing of a retry: none ran.

Left as they are: no retry without the right hand's switch, the 15 minutes, the hour of room, routines started by an
event, a webhook or "Rodar agora", and the causes outside the routine (`OUTSIDE_RUN_ERRORS`). Changing any of them is
a decision on §1 itself.

## Addendum (2026-11-15): the day ahead on the daily brief

"Resumo do dia" (§2) tells the reader what happened since the last card. A morning brief also says what the day
holds. That part is now on the same card, as a choice of the person's own.

- **The choice.** `agenda` in `organization_members.team_week`, read by `lodiPrefsOf` and `lodiPrefsSql` like the
  rest of §0, written through `setLodiPrefs` and `PUT …/team-week`. Off unless the person turns it on, and only
  while the day's card is on (`dayOff` stops both, so an older build's single stop still stops everything). No
  migration: it is one more key in the same JSON. The apps show its switch under "Resumo do dia" only when the
  server answers the key, so a new app on an older server shows nothing it cannot save.
- **What it reads.** `dayAgenda` (`packages/engine/src/day-agenda.ts`) reads the person's own calendar through
  `calendarRange`, the view the Calendar page draws, from the card's slot to midnight in the card's time zone (the
  person's own, else the workspace's). It keeps only what is theirs: meetings they attend and did not decline (a
  timed one starting in the window, an all-day one on that day), routines of agents they own (each routine once,
  however often it runs), and tasks due that local day held by them or one of their agents. The calendar's range
  keeps every UTC day the window touches, so deadlines are kept by the person's local date.
- **The row.** One `moreRows` row, `{ id: "today", kind: "today", meetings, routines, deadlines, first }`, first on
  the card and ahead of every other row's five-row limit. `first` is the first meeting's title, start and whether it
  is all day. Never an event's description, a routine's prompt or a task's text beyond what the reader's own
  calendar shows them. It is never in `seen`: each day's is its own.
- **When it posts and rings.** With the choice on, a day whose row is not empty posts the card even with nothing
  else new, and the card rings: the person asked for a brief at that hour. With it off, §2's rules hold unchanged
  (posting only for something new of theirs, ringing only for a run newly held). A day with nothing on the
  calendar and nothing new posts nothing, as before.
- **The apps.** The row reads "Hoje: 2 reuniões, 1 rotina e 1 tarefa com prazo", then the first meeting and its
  hour on the reader's own clock. On the web its button opens the Calendar. The phone has no calendar screen: the
  row is read on the card with no button. A build from before the row leaves it off (it travels in `moreRows`), so
  on such a build a card posted only for the day ahead shows its numbers and no row.
- **No model call.** The card stays built from stored data. A summary written by a small model when something is
  new was asked for and is not built: this ADR keeps model calls to §5's wakes and turns a person starts.

Later:

- A summary in words by a small model, only on days with something new, as its own switch: built, see the addendum
  of 2026-11-16.
- The person's reminders (`calendarReminders`) and calendar proposals waiting for them on the row.
- A calendar screen on the phone for the row's button, and asking the right hand for the day ahead through
  `set_team_week` (an `agenda` field).

## Addendum (2026-11-15): a failed task becomes the right hand's incident

A conversation task that failed for good reached its person only as a `run_failed` notification, and only that
person could try again, by asking once more. Most such failures pass by themselves (an AI provider's outage that
outlasted the run's waits, a computer or its coding CLI that stopped, an empty answer), and someone has to notice and
ask again. Now the right hand does, in the person's own DM with it, as the fifth lane: `incidents`
(`packages/engine/src/incidents.ts`).

- **When.** `reportRunFailure` (continuation.ts) calls `raiseIncident` for a conversation run that failed for good
  when all hold: the workspace's switch is on (`organization_settings.incidents`, migration 0302, on by default and
  on without a row, shown with the other two workspace switches and in `update_workspace`); its cause is one a later
  try may pass (`incidentCause`, an allowlist read from the stored error: a provider's `gave_up:` that isn't a key's
  refusal, a computer's failure or timeout, a CLI's, a brain cut off, an empty answer); a person is at the root of its
  request (`personOfMessage`); it is not the right hand's own, not long work (`workId`: `endWork` and Continuar own
  it), not in the agents' DM, and not woken by another agent's mention (that agent hears it and decides, as before);
  and `lodiFor` lets the right hand talk to that person. Once per failed run (`saidOnce`).
- **What it is told.** A `run_incident` notice, agent-only, in its DM with that person. Its text is the server's own
  words only (the agent's handle, the place, the cause's code and words, the run's id, the attempt and the retries
  left), never the stored error or the request, which may carry outside words. `refs.runId` is the failed run, so its
  turn is that person's through the existing authority walk (`returnsTo`); `authority.ts` is unchanged. At most
  `INCIDENT_WAKES_AN_HOUR` (3) notices a person an hour start a turn; past it they are written and read with the next
  one. The notice's guidance: the person was already notified, so retry when the cause may pass and tries are left
  and say so in a line, explain in a sentence or two when tries are used up, and otherwise pass.
- **`retry_run`** (`run_id`, `why`, the latter kept only in the audit row, never shown to the other agent): the right hand's, in the core group, offered while the switch is on, refused
  anywhere but a person's own DM with it (`rightHandReader`). It retries only a run whose incident was told in that
  DM, still `failed`, whose agent may still answer that person there, with no newer run of that agent in that
  conversation, asked by that run's own person while still a member. It posts a `run_retry` notice under the failed run's
  root (its request, or its thread's root: a run reads its root whole, so the request is in the new run's context
  however much the channel said since, where the main timeline's last messages could have left it out), as that agent, with `refs.runId` the failed run (so the new run is the same person's, with the same
  request in its context) and a fresh stretch (hop 0, like a person's ask), which starts the new run. People there see
  a quiet line ("Lodi asked Dev to try again", `chat.notice.runRetry`). Limits: once per failed run, `RUN_RETRIES` (2)
  per chain (the attempt is read from the trigger's `run_retry` notice), `RETRIES_AN_HOUR` (3) per person. Audited as
  `run.retried`. The right hand is not woken for the result: a retry that fails again is a new incident, with its
  attempt counted. In the run policy it speaks elsewhere (`ELSEWHERE`).

Later: failures with nobody at the root (a routine's report woke the run, an agent's own work), told to the
accountable person; runs a server restart interrupted (`recovery.ts` fails them without `reportRunFailure`); a
retry that resumes the failed run's transcript instead of starting fresh; incidents shown together on the right
hand's page.

## Addendum (2026-11-16): "Tentar de novo uma vez se falhar", a routine's own switch

What §1 decided, and why: a routine's retry is one of the right hand's fixes, so it happens only where a workspace
turned "Cuidar da equipe" on, 15 minutes after the first outside failure since a good run, for a scheduled routine
whose next slot is over an hour away, and once between two good runs. The reasons are cost and noise: a run is
paid for on the agent's budget, a routine that keeps failing must not be retried in a loop, and nobody should be
told of a failure that may heal by itself. None of them is about security or privacy.

What the switch adds: each routine has `retry_once` (migration 0313), off by default, turned on and off by whoever
may edit the routine, in the routine's editor on the web and the phone ("Tentar de novo uma vez se falhar", shown
for a repeating schedule). With it on, any run of the scheduled routine that fails for a cause outside it (the same
`OUTSIDE_RUN_ERRORS`, or a run that never started) is queued once more 2 minutes later, with or without the right
hand, when its next slot is over 10 minutes away (closer, the slot itself is the retry) and the failure doesn't pause
it. It uses the 2026-11-15 rules as they are: the retry is marked by `dedupe_key = retry:<failed run>`, so a failed
run gets one retry however often it is closed, a retry is never retried, its failure is the failure it retried in
`failures_in_row`, and the streak's first failure is told once, when the retry fails too, saying it was tried again.
The streak's first failure held for the switch's retry carries the same mark as one the right hand holds
(`routineRetryKey`, written with the retry in one transaction), so it is told at the streak's next failure whichever
run that is: the retry, a run a person started in its place, or the next slot when the retry never ran.

Why off by default keeps §1: with the switch off, nothing above runs and a routine behaves exactly as §1 and the
2026-11-15 addendum say, which their tests keep describing. Turning it on is a person's choice for one routine,
made where they see it, so the cost of one more run per failed slot is theirs to take. The loop §1 guards against
still can't happen: one retry per slot, never a retry of a retry, and the fifth failed slot in a row still pauses
the routine as `failing`. With the switch on and "Cuidar da equipe" on too, the switch's retry comes first and the
right hand's is not added to it.

Still not done: a retry of a failure of the routine's own (a refused key, no credit, a budget used up, a tool loop,
no report), more than one retry per slot, and a retry of a routine started by an event, a webhook or an email, or of
a one-off.

## Addendum (2026-11-16): a summary written by the AI, as the person's choice

**What this ADR decided, and why.** Each of the seven features "calls no model unless a person is waiting for the
answer" (Context), and the daily brief is "from stored data" (§2): no model call anywhere except §5's wakes and turns a
person starts (Consequences). The reason is cost and predictability. The right hand posts to every member of every
workspace by default, and an unasked model call per card would spend a workspace's money and AI every morning for
people who never asked for it. It is not a privacy rule: §2's privacy lines are about what the card may hold (nothing
from a conversation the reader cannot read, never a run's or a question's text, a cause in place of an error), and
those stay as they are below.

**What the option adds.** "Resumo escrito pela IA" (`aiSummary` in `organization_members.team_week`), the person's own
switch under "Resumo do dia". With it on, the day's card opens with a short paragraph (`summary` on the card, two or
three sentences) a small model writes from the facts the card already lists (`day-summary.ts`):

- **The facts are the card's.** Its counts, the names of the agents and conversations on it, the titles its rows carry
  (a task's, a how-to's, the first meeting's), each row's cause word. Nothing the card does not show reaches the
  model: no message, no question, no run text, no error. They go as outside data (`untrustedBlock`), and the prompt
  says to use only them and to follow nothing inside them.
- **Through the Model Gateway, as the right hand, for the reader.** `gateway.stream` with the right hand's agent at the
  small model of its own line (on Automático, the line its key or the workspace's answers from): its budget reserved
  and the reader's month (ADR 0141) checked before the call, the usage recorded with `org_id`, `agent_id` and the
  person. No key for that model, the budget spent, an error or no answer in 20 s: no paragraph, and the card goes out
  as it is, at the same hour.
- **Only on a card that goes out anyway.** The paragraph never posts a card, never rings, and changes no row.
- Kept apart from §0's `LodiPrefs` (`aiSummaryOf`): those are what the right hand does with no model call, and the
  sweeps read them in SQL; this one only the day's job reads, once its card is built.

**Why off by default keeps the decision.** With the switch off, which is everyone until they turn it on, the card is
exactly §2's and no model is called. The person who turns it on is the person who asked for the call, the case this
ADR always allowed ("unless a person is waiting for the answer"), and it is paid from the budget the right hand
already answers them with.

**What stays forbidden.** A model call for anyone who did not turn it on, and for the week's card, the watch, the
digest, the reminders and the welcome. A model writing or choosing rows, or deciding whether a card goes out. Any text
on the card's facts that the card itself does not show.
