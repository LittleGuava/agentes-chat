import type { BrainKind, BrainPolicy, Model } from "../api/types";

/*
 * The workspace's rule on what agents think with (ADR 0191), as the pickers explain it. The server holds it on every
 * call and save (`packages/engine/src/brain-policy.ts`); these only grey and word what it would refuse.
 */

export const brainAllowedBy = (policy: BrainPolicy | null | undefined, kind: BrainKind) =>
  !policy?.brains || policy.brains.includes(kind);

/** The API brain may think with this model: the API allowed, its provider listed or all, the model listed or all. */
export const modelAllowedBy = (policy: BrainPolicy | null | undefined, model: Pick<Model, "id" | "provider">) =>
  !policy ||
  (brainAllowedBy(policy, "model") &&
    (!policy.providers || policy.providers.includes(model.provider)) &&
    (!policy.models || policy.models.includes(model.id)));
