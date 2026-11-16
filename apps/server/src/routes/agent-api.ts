import {
  AGENT_API_LIMITS,
  type AgentApiDeps,
  type AgentKeyCaller,
  agentKeyCaller,
  agentKeyResult,
  authenticateAgentKey,
  sendWithAgentKey,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { requestLimitIp } from "../http/client-ip";
import { apiError, errorResponse } from "../http/errors";
import { type AppDeps, body, json } from "./app/context";

/**
 * An agent's own REST API (ADR 0210): `/api/agents/v1/{agent}/messages`, with a key made on the agent. Bearer only:
 * no cookie is read and no `Origin` checked, since a browser page holds no key.
 */

const LIMITS = {
  ip: { limit: 120, windowMs: 60_000 },
  keyMinute: { limit: 60, windowMs: 60_000 },
  keyDay: { limit: 2000, windowMs: 86_400_000 },
  sendMinute: { limit: 20, windowMs: 60_000 },
  sendDay: { limit: 500, windowMs: 86_400_000 },
};

const tags = ["Agent API"];
const security = [{ agentKey: [] }];

const AgentParam = z.object({
  agent: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "agent", in: "path" }, description: "The key's agent, by id or handle" }),
});
const Wait = z.coerce
  .number()
  .int()
  .min(0)
  .max(AGENT_API_LIMITS.waitSeconds)
  .optional()
  .openapi({ description: `Seconds to wait for the run, 0 to ${AGENT_API_LIMITS.waitSeconds} (default 30)` });

const Result = z
  .object({
    message_id: z.string(),
    status: z.enum(["done", "waiting_approval", "waiting_input", "failed", "canceled", "still_running", "no_run"]),
    reply: z
      .object({
        id: z.string(),
        text: z.string(),
        truncated: z.boolean(),
        attachments: z.array(z.object({ name: z.string(), url: z.string() })),
        url: z.string(),
      })
      .optional()
      .openapi({ description: "The agent's answer (`done`), or its question (`waiting_input`)" }),
    approval_url: z.string().optional().openapi({ description: "Where a person decides the approval it waits on" }),
    detail: z.string().optional(),
    error: z.string().optional(),
    poll_after_seconds: z.number().optional(),
    retry_after_seconds: z.number().optional().openapi({ description: "Too many waits open now: ask again later" }),
    conversation_url: z.string().openapi({ description: "The key's conversation in agentes.chat" }),
  })
  .openapi("AgentApiResult");

const failures = {
  400: errorResponse("Invalid request"),
  401: errorResponse("No key, an unknown, revoked or expired one, or one for another agent"),
  403: errorResponse("The key's maker can't use this agent now (the reason's code says why)"),
  429: errorResponse("Too many requests: `Retry-After` says when to try again"),
};

/** A finished state is 200; a run still at work is 202 (ask `GET …/messages/{messageId}` later). */
const statusOf = (r: { status: string }) => (r.status === "still_running" ? 202 : 200);

