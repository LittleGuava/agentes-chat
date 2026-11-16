import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Joining by the address's domain (ADR 0068, addendum 2026-11-15): Membros' card where an admin names the domains,
 * and the onboarding's first step, where a confirmed account at one joins with a click.
 */

afterEach(() => {
  localStorage.clear();
  cleanup();
});

const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const card = () => screen().getByRole("region", { name: "Entrar pelo domínio do e-mail" });

describe("Membros › Entrar pelo domínio do e-mail", () => {
  test("an admin adds a domain, sees it with the cargo it gives, and removes it", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
    await settle(6);
    expect(card().textContent).toContain("Quem tem e-mail confirmado nestes domínios encontra Acme");
    await act(async () =>
      fireEvent.change(screen().getByLabelText("Domínio"), { target: { value: "Empresa.com.br" } }),
    );
    await click(screen().getByRole("button", { name: "Adicionar domínio" }));
    expect(calls(state, "joinDomains.add")[0]?.args).toEqual([ORG_ID, { domain: "Empresa.com.br", roleIds: [] }]);
    expect(card().textContent).toContain("empresa.com.br");
    expect(card().textContent).toContain("Entra como Membro");
    expect((screen().getByLabelText("Domínio") as HTMLInputElement).value).toBe("");

    await click(screen().getByRole("button", { name: "Remover empresa.com.br" }));
    expect(calls(state, "joinDomains.remove")[0]?.args).toEqual([ORG_ID, "domain-1"]);
    expect(card().textContent).not.toContain("empresa.com.br");
  });

  test("a refusal is said under the domain, in the person's words", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.joinDomains.add = async () => {
      throw new ApiError(400, "join_domain.public", "Anyone can have an address at this domain", {
        domain: "gmail.com",
      });
    };
    await renderApp(`/org/${ORG_ID}/settings/members`, { api });
    await settle(6);
    await act(async () => fireEvent.change(screen().getByLabelText("Domínio"), { target: { value: "gmail.com" } }));
    await click(screen().getByRole("button", { name: "Adicionar domínio" }));
    expect(card().textContent).toContain(
      "Qualquer pessoa pode ter um e-mail em gmail.com. Use o domínio da sua empresa.",
    );
  });

  test("worst case: ten domains, one as long as a host name gets, each with a long cargo's name", async () => {
    const state = seedState();
    const long = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    state.joinDomains = Array.from({ length: 10 }, (_, i) => ({
      id: `domain-${i}`,
      domain: i === 0 ? long : `filial-${i}.empresa-com-nome-comprido.com.br`,
      roleIds: [],
      createdAt: "2026-11-15T10:00:00.000Z",
    }));
    await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
    await settle(6);
    expect(card().textContent).toContain(long);
    expect(card().querySelectorAll(".ac-list__row")).toHaveLength(10);
  });

  test("a member who doesn't manage members doesn't see it", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [{ id: ORG_ID, name: "Acme", role: "member", showActivity: true }];
    await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
    await settle(6);
    expect(screen().queryByRole("region", { name: "Entrar pelo domínio do e-mail" })).toBeNull();
    expect(calls(state, "joinDomains.list")).toEqual([]);
  });
});

describe("the onboarding's first step", () => {
  test("a workspace the email's domain lets in shows first, and joining opens it", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    state.domainWorkspaces = [{ id: ORG_ID, name: "Acme", logo: null }];
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().getByRole("region", { name: "Sua equipe já está aqui" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Entrar em Acme" }), 14);
    expect(calls(state, "joinDomains.join")[0]?.args).toEqual([ORG_ID]);
    expect(router.state.location.pathname.startsWith(`/org/${ORG_ID}`)).toBe(true);
  });

  test("worst case: a long workspace name keeps its join button", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    const name = "Cooperativa Agroindustrial dos Produtores Rurais do Vale do Jequitinhonha e Mucuri";
    state.domainWorkspaces = [{ id: ORG_ID, name, logo: null }];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().getByRole("button", { name: `Entrar em ${name}` })).toBeTruthy();
  });

  test("nothing shows while the domain lets nobody in", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().queryByRole("region", { name: "Sua equipe já está aqui" })).toBeNull();
  });
});
