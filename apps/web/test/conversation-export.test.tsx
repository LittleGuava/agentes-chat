import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * "Exportar conversa" (ADR 0055 addendum 2026-11-15): a channel's menu and a DM's agent open one dialog; Baixar saves
 * the server's address for the format and files chosen.
 */

const saved: string[] = [];
const realSave = fileSaver.save;
beforeAll(() => {
  fileSaver.save = (url) => void saved.push(url);
});
afterAll(() => {
  fileSaver.save = realSave;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  saved.length = 0;
});

/** The app on `path`, with a client that names the export's address as the real one does. */
async function open(path: string, state = seedState(), offered = true) {
  const api = createFakeApi(state);
  if (offered)
    api.transcripts = {
      url: (orgId, channelId, o) =>
        `/api/app/organizations/${orgId}/channels/${channelId}/export?format=${o.format}${o.threadId ? `&threadId=${o.threadId}` : ""}${o.files ? "&files=true" : ""}`,
    };
  await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
}

const menu = () => screen().getByRole("menu", { name: "Ações" });
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  await act(
    async () =>
      void el.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
      ),
  );
  await settle(2);
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("Exportar conversa", () => {
  test("a channel's header: JSON with its files saves the zip's address, and the dialog closes", async () => {
    await open(`c/${ENG_ID}`);
    await rightClick(screen().getByRole("heading", { level: 1, name: "eng" }));
    expect(items()).toContain("Exportar conversa");
    await click(within(menu()).getByRole("menuitem", { name: "Exportar conversa" }));

    const dialog = screen().getByRole("dialog", { name: "Exportar conversa" });
    expect(within(dialog).getByRole("radio", { name: "Markdown" }).getAttribute("aria-checked")).toBe("true");
    await click(within(dialog).getByRole("radio", { name: "JSON" }));
    await click(within(dialog).getByRole("switch", { name: "Incluir anexos" }));
    await click(within(dialog).getByRole("button", { name: "Baixar" }));

    expect(saved).toEqual([`/api/app/organizations/${ORG_ID}/channels/${ENG_ID}/export?format=json&files=true`]);
    expect(screen().queryByRole("dialog", { name: "Exportar conversa" })).toBeNull();
  });

  test("a DM, from its agent's menu: Markdown by default, without files", async () => {
    const state = seedState();
    const dm = seedDm(state, { type: "agent", id: ADA_ID });
    await open(`c/${ENG_ID}`, state);
    const nav = document.getElementById("app-nav") as HTMLElement;
    await rightClick(within(nav).getByRole("link", { name: /^Ada/ }));
    await click(within(menu()).getByRole("menuitem", { name: "Exportar conversa" }));
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Baixar" }));
    expect(saved).toEqual([`/api/app/organizations/${ORG_ID}/channels/${dm}/export?format=markdown`]);
  });

  test("a client that can't name the address offers nothing", async () => {
    await open(`c/${ENG_ID}`, seedState(), false);
    await rightClick(screen().getByRole("heading", { level: 1, name: "eng" }));
    expect(items()).not.toContain("Exportar conversa");
  });
});
