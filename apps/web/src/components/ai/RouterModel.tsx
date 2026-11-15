import type { AiRouting } from "@agenteschat/client";
import {
  useCredentials,
  useModelLabel,
  useModels,
  usePlatformKey,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { modelChoices } from "@agenteschat/client/lib/providers";
import { Locked, SettingRow } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AutoMark, ModelSelect, modelOptions } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

const AUTO = "";

/** The steps where a model of the workspace's keys picks who answers (ADR 0074 §1). */
const MODEL_PICKS: readonly AiRouting["by"][] = ["model", "plans", "rules"];

/**
 * "Modelo que decide": the small model that routes and judges (`settings.routerModel`, ADR 0074 §2 and §7). Under Jev
 * or with the router off it shows only to undo one saved before, which still judges.
 */
export function RouterModelRow({ routing }: { routing: AiRouting }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const id = useId();
  const models = useModels();
  const credentials = useCredentials(org.id);
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const modelLabel = useModelLabel();
  const toast = useToast();
  const saved = settings.data?.routerModel ?? AUTO;
  if (!settings.data || !models.data || (!MODEL_PICKS.includes(routing.by) && saved === AUTO)) return null;
  const choices = modelChoices(models.data.models, credentials.data ?? [], platform.data ?? false).flatMap(
    ([group, list]) => {
      const kept = list.filter((c) => c.model.structuredOutput !== false && (c.available || c.model.id === saved));
      return kept.length > 0 ? [[group, kept] as [string, typeof kept]] : [];
    },
  );
  const all = modelOptions(t, i18n.language, choices);
  const fast = new Set(models.data.models.filter((m) => m.router).map((m) => m.id));
  const today = saved === AUTO && routing.model ? modelLabel(routing.model) : null;
  const choose = (model: string) => {
    if (model === saved) return;
    update.mutate(
      { routerModel: model || null },
      {
        onSuccess: () => toast.show(t("routing.model.saved")),
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  };
  return (
    <SettingRow
      title={t("routing.model.title")}
      htmlFor={id}
      hint={{
        name: t("common.about", { label: t("routing.model.title") }),
        text: t(routing.by === "off" ? "routing.model.hintJudge" : "routing.model.hint"),
      }}
      status={statusOf(t, routing, saved, (model) => modelLabel(model) ?? model)}
    >
      <Locked when={update.isPending}>
        <ModelSelect
          aria-label={t("routing.model.title")}
          value={saved}
          onChange={choose}
          options={[
            {
              value: AUTO,
              label: today ? t("routing.model.autoWith", { model: today }) : t("routing.model.auto"),
              leading: <AutoMark />,
            },
            ...all.filter((o) => fast.has(o.value)).map((o) => ({ ...o, group: t("routing.model.picks") })),
            ...all.filter((o) => !fast.has(o.value)),
          ]}
        />
      </Locked>
    </SettingRow>
  );
}

/** Who decides when that isn't the model chosen: Jev, nobody, or another model where the one saved can't be reached. */
function statusOf(t: TFunction, routing: AiRouting, saved: string, label: (model: string) => string) {
  if (routing.by === "jev") return t("routing.model.underJev");
  if (routing.by === "off") return t("routing.model.underOff");
  if (saved === AUTO || routing.model === saved) return undefined;
  return routing.by === "model" && routing.model
    ? t("routing.model.standIn", { model: label(routing.model) })
    : t("routing.model.unused");
}
