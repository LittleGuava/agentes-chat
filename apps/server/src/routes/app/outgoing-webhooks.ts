import {
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  listOutgoingWebhookDeliveries,
  listOutgoingWebhooks,
  OUTGOING_WEBHOOK_EVENTS,
  type OutgoingWebhookDeliveryView,
  type OutgoingWebhookView,
  rotateOutgoingWebhookSecret,
  testOutgoingWebhook,
  updateOutgoingWebhook,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  iso,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Outgoing webhooks"];

const Event = z.enum(OUTGOING_WEBHOOK_EVENTS);

const Webhook = z
  .object({
    id: z.uuid(),
    name: z.string(),
    url: z.string(),
    events: z.array(Event),
    channelIds: z.array(z.uuid()).openapi({
      description: "The channels it listens to: required for `message.posted`; empty, the other events from every one.",
    }),
    enabled: z.boolean(),
    disabledReason: z
      .string()
      .nullable()
      .openapi({ description: "`manual`, or `failures` (ten deliveries failed in a row). Null while on." }),
    consecutiveFailures: z.number().int(),
    lastSuccessAt: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("OutgoingWebhook");

const Delivery = z
  .object({
    id: z.uuid(),
    event: z.string(),
    subjectId: z.uuid().openapi({ description: "The message, run or task it is about." }),
    status: z.enum(["pending", "delivered", "failed", "skipped"]),
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    error: z.string().nullable().openapi({ description: "`timeout`, `network`, `address_refused`, `http_<status>`…" }),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("OutgoingWebhookDelivery");

const Fields = z.object({
  name: z.string().max(100),
  url: z.string().max(2000).openapi({ description: "An https address whose host resolves to public addresses only." }),
  events: z.array(Event).min(1).max(OUTGOING_WEBHOOK_EVENTS.length),
  channelIds: z.array(z.uuid()).max(50).optional(),
});

const Secret = z.object({ secret: z.string().openapi({ description: "Shown only now: it signs every delivery." }) });
const IdParams = OrgParams.extend({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });

const webhookView = (w: OutgoingWebhookView) => ({
  ...w,
  lastSuccessAt: iso(w.lastSuccessAt),
  lastFailureAt: iso(w.lastFailureAt),
  createdAt: w.createdAt.toISOString(),
});

const deliveryView = (d: OutgoingWebhookDeliveryView) => ({
  ...d,
  createdAt: d.createdAt.toISOString(),
  finishedAt: iso(d.finishedAt),
});

/** A workspace's outgoing webhooks (ADR 0212): administrators only. */
export function outgoingWebhookRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const hookDeps = {
    db: deps.db,
    keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
    resolveHost: deps.extras?.resolveHost,
  };
  const base = "/organizations/{orgId}/outgoing-webhooks";

  app.openapi(
    createRoute({
      method: "get",
      path: base,
      tags,
      security,
      summary: "The workspace's outgoing webhooks",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ webhooks: z.array(Webhook) })), ...errors },
    }),
    async (c) => {
      const list = await listOutgoingWebhooks(hookDeps, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ webhooks: list.map(webhookView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: base,
      tags,
      security,
      summary: "Create an outgoing webhook; its signing secret is shown once",
      request: { params: OrgParams, body: body(Fields) },
      responses: { 201: json(z.object({ webhook: Webhook, secret: z.string() }), "Created"), ...errors },
    }),
    async (c) => {
      const made = await createOutgoingWebhook(
        hookDeps,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json({ webhook: webhookView(made.webhook), secret: made.secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${base}/{id}`,
      tags,
      security,
      summary: "Change an outgoing webhook, or turn it on or off",
      description: "Turning it on again starts its failures from zero.",
      request: { params: IdParams, body: body(Fields.partial().extend({ enabled: z.boolean().optional() })) },
      responses: { 200: json(Webhook), ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      const updated = await updateOutgoingWebhook(hookDeps, c.get("user").id, orgId, id, c.req.valid("json"));
      return c.json(webhookView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: `${base}/{id}`,
      tags,
      security,
      summary: "Delete an outgoing webhook and its deliveries",
      request: { params: IdParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      await deleteOutgoingWebhook(hookDeps, c.get("user").id, orgId, id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/{id}/secret`,
      tags,
      security,
      summary: "A new signing secret, shown once; the old one stops at once",
      request: { params: IdParams },
      responses: { 200: json(Secret), ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      return c.json(await rotateOutgoingWebhookSecret(hookDeps, c.get("user").id, orgId, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/{id}/test`,
      tags,
      security,
      summary: "Send a `ping` delivery down the same path as an event's",
      request: { params: IdParams },
      responses: { 202: json(z.object({ deliveryId: z.uuid() }), "Queued"), ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      const queued = await testOutgoingWebhook(hookDeps, c.get("user").id, orgId, id);
      deps.wakeWorkers?.();
      return c.json(queued, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/{id}/deliveries`,
      tags,
      security,
      summary: "The webhook's latest deliveries, newest first",
      request: { params: IdParams },
      responses: { 200: json(z.object({ deliveries: z.array(Delivery) })), ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      const list = await listOutgoingWebhookDeliveries(hookDeps, c.get("user").id, orgId, id);
      return c.json({ deliveries: list.map(deliveryView) }, 200);
    },
  );
  return app;
}
