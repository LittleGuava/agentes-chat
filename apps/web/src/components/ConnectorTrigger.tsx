import type { CustomServer, Routine, RoutineConnectorTrigger } from "@agenteschat/client";
import { useAgentScopes, useCustomServers } from "@agenteschat/client";
import {
  type ConnectorDraftShape,
  connectionReader,
  connectorEventChoices,
  connectorWhenWords,
  SLACK_MESSAGE,
  triggerChoices,
} from "@agenteschat/client/lib/routines";
import { Field, Input, Select } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { AgentAccessNote } from "@/components/EmailTrigger";
import { useOrg } from "@/components/org-context";

/**
 * "Quando chegar um email no MillionSend" (ADR 0130): the connection, the inbox's address (any inbox when empty) and
 * the same optional filters as a mailbox's (de, assunto contém). "Quando chegar uma mensagem no Slack" (ADR 0196): the
 * connection, the channel and words in the text.
 */
export type ConnectorTriggerDraft = ConnectorDraftShape;

export const MILLIONSEND_EMAIL: RoutineConnectorTrigger["event"] = "millionsend.email.received";

/** The workspace's connections whose `event` can start a routine. */
function useEventConnections(orgId: string, event: RoutineConnectorTrigger["event"]): CustomServer[] {
  const servers = useCustomServers(orgId);
  return (servers.data ?? []).filter((s) => s.events?.includes(event));
}

/** The connector events Quando offers here: one per service connected, and the routine's own (`current`). */
export function useConnectorEvents(
  orgId: string,
  current?: RoutineConnectorTrigger["event"],
): RoutineConnectorTrigger["event"][] {
  const servers = useCustomServers(orgId);
  return connectorEventChoices(servers.data ?? [], current);
}

export function ConnectorTriggerFields({
  value,
  onChange,
  agentId,
}: {
  value: ConnectorTriggerDraft;
  onChange: (value: ConnectorTriggerDraft) => void;
  /** The routine's agent: only the connections it reads are offered (the server refuses the others). */
  agentId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useEventConnections(org.id, value.event);
  const grants = useAgentScopes(org.id, agentId, Boolean(agentId) && list.length > 0);
  const { options, cantRead } = triggerChoices(
    list,
    agentId && grants.data ? connectionReader(grants.data) : undefined,
    value.connectionId,
  );
  const waiting = Boolean(agentId) && list.length > 0 && grants.isPending;
  const first = waiting ? undefined : options[0];
  useEffect(() => {
    if (!value.connectionId && first) onChange({ ...value, connectionId: first.id });
  }, [value, first, onChange]);
  const setFilter = (filter: RoutineConnectorTrigger["filter"]) => onChange({ ...value, filter });
  const slack = value.event === SLACK_MESSAGE;
  const picked = list.find((s) => s.id === value.connectionId) ?? list[0];
  const access = cantRead && agentId && (
    <AgentAccessNote
      agentId={agentId}
      words={options.length === 0 ? "mail.routine.connectorReadsNone" : "mail.routine.connectorCantRead"}
      values={{ connector: picked?.label ?? "" }}
    />
  );
  if (options.length === 0 && access) return access;
  return (
    <div className="routine-email">
      <div className="grid-fields">
        {options.length > 1 && (
          <Field label={t("mail.routine.connection")} id="nr-connection">
            <Select
              value={value.connectionId || first?.id}
              onValueChange={(connectionId) => onChange({ ...value, connectionId })}
              options={options.map((s) => ({ value: s.id, label: s.label }))}
              placeholder={waiting ? t("common.loading") : undefined}
              disabled={waiting}
            />
          </Field>
        )}
        {slack ? (
          <Field
            label={t("mail.routine.slackChannel")}
            id="nr-slack-channel"
            example={t("mail.routine.slackChannelHelp")}
          >
            <Input
              value={value.filter.channel ?? ""}
              onChange={(e) => setFilter({ ...value.filter, channel: e.target.value })}
            />
          </Field>
        ) : (
          <Field label={t("mail.routine.inboxAddress")} id="nr-inbox" example={t("mail.routine.inboxAddressHelp")}>
            <Input
              type="email"
              value={value.filter.to ?? ""}
              onChange={(e) => setFilter({ ...value.filter, to: e.target.value })}
            />
          </Field>
        )}
      </div>
      {access}
      <span className="ac-eyebrow">{t("mail.routine.filters")}</span>
      {slack ? (
        <Field label={t("mail.routine.text")} id="nr-slack-text">
          <Input
            value={value.filter.text ?? ""}
            onChange={(e) => setFilter({ ...value.filter, text: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <AddressList
            id="nr-ms-from"
            label={t("mail.routine.from")}
            example={t("mail.routine.fromHelp")}
            values={value.filter.from ?? []}
            onChange={(from) => setFilter({ ...value.filter, from })}
          />
          <Field label={t("mail.routine.subject")} id="nr-ms-subject">
            <Input
              value={value.filter.subject ?? ""}
              onChange={(e) => setFilter({ ...value.filter, subject: e.target.value })}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/** "Quando chegar um email em vendas@loja.com", in any MillionSend inbox, or "…uma mensagem no Slack". */
export function connectorWhen(t: TFunction, routine: Routine) {
  if (routine.trigger.type !== "connector") return "";
  const words = connectorWhenWords(routine.trigger);
  return words.key === "mail.routine.when" ? t(words.key, words.values) : t(words.key);
}
