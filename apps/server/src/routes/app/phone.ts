import {
  answerPhoneJob,
  listPhoneJobs,
  myPhoneTools,
  PHONE_CONTACT_VALUES_MAX,
  PHONE_CONTACTS_MAX,
  PHONE_JOB_KINDS,
  PHONE_TOOLS,
  setPhoneTools,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { apiError } from "../../http/errors";
import {
  APP_CLIENT_HEADER,
  type AppDeps,
  type AppEnv,
  body,
  createAppRouter,
  errors,
  json,
  MOBILE_CLIENT,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Phone"];

const PhoneTools = z.object({
  tools: z.array(z.enum(PHONE_TOOLS)),
  deviceName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const Contact = z.object({
  name: z.string().trim().min(1).max(200),
  phones: z.array(z.string().trim().min(1).max(40)).max(PHONE_CONTACT_VALUES_MAX),
  emails: z.array(z.string().trim().min(1).max(254)).max(PHONE_CONTACT_VALUES_MAX),
});

/** The phone's answer to one job: what the phone found, the person's no, or why it couldn't. */
const Answer = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("done"), contacts: z.array(Contact).max(PHONE_CONTACTS_MAX) }),
  z.object({ outcome: z.literal("declined") }),
  z.object({ outcome: z.literal("failed"), error: z.string().trim().min(1).max(300) }),
]);

const Job = z.object({
  id: z.uuid(),
  kind: z.enum(PHONE_JOB_KINDS),
  input: z.object({ query: z.string() }),
  agent: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.string(),
  expiresAt: z.string(),
});

/** What a person turns on and answers here comes from their phone: the web and desktop apps neither offer nor answer it. */
const phoneAppOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header(APP_CLIENT_HEADER) !== MOBILE_CLIENT) {
    return apiError(c, 403, "phone.app_only", "Only the agentes.chat phone app does this");
  }
  await next();
};

/**
 * The phone's own apps as the agents' tools (ADR 0205): the person's switches, sent by the phone app, and the jobs its
 * agents' runs send to it, listed and answered by the phone app. Each person reaches only their own.
 */
export function phoneRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/phone/*", phoneAppOnly);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/phone/tools",
      tags,
      security,
      summary: "What this person lets their agents use on their phone here",
      request: { params: OrgParams },
      responses: { 200: json(PhoneTools), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await myPhoneTools(db, orgId, c.get("user").id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/phone/tools",
      tags,
      security,
      summary: "Turn the phone's apps on or off for this person's agents here",
      description:
        "Sent by the phone app only, with the phone's name. An empty list turns them all off. Only runs this person is behind, in their own conversation with an agent, reach the phone.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            tools: z.array(z.enum(PHONE_TOOLS)).max(PHONE_TOOLS.length),
            deviceName: z.string().trim().min(1).max(100),
          }),
        ),
      },
      responses: { 200: json(PhoneTools), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(await setPhoneTools(db, { orgId, userId: c.get("user").id, ...input }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/phone/jobs",
      tags,
      security,
      summary: "The requests from this person's agents their phone has to answer now",
      description:
        "Oldest first. The app lists them again on each `phone.job` event on the person's realtime topic, and when it opens.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ jobs: z.array(Job) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ jobs: await listPhoneJobs(db, orgId, c.get("user").id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/phone/jobs/{jobId}",
      tags,
      security,
      summary: "The phone answers one request",
      description: `The first answer wins: one already answered or out of time is a 409 \`phone.job_closed\`. At most ${PHONE_CONTACTS_MAX} contacts, each with at most ${PHONE_CONTACT_VALUES_MAX} numbers and addresses.`,
      request: { params: OrgParams.extend({ jobId: z.uuid() }), body: body(Answer) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, jobId } = c.req.valid("param");
      await answerPhoneJob({ db, pubsub }, { orgId, userId: c.get("user").id, jobId, answer: c.req.valid("json") });
      return c.body(null, 204);
    },
  );

  return app;
}
