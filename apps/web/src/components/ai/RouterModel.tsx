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
import { can } from "@agenteschat/client/lib/permissions";
import { modelChoices } from "@agenteschat/client/lib/providers";
import { Icon, Locked, SettingRow } from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ModelSelect, modelOptions } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** The choice that leaves the router on the server's pick. */
const AUTO = "";

/**
 * "Modelo que decide": the small model that picks who answers (`settings.routerModel`, ADR 0074 §2), among the models
 * of the workspace's keys. Automático leaves it to the server: its `ROUTER_MODEL`, else the small model of the default
 * key's provider, else of any other key. Offered only while Jev doesn't pick: under Jev it would only stand in for a
 * failed call, and the card names Jev nowhere else (the Cloud).
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
  if (!can(org, "configure") || routing.by === "off" || routing.by === "jev" || !settings.data || !models.data)
    return null;
  const saved = settings.data.routerModel ?? AUTO;
  // Only a model the workspace can call, and the one saved even when its key is gone, so the field still says it.
  const choices = modelChoices(models.data.models, credentials.data ?? [], platform.data ?? false).flatMap(
    ([group, list]) => {
      const kept = list.filter((c) => c.available || c.model.id === saved);
      return kept.length > 0 ? [[group, kept] as [string, typeof kept]] : [];
    },
  );
  // On Automático the model picking today is named, when it is one.
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
      hint={{ name: t("common.about", { label: t("routing.model.title") }), text: t("routing.model.hint") }}
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
              leading: (
                <span className="newag__ib">
                  <Icon name="bulb" size={16} />
                </span>
              ),
            },
            ...modelOptions(t, i18n.language, choices),
          ]}
        />
      </Locked>
    </SettingRow>
  );
}
