# 0199. Agents join online meetings and take notes

- Status: Proposed (2026-11-15). Built: the server's first slice (§9), then the listener (§4, protocol 79), the meeting chat line (§5), the workspace switch (§6), "Leave meeting" as a tool and a button, and the transcript into the notes (migration 0278, §10). Offered only where the workspace turned meeting notes on, the server has a speech engine and the agent's computer hears calls. All of it runs against a fake screen, a fake computer and a fake speech engine; no real meeting was joined and no real audio was heard, so the pages' labels (§3, §5) and PulseAudio's behaviour with the agent's Chrome come from how they present themselves today.
- Date: 2026-11-15
- Extends: ADR 0040 (the agent browser), ADR 0054 (the screen layer: plans, targets in words), ADR 0100 (voice messages: the speech chain), ADR 0117 (outside text reaches models only as data), ADR 0053 (who is behind a run)

## Context

People ask an agent to "join this call and take notes". Today an agent can open a meeting's page in its own browser (`browser_do`), but nothing tells the people in the call that a bot is listening, nothing hears the call, and the notes have no place to land. A meeting is also the most sensitive thing an agent's browser can open: other people's voices, often people outside the workspace, who never agreed to talk to an agent.

## Decision

### 1. What a person sees

- They ask an agent, in any conversation, to join a Google Meet or Jitsi Meet link. Zoom and Microsoft Teams links get a plain "not supported yet"; anything else is not a meeting link.
- The agent joins from its own browser (never a shared, signed-in profile) as **"<agent name> (notes)"**, microphone and camera off, and waits for the host to let it in.
- When the meeting ends, a notice in the conversation carries the transcript to the agent, which writes the notes as its reply: a short summary, decisions, action items with owners, open questions and who spoke. People see the notice and the agent's notes; the agent reads the transcript as outside data.

### 2. Who may send an agent into a meeting

- Only a run a person is behind (`personBehindCall`, ADR 0053). A routine, an unattended run or a run a routine's report woke is refused by the tool itself: the run policy table lets `browser:use` tools through for routines, and joining a call speaks for someone. "Join my meetings as they start" (a calendar routine) is Later, and will need the person's own opt-in per calendar, not a routine's.
- The scope is the browser's (`browser:use`): an agent that can't use a browser can't join. No new scope: joining is the browser opening one page with fixed steps, and the meeting's own host still decides whether the bot comes in.
- One live meeting per agent (a partial unique index on `agent_meetings`): its browser has one page in front. A meeting live for more than four hours is closed when the agent is sent to another: what was heard of it becomes notes, and one with nothing heard ends as `timed_out`.

### 3. Links and the join steps

`parseMeetingLink` (pure) accepts only:

- `https://meet.google.com/<abc-defg-hij>`: the host exactly, a meeting code (three, four and three letters), nothing else in the path (`/new`, `/lookup/…` are refused). Query and fragment are dropped.
- `https://meet.jit.si/<room>`: the host exactly, one path segment of letters, digits, `-` and `_` (3 to 128).
- https only, no user name or password in the link, no port. What is opened is the address rebuilt from the parsed parts, never the text the model gave.

The steps (`meetingJoinSteps`) go through the browser's plan (`browser_do`'s own `plan`, ADR 0054) with `own: true`:

