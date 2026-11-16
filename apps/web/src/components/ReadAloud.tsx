import { type Agent, ApiError, type Message, useApi, useUpdateAgent } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { readAloudOffered } from "@agenteschat/client/lib/read-aloud";
import { Button, Field, Input, Switch } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import {
  onReadAloudAutoChange,
  onReadAloudChange,
  playReadAloud,
  readAloudAuto,
  readAloudKey,
  readAloudState,
  setReadAloudAuto,
  stopReadAloud,
} from "@/lib/read-aloud";
import { useToast } from "@/lib/toast";

/** Agents' replies read aloud on the web (ADR 0209). */

/** Whether this server reads replies aloud: asked once per workspace. */
export function useReadAloudAvailable() {
  const api = useApi();
  const { org } = useOrg();
  const query = useQuery({
    queryKey: readAloudKey(org.id),
    queryFn: () => api.readAloud.available(org.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return query.data?.available ?? false;
}

/** "Ouvir" on a reply, and "Parar" while it plays: one reply at a time. */
function useListen(message: Message) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const toast = useToast();
  const state = useSyncExternalStore(onReadAloudChange, () => readAloudState(message.id));
  const toggle = () => {
    if (state !== "idle") return stopReadAloud();
    const failed = () => toast.show(t("readAloud.failed"), "error");
    playReadAloud(api, org.id, message.id, failed).catch((error: unknown) => {
      const limit = error instanceof ApiError && error.code === "read_aloud_limit";
      if (limit) toast.show(t("readAloud.limit"), "error");
      else failed();
    });
  };
  const shown = useReadAloudAvailable() && readAloudOffered(message);
  return { shown, state, toggle, label: t(state === "idle" ? "readAloud.listen" : "readAloud.stop") };
}

export function ListenButton({ message }: { message: Message }) {
  const listen = useListen(message);
  if (!listen.shown) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon={listen.state === "loading" ? "spinner" : listen.state === "playing" ? "pause" : "sound"}
      aria-label={listen.label}
      title={listen.label}
      aria-pressed={listen.state !== "idle"}
      onClick={listen.toggle}
    />
  );
}

/** The same in a reply's menu, where it stands in for the bar on touch. */
export function useListenEntry(message: Message): MenuEntry | null {
  const listen = useListen(message);
  if (!listen.shown) return null;
  return {
    kind: "item",
    id: "listen",
    label: listen.label,
    icon: listen.state === "playing" ? "pause" : "sound",
    run: listen.toggle,
  };
}

/** "Ler respostas em voz alta": this device reads each new reply in the open conversation aloud. */
export function ReadAloudAutoRow() {
  const { t } = useTranslation();
  const on = useSyncExternalStore(onReadAloudAutoChange, readAloudAuto, readAloudAuto);
  if (!useReadAloudAvailable()) return null;
  return (
    <PrefRow
      id="account-read-aloud"
      icon="volume"
      label={t("readAloud.auto")}
      hint={t("readAloud.autoHint")}
      control={<Switch checked={on} onCheckedChange={setReadAloudAuto} aria-label={t("readAloud.auto")} />}
    />
  );
}

const VOICE = /^[A-Za-z0-9_.-]{1,100}$/;

/** The agent's voice, saved when the field is left (who edits agents changes it). */
export function ReadAloudVoiceField({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const saved = agent.readAloudVoice ?? "";
  const [value, setValue] = useState(saved);
  const [invalid, setInvalid] = useState(false);
  if (!useReadAloudAvailable() || !can(org, "manage_agents")) return null;
  const save = () => {
    const next = value.trim();
    if (next === saved) return;
    if (next && !VOICE.test(next)) return setInvalid(true);
    setInvalid(false);
    update.mutate(
      { readAloudVoice: next || null },
      {
        onSuccess: () => toast.show(t("readAloud.voiceSaved")),
        onError: () => toast.show(t("readAloud.failed"), "error"),
      },
    );
  };
  return (
    <div className="agp-field">
      <Field
        label={t("readAloud.voice")}
        id="agp-read-aloud-voice"
        hint={{ name: t("common.about", { label: t("readAloud.voice") }), text: t("readAloud.voiceHint") }}
        error={invalid ? t("readAloud.voiceInvalid") : undefined}
      >
        <Input
          value={value}
          placeholder={t("readAloud.voiceDefault")}
          maxLength={100}
          spellCheck={false}
          autoComplete="off"
          invalid={invalid}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      </Field>
    </div>
  );
}
