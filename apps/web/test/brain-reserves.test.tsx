import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog, brainLines, done, toScreen } from "./ai-picker";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

/*
 * "Quem pensa" › "Mais opções" › "IAs de reserva" (ADR 0118 addendum 2026-11-15): up to three of the accounts on the
 * agent's computer, in the order they answer while its own plan is at its limit or signed out. Added, moved and
 * removed in place; "Concluído" saves the list with the rest.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};

const account = (id: string, label: string, kind: MachineAccount["kind"] = "claude_code"): MachineAccount => ({
  id,
  kind,
  label,
  email: null,
  plan: null,
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter Nogueira",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  // Walter's plans serve the whole workspace (ADR 0059 §3): Ada, João's agent, may use them.
  serves: "everyone",
});

const MAIN = account("acct_main", "Principal");
const WORK = account("acct_work", "Trabalho");
const GPT = account("acct_gpt", "Pessoal", "codex");
const SPARE = account("acct_spare", "Sobra");
const MORE = account("acct_more", "Mais uma");

/** Ada thinks with Claude Code on the MacBook's account "Principal"; the others wait there. */
async function onMac(patch: Partial<AgentBrain> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    browser: { available: true, version: "1", chrome: null, reason: null },
  });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  api.agents.brain = async () =>
    fakeAgentBrain(ADA_ID, {
      brain: "claude_code",
      effectiveModel: "sonnet",
      account: MAIN.id,
      accounts: [MAIN, WORK, GPT, SPARE, MORE],
      fallbackChain: [],
      ...patch,
    });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return state;
}

const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const reservesLine = (d: HTMLElement) => brainLines(d).find((l) => l.label === "IAs de reserva")?.value;
/** The reserves in order, as their list says them. */
const chosen = (d: HTMLElement) =>
  Array.from(within(d).getByRole("list", { name: "IAs de reserva, em ordem" }).querySelectorAll("li")).map(
    (li) => li.querySelector(".bd-reserve__name")?.textContent,
  );

describe("Quem pensa: IAs de reserva", () => {
  test("adds up to three in order, moves and removes them, and saves the list with Concluído", async () => {
    const state = await onMac();
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(reservesLine(d)).toBe("Nenhuma");
    await toScreen(d, "IAs de reserva");
    // The account it thinks with is never offered.
    expect(within(d).queryByRole("button", { name: "Adicionar Principal" })).toBeNull();
    await click(within(d).getByRole("button", { name: "Adicionar Trabalho" }));
    await click(within(d).getByRole("button", { name: "Adicionar Pessoal" }));
    await click(within(d).getByRole("button", { name: "Adicionar Sobra" }));
    expect(chosen(d)).toEqual(["Trabalho", "Pessoal", "Sobra"]);
    // Three is the most: nothing more to add.
    expect(within(d).queryByRole("button", { name: "Adicionar Mais uma" })).toBeNull();
    expect(d.textContent).toContain("No máximo 3 reservas.");
    // Pessoal first, Sobra out.
    expect((within(d).getByRole("button", { name: "Subir Trabalho" }) as HTMLButtonElement).disabled).toBe(true);
    await click(within(d).getByRole("button", { name: "Subir Pessoal" }));
    await click(within(d).getByRole("button", { name: "Tirar Sobra das reservas" }));
    expect(chosen(d)).toEqual(["Pessoal", "Trabalho"]);
    expect(reservesLine(d)).toBe("Pessoal, Trabalho");
    await done(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([
      { brain: "claude_code", fallbackChain: [{ accountId: GPT.id }, { accountId: WORK.id }] },
    ]);
  });

  test("the saved list shows in order; nothing changed sends nothing about it", async () => {
    const state = await onMac({ fallbackChain: [{ accountId: GPT.id }, { accountId: WORK.id }] });
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(reservesLine(d)).toBe("Pessoal, Trabalho");
    await toScreen(d, "IAs de reserva");
    expect(chosen(d)).toEqual(["Pessoal", "Trabalho"]);
    await done(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([]);
  });

  test("not offered on a key, nor with no other account on the computer", async () => {
    await onMac({ accounts: [MAIN] });
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(reservesLine(d)).toBeUndefined();
  });
});
