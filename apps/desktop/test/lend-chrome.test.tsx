import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import { DesktopStore } from "../src/control/store";
import { firstTools } from "../src/control/this-mac";
import { createFakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { Tools } from "../src/windows/prefs/Tools";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Preferences › Tools › Your Chrome (ADR 0202), on fake runners: two organizations, Commands and Claude Code on. */
test("the person lends their Chrome only with every program switch off, sees who holds it, and ends it", async () => {
  const host = createFakeHost("prefs", "selfhost");
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  /** A switch flipped on every runner here, as the person would, one organization's commands at a time. */
  const flip = (tool: string, on: boolean) => {
    for (const runner of host.runners.values())
      runner.handle(JSON.stringify({ id: `t-${tool}`, type: "tools.set", tool, on }));
  };
  const card = () =>
    [...el.querySelectorAll(".dk-ctitle")].find((h) => h.textContent === "Your Chrome")?.nextElementSibling as
      | HTMLElement
      | undefined;
  const lendButton = () =>
    [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Lend") as
      | HTMLButtonElement
      | undefined;
  const sessions = () => [...(card()?.querySelectorAll(":scope > .dk-crow") ?? [])].slice(1);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <Tools />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    // Commands and Claude Code are on here: nothing to lend with, only why.
    await until(() => card()?.textContent?.includes("Turn off Commands and the coding programs first"));
    expect(lendButton()).toBeUndefined();

    await act(async () => {
      flip("commands", false);
      flip("claude", false);
    });
    await until(() => lendButton());
    const port = card()?.querySelector('input[aria-label="Port"]') as HTMLInputElement;
    const typeIn = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

    // A port that can't be one is said under the form; nothing is sent.
    await typeIn(port, "99999");
    await act(async () => lendButton()?.click());
    await until(() => card()?.textContent?.includes("Give the port Chrome listens on"));
    expect(sessions()).toHaveLength(0);

    await typeIn(port, "9333");
    await act(async () => lendButton()?.click());
    await until(() => sessions().length === 1);
    const held = sessions()[0] as HTMLElement;
    expect(held.querySelector(".dk-crow__title")?.textContent).toBe("Dev");
    expect(held.textContent).toContain("port 9333");

    // Turning a coding program on from here gives it back at once.
    await act(async () => (el.querySelector("#tool-claude") as HTMLElement).click());
    await until(() => sessions().length === 0 && card()?.textContent?.includes("Turn off Commands"));
    expect([...host.runners.values()].every((r) => r.myChrome.length === 0)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
});

/** The runner only knows its own switches: the app gives the Chrome back whatever turns one on elsewhere here. */
test("a program switch turned on by any path, a new pairing's first tools too, gives back a Chrome lent through another organization", async () => {
  const host = createFakeHost("prefs", "selfhost");
  const store = new DesktopStore(host, {});
  const stop = store.start();
  try {
    await until(() => store.getSnapshot().homes.filter((h) => h.access).length >= 2);
    const [lenderId, otherId] = [...host.runners.keys()] as [string, string];
    const lent = () => host.runners.get(lenderId)?.myChrome.length;
    for (const runner of host.runners.values())
      for (const tool of ["commands", "claude"])
        runner.handle(JSON.stringify({ id: `off-${tool}`, type: "tools.set", tool, on: false }));
    const agentId = (await store.request(lenderId, { type: "status" })).agents[0]?.id as string;
    await store.request(lenderId, { type: "mychrome.connect", agentId, port: 9333, minutes: 30 });
    expect(lent()).toBe(1);

    // Pairing turns Commands on in the other organization: its agents could reach the port too.
    await firstTools(store, otherId);
    await until(() => lent() === 0);

    // Turned on from the web: the other runner only says its access changed, past any request the app sent.
    const other = host.runners.get(otherId);
    for (const tool of ["commands", "claude", "codex"])
      other?.handle(JSON.stringify({ id: `off2-${tool}`, type: "tools.set", tool, on: false }));
    await until(() => store.home(otherId)?.access?.tools.commands === false);
    await store.request(lenderId, { type: "mychrome.connect", agentId, port: 9333, minutes: 30 });
    expect(lent()).toBe(1);
    other?.handle(JSON.stringify({ id: "web-claude", type: "tools.set", tool: "claude", on: true }));
    await until(() => lent() === 0);
  } finally {
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
});
