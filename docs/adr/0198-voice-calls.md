# 0198. Voice calls with an agent, by turns

- Status: Accepted
- Date: 2026-11-15
- Code: `packages/adapters/src/call-voice.ts`, `packages/engine/src/voice-call.ts`, `apps/server/src/routes/app/voice.ts`, `packages/client/src/lib/voice-call.ts`, `packages/ui/src/components/call-turn.ts`, `apps/web/src/components/VoiceCall.tsx`

## Context

People already talk to agents with voice messages (ADR 0100): they record, the server turns the recording into words,
and the agent answers in text. Some want a conversation they can hold with their hands and eyes busy: speak, hear the
answer, speak again, without touching the screen between turns. That is a call.

A call in real time, both sides speaking at once, needs streaming speech both ways and an echo-cancelled microphone,
and it would make the model's turn the call's clock. An agent's turn takes 5 to 60 seconds of tools; the time to make
out the words or to make the audio is a small part of it. So a call by turns, built on what voice messages already do,
gives nearly the same conversation for a fraction of the parts.

## Decision

### 1. A call is a loop of voice messages and replies read aloud

A call joins pieces that exist or are small:

1. **Listening.** The app records a take with the kit's recorder (the same `MediaRecorder`, echo cancellation and
   noise suppression as a voice message).
2. **The turn ends on silence.** Once speech was heard, 1.2 s of quiet ends the take (`turnEnded`,
   `packages/ui/src/components/call-turn.ts`): speech is a level above 0.12 held for 250 ms without a break, which a
   room's hum, a click or a knock doesn't reach. A take with no speech for 12 s starts again (`listenAgain`), so the
   silence before someone speaks is never sent, and one that reaches the voice message's 5 minutes goes as it is.
   "Pronto" (or Space) ends it at once once there was speech, for a noisy room. Levels are read on a timer, not on
   animation frames: a tab in the background keeps listening, if on the browser's slower beat.
3. **The take is a voice message.** It goes through `useSendVoice` and the voice route, so it is stored, turned into
   words by the job, posted through `postPersonMessage` and seen by everyone in the conversation as a voice message
   (ADR 0100 §1, §4). Nothing new is posted: the call leaves the same history as recording by hand.
4. **Waiting.** The agent answers as it always does. The call reads the conversation's messages and live runs.
5. **Speaking.** Each agent message posted after the take, in the server's order, is read aloud: the app asks the
   server for its audio (`POST …/messages/{messageId}/speech`) and plays it. Then the call listens again.

Half duplex on purpose: the microphone is closed while the agent speaks, so the agent never hears itself. Interrupting
is a press (or Space), which stops the audio and listens; Esc hangs up. The call's keys wait while a field is typed in
or a dialog, menu or list is open, and its Esc, once handled, leaves the page's own (which stops an agent) alone. Only
the DM's own line counts: a reply in one of its threads isn't read.

### 2. The call's states are a pure function of what the app sees

`packages/client/src/lib/voice-call.ts` holds the call's state and one reducer (`callStep`), shared with the phone
later:

```ts
type CallPhase = "listening" | "sending" | "waiting" | "speaking" | "ended";
interface CallState {
  phase: CallPhase;
  /** The take on its way: its clientId, then the id of the message the server posted for it; `shown`: its bubble was seen. */
  take: { clientId: string; messageId: string | null; shown: boolean } | null;
  /** Agent replies after the take, in the server's order, still to be read. */
  queue: string[];
  /** Replies already queued or read: never twice. */
  heard: string[];
  /** A run worked on the take: its end is the end of the answer. */
  sawWork: boolean;
  /** A reply to this take was queued. */
  answered: boolean;
  /** Whether a run works here now, as last seen. */
  busy: boolean;
  /** Since when nothing is queued and no run works (this device's clock). */
  quietSince: number | null;
  /** When this phase began. */
  since: number;
}
type CallEvent =
  | { type: "took"; clientId: string; now: number } // a take went
  | { type: "dropped"; now: number } // nothing was said, refused, too short
  | { type: "seen"; messages: CallMessage[]; busy: boolean; now: number } // the conversation now
  | { type: "spoken"; now: number } // the head of the queue was read, failed or was skipped
  | { type: "interrupt"; now: number }
  | { type: "hangUp" };
```

The anchor is the take's own message, found by its `clientId` once the server posted it, and the replies are the agent
messages after it in the list's order, never by this device's clock (it may be off) or by arrival (older history can
load later). Ways the loop can't stall:

- **Nothing said or refused.** `voice.dropped` and a refusal (`voice_limit`) take the take's bubble away: a list
  without it, once it showed, goes back to listening, as does a take too short or silent for the recorder.
- **No answer.** A run that ends without a message (an agent that keeps quiet, a failed run) ends the wait 1.5 s after
  the last run stopped. With no run seen at all, the wait ends after 60 s. A take whose message never comes ends its
  sending after 120 s.
