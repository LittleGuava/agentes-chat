import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import {
  FOLDER_SYNC_PREF,
  FOLDER_SYNC_STATUS_PREF,
  type FolderSyncChoice,
  type FolderSyncStatus,
} from "../src/control/folder-sync";
import { DesktopStore } from "../src/control/store";
import { FAKE_SERVER } from "../src/dev/fake-runner";
import { readPref, writePref } from "../src/hooks";
import { createFakeHost, type FakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { FolderSync } from "../src/windows/prefs/FolderSync";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => localStorage.clear());

/** Preferences › Agents' files on a fake host (a server of its own and agentes.chat, both signed in). */
async function pane(check: (el: HTMLElement, host: FakeHost) => Promise<void>, before?: (host: FakeHost) => void) {
  const host = createFakeHost("prefs", "selfhost");
  before?.(host);
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <FolderSync />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    await until(() => el.querySelector("#folder-sync"));
    await check(el, host);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

const press = (el: Element | null) => act(async () => (el as HTMLElement).click());
const choice = () => readPref<FolderSyncChoice | null>(FOLDER_SYNC_PREF, null);
/** The conversations' rows as the person reads them, checked or not. */
const boxes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="checkbox"][id^="conversation-"]')];
const rows = (el: HTMLElement) =>
  boxes(el).map(
    (box) =>
      `${box.getAttribute("aria-checked") === "true" ? "☑" : "☐"} ${box.closest(".dk-crow")?.textContent?.trim()}`,
  );
const anyRow = (el: HTMLElement) => boxes(el)[0] ?? null;

describe("Preferences › Agents' files (ADR 0204)", () => {
  test("off at first; turning it on takes the open server's first workspace and lists what the person reads there", async () => {
    await pane(async (el, host) => {
      expect(el.querySelector("#folder-sync")?.getAttribute("aria-checked")).toBe("false");
      expect(anyRow(el)).toBeNull();

      await press(el.querySelector("#folder-sync"));
      await until(() => anyRow(el));

      expect(choice()).toEqual({ on: true, server: FAKE_SERVER, orgId: "org_acme", channelIds: [] });
      // Channels by name, then the direct conversations with agents; Ana's DM holds no agent's files.
      expect(rows(el)).toEqual(["☐ #anúncios", "☐ #general", "☐ #vendas", "☐ DevDirect messages"]);
      expect(host.site.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "GET /api/app/organizations/org_acme/channels",
        "GET /api/app/organizations/org_acme/dms",
      ]);
    });
  });

  test("checking a conversation adds it to what comes down, unchecking takes it out", async () => {
    await pane(async (el) => {
      await press(el.querySelector("#folder-sync"));
      await until(() => anyRow(el));
      const box = (name: string) => boxes(el).find((b) => b.closest(".dk-crow")?.textContent?.includes(name)) ?? null;

      await press(box("#general"));
      await press(box("Dev"));
      expect(choice()?.channelIds).toEqual(["c-general", "d-dev"]);
      expect(rows(el)).toContain("☑ #general");

      await press(box("#general"));
      expect(choice()?.channelIds).toEqual(["d-dev"]);
    });
  });

  test("turning it off keeps the choice for later and hides it", async () => {
    writePref(FOLDER_SYNC_PREF, { on: true, server: FAKE_SERVER, orgId: "org_acme", channelIds: ["c-general"] });
    await pane(async (el) => {
      await until(() => anyRow(el));
      expect(rows(el)).toContain("☑ #general");
      await press(el.querySelector("#folder-sync"));
      expect(choice()).toEqual({ on: false, server: FAKE_SERVER, orgId: "org_acme", channelIds: ["c-general"] });
      expect(anyRow(el)).toBeNull();
    });
  });

  test("the folder, with a button that shows it", async () => {
    const shown: string[] = [];
    await pane(
      async (el, host) => {
        await press(el.querySelector("#folder-sync"));
        const root = await host.folderSyncRoot();
        await until(() => el.textContent?.includes(root));
        const show = [...el.querySelectorAll("button")].find((b) => b.textContent === "Show in Finder");
        await press(show ?? null);
        expect(shown).toEqual([root]);
      },
      (host) => {
        host.revealFolder = async (path) => {
          shown.push(path);
        };
      },
    );
  });

  test("the last download and its trouble, as the popover writes them, kept current", async () => {
    writePref(FOLDER_SYNC_PREF, { on: true, server: FAKE_SERVER, orgId: "org_acme", channelIds: ["c-general"] });
    const status = (s: Partial<FolderSyncStatus>): FolderSyncStatus => ({
      server: FAKE_SERVER,
      orgId: "org_acme",
      at: new Date().toISOString(),
      written: 2,
      failed: 0,
      unreachable: false,
      ...s,
    });
    writePref(FOLDER_SYNC_STATUS_PREF, status({}));
    await pane(async (el) => {
      await until(() => el.textContent?.includes("Last download"));
      expect(el.textContent).not.toContain("Not yet");
      expect(el.textContent).not.toContain("couldn't");

      // The popover writes another, in its own window: the storage event brings it here.
      await act(async () => {
        writePref(FOLDER_SYNC_STATUS_PREF, status({ unreachable: true }));
        window.dispatchEvent(new StorageEvent("storage", { key: `agentes.desktop.${FOLDER_SYNC_STATUS_PREF}` }));
      });
      await until(() => el.textContent?.includes("The server couldn't be reached"));
    });
  });

  test("a workspace the person left can be traded for one still there, even with only one left", async () => {
    writePref(FOLDER_SYNC_PREF, { on: true, server: FAKE_SERVER, orgId: "org_gone", channelIds: ["c-old"] });
    await pane(
      async (el) => {
        await until(() => el.querySelector("#folder-sync-workspace"));
        // Nothing is dropped on its own: a session out for a moment would lose the choice.
        expect(choice()).toEqual({ on: true, server: FAKE_SERVER, orgId: "org_gone", channelIds: ["c-old"] });
      },
      (host) => {
        host.workspaces = async () => [
          {
            server: FAKE_SERVER,
            signedIn: true,
            agentsHere: true,
            orgs: [{ id: "org_acme", name: "Acme", logo: null, unread: 0, waiting: 0, pair: true }],
          },
        ];
      },
    );
  });

  test("conversations that can't be read say so, and Try again reads them again", async () => {
    await pane(
      async (el, host) => {
        await press(el.querySelector("#folder-sync"));
        await until(() => el.textContent?.includes("Couldn't read the conversations"));
        host.site.signedOut = false;
        await press([...el.querySelectorAll("button")].find((b) => b.textContent === "Try again") ?? null);
        await until(() => anyRow(el));
      },
      (host) => {
        host.site.signedOut = true;
      },
    );
  });
});
