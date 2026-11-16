import { SpeechError } from "@agenteschat/adapters";
import {
  NotFoundError,
  type ReadAloudDeps,
  readAloud,
  readAloudAudio,
  requirePermission,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { rangedResponse } from "../../http/byte-range";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];
/** Every server: a person can't make the engine read in bulk. */
const READS_PER_PERSON = { limit: 20, windowMs: 60_000 };

const MessageParams = OrgParams.extend({ messageId: z.uuid() });
const ClipParams = OrgParams.extend({ clipId: z.uuid() });

/**
 * Agents' replies read aloud (ADR 0209): `POST` makes the audio (or finds it made) and answers its clip; `GET` only
 * serves a clip that exists, so an `<audio>` tag never pays for one.
 */
export function readAloudRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const readAloudDeps = (): ReadAloudDeps => {
    const r = deps.extras?.readAloud;
    if (!r) throw new NotFoundError();
    return r;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/read-aloud",
      tags,
      security,
      summary: "Whether this server reads agents' replies aloud",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ available: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(deps.db, c.get("user").id, orgId, "read");
      return c.json({ available: Boolean(deps.extras?.readAloud?.engine) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/read-aloud",
      tags,
      security,
      summary: "Read an agent's reply aloud",
      description:
        "Makes the reply's audio in its agent's voice, or finds it already made for this text and voice, for who can " +
        "read its channel. Play it from `GET …/read-aloud/{clipId}/audio`.",
      request: { params: MessageParams },
      responses: {
        200: json(z.object({ clipId: z.uuid() }), "The audio to play"),
        ...errors,
        409: errorResponse("Reading aloud is off on this server (`read_aloud.unavailable`)"),
        422: errorResponse("Not an agent's reply, or nothing to read (`read_aloud.not_agent`, `read_aloud.no_words`)"),
        429: errorResponse("Too much today, or too fast (`read_aloud_limit`, `rate_limited`)"),
        503: errorResponse("The engine couldn't read it now (`read_aloud.busy`)"),
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const user = c.get("user");
      if (!(await deps.adapters.rateLimiter.consume(`read-aloud:${user.id}`, READS_PER_PERSON)).allowed) {
        return apiError(c, 429, "rate_limited", "Slow down");
      }
      try {
        return c.json(await readAloud(readAloudDeps(), user.id, orgId, messageId), 200);
      } catch (error) {
        if (error instanceof ValidationError) {
          if (error.code === "read_aloud.limit") return apiError(c, 429, "read_aloud_limit", error.message);
          if (error.code === "read_aloud.unavailable") return apiError(c, 409, error.code, error.message);
          if (error.code === "read_aloud.not_agent" || error.code === "read_aloud.no_words") {
            return apiError(c, 422, error.code, error.message);
          }
        }
        // The engine's own words never reach the person: they may name the provider's account.
        if (error instanceof SpeechError) {
          deps.log?.warn("read aloud failed", { orgId, reason: error.reason, error: error.message });
          return apiError(c, 503, "read_aloud.busy", "Couldn't read it aloud now");
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/read-aloud/{clipId}/audio",
      tags,
      security,
      summary: "A reply's audio, for who can read its channel",
      request: { params: ClipParams },
      responses: {
        200: { description: "The audio" },
        206: { description: "Part of the audio" },
        302: { description: "A short-lived link to the audio" },
        416: { description: "Range not satisfiable" },
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, clipId } = c.req.valid("param");
      const audio = await readAloudAudio(readAloudDeps(), c.get("user").id, orgId, clipId);
      if ("url" in audio) return c.redirect(audio.url, 302);
      return rangedResponse(audio.body, c.req.header("range"), {
        "content-type": audio.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
    },
  );

  return app;
}
