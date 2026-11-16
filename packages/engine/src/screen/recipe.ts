import { SCREEN_NOUN, screenRef } from "./observation";
import { actsOnTarget, type PlanReport, type ScreenStep, type ScreenVerb, screenStepOf } from "./plan";
import type { TargetMemory } from "./targets";

/**
 * Saved steps (ADR 0054, addendum 2026-11-15): a plan that went through, kept under a name with where each target
 * was, to run again by code alone. Replayed, each target is found only where it was (`ScreenStep.pinned`), its checks
 * are checked again, and the plan stops at the first step that doesn't hold, handing the rest back to the agent.
 */

/** Most characters in a saved plan's name. */
export const RECIPE_NAME_MAX = 80;

export type RecipeOutcome = { ok: true; steps: ScreenStep[] } | { ok: false; reason: string };

/** The steps of a plan that went through, each target where it was found; why not, otherwise. */
export function recipeOf(report: PlanReport): RecipeOutcome {
  if (report.stopped || report.steps.some((s) => s.status !== "done")) {
    return { ok: false, reason: "they didn't all go through" };
  }
  const noun = SCREEN_NOUN[report.kind ?? "browser"];
  const steps: ScreenStep[] = [];
  for (const [i, r] of report.steps.entries()) {
    const { pinned: _, ...step } = r.step;
    if (!actsOnTarget(step)) {
      steps.push(step);
      continue;
    }
    if (!r.pinned) {
      return {
        ok: false,
        reason: `step ${i + 1}'s target wasn't an element of the ${noun} it could be found by again (it was found only on the ${noun}'s image, or by a number the ${noun} hadn't shown): name it in words, then save the steps again`,
      };
    }
    steps.push({ ...step, pinned: r.pinned });
  }
  return { ok: true, steps };
}

function pinOf(v: unknown): TargetMemory | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.role !== "string" || typeof p.name !== "string") return null;
  if (!Array.isArray(p.context) || !p.context.every((c) => typeof c === "string")) return null;
  return { role: p.role, name: p.name, context: p.context, ...(p.costly === true ? { costly: true } : {}) };
}

/**
 * Saved steps as stored (a JSON column: read as data from outside), checked as a model's steps are, for a screen
 * that takes `verbs`; each step that acts on a target must say where it was. Null when anything doesn't hold.
 */
export function recipeStepsOf(value: unknown, verbs: readonly ScreenVerb[]): ScreenStep[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const steps: ScreenStep[] = [];
  for (const v of value) {
    const step = screenStepOf(v, verbs);
    if (!step) return null;
    const raw = (v as { pinned?: unknown }).pinned;
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const pins = raw.map(pinOf);
      if (pins.some((p) => p === null)) return null;
      step.pinned = pins as TargetMemory[];
    }
    if (actsOnTarget(step) !== Boolean(step.pinned)) return null;
    steps.push(step);
  }
  return steps;
}

/** Where saved steps stopped: the ones not done yet, as the agent writes steps, to go on by hand; null when none. */
export function recipeHandBack(report: PlanReport): string | null {
  if (!report.stopped) return null;
  const { index } = report.stopped;
  // A step that ran and only failed its check was done: it must not be done again.
  const from = report.steps[index]?.ran ? index + 1 : index;
  let numbered = false;
  const isNumber = (t: string | undefined) => t !== undefined && screenRef(t) !== null;
  const rest = report.steps.slice(from).map(({ step: { pinned: _, ...step } }) => {
    // A number names another element on another day: left out, never swapped for the element's name (page text).
    if (isNumber(step.target) || isNumber(step.to) || step.targets?.some(isNumber)) numbered = true;
    if (isNumber(step.target)) delete step.target;
    if (isNumber(step.to)) delete step.to;
    if (step.targets?.some(isNumber)) delete step.targets;
    return step;
  });
  if (rest.length === 0) return null;
  const noun = SCREEN_NOUN[report.kind ?? "browser"];
  const note = numbered
    ? `. A target that was a number then is left out: read the ${noun} and give its number now.`
    : "";
  return `The saved steps from there, to go on yourself with \`steps\`: ${JSON.stringify(rest)}${note}`;
}

/** What the agent hears when steps are saved: and which of them a replay stops before, since they can't be undone. */
export function recipeSavedText(name: string, steps: ScreenStep[]): string {
  const stops = steps.flatMap((s, i) => (s.pinned?.some((p) => p.costly) ? [i + 1] : []));
  const saved = `Saved these steps as "${name}": run them again with \`recipe\`.`;
  if (stops.length === 0) return saved;
  const which = stops.length === 1 ? `step ${stops[0]}` : `steps ${stops.join(", ")}`;
  const one = stops.length === 1;
  return `${saved} A replay stops before ${which}: ${one ? "it" : "they"} can't be undone, or no judge could tell, so you do ${one ? "it" : "them"} yourself.`;
}
