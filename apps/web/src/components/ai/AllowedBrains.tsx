import type { BrainKind, BrainPolicy, Model } from "@agenteschat/client";
import { useModels, useSettings, useUpdateSettings } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { providerLabel } from "@agenteschat/client/lib/providers";
import {
  Button,
  Card,
  CardHeader,
  CheckboxPill,
  InfoHint,
  Locked,
  SettingNote,
  SettingRow,
  Switch,
} from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** Every brain, the API first, as "Quem pensa" lists them. */
const BRAINS: readonly BrainKind[] = [
  "model",
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "copilot",
];

/** The rule as the card edits it: every list whole, `onlySome` keeping the models list while it is off. */
interface Draft {
  brains: BrainKind[];
  providers: string[];
  onlySome: boolean;
  models: string[];
}

const draftOf = (policy: BrainPolicy | null | undefined, providers: readonly string[]): Draft => ({
  brains: policy?.brains ?? [...BRAINS],
  providers: policy?.providers ?? [...providers],
  onlySome: Boolean(policy?.models),
  models: policy?.models ?? [],
});

/** What the card saves: a list holding everything is no limit (null), and nothing limited is no rule at all. */
function policyOf(d: Draft, providers: readonly string[]): BrainPolicy | null {
  const brains = BRAINS.every((b) => d.brains.includes(b)) ? null : BRAINS.filter((b) => d.brains.includes(b));
  const api = d.brains.includes("model");
  const listed = providers.filter((p) => d.providers.includes(p));
  const providersOut = !api || listed.length === providers.length ? null : listed;
  const models = api && d.onlySome ? d.models : null;
  return brains || providersOut || models ? { brains, providers: providersOut, models } : null;
}

const toggle = <T,>(list: readonly T[], item: T, on: boolean) =>
  on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);

/**
 * "O que os agentes podem usar" (ADR 0191): the brains, the API's providers and, if the admin wants, its models every
 * agent of the workspace may think with. The server holds it on every call and save; here admins only set it.
 */
export function AllowedBrainsCard() {
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const models = useModels();
  if (!can(org, "configure") || !settings.data || !models.data) return null;
  // The providers the pickers know: the catalog's, OpenRouter's and the workspace's own endpoints.
  const all = models.data.models.filter((m) => m.pick !== false);
  const saved = settings.data.allowedBrains ?? null;
  // A save (here or elsewhere) starts the draft again from what the server keeps.
  return <AllowedBrainsForm key={JSON.stringify(saved)} saved={saved} all={all} />;
}

function AllowedBrainsForm({ saved, all }: { saved: BrainPolicy | null; all: Model[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const update = useUpdateSettings(org.id);
  const toast = useToast();
  const id = useId();
  const providers = [...new Set(all.map((m) => m.provider))];
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved, providers));
  const next = policyOf(draft, providers);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const api = draft.brains.includes("model");
  const shownModels = all.filter((m) => draft.providers.includes(m.provider));
  const empty =
    draft.brains.length === 0 || (api && (draft.providers.length === 0 || (draft.onlySome && !draft.models.length)));
  const save = () =>
    update.mutate(
      { allowedBrains: next },
      {
        onSuccess: () => toast.show(t("settings.allowedBrains.saved")),
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  const brainName = (b: BrainKind) => (b === "model" ? t("brain.model") : t(`brain.card.${b}`));
  return (
    <Card aria-labelledby={`${id}-title`}>
      <CardHeader
        id={`${id}-title`}
        icon="shield"
        title={t("settings.allowedBrains.title")}
        action={
          <InfoHint name={t("common.about", { label: t("settings.allowedBrains.title") })}>
            {t("settings.allowedBrains.hint")}
          </InfoHint>
        }
      />
      <Locked when={update.isPending}>
        <fieldset className="mail-rules__group">
          <legend className="ac-field__label">{t("settings.allowedBrains.brains")}</legend>
          <div className="newag__pills">
            {BRAINS.map((b) => (
              <CheckboxPill
                key={b}
                id={`${id}-brain-${b}`}
                checked={draft.brains.includes(b)}
                onCheckedChange={(on) => setDraft({ ...draft, brains: toggle(draft.brains, b, on) })}
              >
                {brainName(b)}
              </CheckboxPill>
            ))}
          </div>
        </fieldset>
        {api && (
          <fieldset className="mail-rules__group">
            <legend className="ac-field__label">{t("settings.allowedBrains.providers")}</legend>
            <div className="newag__pills">
              {providers.map((p) => (
                <CheckboxPill
                  key={p}
                  id={`${id}-provider-${p}`}
                  checked={draft.providers.includes(p)}
                  onCheckedChange={(on) =>
                    setDraft({
                      ...draft,
                      providers: toggle(draft.providers, p, on),
                      // A model of a provider left out could never run: it leaves the list with it.
                      models: on
                        ? draft.models
                        : draft.models.filter((m) => all.find((x) => x.id === m)?.provider !== p),
                    })
                  }
                >
                  {providerLabel(p)}
                </CheckboxPill>
              ))}
            </div>
          </fieldset>
        )}
        {api && (
          <SettingRow title={t("settings.allowedBrains.onlySome")} htmlFor={`${id}-only`}>
            <Switch
              id={`${id}-only`}
              checked={draft.onlySome}
              onCheckedChange={(on) => setDraft({ ...draft, onlySome: on })}
            />
          </SettingRow>
        )}
        {api && draft.onlySome && (
          <fieldset className="mail-rules__group">
            <legend className="ac-field__label">{t("settings.allowedBrains.models")}</legend>
            <div className="newag__pills">
              {shownModels.map((m) => (
                <CheckboxPill
                  key={m.id}
                  id={`${id}-model-${m.id}`}
                  checked={draft.models.includes(m.id)}
                  onCheckedChange={(on) => setDraft({ ...draft, models: toggle(draft.models, m.id, on) })}
                >
                  {m.label}
                </CheckboxPill>
              ))}
            </div>
          </fieldset>
        )}
      </Locked>
      {empty && <SettingNote icon="alert">{t("settings.allowedBrains.empty")}</SettingNote>}
      <div className="ac-acts">
        <Button
          variant="primary"
          disabled={!dirty || empty || update.isPending}
          loading={update.isPending}
          onClick={save}
        >
          {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}
