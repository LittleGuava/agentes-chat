import {
  addMySidebarLink,
  mySidebarLinks,
  removeMySidebarLink,
  SIDEBAR_LINK_LIMIT,
  SIDEBAR_LINK_TITLE_MAX,
  SIDEBAR_LINK_URL_MAX,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Members"];

const SidebarLink = z
  .object({
    id: z.uuid(),
    title: z.string(),
    url: z.string().openapi({ description: "An https address, as the URL parser writes it back." }),
  })
  .openapi("SidebarLink");
const Links = z.object({ links: z.array(SidebarLink) });

// Only the shape here: the engine checks the title and the address (`sidebarLinkUrl`) once, and refuses with a code
// the apps say in words (`sidebar_link.title`, `sidebar_link.url`).
const NewLink = z.object({
  title: z
    .string()
    .max(SIDEBAR_LINK_TITLE_MAX * 4)
    .openapi({
      description: `1 to ${SIDEBAR_LINK_TITLE_MAX} characters once trimmed, else 400 \`sidebar_link.title\`.`,
    }),
  url: z
    .string()
    .max(SIDEBAR_LINK_URL_MAX * 2)
    .openapi({
      description: `https with a host and no user or password in it, ${SIDEBAR_LINK_URL_MAX} characters at most once written back, else 400 \`sidebar_link.url\`.`,
    }),
});

const LinkParams = OrgParams.extend({
  linkId: z.uuid().openapi({ param: { name: "linkId", in: "path" } }),
});

/**
 * A person's own links in their sidebar, per workspace (ADR 0083, amendment of 2026-11-15). The apps open them in a
 * new tab; the server never fetches one.
 */
export function sidebarLinkRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/me/sidebar/links",
      tags,
      security,
      summary: "Your links in the sidebar of this workspace, in their order",
      description: "Yours alone, on every device you sign in on.",
      request: { params: OrgParams },
      responses: { 200: json(Links), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ links: await mySidebarLinks(db, orgId, c.get("user").id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/me/sidebar/links",
      tags,
      security,
      summary: "Add a link at the end of your sidebar's links in this workspace",
      description: `At most ${SIDEBAR_LINK_LIMIT}: one more is 409 \`sidebar_link.full\`. An address that isn't https is 400.`,
      request: { params: OrgParams, body: body(NewLink) },
      responses: { 200: json(Links), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ links: await addMySidebarLink(db, orgId, c.get("user").id, c.req.valid("json")) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/me/sidebar/links/{linkId}",
      tags,
      security,
      summary: "Remove one of your sidebar's links in this workspace",
      description: "Answers with the links left. Someone else's link is not found.",
      request: { params: LinkParams },
      responses: { 200: json(Links), ...errors },
    }),
    async (c) => {
      const { orgId, linkId } = c.req.valid("param");
      return c.json({ links: await removeMySidebarLink(db, orgId, c.get("user").id, linkId) }, 200);
    },
  );

  return app;
}
