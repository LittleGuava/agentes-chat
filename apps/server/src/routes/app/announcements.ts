import {
  type AnnouncementViewer,
  announcementsFor,
  can,
  dismissAnnouncement,
  requireActiveMembership,
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

const tags = ["Announcements"];

const Announcement = z
  .object({
    id: z.uuid(),
    title: z.string().openapi({ description: "Plain text, one line." }),
    body: z.string().openapi({ description: "Plain text, line breaks kept: never read as markup." }),
    link: z
      .object({
        url: z.string().openapi({ description: "An https address, opened outside the app as it is." }),
        label: z.string().nullable().openapi({ description: "Null: the app's own words." }),
      })
      .nullable(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
  })
  .openapi("Announcement");

/**
 * Announcements (ADR 0056, addendum on announcements): what the people who run this server tell me in this workspace,
 * and closing one for good.
 */
export function announcementRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  const viewerOf = async (userId: string, orgId: string): Promise<AnnouncementViewer> => {
    const membership = await requireActiveMembership(db, userId, orgId);
    return { userId, orgId, admin: can(membership, "administrator") };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/announcements",
      tags,
      security,
      summary: "What the server's operator tells me here now, newest first",
      description: "Live for me in this workspace and not closed, at most 5.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ announcements: z.array(Announcement) }).openapi("Announcements")), ...errors },
    }),
    async (c) => {
      const viewer = await viewerOf(c.get("user").id, c.req.valid("param").orgId);
      const shown = await announcementsFor(db, viewer);
      return c.json(
        {
          announcements: shown.map((a) => ({
            id: a.id,
            title: a.title,
            body: a.body,
            link: a.link,
            startsAt: a.startsAt.toISOString(),
            endsAt: iso(a.endsAt),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/announcements/{id}/dismiss",
      tags,
      security,
      summary: "Close an announcement for good",
      description:
        "In every workspace. Again changes nothing. 404 for one I'm not shown here now (ended, removed, not for me).",
      request: { params: OrgParams.extend({ id: z.uuid() }), body: body(z.object({})) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      await dismissAnnouncement(db, await viewerOf(c.get("user").id, orgId), id);
      return c.body(null, 204);
    },
  );

  return app;
}
