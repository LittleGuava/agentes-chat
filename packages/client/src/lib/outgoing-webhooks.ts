import type { OutgoingWebhook, OutgoingWebhookDelivery } from "../webhooks/types";

/** What the apps say about a workspace's outgoing webhooks (ADR 0188). */

/** On; off by its failures (an administrator turns it back on); off by hand. */
export type WebhookState = "on" | "failures" | "off";

export const webhookState = (w: Pick<OutgoingWebhook, "enabled" | "disabledReason">): WebhookState =>
  w.enabled ? "on" : w.disabledReason === "failures" ? "failures" : "off";

/** The kinds of a delivery's result, for its mark in the log. */
export type DeliveryTone = "ok" | "pending" | "failed" | "skipped";

const ERROR_KEYS = {
  timeout: "webhooks.delivery.timeout",
  network: "webhooks.delivery.network",
  address_refused: "webhooks.delivery.addressRefused",
  webhook_off: "webhooks.delivery.webhookOff",
  gone: "webhooks.delivery.gone",
  workspace_closed: "webhooks.delivery.workspaceClosed",
} as const;

type DeliveryKey =
  | (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS]
  | "webhooks.delivery.delivered"
  | "webhooks.delivery.sending"
  | "webhooks.delivery.retrying"
  | "webhooks.delivery.retryingStatus"
  | "webhooks.delivery.refused"
  | "webhooks.delivery.redirect"
  | "webhooks.delivery.failed";

/** A delivery's result as the log says it: its tone, and its words' key with their values. */
export function deliveryResult(d: OutgoingWebhookDelivery): {
  tone: DeliveryTone;
  key: DeliveryKey;
  values?: Record<string, unknown>;
} {
  const status = d.responseStatus;
  if (d.status === "delivered") return { tone: "ok", key: "webhooks.delivery.delivered", values: { status } };
  if (d.status === "pending")
    return d.attempts === 0
      ? { tone: "pending", key: "webhooks.delivery.sending" }
      : status === null
        ? { tone: "pending", key: "webhooks.delivery.retrying", values: { count: d.attempts } }
        : { tone: "pending", key: "webhooks.delivery.retryingStatus", values: { count: d.attempts, status } };
  const tone = d.status === "skipped" ? "skipped" : "failed";
  const http = /^http_(\d{3})$/.exec(d.error ?? "");
  if (http) {
    const code = Number(http[1]);
    return {
      tone,
      key: code >= 300 && code < 400 ? "webhooks.delivery.redirect" : "webhooks.delivery.refused",
      values: { status: code },
    };
  }
  const known = d.error && Object.hasOwn(ERROR_KEYS, d.error) ? ERROR_KEYS[d.error as keyof typeof ERROR_KEYS] : null;
  return { tone, key: known ?? "webhooks.delivery.failed" };
}

const EVENT_KEYS = {
  "message.posted": "webhooks.event.messagePosted",
  "run.finished": "webhooks.event.runFinished",
  "issue.created": "webhooks.event.issueCreated",
  ping: "webhooks.event.ping",
} as const;

/** An event's name in the person's words (`ping` is Testar's); one from a newer server, by its own name. */
export const eventWordKey = (event: string) =>
  Object.hasOwn(EVENT_KEYS, event) ? EVENT_KEYS[event as keyof typeof EVENT_KEYS] : null;
