import type { Message } from "@agenteschat/client";
import { useModelLabel, useSettings } from "@agenteschat/client";
import { planMark } from "@agenteschat/client/lib/no-ai";
import { type AiPick, pickedByLine, routerPickOf } from "@agenteschat/client/lib/routing";
import { InfoHint, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useLive } from "@/realtime/context";
import { useOrg } from "./org-context";
import "./chat-notices.css";

/** The mark beside the words: Jev's, the small model's maker, the plan's maker. */
const markOf = (by: AiPick) =>
  by.step === "jev" ? "typesafe" : by.step === "model" ? by.provider : planMark(by.brand);

/**
 * Under the reply of an agent an AI step of the router picked (Jev, the workspace's small model, the author's own
 * plan), one quiet line naming it, with what it means behind its ⓘ. Only where an admin turned it on
 * (`settings.routerCaption`, ADR 0074 addendum 2026-11-16): by default the reply shows nothing, as the addendum of
 * 2026-11-03 decided, and a reply to a mention or a rule's pick never shows it.
 */
export function RouterCaption({ message }: { message: Message }) {
  const { org } = useOrg();
  const settings = useSettings(org.id);
  if (message.author.type !== "agent" || !message.agentRunId || settings.data?.routerCaption !== true) return null;
  return <PickedLine message={message} />;
}

function PickedLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const modelLabel = useModelLabel();
  const by = useLive((s) => routerPickOf(s.receipts, message));
  if (!by) return null;
  const text = pickedByLine(t, by, {
    meId: me.user.id,
    person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    model: modelLabel,
  });
  if (!text) return null;
  return (
    <p className="msg-picked ac-hintline">
      <span className="ac-iconline">
        <ProviderLogo id={markOf(by)} size="xs" />
        <span>{text}</span>
      </span>
      <InfoHint name={t("common.about", { label: text })}>{t("routing.picked.hint")}</InfoHint>
    </p>
  );
}
