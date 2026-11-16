import { type Executor, eq, schema } from "@agenteschat/db";
import { isAutoModel, isKnownProvider, modelProvider, PROVIDERS } from "@agenteschat/providers";
import { BRAIN_NAMES, type BrainKind, isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { modelInfoFor } from "./credentials";
import { ValidationError } from "./errors";

/*
 * What a workspace's agents may think with (ADR 0191): the brains, the API brain's providers and its models. Every list
 * restricts, null allows all of its kind, and no rule at all (null) restricts nothing. The Model Gateway, the
 * executor (`resolveBrain`) and the saves read it here; the apps only explain it.
 */

export interface BrainPolicy {
  /** The brains agents may think with; null: every brain. */
  brains: BrainKind[] | null;
  /** The API brain's providers (`PROVIDER_IDS`); null: every provider. */
  providers: string[] | null;
  /** The API brain's models (catalog, OpenRouter or endpoint ids); null: every model of an allowed provider. */
  models: string[] | null;
}

const BRAINS: readonly BrainKind[] = ["model", ...(Object.keys(BRAIN_NAMES) as BrainKind[])];
const LIST_MAX = 200;

const listOf = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v as string[])] : null;

/** A stored rule read back: anything unreadable is no rule, a list that isn't one allows all of its kind. */
export function policyOf(stored: unknown): BrainPolicy | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;
  const brains = listOf(s.brains)?.filter((b): b is BrainKind => (BRAINS as readonly string[]).includes(b)) ?? null;
  return { brains, providers: listOf(s.providers), models: listOf(s.models) };
}

export const brainAllowed = (policy: BrainPolicy | null, kind: BrainKind) =>
  !policy?.brains || policy.brains.includes(kind);

/** The API brain may think on this provider's models. */
export const providerAllowed = (policy: BrainPolicy | null, provider: string) =>
  brainAllowed(policy, "model") && (!policy?.providers || policy.providers.includes(provider));

/** The API brain may think with this model (Automático: the model it picked, never `auto` itself). */
export function modelAllowed(policy: BrainPolicy | null, model: string): boolean {
  if (!policy) return true;
  const provider = modelProvider(model);
  if (!provider || !providerAllowed(policy, provider)) return false;
  return !policy.models || policy.models.includes(model);
}

const providerName = (id: string) => (isKnownProvider(id) ? PROVIDERS[id].label : id);

/**
 * Why the rule refuses a brain or the API brain's model (`brain.not_allowed`, the words a run fails with), or null.
 * `model`: the API brain's, `auto` allowed with the brain (its pick is checked when made).
 */
export function brainPolicyRefusal(
  policy: BrainPolicy | null,
  kind: BrainKind,
  model?: string | null,
): ValidationError | null {
  if (!policy) return null;
  if (!brainAllowed(policy, kind)) {
    const name = isComputerBrain(kind) ? BRAIN_NAMES[kind] : "The API";
    return new ValidationError(
      `This workspace's rules don't let agents think with ${name}. Ask an admin, or choose another brain.`,
      "brain.not_allowed",
      { brain: kind },
    );
  }
  if (kind !== "model" || !model || isAutoModel(model) || modelAllowed(policy, model)) return null;
  const provider = modelProvider(model);
  return new ValidationError(
    provider && !providerAllowed(policy, provider)
      ? `This workspace's rules don't let agents use ${providerName(provider)}'s models. Ask an admin, or choose another model.`
      : `This workspace's rules don't let agents use ${model}. Ask an admin, or choose another model.`,
    "brain.not_allowed",
    { brain: kind, model, provider: provider ?? null },
  );
}

/**
 * An agent's API model as it is saved (`validateAgentFields`): its provider and model only. Whether the API brain thinks
 * at all is `setAgentBrain`'s, so an agent on a computer brain keeps an API model to fall back on when the rule allows it.
 */
export const apiModelRefusal = (policy: BrainPolicy | null, model: string) =>
  brainPolicyRefusal(policy && { ...policy, brains: null }, "model", model);

export const brainPolicyCacheKey = (orgId: string) => `${orgId}:brain-policy`;

/** The workspace's rule (`organization_settings.allowed_brains`), cached; null: nothing restricted. */
export async function orgBrainPolicy(db: Executor, orgId: string): Promise<BrainPolicy | null> {
  return (await caches.orgs.getOrLoad(brainPolicyCacheKey(orgId), async () => {
    const [row] = await db
      .select({ allowedBrains: schema.organizationSettings.allowedBrains })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId));
    return policyOf(row?.allowedBrains);
  })) as BrainPolicy | null;
}

const invalid = (message: string) => new ValidationError(message, "brain_policy.invalid");

/** A rule as an admin saves it: each list known and not empty, each model known and of an allowed provider. */
export async function validBrainPolicy(db: Executor, orgId: string, input: unknown): Promise<BrainPolicy | null> {
  if (input === null) return null;
  if (!input || typeof input !== "object") throw invalid("allowedBrains is an object or null");
  const raw = input as Record<string, unknown>;
  const list = (key: keyof BrainPolicy): string[] | null => {
    const v = raw[key];
    if (v === null || v === undefined) return null;
    const out = listOf(v);
    if (!out) throw invalid(`allowedBrains.${key} is a list of names or null`);
    if (out.length === 0) throw invalid(`allowedBrains.${key} can't be empty: null allows every one`);
    if (out.length > LIST_MAX) throw invalid(`allowedBrains.${key} has at most ${LIST_MAX} names`);
    return out;
  };
  const brains = list("brains");
  const providers = list("providers");
  const models = list("models");
  for (const b of brains ?? [])
    if (!(BRAINS as readonly string[]).includes(b)) throw invalid(`${b} isn't a brain: ${BRAINS.join(", ")}`);
  for (const p of providers ?? []) if (!isKnownProvider(p)) throw invalid(`${p} isn't a provider`);
  for (const m of models ?? []) {
    const info = await modelInfoFor(db, m, orgId);
    if (!info) throw invalid(`Unknown model ${m}`);
    if (providers && !providers.includes(info.provider))
      throw invalid(`${m} is ${providerName(info.provider)}'s, which the rule leaves out`);
  }
  return { brains: brains as BrainKind[] | null, providers, models };
}
