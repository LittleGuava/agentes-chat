import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, within } from "@testing-library/react";
import { brainDialog, brainRows, brainScreen, confirmScreen, mainButton, pickRow, toScreen } from "./ai-picker";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" with the ACP agents the agent's computer declares (ADR 0216): each is a way to think on the switch
 * screen, by the name its computer's owner gave it; one in use shows by that name, never as Claude, and its model
 * screen lists the models that agent offered after its own default.
 */

afterEach(cleanup);

const VIBE = {
  id: "vibe",
  name: "Mistral Vibe",
  models: [
    { value: "vibe/devstral-3", label: "Devstral 3" },
    { value: "vibe/mistral-large-4", label: "Mistral Large 4" },
  ],
};
const ACP: NonNullable<AgentBrain["acp"]> = {
  kind: "acp",
  available: true,
  models: [],
  defaultModel: null,
  engines: [VIBE, { id: "zed", name: "Zed agent", models: [] }],
};

const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

/** Ada on the MacBook, whose runner declares two ACP agents; her brain as given. */
async function open(patch: Partial<AgentBrain> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "linux",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: false } },
    browser: { available: false, version: null, chrome: null, reason: null },
  });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  const base = fakeAgentBrain(ADA_ID, { acp: ACP, ...patch });
  let current = base;
  api.agents.brain = async () => structuredClone(current);
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input) => {
    const saved = await setBrain(orgId, agentId, input);
    current = { ...saved, acp: ACP };
    return structuredClone(current);
  };
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state };
}

describe("Quem pensa with ACP agents (ADR 0216)", () => {
  test("each agent the computer declares is a way to think; switching saves it by its id, on its own default model", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    const rows = brainRows(d).filter((r) => r.group !== "Em uso");
    expect(rows.filter((r) => r.title === "Mistral Vibe" || r.title === "Zed agent").map((r) => r.title)).toEqual([
      "Mistral Vibe",
      "Zed agent",
    ]);
    expect(rows.find((r) => r.title === "Mistral Vibe")).toMatchObject({ off: false, group: "Agentes ACP" });
    await pickRow(d, "Mistral Vibe");
    expect(mainButton(d)?.textContent).toBe("Trocar para Mistral Vibe");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "acp", engine: "vibe", model: null }]);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("pensa com Mistral Vibe");
  });

  test("one in use shows by its name, never as Claude; its model is one of those it offered, after its default", async () => {
    const { state } = await open({ brain: "acp", engine: "vibe", model: null, effectiveModel: null });
    const cell = within(screen().getByRole("region", { name: "Como trabalha" })).getByRole("button", {
      name: "Mudar quem pensa",
    });
    expect(cell.textContent).toContain("Mistral Vibe");
    expect(cell.textContent).not.toContain("Claude");
    const d = await brainDialog();
    expect(brainRows(d).find((r) => r.still)).toMatchObject({ title: "Mistral Vibe" });
    expect(shownText(d)).not.toContain("Claude");
    await toScreen(d, "Modelo");
    expect(brainRows(d).map((r) => [r.title, r.checked])).toEqual([
      ["Padrão do Mistral Vibe", true],
      ["Devstral 3", false],
      ["Mistral Large 4", false],
    ]);
    await pickRow(d, "Devstral 3");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "acp", model: "vibe/devstral-3" }]);
  });

  test("another ACP agent of the computer: the agent moves to it on that agent's own default", async () => {
    const { state } = await open({
      brain: "acp",
      engine: "vibe",
      model: "vibe/devstral-3",
      effectiveModel: "vibe/devstral-3",
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Zed agent");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "acp", engine: "zed", model: null }]);
  });
});
