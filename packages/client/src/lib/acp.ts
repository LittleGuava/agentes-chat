import type { TFunction } from "i18next";
import type { AcpEngine, AgentBrain } from "../api/types";

/*
 * ACP agents a computer declares (ADR 0216), as "Quem pensa" shows them on the web and the phone: each by the name its
 * computer's owner gave it, with the models it offered. The view lists them in `acp`, apart from `options`, and
 * `engine` names the one the agent thinks with. None has a plan of ours or an Automático: a model it offered, or its
 * own default (no model saved).
 */

/** The value of "its own default" among a model list's rows: no model saved. */
export const ACP_DEFAULT_MODEL = "";

/** The ACP agents the agent's computer declares and can run now; none where it can't (commands off, an old runner). */
export const acpEngines = (view: Pick<AgentBrain, "acp">): AcpEngine[] => (view.acp?.available ? view.acp.engines : []);

/** The ACP agent the agent thinks with; one its computer stopped declaring by its id. Null on any other brain. */
export function acpEngineOf(view: Pick<AgentBrain, "brain" | "engine" | "acp">): AcpEngine | null {
  if (view.brain !== "acp") return null;
  const id = view.engine ?? "";
  return view.acp?.engines.find((e) => e.id === id) ?? { id, name: id, models: [] };
}

/** What thinks, in the sentence every place says it: the model by that agent ("Devstral 3 pelo Mistral Vibe"). */
export const acpThinks = (t: TFunction, engine: string | undefined, model: string | null) => {
  const name = engine || t("brain.acp.name");
  return model ? t("brain.line.acp", { model, engine: name }) : name;
};

/** What thinks now, as `acpThinks` says it, from the agent's brain view. */
export function acpThinksNow(t: TFunction, view: Pick<AgentBrain, "brain" | "engine" | "acp" | "effectiveModel">) {
  const engine = acpEngineOf(view);
  const model = view.effectiveModel || null;
  return acpThinks(t, engine?.name, model && (engine?.models.find((m) => m.value === model)?.label ?? model));
}

/** Its models as a list: its own default first, then each it offered, and one it no longer lists while it runs it. */
export function acpModelRows(t: TFunction, view: Pick<AgentBrain, "brain" | "engine" | "acp" | "effectiveModel">) {
  const engine = acpEngineOf(view);
  const chosen = view.effectiveModel ?? ACP_DEFAULT_MODEL;
  const models = engine?.models ?? [];
  const rows = [
    {
      value: ACP_DEFAULT_MODEL,
      label: t("brain.acp.defaultModel", { engine: engine?.name ?? t("brain.acp.name") }),
      sub: t("brain.acp.defaultModelHint"),
    },
    ...(chosen === ACP_DEFAULT_MODEL || models.some((m) => m.value === chosen)
      ? []
      : [{ value: chosen, label: chosen }]),
    ...models.map((m) => ({ value: m.value, label: m.label })),
  ];
  return rows.map((r) => ({ ...r, checked: r.value === chosen }));
}

/** What picking one of its models saves: that model, or none for its own default. */
export const acpModelInput = (value: string) => ({ model: value === ACP_DEFAULT_MODEL ? null : value });