- **An approval.** A run waiting on a person's decision (`waiting_approval`) isn't working: the turn comes back to the
  person, and the card is on the screen.
- **Audio that fails.** A reply with nothing to read (422), an engine that is busy or refuses, or a player that can't
  play skips that reply: it is in the chat.

"Gravando áudio…" (ADR 0100, 2026-11-13) goes out only once the take heard speech, so an open microphone in a quiet
room doesn't hold the agent's quiet window (ADR 0112) or show the line to others for nothing.

### 3. Text to speech behind one small interface, off until the server asks for it

`CallVoice` (`@agenteschat/adapters`) turns words into audio:

```ts
interface CallVoice {
  readonly id: string;
  /** The voice used when nobody names one. */
  readonly defaultVoice: string;
  /** The most characters one request takes. */
  readonly maxChars: number;
  speak(input: { text: string; voice: string; orgId?: string }): Promise<{ audio: Uint8Array; contentType: string }>;
}
```

One engine for now: a server speaking the OpenAI speech format (`POST <VOICE_CALL_SPEECH_URL>/audio/speech`): OpenAI
itself, or one of one's own (Kokoro-FastAPI, Speaches) so the words never leave the machine. A server of one's own is
told the workspace (`X-Agentes-Org`), as for voice messages. Errors are `SpeechError`s (`auth`, `busy`, `refused`).

`VOICE_CALL_SPEECH_URL` turns it on, with `VOICE_CALL_SPEECH_API_KEY`, `VOICE_CALL_SPEECH_MODEL` (`tts-1`) and
`VOICE_CALL_SPEECH_VOICE` (`alloy`). A key set for voice messages never starts sending agents' replies anywhere by
itself. The key is the server's, like the speech key (ADR 0100 §3): no Model Gateway, nothing in the Usage screens.

### 4. Only an agent's reply, only the words a person reads, nothing kept

`speakReply` (`packages/engine/src/voice-call.ts`) reads one message for someone who can read its channel
(`requireChannelAccess`), and only an agent's. The text is what the chat shows: `readableBody` (a voice message, a
notice for the agent or a line the server wrote, `bodyCode`, has nothing to read), then the kit's `plainLines`, which
keeps paragraphs, list items and quotes and leaves out code, tables and headings. At most 4,000 characters (or the
engine's limit), cut at the end of a sentence. Nothing to read answers 422 `voice_call.no_words` and calls no engine.

The audio goes back in the answer (`Cache-Control: no-store`) and is not stored: it is heard once, by the person in the
call. A POST, so the session's CSRF guards a request that costs. A person may ask 30 a minute.

`OrgSettings.voiceCallAvailable` (read only) is true when the server has both a speech engine and `CallVoice`. The
apps offer a call when it is true and the workspace's voice messages are on (`voiceMessages`).

### 5. In the web app: a DM with an agent

The phone button sits beside the microphone in the composer of a DM with an agent (not one of its threads), where the
microphone is. A call bar takes the composer's place: the agent's name, what the call is doing ("Ouvindo…",
"Enviando…", "Pensando…", "Falando…"), "Pronto" while listening, "Interromper" while it waits or speaks, and
"Encerrar". Leaving the conversation or closing the tab ends the call. The audio is registered with the kit's player
(`stopVoicePlayback`), so a voice message started by hand stops it.

## Consequences

- Each take is a voice message: it counts in voice fair use and retention (ADR 0100 §7, §8) and shows in the history.
- On agentes.chat's servers the replies read in a call cost the server, with only the per-minute limit. A daily limit
  per person, as voice messages have, comes when Cloud turns it on.
- The words of agents' replies go to the speech server chosen; `SELF_HOSTING.md` says so.
- No migration, no runner protocol.

### Meeting ADR 0209 (agents' replies read aloud)

Another change, ADR 0209, adds `ReadAloudEngine` and `READ_ALOUD_*` for an "Ouvir" button. Its engine fits `CallVoice`
as it is (the same `speak`, `defaultVoice`, `maxChars`). When both are in, the call takes that engine and voice
(`agents.read_aloud_voice`), `VOICE_CALL_SPEECH_*` go, `speakReply` reads its text with 0209's `spokenText`, and the
call may play its cached clips instead of asking for new audio.

## Later

- Real time, both ways: streaming speech in and out, barge-in with echo cancellation, a model that speaks.
- The phone: the same reducer, `expo-audio` for playback, silence detection over its recorder.
- Approvals answered by voice ("sim"/"não", re-asked when unclear) and questions read aloud.
- The agent's work narrated while it waits ("Lendo o GitHub…") from the runs' tool events.
- Calls in channels and threads (several agents answering, in order).
- Telling the agent the conversation is a call, so it answers shorter: a prompt change needs an eval first (ADR 0100).
- Turn detection by time rather than by count of levels, so a tab in the background ends a turn as fast as one in
  front; one microphone kept open for the whole call instead of one per turn.
- More engines (ElevenLabs through 0209), each agent's voice, the owner's key in Settings, a daily limit on Cloud.
