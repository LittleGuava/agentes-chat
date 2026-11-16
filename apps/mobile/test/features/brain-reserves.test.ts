import { describe, expect, test } from "bun:test";
import type { AgentBrain, BrainReserve, MachineAccount } from "@agenteschat/client";
import { reserveSection } from "../../src/features/ai/logic";
import { translator } from "./fixtures";

/*
 * "Configuração avançada" › "IAs de reserva" on the phone (ADR 0118 addendum 2026-11-15): the same list as the web's
 * "Mais opções", each tap saving at once. The screen draws `reserveSection` as it comes: a row per reserve with ▲ ▼
 * and ×, a row per other account with +, each carrying the list that tap saves.
 */

const account = (id: string, label: string, kind: MachineAccount["kind"] = "claude_code"): MachineAccount => ({
  id,
  kind,
  label,
  email: null,
  plan: null,
  status: "active",
  ownerId: "u1",
  ownerName: "Walter Nogueira",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
});

const MAIN = account("acct_main", "Principal");
const WORK = account("acct_work", "Trabalho");
const GPT = account("acct_gpt", "Pessoal", "codex");
const SPARE = account("acct_spare", "Sobra");
const MORE = account("acct_more", "Mais uma");

const view: Pick<AgentBrain, "accounts" | "account"> = { account: MAIN.id, accounts: [MAIN, WORK, GPT, SPARE, MORE] };
const ids = (chain: BrainReserve[] | null) => chain?.map((r) => r.accountId) ?? null;

describe("IAs de reserva on the phone", () => {
  test("the reserves in order, each moved or taken out; the others added last; never the account it thinks with", async () => {
    const t = await translator("pt-BR");
    const s = reserveSection(t, view, [{ accountId: GPT.id }, { accountId: WORK.id }], "u1");

    expect(s.chosen.map((r) => [r.label, r.sub])).toEqual([
      ["Pessoal", "Codex"],
      ["Trabalho", "Claude Code"],
    ]);
    const [first, second] = s.chosen;
    // The first can't go up, the last can't go down: their buttons are there, off.
    expect(first?.up).toEqual({ label: "Subir Pessoal", chain: null });
    expect(ids(first?.down.chain ?? null)).toEqual([WORK.id, GPT.id]);
    expect(ids(second?.up.chain ?? null)).toEqual([WORK.id, GPT.id]);
    expect(second?.down.chain).toBeNull();
    expect(second?.remove.label).toBe("Tirar Trabalho das reservas");
    expect(ids(second?.remove.chain ?? null)).toEqual([GPT.id]);

    expect(s.others.map((r) => r.label)).toEqual(["Sobra", "Mais uma"]);
    expect(s.others[0]?.add.label).toBe("Adicionar Sobra");
    expect(ids(s.others[0]?.add.chain ?? null)).toEqual([GPT.id, WORK.id, SPARE.id]);
    expect(s.others.some((r) => r.label === "Principal")).toBe(false);
    expect(s.full).toBeNull();
  });

  test("three reserves: nothing more to add, and the screen says why", async () => {
    const t = await translator("pt-BR");
    const s = reserveSection(t, view, [{ accountId: GPT.id }, { accountId: WORK.id }, { accountId: SPARE.id }], "u1");
    expect(s.others).toEqual([]);
    expect(s.full).toBe("No máximo 3 reservas.");
  });

  test("a reserve the computer no longer lists isn't drawn, and stays in the list another tap saves", async () => {
    const t = await translator("pt-BR");
    const s = reserveSection(t, view, [{ accountId: "acct_gone" }, { accountId: WORK.id }], "u1");
    expect(s.chosen.map((r) => r.label)).toEqual(["Trabalho"]);
    expect(ids(s.chosen[0]?.remove.chain ?? null)).toEqual(["acct_gone"]);
  });

  test("the screen saves each tap's list at once and shows the section only where the web does", async () => {
    const screen = await Bun.file(
      new URL("../../src/features/ai/AgentAdvancedScreen.tsx", import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        "$1",
      ),
    ).text();
    expect(screen).toContain("offersReserves(view, agent?.ownerUserId)");
    expect(screen).toContain("reserveSection(t, view, reservesOf(view), agent?.ownerUserId)");
    expect(screen).toMatch(/save\(\{ fallbackChain: \w+ \}/);
  });
});
