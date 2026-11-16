import { operatorHealthIssues } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { json, OrgParams } from "../routes/app/context";
import { HealthIssueKind } from "../routes/app/health-issues";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = { 401: errorResponse("Missing or wrong token"), 404: errorResponse("Not found") };

const OperatorHealthIssue = z
  .object({
    kind: HealthIssueKind,
    signature: z.string().openapi({ description: "`kind:` and 16 hex characters: one cause, one signature." }),
    source: z.string().nullable().openapi({
      description:
        "The tool's name, the job's kind or a run's error code (`run.provider_timeout`); null for a cost spike.",
    }),
    subject: z.string().nullable().openapi({ description: "The provider or brain a run's failure names." }),
    agentId: z.string().nullable(),
    count: z.number().int(),
    firstAt: z.string(),
    lastAt: z.string(),
  })
  .openapi("OperatorHealthIssue", {
    description: "A group of a workspace's failures with one signature (ADR 0214), never its text.",
  });

/** A workspace's health issues (ADR 0214 §6): facts, never the normalized text people's admins read. */
export function registerOperatorHealth(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/health-issues",
      tags,
      summary: "What keeps failing in a workspace, grouped by cause, latest first",
      description:
        "Tool errors, runs failed or timed out, jobs stalled or dead, and runs that cost over $5, each group with its count and first and last time. Never the failure's text.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ issues: z.array(OperatorHealthIssue) })), ...errors },
    }),
    async (c) => {
      const issues = await operatorHealthIssues(db, c.req.valid("param").orgId);
      if (!issues) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ issues }, 200);
    },
  );
}
