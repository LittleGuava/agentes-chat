import { expect, test } from "bun:test";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { noticeOn } from "../src/notice-prefs";
import { PUSH } from "../src/push/messages";
import { strings as ru } from "../src/push/messages/ru";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, pushStrings, renderPush } from "../src/push-messages";

const KINDS = [
  "approval",
  "agent_question",
  "mention",
  "dm",
  "agent_reply",
  "mission_stopped",
  "routine_failed",
  "run_failed",
  "agent_needs_ai",
  "routine_paused",
  "agent_unreached",
  "routine_stalled",
  "routine_waiting_plan",
  "plan_reset_unknown",
  "machine_connected",
  "computer_ready",
  "browser_handoff",
  "secret_request",
  "join_request",
  "device.join_request",
  "device.folder_request",
  "widget_alert",
  "widget_failed",
  "dashboard_proposal",
  "something_new",
];

test("every push kind in every language: words, within the phone's limits (ADR 0122)", () => {
  for (const locale of LOCALE_CODES)
    for (const kind of KINDS)
      for (const variant of [
        { actorName: "Ana", actorType: "user" as const, text: "olha", title: "Deploy", label: "geral" },
        { actorType: "agent" as const, highRisk: true, reminder: true, screen: "desktop", suggestedBy: "Bia" },
        // A personal workspace's words (ADR 0159), with no words of the agent's own to stand in for them.
        { actorName: "Ana", actorType: "user" as const, title: "Deploy", reason: "creator_left", personal: true },
        { actorType: "agent" as const, suggestedBy: "Bia", personal: true },
      ]) {
        const { title, body } = renderPush(locale, { kind, waiting: true, ...variant });
        expect({ locale, kind, title: title.length > 0 }).toEqual({ locale, kind, title: true });
        expect(`${title}${body}`).not.toMatch(/undefined|null|\{\{/);
        expect(title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
        expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
      }
});

test("a personal workspace's pushes speak of one person and their agents, never a team (ADR 0159)", () => {
  const push = (kind: string, more: object = {}) =>
    renderPush("en", { kind, waiting: true, actorName: "Ana", label: "Personal", personal: true, ...more });
  expect(push("join_request", { title: "Bia" }).title).toBe("Bia asks to join your workspace");
  expect(push("join_request", { title: "Bia", suggestedBy: "Caio" }).title).toBe("Caio suggested inviting Bia");
  expect(push("computer_ready").title).toBe("Your agents' computer is ready");
  expect(push("machine_connected").title).toBe("A new computer was connected");
  expect(push("widget_failed", { label: null, reason: "creator_left" }).body).toBe(
    "Whoever set it up is no longer in your workspace.",
  );
  // A reason a personal workspace reads as a team does: the team's words.
  expect(push("widget_failed", { label: null, reason: "timeout" }).body).toBe("The update took too long.");
  // Only the words change: a team's read as before.
  expect(push("join_request", { title: "Bia", personal: false }).title).toBe("Bia asks to join Personal");
  // Every language has them, so none falls back to English.
  const keys = Object.keys(PUSH.en).filter((k) => k.endsWith("Personal"));
  expect(keys.length).toBe(7);
  for (const locale of LOCALE_CODES)
    expect({ locale, missing: keys.filter((k) => !(k in PUSH[locale])) }).toEqual({ locale, missing: [] });
});

test("a language without a word says it in English", () => {
  PUSH.ru = {};
  try {
    expect(pushStrings("ru").questionBody).toBe(pushStrings("en").questionBody);
  } finally {
    PUSH.ru = ru;
  }
  expect(pushStrings("ru").questionBody).not.toBe(pushStrings("en").questionBody);
  expect(pushStrings("pt-BR").questionBody).not.toBe(pushStrings("en").questionBody);
});

test("a routine that failed on its automatic retry says it was tried again, in every language", () => {
  for (const locale of LOCALE_CODES) {
    const once = renderPush(locale, { kind: "routine_failed", waiting: false, title: "Relatório" });
    const again = renderPush(locale, { kind: "routine_failed", waiting: false, title: "Relatório", retried: true });
    expect([locale, again.title]).not.toEqual([locale, once.title]);
    expect(again.body).toBe(once.body);
    expect(again.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
  }
});

test("an agent someone couldn't reach for want of an AI: the agent leads, who called follows, as a reply pushes", () => {
  const push = (locale: "en" | "pt-BR") =>
    renderPush(locale, { kind: "agent_needs_ai", waiting: false, actorName: "Bia", actorType: "user", label: "Dev" });
  expect(push("en")).toEqual({
    title: "Dev has no AI connected",
    body: "Bia called and got no answer. Connect an AI so it can answer.",
  });
  expect(push("pt-BR")).toEqual({
    title: "Dev está sem IA conectada",
    body: "Bia chamou e ficou sem resposta. Conecte uma IA para responder.",
  });
  // It reaches devices as an agent's reply does, and stays in the inbox when the person turned those off.
  expect(noticeOn({}, "agent_needs_ai", false)).toBe(true);
  expect(noticeOn({ replies: false }, "agent_needs_ai", false)).toBe(false);
});