export function registerAgentApi(api: OpenAPIHono, deps: AppDeps) {
  api.openAPIRegistry.registerComponent("securitySchemes", "agentKey", { type: "http", scheme: "bearer" });
  const { rateLimiter } = deps.adapters;
  const engine: AgentApiDeps = {
    db: deps.db,
    pubsub: deps.adapters.pubsub,
    publicUrl: deps.config.PUBLIC_URL,
    judge: deps.extras?.context?.judge,
    talker: deps.extras?.talker,
    gifs: deps.adapters.gifs,
    wakeWorkers: deps.wakeWorkers,
  };

  /** A call refused before it reaches the agent: a 401 that names the scheme, or a 429 that says when to come back. */
  type Refusal = { status: 401 } | { status: 429; resetAt: Date };
  const refuse = (c: Context, r: Refusal) => {
    if (r.status === 429) {
      c.header("retry-after", String(Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000))));
      return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
    }
    c.header("www-authenticate", "Bearer");
    return apiError(c, 401, "agent_api.unauthorized", "A valid API key for this agent is required");
  };

  /** The address's limit, the key, the key's limits, then everything behind it: a caller, or why not. */
  async function gate(c: Context, agentRef: string, sending: boolean): Promise<AgentKeyCaller | Refusal> {
    const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
    const byIp = await rateLimiter.consume(`agent-api:ip:${ip}`, LIMITS.ip);
    if (!byIp.allowed) return { status: 429, resetAt: byIp.resetAt };
    const key = await authenticateAgentKey(deps.db, c.req.header("authorization"));
    if (!key) return { status: 401 };
    const rules = [
      ["m", LIMITS.keyMinute],
      ["d", LIMITS.keyDay],
      ...(sending
        ? ([
            ["sm", LIMITS.sendMinute],
            ["sd", LIMITS.sendDay],
          ] as const)
        : []),
    ] as const;
    for (const [suffix, rule] of rules) {
      const r = await rateLimiter.consume(`agent-api:${suffix}:${key.id}`, rule);
      if (!r.allowed) return { status: 429, resetAt: r.resetAt };
    }
    return (await agentKeyCaller(deps.db, key, agentRef)) ?? { status: 401 };
  }

  api.openapi(
    createRoute({
      method: "post",
      path: "/agents/v1/{agent}/messages",
      tags,
      security,
      summary: "Send a message to the key's agent",
      description: `Posted as the key's maker in the key's own conversation, marked as sent through the key. Waits up to \`wait_seconds\` (default 30, at most ${AGENT_API_LIMITS.waitSeconds}) for the agent: 200 with the result when its run reached a state to act on (\`done\` with the reply, \`waiting_approval\` or \`waiting_input\` for a person in agentes.chat, \`failed\`, \`canceled\`, \`no_run\`), 202 \`still_running\` otherwise. The same \`idempotency_key\` on the same key sends once. Limits per key: 60 requests a minute and 2,000 a day; sending, 20 a minute and 500 a day.`,
      request: {
        params: AgentParam,
        body: body(
          z.object({
            message: z.string().trim().min(1).max(AGENT_API_LIMITS.messageChars),
            wait_seconds: z.number().int().min(0).max(AGENT_API_LIMITS.waitSeconds).optional(),
            idempotency_key: z.string().min(1).max(100).optional(),
          }),
        ),
      },
      responses: { 200: json(Result), 202: json(Result, "Still running"), ...failures },
    }),
    async (c) => {
      const caller = await gate(c, c.req.valid("param").agent, true);
      if ("status" in caller) return refuse(c, caller);
      const input = c.req.valid("json");
      const result = await sendWithAgentKey(
        engine,
        caller,
        { message: input.message, waitSeconds: input.wait_seconds ?? 30, idempotencyKey: input.idempotency_key },
        c.req.raw.signal,
      );
      return c.json(result, statusOf(result));
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/agents/v1/{agent}/messages/{messageId}",
      tags,
      security,
      summary: "Where a message sent with this key stands",
      description:
        "The same result as sending, waiting up to `wait_seconds` (default 0) for the run. Only a message this key sent: anything else is 404.",
      request: {
        params: AgentParam.extend({ messageId: z.uuid() }),
        query: z.object({ wait_seconds: Wait }),
      },
      responses: {
        200: json(Result),
        202: json(Result, "Still running"),
        404: errorResponse("Not found"),
        ...failures,
      },
    }),
    async (c) => {
      const { agent, messageId } = c.req.valid("param");
      const caller = await gate(c, agent, false);
      if ("status" in caller) return refuse(c, caller);
      const result = await agentKeyResult(
        engine,
        caller,
        messageId,
        c.req.valid("query").wait_seconds ?? 0,
        c.req.raw.signal,
      );
      return c.json(result, statusOf(result));
    },
  );
}
