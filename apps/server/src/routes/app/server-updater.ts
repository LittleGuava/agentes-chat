import {
  SERVER_UPDATE_REASONS,
  SERVER_UPDATE_STATES,
  SERVER_UPDATE_STEPS,
  type ServerUpdater,
} from "@agenteschat/adapters";
import { isAgentesCloud, NotFoundError, pinnedOwner, requestServerUpdate, serverUpdateView } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const ServerUpdaterStatus = z
  .object({
    helper: z.enum(["ready", "absent"]).openapi({
      description: "`absent`: the updater service hasn't said it is there in the last minute, so nothing would run.",
    }),
    requested: z.boolean().openapi({ description: "A request is waiting for the updater." }),
    canUpdate: z.boolean(),
    run: z
      .object({
        state: z.enum(SERVER_UPDATE_STATES),
        step: z.enum(SERVER_UPDATE_STEPS).nullable(),
        reason: z.enum(SERVER_UPDATE_REASONS).nullable(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        from: z.string().nullable().openapi({ description: "The app's image id before the run." }),
        to: z.string().nullable().openapi({ description: "The image id the registry had." }),
      })
      .nullable()
      .openapi({ description: "The updater's last run, as it wrote it. Null before the first." }),
  })
  .openapi("ServerUpdaterStatus");

/**
 * Updates from the app (ADR 0200): only the installation's pinned owner, never on agentes.chat itself, and only with
 * `SERVER_UPDATER_DIR`. Everyone else gets 404, as for the usage report's switch.
 */
export function serverUpdaterRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/server-updater", requireSession(deps.auth));

  const updaterFor = async (userId: string): Promise<ServerUpdater> => {
    const updater = deps.adapters.serverUpdater;
    if (!updater || isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) {
      throw new NotFoundError("Not found");
    }
    return updater;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/server-updater",
      tags,
      summary: "Whether the server can be updated from here, and how its last update went",
      description:
        "404 for everyone but the installation's owner, on a server without `SERVER_UPDATER_DIR`, and on agentes.chat itself.",
      security,
      responses: { 200: json(ServerUpdaterStatus), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const updater = await updaterFor(c.get("user").id);
      return c.json(serverUpdateView(await updater.read(), new Date()), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/server-updater",
      tags,
      summary: "Update the server",
      description:
        "Asks the updater for one update: it pulls the app's image, stops the app, copies the database, starts the new version, and puts the previous one and the copy back if it never gets healthy. The request carries nothing: the updater picks the image. 409 `updater_absent` when the updater isn't running, `update_in_progress` while a request waits or a run is going.",
      security,
      request: { body: body(z.object({})) },
      responses: { 202: json(ServerUpdaterStatus), 401: errors[401], 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const user = c.get("user");
      const updater = await updaterFor(user.id);
      const view = await requestServerUpdate(updater, new Date());
      deps.log?.info("server update requested", { userId: user.id });
      return c.json(view, 202);
    },
  );

  return app;
}
