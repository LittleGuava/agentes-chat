import type { ScreenKind } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, schema, sql } from "@agenteschat/db";
import { screenKey } from "./right-hand-seats";
import {
  type PlanReport,
  RECIPE_NAME_MAX,
  recipeHandBack,
  recipeOf,
  recipeSavedText,
  recipeStepsOf,
  SCREEN_NOUN,
  type ScreenStep,
  type ScreenVerb,
} from "./screen";
import type { JsonSchema } from "./tools/json-schema";
import type { ToolContext, ToolOutput } from "./tools/types";

/**
 * Saved steps kept per screen (ADR 0054, addendum 2026-11-15): `browser_do` and `desktop_do` save a plan that went
 * through under a name (`save_as`) and run one again by it (`recipe`). Rows are the agent's screen's as the server
 * remembers it (`screenKey`), so a right hand's seat never runs another seat's steps.
 */

/** Most saved plans one agent keeps per screen (and seat). */
export const MAX_SCREEN_RECIPES = 100;

export interface RecipePlace {
  orgId: string;
  /** `screenKey`: the agent, and on the right hand its seat. */
  key: string;
  screen: ScreenKind;
}

const where = (p: RecipePlace) =>
  and(
    eq(schema.screenRecipes.orgId, p.orgId),
    eq(schema.screenRecipes.screenKey, p.key),
    eq(schema.screenRecipes.screen, p.screen),
  );

/** The names of the plans saved on this screen, in order. */
export async function screenRecipeNames(db: Database, place: RecipePlace): Promise<string[]> {
  const rows = await db
    .select({ name: schema.screenRecipes.name })
    .from(schema.screenRecipes)
    .where(where(place))
    .orderBy(asc(schema.screenRecipes.name));
  return rows.map((r) => r.name);
}

