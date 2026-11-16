import type { ServerUpdaterStatus } from "../api/types";

/** How often the card asks again while an update waits or runs (ADR 0200): the server restarts in between. */
export const SERVER_UPDATE_POLL_MS = 5_000;

/** A request waits for the updater or a run is going. */
export function serverUpdateBusy(view: ServerUpdaterStatus | null): boolean {
  return view !== null && (view.requested || view.run?.state === "running");
}

/** The words' key of the card's line under its label. */
export type ServerUpdateLine =
  | "settings.serverUpdater.absent"
  | "settings.serverUpdater.requested"
  | "settings.serverUpdater.running"
  | "settings.serverUpdater.updated"
  | "settings.serverUpdater.current"
  | "settings.serverUpdater.pinned"
  | "settings.serverUpdater.rolledBack"
  | "settings.serverUpdater.failed"
  | "settings.serverUpdater.interrupted";

/** What the card says: an absent updater first, then a run going on, a request waiting, the last run's end. */
export function serverUpdateLine(view: ServerUpdaterStatus): ServerUpdateLine | null {
  if (view.helper === "absent") return "settings.serverUpdater.absent";
  if (view.run?.state === "running") return "settings.serverUpdater.running";
  if (view.requested) return "settings.serverUpdater.requested";
  switch (view.run?.state) {
    case undefined:
      return null;
    case "updated":
      return "settings.serverUpdater.updated";
    case "current":
      return "settings.serverUpdater.current";
    case "pinned":
      return "settings.serverUpdater.pinned";
    case "rolled_back":
      return "settings.serverUpdater.rolledBack";
    case "failed":
      return "settings.serverUpdater.failed";
    case "interrupted":
      return "settings.serverUpdater.interrupted";
  }
}
