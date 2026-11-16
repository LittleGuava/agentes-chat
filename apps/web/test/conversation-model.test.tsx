import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * A model for one conversation (ADR 0032, addendum 2026-11-15): the DM header's picker has "Só nesta conversa", a
 * choice there shows on the header's button, and "Padrão do agente" goes back to the agent's own.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};

const header = () => document.querySelector(".channel__header") as HTMLElement;

async function chooseHere(name: string) {
  await click(within(header()).getByRole("button", { name: "Mudar o modelo de Ada" }));
  const panel = document.querySelector(".mp") as HTMLElement;
  const select = within(panel).getByRole("combobox", { name: "Só nesta conversa" });
  select.focus();
  await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
  await settle(3);
  // The select's rows, not the picker's own list of models.
  const row = screen()
    .getAllByRole("option")
    .find((o) => !o.closest(".mp__models") && o.textContent === name);
  if (!row) throw new Error(`no row ${name}`);
  await click(row);
}

test("a model chosen only in this DM shows on the header, and the agent's default comes back", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
  await settle(8);

  await chooseHere("Claude Opus 5.5");
  const set = state.calls.filter((c) => c.method === "agents.setConversationModel");
  expect(set.at(-1)?.args[2]).toMatchObject({ model: "claude-opus-5-5" });
  expect(header().querySelector(".mp-label__text")?.textContent).toBe("Claude Opus 5.5 nesta conversa");

  await chooseHere("Padrão do agente");
  expect(state.calls.filter((c) => c.method === "agents.setConversationModel").at(-1)?.args[2]).toMatchObject({
    model: null,
  });
  expect(header().querySelector(".mp-label__text")?.textContent).not.toContain("nesta conversa");
});

test("a change of brain in the list above passes the conversation's model over, and the header says so at once", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await chooseHere("Claude Opus 5.5");
  expect(header().querySelector(".mp-label__text")?.textContent).toContain("nesta conversa");

  await click(within(header()).getByRole("button", { name: "Mudar o modelo de Ada" }));
  const panel = document.querySelector(".mp") as HTMLElement;
  await click(within(panel).getByRole("button", { name: "Claude" }));
  await click(within(panel).getByRole("option", { name: /Sonnet/ }));
  expect(state.calls.some((c) => c.method === "agents.setBrain")).toBe(true);
  expect(header().querySelector(".mp-label__text")?.textContent).not.toContain("nesta conversa");
});
