import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, OutgoingWebhook, OutgoingWebhookDelivery } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Configurações › Conectores › Webhooks (ADR 0212), against a fake server: each webhook with its state, turning one
 * back on after its failures turned it off, a new one made from the form (its secret shown once, with Copy), Testar
 * and the deliveries' log, another secret and deleting after a question, the address the server refuses said under
 * its field, and a member who never gets the section.
 */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const AT = "2026-11-16T12:00:00.000Z";

function hook(patch: Partial<OutgoingWebhook> & Pick<OutgoingWebhook, "id" | "name">): OutgoingWebhook {
  return {
    url: "https://hooks.example.com/in",
    events: ["message.posted"],
    channelIds: [ENG_ID],
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: AT,
    lastFailureAt: null,
    createdAt: AT,
    ...patch,
  };
}

const CRM = hook({ id: "w-crm", name: "CRM de vendas" });
const LOG = hook({
  id: "w-log",
  name: "Log de auditoria",
  url: "https://logs.example.com/agentes",
  events: ["run.finished", "issue.created"],
  channelIds: [],
  enabled: false,
  disabledReason: "failures",
  consecutiveFailures: 10,
  lastSuccessAt: null,
  lastFailureAt: AT,
});

/** A fake server's webhooks: what each call asked, and its answers. */
function fakeWebhooks(start: OutgoingWebhook[], refuse?: { code: string }, failTest = false) {
  const hooks = start.map((w) => structuredClone(w));
  const deliveries: Record<string, OutgoingWebhookDelivery[]> = {};
  const calls: unknown[][] = [];
  let made = 0;
  const api: NonNullable<ApiClient["outgoingWebhooks"]> = {
    list: async () => {
      calls.push(["list"]);
      return structuredClone(hooks);
    },
    create: async (_orgId, input) => {
      calls.push(["create", input]);
      if (refuse) throw new ApiError(400, refuse.code, "English");
      made++;
      const w = hook({ id: `w-new-${made}`, ...input, lastSuccessAt: null });
      hooks.push(w);
      return { webhook: structuredClone(w), secret: `whsec_first_${made}` };
    },
    update: async (_orgId, id, patch) => {
      calls.push(["update", id, patch]);
      const w = hooks.find((x) => x.id === id) as OutgoingWebhook;
      const { enabled, ...fields } = patch;
      Object.assign(w, fields);
      if (enabled === true) Object.assign(w, { enabled: true, disabledReason: null, consecutiveFailures: 0 });
      if (enabled === false) Object.assign(w, { enabled: false, disabledReason: "manual" });
      return structuredClone(w);
    },
    remove: async (_orgId, id) => {
      calls.push(["remove", id]);
      hooks.splice(
        hooks.findIndex((x) => x.id === id),
        1,
      );
    },
    rotateSecret: async (_orgId, id) => {
      calls.push(["rotateSecret", id]);
      return { secret: "whsec_rotated" };
    },
    test: async (_orgId, id) => {
      calls.push(["test", id]);
      const list = deliveries[id] ?? [];
      deliveries[id] = list;
      list.unshift({
        id: `d-${list.length + 1}`,
        event: "ping",
        subjectId: id,
        status: failTest ? "failed" : "delivered",
        attempts: 1,
        responseStatus: failTest ? null : 200,
        error: failTest ? "address_refused" : null,
        createdAt: AT,
        finishedAt: AT,
      });
      // Its tenth failure in a row: the server turns it off as the delivery ends.
      if (failTest)
        Object.assign(hooks.find((x) => x.id === id) as OutgoingWebhook, {
          enabled: false,
          disabledReason: "failures",
          consecutiveFailures: 10,
        });
      return { deliveryId: list[0]?.id ?? "" };
    },
    deliveries: async (_orgId, id) => structuredClone(deliveries[id] ?? []),
  };
  return { api, calls, hooks };
}

