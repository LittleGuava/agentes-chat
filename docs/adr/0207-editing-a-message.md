# 0207. Editing a message, and editing it to redo the agents' answer

- Status: Accepted (2026-11-15; built: engine, server, the shared client, the web app; the phone hears edits live but has no Edit yet)
- Date: 2026-11-15
- Extends: ADR 0008 (agent runs), ADR 0010 (realtime), ADR 0089 (stretches), ADR 0128 (stopping a task)

## Context

`messages.edited_at` has been in the schema since the first migration, but nothing wrote it and no route changed a
message's text. People fix typos, and they often want to ask an agent the same thing better instead of sending a second
message under the first answer. Two things make an edit harder here than in a chat with one assistant:

- A conversation has several people and agents. Cutting the conversation at the edited message and answering again,
  the way a one-to-one assistant does, would remove what others said.
- An agent's run keeps its conversation as an append-only transcript (`executor.ts`), and later runs read the
  conversation from `messages`. If a message changed under an answer it already got, the next run would read a question
  and an answer that don't match, and nothing would say why.

`agent_runs` also allows one run per message and agent (`unique (trigger_message_id, agent_id)`), so the edited message
can't start a second run of the same agent.

## Decision

1. **Who and when.** `PATCH /api/app/organizations/{orgId}/messages/{messageId}` with `{ body, redo? }`
   (`editMessage`, `message-edit.ts`). Only the message's author (403 `message.edit_not_yours`), only a person's
   message, within a day of sending it (`MESSAGE_EDIT_WINDOW_MS`, 409 `message.edit_expired`), not a voice message
   (its words are its recording's), an answer to an agent's question (already taken by the run it resumed) or a notice
   (409 `message.not_editable`). The text is checked as a new message's (empty unless it has files or media,
   `message.too_long`). The same text again changes nothing. The rate limit is posting's.
2. **What changes.** `body` and `edited_at`, the message's wiki links, and its search document (a `search.index` job).
   Its mentions stay as they were: an edit wakes nobody and notifies nobody. `MessageView.editedAt` carries the time,
   and the apps show "editada" beside the time, with the date in its tip.
3. **Realtime.** A new channel event, `message.edited` (`channelId`, `messageId`, `threadId`, `body`, `editedAt`). It
   isn't `message.created` again: that replaces the apps' whole copy (its reactions, receipts and pins until a refetch)
   and publishes `channel.activity`, which would count an old message as unread for everyone. The apps patch the text
   and time in every cached list of the channel (`cacheMessageEdited`).
4. **A message an agent took isn't edited under its answer.** A message is taken once a run started on it, or it
   reached an agent's task at work (`meta.steeredRunIds`). Then a plain edit is refused (409 `message.edit_answered`),
   checked again inside the `UPDATE`, so a run that starts meanwhile still refuses it. The app offers only "Editar e
   refazer a resposta" (`redo: true`).
5. **Edit and redo.** Only on the last message a person sent in that conversation (its thread, or the timeline: 409
   `message.redo_not_latest`), so nobody's later words lose their place. The message is edited as above. Then, for each
   agent that took it:
   - a run started on this message and still active stops (`cancelRun`, without telling the agent, since the notice
     below says why). A task at work it was sent into is not stopped: it was working on someone's earlier message too.
   - a `message_edited` notice goes to that agent where it answered (`deliverNotice`), with what the message said and
     what it says now (each up to 4,000 characters). It joins the agent's task at work there, or starts a run in a fresh
     stretch, since a person asked (`granted`, ADR 0089). The notice's `refs.runId` is the run that took the message,
     so the new run acts for the same person (`authority.ts`).
   The answers already given stay where they are. The notice is quiet (`QUIET_NOTICES`): people see one line, "Ana
   editou a mensagem e pediu outra resposta a Dev", and it is never news (no unread, notification or search).
6. **What agents read.** No agent ever reads the old text as the current one, and nothing is rewritten:
   - A run's transcript is append-only. A run that took the old text either stops (point 5) or, as a task it was sent
     into, reads the notice at its next step. Its transcript keeps the old words where they were and gets the edit after
     them, never a silent replacement.
   - A new run reads the conversation from `messages`: the message as it is now, the earlier answer, then the notice
     that says it was edited and what it said before (`noticeText`), so the earlier answer reads as an answer to the old
     words.
   - An edit nobody's run took needs no notice: no answer depends on the old words.
7. **Audit.** `message.edited` in `audit_log`, target the message, with the lengths before and after, `redo`, and the
   agents asked again. Never the words: an admin reads the audit log but not every conversation (ADR 0151).

## Consequences

- The old answers stay visible with the edit's line under them, so the conversation shows what happened. The cost is a
  longer conversation than a replace would leave.
- `deliverNotice` takes the run's start options (`start`), used here for `granted`.
- A new notice kind, mirrored in the apps (`NOTICE_KINDS`), and a new channel event, mirrored in the client's
  `ChannelEvent`.

## Later

- The phone app: Edit in the message's menu and the "editada" mark (it already applies `message.edited`).
- Editing a message's files, quote or media, and deleting a message.
- An edit history people can open.
