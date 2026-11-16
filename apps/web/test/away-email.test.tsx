import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/settings/notifications`, { api: createFakeApi(state) });
  await settle(5);
  return state;
};
const LABEL = "Mandar por e-mail o que perdi";
const choose = async (option: string) => {
  const field = screen().getByRole("combobox", { name: LABEL });
  field.focus();
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
  await settle(3);
};
const PREFS = {
  categories: [{ id: "mentions" as const, on: true }],
  phones: 0,
  awayEmail: 60 as const,
};

describe("the email of what I missed while away, in Configurações › Notificações (ADR 0069)", () => {
  test("an hour by default; a person picks another wait or turns it off, and it's saved", async () => {
    const state = await open();
    expect(screen().getByRole("region", { name: "E-mail quando estou fora" })).toBeTruthy();
    expect(screen().getByRole("combobox", { name: LABEL }).textContent).toContain("Depois de uma hora");

    await choose("Depois de um dia");
    await choose("Nunca");
    expect(state.calls.filter((c) => c.method === "notifications.setAwayEmail").map((c) => c.args[1])).toEqual([
      1440, 0,
    ]);
    expect(screen().getByRole("combobox", { name: LABEL }).textContent).toContain("Nunca");
  });

  test("a server that sends no email doesn't offer it", async () => {
    await open(seedState({ noticePrefs: { ...PREFS, emails: false } }));
    expect(screen().getByRole("region", { name: "O que avisa" })).toBeTruthy();
    expect(screen().queryByRole("region", { name: "E-mail quando estou fora" })).toBeNull();
  });
});
