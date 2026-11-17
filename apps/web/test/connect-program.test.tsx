import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Machine } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { service } from "./catalog";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const paste = (el: Element, text: string) =>
  act(async () => fireEvent.paste(el, { clipboardData: { getData: () => text } }));

/** The connect form of a server by address, with the person's computers paired first (ADR 0215). */
async function openForm(computers: (Partial<Machine> & { name: string })[]) {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  for (const computer of computers) fakeMachinesOf.get(api)?.pair(computer);
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  const catalog = screen().getByRole("dialog", { name: "Adicionar conector" });
  await click(within(catalog).getByRole("button", { name: /Não achou/ }));
  await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
  await settle(4);
  const flow = () => screen().getByRole("dialog", { name: "Conectar servidor MCP" });
  const field = (label: string) => within(flow()).getByLabelText(label) as HTMLInputElement;
  return { state, flow, field };
}

test("a pasted stdio server offers the person's computer, and the program goes there with its variables", async () => {
  const { state, flow, field } = await openForm([{ name: "Notebook da Ana" }]);
  await paste(
    field("Endereço do servidor MCP"),
    `claude mcp add notes -e NOTES_TOKEN=nt_secret_1 -- npx -y @acme/notes-mcp --dir "my notes"`,
  );
  const note = within(flow()).getByText(/Ele pode rodar num computador que você conectou\./);
  expect(note.closest("[role=status]")).not.toBeNull();

  await click(within(note).getByRole("button", { name: "Usar como programa" }));
  expect(within(flow()).getByRole("radio", { name: "Programa neste computador" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(flow().textContent).toContain("Roda em Notebook da Ana.");
  expect(field("Comando").value).toBe("npx -y @acme/notes-mcp --dir 'my notes'");
  expect(field("Nome").value).toBe("notes");
  expect(field("Nome da variável 1").value).toBe("NOTES_TOKEN");
  expect(field("Valor da variável 1").type).toBe("password");

  await click(within(flow()).getByRole("button", { name: "Adicionar programa" }));
  await settle(4);
  const call = state.calls.find((c) => c.method === "customConnectors.connectProgram");
  expect(call?.args[1]).toEqual({
    machineId: expect.any(String),
    command: "npx",
    args: ["-y", "@acme/notes-mcp", "--dir", "my notes"],
    env: [{ name: "NOTES_TOKEN", value: "[redacted]" }],
    label: "notes",
  });
  const done = screen().getByRole("dialog");
  expect(done.textContent).toContain("Nenhum agente usa ainda. Escolha quem em Ajustar.");

  // In the list it says where it runs and its variables by name, never an address or a value.
  await click(within(done).getByRole("button", { name: "Fechar" }));
  await settle(6);
  expect(screen().getByText(/^Roda em Notebook da Ana · /)).toBeTruthy();
  expect(document.body.textContent).toContain("Variáveis: NOTES_TOKEN");
  expect(document.body.textContent).not.toContain("computer://");
  expect(document.body.textContent).not.toContain("nt_secret_1");
});

test("typed by hand: an open quote is said under the field and nothing is sent", async () => {
  const { state, flow, field } = await openForm([{ name: "Notebook da Ana" }]);
  await click(within(flow()).getByRole("radio", { name: "Programa neste computador" }));
  await type(field("Comando"), `uvx "mcp-server-files`);
  await click(within(flow()).getByRole("button", { name: "Adicionar programa" }));
  expect(flow().textContent).toContain("Ficou uma aspa aberta no comando.");
  expect(state.calls.some((c) => c.method === "customConnectors.connectProgram")).toBe(false);
});

test("without a computer of theirs that can run it, there is no choice and the paste is refused as before", async () => {
  const { flow, field } = await openForm([
    { name: "Servidor desligado", online: false },
    { name: "Notebook do Bruno", pairedBy: { id: "u-bruno", name: "Bruno" } },
  ]);
  expect(within(flow()).queryByRole("radio", { name: "Programa neste computador" })).toBeNull();
  await paste(field("Endereço do servidor MCP"), "claude mcp add files -- npx -y @acme/files-mcp");
  const note = within(flow()).getByRole("alert");
  expect(note.textContent).toContain("Os agentes só alcançam servidores MCP pelo endereço https.");
  expect(within(note).queryByRole("button")).toBeNull();
});
