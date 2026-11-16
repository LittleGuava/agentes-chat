import type { ApiClient, ExportScope } from "@agenteschat/client";
import { fileSaver } from "@/components/artifacts/fileSaver";

/**
 * Downloads the workspace as a file: its agents, skills, routines and shared memory, never conversations or files.
 * With `scope`, only that part of it (ADR 0055 addendum 2026-11-15).
 */
export const saveExport = (api: ApiClient, orgId: string, scope?: ExportScope) =>
  fileSaver.save(api.imports.exportUrl(orgId, scope), `agentes-chat-${new Date().toISOString().slice(0, 10)}.json`);
