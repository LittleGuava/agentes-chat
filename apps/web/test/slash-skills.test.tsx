import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const type = (el: Element, value: string) =>
  act(async () =>
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );

/** Ada with "Revisão de PR" and "Atendimento" on, and someone else's personal skill on for her too. */
async function adaWithSkills() {
  const api = createFakeApi(seedState());
  const all = await api.skills.list(ORG_ID);
  const id = (name: string) => all.find((s) => s.name === name)?.id ?? "";
  const theirs = await api.skills.create(ORG_ID, { name: "Notas da Bia", description: "Só da Bia.", body: "x" });
  await api.skills.setForAgent(ORG_ID, ADA_ID, [
    { skillId: id("Revisão de PR"), enabled: true },
    { skillId: id("Atendimento"), enabled: true },
    { skillId: theirs.id, enabled: true },
  ]);
  // Someone else's: on for Ada, but a message of mine can't use it.
  const list = await api.skills.forAgent(ORG_ID, ADA_ID);
  const original = api.skills.forAgent;
  api.skills.forAgent = async (orgId, agentId) =>
    (await original(orgId, agentId)).map((s) => (s.id === theirs.id ? { ...s, ownerUserId: "someone-else" } : s));
  expect(list.filter((s) => s.enabled)).toHaveLength(3);
  return api;
}

const optionTexts = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");

describe("skills in the composer's '/' menu", () => {
  test("a DM lists the agent's skills after its commands; picking one asks it to use that skill", async () => {
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: await adaWithSkills() });
    await settle(8);
    const composer = screen().getByRole("combobox", { name: "Mensagem para Ada" }) as HTMLTextAreaElement;
    await type(composer, "/");
    await settle(4);
    const menu = screen().getByRole("listbox", { name: "Comandos" });
    const texts = optionTexts(menu);
    expect(texts.slice(-2)).toEqual([expect.stringContaining("Atendimento"), expect.stringContaining("Revisão de PR")]);
    expect(texts[0]).toContain("/relatório");
    expect(texts.some((x) => x.includes("Notas da Bia"))).toBe(false);
    expect(menu.textContent).toContain("Skills");
    // The line under a skill is its description's first sentence.
    expect(texts.at(-1)).toContain("Use quando pedirem para revisar um pull request.");

    await type(composer, "/revi");
    const narrowed = screen().getByRole("listbox", { name: "Comandos" });
    expect(optionTexts(narrowed)).toEqual([expect.stringContaining("Revisão de PR")]);
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(composer.value).toBe("use a skill Revisão de PR: ");
  });

  test("in a channel the request names the agent", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: await adaWithSkills() });
    await settle(8);
    const composer = screen().getByRole("combobox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    await type(composer, "/atend");
    await settle(4);
    const menu = screen().getByRole("listbox", { name: "Comandos" });
    expect(optionTexts(menu)).toEqual([expect.stringContaining("Atendimento")]);
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(composer.value).toMatch(/^@\S+ use a skill Atendimento: $/);
  });
});
