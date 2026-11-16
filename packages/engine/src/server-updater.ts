import type { ServerUpdateRun, ServerUpdater, ServerUpdaterReading } from "@agenteschat/adapters";
import { ConflictError } from "./errors";

/**
 * Updates from the app (ADR 0200): what the installation's owner sees and may do. The updater touches its `alive`
 * file every few seconds; a minute without it means it isn't running.
 */
export const UPDATER_ALIVE_MS = 60_000;

export interface ServerUpdateView {
  /** `absent`: the updater service isn't running, so a request would wait for nobody. */
  helper: "ready" | "absent";
  /** A request is waiting for the updater (it waits a few minutes after a run that stopped the app). */
  requested: boolean;
  run: ServerUpdateRun | null;
  /** The button: the updater is there, nothing is waiting and no run is going. */
  canUpdate: boolean;
}

export function serverUpdateView(reading: ServerUpdaterReading, now: Date): ServerUpdateView {
  const ready = reading.aliveAt !== null && now.getTime() - reading.aliveAt.getTime() <= UPDATER_ALIVE_MS;
  const running = reading.run?.state === "running";
  return {
    helper: ready ? "ready" : "absent",
    requested: reading.requested,
    run: reading.run,
    canUpdate: ready && !reading.requested && !running,
  };
}

/** Leaves the request when the view allows it; 409 otherwise, with the view's reason as the code. */
export async function requestServerUpdate(updater: ServerUpdater, now: Date): Promise<ServerUpdateView> {
  const view = serverUpdateView(await updater.read(), now);
  if (!view.canUpdate) {
    const code = view.helper === "absent" ? "updater_absent" : "update_in_progress";
    throw new ConflictError(
      view.helper === "absent" ? "The updater isn't running" : "An update is already on its way",
      code,
    );
  }
  await updater.request(now);
  return serverUpdateView(await updater.read(), now);
}
