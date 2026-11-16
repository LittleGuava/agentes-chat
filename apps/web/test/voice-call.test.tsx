import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { fakeMicrophone } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A voice call with an agent (ADR 0198): the phone in its DM, a take sent as a voice message, the reply read aloud. */

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
});

async function open(available = true) {
  const state = seedState({ media: { voiceAvailable: true, voiceCallAvailable: available } });
  const dm = seedDm(state, { type: "agent", id: ATLAS_ID });
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: dm, event: { channelId: dm, ...event } }));
  return { state, dm, ev };
}

const bar = () => document.querySelector(".voice-call") as HTMLElement | null;

test("no text-to-speech on the server, no phone", async () => {
  restore = fakeMicrophone();
  await open(false);
  expect(screen().queryByRole("button", { name: "Ligar para Atlas" })).toBeNull();
});

test("a call listens, sends the take as a voice message, waits for Atlas, reads its reply, and hangs up", async () => {
  restore = fakeMicrophone();
  const { state, dm, ev } = await open();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ligar para Atlas" })));
  await settle(2);
  expect(bar()?.textContent).toContain("Ouvindo…");

  // The fake microphone hears a voice: once enough of it, "Pronto" ends the turn.
  const done = () => screen().getByRole("button", { name: "Pronto" }) as HTMLButtonElement;
  expect(done().disabled).toBe(true);
  for (let i = 0; i < 50 && done().disabled; i++) await act(() => Bun.sleep(50));
  expect(done().disabled).toBe(false);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Pronto" })));
  await settle(4);
  const sent = state.calls.find((c) => c.method === "voice.send");
  expect(sent?.args[0]).toBe(dm);
  const clientId = sent?.args[1] as string;
  expect(bar()?.textContent).toContain("Enviando…");

  // The server posts the take's words, and Atlas starts on it.
  const run = { threadId: null, runId: "r-call", agentId: ATLAS_ID };
  await ev({
    type: "message.created",
    messageId: "m-take",
    message: {
      id: "m-take",
      channelId: dm,
      threadId: null,
      author: { type: "person", id: state.me?.user.id },
      body: "Como está o deploy?",
      mentionedAgentIds: [],
      agentRunId: null,
      clientId,
      meta: { voice: { clipId: `clip-${clientId}`, durationMs: 1200, peaks: [] } },
      createdAt: new Date().toISOString(),
    },
  });
  await ev({ type: "agent.run", ...run, status: "running" });
  await settle(2);
  expect(bar()?.textContent).toContain("Atlas está pensando…");

  await ev({
    type: "message.created",
    messageId: "m-reply",
    message: {
      id: "m-reply",
      channelId: dm,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "O deploy terminou bem.",
      mentionedAgentIds: [],
      agentRunId: "r-call",
      createdAt: new Date().toISOString(),
    },
  });
  await ev({ type: "agent.run", ...run, status: "done" });
  await settle(4);
  expect(state.calls.filter((c) => c.method === "voice.speech").map((c) => c.args[0])).toEqual(["m-reply"]);

  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Encerrar" })));
  await settle(2);
  expect(bar()).toBeNull();
  expect(screen().getByRole("button", { name: "Ligar para Atlas" })).toBeTruthy();
});
