import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { FIRST_REPLY_RESCUE_MS } from "@agenteschat/client/lib/first-reply";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, meWithRole, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
});

type State = ReturnType<typeof seedState>;

/** The rescue's line under Atlas's live block, if it shows. */
const rescue = () =>
  [...document.querySelectorAll(".run-status .run-quiet")].find((p) =>
    p.textContent?.startsWith("A IA ainda não respondeu"),
  ) as HTMLElement | undefined;
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ });

/**
 * #eng open, with its socket. `ask` sends a message from the composer as a person does; `ev` delivers what the server
 * publishes for Atlas's run, as the engine sends it (no message id on `agent.run`: the app ties the run to the message
 * it guessed on send); `later` moves the clock and lets the screen look again (as a tab coming back does).
 */
async function engWithAtlas(setup?: (state: State) => void, dm = false) {
  const state = seedState();
  setup?.(state);
  // Atlas's DM, or #eng.
  const channelId = dm ? seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 5, body: "Oi!" }) : ENG_ID;
  const path = dm ? `dm/agent/${ATLAS_ID}` : `c/${ENG_ID}`;
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const push = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId, event: { channelId, ...event } }));
  const run = { threadId: null, runId: "r-atlas", agentId: ATLAS_ID };
  const ev = (event: Record<string, unknown>) => push({ ...run, ...event });
  const ask = async (text: string) => {
    await act(async () => fireEvent.change(composer(), { target: { value: text } }));
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(4);
  };
  const start = Date.now();
  const later = async (ms: number) => {
    setSystemTime(new Date(start + ms));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(3);
  };
  /** The engine's claim: "thinking", then `running`. */
  const claimed = async () => {
    await ev({ type: "agent.thinking" });
    await ev({ type: "agent.run", status: "running" });
    await settle(2);
  };
  return { state, push, ev, ask, later, claimed, router: r.router };
}

describe("'Trocar IA' when the first reply doesn't come", () => {
  test("the person who asked sees it once the AI has been silent long enough, and it goes when the AI answers", async () => {
    const { ev, ask, later, claimed } = await engWithAtlas();
    await ask("@atlas olha o deploy");
    await claimed();
    await later(FIRST_REPLY_RESCUE_MS - 5000);
    expect(rescue()).toBeUndefined();
    await later(FIRST_REPLY_RESCUE_MS + 1000);
    const line = rescue();
    expect(line?.textContent).toBe("A IA ainda não respondeu · Trocar IA");
    // An admin: "Trocar IA" opens "Quem pensa" on its screen for switching.
    const href = line?.querySelector("a")?.getAttribute("href") ?? "";
    expect(href).toContain(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    expect(href).toContain("sec=brain");
    expect(href).toContain("brain=switch");

    await ev({ type: "agent.tool", tool: "drive_read", toolUseId: "t1" });
    await settle(3);
    expect(rescue()).toBeUndefined();
  });

  test("in a DM too: the message it answers is the one this device sent there", async () => {
    const { ev, ask, later, claimed } = await engWithAtlas(undefined, true);
    await ask("olha o deploy");
    await claimed();
    await later(FIRST_REPLY_RESCUE_MS + 1000);
    expect(rescue()?.textContent).toBe("A IA ainda não respondeu · Trocar IA");
    await ev({ type: "agent.typing" });
    await settle(3);
    expect(rescue()).toBeUndefined();
  });

  test("in a thread too, in its panel", async () => {
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}?thread=m-1`, { api: createFakeApi(state) });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const panel = () => screen().getByRole("complementary", { name: "Thread" });
    const box = within(panel()).getByRole("combobox", { name: "Responder na thread" });
    await act(async () => fireEvent.change(box, { target: { value: "@atlas e o refresh?" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    const run = { channelId: ENG_ID, threadId: "m-1", runId: "r-thread", agentId: ATLAS_ID };
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { ...run, ...event } }));
    await ev({ type: "agent.thinking" });
    await ev({ type: "agent.run", status: "running" });
    await settle(2);
    setSystemTime(new Date(Date.now() + FIRST_REPLY_RESCUE_MS + 1000));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(3);
    const line = [...panel().querySelectorAll(".run-status .run-quiet")].find((p) =>
      p.textContent?.startsWith("A IA ainda não respondeu"),
    );
    expect(line?.textContent).toBe("A IA ainda não respondeu · Trocar IA");
  });

  test("someone who may not change Atlas's AI is offered its status, which opens its page", async () => {
    const { ask, later, claimed, router } = await engWithAtlas((state) => {
      meWithRole(state, []);
      const atlas = state.agents.find((a) => a.id === ATLAS_ID);
      if (atlas) atlas.ownerUserId = "u-joao";
    });
    await ask("@atlas olha o deploy");
    await claimed();
    await later(FIRST_REPLY_RESCUE_MS + 1000);
    const line = rescue();
    expect(line?.textContent).toBe("A IA ainda não respondeu · Ver status");
    const link = line?.querySelector("a");
    expect(link?.getAttribute("href")).not.toContain("brain=");
    await act(async () => {
      if (link) fireEvent.click(link);
    });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
  });

  test("nobody but the person who asked sees it", async () => {
    const { push, later, claimed } = await engWithAtlas();
    // João asks Atlas: the message reaches this screen through the socket, and Atlas's run answers it.
    const asked = {
      id: "m-joao",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "@atlas olha o deploy",
      mentionedAgentIds: [ATLAS_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    };
    await push({ type: "message.created", messageId: asked.id, message: asked });
    await claimed();
    await later(FIRST_REPLY_RESCUE_MS * 2);
    expect(rescue()).toBeUndefined();
  });
});
