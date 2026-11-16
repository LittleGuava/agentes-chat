import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * "Usar a minha ordem" (ADR 0080, addendum of 2026-11-16): off by default, the sidebar is everyone's; on, each section's
 * rows show in my order, and dragging or Mover para cima / para baixo changes it for me alone, never the workspace's.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const SALA_ID = "00000000-0000-4000-8000-0000000000d9";
/** Three channels with no category, in the workspace's order (by name, nobody arranged them): eng, general, sala. */
const seeded = (own?: State["ownOrder"]) => {
  const state = seedState();
  state.channels.push({
    id: SALA_ID,
    name: "sala",
    topic: "",
    visibility: "public",
    isMember: true,
    createdAt: state.channels[0]?.createdAt ?? "",
  });
  state.sidebarView = { agentSort: "workspace", showAllAgents: false, pins: { agents: [], channels: [], people: [] } };
  if (own) state.ownOrder = own;
  return state;
};
const go = async (state: State) => {
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const scroll = () => nav().querySelector(".sidebar__scroll") as HTMLElement;
const channels = () =>
  [...nav().querySelectorAll("a.sidebar__item[data-kind='channel']")].map((a) => a.getAttribute("title"));
const agents = () => [...nav().querySelectorAll("[data-agent-row] .sidebar__item-label")].map((l) => l.textContent);
const row = (name: string) => nav().querySelector(`a.sidebar__item[title="#${name}"]`) as HTMLElement;
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const rightClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle(2);
};
const items = () =>
  within(screen().getByRole("menu", { name: "Ações" }))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const pick = (name: string) =>
  click(within(screen().getByRole("menu", { name: "Ações" })).getByRole("menuitem", { name }));
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args[1]);
const workspaceMoves = (state: State) =>
  state.calls.filter((c) => c.method === "chat.place" || c.method === "chat.placeCategory");
const MINE = { on: true, channels: [SALA_ID, GENERAL_ID, ENG_ID], people: [], agents: [] };
const allChannels = ["#eng", "#general", "#sala"];

describe("Usar a minha ordem", () => {
  test("off by default: everyone's order, no move of my own; Personalizar turns it on", async () => {
    const state = await go(seeded());
    expect(channels()).toEqual(allChannels);
    await rightClick(row("eng"));
    expect(items()).not.toContain("Mover para cima");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    await rightClick(scroll());
    await pick("Personalizar a barra lateral");
    const dialog = screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
    const toggle = within(dialog).getByRole("switch", { name: "Usar a minha ordem" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(calls(state, "orgs.setOwnOrder").at(-1)).toMatchObject({ on: true });
  });

  test("off with an order saved: the sidebar is everyone's, and the order waits for the next time", async () => {
    const state = await go(seeded({ ...MINE, on: false }));
    expect(channels()).toEqual(allChannels);
    expect(state.ownOrder).toMatchObject({ channels: MINE.channels });
  });

  test("on: my order; a channel nobody ordered for me keeps its place in everyone's order", async () => {
    await go(seeded(MINE));
    expect(channels()).toEqual(["#sala", "#general", "#eng"]);
    // eng is new to my order: everyone's order puts it first, so it holds that place.
    const state = seeded({ ...MINE, channels: [SALA_ID, GENERAL_ID] });
    cleanup();
    await go(state);
    expect(channels()).toEqual(["#eng", "#sala", "#general"]);
  });

  test("on: Mover para cima moves a channel for me alone, never in the workspace", async () => {
    const state = await go(seeded(MINE));
    await rightClick(row("eng"));
    expect(items()).toContain("Mover para cima");
    expect(items()).not.toContain("Mover para baixo");
    await pick("Mover para cima");
    expect(channels()).toEqual(["#sala", "#eng", "#general"]);
    expect(calls(state, "orgs.setOwnOrder").at(-1)).toMatchObject({
      on: true,
      channels: [SALA_ID, ENG_ID, GENERAL_ID],
    });
    expect(workspaceMoves(state)).toEqual([]);
  });

  test("on: dragging a channel, by an owner who may arrange the workspace, reorders it for me alone", async () => {
    const state = await go(seeded(MINE));
    const dt = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };
    await act(async () => fireEvent.dragStart(row("eng"), { dataTransfer: dt }));
    await act(async () => fireEvent.dragOver(row("sala"), { dataTransfer: dt, clientY: 0 }));
    expect(row("sala").dataset.drop).toBe("before");
    await act(async () => fireEvent.drop(row("sala"), { dataTransfer: dt, clientY: 0 }));
    await settle(6);
    expect(channels()).toEqual(["#eng", "#sala", "#general"]);
    expect(calls(state, "orgs.setOwnOrder").at(-1)).toMatchObject({ channels: [ENG_ID, SALA_ID, GENERAL_ID] });
    expect(workspaceMoves(state)).toEqual([]);
  });

  test("on: Agentes in my order too, moved from an agent's menu", async () => {
    const state = await go(seeded({ ...MINE, agents: [ATLAS_ID, ADA_ID] }));
    expect(agents()).toEqual(["Atlas", "Ada"]);
    await rightClick(nav().querySelector(`[data-agent-row="${ADA_ID}"] a`) as HTMLElement);
    await pick("Mover para cima");
    expect(agents()).toEqual(["Ada", "Atlas"]);
    expect(calls(state, "orgs.setOwnOrder").at(-1)).toMatchObject({ agents: [ADA_ID, ATLAS_ID] });
  });

  test("turning it off from Personalizar brings everyone's order back and keeps mine saved", async () => {
    const state = await go(seeded(MINE));
    await rightClick(scroll());
    await pick("Personalizar a barra lateral");
    const dialog = screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
    await click(within(dialog).getByRole("switch", { name: "Usar a minha ordem" }));
    expect(calls(state, "orgs.setOwnOrder").at(-1)).toEqual({ ...MINE, on: false });
    await act(async () => fireEvent.keyDown(dialog, { key: "Escape" }));
    await settle(4);
    expect(channels()).toEqual(allChannels);
  });
});
