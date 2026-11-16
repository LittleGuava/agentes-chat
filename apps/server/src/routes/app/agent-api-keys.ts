import {
  AGENT_API_LIMITS,
  AGENT_KEY_EXPIRY_DAYS,
  agentKeyRoom,
  appsUrls,
  createAgentApiKey,
  listAgentApiKeys,
  revokeAgentApiKey,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { signedInLately } from "../../auth";
import { apiError } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Agent API"];

const Key = z
  .object({
    id: z.string(),
    name: z.string(),
    lastFour: z.string().openapi({ description: "The secret's last four characters" }),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    createdBy: z.object({ id: z.string(), name: z.string() }),
    roomId: z.uuid().nullable().openapi({
      description:
        "The key's conversation, for its maker once a message was sent with it (the channel id); null otherwise",
    }),
  })
  .openapi("AgentApiKey");

const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/** An agent's API keys (ADR 0210): listed, created and revoked by its owner or anyone with `manage_agents`. */
export function agentApiKeyRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/:orgId/agents/:agentId/api-keys", requireSession(deps.auth));
  app.use("/organizations/:orgId/agents/:agentId/api-keys/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/agent-key-rooms/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/api-keys",
      tags,
      security,
      summary: "The agent's live API keys",
      description: "Never their secrets. Its owner or anyone with `manage_agents`.",
      request: { params: AgentParams },
      responses: {
        200: json(
          z.object({
            keys: z.array(Key),
            endpoint: z.string().openapi({ description: "Where a key sends this agent messages, on this server" }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const keys = await listAgentApiKeys(db, c.get("user").id, orgId, agentId);
      // By the agent's id, not its handle: a rename doesn't break a script that pasted it.
      const endpoint = `${appsUrls(deps.config.PUBLIC_URL).issuer}/api/agents/v1/${agentId}/messages`;
      return c.json({ keys, endpoint }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-key-rooms/{channelId}",
      tags,
      security,
      summary: "Whose API key a conversation belongs to",
      description:
        "A key's conversation is a DM outside the DM list: the apps ask this to open it as that key's. Only for the key's maker (404 for anyone else and for any other conversation); `keyName` is null once the key is gone.",
      request: { params: OrgParams.extend({ channelId: z.uuid() }) },
      responses: {
        200: json(z.object({ agentId: z.string(), keyId: z.string(), keyName: z.string().nullable() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json(await agentKeyRoom(db, c.get("user").id, orgId, channelId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/api-keys",
      tags,
      security,
      summary: "Create an API key for the agent",
      description: `\`Authorization: Bearer agk_…\` on \`/api/agents/v1/{agent}/messages\`. \`secret\` is returned here once. Messages sent with it are posted as you, in a conversation of the key's own, with your access through this agent. At most ${AGENT_API_LIMITS.keysPerAgent} live per agent (409 \`agent_api.key_limit\`). One with no expiry (\`expiresInDays: null\`) needs a sign-in in the last 10 minutes (403 \`reauth.sign_in\`).`,
      request: {
        params: AgentParams,
        body: body(
          z.object({
            name: z.string().trim().min(1).max(AGENT_API_LIMITS.nameChars),
            expiresInDays: z
              .union([
                z.literal(AGENT_KEY_EXPIRY_DAYS[0]),
                z.literal(AGENT_KEY_EXPIRY_DAYS[1]),
                z.literal(AGENT_KEY_EXPIRY_DAYS[2]),
              ])
              .nullable(),
          }),
        ),
      },
      responses: { 201: json(z.object({ key: Key, secret: z.string() }), "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const input = c.req.valid("json");
      if (input.expiresInDays === null && !(await signedInLately(deps.auth, c.req.raw.headers, c.get("user").id)))
        return apiError(c, 403, "reauth.sign_in", "Sign in again to create a key with no expiry");
      return c.json(await createAgentApiKey(db, c.get("user").id, orgId, agentId, input), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}/api-keys/{keyId}",
      tags,
      security,
      summary: "Revoke an API key",
      description: "It stops working now. Its maker, or anyone who manages the agent.",
      request: { params: AgentParams.extend({ keyId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, agentId, keyId } = c.req.valid("param");
      await revokeAgentApiKey(db, c.get("user").id, orgId, agentId, keyId);
      return c.body(null, 204);
    },
  );

  return app;
}
