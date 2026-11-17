import type { Message } from "@agenteschat/client";
import { VOICE_MAX_MS } from "@agenteschat/client/lib/voice";
import { type CallState, callReply, callStep, startCall } from "@agenteschat/client/lib/voice-call";
import {
  Button,
  claimPlayback,
  heardSpeech,
  Icon,
  listenAgain,
  OPEN_LAYER,
  releasePlayback,
  stopPlayback,
  turnEnded,
  typingInField,
  VOICE_LEVEL_MS,
  VoiceRecording,
  type VoiceTake,
} from "@agenteschat/ui";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";

/** Why a call couldn't listen: the microphone's errors, worded as voice messages word them. */
export type CallMicProblem = "blocked" | "noMic" | "failed";

export interface VoiceCallProps {
  orgId: string;
  agentName: string;
  /** The conversation's own messages, in the server's order. */
  messages: readonly Message[];
  /** A run thinks or works here now (`callBusy`). */
  busy: boolean;
  /** Sends a take as a voice message with this clientId (`useSendVoice`). */
  sendTake: (take: VoiceTake, clientId: string) => void;
  /** Each second a take holds speech: "gravando áudio…" for the others. */
  onSpeaking: () => void;
  onMicProblem: (problem: CallMicProblem) => void;
  onEnd: () => void;
}

const TICK_MS = 500;

/**
 * A voice call with an agent, by turns (ADR 0198), in the composer's place: it listens until the person stops
 * speaking, sends the take as a voice message, waits for the agent, reads each reply aloud, and listens again. The
 * microphone is closed while the agent speaks. Space hands the turn over ("Pronto" or "Interromper"), Esc hangs up.
 */
export function VoiceCall({
  orgId,
  agentName,
  messages,
  busy,
  sendTake,
  onSpeaking,
  onMicProblem,
  onEnd,
}: VoiceCallProps) {
  const { t } = useTranslation();
  const api = useApi();
  const [state, dispatch] = useReducer(callStep, undefined, (): CallState => startCall(Date.now()));
  const [spoke, setSpoke] = useState(false);
  const finishNow = useRef<(() => void) | null>(null);
  const latest = useRef({ sendTake, onSpeaking, onMicProblem, onEnd });
  latest.current = { sendTake, onSpeaking, onMicProblem, onEnd };

  // What the conversation shows now: the take's message, the agent's replies, its runs.
  useEffect(() => {
    dispatch({ type: "seen", messages, busy, now: Date.now() });
  }, [messages, busy]);

  const phase = state.phase;
  useEffect(() => {
    if (phase !== "sending" && phase !== "waiting" && phase !== "speaking") return;
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "ended") latest.current.onEnd();
  }, [phase]);

  // Listening: the microphone until speech, then quiet (or "Pronto"), ends the take. A take with no speech for a while
  // starts again, so the silence before someone speaks is never sent. Levels are read on a timer, not on frames: the
  // call isn't drawn, and a tab in the background still gets its (slower) beats.
  useEffect(() => {
    if (phase !== "listening") return;
    let stopped = false;
    let rec: VoiceRecording | null = null;
    let told = 0;
    setSpoke(false);
    const fail = (error: unknown) => {
      if (stopped) return;
      const name = error instanceof Error ? error.name : "";
      latest.current.onMicProblem(
        name === "NotAllowedError" || name === "SecurityError"
          ? "blocked"
          : name === "NotFoundError"
            ? "noMic"
            : "failed",
      );
      dispatch({ type: "hangUp" });
    };
    const open = () =>
      VoiceRecording.open().then((opened) => {
        if (stopped) opened.cancel();
        else rec = opened;
      }, fail);
    const finish = async () => {
      if (!rec || stopped || !heardSpeech(rec.levels)) return;
      const current = rec;
      rec = null;
      stopped = true;
      const take = await current.finish();
      const clientId = crypto.randomUUID();
      dispatch({ type: "took", clientId, now: Date.now() });
      latest.current.sendTake(take, clientId);
    };
    finishNow.current = () => void finish();
    const beat = setInterval(() => {
      if (!rec || stopped) return;
      const now = performance.now();
      rec.listen(now);
      const speech = heardSpeech(rec.levels);
      if (!speech) {
        if (listenAgain(rec.levels, rec.elapsed())) {
          rec.cancel();
          rec = null;
          void open();
        }
        return;
      }
      setSpoke(true);
      if (now - told >= 1000) {
        told = now;
        latest.current.onSpeaking();
      }
      // The server takes up to `VOICE_MAX_MS`: a take that long goes as it is.
      if (turnEnded(rec.levels) || rec.elapsed() >= VOICE_MAX_MS - 2000) void finish();
    }, VOICE_LEVEL_MS);
    // Nothing else plays while the call listens.
    stopPlayback();
    void open();
    return () => {
      stopped = true;
      finishNow.current = null;
      clearInterval(beat);
      rec?.cancel();
    };
  }, [phase]);

  // Speaking: the reply at the head of the line, read aloud; whatever goes wrong, the next one.
  const reply = callReply(state);
  useEffect(() => {
    if (!reply) return;
    let done = false;
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    const next = () => {
      if (done) return;
      done = true;
      releasePlayback(stop);
      dispatch({ type: "spoken", now: Date.now() });
    };
    function stop() {
      audio?.pause();
      next();
    }
    api.voice.speech(orgId, reply).then(
      (blob) => {
        if (done) return;
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = next;
        audio.onerror = next;
        claimPlayback(stop);
        audio.play().catch(next);
      },
      () => next(),
    );
    return () => {
      done = true;
      releasePlayback(stop);
      audio?.pause();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, orgId, reply]);

  const handOver = useCallback(() => {
    if (phase === "listening") finishNow.current?.();
    else if (phase === "waiting" || phase === "speaking") dispatch({ type: "interrupt", now: Date.now() });
  }, [phase]);
  const hangUp = useCallback(() => dispatch({ type: "hangUp" }), []);

  useEffect(() => {
    // Keys only when nothing else has them: a field being typed in, a dialog, menu or list open, a button pressed.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typingInField(e.target) || document.querySelector(OPEN_LAYER)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        hangUp();
      } else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        handOver();
      }
    };
    // Ahead of the page's own Esc (which stops an agent): handled here, it's marked so the page leaves it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handOver, hangUp]);

  const status =
    phase === "listening"
      ? t("voiceCall.listening")
      : phase === "sending"
        ? t("voiceCall.sending")
        : phase === "waiting"
          ? t("voiceCall.waiting", { name: agentName })
          : t("voiceCall.speaking", { name: agentName });
  return (
    <section className="voice-call" aria-label={t("voiceCall.region", { name: agentName })}>
      <p className="voice-call__state ac-iconline" aria-live="polite">
        <Icon name={phase === "speaking" ? "volume" : phase === "listening" ? "mic" : "phone"} size={16} />
        <span>{status}</span>
      </p>
      <div className="voice-call__acts">
        {phase === "listening" && (
          <Button size="sm" onClick={handOver} disabled={!spoke}>
            {t("voiceCall.done")}
          </Button>
        )}
        {(phase === "waiting" || phase === "speaking") && (
          <Button size="sm" onClick={handOver}>
            {t("voiceCall.interrupt")}
          </Button>
        )}
        <Button size="sm" variant="danger" icon="phone" onClick={hangUp}>
          {t("voiceCall.hangUp")}
        </Button>
      </div>
    </section>
  );
}
