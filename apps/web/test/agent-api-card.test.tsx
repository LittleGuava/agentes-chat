import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { agentApiCurl } from "@agenteschat/client/lib/agent-api";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, fakeAgentApiKeysOf, ORG_ID, seedState } from "./fake-api";
import { AGENT_API_ORIGIN, type FakeAgentApiKeys } from "./fakes/agent-api-keys";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

const ENDPOINT = `${AGENT_API_ORIGIN}/api/agents/v1/${ADA_ID}/messages`;
const ROOM_ID = "00000000-0000-4000-8000-0000000000e1";

const open = async (path: string, state: FakeState = seedState(), setup?: (keys: FakeAgentApiKeys) => void) => {
  const api = createFakeApi(state);
  const keys = fakeAgentApiKeysOf.get(api) as FakeAgentApiKeys;
  setup?.(keys);
  const r = await renderApp(path, { api });
  await settle(8);
  return { ...r, state, keys };
};
const go = (state?: FakeState, setup?: (keys: FakeAgentApiKeys) => void) =>
  open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, state, setup);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(2);
};
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await key(trigger, "Enter");
  return within(screen().getByRole("menu"));
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
const card = () => within(screen().getByRole("region", { name: "API do agente" }));
const dialog = () => within(screen().getByRole("dialog"));
const keyList = () => screen().getByRole("region", { name: "API do agente" }).querySelector(".ac-list") as HTMLElement;
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
/** I (Walter) am a member and Ada's owner. */
const asOwner = () => {
  const state = asMember();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  return state;
};

describe("the curl a card shows", () => {
  test("this server's address, the bearer, and a message quoted for the shell", () => {
    expect(agentApiCurl(ENDPOINT, "agk_x", "It's done")).toBe(
      [
        `curl -X POST ${ENDPOINT} \\`,
        '  -H "Authorization: Bearer agk_x" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"message":"It'\\''s done","wait_seconds":30}'`,
      ].join("\n"),
    );
  });
});

