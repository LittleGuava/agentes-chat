import { describe, expect, test } from "bun:test";
import {
  createFakeJudge,
  formatPlanReport,
  type PlanReport,
  recipeHandBack,
  recipeOf,
  recipeSavedText,
  recipeStepsOf,
  runPlan,
  type ScreenStep,
  type ScreenVerb,
  screenStepOf,
} from "../src";
import { acted, fakeScreen, ticking } from "./screen-fixtures";

const ids = { orgId: "o", agentId: "a", runId: "r", scope: "a" };

const LOGIN = `- main
  - form "Sign in"
    - textbox "Email" [ref=e3]
    - button "Sign in" [ref=e5]
  - link "Help" [ref=e6]`;

/** The same page another day: every element has another number. */
const LOGIN_LATER = `- banner
  - link "Acme" [ref=e1]
- main
  - form "Sign in"
    - textbox "Email" [ref=e8]
    - button "Sign in" [ref=e9]
  - link "Help" [ref=e10]`;

const browser = (text: string) => fakeScreen(text, { kind: "browser", url: "https://app.acme.example/login" });

/**
 * A judge that picks `ref` for any words and says whether acting on it can't be undone; every check holds.
 */
const picking = (ref: string, costly = 0) =>
  createFakeJudge((kind, id) => {
    if (kind === "screen_check") return 0.95;
    if (kind !== "screen_target") return undefined;
    if (id === "present") return 0.95;
    if (id === "costly") return costly;
    return { choice: ref, probabilities: { [ref]: 0.95 } };
  });

/** A judge that answers nothing: a saved target must never need it. */
const refusing = () =>
  createFakeJudge((kind) => {
    if (kind === "screen_target") throw new Error("the judge was asked for a saved target");
    return undefined;
  });

async function saved(steps: ScreenStep[], judge = picking("e5")) {
  const surface = browser(LOGIN);
  // The agent read the page first: a number it gives is an element it saw.
  const report = await runPlan({ judge, ...ids, surface, last: await surface.observe(), keep: true }, steps);
  const recipe = recipeOf(report);
  if (!recipe.ok) throw new Error(recipe.reason);
  return recipe.steps;
}

