import { listHealthIssues } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Health"];

export const HealthIssueKind = z
  .enum(["tool_error", "timeout", "run_failed", "queue_stalled", "job_failed", "cost_spike"])
  .openapi("HealthIssueKind");

const HealthIssue = z
  .object({
    id: z.string(),
    kind: HealthIssueKind,
    signature: z.string().openapi({ description: "`kind:` and 16 hex characters: one cause, one signature." }),
    title: z.string().openapi({
      description:
        "The failure's first line with ids, numbers, addresses, paths and quoted values replaced (`<n>`, `<path>`…); empty for a stalled job or a cost spike.",
    }),
    source: z.string().nullable().openapi({
      description:
        "The tool's name, the job's kind or a run's error code (`run.provider_timeout`); null for a cost spike.",
    }),
    subject: z.string().nullable().openapi({ description: "The provider or brain a run's failure names." }),
    agentId: z.string().nullable().openapi({ description: "Set while every occurrence is that agent's." }),
    count: z.number().int(),
    firstAt: z.string(),
    lastAt: z.string(),
    examples: z
      .array(
        z.object({
          at: z.string(),
          runId: z.string().nullable(),
          agent: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
        }),
      )
      .openapi({ description: "The latest three occurrences of the last 14 days: when, which agent, which run." }),
  })
  .openapi("HealthIssue");

/** The workspace's failures grouped into issues (ADR 0214), for who may read the audit log. */
export function healthIssueRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/health-issues",
      tags,
      security,
      summary: "What keeps failing, grouped by cause, latest first (who may read the audit log)",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ issues: z.array(HealthIssue) }).openapi("HealthIssues")),
        ...errors,
      },
    }),
    async (c) => c.json(await listHealthIssues(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  return app;
}
