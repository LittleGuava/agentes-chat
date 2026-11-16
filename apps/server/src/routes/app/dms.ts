import {
  DM_SHARE_LIMITS,
  dmReads,
  listDms,
  markChannelRead,
  openDm,
  setChannelMuted,
  shareDm,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
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
import { MediaKind, Message, PreviewMeta } from "./schemas";

const tags = ["Chat"];

const Dm = z
  .object({
    channelId: z.uuid().openapi({ description: "Use the channel message endpoints and WebSocket with this id." }),
    with: z.object({
      type: z.enum(["person", "agent"]),
      id: z.string(),
      name: z.string(),
      handle: z.string().nullable(),
    }),
    lastMessage: z
      .object({
        id: z.uuid(),
        body: z.string(),
        meta: PreviewMeta,
        mediaKind: MediaKind,
        createdAt: z.string(),
        authorType: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "The latest message (an agent's sticker or GIF after its own reply is part of that reply, so the reply shows).",
      }),
    unread: z.number().openapi({
      description: "Messages since you last read it, not yours; an agent's sticker or GIF after its reply never.",
    }),
    lastReadAt: z.string().nullable().openapi({
      description: "Where the unread starts: when you last read it; null when you never did.",
    }),
    everRead: z.boolean().openapi({
      description:
        "False until you first read it (`POST …/channels/{channelId}/read`): the right hand waves on that first visit.",
    }),
    openedAt: z.string().openapi({ description: "When the DM began: where it sorts until its first message." }),
  })
  .openapi("DirectMessage");

/** A DM as the list has it, its dates as strings. */
const dmView = (d: Awaited<ReturnType<typeof listDms>>[number]) => ({
  ...d,
  lastReadAt: iso(d.lastReadAt),
  openedAt: d.openedAt.toISOString(),
  lastMessage: d.lastMessage ? { ...d.lastMessage, createdAt: d.lastMessage.createdAt.toISOString() } : null,
});

/** Direct conversations (person↔person, person↔agent). In an agent DM the agent answers every message. */
export function dmRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/dms",
      tags,
      security,
      summary: "My direct conversations, with unread counts",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ dms: z.array(Dm) })), ...errors },
    }),
    async (c) => {
      const dms = await listDms(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ dms: dms.map(dmView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dms",
      tags,
      security,
      summary: "Open (or create) a direct conversation with a person or an agent",
      description:
        "`dm`: the conversation as `GET …/dms` lists it, so an app shows it there without asking again; none while it isn't in that list yet (an empty one the other person opened). While the workspace is being deleted, a conversation it has opens as it is and a new one is refused (`org.deleting`).",
      request: {
        params: OrgParams,
        body: body(z.union([z.object({ userId: z.string() }), z.object({ agentId: z.uuid() })])),
      },
      responses: { 200: json(z.object({ channelId: z.uuid(), dm: Dm.optional() })), ...errors },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { orgId } = c.req.valid("param");
      const channel = await openDm(db, userId, orgId, c.req.valid("json"), { pubsub: adapters.pubsub });
      const [dm] = await listDms(db, userId, orgId, channel.id);
      return c.json({ channelId: channel.id, ...(dm ? { dm: dmView(dm) } : {}) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/read",
      tags,
      security,
      summary: "Mark a channel or DM read up to now",
      request: { params: OrgParams.extend({ channelId: z.uuid() }), body: body(z.object({})) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await markChannelRead(db, c.get("user").id, orgId, channelId, new Date(), adapters.pubsub);
      return c.body(null, 204);
    },
  );

  for (const [method, muted] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/organizations/{orgId}/channels/{channelId}/mute",
        tags,
        security,
        summary: muted
          ? "Mute a channel for you: it never looks unread (a mention of you still counts)"
          : "Unmute a channel for you",
        description:
          "Members only, channels only (a DM gets 400). Your other devices hear `channel.muted` on your own topic.",
        request: { params: OrgParams.extend({ channelId: z.uuid() }) },
        responses: { 204: noContent[204], ...errors },
      }),
      async (c) => {
        const { orgId, channelId } = c.req.valid("param");
        await setChannelMuted(db, c.get("user").id, orgId, channelId, muted, adapters.pubsub);
        return c.body(null, 204);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/reads",
      tags,
      security,
      summary: 'Where the other people of a DM stopped reading ("Visto"); empty for any other channel',
      request: { params: OrgParams.extend({ channelId: z.uuid() }) },
      responses: {
        200: json(z.object({ reads: z.array(z.object({ userId: z.string(), lastReadAt: z.string() })) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json({ reads: await dmReads(db, c.get("user").id, orgId, channelId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dms/{channelId}/share",
      tags,
      security,
      summary: "Share your conversation with an agent: a read-only copy in a channel or with a person",
      description:
        "Your DM with an agent, as it stands now, posted by you with `note` in a channel you are a member of (`to.channelId`) or in your DM with a person (`to.userId`, opened if new). The copy is `meta.sharedDm` on that message; the DM stays closed to everyone else and keeps what the agent remembers there. Nothing deletes the copy, so `confirm` must be true. The copy wakes no agent and only `note` is searched. 400 `dm_share.not_agent_dm` (a DM between people), `dm_share.target` (not a channel, or the DM itself), `dm_share.empty`, `dm_share.note`; 404 when the DM isn't yours or you aren't a member of the channel.",
      request: {
        params: OrgParams.extend({ channelId: z.uuid() }),
        body: body(
          z.object({
            to: z.union([z.object({ channelId: z.uuid() }), z.object({ userId: z.string() })]),
            note: z.string().min(1).max(DM_SHARE_LIMITS.noteChars),
            confirm: z.literal(true).openapi({ description: "The copy can't be taken back: say so." }),
            clientId: z.string().max(64).optional(),
          }),
        ),
      },
      responses: {
        201: json(z.object({ channelId: z.uuid(), message: Message }), "Created"),
        ...errors,
        429: errorResponse("Too many messages"),
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const { to, note, clientId } = c.req.valid("json");
      const user = c.get("user");
      // A copy is a post: it counts toward the same limit as a message.
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const shared = await shareDm({ db, pubsub: adapters.pubsub }, user.id, orgId, channelId, { to, note, clientId });
      // Notifications and indexing of the note now, instead of at the next poll.
      deps.wakeWorkers?.();
      return c.json(shared, 201);
    },
  );

  return app;
}