async function openWebhooks(
  start = [CRM, LOG],
  options: { member?: boolean; refuse?: { code: string }; failTest?: boolean } = {},
) {
  const state = seedState();
  if (options.member && state.me?.organizations[0]) state.me.organizations[0].role = "member";
  const api = createFakeApi(state);
  const fake = fakeWebhooks(start, options.refuse, options.failTest);
  api.outgoingWebhooks = fake.api;
  const r = await renderApp(`/org/${ORG_ID}/settings/webhooks`, { api });
  await settle(6);
  const t = r.services.i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return { ...r, ...fake, t };
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".owh-card")];
const card = (name: string) => cards().find((c) => c.querySelector("h2")?.textContent === name) as HTMLElement;

describe("Configurações › Webhooks (ADR 0212)", () => {
  test("each webhook with its state; one its failures turned off says so and turns back on", async () => {
    const { t, calls } = await openWebhooks();
    expect(document.querySelector(".settings__body h2")?.textContent).toBe(t("settings.section.webhooks"));
    expect(cards().map((c) => c.querySelector("h2")?.textContent)).toEqual(["CRM de vendas", "Log de auditoria"]);

    const crm = card("CRM de vendas");
    expect(crm.textContent).toContain(t("webhooks.state.on"));
    expect(crm.textContent).toContain(
      `${t("webhooks.event.messagePosted")} ${t("webhooks.inChannels", { channels: "#eng" })}`,
    );
    expect(crm.textContent).toContain("https://hooks.example.com/in");

    const log = card("Log de auditoria");
    expect(log.textContent).toContain(t("webhooks.state.failures"));
    expect(within(log).getByRole("alert").textContent).toBe(t("webhooks.offByFailures", { count: 10 }));
    // Testar waits for it to be on.
    expect(
      within(log)
        .getByRole("button", { name: t("webhooks.test") })
        .hasAttribute("disabled"),
    ).toBe(true);
    await click(within(log).getByRole("button", { name: t("webhooks.turnOn") }));
    await settle(4);
    expect(calls).toContainEqual(["update", "w-log", { enabled: true }]);
    const on = card("Log de auditoria");
    expect(on.textContent).toContain(t("webhooks.state.on"));
    expect(within(on).queryByRole("alert")).toBeNull();
  });

  test("a new one from the form: what's missing first, then its secret shown once with Copy", async () => {
    const { t, calls } = await openWebhooks([]);
    await click(screen().getByRole("button", { name: t("webhooks.new") }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: t("webhooks.form.newTitle") });
    await type(within(dialog).getByLabelText(t("webhooks.form.name")), "Zapier");
    await type(within(dialog).getByLabelText(t("webhooks.form.url")), "http://hooks.zapier.example/catch");
    await click(within(dialog).getByRole("button", { name: t("webhooks.form.create") }));
    await settle(2);
    // An address without https, and messages with no channel: said under each, and nothing sent.
    expect(dialog.textContent).toContain(t("webhooks.form.urlHttps"));
    expect(dialog.textContent).toContain(t("errors.outgoingWebhook.noChannels"));
    expect(calls.filter((c) => c[0] === "create")).toEqual([]);

    await type(within(dialog).getByLabelText(t("webhooks.form.url")), "https://hooks.zapier.example/catch");
    await click(within(dialog).getByRole("checkbox", { name: t("webhooks.event.messagePosted") }));
    await click(within(dialog).getByRole("checkbox", { name: t("webhooks.event.issueCreated") }));
    await click(within(dialog).getByRole("button", { name: t("webhooks.form.create") }));
    await settle(4);
    expect(calls).toContainEqual([
      "create",
      { name: "Zapier", url: "https://hooks.zapier.example/catch", events: ["issue.created"], channelIds: [] },
    ]);
    expect(screen().queryByRole("dialog")).toBeNull();
    const made = card("Zapier");
    expect(made.textContent).toContain(t("webhooks.secretOnce"));
    expect(made.querySelector("code")?.textContent).toBe("whsec_first_1");
    expect(within(made).getByRole("button", { name: t("common.copy") })).toBeTruthy();
    // Never in the list the server sends back.
    expect(JSON.stringify(calls.filter((c) => c[0] === "list"))).not.toContain("whsec_");
  });

  test("an address the server refuses as internal is said under its field", async () => {
    const { t } = await openWebhooks([], { refuse: { code: "url.internal" } });
    await click(screen().getByRole("button", { name: t("webhooks.new") }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: t("webhooks.form.newTitle") });
    await type(within(dialog).getByLabelText(t("webhooks.form.name")), "Interno");
    await type(within(dialog).getByLabelText(t("webhooks.form.url")), "https://intranet.example/hook");
    await click(within(dialog).getByRole("checkbox", { name: t("webhooks.event.messagePosted") }));
    await click(within(dialog).getByRole("checkbox", { name: t("webhooks.event.runFinished") }));
    await click(within(dialog).getByRole("button", { name: t("webhooks.form.create") }));
    await settle(4);
    const url = within(dialog).getByLabelText(t("webhooks.form.url"));
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.textContent).toContain(t("webhooks.form.urlInternal"));
  });

  test("Testar shows the delivery in the log; another secret and Delete ask first", async () => {
    const { t, calls } = await openWebhooks([CRM]);
    const crm = card("CRM de vendas");
    await click(within(crm).getByRole("button", { name: t("webhooks.test") }));
    await settle(6);
    expect(calls).toContainEqual(["test", "w-crm"]);
    const log = within(card("CRM de vendas")).getByRole("list", { name: t("webhooks.deliveries") });
    expect(log.textContent).toContain(t("webhooks.delivery.delivered", { status: 200 }));
    expect(log.textContent).toContain(t("webhooks.event.ping"));

    await click(within(card("CRM de vendas")).getByRole("button", { name: t("webhooks.newSecret") }));
    const asked = within(card("CRM de vendas")).getByRole("alert");
    expect(asked.textContent).toContain(t("webhooks.newSecretBody"));
    expect(calls.filter((c) => c[0] === "rotateSecret")).toEqual([]);
    await click(within(asked).getByRole("button", { name: t("webhooks.newSecret") }));
    await settle(3);
    expect(card("CRM de vendas").querySelector(".owh-card__secret code")?.textContent).toBe("whsec_rotated");

    await click(within(card("CRM de vendas")).getByRole("button", { name: t("webhooks.delete") }));
    const sure = within(card("CRM de vendas")).getByRole("alert");
    expect(sure.textContent).toContain(t("webhooks.deleteBody", { name: "CRM de vendas" }));
    await click(within(sure).getByRole("button", { name: t("webhooks.delete") }));
    await settle(4);
    expect(calls).toContainEqual(["remove", "w-crm"]);
    expect(cards()).toEqual([]);
    expect(screen().getByText(t("webhooks.emptyTitle"))).toBeTruthy();
  });

  test("a test that is its tenth failure turns the card off, without reloading", async () => {
    const { t } = await openWebhooks([CRM], { failTest: true });
    await click(within(card("CRM de vendas")).getByRole("button", { name: t("webhooks.test") }));
    await settle(8);
    const crm = card("CRM de vendas");
    const log = within(crm).getByRole("list", { name: t("webhooks.deliveries") });
    expect(log.textContent).toContain(t("webhooks.delivery.addressRefused"));
    expect(crm.textContent).toContain(t("webhooks.state.failures"));
    expect(within(crm).getByRole("alert").textContent).toBe(t("webhooks.offByFailures", { count: 10 }));
  });

  test("a member never gets the section, and the server is never asked", async () => {
    const { calls } = await openWebhooks([CRM], { member: true });
    expect(cards()).toEqual([]);
    expect(calls).toEqual([]);
  });
});
