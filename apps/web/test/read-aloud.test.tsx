import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setReadAloudAuto, stopReadAloud } from "@/lib/read-aloud";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Agents' replies read aloud on the web (ADR 0209): "Ouvir" on an agent's bar, only where the server reads aloud. */

afterEach(() => {
  stopReadAloud();
  setReadAloudAuto(false);
  cleanup();
});

describe("Ouvir", () => {
  test("an agent's reply has it when the server reads aloud, and it asks for that reply's audio", async () => {
    const state = seedState({ readAloudAvailable: true });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bars = screen().getAllByRole("toolbar", { name: "Ações da mensagem de Ada" });
    const listen = within(bars[0] as HTMLElement).getByRole("button", { name: "Ouvir" });
    await act(async () => fireEvent.click(listen));
    await settle(4);
    const asked = state.calls.filter((c) => c.method === "readAloud.make").map((c) => c.args[0]);
    expect(asked).toEqual(["m-2"]);
    // A person's message never has it.
    const person = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(within(person).queryByRole("button", { name: "Ouvir" })).toBeNull();
  });

  test("audio that won't play says so, and the next press asks for it again", async () => {
    const real = globalThis.Audio;
    // An audio file the server no longer has: the element fails after it starts.
    globalThis.Audio = class extends EventTarget {
      play() {
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
        return Promise.resolve();
      }
      pause() {}
    } as unknown as typeof Audio;
    try {
      const state = seedState({ readAloudAvailable: true });
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
      await settle(8);
      const bar = screen().getAllByRole("toolbar", { name: "Ações da mensagem de Ada" })[0] as HTMLElement;
      await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Ouvir" })));
      await settle(4);
      expect(screen().getByText("Não deu para ler em voz alta agora.")).toBeTruthy();
      await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Ouvir" })));
      await settle(4);
      expect(state.calls.filter((c) => c.method === "readAloud.make")).toHaveLength(2);
    } finally {
      globalThis.Audio = real;
    }
  });

  test("off on the server: no button, nothing asked", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bars = screen().getAllByRole("toolbar", { name: "Ações da mensagem de Ada" });
    for (const bar of bars) expect(within(bar).queryByRole("button", { name: "Ouvir" })).toBeNull();
    expect(state.calls.some((c) => c.method === "readAloud.make")).toBe(false);
  });
});

describe("reading new replies by themselves", () => {
  const open = async (available: boolean) => {
    const state = seedState({ readAloudAvailable: available });
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const arrive = (id: string, author: { type: "agent" | "person"; id: string }) =>
      act(async () =>
        socket.push({
          type: "event",
          channelId: ENG_ID,
          event: {
            channelId: ENG_ID,
            type: "message.created",
            messageId: id,
            message: {
              id,
              channelId: ENG_ID,
              threadId: null,
              author,
              body: "Os 401 no Sentry caíram de 312 para 4.",
              mentionedAgentIds: [],
              agentRunId: author.type === "agent" ? "r-9" : null,
              createdAt: new Date().toISOString(),
            },
          },
        }),
      );
    const asked = () => state.calls.filter((c) => c.method === "readAloud.make").map((c) => c.args[0]);
    return { arrive, asked };
  };

  test("with the device's switch on, an agent's reply that arrives is read, a person's isn't", async () => {
    setReadAloudAuto(true);
    const { arrive, asked } = await open(true);
    await arrive("m-person", { type: "person", id: "u-walter" });
    await arrive("m-final", { type: "agent", id: ATLAS_ID });
    await settle(4);
    expect(asked()).toEqual(["m-final"]);
  });

  test("with the switch off, or the server not reading aloud, nothing is read", async () => {
    const off = await open(true);
    await off.arrive("m-final", { type: "agent", id: ATLAS_ID });
    await settle(4);
    expect(off.asked()).toEqual([]);
    cleanup();
    setReadAloudAuto(true);
    const unavailable = await open(false);
    await unavailable.arrive("m-final-2", { type: "agent", id: ATLAS_ID });
    await settle(4);
    expect(unavailable.asked()).toEqual([]);
  });
});
