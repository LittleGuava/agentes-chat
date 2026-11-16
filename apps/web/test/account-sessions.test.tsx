import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AccountSession } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const DAY = 86_400_000;
const session = (id: string, patch: Partial<AccountSession>): AccountSession => ({
  id,
  current: false,
  device: { kind: "browser", browser: "Chrome", os: "Windows" },
  ip: null,
  signedInAt: new Date(Date.now() - 30 * DAY).toISOString(),
  lastActiveAt: new Date().toISOString(),
  ...patch,
});

const SESSIONS = [
  session("here", { current: true, ip: "2001:db8:85a3:1234:5678:8a2e:370:7334" }),
  session("phone", {
    device: { kind: "phone_app", browser: null, os: "iOS" },
    ip: "198.51.100.4",
    lastActiveAt: new Date(Date.now() - DAY).toISOString(),
  }),
  session("mac", { device: { kind: "browser", browser: null, os: "macOS" } }),
];

const open = async (accountSessions?: AccountSession[]) => {
  const state = seedState({ accountSessions });
  await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
  await settle(5);
  return state;
};
const card = () => screen().getByRole("region", { name: "Sessões ativas" });
const rows = () =>
  within(card())
    .getAllByText(/Chrome no Windows|App do celular|macOS/)
    .map((el) => el.textContent);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("Sessões ativas, in Configurações › Sua conta", () => {
  test("names each device, this session first and marked, with no Sair of its own", async () => {
    await open(SESSIONS);
    expect(rows()).toEqual(["Chrome no Windows", "App do celular no iOS", "macOS"]);
    expect(card().textContent).toContain("Esta sessão");
    expect(card().textContent).toContain("2001:db8:85a3:1234:5678:8a2e:370:7334");
    expect(card().textContent).toContain("198.51.100.4 · Último uso: Ontem");
    expect(within(card()).queryByRole("button", { name: "Sair: Chrome no Windows" })).toBeNull();
  });

  test("Sair signs that one session out and it leaves the list", async () => {
    const state = await open(SESSIONS);
    await click(within(card()).getByRole("button", { name: "Sair: App do celular no iOS" }));
    expect(state.calls.filter((c) => c.method === "account.signOutSession").map((c) => c.args)).toEqual([["phone"]]);
    expect(rows()).toEqual(["Chrome no Windows", "macOS"]);
  });

  test("Sair de todas as outras leaves this one alone, then goes away", async () => {
    const state = await open(SESSIONS);
    await click(within(card()).getByRole("button", { name: "Sair de todas as outras" }));
    expect(state.calls.some((c) => c.method === "account.signOutOtherSessions")).toBe(true);
    expect(rows()).toEqual(["Chrome no Windows"]);
    expect(document.body.textContent).toContain("Você saiu das outras sessões.");
    expect(within(card()).queryByRole("button", { name: "Sair de todas as outras" })).toBeNull();
  });

  test("a server from before the list shows no card", async () => {
    await open(undefined);
    expect(screen().queryByRole("region", { name: "Sessões ativas" })).toBeNull();
  });
});
