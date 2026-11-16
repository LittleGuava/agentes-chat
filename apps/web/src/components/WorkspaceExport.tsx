import { type Agent, type AgentGroup, useAgentGroups, useAgents, useExportPreview } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { bundleCounts, scopeNamesSome } from "@agenteschat/client/lib/workspace-export";
import {
  Button,
  Card,
  CardHeader,
  ChipField,
  type ChipFieldOption,
  type ChipFieldToken,
  Field,
  Icon,
  Segmented,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { HelpLink } from "@/components/HelpLink";
import { useOrg } from "@/components/org-context";
import { SectorMark } from "@/components/team/shared";
import { lookOf } from "@/lib/look";
import { saveExport } from "@/lib/workspace-export";

type What = "all" | "part";

/**
 * Configurações → Importar e exportar's Exportar card (ADR 0055): the whole workspace, or a part of it, setores and
 * agents with what they use (addendum 2026-11-15), what goes in the file shown before the download. What never goes
 * stays one line, the full list on the help page.
 */
export function ExportCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const [what, setWhat] = useState<What>("all");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const groups = useAgentGroups(org.id).data ?? [];
  // The right hand is the product's (ADR 0137): never exported, so never offered.
  const agents = (useAgents(org.id).data ?? []).filter((a) => !a.builtin && !a.former);
  const part = what === "part";
  // Only what is still here: a setor or agent removed meanwhile leaves the part (it has no token left to take out).
  const scope = {
    agentIds: agentIds.filter((id) => agents.some((a) => a.id === id)),
    groupIds: groupIds.filter((id) => groups.some((g) => g.id === id)),
  };
  const preview = useExportPreview(org.id, part ? scope : {});
  // A part downloads only what its preview showed: never while it loads, failed, or holds nobody.
  const ready = !part || (!preview.isFetching && !preview.error && (preview.data?.agents.length ?? 0) > 0);
  const download = () => saveExport(api, org.id, part ? scope : undefined);
  const shown = part && scopeNamesSome(scope);
  return (
    <Card aria-labelledby="imp-export-title">
      <CardHeader
        icon="download"
        id="imp-export-title"
        title={t("settings.import.exportTitle")}
        action={
          <Button icon="download" onClick={download} disabled={!ready}>
            {t("settings.import.download")}
          </Button>
        }
      />
      <Segmented
        block
        label={t("settings.import.exportWhat")}
        value={what}
        onValueChange={setWhat}
        options={[
          { value: "all", label: t("settings.import.exportAll") },
          { value: "part", label: t("settings.import.exportPart") },
        ]}
      />
      {part && (
        <PartPicker
          groups={groups}
          agents={agents}
          agentIds={scope.agentIds}
          groupIds={scope.groupIds}
          onAgents={setAgentIds}
          onGroups={setGroupIds}
          lineId={shown ? "imp-export-preview" : undefined}
        />
      )}
      {shown && (
        <div id="imp-export-preview" className="imp-export-preview" aria-live="polite">
          {preview.error ? (
            <p className="imp-note">{errorText(t, preview.error)}</p>
          ) : preview.data ? (
            <PartPreview bundle={preview.data} />
          ) : null}
        </div>
      )}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("settings.import.neverLine")}</span>
      </p>
      <p className="imp-help">
        <HelpLink slug="import" section="export">
          {t("settings.import.whatsIn")}
        </HelpLink>
      </p>
    </Card>
  );
}

/** Setores and agents in one field: a setor brings every agent in it. */
function PartPicker({
  groups,
  agents,
  agentIds,
  groupIds,
  onAgents,
  onGroups,
  lineId,
}: {
  groups: readonly AgentGroup[];
  agents: readonly Agent[];
  agentIds: string[];
  groupIds: string[];
  onAgents: (ids: string[]) => void;
  onGroups: (ids: string[]) => void;
  /** The preview's id, while it shows. */
  lineId?: string;
}) {
  const { t } = useTranslation();
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const setorWord = t("settings.import.setores");
  const agentWord = t("settings.import.agents");
  const options: ChipFieldOption[] = [
    ...groups.map((g) => ({
      value: `group:${g.id}`,
      label: g.name,
      leading: <SectorMark group={g} />,
      description: t("settings.import.setorAgents", { count: g.agentIds.length }),
      group: setorWord,
      picked: groupIds.includes(g.id),
    })),
    ...agents.map((a) => ({
      value: `agent:${a.id}`,
      label: a.name,
      leading: <AgentAvatar name={a.name} appearance={lookOf(a)} size="xs" />,
      description: `@${a.handle}`,
      group: agentWord,
      picked: agentIds.includes(a.id),
    })),
  ];
  const tokens: ChipFieldToken[] = [
    ...groups
      .filter((g) => groupIds.includes(g.id))
      .map((g) => ({
        key: `group:${g.id}`,
        label: g.name,
        leading: <SectorMark group={g} size={14} />,
        removeLabel: t("common.removeName", { name: g.name }),
      })),
    ...agents
      .filter((a) => agentIds.includes(a.id))
      .map((a) => ({
        key: `agent:${a.id}`,
        label: a.name,
        leading: <AgentAvatar name={a.name} appearance={lookOf(a)} size="xs" />,
        removeLabel: t("common.removeName", { name: a.name }),
      })),
  ];
  const pick = (key: string) => {
    const [kind, id = ""] = key.split(":");
    if (kind === "group") onGroups(toggle(groupIds, id));
    else onAgents(toggle(agentIds, id));
  };
  const label = t("settings.import.partLabel");
  return (
    <Field label={label} id="imp-export-part">
      <ChipField
        tokens={tokens}
        onRemove={pick}
        placeholder={t("settings.import.partPlaceholder")}
        options={options}
        onPick={(o) => pick(o.value)}
        listLabel={label}
        empty={(query) => (query ? t("settings.import.partNoMatch", { query }) : t("settings.import.partNothing"))}
        aria-describedby={lineId}
      />
    </Field>
  );
}

/** What the part's file holds: its agents by name, then how many of the rest, or that nobody is in it. */
function PartPreview({ bundle }: { bundle: Parameters<typeof bundleCounts>[0] }) {
  const { t } = useTranslation();
  const counts = bundleCounts(bundle);
  if (counts.agents === 0) return <p className="imp-note">{t("settings.import.partNobody")}</p>;
  const rest = [
    counts.skills > 0 && t("settings.import.countSkills", { count: counts.skills }),
    counts.channels > 0 && t("settings.import.countChannels", { count: counts.channels }),
    counts.routines > 0 && t("settings.import.countRoutines", { count: counts.routines }),
    counts.notes > 0 && t("settings.import.countNotes", { count: counts.notes }),
  ].filter((x): x is string => typeof x === "string");
  return (
    <>
      <p className="imp-note">
        {t("settings.import.partAgentsLine", {
          count: counts.agents,
          names: joinNames(
            bundle.agents.map((a) => a.name),
            t,
          ),
        })}
      </p>
      {rest.length > 0 && <p className="imp-note">{t("settings.import.partRestLine", { what: joinNames(rest, t) })}</p>}
    </>
  );
}
