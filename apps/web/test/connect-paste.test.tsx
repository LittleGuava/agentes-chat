import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { service } from "./catalog";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const paste = (el: Element, text: string) =>
  act(async () => fireEvent.paste(el, { clipboardData: { getData: () => text } }));

/** The connect form of a server by address, from Settings › Connectors. */
async function openForm() {
  const state = seedState({ connections: [] });
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  const catalog = screen().getByRole("dialog", { name: "Adicionar conector" });
  await click(within(catalog).getByRole("button", { name: /Não achou/ }));
  await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
  const flow = () => screen().getByRole("dialog", { name: "Conectar servidor MCP" });
  const field = (label: string) => within(flow()).getByLabelText(label) as HTMLInputElement;
  return { state, flow, field };
}

test("a pasted claude mcp add line fills the address, the name, the key and the request headers", async () => {
  const { state, flow, field } = await openForm();
  await paste(
    field("Endereço do servidor MCP"),
    `claude mcp add --transport http acme https://mcp.acme.com/mcp \\\n  --header "Authorization: Bearer acme_key_123" \\\n  --header "CF-Access-Client-Secret: s3cr3t-value"`,
  );
  expect(field("Endereço do servidor MCP").value).toBe("https://mcp.acme.com/mcp");
  expect(field("Nome").value).toBe("acme");
  expect(field("Chave de API").value).toBe("acme_key_123");
  expect(field("Nome do cabeçalho 1").value).toBe("CF-Access-Client-Secret");
  expect(field("Valor do cabeçalho 1").value).toBe("s3cr3t-value");

  await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
  await settle(4);
  expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
    serverUrl: "https://mcp.acme.com/mcp",
    label: "acme",
    apiKey: "[redacted]",
    headers: [{ name: "CF-Access-Client-Secret", value: "[redacted]" }],
  });
});

test("a key the paste took from a terminal variable is asked for, never filled", async () => {
  const { flow, field } = await openForm();
  await paste(
    field("Endereço do servidor MCP"),
    JSON.stringify({
      mcpServers: {
        wiki: { url: "https://wiki.example.com/sse", headers: { Authorization: `Bearer \${WIKI_TOKEN}` } },
      },
    }),
  );
  expect(field("Endereço do servidor MCP").value).toBe("https://wiki.example.com/sse");
  expect(field("Chave de API").value).toBe("");
  expect(flow().textContent).toContain("Digite a chave que o texto colado tirava de WIKI_TOKEN.");
});

test("a server run as a command is refused in words; an address pasted alone pastes as it is", async () => {
  const { flow, field } = await openForm();
  await paste(
    field("Endereço do servidor MCP"),
    "claude mcp add files -- npx -y @modelcontextprotocol/server-filesystem",
  );
  expect(field("Endereço do servidor MCP").value).toBe("");
  expect(within(flow()).getByRole("alert").textContent).toContain("roda como comando (stdio)");

  // Typing clears the note; a bare address is left to the browser's own paste.
  await act(async () => fireEvent.change(field("Endereço do servidor MCP"), { target: { value: "https://x" } }));
  expect(within(flow()).queryByRole("alert")).toBeNull();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "https://mcp.example.com/mcp" } });
  await act(async () => {
    field("Endereço do servidor MCP").dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
});
