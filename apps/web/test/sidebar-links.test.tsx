import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type SidebarLink } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* A person's own links in the sidebar (ADR 0083, amendment of 2026-11-15): under the tools, opened in a new tab, added
   and removed in "Personalizar a barra lateral". */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const link = (id: string, title: string, url = `https://${id}.example.com/`): SidebarLink => ({ id, title, url });
const go = async (state: State) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = async (el: Element, value: string) => {
  await act(async () => fireEvent.change(el, { target: { value } }));
  await settle(1);
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
const sidebarLinks = () => [...nav().querySelectorAll<HTMLAnchorElement>(".sidebar__links > a")];
const openSetup = async () => {
  await click(within(nav()).getByRole("button", { name: "Mais" }));
  await click(
    within(screen().getByRole("dialog", { name: "Mais" })).getByRole("button", {
      name: "Personalizar a barra lateral",
    }),
  );
  return screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
};
const added = (state: State) => state.calls.filter((c) => c.method === "orgs.addSidebarLink").map((c) => c.args[1]);

test("my links show under the tools and open in a new tab, never in the app", async () => {
  await go(seedState({ sidebarLinks: [link("crm", "CRM"), link("status", "Status")] }));
  const rows = sidebarLinks();
  expect(rows.map((a) => a.querySelector(".sidebar__item-label")?.textContent)).toEqual(["CRM", "Status"]);
  const [crm] = rows;
  expect(crm?.getAttribute("href")).toBe("https://crm.example.com/");
  expect(crm?.getAttribute("target")).toBe("_blank");
  expect(crm?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(crm?.closest(".sidebar__tools")).toBeTruthy();
  // Screen readers hear where it opens; the tools' own list doesn't count it as a tool.
  expect(crm?.textContent).toContain("abre numa nova aba");
  expect([...nav().querySelectorAll(".sidebar__tools > a.sidebar__item .sidebar__item-label")]).not.toContain(
    crm?.querySelector(".sidebar__item-label"),
  );
});

test("no links: nothing extra in the sidebar", async () => {
  await go(seedState());
  expect(nav().querySelector(".sidebar__links")).toBeNull();
});

test("a personal workspace with nothing waiting still shows my links on top", async () => {
  const state = seedState({ sidebarLinks: [link("crm", "CRM")] });
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  await go(state);
  expect(sidebarLinks().map((a) => a.querySelector(".sidebar__item-label")?.textContent)).toEqual(["CRM"]);
});

test("adding one in the setup: an address typed without https gets it, and the link shows in the sidebar", async () => {
  const state = await go(seedState());
  const dialog = await openSetup();
  const add = within(dialog).getByRole("button", { name: "Adicionar link" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  await type(within(dialog).getByRole("textbox", { name: "Nome" }), "  CRM ");
  await type(within(dialog).getByRole("textbox", { name: "Endereço" }), "crm.example.com/board");
  await click(add);
  expect(added(state)).toEqual([{ title: "CRM", url: "https://crm.example.com/board" }]);
  expect((within(dialog).getByRole("textbox", { name: "Endereço" }) as HTMLInputElement).value).toBe("");
  expect(within(dialog).getByText("crm.example.com/board")).toBeTruthy();
  expect(sidebarLinks().map((a) => a.getAttribute("href"))).toEqual(["https://crm.example.com/board"]);

  // A host with its port reads as a host, not as a scheme.
  await type(within(dialog).getByRole("textbox", { name: "Nome" }), "Grafana");
  await type(within(dialog).getByRole("textbox", { name: "Endereço" }), "grafana.example.com:8443/d/1");
  await click(add);
  expect(added(state).at(-1)).toEqual({ title: "Grafana", url: "https://grafana.example.com:8443/d/1" });
});

test("an address that isn't https is refused before it is sent, with what to use instead", async () => {
  const state = await go(seedState());
  const dialog = await openSetup();
  await type(within(dialog).getByRole("textbox", { name: "Nome" }), "Old");
  const address = within(dialog).getByRole("textbox", { name: "Endereço" });
  for (const bad of ["http://old.example.com", "javascript:alert(1)"]) {
    await type(address, bad);
    await click(within(dialog).getByRole("button", { name: "Adicionar link" }));
    expect(address.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText("Use um endereço https, como https://crm.exemplo.com.")).toBeTruthy();
  }
  expect(added(state)).toEqual([]);
});

test("the server's refusal is said in words under the address", async () => {
  await go(
    seedState({
      sidebarLinkError: new ApiError(409, "sidebar_link.full", "At most 10 links", { max: 10 }),
    }),
  );
  const dialog = await openSetup();
  await type(within(dialog).getByRole("textbox", { name: "Nome" }), "CRM");
  await type(within(dialog).getByRole("textbox", { name: "Endereço" }), "https://crm.example.com");
  await click(within(dialog).getByRole("button", { name: "Adicionar link" }));
  expect(within(dialog).getByText("Você já tem 10 links. Remova um para adicionar outro.")).toBeTruthy();
});

test("removing one takes it out of the sidebar; at the limit the form gives way to a line", async () => {
  const ten = Array.from({ length: 10 }, (_, i) => link(`l${i}`, `Link ${i}`));
  const state = await go(seedState({ sidebarLinks: ten }));
  const dialog = await openSetup();
  expect(within(dialog).queryByRole("textbox", { name: "Endereço" })).toBeNull();
  expect(within(dialog).getByText("Você já tem 10 links. Remova um para adicionar outro.")).toBeTruthy();
  await click(within(dialog).getByRole("button", { name: "Remover Link 0" }));
  expect(state.calls.some((c) => c.method === "orgs.removeSidebarLink" && c.args[1] === "l0")).toBe(true);
  expect(sidebarLinks()).toHaveLength(9);
  expect(within(dialog).getByRole("textbox", { name: "Endereço" })).toBeTruthy();
});
