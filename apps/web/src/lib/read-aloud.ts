import type { ApiClient, Message } from "@agenteschat/client";
import { readAloudAudioUrl, readAloudOffered } from "@agenteschat/client/lib/read-aloud";
import type { QueryClient } from "@tanstack/react-query";
import { notificationAudience } from "./sounds";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * Agents' replies read aloud on the web (ADR 0209): one reply plays at a time, "Ouvir" again stops it. Whether each new
 * reply in the open conversation is read by itself belongs to this device, like the sound choice (ADR 0070).
 */
export type ReadAloudState = "idle" | "loading" | "playing";

/** The query of whether the server reads aloud: the hook asks it, the arriving replies read it from the cache. */
export const readAloudKey = (orgId: string) => ["org", orgId, "read-aloud"] as const;

const CHANGE_EVENT = "agentes:read-aloud";

let current: { messageId: string; state: Exclude<ReadAloudState, "idle">; audio: HTMLAudioElement | null } | null =
  null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** `useSyncExternalStore`'s subscription to what plays now. */
export const onReadAloudChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** This message's state in the one player. */
export const readAloudState = (messageId: string): ReadAloudState =>
  current?.messageId === messageId ? current.state : "idle";

/** Stops whatever plays. */
export function stopReadAloud() {
  current?.audio?.pause();
  current = null;
  changed();
}

/**
 * Reads a reply aloud, stopping anything else. Throws the server's refusal (`read_aloud_limit`, …) for the caller to
 * word, and calls `onFail` when the audio itself fails (its file gone: the next press makes it again); a browser that
 * won't play without a click just stays quiet.
 */
export async function playReadAloud(api: ApiClient, orgId: string, messageId: string, onFail?: () => void) {
  stopReadAloud();
  const mine = { messageId, state: "loading" as const, audio: null };
  current = mine;
  changed();
  try {
    const { clipId } = await api.readAloud.make(orgId, messageId);
    // Another reply was asked for meanwhile, or this one was stopped.
    if (current !== mine) return;
    const audio = new Audio(readAloudAudioUrl(orgId, clipId));
    const playing = { messageId, state: "playing" as const, audio };
    current = playing;
    changed();
    const end = () => {
      if (current === playing) stopReadAloud();
    };
    audio.addEventListener("ended", end);
    audio.addEventListener("error", () => {
      if (current !== playing) return;
      stopReadAloud();
      onFail?.();
    });
    await audio.play().catch(end);
  } catch (error) {
    if (current === mine) stopReadAloud();
    throw error;
  }
}

/** Whether this device reads each new agent reply aloud by itself. */
export const readAloudAuto = () => storage.get(STORAGE_KEYS.readAloud) === "on";
export const onReadAloudAutoChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};
export function setReadAloudAuto(on: boolean) {
  storage.set(STORAGE_KEYS.readAloud, on ? "on" : "off");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * A finished agent reply that just arrived in the open conversation: read aloud when this device asked for it, in one
 * tab only (the sounds' rule), never history. Refusals stay quiet: no words, the day's limit, the engine busy.
 */
export function readArrivedReply(
  qc: QueryClient,
  api: ApiClient,
  orgId: string,
  message: Pick<Message, "id" | "author" | "body" | "meta" | "local"> | undefined,
) {
  if (!message || !readAloudOffered(message)) return;
  if (!readAloudAuto() || !notificationAudience().mine) return;
  // Asked once per workspace, even where no message has shown the button yet.
  qc.fetchQuery({
    queryKey: readAloudKey(orgId),
    queryFn: () => api.readAloud.available(orgId),
    staleTime: Number.POSITIVE_INFINITY,
  })
    .then(({ available }) => (available ? playReadAloud(api, orgId, message.id) : undefined))
    .catch(() => {});
}
