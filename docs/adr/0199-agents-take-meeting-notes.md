# 0199. Agents join online meetings and take notes

- Status: Proposed (2026-11-15). Built: the server's first slice (§9): `join_meeting` with its link rules, the join steps in the agent's own browser, the `agent_meetings` table (migration 0305) and the notes notice at the end, all run against a fake screen and a fake transcript. Not offered to any agent yet: nothing hears a meeting until the computer's listener (§4) exists, and an agent sitting silently in a call that never gets notes is worse than no agent. The pages' labels and Jitsi's URL options in §3 come from how Google Meet and Jitsi Meet present themselves today; no real meeting was joined.
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
- One live meeting per agent (a partial unique index on `agent_meetings`): its browser has one page in front. A meeting live for more than four hours is closed as `timed_out` when the agent is sent to another.

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

### 4. Hearing the meeting (Later, protocol 79)

The computer's runner hears the call; the server never receives raw audio from a browser it doesn't run.

- `MeetingListener` is the engine's interface: `listen(meeting)` starts capture on the agent's computer after the join; without one, `join_meeting` isn't offered at all.
- On the runner (machine protocol 79): `meeting.listen { meetingId, agent }` records the agent browser's tab audio only (PulseAudio's monitor of the agent's own sink on Linux, which the agent's desktop session already has, ADR 0058), cut at pauses into short pieces; `meeting.leave`; events `meeting.state` (`waiting`, `in_call`, `ended` when the page says the call ended or the bot was removed) and `meeting.piece` (audio piece, start time, the speaker the page highlights at that moment).
- Transcription goes through the speech chain of ADR 0100 (`SpeechEngine`, the workspace's own key or server first), on the server, so no provider key ever reaches the computer. Pieces are transcribed as they come and kept only as text; the audio is dropped once its words exist.
- A call stops after four hours, and when everyone else has left.

### 5. Telling the people in the call

Before anything is captured, the bot posts one line in the meeting's chat: "Hi, I'm <agent> (notes) from agentes.chat, taking notes for <person>. Type "@notes stop" and I'll leave." If the line can't be posted (the chat is off, the host blocked it), the bot leaves without capturing. "@notes stop" in the meeting chat, the host removing the bot, or the person who asked pressing Leave ends capture at once; what was captured until then still becomes notes, and the line says so. This is the listener's first step (§4), so it is Later with it.

### 6. Consent and the law

- The person who asks answers for having a bot in the call, as they would for recording it: the tool's description says so, and the notes name them.
- The bot never joins hidden: its name says "(notes)" and the chat line (§5) comes before any capture. A host who doesn't admit it, or removes it, wins.
- Brazil's LGPD (personal data of everyone who speaks) and recording rules elsewhere differ: the workspace's owner turns meeting notes on (a workspace setting, off by default, Later with the listener), and the setting's text says that some places require every participant's consent and that the host must be told. The transcript is the workspace's data like any message; it is not used for anything but the notes and is deleted with the conversation.
- Never the person's own Chrome or a signed-in profile: the bot is a guest, as any other participant can see.

### 7. The notes (built)

`finishMeeting` (called by the listener's `ended`, and by tests with a fake transcript) does, in one transaction:

1. moves the meeting from a live state to `ended` (`update … where status in live … returning`): a second call finds nothing and posts nothing;
2. `deliverNotice` with kind `meeting_ended` in the conversation and thread where the agent was asked, `readOutside: true`, and the notice message's id kept on the row.

The notice's text is the transcript, one line per piece (`[mm:ss] Speaker: words`); the agent reads it inside `untrustedBlock` with what to write. Up to 60 000 characters are handed to the agent; past that the start is kept and the notice says how much was cut and that the notes cover only that part. People read the notice as a line of the app's own ("The meeting Ada took notes in has ended", `chat.notice.meetingEnded`, every language), never the transcript or the agent's text; the meetings card (Later) will carry the transcript as a file.

### 8. Data

`agent_meetings` (migration 0305): `id`, `org_id`, `agent_id`, `channel_id`, `thread_id`, `run_id`, `requested_by_user_id`, `platform` (`google_meet`, `jitsi`), `url` (the rebuilt address), `display_name`, `status` (`joining`, `waiting`, `in_call`, `ended`, `failed`), `error`, `joined_at`, `ended_at`, `notice_message_id`, `created_at`. One live row per agent (partial unique index on `agent_id` where `status` is `joining`, `waiting` or `in_call`).

### 9. The first slice (built)

- `packages/engine/src/meetings/links.ts`: `parseMeetingLink`, `meetingDisplayName`, `meetingJoinUrl`, `meetingJoinSteps`, `meetingStateOf`.
- `packages/engine/src/meetings/tool.ts`: `createMeetingToolSource({ browser, listener })`: `join_meeting` (scope `browser:use`), offered only when both are given.
- `packages/engine/src/meetings/notes.ts`: `finishMeeting`, `meetingTranscriptText`.
- `packages/engine/src/browser/tools.ts`: the browser source also returns its `plan` (as it returns `readPage`), with `own` to skip a shared profile.
- `notices.ts`: kind `meeting_ended`, mirrored in the apps' `NOTICE_KINDS` (`packages/client/src/lib/notices.ts`) with its line in every language.
- `apps/server/src/engine.ts` wires the source with the browser and no listener: nothing is offered.

## Later

- The listener (§4) on the runner, protocol 79, and the meeting chat line (§5).
- The workspace setting (§6) and its text; a "Leave meeting" tool and button; the live card in the apps (waiting, in the call, ended) with the transcript as a Drive file.
- The notice's body ("Meeting ended (Google Meet, 42 min, 3 people spoke). Notes follow.") is English where a body shows as it is (a conversation's preview, a push): a `bodyCode` with its words in every language, as GitHub events have.
- "@notes <question>" answered in the meeting chat, sent as any message the agent sends for the person.
- Microsoft Teams (its guest page refuses brackets in names), self-hosted Jitsi servers named by the workspace, Zoom's web client.
- A calendar routine that joins the person's meetings as they start, opted in per calendar.
- Meetings on a person's own Mac or PC.

## Consequences

- An agent can be sent into a meeting only by a person, only from its own browser, with a name that says what it is, and the steps stop before joining if the microphone or the name can't be set.
- No audio is captured by this slice, so it is not offered; the next step is the runner's listener, which turns the tool on where a computer serves it.
- The transcript reaches the model only as outside data; the notes are the agent's reply, so they count against its budget like any reply (no model call of its own).
