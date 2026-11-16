import type { Agent, ConversationModel, ConversationPlace } from "@agenteschat/client";
import { useChannelMembers, useConversationModels, useSetConversationModel } from "@agenteschat/client";
import {
  AGENT_OWN,
  conversationAgents,
  conversationModelChoices,
  conversationModelNow,
  conversationModelSaved,
} from "@agenteschat/client/lib/conversation-model";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { PickList } from "../shared/PickList";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";

/** The agents of a channel, a DM or a thread: the "…" sheets offer "Modelos nesta conversa" only when there is one. */
export function useConversationAgents(channelId: string): Agent[] {
  const orgId = useOrgId();
  const dir = useDirectory();
  return conversationAgents(useChannelMembers(orgId, channelId).data ?? [], dir.agentById);
}

/**
 * "Modelos nesta conversa" (ADR 0032, addendum 2026-11-15), the web header's popover as a sheet: each agent here with
 * what it thinks with here. Who may change an agent's brain opens its choices, the rest read them.
 */
export function ConversationModelSheet({ place, agents }: { place: ConversationPlace; agents: Agent[] }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const views = useConversationModels(
    orgId,
    agents.map((a) => a.id),
    place,
  );
  return (
    <>
      <SheetTitle leading={<Tile icon="brain" />} title={t("brain.picker.conversation.button")} />
      <ActionList
        items={agents.map((agent, i) => {
          const view = views[i]?.data;
          const editable = Boolean(view?.canEdit && view.options.length > 0);
          return {
            key: agent.id,
            leading: <AgentFace agentId={agent.id} size={20} live={false} />,
            label: agent.name,
            hint: view ? conversationModelNow(t, view) : t("brain.picker.conversation.default"),
            ...(view && editable
              ? {
                  onPress: () => sheet.open(<AgentModelPick agent={agent} place={place} view={view} agents={agents} />),
                }
              : {}),
          };
        })}
      />
    </>
  );
}

/** One agent's choices here, the default first and the one in force checked; a pick saves it and goes back. */
function AgentModelPick({
  agent,
  place,
  view,
  agents,
}: {
  agent: Agent;
  place: ConversationPlace;
  view: ConversationModel;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const toast = useToast();
  const set = useSetConversationModel(orgId, agent.id, place);
  const back = () => sheet.open(<ConversationModelSheet place={place} agents={agents} />);
  return (
    <>
      <SheetTitle
        leading={<AgentFace agentId={agent.id} size={32} live={false} />}
        title={t("brain.picker.conversation.of", { agent: agent.name })}
      />
      <PickList
        options={conversationModelChoices(t, view).map((o) => ({ ...o, keywords: "" }))}
        value={view.model ?? AGENT_OWN}
        onPick={(o) => {
          const model = o.value === AGENT_OWN ? null : o.value;
          if (model === view.model || set.isPending) return back();
          set.mutate(model, {
            onSuccess: (saved) => {
              toast({ title: conversationModelSaved(t, agent.name, saved), agentId: agent.id });
              back();
            },
            onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
          });
        }}
        placeholder={t("models.searchPlaceholder")}
        searchLabel={t("models.search")}
        noResults={t("models.noResults")}
      />
    </>
  );
}
