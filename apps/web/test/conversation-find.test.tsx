import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const said = (id: string, channelId: string, body: string, minutesAgo: number, threadId: string | null = null) => ({
  id,
  channelId,
  threadId,
  author: { type: "agent" as const, id: ADA_ID },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: at(minutesAgo),
});

const seeded = () => {
  const state = seedState();
  state.messages.push(
    said("z-old", ENG_ID, "a zebra antiga", 30),
    said("z-new", ENG_ID, "a zebra nova", 5),
    // A thread's reply isn't a row of the channel, another channel's message isn't this conversation's.
    said("z-reply", ENG_ID, "zebra na resposta", 4, "m-1"),
    said("z-general", GENERAL_ID, "uma zebra no general", 3),
  );
  return state;
};

/** The bar (a `<search>` landmark, which the test DOM gives no role). */
const bar = () => document.querySelector<HTMLElement>('search[aria-label="Buscar nesta conversa"]');
const field = () => within(bar() as HTMLElement).getByRole("searchbox", { name: "Buscar nesta conversa" });
const status = () => (bar()?.querySelector("output")?.textContent ?? "").trim();
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
const press = async (target: Element, init: KeyboardEventInit) => {
  let event: KeyboardEvent | undefined;
  await act(async () => {
    event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  await settle(2);
  return event as KeyboardEvent;
};
const typeIn = async (value: string) => {
  await act(async () => fireEvent.change(field(), { target: { value } }));
  // The search runs a beat after the last key.
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(6);
};

describe("find in the conversation (Ctrl/⌘F)", () => {
  test("opens a bar that searches this channel and goes to the newest message found, then steps up and wraps", async () => {
    const state = seeded();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    expect(bar()).toBeNull();

    const opened = await press(document.body, { key: "f", ctrlKey: true });
    expect(opened.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field());

    await typeIn("zebra");
    const asked = state.calls.filter((c) => c.method === "search.query").at(-1)?.args[1] as {
      q: string;
      filters?: unknown;
    };
    expect(asked.q).toBe("zebra");
    expect(asked.filters).toEqual({ in: [ENG_ID], sort: "newest" });
    // Only this channel's own rows: not the thread's reply, not #general's.
    expect(status()).toBe("1 de 2");
    expect(row("z-new").classList.contains("ac-msg--focus")).toBe(true);

    await press(field(), { key: "Enter" });
    expect(status()).toBe("2 de 2");
    expect(row("z-old").classList.contains("ac-msg--focus")).toBe(true);

    // Past the oldest it wraps to the newest; Shift+Enter goes back down.
    await press(field(), { key: "Enter" });
    expect(status()).toBe("1 de 2");
    await press(field(), { key: "Enter", shiftKey: true });
    expect(status()).toBe("2 de 2");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Resultado mais recente" })));
    await settle(2);
    expect(status()).toBe("1 de 2");
  });

  test("words with nothing here say so", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await press(document.body, { key: "f", metaKey: true });
    await typeIn("girafa");
    expect(status()).toBe("Nada encontrado");
    expect(screen().getByRole("button", { name: "Resultado mais antigo" }).hasAttribute("disabled")).toBe(true);
  });

  test("a thread's find holds its root and replies, not the channel around it", async () => {
    const state = seeded();
    state.messages.push(said("z-reply-old", ENG_ID, "outra zebra na resposta", 20, "m-1"));
    await renderApp(`/org/${ORG_ID}/threads/m-1`, { api: createFakeApi(state) });
    await settle(8);
    await press(document.body, { key: "f", ctrlKey: true });
    await typeIn("zebra");
    expect(status()).toBe("1 de 2");
    expect(row("z-reply").classList.contains("ac-msg--focus")).toBe(true);
    await press(field(), { key: "ArrowUp" });
    expect(status()).toBe("2 de 2");
    expect(row("z-reply-old").classList.contains("ac-msg--focus")).toBe(true);
  });

  test("from the sidebar the page's conversation takes it; Esc from its buttons closes it", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    const link = [...document.querySelectorAll<HTMLElement>("nav a[href]")].find(
      (a) => !a.closest(".shell__main--chat"),
    );
    // A link of the sidebar's, outside any conversation.
    expect(link).toBeTruthy();
    (link as HTMLElement).focus();
    const opened = await press(link as HTMLElement, { key: "f", ctrlKey: true });
    expect(opened.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field());
    await typeIn("zebra");
    const newer = screen().getByRole("button", { name: "Resultado mais recente" });
    await act(async () => fireEvent.click(newer));
    newer.focus();
    const esc = await press(newer, { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(bar()).toBeNull();
  });

  test("Ctrl/⌘F again from its field is the browser's own find; Esc closes it", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await press(document.body, { key: "f", ctrlKey: true });
    const again = await press(field(), { key: "f", ctrlKey: true });
    expect(again.defaultPrevented).toBe(false);
    await press(field(), { key: "Escape" });
    expect(bar()).toBeNull();
  });
});
