import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { RELAY_PROTOCOL, type RelayAgent } from "@agenteschat/adapters/machine-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import { DesktopStore } from "../src/control/store";
import { createFakeHost, type FakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { Sites } from "../src/windows/prefs/Sites";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** ADR 0203: Preferences › Sites, on a fake host whose runner keeps what the person decides. */

const ANA: RelayAgent = { id: "ag_far", handle: "ana", name: "Ana", machine: "Escritório", look: { color: "rose" } };
const RUI: RelayAgent = { id: "ag_rui", handle: "rui", name: "Rui", machine: "Servidor" };

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount(setup: (host: FakeHost) => void) {
  const host = createFakeHost("prefs", "selfhost");
  setup(host);
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root: Root = createRoot(el);
  await act(async () =>
    root.render(
      <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
        <AppProvider host={host} store={store}>
          <ToastProvider>
            <Sites />
          </ToastProvider>
        </AppProvider>
      </I18nextProvider>,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  };
  return { el, host, store };
}

/** Types into a React field: the value through the field's own setter, then the event React listens to. */
function typeInto(field: Element | null, value: string) {
  const input = field as HTMLInputElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const rowTitles = (el: HTMLElement) => [...el.querySelectorAll(".dk-crow__title")].map((t) => t.textContent);
/** The option rows of the open "who opens it" list, by their words. */
const option = (text: string) =>
  [...document.querySelectorAll(".dk-drop__row")].find((r) => r.textContent?.includes(text)) as HTMLElement | undefined;

describe("Preferences › Sites", () => {
  test("a person lends a site to an agent of another computer by name, then to every agent, then stops", async () => {
    const { el, host, store } = await mount((h) => {
      for (const r of h.runners.values()) {
        r.protocol = RELAY_PROTOCOL;
        r.lendable = [ANA, RUI];
      }
    });
    await until(() => rowTitles(el).includes("No site through this Mac in Acme"));

    await click(button(el, "Add site"));
    await until(() => dialog());
    const field = () => dialog()?.querySelector("input") ?? null;
    // What names no public site is refused in the dialog, and nothing reaches this computer's list.
    await act(async () => typeInto(field(), "localhost"));
    await click(button(dialog() as HTMLElement, "Add"));
    await until(() => dialog()?.textContent?.includes("That isn't a public site. Type a name like example.com."));
    await act(async () => typeInto(field(), "https://Jobs.Example.com/vagas"));
    await click(button(dialog() as HTMLElement, "Add"));
    await until(() => rowTitles(el).includes("jobs.example.com"));
    expect(el.textContent).toContain("No agent uses it yet");

    // The list of whom to lend it to opens by itself: every agent, then the workspace's agents with their computer.
    await until(() => option("Ana"));
    expect(option("Every agent")).toBeDefined();
    expect(option("Ana")?.textContent).toContain("Escritório");
    expect(option("Rui")?.textContent).toContain("Servidor");
    await click(option("Ana")?.querySelector('[role="checkbox"]'));
    await until(() => el.querySelector(".dk-crow__line")?.textContent?.includes("Ana"));
    const [homeId] = host.runners.keys();
    // What this computer keeps, as its runner answers the app.
    const relayOf = async () => (await store.request(homeId as string, { type: "access.get" })).relay;
    expect(await relayOf()).toEqual([{ site: "jobs.example.com", agents: ["ag_far"] }]);

    await click(option("Every agent")?.querySelector('[role="checkbox"]'));
    await until(() => el.querySelector(".dk-crow__line")?.textContent === "Every agent of Acme");
    expect(await relayOf()).toEqual([{ site: "jobs.example.com", agents: ["*"] }]);

    await click(el.querySelector('[aria-label="Remove jobs.example.com"]'));
    await until(() => dialog()?.textContent?.includes("Stop lending jobs.example.com?"));
    await click(button(dialog() as HTMLElement, "Remove"));
    await until(() => rowTitles(el).includes("No site through this Mac in Acme"));
    expect(await relayOf()).toEqual([]);
  });

  test("an older agentes.chat on this computer asks for an update instead of offering to lend", async () => {
    const { el } = await mount(() => undefined);
    await until(() => rowTitles(el).includes("Update agentes.chat to lend sites"));
    expect(button(el, "Add site")).toBeUndefined();
  });
});
