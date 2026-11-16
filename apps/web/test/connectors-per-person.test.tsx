import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PersonalAccount } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { openConnected } from "./catalog";
import { createFakeApi, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  setNavigateAway((url) => window.location.assign(url));
});

/**
 * Settings › Conectores as a member who doesn't manage connectors, with Google Drive through Composio set to each
 * person's own account (ADR 0195) and `mine` as the viewer's own account there.
 */
async function open(mine: PersonalAccount | null, options: { admin?: boolean; query?: (id: string) => string } = {}) {
  const state = seedState();
  if (!options.admin) meWithRole(state, []);
  const api = createFakeApi(state);
  const drive = await api.customConnectors.connect(ORG_ID, {
    serverUrl: "https://oauth.drive.example.com",
    label: "Google Drive",
    returnTo: "/",
  });
  if (drive.status !== "connected") throw new Error("expected connected");
  const list = api.customConnectors.list;
  api.customConnectors.list = async (orgId) =>
    (await list(orgId)).map((s) => ({ ...s, via: "composio" as const, perPerson: true, mine }));
  const calls: string[] = [];
  api.connectors.connectMine = async (_orgId, id, input) => {
    calls.push(`connect ${id} ${input.returnTo}`);
    return "https://connect.composio.dev/link/ln_1?state=s";
  };
  api.connectors.disconnectMine = async (_orgId, id) => {
    calls.push(`disconnect ${id}`);
  };
  const opened: string[] = [];
  setNavigateAway((url) => opened.push(url));
  const query = options.query?.(drive.server.id) ?? "";
  await renderApp(`/org/${ORG_ID}/settings/connectors${query}`, { api });
  await settle(8);
  await openConnected();
  const row = [...document.querySelectorAll<HTMLElement>(".connected-row")].find((r) =>
    r.textContent?.includes("Google Drive"),
  );
  if (!row) throw new Error("no Google Drive row");
  return { calls, opened, row, id: drive.server.id };
}

/** A row's lines under its name, each as it reads. */
const detailsOf = (row: HTMLElement) => [...row.querySelectorAll(".connected-row__text")].map((l) => l.textContent);

describe("a connection where each person uses their own account", () => {
  test("a member with no account of their own is told so and connects it from its row", async () => {
    const { calls, opened, row, id } = await open(null);
    expect(detailsOf(row)).toContain("Cada pessoa usa a própria conta · Você ainda não conectou a sua conta");
    const button = screen().getByRole("button", { name: "Conectar minha conta ao Google Drive" });
    expect(button.textContent).toBe("Conectar minha conta");
    await act(async () => fireEvent.click(button));
    await settle(3);
    expect(calls).toEqual([`connect ${id} /org/${ORG_ID}/settings/connectors`]);
    expect(opened).toEqual(["https://connect.composio.dev/link/ln_1?state=s"]);
  });

  test("with their account connected it names it, and they disconnect it", async () => {
    const { calls, row, id } = await open({ accountLabel: "bea@acme.com", status: "active" });
    expect(detailsOf(row)).toContain("Cada pessoa usa a própria conta · Sua conta: bea@acme.com");
    expect(screen().queryByRole("button", { name: "Conectar minha conta ao Google Drive" })).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Desconectar minha conta" })));
    await settle(3);
    expect(calls).toEqual([`disconnect ${id}`]);
  });

  test("back from connecting one's own account, an admin is told so without the workspace's new-account dialog", async () => {
    await open(
      { accountLabel: "ana@acme.com", status: "active" },
      { admin: true, query: (id) => `?connected=custom:${id}&outcome=personal` },
    );
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(screen().getByText("Google Drive conectado.")).toBeTruthy();
  });

  test("an account that stopped working says so and offers to connect it again", async () => {
    const { row } = await open({ accountLabel: "bea@acme.com", status: "needs_reconnect" });
    expect(detailsOf(row)).toContain("Cada pessoa usa a própria conta · Sua conta parou de funcionar");
    expect(screen().getByRole("button", { name: "Conectar minha conta ao Google Drive" })).toBeTruthy();
  });
});
