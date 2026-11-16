import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * A model for one conversation (ADR 0032, addendum 2026-11-15) from a channel's header and a thread's: "Modelos nesta
 * conversa" lists the agents there, each with its select, and a thread's default says what the channel chose.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};

const header = () => document.querySelector(".channel__header") as HTMLElement;

async function openModels() {
  await click(within(header()).getByRole("button", { name: "Modelos nesta conversa" }));
  return screen().getByRole("dialog", { name: "Modelos nesta conversa" });
}

async function choose(list: HTMLElement, agent: string, name: string) {
  const select = within(list).getByRole("combobox", { name: `Modelo de ${agent} nesta conversa` });
  select.focus();
  await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
  await settle(3);
  const row = screen()
    .getAllByRole("option")
    .find((o) => o.textContent === name);
  if (!row) throw new Error(`no row ${name}`);
  await click(row);
}

const sets = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setConversationModel");

test("a channel's header lists its agents; a model chosen for one is for the channel as a whole", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);

  const list = await openModels();
  expect(within(list).getByText("Ada")).toBeTruthy();
  expect(within(list).getByText("Atlas")).toBeTruthy();
  expect(within(list).getByRole("combobox", { name: "Modelo de Ada nesta conversa" }).textContent).toContain(
    "Padrão do agente",
  );

  await choose(list, "Ada", "Claude Opus 5.5");
  expect(sets(state).at(-1)?.args[1]).toBe(ADA_ID);
  expect(sets(state).at(-1)?.args[2]).toMatchObject({ channelId: ENG_ID, threadId: null, model: "claude-opus-5-5" });
  // Only Ada's: Atlas keeps its own.
  expect(sets(state).some((c) => c.args[1] === ATLAS_ID)).toBe(false);
  expect(within(list).getByRole("combobox", { name: "Modelo de Ada nesta conversa" }).textContent).toContain(
    "Claude Opus 5.5",
  );
  expect(within(list).getByRole("combobox", { name: "Modelo de Atlas nesta conversa" }).textContent).toContain(
    "Padrão do agente",
  );

  await choose(list, "Ada", "Padrão do agente");
  expect(sets(state).at(-1)?.args[2]).toMatchObject({ channelId: ENG_ID, model: null });
});

test("who may not change an agent's brain reads its model there, with no select", async () => {
  const state = seedState();
  state.conversationModelReadOnly = [ATLAS_ID];
  const api = createFakeApi(state);
  await api.agents.setConversationModel(ORG_ID, ATLAS_ID, {
    channelId: ENG_ID,
    threadId: null,
    model: "claude-haiku-5-5",
  });
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);

  const list = await openModels();
  expect(within(list).queryByRole("combobox", { name: "Modelo de Atlas nesta conversa" })).toBeNull();
  const atlas = within(list).getByText("Atlas").closest(".cm-pop__row") as HTMLElement;
  expect(atlas.textContent).toContain("Claude Haiku 5.5");
  expect(within(list).getByRole("combobox", { name: "Modelo de Ada nesta conversa" })).toBeTruthy();
});

test("in a thread, the default is the channel's choice, and a choice there is the thread's alone", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  await api.agents.setConversationModel(ORG_ID, ADA_ID, {
    channelId: ENG_ID,
    threadId: null,
    model: "claude-opus-5-5",
  });
  await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
  await settle(8);

  const list = await openModels();
  const ada = within(list).getByRole("combobox", { name: "Modelo de Ada nesta conversa" });
  expect(ada.textContent).toContain("Como no canal (Claude Opus 5.5)");
  expect(within(list).getByRole("combobox", { name: "Modelo de Atlas nesta conversa" }).textContent).toContain(
    "Padrão do agente",
  );

  await choose(list, "Ada", "Claude Haiku 5.5");
  expect(sets(state).at(-1)?.args[1]).toBe(ADA_ID);
  expect(sets(state).at(-1)?.args[2]).toMatchObject({ channelId: ENG_ID, threadId: "m-1", model: "claude-haiku-5-5" });
  expect(within(list).getByRole("combobox", { name: "Modelo de Ada nesta conversa" }).textContent).toContain(
    "Claude Haiku 5.5",
  );
});
