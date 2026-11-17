import { type ArtifactDeps, listPublishedPages, unpublishPage } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, noContent, OrgParams, requireSession, security } from "./context";

const tags = ["Drive"];

const PublishedPage = z
  .object({
    id: z.string(),
    artifactId: z.string(),
    title: z.string(),
    version: z.number().openapi({ description: "The version the address shows: the one a person approved." }),
    url: z.string().openapi({ description: "The public address, on the server's pages host." }),
    createdBy: z.object({ type: z.enum(["agent", "person"]), id: z.string() }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PublishedPage");

/**
 * Public pages (ADR 0211 §6): the live ones a person may take down, and taking one down. Agents publish them
 * (`publish_page`); a server without `PUBLISHED_PAGES_URL` serves none and lists none.
 */
export function publishedPageRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const artifacts = (): ArtifactDeps => {
    const a = deps.extras?.artifacts;
    if (!a) throw new Error("artifacts are not configured on this server");
    return a;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/published-pages",
      tags,
      security,
      summary:
        "Live public pages I may take down: every one for an administrator, else those of files I read; one file's with artifactId",
      request: { params: OrgParams, query: z.object({ artifactId: z.uuid().optional() }) },
      responses: { 200: json(z.object({ pages: z.array(PublishedPage) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const baseUrl = deps.config.PUBLISHED_PAGES_URL;
      if (!baseUrl) return c.json({ pages: [] }, 200);
      const { artifactId } = c.req.valid("query");
      const pages = await listPublishedPages(artifacts(), c.get("user").id, orgId, {
        baseUrl,
        ...(artifactId ? { artifactId } : {}),
      });
      return c.json({ pages }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/published-pages/{pageId}",
      tags,
      security,
      summary:
        "Take a public page down at once (an administrator, or whoever reads its file); its address never answers again",
      request: { params: OrgParams.extend({ pageId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, pageId } = c.req.valid("param");
      await unpublishPage(artifacts(), c.get("user").id, orgId, pageId);
      return c.body(null, 204);
    },
  );

  return app;
}