/** A saved plan by its name, ignoring case (the exact name first); its steps as stored. */
async function storedRecipe(db: Database, place: RecipePlace, name: string) {
  const [row] = await db
    .select({ name: schema.screenRecipes.name, steps: schema.screenRecipes.steps })
    .from(schema.screenRecipes)
    .where(and(where(place), sql`lower(${schema.screenRecipes.name}) = lower(${name})`))
    .orderBy(sql`${schema.screenRecipes.name} = ${name} desc`, desc(schema.screenRecipes.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Keeps `steps` under `name` (the plan saved under it before is replaced); why not, when it can't. */
export async function saveScreenRecipe(
  db: Database,
  place: RecipePlace & { agentId: string; name: string; steps: ScreenStep[]; runId: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [count] = await db
    .select({
      n: sql<number>`count(*)::int`,
      same: sql<number>`count(*) filter (where ${schema.screenRecipes.name} = ${place.name})::int`,
    })
    .from(schema.screenRecipes)
    .where(where(place));
  if ((count?.n ?? 0) >= MAX_SCREEN_RECIPES && !count?.same) {
    return {
      ok: false,
      reason: `you keep ${MAX_SCREEN_RECIPES} on the ${place.screen} already: save these under the name of one you no longer need`,
    };
  }
  const now = new Date();
  await db
    .insert(schema.screenRecipes)
    .values({
      orgId: place.orgId,
      agentId: place.agentId,
      screenKey: place.key,
      screen: place.screen,
      name: place.name,
      steps: place.steps,
      runId: place.runId,
    })
    .onConflictDoUpdate({
      target: [schema.screenRecipes.screenKey, schema.screenRecipes.screen, schema.screenRecipes.name],
      set: { steps: place.steps, runId: place.runId, updatedAt: now },
    });
  return { ok: true };
}

/** `save_as` and `recipe` in a plan tool's input (beside `steps`, which neither requires any more). */
export function recipeProperties(screen: ScreenKind): Record<string, JsonSchema> {
  const noun = SCREEN_NOUN[screen];
  return {
    save_as: {
      type: "string",
      description: `With \`steps\`: when they all go through, keep them under this name, each target with where it was found on the ${noun}, to run them again later with \`recipe\` (a task you'll repeat). The same name replaces them.`,
      maxLength: RECIPE_NAME_MAX,
    },
    recipe: {
      type: "string",
      description: `Instead of \`steps\`: run steps you kept with \`save_as\` again, by their name, without planning them. Each target is found only where it was, and every \`expect\` is checked again: they stop at the first step that doesn't hold and give you the rest to go on with \`steps\`. A name you didn't keep lists yours.`,
      maxLength: RECIPE_NAME_MAX,
    },
  };
}

/** What a plan tool was asked: steps written out (to save, with `saveAs`), or saved ones by name (`replay`). */
export type PlanAsk = { steps: ScreenStep[]; saveAs?: string; replay?: string } | { error: string };

const placeOf = async (ctx: ToolContext, screen: ScreenKind): Promise<RecipePlace> => ({
  orgId: ctx.orgId,
  key: await screenKey(ctx),
  screen,
});

/**
 * Reads `steps`, `save_as` and `recipe` from a plan tool's input. Saved steps are read back as data from outside:
 * checked as the model's are, for this screen's `verbs`, each target with where it was.
 */
export async function planAskOf(
  ctx: ToolContext,
  screen: ScreenKind,
  input: Record<string, unknown>,
  stepOf: (raw: unknown) => ScreenStep | null,
  verbs: readonly ScreenVerb[],
): Promise<PlanAsk> {
  const recipe = typeof input.recipe === "string" ? input.recipe.trim() : "";
  const saveAs = typeof input.save_as === "string" ? input.save_as.trim() : "";
  if (recipe) {
    if (input.steps !== undefined) return { error: "Give `steps` or `recipe`, not both." };
    if (saveAs) return { error: "`save_as` names steps you write out (`steps`): saved steps keep their name." };
    const place = await placeOf(ctx, screen);
    const found = await storedRecipe(ctx.db, place, recipe);
    if (!found) {
      const names = await screenRecipeNames(ctx.db, place);
      const yours =
        names.length > 0
          ? `Yours on the ${screen}: ${names.map((n) => `"${n}"`).join(", ")}.`
          : `You have none on the ${screen}: a plan that goes through is kept with \`save_as\`.`;
      return { error: `No saved steps are called "${recipe}". ${yours}` };
    }
    const steps = recipeStepsOf(found.steps, verbs);
    if (!steps) {
      return { error: `The saved steps "${found.name}" can't be read: write them out again (\`steps\`, \`save_as\`).` };
    }
    return { steps, replay: found.name };
  }
  const raw = Array.isArray(input.steps) ? input.steps : [];
  const steps = raw.map(stepOf);
  if (steps.length === 0 || steps.some((s) => s === null)) return { error: "Give `steps`, each with a known `do`." };
  if (saveAs.length > RECIPE_NAME_MAX) return { error: `Name saved steps in at most ${RECIPE_NAME_MAX} characters.` };
  return { steps: steps as ScreenStep[], ...(saveAs ? { saveAs } : {}) };
}

/** A plan's answer with what became of its saved steps: run again (and where they stopped), or saved now. */
export async function afterPlanAsk(
  ctx: ToolContext,
  screen: ScreenKind,
  ask: { saveAs?: string; replay?: string },
  report: PlanReport | null,
  out: ToolOutput,
): Promise<ToolOutput> {
  if (!report) return out;
  if (ask.replay) {
    const back = recipeHandBack(report);
    return { ...out, content: `Ran your saved steps "${ask.replay}".\n${out.content}${back ? `\n${back}` : ""}` };
  }
  if (!ask.saveAs) return out;
  const name = ask.saveAs;
  const said = (line: string): ToolOutput => ({ ...out, content: `${line}\n${out.content}` });
  const recipe = recipeOf(report);
  if (!recipe.ok) return said(`Not saved as "${name}": ${recipe.reason}.`);
  const saved = await saveScreenRecipe(ctx.db, {
    ...(await placeOf(ctx, screen)),
    agentId: ctx.agentId,
    name,
    steps: recipe.steps,
    runId: ctx.runId || null,
  });
  return said(saved.ok ? recipeSavedText(name, recipe.steps) : `Not saved as "${name}": ${saved.reason}.`);
}
