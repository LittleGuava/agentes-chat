import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** A message `minutes` before now: a person's, or Ada's reply in run `r1`. */
const said = (id: string, body: string, minutes: number, over: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...over,
  }) as Message;
const answer = (id: string, runId: string, minutes: number) =>
  said(id, "Passou, todos verdes.", minutes, { author: { type: "agent", id: ADA_ID }, agentRunId: runId });
const handled = (runId: string) => [{ agentId: ADA_ID, runId, status: "done" as const }];
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

/** Jev picked Ada for a message nobody mentioned; the person called Ada by name for the next one. */
const conversation = () => [
  said("p1", "O build passou?", 10, {
    receipts: { seenBy: [ADA_ID], pickedBy: [ADA_ID], handled: handled("r1"), decidedBy: { step: "jev" } },
  }),
  answer("m1", "r1", 9),
  said("p2", "@ada e o deploy?", 8, {
    mentionedAgentIds: [ADA_ID],
    receipts: { seenBy: [ADA_ID], pickedBy: [ADA_ID], handled: handled("r2") },
  }),
  answer("m2", "r2", 7),
];

const openChannel = async (routerCaption?: boolean) => {
  const state = seedState(routerCaption === undefined ? {} : { routerCaption });
  state.messages = conversation();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
};

describe("who picked the agent, under its reply (ADR 0074 addendum 2026-11-16)", () => {
  test("off by default: no reply says who picked its agent", async () => {
    await openChannel();
    expect(row("m1").textContent).not.toContain("Escolhido pelo Jev");
    expect(document.body.textContent).not.toContain("Escolhido pelo");
  });

  test("with the workspace's switch on: the reply Jev picked says so, quietly, and a reply to a mention says nothing", async () => {
    await openChannel(true);
    const line = within(row("m1")).getByText("Escolhido pelo Jev");
    expect(line.closest(".msg-picked")).not.toBeNull();
    // What it means, behind its ⓘ.
    expect(within(row("m1")).getByRole("button", { name: "Sobre Escolhido pelo Jev" })).toBeTruthy();
    expect(row("m2").textContent).not.toContain("Escolhido pelo");
    // The person's own message keeps its receipt as it was: no AI named there.
    expect(row("p1").textContent).not.toContain("Escolhido pelo");
  });
});

const routed = (by: NonNullable<AiStatus["routing"]>["by"]): AiStatus => ({
  any: true,
  agents: [],
  routing: {
    by,
    mine: by === "plans" ? "plan" : by,
    model: by === "model" ? "claude-haiku-5-5" : null,
    noSmallModel: null,
  },
  apiKey: true,
});
const settingsPage = async (patch: Partial<ReturnType<typeof seedState>>) => {
  const state = seedState(patch);
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return state;
};
const section = () => screen().getByRole("region", { name: "Quem escolhe os agentes" });
const SWITCH = { name: "Mostrar quem escolheu o agente" };
const toggle = () => within(section()).getByRole("switch", SWITCH);

describe("the switch, in Configurações › IA e uso", () => {
  test("off until an admin turns it on, saved as the workspace's", async () => {
    const state = await settingsPage({ aiStatus: routed("model") });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(toggle()));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.updateSettings").map((c) => c.args[1])).toEqual([
      { routerCaption: true },
    ]);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  test("the plans picking offer it too, and its words never name Jev", async () => {
    await settingsPage({ aiStatus: routed("plans") });
    expect(toggle()).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/jev|typesafe/i);
  });

  test("while Jev picks, only the server's owner, who has Jev's card, gets it: the Cloud names Jev nowhere else", async () => {
    await settingsPage({ aiStatus: routed("jev") });
    expect(within(section()).queryByRole("switch", SWITCH)).toBeNull();
    cleanup();
    const ON = { source: "settings" as const, hint: "9f2c", state: "ok" as const, month: { decisions: 1, costUsd: 0 } };
    await settingsPage({ aiStatus: routed("jev"), jev: ON });
    expect(toggle()).toBeTruthy();
  });

  test("with only rules or mentions there is no AI to name, so no switch", async () => {
    for (const by of ["rules", "off"] as const) {
      await settingsPage({ aiStatus: routed(by) });
      expect(within(section()).queryByRole("switch", SWITCH)).toBeNull();
      cleanup();
    }
  });

  test("once on, it stays in sight whoever picks, so an admin can always turn the line off", async () => {
    for (const by of ["jev", "rules"] as const) {
      const state = await settingsPage({ aiStatus: routed(by), routerCaption: true });
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      await act(async () => fireEvent.click(toggle()));
      await settle(4);
      expect(state.calls.filter((c) => c.method === "orgs.updateSettings").map((c) => c.args[1])).toEqual([
        { routerCaption: false },
      ]);
      cleanup();
    }
  });
});
