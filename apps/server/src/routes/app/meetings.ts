import { NotFoundError } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, noContent, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

/** Meetings agents take notes in (ADR 0199): the way out people have from the conversation. */
export function meetingRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/meetings/{meetingId}/leave",
      tags,
      security,
      summary: "Make an agent leave the meeting it is taking notes in",
      description:
        "Anyone who reads the conversation the meeting was asked in (its `meeting_joined` notice carries `refs.meetingId`). The computer stops hearing the call, the agent's browser closes, and what was heard comes back as the `meeting_ended` notice. 409 `meeting.ended` once it is over; 404 `meeting.not_found`.",
      request: { params: OrgParams.extend({ meetingId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const meetings = deps.extras?.meetings;
      if (!meetings) throw new NotFoundError("Meeting not found", "meeting.not_found");
      const { orgId, meetingId } = c.req.valid("param");
      await meetings.leaveAs(c.get("user").id, orgId, meetingId);
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  return app;
}