describe("saved steps", () => {
  test("a plan that went through is kept with where each target was, and repeated there without the judge", async () => {
    const steps = await saved([
      { do: "fill", target: "Email", text: "ana@acme.example" },
      { do: "click", target: "the button that signs me in" },
    ]);
    expect(steps[1]?.pinned).toEqual([{ role: "button", name: "Sign in", context: ['form "Sign in"'] }]);
    expect(steps[0]?.pinned).toEqual([{ role: "textbox", name: "Email", context: ['form "Sign in"'] }]);

    const judge = refusing();
    const surface = browser(LOGIN_LATER);
    const report = await runPlan({ judge, ...ids, surface }, steps);
    expect(report.stopped).toBeUndefined();
    expect(acted(surface.actions)).toEqual([
      { kind: "fill", at: { ref: "e8" }, text: "ana@acme.example" },
      { kind: "click", at: { ref: "e9" } },
    ]);
    expect(judge.calls.filter((c) => c.kind === "screen_target")).toHaveLength(0);
    expect(report.steps.map((s) => s.via)).toEqual(["saved", "saved"]);
  });

  test("a saved step given by number acts on the element it was, never on whatever has that number now", async () => {
    const steps = await saved([{ do: "click", target: "e5" }]);
    const moved = browser(`- main
  - button "Delete account" [ref=e5]
  - form "Sign in"
    - button "Sign in" [ref=e7]`);
    await runPlan({ judge: refusing(), ...ids, surface: moved }, steps);
    expect(acted(moved.actions)).toEqual([{ kind: "click", at: { ref: "e7" } }]);

    const gone = browser('- main\n  - button "Delete account" [ref=e5]');
    const report = await runPlan({ judge: refusing(), ...ids, surface: gone }, steps);
    expect(acted(gone.actions)).toEqual([]);
    expect(report.stopped).toMatchObject({ index: 0 });
  });

  test("a saved target gone, moved elsewhere or there twice stops that step; nothing after it runs", async () => {
    const steps = await saved([
      { do: "fill", target: "Email", text: "ana@acme.example" },
      { do: "click", target: "Sign in" },
      { do: "click", target: "Help" },
    ]);
    const cases = [
      // Gone.
      `- main\n  - form "Sign in"\n    - textbox "Email" [ref=e3]`,
      // In another place: not the button it was.
      `- main\n  - form "Sign in"\n    - textbox "Email" [ref=e3]\n  - dialog "Delete"\n    - button "Sign in" [ref=e4]`,
      // Twice in the same place: which one is a guess.
      `- main\n  - form "Sign in"\n    - textbox "Email" [ref=e3]\n    - button "Sign in" [ref=e4]\n    - button "Sign in" [ref=e5]`,
    ];
    for (const text of cases) {
      const surface = browser(text);
      const report = await runPlan({ judge: refusing(), ...ids, surface }, steps);
      expect(report.stopped).toMatchObject({ index: 1 });
      expect(report.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
      expect(acted(surface.actions).map((a) => a.kind)).toEqual(["fill"]);
      // Page text reaches the agent only inside the untrusted block: the reason names the role alone.
      expect(report.stopped?.reason).toBe("the saved button isn't on the page as it was when these steps were saved");
    }
  });

  test("a target the judge found can't be undone is never repeated from saved steps: they stop before it", async () => {
    const steps = await saved([{ do: "click", target: "the button that signs me in" }], picking("e5", 0.9));
    expect(steps[0]?.pinned?.[0]?.costly).toBe(true);
    const surface = browser(LOGIN_LATER);
    const report = await runPlan({ judge: refusing(), ...ids, surface }, steps);
    expect(acted(surface.actions)).toEqual([]);
    expect(report.stopped?.reason).toContain("can't be undone");
  });

  test("kept steps ask once whether a target named exactly can't be undone; no answer counts as yes", async () => {
    const costly = createFakeJudge((kind) => (kind === "screen_costly" ? 0.9 : undefined));
    const named = await saved([{ do: "click", target: "Sign in" }], costly);
    expect(named[0]?.pinned?.[0]?.costly).toBe(true);
    expect(costly.calls.filter((c) => c.kind === "screen_costly")).toHaveLength(1);
    // The agent hears it on saving, not on the day it replays them.
    expect(recipeSavedText("Sign in", [{ do: "open", url: "https://app.acme.example/login" }, ...named])).toBe(
      'Saved these steps as "Sign in": run them again with `recipe`. A replay stops before step 2: it can\'t be undone, or no judge could tell, so you do it yourself.',
    );
    const silent = createFakeJudge((kind) => {
      if (kind === "screen_costly") throw new Error("no judge here");
      return undefined;
    });
    expect((await saved([{ do: "click", target: "e5" }], silent))[0]?.pinned?.[0]?.costly).toBe(true);
    // A plan that isn't kept asks nothing more.
    const asked = createFakeJudge();
    await runPlan({ judge: asked, ...ids, surface: browser(LOGIN) }, [{ do: "click", target: "Sign in" }]);
    expect(asked.calls).toHaveLength(0);
  });

  test("only a plan that went through, every target found as an element, is kept", async () => {
    const stopped = await runPlan({ judge: createFakeJudge(), ...ids, surface: browser(LOGIN) }, [
      { do: "click", target: "Sign in" },
      { do: "click", target: "Export" },
    ]);
    expect(recipeOf(stopped)).toEqual({ ok: false, reason: "they didn't all go through" });

    // Found only on the screen's image (a spot, no element): nothing to find it by again.
    const judge = createFakeJudge((kind, id) => {
      if (kind === "screen_target") return id === "present" ? 0.05 : { choice: "none", probabilities: { none: 0.9 } };
      if (kind === "screen_locate")
        return id === "present" ? 0.9 : { box: { top: 0.1, bottom: 0.2, left: 0.1, right: 0.2 } };
      return undefined;
    });
    const surface = fakeScreen(LOGIN, {
      kind: "browser",
      url: "https://app.acme.example/login",
      capture: () => ({ data: "AAAA", width: 1000, height: 500, viewport: { width: 1000, height: 500 } }),
    });
    const spot = await runPlan({ judge, ...ids, surface, vision: true, now: ticking() }, [
      { do: "press", key: "Tab" },
      { do: "click", target: "the chart's settings gear" },
    ]);
    expect(spot.stopped).toBeUndefined();
    expect(spot.steps[1]?.via).toBe("image");
    const refused = recipeOf(spot);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("step 2");

    // Steps with no target need nothing more.
    const open = await saved([
      { do: "open", url: "https://app.acme.example/login" },
      { do: "press", key: "Enter" },
    ]);
    expect(open).toEqual([
      { do: "open", url: "https://app.acme.example/login" },
      { do: "press", key: "Enter" },
    ]);
  });

  test("the model can't pin a target, and saved steps are read back checked", async () => {
    const verbs: ScreenVerb[] = ["open", "click", "fill"];
    const pinned = [{ role: "button", name: "Pay", context: [] }];
    expect(screenStepOf({ do: "click", target: "Sign in", pinned }, verbs)).toEqual({ do: "click", target: "Sign in" });

    const steps = await saved([
      { do: "open", url: "https://app.acme.example/login" },
      { do: "click", target: "Sign in", expect: "signed in" },
    ]);
    const stored: unknown = JSON.parse(JSON.stringify(steps));
    expect(recipeStepsOf(stored, verbs)).toEqual(steps);
    // A verb this screen doesn't take, a target with nothing saved, a pin that isn't one: not steps.
    expect(recipeStepsOf(stored, ["open"])).toBeNull();
    expect(recipeStepsOf([{ do: "click", target: "Sign in" }], verbs)).toBeNull();
    expect(recipeStepsOf([{ do: "click", target: "Sign in", pinned: [{ role: 1, name: "x" }] }], verbs)).toBeNull();
    expect(recipeStepsOf("click", verbs)).toBeNull();
    expect(recipeStepsOf([], verbs)).toBeNull();
  });

  test("where saved steps stop, the agent gets the rest of them to go on by hand", async () => {
    const steps = await saved([
      { do: "fill", target: "Email", text: "ana@acme.example" },
      { do: "click", target: "Sign in" },
      { do: "click", target: "Help" },
    ]);
    const surface = browser('- main\n  - form "Sign in"\n    - textbox "Email" [ref=e3]');
    const report: PlanReport = await runPlan({ judge: refusing(), ...ids, surface }, steps);
    expect(recipeHandBack(report)).toBe(
      'The saved steps from there, to go on yourself with `steps`: [{"do":"click","target":"Sign in"},{"do":"click","target":"Help"}]',
    );
    expect(formatPlanReport(report).summary).toStartWith('Stopped at step 2 of 3 (click "Sign in")');
    // A target given by number is another element today: handed back without it, never as the old number.
    const numbered = await saved([
      { do: "click", target: "e5" },
      { do: "click", target: "Help" },
    ]);
    const gone = browser('- main\n  - link "Help" [ref=e5]');
    const back = recipeHandBack(await runPlan({ judge: refusing(), ...ids, surface: gone }, numbered));
    expect(back).toBe(
      'The saved steps from there, to go on yourself with `steps`: [{"do":"click"},{"do":"click","target":"Help"}]. A target that was a number then is left out: read the page and give its number now.',
    );
    // All went through: nothing to hand back.
    const all = await runPlan({ judge: refusing(), ...ids, surface: browser(LOGIN_LATER) }, steps);
    expect(recipeHandBack(all)).toBeNull();
  });
});
