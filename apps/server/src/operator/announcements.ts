import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENTS_LIST_MAX,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  type OperatorAnnouncement as Stored,
  updateAnnouncement,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, noContent } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  403: errorResponse("The read-only token can't do this"),
  404: errorResponse("Not found"),
};

/** An `https` address with no user name or password: opened outside the app as it is. */
const safeLink = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const Link = z
  .object({
    url: z.string().max(2000).refine(safeLink, "An https address with no user name or password"),
    label: z.string().trim().min(1).max(40).nullable().default(null).openapi({
      description: "The link's words. Null (or left out): the apps' own, Learn more in the person's language.",
    }),
  })
  .openapi("OperatorAnnouncementLink");

const Audience = z.enum(ANNOUNCEMENT_AUDIENCES).openapi("OperatorAnnouncementAudience", {
  description:
    "`everyone`: every member of every workspace. `admins`: whoever holds `administrator` in the workspace on screen, owners included. `workspace`: every member of the workspace `orgId`.",
});

const Input = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => !/[\r\n]/.test(v), "One line")
      .openapi({ description: "Plain text, one line." }),
    body: z
      .string()
      .max(600)
      .default("")
      .openapi({ description: "Plain text, line breaks kept: never read as markup." }),
    link: Link.nullable().default(null),
    audience: Audience,
    orgId: z.uuid().nullable().default(null).openapi({ description: "The workspace, for `workspace` only." }),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null).openapi({
      description: "When it starts to show. Null (or left out): now on POST, as it was on PUT.",
    }),
    endsAt: z.iso.datetime({ offset: true }).nullable().default(null).openapi({
      description: "When it stops, after `startsAt` (else 400 `announcement.period`). Null: until removed.",
    }),
  })
  .refine((a) => (a.audience === "workspace") === (a.orgId !== null), {
    message: "orgId is for audience workspace, and only for it",
    path: ["orgId"],
  })
  .openapi("OperatorAnnouncementInput");

const OperatorAnnouncement = z
  .object({
    id: z.uuid(),
    title: z.string(),
    body: z.string(),
    link: Link.nullable(),
    audience: Audience,
    orgId: z.uuid().nullable(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    dismissals: z.number().int().openapi({ description: "How many people closed it." }),
  })
  .openapi("OperatorAnnouncement");

const IdParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });

const toJson = (a: Stored) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  link: a.link,
  audience: a.audience,
  orgId: a.orgId,
  startsAt: a.startsAt.toISOString(),
  endsAt: iso(a.endsAt),
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
  dismissals: a.dismissals,
});

const inputOf = ({ startsAt, endsAt, ...rest }: z.infer<typeof Input>) => ({
  ...rest,
  startsAt: startsAt ? new Date(startsAt) : null,
  endsAt: endsAt ? new Date(endsAt) : null,
});

/** Announcements (ADR 0056, addendum on announcements): what the operator tells the instance's people. */
export function registerOperatorAnnouncements(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/announcements",
      tags,
      summary: "Every announcement, live or not, newest first",
      description: `Up to \`limit\` (at most ${ANNOUNCEMENTS_LIST_MAX}); \`more\` when there are others.`,
      request: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(ANNOUNCEMENTS_LIST_MAX).default(ANNOUNCEMENTS_LIST_MAX),
        }),
      },
      responses: {
        200: json(
          z
            .object({ announcements: z.array(OperatorAnnouncement), more: z.boolean() })
            .openapi("OperatorAnnouncements"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { announcements, more } = await listAnnouncements(db, c.req.valid("query").limit);
      return c.json({ announcements: announcements.map(toJson), more }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/announcements",
      tags,
      summary: "Publish an announcement",
      description:
        "The web app shows it on top of the work area to whoever it is for, within its period, until each person closes it. 404 when `orgId` names no workspace.",
      request: { body: body(Input) },
      responses: { 201: json(OperatorAnnouncement, "Published"), ...errors },
    }),
    async (c) => c.json(toJson(await createAnnouncement(db, inputOf(c.req.valid("json")))), 201),
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/announcements/{id}",
      tags,
      summary: "Change an announcement",
      description:
        "Every field but the id, `startsAt` left out keeping its own. Whoever closed it doesn't see it again: something new is a new announcement.",
      request: { params: IdParams, body: body(Input) },
      responses: { 200: json(OperatorAnnouncement), ...errors },
    }),
    async (c) => {
      const changed = await updateAnnouncement(db, c.req.valid("param").id, inputOf(c.req.valid("json")));
      if (!changed) return apiError(c, 404, "not_found", "No announcement with this id");
      return c.json(toJson(changed), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/announcements/{id}",
      tags,
      summary: "Remove an announcement",
      description: "Nobody sees it any more; who closed it is forgotten with it.",
      request: { params: IdParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      if (!(await deleteAnnouncement(db, c.req.valid("param").id))) {
        return apiError(c, 404, "not_found", "No announcement with this id");
      }
      return c.body(null, 204);
    },
  );
}
