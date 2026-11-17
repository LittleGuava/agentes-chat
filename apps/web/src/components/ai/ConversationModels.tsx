import type { Agent, ConversationModel, ConversationPlace } from "@agenteschat/client";
import { useChannelMembers, useConversationModel, useSetConversationModel } from "@agenteschat/client";
import {
  AGENT_OWN,
  conversationAgents,
  conversationModelChoices,
  conversationModelNow,
  conversationModelSaved,
} from "@agenteschat/client/lib/conversation-model";
import { Button, Icon, Popover, Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./conversation-models.css";

/**
 * Another of the agent's models for this conversation alone, or back to its default (ADR 0032, addendum 2026-11-15).
 * In a thread the default is what its channel chose, and says so. `view` is the agent's here, read by the caller.
 */
export function ConversationModelSelect({
  agent,
  place,
  view,
  label,
  onSaved,
}: {
  agent: Agent;
  place: ConversationPlace;
  view: ConversationModel;
  label: string;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const set = useSetConversationModel(org.id, agent.id, place);
  const choose = async (value: string) => {
    const model = value === AGENT_OWN ? null : value;
    if (model === view.model) return;
    try {
      const saved = await set.mutateAsync(model);
      onSaved?.();
      toast.show(conversationModelSaved(t, agent.name, saved), "success");
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    }
  };
  return (
    <Select
      size="sm"
      value={view.model ?? AGENT_OWN}
      onValueChange={(v) => void choose(v)}
      aria-label={label}
      disabled={set.isPending}
      options={conversationModelChoices(t, view)}
    />
  );
}

/**
 * "Modelos nesta conversa" in a channel's header or a thread's: the agents here, each with the model it thinks with
 * here. Who may change an agent's brain gets its select, the rest read it. None while no agent is a member.
 */
export function ConversationModelsButton({
  channelId,
  threadId,
  look,
}: {
  channelId: string;
  threadId?: string;
  /** The channel header's icon buttons, or the thread header's kit buttons. */
  look: "channel" | "thread";
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const members = useChannelMembers(org.id, channelId);
  const agents = conversationAgents(members.data ?? [], dir.agentById);
  if (agents.length === 0) return null;
  const title = t("brain.picker.conversation.button");
  const place: ConversationPlace = { channelId, threadId: threadId ?? null };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      className="thread-pop cm-pop"
      label={title}
      trigger={
        look === "channel" ? (
          <button
            type="button"
            className="ac-btn ac-btn--ghost ac-btn--icon channel__icon"
            aria-label={title}
            title={title}
          >
            <Icon name="brainAgent" />
          </button>
        ) : (
          <Button size="sm" variant="ghost" iconOnly icon="brainAgent" aria-label={title} title={title} />
        )
      }
    >
      <div className="thread-pop__head">
        <b>{title}</b>
      </div>
      <div className="thread-pop__list cm-pop__list">
        {agents.map((agent) => (
          <AgentModelRow key={agent.id} agent={agent} place={place} />
        ))}
      </div>
    </Popover>
  );
}

function AgentModelRow({ agent, place }: { agent: Agent; place: ConversationPlace }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const view = useConversationModel(org.id, agent.id, place).data;
  const label = t("brain.picker.conversation.of", { agent: agent.name });
  return (
    <div className="cm-pop__row">
      <span className="cm-pop__who">
        <ActorAvatar actor={{ type: "agent", id: agent.id }} name={agent.name} size="sm" />
        <b>{agent.name}</b>
      </span>
      {view?.canEdit && view.options.length > 0 ? (
        <ConversationModelSelect agent={agent} place={place} view={view} label={label} />
      ) : (
        <span className="cm-pop__model">
          {view ? conversationModelNow(t, view) : t("brain.picker.conversation.default")}
        </span>
      )}
    </div>
  );
}
