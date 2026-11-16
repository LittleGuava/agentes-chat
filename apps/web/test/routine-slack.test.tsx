import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CustomServer, RoutineInput } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(1);
};

const slackServer = (id: string, label: string): CustomServer => ({
  id,
  serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/slack",
  label,
  accountLabel: null,
  authType: "oauth",
  iconUrl: null,
  status: "active",
  tools: [],
  events: ["slack.message.received"],
  reviewedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
});

/** ADR 0196: a routine on a new Slack message, made in Nova rotina, read and edited in Rotinas. */
describe("Nova rotina: quando chegar uma mensagem no Slack", () => {
  test("offered where Slack is connected, beside MillionSend: the connection, the channel and the words", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    for (const agent of state.agents)
      state.scopes[agent.id] = [
        ...(state.scopes[agent.id] ?? []),
        { connectionId: "slack-1", scope: "custom:slack-1:read" },
        { connectionId: "slack-2", scope: "custom:slack-2:read" },
        { connectionId: "ms-1", scope: "custom:ms-1:read" },
      ];
    api.customConnectors.list = async () => [
      slackServer("slack-1", "Slack da Acme"),
      slackServer("slack-2", "Slack do Suporte"),
      {
        ...slackServer("ms-1", "MillionSend"),
        serverUrl: "https://api.millionsend.com/mcp",
        events: ["millionsend.email.received"],
      },
    ];
    const created: RoutineInput[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    // Both services, each its own choice.
    expect(within(dialog).getByRole("radio", { name: "Email no MillionSend" })).toBeTruthy();
    await click(within(dialog).getByRole("radio", { name: "Mensagem no Slack" }));
    await settle(6);
    expect(within(dialog).queryByLabelText("Endereço da caixa")).toBeNull();
    // Two Slack connections: the person picks which one.
    const connection = within(dialog).getByRole("combobox", { name: "Conexão" });
    expect(connection.textContent).toContain("Slack da Acme");
    connection.focus();
    await act(async () => fireEvent.keyDown(connection, { key: "Enter" }));
    await settle(2);
    expect(screen().queryByRole("option", { name: "MillionSend" })).toBeNull();
    await click(screen().getByRole("option", { name: "Slack do Suporte" }));
    await settle(2);
    await type(within(dialog).getByLabelText("ID do canal"), " c0support ");
    await type(within(dialog).getByLabelText("Texto contém"), "ajuda");
    await type(within(dialog).getByLabelText("O que fazer"), "Responda quem pediu ajuda.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(8);
    expect(created[0]?.trigger).toEqual({
      type: "connector",
      connectionId: "slack-2",
      event: "slack.message.received",
      inboxId: null,
      filter: { channel: "C0SUPPORT", text: "ajuda" },
    });
    expect(screen().getByText("Quando chegar uma mensagem no Slack")).toBeTruthy();
  });

  test("switching to MillionSend and back starts each over: no Slack channel goes out as an email filter", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    for (const agent of state.agents)
      state.scopes[agent.id] = [
        ...(state.scopes[agent.id] ?? []),
        { connectionId: "slack-1", scope: "custom:slack-1:read" },
        { connectionId: "ms-1", scope: "custom:ms-1:read" },
      ];
    api.customConnectors.list = async () => [
      slackServer("slack-1", "Slack da Acme"),
      {
        ...slackServer("ms-1", "MillionSend"),
        serverUrl: "https://api.millionsend.com/mcp",
        events: ["millionsend.email.received"],
      },
    ];
    const created: RoutineInput[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Mensagem no Slack" }));
    await settle(6);
    // One Slack connection: nothing to pick.
    expect(within(dialog).queryByRole("combobox", { name: "Conexão" })).toBeNull();
    await type(within(dialog).getByLabelText("ID do canal"), "C0SALES");
    await click(within(dialog).getByRole("radio", { name: "Email no MillionSend" }));
    await settle(6);
    expect(within(dialog).queryByLabelText("ID do canal")).toBeNull();
    await type(within(dialog).getByLabelText("Assunto contém"), "pedido");
    await type(within(dialog).getByLabelText("O que fazer"), "Responda o pedido.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(8);
    expect(created[0]?.trigger).toEqual({
      type: "connector",
      connectionId: "ms-1",
      event: "millionsend.email.received",
      inboxId: null,
      filter: { subject: "pedido" },
    });
  });
});

/** ADR 0196: a routine on a new Slack message, made through the API, read and edited in Rotinas. */
describe("Rotinas: quando chegar uma mensagem no Slack", () => {
  test("the list names Slack; Quando shows its channel and words, and Salvar keeps it a Slack routine", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    for (const agent of state.agents)
      state.scopes[agent.id] = [
        ...(state.scopes[agent.id] ?? []),
        { connectionId: "slack-1", scope: "custom:slack-1:read" },
      ];
    api.customConnectors.list = async () => [
      {
        id: "slack-1",
        serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/slack",
        label: "Slack",
        accountLabel: null,
        authType: "oauth",
        iconUrl: null,
        status: "active",
        tools: [],
        events: ["slack.message.received"],
        reviewedAt: null,
        createdAt: "2026-11-01T00:00:00Z",
      },
    ];
    const agentId = state.agents[0]?.id ?? "";
    await api.routines.create(ORG_ID, {
      name: "Pedidos no Slack",
      agentId,
      prompt: "Responda o pedido novo.",
      target: { type: "dm" },
      trigger: {
        type: "connector",
        connectionId: "slack-1",
        event: "slack.message.received",
        inboxId: null,
        filter: { channel: "C0SALES", text: "pedido" },
      },
    });
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);

    const card = screen().getByRole("article", { name: "Pedidos no Slack" });
    expect(card.textContent).toContain("Quando chegar uma mensagem no Slack");
    expect(card.textContent).not.toContain("MillionSend");

    const more = within(card).getByRole("button", { name: "Mais ações: Pedidos no Slack" });
    more.focus();
    await key(more, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Editar" }));
    await settle(4);
    const page = screen().getByRole("dialog", { name: "Pedidos no Slack" });
    await click(within(page).getByRole("button", { name: /^Quando: / }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Quando" });
    expect(within(dialog).getByRole("radio", { name: "Mensagem no Slack" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Endereço da caixa")).toBeNull();
    expect((within(dialog).getByLabelText("ID do canal") as HTMLInputElement).value).toBe("C0SALES");
    await type(within(dialog).getByLabelText("Texto contém"), " urgente ");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const update = state.calls.find((c) => c.method === "routines.update");
    if (!update) throw new Error("nothing saved");
    expect((update.args[1] as { trigger?: unknown }).trigger).toEqual({
      type: "connector",
      connectionId: "slack-1",
      event: "slack.message.received",
      inboxId: null,
      filter: { channel: "C0SALES", text: "urgente" },
    });
  });
});
