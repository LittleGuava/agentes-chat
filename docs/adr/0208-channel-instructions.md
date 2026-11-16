# 0208. A channel's instructions for its agents

- Status: Accepted (built)
- Date: 2026-11-15
- Amends: ADR 0008 (a run's fixed context gains the channel's instructions)
- Code: column `channels.instructions` (migration 0283); engine `management.ts` (`updateChannel`: the limit,
  `channel.instructions_changed` in the audit log), `channels.ts` (`CHANNEL_INSTRUCTIONS_MAX`, `listChannels`),
  `context.ts` (`buildRunContext`: the "# Instructions for this channel" block and `sessionPrompt`); routes
  `PATCH /api/app/organizations/{orgId}/channels/{channelId}` (`instructions`) and the channel list; web the channel's
  settings (Visão geral); tests `management.test.ts`, `context.test.ts`, `apps/server/test/channel-instructions.test.ts`

## Context

A team often wants every agent in one channel to work the same way there: answer in English in #support, link the
ticket in every answer in #incidents, never promise a date in #sales. Until now the only places for that were each
agent's own instructions (one agent at a time, and they hold in every channel) and the channel's topic, which goes into
the "Where you are" line as a short description, not as something to follow. Memory scoped to a channel is what agents
learned, not what people set.

## Decision

1. **A text per channel, set by who manages it.** `channels.instructions` (text, empty by default) is changed through
   the same `PATCH` as the name and the topic, by the same people: the channel's creator, administrators and who holds
   `manage_channels` there (`managesChannel`). Channels only: a DM is refused as before, and a task's conversation
   (`kind = 'task'`) too, since its runs follow their task.
2. **At most 4000 characters, trimmed.** Every run in the channel reads them whole, so they stay a brief of about a
   thousand tokens. The route's schema and the engine both hold the limit (`CHANNEL_INSTRUCTIONS_MAX`); the web field
   counts it as the server does (`FIELD_LIMITS.channelInstructions`).
3. **Trusted, like the agent's instructions and the organization's context.** They are written by people of the
   workspace with the right to change the channel, the same trust as whoever wrote the agent's instructions or the
   organization's context, which `context.ts` puts in the prompt as they are. So they are not wrapped in
   `untrustedBlock`, which is for what anyone outside can write (pages, mail, tool output). They come with one line
   that keeps them under the rules: they never change the rules, the agent's permissions or what needs a person's
   approval.
4. **A section of their own, held for the conversation.** "# Instructions for this channel" follows the agent's block,
   its capabilities, team and skills, marked `conversation`: the model brain reads it in its system prompt after the
   cache breakpoint of the agent's settings, and a computer brain reads it once in "# This conversation" when its
   session starts, so its system text stays the same in every conversation of the agent. Their text is part of
   `sessionPrompt` when there is any, so a change starts a new computer session in that channel instead of leaving it
   on the old text; a channel without them keeps the key it had.
5. **Audited without their text.** A change writes `channel.instructions_changed` (target and `channel_id` the
   channel; `details`: its name and the new length), never the text itself, as `agent.updated` leaves out an agent's
   instructions. The same text again writes nothing.
6. **Read where the channel is read.** The channel list returns `instructions`, so the apps can show members what their agents
   are told there; the web edits them in the channel's settings (Visão geral), which only who manages it opens.

## Consequences

- Every agent in a channel follows the same brief there without anyone editing each agent.
- Text in a run's context grows by up to 4000 characters in channels that use it, and never elsewhere.
- The phone shows no field for them yet: it has no screen that edits a channel's description either. Setting them there
  comes with that screen.
