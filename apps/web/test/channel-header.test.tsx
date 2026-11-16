import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async () => {
  const api = createFakeApi(seedState());
  api.pins = { list: async () => [], pin: async () => ({}) as never, unpin: async () => {} };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  return document.querySelector(".channel__header") as HTMLElement;
};

describe("the channel header, as Discord's", () => {
  test("the name and topic, then threads, pins, models, settings, members and the search, with no faces", async () => {
    const header = await open();
    expect(within(header).getByRole("heading", { level: 1, name: "eng" })).toBeTruthy();
    expect(within(header).getByText("Código, erros e deploys")).toBeTruthy();
    // The name and the glyphs are an action line: the glyphs go under a name that can't keep its row beside them.
    const line = header.querySelector(":scope > .ac-actline.channel__line") as HTMLElement;
    expect(line.firstElementChild?.matches(".channel__head-text")).toBe(true);
    expect(line.lastElementChild?.matches(".channel__acts")).toBe(true);
    const icons = [...header.querySelectorAll<HTMLElement>(".channel__acts > .channel__icon")]
      .filter((b) => !b.classList.contains("channel__search-icon"))
      .map((b) => b.getAttribute("aria-label"));
    expect(icons).toEqual([
      expect.stringMatching(/^Threads: \d+ neste canal$/),
      "Mensagens fixadas",
      // Its agents' models here (ADR 0032, addendum 2026-11-15).
      "Modelos nesta conversa",
      "Configurações do canal",
      "Membros do canal (4)",
    ] as never);
    expect(within(header).getByRole("button", { name: "Buscar" })).toBeTruthy();
    expect(header.querySelectorAll(".ac-avatar")).toHaveLength(0);
    expect(within(header).queryByRole("button", { name: "Detalhes do canal" })).toBeNull();
    expect(within(header).queryByRole("link", { name: "Buscar nesta conversa" })).toBeNull();
  });

  test("the cog opens the channel's details; the pin lists the pins, or says there are none", async () => {
    const header = await open();
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Configurações do canal" })));
    await settle(3);
    expect(screen().getByRole("dialog", { name: /eng/ })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    await settle(2);
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Mensagens fixadas" })));
    await settle(2);
    const pins = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    expect(pins.textContent).toContain("Nada fixado aqui ainda");
  });
});

describe("who else has the conversation open (ADR 0084 addendum 2026-11-15)", () => {
  const withViewers = async (ids: string[]) => {
    const state = seedState();
    // Five more people, so the header has more than its three faces to show.
    const base = state.members.find((m) => m.userId === "u-joao");
    if (!base) throw new Error("the seed has João");
    for (const [i, name] of ["Bia", "Caio", "Duda", "Eva", "Fábio"].entries()) {
      state.members.push({ ...base, userId: `u-${i}`, name, handle: name.toLowerCase() });
    }
    const api = createFakeApi(state);
    api.pins = { list: async () => [], pin: async () => ({}) as never, unpin: async () => {} };
    api.viewers = { list: async () => ids };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    return document.querySelector(".channel__header") as HTMLElement;
  };

  test("nobody else there: no faces", async () => {
    const header = await withViewers([]);
    expect(header.querySelector(".channel__viewers")).toBeNull();
  });

  test("one person: their face before the glyphs, their name in the tip", async () => {
    const header = await withViewers(["u-joao"]);
    const viewers = header.querySelector(".channel__viewers") as HTMLElement;
    expect(viewers.parentElement?.firstElementChild).toBe(viewers);
    expect(viewers.getAttribute("aria-label")).toBe("Aqui agora: João");
    expect(viewers.getAttribute("title")).toBe("Aqui agora: João");
    expect(viewers.querySelectorAll(".ac-avatar")).toHaveLength(1);
    expect(viewers.querySelector(".channel__viewers-more")).toBeNull();
  });

  test("past three: three faces, +N, every name in the tip; someone not in the people yet waits", async () => {
    const header = await withViewers(["u-joao", "u-0", "u-1", "u-2", "u-3", "u-stranger"]);
    const viewers = header.querySelector(".channel__viewers") as HTMLElement;
    expect(viewers.querySelectorAll(".ac-avatar")).toHaveLength(3);
    expect(viewers.querySelector(".channel__viewers-more")?.textContent).toBe("+2");
    expect(viewers.getAttribute("aria-label")).toBe("Aqui agora: João, Bia, Caio, Duda e Eva");
  });
});
