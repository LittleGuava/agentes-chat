import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { ApiError, type AppNotification, createHttpApi, type OutgoingWebhookDelivery } from "../src/index";
import { errorText } from "../src/lib/errors";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";
import { deliveryResult, webhookState } from "../src/lib/outgoing-webhooks";
import { soundForNotification } from "../src/lib/sounds";

/** ADR 0212: what the apps say about a workspace's outgoing webhooks. */

const pt = i18next.createInstance();
void pt.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });

describe("a webhook's state", () => {
  test("on; off by its failures (to turn back on); off by hand", () => {
    expect(webhookState({ enabled: true, disabledReason: null })).toBe("on");
    expect(webhookState({ enabled: false, disabledReason: "failures" })).toBe("failures");
    expect(webhookState({ enabled: false, disabledReason: "manual" })).toBe("off");
  });
});

describe("a delivery's result", () => {
  const delivery = (d: Partial<OutgoingWebhookDelivery>): OutgoingWebhookDelivery => ({
    id: "d1",
    event: "message.posted",
    subjectId: "m1",
    status: "delivered",
    attempts: 1,
    responseStatus: 200,
    error: null,
    createdAt: "2026-11-16T12:00:00.000Z",
    finishedAt: "2026-11-16T12:00:01.000Z",
    ...d,
  });
  const said = (d: Partial<OutgoingWebhookDelivery>) => {
    const r = deliveryResult(delivery(d));
    return [r.tone, pt.t(r.key, r.values)];
  };

  test("each outcome in the person's words, the receiver's status where there is one", () => {
    expect(said({})).toEqual(["ok", "Entregue (200)"]);
    expect(said({ status: "pending", attempts: 0, responseStatus: null })).toEqual(["pending", "Enviando…"]);
    expect(said({ status: "pending", attempts: 2, responseStatus: 503, error: "http_503" })).toEqual([
      "pending",
      "Falhou 2 vezes (503). Tentando de novo",
    ]);
    expect(said({ status: "failed", responseStatus: 404, error: "http_404" })).toEqual([
      "failed",
      "Recusada pelo destino (404)",
    ]);
    expect(said({ status: "failed", responseStatus: 302, error: "http_302" })).toEqual([
      "failed",
      "O destino redirecionou (302). Redirecionamentos não são seguidos",
    ]);
    expect(said({ status: "failed", responseStatus: null, error: "timeout", attempts: 6 })[1]).toBe(
      "O destino não respondeu em 10 segundos",
    );
    expect(said({ status: "failed", responseStatus: null, error: "address_refused" })[1]).toBe(
      "Endereço recusado: ele aponta para uma rede interna",
    );
    expect(said({ status: "skipped", responseStatus: null, error: "gone" })).toEqual([
      "skipped",
      "Não enviada: o que ela contaria foi apagado",
    ]);
    // A code from a newer server still says something.
    expect(said({ status: "failed", responseStatus: null, error: "something_new" })[1]).toBe("Não entregue");
  });
});

describe("the notice when failures turn one off", () => {
  const notice = {
    kind: "webhook_disabled",
    source: { webhookId: "w1", label: "CRM" },
    latest: { title: "CRM", reason: "http_500" },
  } as AppNotification;

  test("says which webhook, and opens Configurações › Webhooks", () => {
    const key = workspaceHeadline(notice);
    expect(key).toBe("webhooks.notice.disabled");
    expect(pt.t(key ?? "", { name: "CRM" })).toBe("O webhook CRM foi desligado depois de 10 falhas seguidas");
    expect(openTarget(notice)).toEqual({ to: "/org/$orgId/settings/$section", params: { section: "webhooks" } });
  });

  test("arriving, it sounds as a failure, in the background too; once read, nothing", () => {
    const fresh = { ...notice, waiting: false, count: 1, readAt: null, doneAt: null };
    expect(soundForNotification(fresh, false)).toBe("error");
    expect(soundForNotification(fresh, true)).toBe("error");
    expect(soundForNotification({ ...fresh, readAt: "2026-11-16T12:00:00.000Z" }, false)).toBeNull();
  });
});

describe("the server's refusals", () => {
  test("each says what to fix", () => {
    const refusal = (code: string) => errorText(pt.t, new ApiError(400, code, "English"), "pt-BR");
    expect(refusal("outgoing_webhook.no_channels")).toBe("Escolha os canais cujas mensagens ele envia.");
    expect(refusal("outgoing_webhook.disabled")).toBe("Ligue o webhook antes de testar.");
    expect(refusal("outgoing_webhook.channel")).toBe(
      "Escolha só canais do workspace. Conversas diretas nunca são enviadas.",
    );
  });
});

describe("the API", () => {
  test("asks the server's addresses and hands back what each answers", async () => {
    const asked: string[] = [];
    const api = createHttpApi({
      fetch: async (input, init) => {
        asked.push(`${init?.method ?? "GET"} ${String(input)}`);
        const body = String(input).endsWith("/deliveries")
          ? { deliveries: [{ id: "d1" }] }
          : String(input).endsWith("/secret")
            ? { secret: "whsec_new" }
            : { webhooks: [{ id: "w1" }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const hooks = api.outgoingWebhooks;
    expect(await hooks?.list("o1")).toEqual([{ id: "w1" } as never]);
    expect(await hooks?.deliveries("o1", "w1")).toEqual([{ id: "d1" } as never]);
    expect(await hooks?.rotateSecret("o1", "w1")).toEqual({ secret: "whsec_new" });
    expect(asked).toEqual([
      "GET /api/app/organizations/o1/outgoing-webhooks",
      "GET /api/app/organizations/o1/outgoing-webhooks/w1/deliveries",
      "POST /api/app/organizations/o1/outgoing-webhooks/w1/secret",
    ]);
  });
});