- Google Meet: open; fill "Your name" with the display name; click "Turn off microphone"; click "Turn off camera"; click "Ask to join". The name step comes first and is required: a browser signed in to a Google account shows no name box, so the plan stops there and the agent never joins as a person's account. A step that fails stops the plan, so the join button is never pressed with the microphone on.
- Jitsi Meet: open the room with `#config.startWithAudioMuted=true&config.startWithVideoMuted=true&userInfo.displayName=<name>` (the name JSON-encoded, then URL-encoded, so a name can't add options); fill "Enter your name"; click "Join meeting". Microphone and camera are off by the room's own options: clicking a toggle that is already off would turn it on.
- The display name is the agent's name, cleaned of control characters and quotes, cut to 60 characters, followed by " (notes)": the name itself tells everyone in the call what the bot is for.

After the plan, the page is read once (`meetingStateOf`): "asking to be let in" is `waiting`, a leave button is `in_call`, Google Meet's "You can't join this video call" (it often refuses guests from data-centre networks) is a failure the agent says plainly, anything else is `waiting`.

### 4. Hearing the meeting (built, protocol 79)

The computer's runner hears the call; no provider key reaches the computer and the server keeps no audio.

- `MeetingListener` is the engine's interface: `available(ctx)` (the workspace's switch, §6; a speech engine; the agent's computer hearing calls with the browser on) decides whether `join_meeting` and `leave_meeting` are offered at all, and `listen(meeting)` runs after the join steps. It waits to be let in (up to two minutes, the page's leave button showing; past that the bot leaves, `not_admitted`), posts the chat line (§5), and only then asks the computer to hear.
- The runner says whether it can in its hello (`hello.meetingAudio`: `available`, or a code and a reason): Linux, `pactl` and `parecord` against PulseAudio or PipeWire's pulse server, and a single-user runner. A system-mode runner (one OS user per agent) says `meeting_audio_system_mode`: the agent's Chrome plays into the agent's own user's sound server, which root's capture would need to reach through the agent's launcher (Later).
- Ops (machine protocol 79): `meeting.listen { meetingId, streamId }` loads a null sink only for that meeting (`agentes_meeting_<agent>`), moves into it every sink input whose process descends from the agent's own Chrome (checked every two seconds: a tab's audio process comes and goes), records the sink's monitor at 16 kHz mono and dials a data socket of kind `meetingAudio` with the server's `streamId`; `meeting.stop { meetingId }` ends it. Nothing else on the computer is heard: other programs stay on their own sinks.
- Pieces are cut at a pause (600 ms of quiet after at least 5 s of sound, at most 30 s, at most 1 MiB) and sent as binary frames (`encodeMeetingPiece`: a version byte, a header with the piece's number, start and length, then a WAV); silence alone sends nothing. The end is a text frame `meeting.end` with its reason: `stopped`, `silence` (ten minutes with nothing heard: everyone left), `max` (four hours) or `failed`. Then the sink is unloaded.
- The server's broker hands the socket to `MeetingAudio.claim` (`packages/engine/src/meetings/audio.ts`), held in this replica's memory as the live browser views are. Each piece goes through the speech chain of ADR 0100 (`firstWords`, the workspace's key or the server's), in order; its words are appended to `agent_meetings.transcript` and its cost to `cost_nano_usd`, and the audio is dropped. When the capture ends, or the socket closes without an end, the queue drains and `finishMeeting` delivers the notes; any end but `stopped` also closes the agent's browser, so the bot leaves the call.
- A server restart loses the capture, not the words: the transcript is on the row, and "Leave meeting" or the four hours' release (§2) still turns it into notes.
- Who spoke is not known yet: the transcript's lines carry no speaker (`[mm:ss] words`) and the notes don't guess. The page's highlighted speaker is Later.

### 5. Telling the people in the call

Before anything is captured, once the host let it in, the bot posts one line in the meeting's chat (`meetingAnnouncement`): "Hi, I'm <agent> (notes), an AI agent from agentes.chat taking notes for <person>. What is said from now on is transcribed for those notes. If you don't agree, ask <person> or the host to remove me." It promises no command: nothing reads the meeting's chat yet. The steps (`meetingAnnounceSteps`) open the chat ("Chat with everyone" on Google Meet, "Open chat" on Jitsi), type the line, press Enter, and wait for its first words to show on the page; if any step fails (the chat is off, the host blocked it), the bot leaves without capturing (`not_announced`).

The capture ends when anyone who reads the conversation presses "Leave meeting" on the agent's line (`meeting_joined`, a quiet notice that wakes nobody), when the agent calls `leave_meeting` (still offered while it is in a meeting, after the switch goes off or its computer stops hearing), or by the computer's own ends (§4); what was heard until then still becomes notes. Leaving stops the capture (`meeting.stop`), closes the agent's browser (`browser.stop`), waits up to 20 s for the last pieces' words and delivers the notes. The host removing the bot is heard as silence, which ends it after ten minutes; reading the page's "You've been removed" is Later.

### 6. Consent and the law

- The person who asks answers for having a bot in the call, as they would for recording it: the tool's description says so, and the notes name them.
- The bot never joins hidden: its name says "(notes)" and the chat line (§5) comes before any capture. A host who doesn't admit it, or removes it, wins.
- Brazil's LGPD (personal data of everyone who speaks) and recording rules elsewhere differ: whoever configures the workspace turns meeting notes on (`organization_settings.meeting_notes`, off by default; Settings › General, "Agents take meeting notes"), and the setting's text says that some places require every participant's consent and that the host must be told. The transcript is the workspace's data like any message; it is not used for anything but the notes and is deleted with the conversation.
- Never the person's own Chrome or a signed-in profile: the bot is a guest, as any other participant can see.

### 7. The notes (built)

`finishMeeting` (called by the listener's `ended`, and by tests with a fake transcript) does, in one transaction:

1. moves the meeting from a live state to `ended` (`update … where status in live … returning`): a second call finds nothing and posts nothing;
2. `deliverNotice` with kind `meeting_ended` in the conversation and thread where the agent was asked, `readOutside: true`, and the notice message's id kept on the row.

The notice's text is the transcript, one line per piece (`[mm:ss] Speaker: words`, or `[mm:ss] words` while the speaker isn't known, §4); the agent reads it inside `untrustedBlock` with what to write. Up to 60 000 characters are handed to the agent; past that the start is kept and the notice says how much was cut and that the notes cover only that part. People read the notice as a line of the app's own ("The meeting Ada took notes in has ended", `chat.notice.meetingEnded`, every language), never the transcript or the agent's text; the meetings card (Later) will carry the transcript as a file.

### 8. Data

`agent_meetings` (migration 0277): `id`, `org_id`, `agent_id`, `channel_id`, `thread_id`, `run_id`, `requested_by_user_id`, `platform` (`google_meet`, `jitsi`), `url` (the rebuilt address), `display_name`, `status` (`joining`, `waiting`, `in_call`, `ended`, `failed`), `error`, `joined_at`, `ended_at`, `notice_message_id`, `created_at`. One live row per agent (partial unique index on `agent_id` where `status` is `joining`, `waiting` or `in_call`). Migration 0278 adds `machine_id` (the computer hearing it, set null when the computer goes), `transcript` (the lines heard so far, jsonb) and `cost_nano_usd` (the speech engine's cost), and `organization_settings.meeting_notes`.

### 9. The first slice (built)

- `packages/engine/src/meetings/links.ts`: `parseMeetingLink`, `meetingDisplayName`, `meetingJoinUrl`, `meetingJoinSteps`, `meetingStateOf`.
- `packages/engine/src/meetings/tool.ts`: `createMeetingToolSource({ browser, listener })`: `join_meeting` (scope `browser:use`), offered only when both are given.
- `packages/engine/src/meetings/notes.ts`: `finishMeeting`, `meetingTranscriptText`.
- `packages/engine/src/browser/tools.ts`: the browser source also returns its `plan` (as it returns `readPage`), with `own` to skip a shared profile.
- `notices.ts`: kind `meeting_ended`, mirrored in the apps' `NOTICE_KINDS` (`packages/client/src/lib/notices.ts`) with its line in every language.
- `apps/server/src/engine.ts` wired the source with the browser and no listener, so nothing was offered until the second slice (§10).

### 10. The second slice (built)

- Protocol 79 in `packages/adapters/src/machine-protocol.ts`: `hello.meetingAudio`, `meeting.listen`/`meeting.stop`, `MEETING_AUDIO`, `encodeMeetingPiece`/`decodeMeetingPiece`, `parseMeetingEnd`.
- Runner: `apps/server/runner/meeting-audio.ts` (`MeetingAudio`, `PieceCutter`), routed in `handlers.ts`, its data socket kind in `streams.ts`, started and stopped with the session in `daemon.ts`.
- Engine: `packages/engine/src/meetings/audio.ts` (`agentMeetingAudioStatus`, `createMeetingAudio`: listener, claim, `leave`, `leaveAs`); `tool.ts` adds `leave_meeting`; `links.ts` the chat line and its steps; notice `meeting_joined` (quiet, wakes nobody).
- Server: `POST /api/app/organizations/{orgId}/meetings/{meetingId}/leave` (`apps/server/src/routes/app/meetings.ts`); `meetingNotes` in the workspace's settings.
- Apps: "Leave meeting" on the `meeting_joined` line (`ChatNotices.tsx`), the switch in Settings › General, every language. The phone shows the line without the button.

## Later

- Capture on a system-mode computer (each agent its own OS user, so agentes.chat Cloud's computers): root reaching the agent's sound server through its launcher.
- Who spoke: the page's highlighted speaker with each piece, and the page's own states ("removed", "call ended") instead of ten minutes of silence.
- "@notes stop" and "@notes <question>" read from the meeting chat.
- "Leave meeting" on the phone; whether a computer hears calls on its page in the apps; the live card (waiting, in the call, ended) with the transcript as a Drive file.
- The notice's body ("Meeting ended (Google Meet, 42 min, 3 people spoke). Notes follow.") is English where a body shows as it is (a conversation's preview, a push): a `bodyCode` with its words in every language, as GitHub events have.
- "@notes <question>" answered in the meeting chat, sent as any message the agent sends for the person.
- Microsoft Teams (its guest page refuses brackets in names), self-hosted Jitsi servers named by the workspace, Zoom's web client.
- A calendar routine that joins the person's meetings as they start, opted in per calendar.
- Meetings on a person's own Mac or PC.
- Fair use on agentes.chat's servers: ADR 0100's limits count voice messages only, so a meeting's minutes (up to four hours on the platform's speech key) are capped by nothing but the switch; they should count against the same daily minutes, and a workspace put on hold mid-call should stop its capture.

## Consequences

- An agent can be sent into a meeting only by a person, only from its own browser, with a name that says what it is, and the steps stop before joining if the microphone or the name can't be set.
- The tools are offered only where a workspace turned meeting notes on, a speech engine exists and the agent's single-user Linux computer hears calls: off everywhere by default, and off on agentes.chat Cloud's system-mode computers until capture works there.
- Nothing is heard before the people in the call were told in its chat; when that fails, the bot leaves.
- A capture lives in one replica's memory: a restart loses the rest of the call, never the words already transcribed.
- The transcript reaches the model only as outside data; the notes are the agent's reply, so they count against its budget like any reply (no model call of its own).
