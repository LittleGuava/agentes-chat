import type { ServerUpdate } from "../api/types";

/** How often the card asks again while an update waits or runs (ADR 0200): the server restarts in between. */
export const SERVER_UPDATE_POLL_MS = 5_000;

/** A request waits for the updater or a run is going. */
export function serverUpdateBusy(view: ServerUpdate | null): boolean {
  return view !== null && (view.requested || view.run?.state === "running");
}

/** The words' key of the card's line under its label. */
export type ServerUpdateLine =
  | "settings.serverUpdate.absent"
  | "settings.serverUpdate.requested"
  | "settings.serverUpdate.running"
  | "settings.serverUpdate.updated"
  | "settings.serverUpdate.current"
  | "settings.serverUpdate.pinned"
  | "settings.serverUpdate.rolledBack"
  | "settings.serverUpdate.failed"
  | "settings.serverUpdate.interrupted";

/** What the card says: an absent updater first, then a run going on, a request waiting, the last run's end. */
export function serverUpdateLine(view: ServerUpdate): ServerUpdateLine | null {
  if (view.helper === "absent") return "settings.serverUpdate.absent";
  if (view.run?.state === "running") return "settings.serverUpdate.running";
  if (view.requested) return "settings.serverUpdate.requested";
  switch (view.run?.state) {
    case undefined:
      return null;
    case "updated":
      return "settings.serverUpdate.updated";
    case "current":
      return "settings.serverUpdate.current";
    case "pinned":
      return "settings.serverUpdate.pinned";
    case "rolled_back":
      return "settings.serverUpdate.rolledBack";
    case "failed":
      return "settings.serverUpdate.failed";
    case "interrupted":
      return "settings.serverUpdate.interrupted";
  }
}
