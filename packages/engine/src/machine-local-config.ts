import { isIP } from "node:net";
import {
  LOCAL_CONFIG_PROTOCOL,
  type LocalConfig,
  type LocalMcpServer,
  parseLocalConfig,
  redactCommon,
} from "@agenteschat/adapters";
import { and, eq, isNull, like, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { CUSTOM_PREFIX } from "./connectors/custom";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { MigrationBundle } from "./imports";
import type { AccessDeps } from "./machine-access";
import type { MachineCaller } from "./machine-hub";
import { getMachine, MachineOfflineError } from "./machines";
import { isBlockedAddress, isPublicHostName } from "./net-guard";
import { requirePermission } from "./organizations";

/**
 * Bringing what a person set up for their own coding tools on their computer (ADR 0055, addendum 2026-11-15): the
 * runner reads it there (`local.config`), only for the person who connected the computer, and this turns it into a
 * preview. Remote servers are connected through the usual custom-server flow (`connectCustomServer`), and the skills
 * come as a bundle for the usual import (`POST …/imports`). Nothing is stored here.
 */

/**
 * What can be done with a server here: `connect` (a public https address: "Conectar"), `connected` (a server of the
 * workspace has that address already), `private` (http, or an address only that computer or its network reaches),
 * `sse` (the older transport, which our MCP client doesn't speak), `stdio` (a program the tool starts on that
 * computer, which the server can't run), `key_in_address` (a key in its address was masked: the person pastes the
 * whole address in the custom-server flow themselves).
 */
export const LOCAL_SERVER_STATES = ["connect", "connected", "private", "sse", "stdio", "key_in_address"] as const;
export type LocalServerState = (typeof LOCAL_SERVER_STATES)[number];
export type LocalSetupServer = LocalMcpServer & { state: LocalServerState };

export interface LocalSetup {
  files: LocalConfig["files"];
  servers: LocalSetupServer[];
  skipped: LocalConfig["skipped"];
  /** The skills as an import bundle (no agents come with them). */
  bundle: MigrationBundle;
  /** The skills where something that looked like a key was masked (`***`) before they left the computer. */
  masked: string[];
}

type Deps = AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> };

/** The bundle's app: the skills come from Claude Code's skills folder. */
export const LOCAL_SKILLS_APP = "claude-code";

/** Whether the server reaches an address from the name alone (the connect flow resolves it again). */
function reachable(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) ? !isBlockedAddress(host) : isPublicHostName(host);
}

function stateOf(server: LocalMcpServer, connected: ReadonlySet<string>): LocalServerState {
  if (server.kind === "stdio" || !server.url) return "stdio";
  if (server.keyInAddress) return "key_in_address";
  if (connected.has(server.url)) return "connected";
  if (!reachable(server.url)) return "private";
  return server.kind === "sse" ? "sse" : "connect";
}

/** The addresses of the workspace's servers by address, as `cleanServerUrl` writes them. */
async function connectedUrls(deps: Deps, orgId: string) {
  const { connectorConnections: c } = schema;
  const rows = await deps.db
    .select({ serverUrl: c.serverUrl })
    .from(c)
    .where(and(eq(c.orgId, orgId), like(c.connector, `${CUSTOM_PREFIX}%`), isNull(c.revokedAt)));
  const urls = new Set<string>();
  for (const r of rows) {
    try {
      urls.add(new URL(r.serverUrl).toString());
    } catch {
      // A row's address is checked when it is saved; one that no longer parses matches nothing.
    }
  }
  return urls;
}

/**
 * `POST …/machines/{machineId}/local-config`: the MCP servers and skills of Claude Code, Cursor and Codex on the
 * computer, read now. Only the person who connected it (the settings are theirs), never the workspace's own computer;
 * an app too old for it is told to update. The audit keeps the counts, never names or addresses.
 */
export async function readLocalSetup(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
): Promise<LocalSetup> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (machine.kind === "managed") {
    throw new ForbiddenError(
      "This is the workspace's own computer: it has no settings of yours",
      "machine.managed_access",
    );
  }
  if (machine.pairedByUserId !== actorId) {
    throw new ForbiddenError("Only the person who connected this computer can read its settings", "machine.not_owner", {
      ownerId: machine.pairedByUserId ?? null,
    });
  }
  if (machine.protocol < LOCAL_CONFIG_PROTOCOL) {
    throw new ValidationError(
      "This computer's app is too old to read its settings from here. Update the app on it.",
      "machine.local_config_outdated",
      { name: machine.name },
    );
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const config = parseLocalConfig(await deps.hub.call(machine.id, { op: "local.config" }));
  if (config.unsupported) {
    throw new ValidationError(
      "This computer's app runs for every agent's user, not as you: it can't read your settings.",
      "machine.local_config_unsupported",
      { name: machine.name },
    );
  }
  // Masked again here: an older or changed runner may not have.
  const skills = config.skills.map((s) => {
    const markdown = redactCommon(s.markdown);
    return { name: s.name, markdown, masked: s.masked === true || markdown !== s.markdown };
  });
  const connected = await connectedUrls(deps, orgId);
  const servers = config.servers.map((s) => ({ ...s, state: stateOf(s, connected) }));
  const skillsPlace = config.files.find((f) => f.app === "claude" && f.state === "read" && /skills$/.test(f.path));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.local_config_shown",
    target: { type: "machine", id: machine.id },
    details: { servers: servers.length, skills: skills.length },
  });
  return {
    files: config.files,
    servers,
    skipped: config.skipped,
    masked: skills.filter((s) => s.masked).map((s) => s.name),
    bundle: {
      format: "agenteschat.bundle",
      version: 1,
      // One package per computer: reading it again later updates what the first import made.
      source: {
        app: LOCAL_SKILLS_APP,
        ref: `computer:${machine.id}`,
        name: machine.name,
        files: skillsPlace ? [skillsPlace.path] : [],
      },
      agents: [],
      skills: skills.map((s) => ({ key: s.name, markdown: s.markdown })),
      channels: [],
      routines: [],
      notes: [],
      todo: [],
      leftOut: [],
    },
  };
}
