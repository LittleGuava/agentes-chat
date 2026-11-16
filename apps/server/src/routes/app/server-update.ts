import { NotFoundError, pinnedOwner, serverUpdate, updateChecks } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { createUpdateCheck } from "../../server-update";
import { installMode } from "../../telemetry";
import { version } from "../../version";
import { type AppDeps, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const ServerUpdate = z
  .object({
    version: z.string().openapi({ description: "This server's version." }),
    latest: z
      .object({
        version: z.string(),
        publishedAt: z.string().nullable(),
        notesUrl: z.string().openapi({ description: "The release's page, with its notes." }),
      })
      .nullable()
      .openapi({ description: "The newest server release seen; null while GitHub hasn't answered." }),
    updateAvailable: z.boolean(),
    install: z.enum(["docker", "native", "desktop"]),
    command: z
      .string()
      .nullable()
      .openapi({ description: "What installs it on this server, one command per line; null with nothing to install." }),
  })
  .openapi("ServerUpdate");

/**
 * Whether a newer release is out (ADR 0060, addendum 2026-11-15): only the installation's pinned owner, the one
 * who updates it, as with the usage report's switch; never on agentes.chat itself, in the desktop app's server or
 * with `UPDATE_CHECK=off`.
 */
export function serverUpdateRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/server-update", requireSession(deps.auth));
  const install = installMode(config);
  const check = createUpdateCheck({
    repo: config.DESKTOP_RELEASES_REPO,
    fetch: deps.extras?.desktopFetch,
    log: deps.log,
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/server-update",
      tags,
      summary: "Whether a newer agentes.chat release is out",
      description:
        "404 for everyone but the installation's owner, on agentes.chat itself, in the desktop app's server and with `UPDATE_CHECK=off`. Asks GitHub for the releases at most once every 12 hours.",
      security,
      responses: { 200: json(ServerUpdate), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      if (!updateChecks(config, install) || (await pinnedOwner(db)) !== c.get("user").id) {
        throw new NotFoundError("Not found");
      }
      const latest = await check.latest();
      return c.json(serverUpdate({ current: version, latest, install, repo: config.DESKTOP_RELEASES_REPO }), 200);
    },
  );

  return app;
}
