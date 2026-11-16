import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(cleanup);

/** Announcements (ADR 0056, addendum on announcements): the operator's cards on top of the work area. */

test("each announcement shows its words as written and its link outside the app, and its × closes it for good", async () => {
  const s = seedState();
  s.announcements = [
    {
      id: "a-1",
      title: "Manutenção hoje às 22h",
      body: "O app pausa por dez minutos.\n<b>Nada</b> se perde.",
      link: { url: "https://example.com/status", label: null },
      startsAt: new Date().toISOString(),
      endsAt: null,
    },
    {
      id: "a-2",
      title: "Busca nova",
      body: "",
      link: { url: "https://example.com/busca", label: "Ver novidades" },
      startsAt: new Date().toISOString(),
      endsAt: null,
    },
  ];
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const region = screen.getByRole("region", { name: "Avisos" });
  const cards = within(region).getAllByRole("status");
  expect(cards).toHaveLength(2);
  const [first, second] = cards as [HTMLElement, HTMLElement];
  // Plain text: a tag in it is shown as typed, never drawn, and its line break is kept.
  expect(first.textContent).toContain("Manutenção hoje às 22h");
  expect(first.querySelector(".announcement__body")?.textContent).toBe(
    "O app pausa por dez minutos.\n<b>Nada</b> se perde.",
  );
  expect(first.querySelector("b b")).toBeNull();
  const more = within(first).getByRole("link", { name: "Saiba mais" });
  expect([more.getAttribute("href"), more.getAttribute("target"), more.getAttribute("rel")]).toEqual([
    "https://example.com/status",
    "_blank",
    "noopener noreferrer",
  ]);
  expect(within(second).getByRole("link", { name: "Ver novidades" }).getAttribute("href")).toBe(
    "https://example.com/busca",
  );

  await act(async () => {
    fireEvent.click(within(first).getByRole("button", { name: "Fechar aviso" }));
  });
  await settle(4);
  expect(s.calls.find((c) => c.method === "orgs.dismissAnnouncement")?.args).toEqual([ORG_ID, "a-1"]);
  expect(screen.queryByText("Manutenção hoje às 22h")).toBeNull();
  expect(screen.getByText("Busca nova")).toBeTruthy();
});

test("nothing to say: no region at all", async () => {
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(seedState()) });
  await settle(8);
  expect(screen.queryByRole("region", { name: "Avisos" })).toBeNull();
});
