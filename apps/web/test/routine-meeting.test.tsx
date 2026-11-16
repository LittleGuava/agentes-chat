import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CustomServer, RoutineInput, RoutinePatch } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** ADR 0190: "Antes de uma reunião" in the routine form, on a Google Calendar connection the agent reads. */

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

const CAL = "0193aaaa-0000-4000-8000-0000000000c1";
const calendar = (over: Partial<CustomServer> = {}): CustomServer => ({
  id: CAL,
  serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/googlecalendar",
  label: "Google Calendar (ana@acme.com)",
  accountLabel: null,
  authType: "oauth",
  iconUrl: null,
  via: "composio",
  status: "active",
  tools: [],
  events: [],
  meetings: true,
  reviewedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});

/** The routines page with these connections, every agent granted `grant` on the calendar (none: no access). */
async function open(servers: CustomServer[], grant: string | null = "connector:*") {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  if (grant) for (const agent of state.agents) state.scopes[agent.id] = [{ connectionId: CAL, scope: grant }];
  api.customConnectors.list = async () => servers;
  const created: RoutineInput[] = [];
  const updated: RoutinePatch[] = [];
  const create = api.routines.create;
  api.routines.create = (orgId, input) => {
    created.push(input);
    return create(orgId, input);
  };
  const update = api.routines.update;
  api.routines.update = (orgId, id, patch) => {
    updated.push(patch);
    return update(orgId, id, patch);
  };
  return { state, api, created, updated };
}

const newRoutine = async () => {
  await click(screen().getByRole("button", { name: "Nova rotina" }));
  await settle(4);
  return screen().getByRole("dialog", { name: "Nova rotina" });
};

describe("Rotinas: antes de uma reunião (ADR 0190)", () => {
  test("offered where a Google Calendar is connected: its calendar and minutes, made as a meeting routine that always posts", async () => {
    const { api, created } = await open([calendar()]);
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const dialog = await newRoutine();
    await click(within(dialog).getByRole("radio", { name: "Antes de uma reunião" }));
    await settle(6);
    expect(within(dialog).getByRole("combobox", { name: "Calendário" }).textContent).toContain(
      "Google Calendar (ana@acme.com)",
    );
    const minutes = within(dialog).getByLabelText("Minutos antes") as HTMLInputElement;
    expect(minutes.value).toBe("15");
    // Minutes it can't keep: the field says why, and nothing can be sent.
    await type(minutes, "2");
    await type(within(dialog).getByLabelText("O que fazer"), "Prepare notas: quem vem e o que está aberto.");
    expect(dialog.textContent).toContain("Escolha de 5 a 240 minutos.");
    expect(minutes.getAttribute("aria-invalid")).toBe("true");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(4);
    expect(created).toEqual([]);
    await type(minutes, "30");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    expect(created[0]?.trigger).toEqual({ type: "meeting", connectionId: CAL, leadMinutes: 30 });
    expect(created[0]?.report).toBe("always");
    await settle(6);
    expect(screen().getByText("30 min antes de cada reunião")).toBeTruthy();
  });

  test("a meeting routine opens as one: saved unchanged it keeps what starts it, new minutes send its trigger", async () => {
    const { api, updated } = await open([calendar()]);
    await api.routines.create(ORG_ID, {
      name: "Preparar reuniões",
      agentId: (await api.agents.list(ORG_ID))[0]?.id ?? "",
      prompt: "Prepare notas.",
      target: { type: "dm" },
      trigger: { type: "meeting", connectionId: CAL, leadMinutes: 20 },
      report: "always",
    });
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const row = screen().getByRole("article", { name: "Preparar reuniões" });
    const more = within(row).getByRole("button", { name: "Mais ações: Preparar reuniões" });
    more.focus();
    await key(more, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Editar" }));
    await settle(4);
    const page = screen().getByRole("dialog", { name: "Preparar reuniões" });
    const openWhen = async () => {
      await click(within(page).getByRole("button", { name: /^Quando: / }));
      await settle(6);
      return screen().getByRole("dialog", { name: "Quando" });
    };
    let when = await openWhen();
    expect(within(when).getByRole("radio", { name: "Antes de uma reunião" }).getAttribute("aria-checked")).toBe("true");
    expect(within(when).queryByLabelText("Frequência")).toBeNull();
    expect((within(when).getByLabelText("Minutos antes") as HTMLInputElement).value).toBe("20");
    // Nothing changed: Salvar just closes, the meeting trigger kept.
    await click(within(when).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(updated).toEqual([]);
    when = await openWhen();
    await type(within(when).getByLabelText("Minutos antes"), "45");
    await click(within(when).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(updated).toEqual([{ trigger: { type: "meeting", connectionId: CAL, leadMinutes: 45 } }]);
  });

  test("an agent that can't read the calendar is told where its access is given; no calendar, no option", async () => {
    const { api } = await open([calendar()], null);
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const dialog = await newRoutine();
    await click(within(dialog).getByRole("radio", { name: "Antes de uma reunião" }));
    await settle(6);
    expect(within(dialog).getByText(/ainda não lê o Google Calendar/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Minutos antes")).toBeNull();
    cleanup();

    const none = await open([calendar({ meetings: false })]);
    await renderApp(`/org/${ORG_ID}/routines`, { api: none.api });
    await settle(8);
    const fresh = await newRoutine();
    expect(within(fresh).queryByRole("radio", { name: "Antes de uma reunião" })).toBeNull();
  });
});
