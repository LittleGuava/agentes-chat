import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const routed = (by: NonNullable<AiStatus["routing"]>["by"], model: string | null = null): AiStatus => ({
  any: true,
  agents: [],
  routing: { by, mine: by === "plans" ? "plan" : by, model, noSmallModel: null },
  apiKey: true,
});

const open = async (patch: Partial<ReturnType<typeof seedState>>) => {
  const state = seedState(patch);
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return state;
};
const section = () => screen().getByRole("region", { name: "Quem escolhe os agentes" });
const picker = () => within(section()).getByRole("combobox", { name: "Modelo que decide" });
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const pick = async (search: string) => {
  await click(picker());
  const field = screen().getByRole("combobox", { name: "Buscar modelos" });
  await act(async () => fireEvent.change(field, { target: { value: search } }));
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await settle(4);
};
const saves = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "orgs.updateSettings").map((c) => c.args[1]);

describe("the model that picks who answers, in Configurações › IA e uso", () => {
  test("on Automático it names today's pick; another model of a key the workspace has is saved, and Automático again clears it", async () => {
    const state = await open({ aiStatus: routed("model", "claude-haiku-5-5") });
    expect(picker().textContent).toContain("Automático · Claude Haiku 5.5");

    await click(picker());
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    // The workspace has a Claude key and no OpenAI one: GPT-5 can't decide here.
    expect(options.some((o) => o.includes("Claude Sonnet 5.5"))).toBe(true);
    expect(options.some((o) => o.includes("GPT-5"))).toBe(false);
    await act(async () =>
      fireEvent.keyDown(screen().getByRole("combobox", { name: "Buscar modelos" }), { key: "Escape" }),
    );
    await settle(2);

    await pick("sonnet");
    expect(saves(state)).toEqual([{ routerModel: "claude-sonnet-5-5" }]);
    expect(state.routerModel).toBe("claude-sonnet-5-5");
    expect(picker().textContent).toContain("Claude Sonnet 5.5");
    expect(document.body.textContent).toContain("Modelo salvo.");

    await pick("automático");
    expect(saves(state).at(-1)).toEqual({ routerModel: null });
    expect(state.routerModel).toBeNull();
  });

  test("a model saved before shows even with its key gone, and the rules picking still offer it", async () => {
    await open({ aiStatus: routed("rules"), routerModel: "gpt-5" });
    expect(picker().textContent).toContain("GPT-5");
  });

  for (const by of ["jev", "off"] as const)
    test(`with ${by === "jev" ? "Jev picking" : "the router off"}, no model to choose`, async () => {
      await open({ aiStatus: routed(by) });
      expect(within(section()).queryByRole("combobox", { name: "Modelo que decide" })).toBeNull();
    });
});
