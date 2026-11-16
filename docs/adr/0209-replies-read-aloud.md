# 0209. Agents' replies read aloud

- Status: Accepted
- Date: 2026-11-15
- Code: `packages/adapters/src/read-aloud.ts`, `packages/engine/src/read-aloud.ts`, `packages/db/src/schema/read-aloud.ts`, `apps/server/src/routes/app/read-aloud.ts`, `apps/web/src/components/ReadAloud.tsx`, `apps/web/src/lib/read-aloud.ts`

## Context

People talk to agents by voice (ADR 0100), and some want to hear the answer too: with their hands busy, on a walk, or
because listening is easier for them than reading. Voice messages turn speech into text; nothing turns an agent's reply
into speech yet.

## Decision

### 1. One engine behind one interface, off until the server asks for it

`ReadAloudEngine` (`@agenteschat/adapters`) turns words into audio: `speak({ text, voice, orgId })` gives back the audio
and its type. Two engines:

- `elevenlabs`: ElevenLabs' `POST /v1/text-to-speech/{voice_id}` with `eleven_flash_v2_5` (40,000 characters a request,
  Portuguese included), MP3 at 44.1 kHz 128 kb/s, keyed by the `ELEVENLABS_API_KEY` voice messages already use.
- `local`: a server of one's own that speaks the OpenAI speech format (`POST <READ_ALOUD_URL>/audio/speech`), such as
  Kokoro-FastAPI or Speaches, so the words never leave the machine.

`READ_ALOUD_ENGINE` picks one (`off` by default). A key set for voice messages never starts sending the agents' replies
to a third party by itself: reading aloud is its own switch. With it off, no button shows and the server still needs only
Postgres. A key the installation's owner pastes in Settings, as for voice messages, is left for later.

### 2. Only an agent's reply, and only the words a person reads

The route reads one message aloud for someone who can read its channel (`requireChannelAccess`), and only an agent's:
it is the reply people want to hear, and a person's own words or a voice message's transcript would be read back to the
room. The text is what the chat shows a person: `readableBody` (a notice written for the agent has nothing to say, nor has a line the server wrote, `bodyCode`, which the apps show in the reader's language), then
`plainLines` from the kit's Markdown, which keeps paragraphs, list items and quotes and leaves out headings, code, tables
and embeds, which frame a reply rather than say it. At most 5,000 characters are read, cut at the end of a sentence. A
message with nothing to read answers 422 `read_aloud.no_words` and calls no engine.

### 3. Each agent has a voice

`agents.read_aloud_voice` (optional) is the engine's voice id: ElevenLabs' voice id, or the name a server of one's own
gives a voice. Empty: the server's `READ_ALOUD_VOICE`, else the engine's default (ElevenLabs' `JBFqnCBsd6RMkjVDRZzb`,
`alloy` on the OpenAI format). It is free text checked for shape only, since the engines' voices differ and change; a
voice the engine doesn't know fails that one request.

### 4. Made once, kept a while

The audio is stored on the workspace's storage (`BlobStoreResolver`, `read-aloud/<id>` under its prefix) and its row in
`read_aloud_clips`, keyed by message and a hash of the engine, model, voice and text: everyone who listens to a reply
hears the same file, and an edited reply or a new voice makes a new one. Two requests: `POST …/messages/{id}/read-aloud`
makes it (or finds it) and answers `{ clipId }`, with errors as JSON and the session's CSRF; `GET …/read-aloud/{clipId}/
audio` only serves what exists, with byte ranges or a short signed link, checking the channel again, so an `<audio>`
tag never pays for a synthesis and two of its range requests can't make two.

The audio is a cache: rows and files go after `READ_ALOUD_CACHE_DAYS` (7 by default, at least 1) in the hourly sweep,
with a deleted channel (`dropChannelReadAloud`, beside its voice messages), and with a deleted workspace's platform
files (`purgeOrgFiles` takes its whole prefix). They don't count in `storedBytes` and aren't moved by a storage
migration: a clip left on the workspace's former storage is made again on the new one at the next listen, and its old
file deleted if that storage still answers. A clip whose file is gone (or whose storage settings were removed) loses its
row when the server serves the bytes itself, so the next listen makes it again; behind a signed link the server can't
tell, and the player fails until the sweep. A deleted reply's audio no longer plays.

### 5. Cost and fair use, as for voice messages

The key is the server's, not the workspace's, as for voice messages (ADR 0100 §3, §7), so the Model Gateway (ADR 0007),
whose job is an agent's budget on the workspace's key, isn't the place: embeddings go through it (ADR 0167) because they
bill a workspace's usage, which this doesn't. Each row keeps its engine and its characters, which is what these engines
bill by; no price is stored, since ElevenLabs bills in plan credits, not a fixed price per character. Nothing reaches
the Usage screens.

Every server limits a person to 20 requests a minute. On agentes.chat's servers only, a person may have
`READ_ALOUD_LIMIT_PERSON_CHARS_PER_DAY` characters (20,000 by default; 0: no limit) read in a rolling 24 hours, counted
from the rows they made; a reply someone already made plays for anyone at no cost. Past it: 429 `read_aloud_limit`.

### 6. In the apps

On the web, "Ouvir" sits on an agent reply's bar and in its menu on touch; one reply plays at a time, and pressing it
again stops it. "Ler respostas em voz alta" in Settings › Account, under the sounds, plays each finished agent reply that
arrives live in the open conversation, in one tab only (the sounds' rule), never the history; it belongs to the
device, as the sound choice does (ADR 0070), since one wants it on a laptop and not on a shared screen. A browser that
refuses to play without a click just stays quiet. The agent's voice is a field on its page, shown when the server reads
aloud.

## Consequences

- An agent's reply goes to ElevenLabs when the server picks it; `SELF_HOSTING.md` says so, and `local` keeps it in.
- Later: the phone app (an "Ouvir" in the message's menu and the same device switch), the owner's key in Settings,
  a list of the engine's voices to pick from instead of an id, a workspace switch, and streaming the audio while it is
  made.
