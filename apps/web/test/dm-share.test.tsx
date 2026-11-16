import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Sharing a DM with an agent as a read-only copy (ADR 0151, addendum 2026-11-15). */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const go = async (state: FakeState, path: string) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return document.querySelector(".channel__header") as HTMLElement;
};
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("Compartilhar conversa, in a DM with an agent", () => {
  test("says who reads it and that it can't be undone, and sends the copy where it was asked", async () => {
    const state = seedState();
    const header = await go(state, `dm/agent/${ADA_ID}`);
    await click(within(header).getByRole("button", { name: "Compartilhar conversa" }));
    const dialog = screen().getByRole("dialog", { name: "Compartilhar sua conversa com Ada" });
    expect(dialog.textContent).toContain("Não dá para desfazer.");
    const send = within(dialog).getByRole("button", { name: "Compartilhar" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect((within(dialog).getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement).value).toBe(
      "Minha conversa com Ada",
    );

    await act(async () =>
      fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Onde" }), { key: "ArrowDown" }),
    );
    await settle(2);
    const list = screen().getByRole("listbox", { name: "Onde" });
    expect(
      within(list)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Canais", "Pessoas"]);
    await click(within(list).getByRole("option", { name: "#general" }));
    expect(dialog.textContent).toContain("Todos em #general podem ler.");

    await click(within(dialog).getByRole("button", { name: "Compartilhar" }));
    const sent = state.calls.find((c) => c.method === "dms.share");
    expect(sent?.args[2]).toEqual({ to: { channelId: GENERAL_ID }, note: "Minha conversa com Ada" });
    expect(screen().queryByRole("dialog", { name: "Compartilhar sua conversa com Ada" })).toBeNull();
  });

  test("a DM with a person has no such button", async () => {
    const header = await go(seedState(), "dm/person/u-joao");
    expect(within(header).queryByRole("button", { name: "Compartilhar conversa" })).toBeNull();
  });
});

describe("the copy on its message", () => {
  test("names the talk and its length, and Ler opens it read only", async () => {
    const state = seedState();
    const at = new Date(Date.now() - 60_000).toISOString();
    state.messages.push({
      id: "msg-shared",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "O plano de sexta",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        sharedDm: {
          agent: { id: ADA_ID, name: "Ada", handle: "ada" },
          count: 2,
          omitted: 0,
          lines: [
            { author: { type: "person", id: "u-joao", name: "João" }, at, body: "Dá para lançar na sexta?" },
            { author: { type: "agent", id: ADA_ID, name: "Ada" }, at, body: "Dá: a revisão passa na quinta." },
          ],
        },
      },
      createdAt: at,
    });
    await go(state, `c/${ENG_ID}`);
    const card = screen().getByRole("region", { name: "Conversa com Ada" });
    expect(card.textContent).toContain("2 mensagens");
    await click(within(card).getByRole("button", { name: "Ler" }));
    const dialog = screen().getByRole("dialog", { name: "Conversa com Ada" });
    expect(dialog.textContent).toContain("Dá para lançar na sexta?");
    expect(dialog.textContent).toContain("Dá: a revisão passa na quinta.");
    expect(dialog.textContent).toContain("Uma cópia, como estava quando foi compartilhada.");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });
});