describe("agent page: the agent API card (ADR 0187)", () => {
  test("lists the keys without a secret, says who made each, and the example names this server", async () => {
    await go(undefined, (keys) => {
      keys.add(ADA_ID, { name: "Deploy bot", lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() });
      keys.add(ADA_ID, {
        name: "Planilha",
        createdBy: { id: "u-joao", name: "João" },
        expiresAt: "2027-02-01T12:00:00.000Z",
      });
    });
    const text = keyList().textContent ?? "";
    expect(text).toContain("Deploy bot");
    expect(text).toContain("por você");
    expect(text).toContain("Usada");
    expect(text).toContain("Planilha");
    expect(text).toContain("por João");
    expect(text).toContain("Expira em");
    expect(text).toContain("Nunca usada");
    expect(text).toContain("Wx9z");
    // The example: this server's address and the agent's id, a placeholder where the secret goes.
    const example = screen().getByRole("region", { name: "API do agente" }).querySelector("pre")?.textContent ?? "";
    expect(example).toContain(`curl -X POST ${ENDPOINT}`);
    expect(example).toContain("Bearer agk_…");
  });

  test("Criar chave: the secret once, with the curl ready to paste; Já copiei only after copying, then listed", async () => {
    copied.length = 0;
    const { state } = await go();
    expect(card().getByText("Nenhuma chave criada.")).toBeTruthy();
    await click(card().getByRole("button", { name: "Criar chave" }));
    const create = dialog();
    const submit = create.getByRole("button", { name: "Criar chave" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.change(create.getByLabelText("Nome"), { target: { value: "Pipeline" } }));
    await click(submit);
    expect(calls(state, "agentApiKeys.create")).toEqual([[ORG_ID, ADA_ID, { name: "Pipeline", expiresInDays: 90 }]]);
    expect(dialog().getByRole("heading", { name: "Chave criada" })).toBeTruthy();
    const shown = screen().getByRole("dialog").textContent ?? "";
    expect(shown).toContain("Copie agora. Ela não aparece de novo.");
    const secret = `agk_${"A1b2C3d4".repeat(5)}Wx9`;
    expect(shown).toContain(secret);
    expect(shown).toContain(`Bearer ${secret}`);
    const done = dialog().getByRole("button", { name: "Já copiei" });
    expect(done.hasAttribute("disabled")).toBe(true);
    // Before copying, Esc keeps the secret on screen and asks first.
    await key(screen().getByRole("dialog"), "Escape");
    expect(screen().getByRole("dialog").textContent).toContain("A chave não aparece de novo");
    await click(dialog().getByRole("button", { name: "Copiar chave" }));
    expect(copied).toEqual([secret]);
    await click(dialog().getByRole("button", { name: "Já copiei" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    const list = keyList().textContent ?? "";
    expect(list).toContain("Pipeline");
    expect(list).toContain("Expira em");
    expect(document.body.textContent).not.toContain(secret);
  });

  test("past 10 keys the dialog says so; no expiry without a recent sign-in asks to sign in again", async () => {
    const { keys } = await go();
    keys.nextError = new ApiError(409, "agent_api.key_limit", "At most 10");
    await click(card().getByRole("button", { name: "Criar chave" }));
    await act(async () => fireEvent.change(dialog().getByLabelText("Nome"), { target: { value: "One more" } }));
    await click(dialog().getByRole("button", { name: "Criar chave" }));
    expect(screen().getByRole("dialog").textContent).toContain(
      "Este agente já tem 10 chaves. Revogue uma para criar outra.",
    );
    keys.nextError = new ApiError(403, "reauth.sign_in", "Sign in again");
    await click(dialog().getByRole("button", { name: "Criar chave" }));
    expect(screen().getByRole("dialog").textContent).toContain("Uma chave sem validade pede uma entrada recente");
    expect(dialog().getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
  });

  test("Revogar asks first, then the key leaves the list", async () => {
    const { state } = await go(undefined, (keys) => void keys.add(ADA_ID, { name: "Deploy bot" }));
    await click(
      (await openMenu(card().getByRole("button", { name: "Opções de Deploy bot" }))).getByRole("menuitem", {
        name: "Revogar",
      }),
    );
    expect(dialog().getByRole("heading", { name: "Revogar Deploy bot?" })).toBeTruthy();
    await click(dialog().getByRole("button", { name: "Revogar" }));
    expect(calls(state, "agentApiKeys.revoke")).toHaveLength(1);
    expect(card().getByText("Nenhuma chave criada.")).toBeTruthy();
  });

  test("Abrir conversa on my keys that have one opens the key's room; never on someone else's", async () => {
    const { router } = await go(undefined, (keys) => {
      keys.add(ADA_ID, { name: "Theirs", createdBy: { id: "u-joao", name: "João" } });
      keys.add(ADA_ID, { name: "Mine", roomId: ROOM_ID });
    });
    const theirs = await openMenu(card().getByRole("button", { name: "Opções de Theirs" }));
    expect(theirs.queryByRole("menuitem", { name: "Abrir conversa" })).toBeNull();
    await key(screen().getByRole("menu"), "Escape");
    const mine = await openMenu(card().getByRole("button", { name: "Opções de Mine" }));
    await click(mine.getByRole("menuitem", { name: "Abrir conversa" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ROOM_ID}`);
  });

  test("back to the tab after a script used a key, its room and last use show without a reload", async () => {
    const { keys } = await go(undefined, (k) => void k.add(ADA_ID, { name: "Mine" }));
    const showing = (visibility: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
      window.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    };
    await act(async () => showing("hidden"));
    // A curl in a terminal: the key's first message opened its room.
    const mine = keys.keys.get(ADA_ID)?.[0];
    if (mine) Object.assign(mine, { roomId: ROOM_ID, lastUsedAt: new Date().toISOString() });
    await act(async () => showing("visible"));
    await settle(6);
    expect(keyList().textContent).not.toContain("Nunca usada");
    const menu = await openMenu(card().getByRole("button", { name: "Opções de Mine" }));
    expect(menu.getByRole("menuitem", { name: "Abrir conversa" })).toBeTruthy();
  });

  test("in a personal workspace the card is in Advanced, with the other hard parts (ADR 0159 §3)", async () => {
    const personal = () => {
      const state = seedState();
      const org = state.me?.organizations[0];
      if (org) org.mode = "personal";
      return state;
    };
    await go(personal());
    expect(screen().queryByRole("region", { name: "API do agente" })).toBeNull();
    cleanup();
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=advanced`, personal());
    expect(screen().getByRole("region", { name: "API do agente" })).toBeTruthy();
  });

  test("the agent's owner has the card; a member who doesn't manage it doesn't", async () => {
    await go(asOwner());
    expect(screen().getByRole("region", { name: "API do agente" })).toBeTruthy();
    cleanup();
    await go(asMember());
    expect(screen().queryByRole("region", { name: "API do agente" })).toBeNull();
  });
});

describe("a key's room at its channel's address", () => {
  test("opens as the agent's conversation, said to be the key's", async () => {
    const { state } = await open(`/org/${ORG_ID}/c/${ROOM_ID}`, seedState(), (keys) =>
      keys.rooms.set(ROOM_ID, { agentId: ADA_ID, keyId: "k1", keyName: "Deploy bot" }),
    );
    expect(document.body.textContent).not.toContain("Este canal não existe");
    expect(document.body.textContent).toContain("Conversa da chave de API Deploy bot");
    expect(document.querySelector(".channel__header .channel__name")?.textContent).toBe("Ada");
    // Its own channel, never the person's DM with the agent.
    expect(calls(state, "dms.open")).toEqual([]);
  });

  test("a channel that is no key of mine stays not found", async () => {
    const { state } = await open(`/org/${ORG_ID}/c/${ROOM_ID}`);
    expect(calls(state, "agentApiKeys.room")).toEqual([[ORG_ID, ROOM_ID]]);
    expect(document.body.textContent).toContain("Este canal não existe");
    expect(document.body.textContent).not.toContain("Conversa da chave");
  });
});
