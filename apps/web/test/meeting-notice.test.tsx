import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const MEETING_ID = "00000000-0000-4000-8000-0000000000e1";

function joinedLine() {
  return {
    id: "m-joined",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body: "Taking notes in a Google Meet meeting.",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      notice: {
        kind: "meeting_joined",
        text: "You are in the Google Meet meeting taking notes.",
        refs: { meetingId: MEETING_ID, platform: "google_meet", url: "https://meet.google.com/abc-defg-hij" },
      },
    },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

test("an agent in a meeting is a quiet line anyone here can make it leave from (ADR 0199)", async () => {
  const state = seedState();
  state.messages.push(joinedLine());
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  expect(screen().getByText("Atlas está anotando uma reunião")).toBeTruthy();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Sair da reunião" })));
  expect(state.calls.filter((c) => c.method === "chat.leaveMeeting").map((c) => c.args)).toEqual([
    [ORG_ID, MEETING_ID],
  ]);
});

test("a long agent name wraps beside the way out, never cut", async () => {
  const state = seedState();
  const long = "Assistente de Pesquisa e Documentação Técnica Avançada do Time de Plataforma";
  const atlas = state.agents.find((a) => a.id === ATLAS_ID);
  if (atlas) atlas.name = long;
  state.messages.push(joinedLine());
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  expect(screen().getByText(`${long} está anotando uma reunião`)).toBeTruthy();
  expect(screen().getByRole("button", { name: "Sair da reunião" })).toBeTruthy();
});

test("Leave on a meeting that already ended says so instead of failing quietly", async () => {
  const state = seedState();
  state.messages.push(joinedLine());
  const api = createFakeApi(state);
  api.chat.leaveMeeting = async () => {
    throw new ApiError(409, "meeting.ended", "The meeting already ended");
  };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(6);

  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Sair da reunião" })));
  await settle(2);
  expect(screen().getByText("Isso já foi respondido ou encerrado. Atualize para ver como ficou.")).toBeTruthy();
});
