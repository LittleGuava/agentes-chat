import {
  addJoinDomain,
  domainWorkspaces,
  type JoinDomain,
  joinByDomain,
  listJoinDomains,
  MAX_JOIN_DOMAINS,
  removeJoinDomain,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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

const tags = ["Organizations"];

const JoinDomainOut = z
  .object({
    id: z.string(),
    domain: z.string(),
    roleIds: z.array(z.string()),
    createdAt: z.string(),
  })
  .openapi("JoinDomain");

const DomainWorkspace = z
  .object({ id: z.string(), name: z.string(), logo: z.string().nullable() })
  .openapi("DomainWorkspace");

const out = (d: JoinDomain) => ({ ...d, createdAt: d.createdAt.toISOString() });

/**
 * Joining by the address's domain (ADR 0068, addendum 2026-11-15): admins name domains in Members; a confirmed account
 * at one finds the workspace and joins with a click.
 */
export function joinDomainRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/domain-workspaces", requireSession(deps.auth));
  app.use("/domain-workspaces/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/join-domains",
      tags,
      security,
      summary: "The domains whose confirmed addresses join without an invitation (admins)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ domains: z.array(JoinDomainOut) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const domains = await listJoinDomains(db, c.get("user").id, orgId);
      return c.json({ domains: domains.map(out) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/join-domains",
      tags,
      security,
      summary: "Name a domain, or change the cargos of one already named (admins)",
      description:
        `Only a domain your own confirmed address is at (\`join_domain.not_yours\`, 403); never a public mailbox ` +
        `provider (\`join_domain.public\`) or something that isn't a host name (\`join_domain.invalid\`). At most ` +
        `${MAX_JOIN_DOMAINS} per workspace (\`join_domain.too_many\`, 409).`,
      request: {
        params: OrgParams,
        body: body(
          z.object({
            domain: z.string().min(1).max(260),
            roleIds: z.array(z.string().uuid()).max(50).optional().openapi({
              description: "Cargos joining starts on, below your own (ADR 0085). None: a member, with what Todos has.",
            }),
          }),
        ),
      },
      responses: { 200: json(JoinDomainOut), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const domain = await addJoinDomain(db, c.get("user").id, orgId, c.req.valid("json"));
      return c.json(out(domain), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/join-domains/{domainId}",
      tags,
      security,
      summary: "Stop letting a domain in (admins); who joined by it stays",
      request: { params: OrgParams.extend({ domainId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, domainId } = c.req.valid("param");
      await removeJoinDomain(db, c.get("user").id, orgId, domainId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/domain-workspaces",
      tags,
      security,
      summary: "Workspaces your confirmed address's domain lets you join",
      description: "Active workspaces you aren't in, id, name and logo only. Empty while your address isn't confirmed.",
      responses: { 200: json(z.object({ workspaces: z.array(DomainWorkspace) })), ...errors },
    }),
    async (c) => c.json({ workspaces: await domainWorkspaces(db, c.get("user").id) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/domain-workspaces/{orgId}/join",
      tags,
      security,
      summary: "Join a workspace that names your address's domain",
      description:
        "403 `join_domain.not_allowed` when your address isn't confirmed, isn't at a domain it names, or an admin " +
        "removed you from it; 409 `org.members_full` when it is full.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ orgId: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await joinByDomain({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId), 200);
    },
  );

  return app;
}
