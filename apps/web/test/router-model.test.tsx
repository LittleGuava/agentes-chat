import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AiStatus, ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const routed = (by: NonNullable<AiStatus["routing"]>["by"], model: string | null = null): AiStatus => ({
  any: true,
  agents: [],
  routing: { by, mine: by === "plans" ? "plan" : by, model, noSmallModel: null },
  apiKey: true,
});

const open = async (patch: Partial<ReturnType<typeof seedState>>, as?: (s: ReturnType<typeof seedState>) => void) => {
  const state = seedState(patch);
  as?.(state);
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return state;
};
const section = () => screen().getByRole("region", { name: "Quem escolhe os agentes" });
const picker = () => within(section()).getByRole("combobox", { name: "Modelo que decide" });
const field = () => screen().getByRole("combobox", { name: "Buscar modelos" });
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const pick = async (search: string) => {
  await click(picker());
  await act(async () => fireEvent.change(field(), { target: { value: search } }));
  await act(async () => fireEvent.keyDown(field(), { key: "Enter" }));
  await settle(6);
};
const saves = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "orgs.updateSettings").map((c) => c.args[1]);
const NO_SCHEMA = {
  id: "claude-no-schema",
  label: "Claude No Schema",
  provider: "anthropic",
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 1,
  structuredOutput: false as const,
};

describe("the model that picks who answers, in Configurações › IA e uso", () => {
  test("lists the routing picks first and only models of the workspace's keys that can answer through a schema", async () => {
    await open({ aiStatus: routed("model", "claude-haiku-5-5"), extraModels: [NO_SCHEMA] });
    expect(picker().textContent).toBe("Automático · Claude Haiku 5.5");
    await click(picker());
    const labels = screen()
      .getAllByRole("option")
      .map((o) => within(o).queryByText(/^(Automático|Claude|GPT)/)?.textContent);
    // The workspace has a Claude key and no OpenAI one: GPT-5 can't decide here, nor a model the server would refuse.
    expect(labels).toEqual([
      "Automático · Claude Haiku 5.5",
      "Claude Haiku 5.5",
      "Claude Sonnet 5.5",
      "Claude Opus 5.5",
    ]);
    expect(screen().getByText("Feitos para decidir")).toBeTruthy();
  });

  test("a model picked is saved and decides; Automático again clears it", async () => {
    const state = await open({ aiStatus: routed("model", "claude-haiku-5-5") });
    await pick("sonnet");
    expect(saves(state)).toEqual([{ routerModel: "claude-sonnet-5-5" }]);
    expect(picker().textContent).toBe("Claude Sonnet 5.5");
    // Who picks, read again from the server: the line above names the new model.
    expect(section().textContent).toContain("O Claude Sonnet 5.5 escolhe quem responde cada mensagem sem menção.");
    expect(document.body.textContent).toContain("Modelo salvo.");

    await pick("automático");
    expect(saves(state).at(-1)).toEqual({ routerModel: null });
    expect(picker().textContent).toBe("Automático · Claude Haiku 5.5");
  });

  test("a save the server refuses keeps the model and says why", async () => {
    const state = await open({
      aiStatus: routed("model", "claude-haiku-5-5"),
      settingsError: new ApiError(400, "validation", "claude-sonnet-5-5 can't follow a JSON schema"),
    });
    await pick("sonnet");
    expect(state.routerModel).toBeUndefined();
    expect(picker().textContent).toBe("Automático · Claude Haiku 5.5");
    expect(screen().getByRole("alert").textContent).toBeTruthy();
  });

  test("a model saved that can't be reached says who decides instead", async () => {
    await open({ aiStatus: routed("model", "claude-haiku-5-5"), routerModel: "gpt-5" });
    expect(picker().textContent).toBe("GPT-5");
    expect(section().textContent).toContain("Este modelo não está disponível agora: quem decide é o Claude Haiku 5.5.");
    cleanup();
    await open({ aiStatus: routed("rules"), routerModel: "gpt-5" });
    expect(section().textContent).toContain("Este modelo não está disponível agora, e nenhum modelo está decidindo.");
  });

  test("under Jev or with the router off, only a model saved before shows, to undo it", async () => {
    for (const by of ["jev", "off"] as const) {
      await open({ aiStatus: routed(by) });
      expect(within(section()).queryByRole("combobox", { name: "Modelo que decide" })).toBeNull();
      cleanup();
    }
    await open({ aiStatus: routed("jev"), routerModel: "claude-haiku-5-5" });
    expect(section().textContent).toContain("O Jev decide primeiro. Este modelo só entra quando o Jev falha.");
    cleanup();
    await open({ aiStatus: routed("off"), routerModel: "claude-haiku-5-5" });
    expect(picker().textContent).toBe("Claude Haiku 5.5");
    expect(section().textContent).toContain(
      "Os agentes só respondem quando mencionados. Este modelo ainda julga os pedidos deles.",
    );
  });

  test("whoever manages keys but can't change settings reads who picks, with no model to choose", async () => {
    await open({ aiStatus: routed("model", "claude-haiku-5-5") }, (s) => meWithRole(s, ["manage_credentials"]));
    expect(section().textContent).toContain("O Claude Haiku 5.5 escolhe quem responde cada mensagem sem menção.");
    expect(within(section()).queryByRole("combobox", { name: "Modelo que decide" })).toBeNull();
  });
});
