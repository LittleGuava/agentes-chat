import type { CustomServer } from "@agenteschat/client";
import { useAgentScopes, useCustomServers } from "@agenteschat/client";
import {
  connectionReader,
  type MeetingDraft,
  meetingCalendars,
  meetingLeadOf,
  triggerChoices,
} from "@agenteschat/client/lib/routines";
import { Field, Input, Select } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AgentAccessNote } from "@/components/EmailTrigger";
import { useOrg } from "@/components/org-context";

/** The workspace's calendars a meeting routine can watch (ADR 0190). */
export function useMeetingCalendars(orgId: string): CustomServer[] {
  return meetingCalendars(useCustomServers(orgId).data ?? []);
}

/**
 * "Antes de uma reunião" (ADR 0190): the calendar (a Google Calendar connection the routine's agent reads) and how
 * many minutes before each meeting the routine runs.
 */
export function MeetingTriggerFields({
  value,
  onChange,
  agentId,
}: {
  value: MeetingDraft;
  onChange: (value: MeetingDraft) => void;
  /** The routine's agent: only the calendars it reads are offered (the server refuses the others). */
  agentId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useMeetingCalendars(org.id);
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
  const picked = list.find((s) => s.id === value.connectionId) ?? list[0];
  const access = cantRead && agentId && (
    <AgentAccessNote
      agentId={agentId}
      words={options.length === 0 ? "mail.routine.connectorReadsNone" : "mail.routine.connectorCantRead"}
      values={{ connector: picked?.label ?? "" }}
    />
  );
  if (options.length === 0 && access) return access;
  // Minutes the server can't keep say so as they're typed: the form doesn't save until they're right.
  const leadBad = meetingLeadOf(value.lead) === null;
  return (
    <div className="routine-email">
      <div className="grid-fields">
        <Field label={t("routines.meeting.calendar")} id="nr-calendar">
          <Select
            value={value.connectionId || first?.id}
            onValueChange={(connectionId) => onChange({ ...value, connectionId })}
            options={options.map((s) => ({ value: s.id, label: s.label }))}
            placeholder={waiting ? t("common.loading") : undefined}
            disabled={waiting}
          />
        </Field>
        <Field
          label={t("routines.meeting.lead")}
          id="nr-lead"
          example={t("routines.meeting.leadExample")}
          error={leadBad ? t("errors.said.meetingLead") : undefined}
        >
          <Input
            inputMode="numeric"
            value={value.lead}
            onChange={(e) => onChange({ ...value, lead: e.target.value })}
          />
        </Field>
      </div>
      {access}
    </div>
  );
}
