import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getByRole("menu");
};
/** One of my messages in #eng, sent a minute ago (the edit is for a day). */
const mine = (id: string, body: string, receipts?: Message["receipts"]) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    receipts,
  }) as Message;
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
const editFrom = async (id: string) => {
  const bar = within(row(id)).getByRole("toolbar");
  const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
  await click(within(menu).getByRole("menuitem", { name: "Editar mensagem" }));
  await settle(2);
  return screen().getByRole("dialog", { name: "Editar mensagem" });
};

describe("editing my message (ADR 0207)", () => {
  test("Editar mensagem saves the new text in place, marked editada", async () => {
    const state = seedState();
    state.messages = [mine("w1", "reunião às 10h")];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const dialog = await editFrom("w1");
    const box = within(dialog).getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
    expect(box.value).toBe("reunião às 10h");
    await act(async () => fireEvent.change(box, { target: { value: "reunião às 11h" } }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.editMessage")?.args).toEqual([
      ORG_ID,
      "w1",
      { body: "reunião às 11h" },
    ]);
    expect(screen().queryByRole("dialog", { name: "Editar mensagem" })).toBeNull();
    expect(row("w1").textContent).toContain("reunião às 11h");
    expect(row("w1").textContent).toContain("editada");
  });

  test("once an agent answered it, saving is Editar e refazer a resposta", async () => {
    const state = seedState();
    state.messages = [
      mine("w1", "@ada resume março", {
        seenBy: [ADA_ID],
        pickedBy: [ADA_ID],
        handled: [{ agentId: ADA_ID, runId: "r1", status: "done" }],
        blocked: [],
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const dialog = await editFrom("w1");
    const box = within(dialog).getByRole("textbox", { name: "Mensagem" });
    await act(async () => fireEvent.change(box, { target: { value: "@ada resume abril" } }));
    expect(within(dialog).queryByRole("button", { name: "Salvar" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Editar e refazer a resposta" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.editMessage")?.args[2]).toEqual({
      body: "@ada resume abril",
      redo: true,
    });
  });

  test("not offered on someone else's message", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    expect(within(menu).queryByRole("menuitem", { name: "Editar mensagem" })).toBeNull();
  });
});
