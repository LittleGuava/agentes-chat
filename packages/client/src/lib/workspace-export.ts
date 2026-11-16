import type { ExportScope, MigrationBundle } from "../api/types";

/**
 * The export's query for a part of the workspace (ADR 0055 addendum 2026-11-15): `?agents=…&groups=…`, both always
 * sent, so a part that names nobody asks for an empty file, never the whole workspace. Nothing for the whole of it.
 */
export function exportQuery(scope?: ExportScope): string {
  if (!scope) return "";
  const params = new URLSearchParams({
    agents: (scope.agentIds ?? []).join(","),
    groups: (scope.groupIds ?? []).join(","),
  });
  return `?${params}`;
}

/** Whether a part names anything to export. */
export const scopeNamesSome = (scope: ExportScope) => (scope.agentIds?.length ?? 0) + (scope.groupIds?.length ?? 0) > 0;

/** What a bundle holds, counted, for the preview before the download. */
export function bundleCounts(bundle: MigrationBundle) {
  return {
    agents: bundle.agents.length,
    skills: bundle.skills.length,
    channels: bundle.channels.length,
    routines: bundle.routines.length,
    notes: bundle.notes.length,
  };
}
