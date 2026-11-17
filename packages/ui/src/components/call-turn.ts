import { VOICE_LEVEL_MS } from "./voice-recorder";

/**
 * When a voice call's turn ends (ADR 0198): the recorder's levels (0 to 1, one every `CALL_LEVEL_MS`) say whether the
 * person spoke and has gone quiet. A room's hum or a click never counts as speech, so an open microphone in a quiet
 * room keeps listening.
 */

/** The recorder reads a level this often. */
export const CALL_LEVEL_MS = VOICE_LEVEL_MS;
/** A level above this is a voice. */
export const CALL_SPEAKING = 0.12;
/** A voice holds above `CALL_SPEAKING` for at least this long without a break; a click or a knock doesn't. */
export const CALL_SPEECH_MS = 250;
/** This much quiet after speech ends the turn. */
export const CALL_QUIET_MS = 1200;
/** A take with no speech this long starts again, so the silence before someone speaks is never sent. */
export const CALL_IDLE_MS = 12_000;

/** Whether the take holds speech: one stretch of levels above a voice's, long enough. */
export function heardSpeech(levels: readonly number[], levelMs = CALL_LEVEL_MS) {
  const need = Math.ceil(CALL_SPEECH_MS / levelMs);
  let run = 0;
  for (const level of levels) {
    run = level > CALL_SPEAKING ? run + 1 : 0;
    if (run >= need) return true;
  }
  return false;
}

/** Whether the turn is over: the person spoke, then stayed quiet for `CALL_QUIET_MS`. */
export function turnEnded(levels: readonly number[], levelMs = CALL_LEVEL_MS) {
  const quiet = Math.ceil(CALL_QUIET_MS / levelMs);
  if (levels.length < quiet) return false;
  for (let i = levels.length - quiet; i < levels.length; i++) if ((levels[i] ?? 0) > CALL_SPEAKING) return false;
  return heardSpeech(levels.slice(0, levels.length - quiet), levelMs);
}

/** Whether to drop the take and listen anew: `elapsedMs` of it and no speech yet. */
export function listenAgain(levels: readonly number[], elapsedMs: number, levelMs = CALL_LEVEL_MS) {
  return elapsedMs >= CALL_IDLE_MS && !heardSpeech(levels, levelMs);
}
