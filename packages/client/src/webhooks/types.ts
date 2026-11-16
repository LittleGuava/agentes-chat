/** A workspace's outgoing webhooks (ADR 0212), as `/api/app/organizations/{orgId}/outgoing-webhooks` answers. */

export const OUTGOING_WEBHOOK_EVENTS = ["message.posted", "run.finished", "issue.created"] as const;
export type OutgoingWebhookEvent = (typeof OUTGOING_WEBHOOK_EVENTS)[number];

export interface OutgoingWebhook {
  id: string;
  name: string;
  url: string;
  events: OutgoingWebhookEvent[];
  /** Required for `message.posted`; empty, the other events come from every channel. */
  channelIds: string[];
  enabled: boolean;
  /** `failures`: ten deliveries failed in a row turned it off; `manual`: an administrator did. Null while on. */
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
}

export interface OutgoingWebhookDelivery {
  id: string;
  /** One of the events, or `ping` (Testar). */
  event: string;
  subjectId: string;
  status: "pending" | "delivered" | "failed" | "skipped";
  attempts: number;
  responseStatus: number | null;
  /** `timeout`, `network`, `address_refused`, `http_<status>`, `webhook_off`, `gone`, `workspace_closed`. */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface OutgoingWebhookInput {
  name: string;
  url: string;
  events: OutgoingWebhookEvent[];
  channelIds: string[];
}

export type OutgoingWebhookPatch = Partial<OutgoingWebhookInput> & { enabled?: boolean };
