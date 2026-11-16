import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ImportInput, LocalSetup, Machine } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(cleanup);

const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} for tests\n---\n\nDo it.\n`;

/** What the server answers for a person's own computer (ADR 0055, addendum 2026-11-15). */
const SETUP: LocalSetup = {
  files: [
    { app: "claude", path: "~/.claude.json", state: "read" },
    { app: "cursor", path: "~/.cursor/mcp.json", state: "missing" },
    { app: "codex", path: "~/.codex/config.toml", state: "too_big" },
    { app: "claude", path: "~/.claude/skills", state: "read" },
  ],
  servers: [
    {
      app: "claude",
      name: "linear",
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      headers: ["Authorization"],
      env: [],
      query: [],
      state: "connect",
    },
    {
      app: "claude",
      name: "notes",
      kind: "http",
      url: "https://notes.example.com/mcp",
      headers: [],
      env: [],
      query: [],
      state: "connected",
    },
    {
      app: "cursor",
      name: "local",
      kind: "http",
      url: "http://localhost:3000/mcp",
      headers: [],
      env: [],
      query: [],
      state: "private",
    },
    {
      app: "claude",
      name: "old",
      kind: "sse",
      url: "https://old.example.com/sse",
      headers: [],
      env: [],
      query: [],
      state: "sse",
    },
    {
      app: "codex",
      name: "db",
      kind: "stdio",
      command: "uvx",
      headers: [],
      env: ["DB_URL"],
      query: [],
      state: "stdio",
    },
    {
      app: "claude",
      name: "hook",
      kind: "http",
      url: "https://hooks.example.com/s/***/mcp",
      keyInAddress: true,
      headers: [],
      env: [],
      query: [],
      state: "key_in_address",
    },
  ],
  skipped: [{ path: "~/.claude/skills/linked", reason: "link" }],
  masked: ["deploy"],
  bundle: {
    format: "agenteschat.bundle",
    version: 1,
    source: { app: "claude-code", ref: "computer:m", name: "MacBook do Walter", files: ["~/.claude/skills"] },
    agents: [],
    skills: [
      { key: "review", markdown: skill("review") },
      { key: "deploy", markdown: skill("deploy") },
    ],
    channels: [],
    routines: [],
    notes: [],
    todo: [],
    leftOut: [],
  },
};

const MAC: Partial<Machine> & { name: string } = {
  name: "MacBook do Walter",
  os: "darwin",
  arch: "arm64",
  localConfig: true,
  access: { folders: [], tools: { claude: true, codex: true, commands: false } },
};

const open = async (over: Partial<Machine> = {}, state = seedState()) => {
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const m = machines.pair({ ...MAC, ...over });
  machines.setLocalSetup(m.id, SETUP);
  await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
  await settle(8);
  return { state, m };
};
const card = () => screen().getByRole("region", { name: "MCPs e skills deste computador" });
const serverRow = (name: string) => card().querySelector(`[data-server="${name}"]`) as HTMLElement;
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("the computer page: MCP servers and skills of the person's own tools (ADR 0055)", () => {
  test("whoever connected it reads them: each server says what can be done with it", async () => {
    const { state, m } = await open();
    // Nothing is read from the computer until the person asks.
    expect(calls(state, "machines.localConfig")).toEqual([]);
    await click(within(card()).getByRole("button", { name: "Procurar" }), 10);
    expect(calls(state, "machines.localConfig")).toEqual([[ORG_ID, m.id]]);

    const linear = serverRow("linear");
    expect(linear.textContent).toContain("https://mcp.linear.app/mcp");
    expect(linear.textContent).toContain("Ao conectar, pede Authorization");
    expect(within(linear).getByRole("button", { name: "Conectar linear" })).toBeTruthy();
    expect(serverRow("notes").textContent).toContain("Conectado");
    expect(within(serverRow("notes")).queryByRole("button", { name: /Conectar/ })).toBeNull();
    expect(serverRow("local").textContent).toContain("Só este computador ou a rede dele chega a esse endereço.");
    expect(serverRow("old").textContent).toContain("Usa SSE, um transporte antigo que o agentes.chat não fala.");
    expect(serverRow("db").textContent).toContain("É um programa que roda neste computador (uvx).");
    for (const name of ["local", "old", "db"]) {
      expect(within(serverRow(name)).queryByRole("button", { name: /Conectar/ })).toBeNull();
    }
    expect(serverRow("hook").textContent).toContain("Ao conectar, cole o endereço inteiro.");
    // What wasn't read, and what was masked, before anything is imported.
    expect(card().textContent).toContain("~/.codex/config.toml (grande demais)");
    expect(card().textContent).toContain("~/.claude/skills/linked (é um link)");
    expect(card().textContent).not.toContain("~/.cursor/mcp.json");
    expect(card().textContent).toContain("Em deploy, o que parecia uma chave virou ***.");
  });

  test("Conectar opens the custom-server flow with the address typed in; a masked address is left for the person", async () => {
    await open();
    await click(within(card()).getByRole("button", { name: "Procurar" }), 10);
    await click(within(serverRow("linear")).getByRole("button", { name: "Conectar linear" }));
    const dialog = screen().getByRole("dialog", { name: "Conectar servidor MCP" });
    expect((within(dialog).getByLabelText("Endereço do servidor MCP") as HTMLInputElement).value).toBe(
      "https://mcp.linear.app/mcp",
    );
    await click(within(dialog).getByRole("button", { name: "Fechar" }));

    await click(within(serverRow("hook")).getByRole("button", { name: "Conectar hook" }));
    const again = screen().getByRole("dialog", { name: "Conectar servidor MCP" });
    expect((within(again).getByLabelText("Endereço do servidor MCP") as HTMLInputElement).value).toBe("");
  });

  test("the skills go through the usual import: planned, the picked ones applied", async () => {
    const { state } = await open();
    await click(within(card()).getByRole("button", { name: "Procurar" }), 12);
    const plans = calls(state, "imports.apply").map((a) => a[1] as ImportInput);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.dryRun).toBe(true);
    expect(plans[0]?.bundle.skills.map((s) => s.key)).toEqual(["review", "deploy"]);
    expect(card().textContent).toContain("Veio do Claude Code · 2 skills");
    // The bundle is the computer's: nothing else to pick in its place.
    expect(within(card()).queryByRole("button", { name: "Trocar arquivo" })).toBeNull();

    await click(within(card()).getByRole("checkbox", { name: /deploy/ }));
    await click(within(card()).getByRole("button", { name: /^Importar 1 item/ }), 10);
    const applied = calls(state, "imports.apply").map((a) => a[1] as ImportInput);
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({ dryRun: false, pick: ["skill:review"] });
  });

  test("someone who can't create agents sees the skills but no import", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open({}, state);
    await click(within(card()).getByRole("button", { name: "Procurar" }), 10);
    expect(calls(state, "imports.apply")).toEqual([]);
    expect(card().textContent).toContain("review");
    expect(card().textContent).toContain("Importar skills pede a permissão de criar agentes.");
    expect(within(card()).queryByRole("button", { name: /^Importar/ })).toBeNull();
    // Nor may they connect services: the row says who does.
    expect(within(serverRow("linear")).queryByRole("button", { name: /Conectar/ })).toBeNull();
    expect(serverRow("linear").textContent).toContain("Um admin conecta");
  });

  test("a read the server refuses says why, in words", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const m = machines.pair(MAC);
    const refusals = [
      new ApiError(400, "machine.local_config_unsupported", "unsupported"),
      new ApiError(400, "machine.local_config_outdated", "outdated"),
    ];
    api.machines.localConfig = async () => {
      throw refusals.shift();
    };
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(8);
    await click(within(card()).getByRole("button", { name: "Procurar" }), 10);
    expect(within(card()).getByRole("alert").textContent).toBe(
      "Este computador roda os agentes como usuários deles, não como você. Ele não lê as suas configurações.",
    );
    await click(within(card()).getByRole("button", { name: "Procurar" }), 10);
    expect(within(card()).getByRole("alert").textContent).toBe(
      "O app do computador é antigo demais para isso. Atualize e tente de novo.",
    );
  });

  test("only whoever connected it sees the card; an app too old asks for an update; offline, nothing to press", async () => {
    await open({ pairedBy: { id: "u-someone", name: "Bia" } });
    expect(screen().queryByRole("region", { name: "MCPs e skills deste computador" })).toBeNull();
    cleanup();

    await open({ localConfig: false });
    expect(card().textContent).toContain("Atualize o app deste computador para trazer os MCPs e as skills dele.");
    expect(within(card()).queryByRole("button", { name: "Procurar" })).toBeNull();
    cleanup();

    await open({ online: false });
    expect(card().textContent).toContain("Ligue o computador para procurar.");
    expect(within(card()).queryByRole("button", { name: "Procurar" })).toBeNull();
    cleanup();

    await open({ mode: "system" });
    expect(screen().queryByRole("region", { name: "MCPs e skills deste computador" })).toBeNull();
  });
});
