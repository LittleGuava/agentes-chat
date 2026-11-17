import {
  ACCESS_ALLOW_PROTOCOL,
  type AgentScope,
  BROWSER_PROFILE_PROTOCOL,
  BROWSER_SITE_HOST,
  BROWSER_SITES_PROTOCOL,
  type BrowserSite,
  type MachineReplies,
  PERSONAL_BROWSER_PROTOCOL,
  type PubSub,
} from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  notInArray,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "../audit";
import { requireChannelAccess } from "../channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { type MachineCaller, MachineRequestError } from "../machine-hub";
import { MachineOfflineError } from "../machines";
import { type NotificationDeps, notify } from "../notifications";
import { can, requireActiveMembership, requireChangePermission, requirePermission } from "../organizations";
import { isRightHand, soleReader } from "../right-hand";
import { BROWSER_HANDOFF_TOPIC, browserOnDesktop, type PageMove, pageCommand } from "./handoff";

const { agents, agentRuns, browserProfiles, browserProfileGrants, machines, organizationMembers, users } = schema;

/** An agent's turn lasts this long after its last command (ADR 0110 §4). */
export const PROFILE_TURN_MS = 2 * 60_000;
/** A command waits this long for another agent's turn to end before it answers `profile_busy`. */
export const PROFILE_WAIT_MS = 60_000;
/** A person's control holds this long without them watching (renewed while they do). */
export const PROFILE_CONTROL_MS = 2 * 60_000;
export const PROFILE_NAME_MAX = 60;

/** The live view's and the runner's key for a profile's session: frames, viewers and Chrome are per profile. */
export const profileKey = (profileId: string) => `profile:${profileId}`;
export const profileIdOfKey = (key: string) => (key.startsWith("profile:") ? key.slice(8) : null);

export type BrowserProfileRow = typeof browserProfiles.$inferSelect;

export interface BrowserProfileView {
  id: string;
  machineId: string;
  name: string;
  createdAt: string;
  agentIds: string[];
  /** Who has the turn now: an agent's run or a person in control; null while free. */
  holder: { type: "agent"; agentId: string; since: string } | { type: "person"; userId: string; since: string } | null;
  lastUsedAt: string | null;
  /** A person's own browser of one agent (`agentIds` is that agent), shown to that person alone. */
  personal: boolean;
}

/** A workspace profile, which the grants decide; a person's own browser of an agent (personal) is none of them. */
const workspaceProfile = isNull(browserProfiles.personUserId);

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Who holds the turn now (a lapsed hold is free). */
export function holderOf(
  p: Pick<BrowserProfileRow, "heldByAgentId" | "heldByUserId" | "heldUntil" | "heldSince">,
  now = Date.now(),
): BrowserProfileView["holder"] {
  if (!p.heldUntil || p.heldUntil.getTime() < now) return null;
  const since = (p.heldSince ?? p.heldUntil).toISOString();
  if (p.heldByUserId) return { type: "person", userId: p.heldByUserId, since };
  if (p.heldByAgentId) return { type: "agent", agentId: p.heldByAgentId, since };
  return null;
}

async function grantsOf(db: Executor, profileIds: string[]) {
  if (profileIds.length === 0) return new Map<string, string[]>();
  const rows = await db
    .select({ profileId: browserProfileGrants.profileId, agentId: browserProfileGrants.agentId })
    .from(browserProfileGrants)
    .where(inArray(browserProfileGrants.profileId, profileIds))
    .orderBy(asc(browserProfileGrants.createdAt));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.profileId, [...(out.get(r.profileId) ?? []), r.agentId]);
  return out;
}

const viewOf = (p: BrowserProfileRow, agentIds: string[]): BrowserProfileView => ({
  id: p.id,
  machineId: p.machineId,
  name: p.name,
  createdAt: p.createdAt.toISOString(),
  agentIds: p.personUserId && p.agentId ? [p.agentId] : agentIds,
  holder: holderOf(p),
  lastUsedAt: iso(p.lastUsedAt),
  personal: Boolean(p.personUserId),
});

/** A live profile of the workspace, or null. */
export async function getBrowserProfile(db: Executor, orgId: string, profileId: string) {
  const [row] = await db
    .select()
    .from(browserProfiles)
    .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.orgId, orgId), isNull(browserProfiles.deletedAt)));
  return row ?? null;
}

/**
 * Phase 1 (ADR 0110) holds profiles only on single-mode computers: on a system-mode one (each agent its own OS user,
 * as the Cloud's computers run) the feature doesn't exist, so its profiles are never listed or offered. A managed
 * computer counts as system mode even before its runner's first hello reports it.
 */
export const onSingleModeMachine = sql`not exists (select 1 from ${machines} m where m.id = ${browserProfiles.machineId} and (m.executors->>'mode' = 'system' or m.kind = 'managed'))`;

/** Whether a computer runs each agent as its own OS user (or is a managed one, which does): no profiles there. */
async function systemModeMachine(db: Executor, orgId: string, machineId: string) {
  const [m] = await db
    .select({ executors: machines.executors, kind: machines.kind })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.orgId, orgId)));
  return m?.executors?.mode === "system" || m?.kind === "managed";
}

/** The API's guard behind the hidden UI: anything about profiles on a system-mode computer is refused. */
async function requireSingleMode(db: Executor, orgId: string, machineId: string) {
  if (await systemModeMachine(db, orgId, machineId)) {
    throw new ValidationError(
      "Browser profiles work only on a computer where every agent runs as one user",
      "browser_profile.system_mode",
    );
  }
}

/**
 * A live profile on a single-mode computer. A person's own browser only with `personal` (watching, driving, handing
 * back): renaming, granting, choosing and deleting know only the workspace's profiles, so it reads as not found there.
 */
async function requireProfile(db: Executor, orgId: string, profileId: string, personal = false) {
  const row = await getBrowserProfile(db, orgId, profileId);
  if (!row || (row.personUserId && !personal)) throw new NotFoundError("Browser profile not found");
  await requireSingleMode(db, orgId, row.machineId);
  return row;
}

/** The workspace's profiles (names and who may use them, never a page): any member. */
export async function listBrowserProfiles(
  db: Database,
  actorId: string,
  orgId: string,
  filter: { machineId?: string } = {},
): Promise<BrowserProfileView[]> {
  await requirePermission(db, actorId, orgId, "read");
  if (filter.machineId) await requireSingleMode(db, orgId, filter.machineId);
  const rows = await db
    .select()
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, orgId),
        isNull(browserProfiles.deletedAt),
        workspaceProfile,
        onSingleModeMachine,
        filter.machineId ? eq(browserProfiles.machineId, filter.machineId) : undefined,
      ),
    )
    .orderBy(asc(browserProfiles.createdAt));
  const grants = await grantsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => viewOf(r, grants.get(r.id) ?? []));
}

/** One profile as the list shows it. */
export async function browserProfileView(db: Executor, orgId: string, profileId: string) {
  const row = await requireProfile(db, orgId, profileId, true);
  return viewOf(row, (await grantsOf(db, [row.id])).get(row.id) ?? []);
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || n.length > PROFILE_NAME_MAX) throw new ValidationError(`A name has 1 to ${PROFILE_NAME_MAX} characters`);
  return n;
}

/** A name another live profile of the workspace has (ignoring case) is refused before the unique index would. */
async function requireFreeName(db: Executor, orgId: string, name: string, except?: string) {
  const [taken] = await db
    .select({ id: browserProfiles.id })
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, orgId),
        isNull(browserProfiles.deletedAt),
        workspaceProfile,
        sql`lower(${browserProfiles.name}) = lower(${name})`,
        except ? sql`${browserProfiles.id} <> ${except}` : undefined,
      ),
    );
  if (taken) throw new ConflictError("Another browser profile has this name", "browser_profile.name_taken");
}

/**
 * The agents of the workspace this person may give or take a profile from: everyone's with `manage_agents`, else
 * only the agents they own. Unknown ids are refused.
 */
async function requireEditableAgents(
  db: Executor,
  membership: Awaited<ReturnType<typeof requirePermission>>,
  orgId: string,
  actorId: string,
  agentIds: string[],
) {
  if (agentIds.length === 0) return;
  const rows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
  if (rows.length !== new Set(agentIds).size) throw new ValidationError("Unknown agent");
  if (can(membership, "manage_agents")) return;
  if (rows.some((a) => a.ownerUserId !== actorId)) {
    throw new ForbiddenError("You can give profiles only to agents you may edit");
  }
}

/**
 * Whether a single-mode computer can hold profiles now: its runner speaks `BROWSER_PROFILE_PROTOCOL` (or `need`, for
 * what came later). An unknown or older computer (offline since before the protocol) is refused as outdated. System
 * mode is refused apart (`requireSingleMode`): there the feature is hidden, not explained.
 */
export async function profileMachineProblem(
  db: Executor,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  machineId: string,
  need = BROWSER_PROFILE_PROTOCOL,
): Promise<string | null> {
  const [m] = await db
    .select({ protocol: machines.protocol, deletedAt: machines.deletedAt })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.orgId, orgId)));
  if (!m || m.deletedAt) return "This computer no longer exists";
  const status = await hub?.status(machineId).catch(() => null);
  const protocol = status?.protocol ?? m.protocol ?? 0;
  if (protocol < need) {
    return need === BROWSER_SITES_PROTOCOL
      ? "Update this computer to see the sites its profiles are signed in to"
      : "Update this computer to use browser profiles";
  }
  return null;
}

export interface ProfileDeps {
  db: Database;
  hub?: MachineCaller;
}

/** Creates a profile on one computer, granted to the chosen agents only (`manage_connectors`). */
export async function createBrowserProfile(
  deps: ProfileDeps,
  actorId: string,
  orgId: string,
  input: { machineId: string; name: string; agentIds?: string[] },
): Promise<BrowserProfileView> {
  const { db } = deps;
  const membership = await requirePermission(db, actorId, orgId, "manage_connectors");
  const name = cleanName(input.name);
  const agentIds = [...new Set(input.agentIds ?? [])];
  await requireEditableAgents(db, membership, orgId, actorId, agentIds);
  await requireSingleMode(db, orgId, input.machineId);
  const problem = await profileMachineProblem(db, deps.hub, orgId, input.machineId);
  if (problem) throw new ValidationError(problem, "browser_profile.machine");
  return db.transaction(async (tx) => {
    await requireFreeName(tx, orgId, name);
    const [row] = await tx
      .insert(browserProfiles)
      .values({ orgId, machineId: input.machineId, name, createdBy: actorId })
      .returning();
    if (!row) throw new Error("profile not created");
    if (agentIds.length > 0) {
      await tx
        .insert(browserProfileGrants)
        .values(agentIds.map((agentId) => ({ orgId, profileId: row.id, agentId, grantedBy: actorId })));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.created",
      target: { type: "browser_profile", id: row.id },
      details: { name, machineId: input.machineId, agentIds },
    });
    return viewOf(row, agentIds);
  });
}

export async function renameBrowserProfile(
  db: Database,
  actorId: string,
  orgId: string,
  profileId: string,
  name: string,
) {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const clean = cleanName(name);
  return db.transaction(async (tx) => {
    const row = await requireProfile(tx, orgId, profileId);
    await requireFreeName(tx, orgId, clean, profileId);
    await tx.update(browserProfiles).set({ name: clean }).where(eq(browserProfiles.id, profileId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.renamed",
      target: { type: "browser_profile", id: profileId },
      details: { from: row.name, name: clean },
    });
    return browserProfileView(tx, orgId, profileId);
  });
}

/**
 * Agents taken off a profile: their turn ends at once, and a default on it goes back to their own browser. Their
 * unfinished runs that followed that default are pinned to the profile first, so the next command reaches the turn
 * check and is told the access was removed, instead of landing silently in the agent's own browser.
 */
async function dropAgents(tx: Executor, orgId: string, profileId: string, agentIds: string[]) {
  if (agentIds.length === 0) return;
  await tx
    .delete(browserProfileGrants)
    .where(and(eq(browserProfileGrants.profileId, profileId), inArray(browserProfileGrants.agentId, agentIds)));
  await tx
    .update(browserProfiles)
    .set({ heldByRunId: null, heldByAgentId: null, heldUntil: null, heldSince: null })
    .where(and(eq(browserProfiles.id, profileId), inArray(browserProfiles.heldByAgentId, agentIds)));
  await tx
    .update(agentRuns)
    .set({ browserProfileId: profileId })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        notInArray(agentRuns.status, ["done", "failed", "canceled"]),
        isNull(agentRuns.browserProfileId),
        sql`${agentRuns.browserProfileOwn} is not true`,
        inArray(agentRuns.agentId, agentIds),
        sql`exists (select 1 from ${agents} a where a.id = ${agentRuns.agentId} and a.browser_profile_id = ${profileId})`,
      ),
    );
  await tx
    .update(agents)
    .set({ browserProfileId: null })
    .where(and(eq(agents.orgId, orgId), eq(agents.browserProfileId, profileId), inArray(agents.id, agentIds)));
}

/**
 * "Mudar quem pode usar": the profile's agents become exactly these (`manage_connectors`, and only agents the
 * person may edit are given or taken). An agent's owner may always take their own agents off, never give.
 * One audit row per agent given or taken.
 */
export async function setBrowserProfileAgents(
  db: Database,
  actorId: string,
  orgId: string,
  profileId: string,
  agentIds: string[],
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const wanted = [...new Set(agentIds)];
  return db.transaction(async (tx) => {
    const row = await requireProfile(tx, orgId, profileId);
    const had = (await grantsOf(tx, [profileId])).get(profileId) ?? [];
    const added = wanted.filter((a) => !had.includes(a));
    const removed = had.filter((a) => !wanted.includes(a));
    if (!can(membership, "manage_connectors")) {
      const owned =
        removed.length === 0
          ? []
          : await tx
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.orgId, orgId), inArray(agents.id, removed), eq(agents.ownerUserId, actorId)));
      if (added.length > 0 || removed.length === 0 || owned.length !== removed.length) throw new ForbiddenError();
    }
    await requireEditableAgents(tx, membership, orgId, actorId, [...added, ...removed]);
    if (added.length > 0) {
      await tx
        .insert(browserProfileGrants)
        .values(added.map((agentId) => ({ orgId, profileId, agentId, grantedBy: actorId })));
    }
    await dropAgents(tx, orgId, profileId, removed);
    for (const [action, list] of [
      ["browser_profile.granted", added],
      ["browser_profile.revoked", removed],
    ] as const) {
      for (const agentId of list) {
        await recordAudit(tx, {
          orgId,
          actor: { type: "person", id: actorId },
          action,
          target: { type: "browser_profile", id: profileId },
          details: { name: row.name, agentId },
        });
      }
    }
    return browserProfileView(tx, orgId, profileId);
  });
}

/** Grants one agent a profile (an admin approving its `request_permission`). */
export async function grantBrowserProfile(
  db: Executor,
  orgId: string,
  profileId: string,
  agentId: string,
  by: { type: "person" | "agent" | "system"; id: string | null },
) {
  const row = await requireProfile(db, orgId, profileId);
  await db
    .insert(browserProfileGrants)
    .values({ orgId, profileId, agentId, grantedBy: by.type === "person" ? by.id : null })
    .onConflictDoNothing();
  await recordAudit(db, {
    orgId,
    actor: by,
    action: "browser_profile.granted",
    target: { type: "browser_profile", id: profileId },
    details: { name: row.name, agentId },
  });
}

/**
 * Deletes a profile: its grants and agents' defaults on it go, its turn ends, and its computer is told to remove
 * its folder (best effort: an offline runner keeps it until it is deleted there).
 */
export async function deleteBrowserProfile(deps: ProfileDeps, actorId: string, orgId: string, profileId: string) {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const row = await db.transaction(async (tx) => {
    const p = await requireProfile(tx, orgId, profileId);
    const had = (await grantsOf(tx, [profileId])).get(profileId) ?? [];
    await dropAgents(tx, orgId, profileId, had);
    await tx
      .update(browserProfiles)
      .set({ deletedAt: new Date(), heldByRunId: null, heldByAgentId: null, heldByUserId: null, heldUntil: null })
      .where(eq(browserProfiles.id, profileId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.deleted",
      target: { type: "browser_profile", id: profileId },
      details: { name: p.name, agents: had.length },
    });
    return p;
  });
  await deps.hub
    ?.call(row.machineId, { op: "browser.profile.delete", profile: { id: profileId } }, { timeoutMs: 30_000 })
    .catch(() => {});
}

/**
 * An agent's default browser: a profile it is granted, or null for its own. Whoever may edit the agent
 * (`manage_agents` or its owner).
 */
export async function setAgentBrowserProfile(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  profileId: string | null,
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId, browserProfileId: agents.browserProfileId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can choose its browser");
  }
  let name: string | null = null;
  if (profileId) {
    const p = await requireProfile(db, orgId, profileId);
    if (!(await isGranted(db, profileId, agentId))) throw new ValidationError("This agent can't use that profile");
    name = p.name;
  }
  if (agent.browserProfileId === profileId) return;
  await db.update(agents).set({ browserProfileId: profileId }).where(eq(agents.id, agentId));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "browser_profile.default_set",
    target: { type: "agent", id: agentId },
    details: { profileId, name },
  });
}

/** The agent may drive the profile: granted a workspace one, or the agent a person's own browser is of. */
const usableBy = (agentId: string) =>
  sql`(${browserProfiles.agentId} = ${agentId} or exists (select 1 from ${browserProfileGrants} g where g.profile_id = ${browserProfiles.id} and g.agent_id = ${agentId}))`;

export async function isGranted(db: Executor, profileId: string, agentId: string) {
  const [g] = await db
    .select({ id: browserProfiles.id })
    .from(browserProfiles)
    .where(and(eq(browserProfiles.id, profileId), usableBy(agentId)));
  return Boolean(g);
}

/**
 * Every agent a profile is granted to, read now (never cached): who shares the sessions signed in there, as a Vault
 * login typed in it checks (ADR 0144).
 */
export async function profileGrantees(db: Executor, orgId: string, profileId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: browserProfileGrants.agentId })
    .from(browserProfileGrants)
    .where(and(eq(browserProfileGrants.orgId, orgId), eq(browserProfileGrants.profileId, profileId)));
  return rows.map((r) => r.agentId);
}

/** The profiles an agent is granted (live ones), oldest grant first. */
export async function agentBrowserProfiles(db: Executor, orgId: string, agentId: string) {
  return db
    .select({ id: browserProfiles.id, name: browserProfiles.name, machineId: browserProfiles.machineId })
    .from(browserProfileGrants)
    .innerJoin(browserProfiles, eq(browserProfiles.id, browserProfileGrants.profileId))
    .where(
      and(
        eq(browserProfileGrants.orgId, orgId),
        eq(browserProfileGrants.agentId, agentId),
        isNull(browserProfiles.deletedAt),
        onSingleModeMachine,
      ),
    )
    .orderBy(asc(browserProfileGrants.createdAt));
}

/**
 * "Pedir mais um perfil": a person who can't grant asks the people who can (`manage_connectors`) to give the agent
 * a profile. An inbox line for them; nothing changes until one of them grants it.
 */
export async function requestBrowserProfile(deps: NotificationDeps, actorId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const [agent] = await deps.db
    .select({
      name: agents.name,
      handle: agents.handle,
      ownerUserId: agents.ownerUserId,
      machineId: sql<string | null>`coalesce(${agents.browserMachineId}, ${agents.machineId})`,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can ask for a profile");
  }
  if (agent.machineId) await requireSingleMode(deps.db, orgId, agent.machineId);
  const members = await deps.db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const deciders: string[] = [];
  for (const m of members) {
    const them = await requireActiveMembership(deps.db, m.userId, orgId).catch(() => null);
    if (them && can(them, "manage_connectors")) deciders.push(m.userId);
  }
  await notify(deps, {
    orgId,
    userIds: deciders,
    kind: "browser_profile_request",
    groupKey: `browser_profile_request:${agentId}`,
    waiting: true,
    actor: { type: "user", id: actorId },
    source: { agentId, label: agent.name || agent.handle },
  });
}

// ── The turn (ADR 0110 §4) ──────────────────────────────────────────────────────

export type TurnResult =
  | {
      ok: true;
      /** The run didn't hold the turn just before: the page is unknown to it (look first). */
      fresh: boolean;
      /** It held a turn of this profile before and another took it since: its command must not run. */
      lost: boolean;
      profile: { id: string; name: string; machineId: string };
    }
  | { ok: false; reason: "busy"; name: string; holder: NonNullable<BrowserProfileView["holder"]> }
  | { ok: false; reason: "revoked" | "deleted"; name: string | null };

/**
 * Takes or renews the turn for a run, in one UPDATE that also checks the grant, with no cache: a revoke made on any
 * replica refuses the very next command. Free means nobody holds it, the hold lapsed, or this run holds it. No row
 * back means busy, revoked or deleted; a second read says which.
 */
export async function takeProfileTurn(
  db: Database,
  at: { orgId: string; profileId: string; agentId: string; runId: string },
  turnMs = PROFILE_TURN_MS,
  retried = false,
): Promise<TurnResult> {
  const { orgId, profileId, agentId, runId } = at;
  const p = browserProfiles;
  const [row] = await db
    .update(p)
    .set({
      heldByRunId: runId,
      heldByAgentId: agentId,
      heldByUserId: null,
      heldUntil: sql`now() + make_interval(secs => ${turnMs / 1000})`,
      heldSince: sql`case when ${p.heldByRunId} = ${runId} then ${p.heldSince} else now() end`,
      lastUsedAt: sql`now()`,
    })
    .where(
      and(
        eq(p.id, profileId),
        eq(p.orgId, orgId),
        isNull(p.deletedAt),
        usableBy(agentId),
        sql`(${p.heldUntil} is null or ${p.heldUntil} < now() or ${p.heldByRunId} = ${runId})`,
      ),
    )
    .returning({ name: p.name, machineId: p.machineId, fresh: sql<boolean>`${p.heldSince} = now()` });
  if (row) {
    const [run] = await db
      .update(agentRuns)
      .set({ browserProfileTurnAt: sql`now()` })
      .where(eq(agentRuns.id, runId))
      .returning({
        before: sql<Date | null>`(select r.browser_profile_turn_at from ${agentRuns} r where r.id = ${runId})`,
      });
    const fresh = row.fresh === true;
    return {
      ok: true,
      fresh,
      lost: fresh && Boolean(run?.before),
      profile: { id: profileId, name: row.name, machineId: row.machineId },
    };
  }
  const [read] = await db
    .select({ row: p, live: sql<boolean>`coalesce(${p.heldUntil} >= now(), false)` })
    .from(p)
    .where(and(eq(p.id, profileId), eq(p.orgId, orgId)));
  const now = read?.row;
  if (!now || now.deletedAt) return { ok: false, reason: "deleted", name: now?.name ?? null };
  if (!(await isGranted(db, profileId, agentId))) return { ok: false, reason: "revoked", name: now.name };
  // Lapsed by the database's clock between the two statements: one more try takes it. The app's clock may differ.
  if (!read?.live && !retried) return takeProfileTurn(db, at, turnMs, true);
  const holder = holderOf(now, 0);
  if (!holder) throw new Error("browser profile turn refused with no holder");
  return { ok: false, reason: "busy", name: now.name, holder };
}

/**
 * A person takes control ("Fazer login"): the turn becomes theirs in one statement, from an agent too (its next
 * command waits; one already on the runner finishes first), never from another person. Null when another person has
 * it.
 */
export async function takeProfileControl(
  db: Database,
  orgId: string,
  profileId: string,
  userId: string,
  ms = PROFILE_CONTROL_MS,
  /** False: not from an agent either (null while an agent's run holds it). */
  overAgent = true,
) {
  const p = browserProfiles;
  const [row] = await db
    .update(p)
    .set({
      heldByRunId: null,
      heldByAgentId: null,
      heldByUserId: userId,
      heldUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
      heldSince: sql`case when ${p.heldByUserId} = ${userId} and ${p.heldUntil} >= now() then ${p.heldSince} else now() end`,
    })
    .where(
      and(
        eq(p.id, profileId),
        eq(p.orgId, orgId),
        isNull(p.deletedAt),
        sql`(${p.heldByUserId} is null or ${p.heldByUserId} = ${userId} or ${p.heldUntil} is null or ${p.heldUntil} < now())`,
        overAgent ? undefined : sql`(${p.heldByAgentId} is null or ${p.heldUntil} is null or ${p.heldUntil} < now())`,
      ),
    )
    .returning();
  return row ?? null;
}

/** The person in control is still there (watching): their hold moves on. False once it isn't theirs. */
export async function touchProfileControl(db: Executor, profileId: string, userId: string, ms = PROFILE_CONTROL_MS) {
  const rows = await db
    .update(browserProfiles)
    .set({ heldUntil: sql`now() + make_interval(secs => ${ms / 1000})` })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.heldByUserId, userId),
        sql`${browserProfiles.heldUntil} >= now()`,
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length > 0;
}

/** Devolver: the person's control ends, and agents may take the turn again. */
export async function releaseProfileControl(db: Executor, orgId: string, profileId: string, userId: string) {
  const rows = await db
    .update(browserProfiles)
    .set({ heldByUserId: null, heldUntil: null, heldSince: null })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.orgId, orgId),
        eq(browserProfiles.heldByUserId, userId),
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length > 0;
}

/** The profile this run's browser commands go to (ADR 0110): its switch, else the agent's default; null = its own. */
export async function runBrowserProfile(
  db: Database,
  at: { orgId: string; agentId: string; runId: string },
): Promise<string | null> {
  const [run] = await db
    .select({ id: agentRuns.browserProfileId, own: agentRuns.browserProfileOwn })
    .from(agentRuns)
    .where(eq(agentRuns.id, at.runId));
  if (run?.own) return null;
  if (run?.id) return run.id;
  const [agent] = await db
    .select({ id: agents.browserProfileId })
    .from(agents)
    .where(and(eq(agents.id, at.agentId), eq(agents.orgId, at.orgId)));
  return agent?.id ?? null;
}

/**
 * Who may drive a profile (log in, open a site, take control, type in it): `manage_connectors` with
 * `control_browsers`, never in a workspace being deleted.
 */
export async function requireProfileDriver(db: Database, userId: string, orgId: string, profileId: string) {
  const own = await requirePersonsOwn(db, userId, orgId, profileId);
  if (own) return own;
  const membership = await requireChangePermission(db, userId, orgId, "manage_connectors");
  if (!can(membership, "control_browsers")) throw new ForbiddenError();
  return requireProfile(db, orgId, profileId);
}

/**
 * Who may watch a profile live: its drivers and the owners of the agents granted it (with `own_browsers`). Never the
 * person behind a run: a profile shows a whole account, so the asker gets the agent's answer, not the screen.
 */
export async function requireProfileWatcher(db: Database, userId: string, orgId: string, profileId: string) {
  const own = await requirePersonsOwn(db, userId, orgId, profileId);
  if (own) return own;
  const membership = await requireActiveMembership(db, userId, orgId);
  const row = await requireProfile(db, orgId, profileId);
  if (can(membership, "manage_connectors") && can(membership, "control_browsers")) return row;
  if (!can(membership, "own_browsers")) throw new ForbiddenError();
  const [owned] = await db
    .select({ id: agents.id })
    .from(browserProfileGrants)
    .innerJoin(agents, eq(agents.id, browserProfileGrants.agentId))
    .where(and(eq(browserProfileGrants.profileId, profileId), eq(agents.ownerUserId, userId)))
    .limit(1);
  if (!owned) throw new ForbiddenError();
  return row;
}

/**
 * A person's own browser of an agent is theirs alone to watch and drive (with `own_browsers`, as their own seat's,
 * ADR 0175): never an admin's, nor the agent's owner's, since it holds that person's sign-ins. Null for a workspace
 * profile (its own rules follow).
 */
async function requirePersonsOwn(db: Database, userId: string, orgId: string, profileId: string) {
  const row = await getBrowserProfile(db, orgId, profileId);
  if (!row?.personUserId) return null;
  const membership = await requireActiveMembership(db, userId, orgId);
  if (row.personUserId !== userId || !can(membership, "own_browsers")) throw new ForbiddenError();
  return requireProfile(db, orgId, profileId, true);
}

// ── A person's own browser in their DM (ADR 0110 addendum 2026-11-15) ─────────────────────────────────────────────

/**
 * The person whose own browser this agent's run drives here: the one person who reads its DM with an agent others
 * may talk to as well (`audience_mode` other than `owner`), so what one person signs in to there never opens signed
 * in for another. Null in a channel, a group conversation, for an agent only its owner talks to, and for the right
 * hand, whose seats already keep each person apart (ADR 0175).
 */
export async function personalBrowserReader(
  db: Executor,
  at: { orgId: string; agentId: string; channelId: string },
): Promise<string | null> {
  const [agent] = await db
    .select({ audienceMode: agents.audienceMode, builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.id, at.agentId), eq(agents.orgId, at.orgId)));
  if (!agent || isRightHand(agent) || agent.audienceMode === "owner") return null;
  return soleReader(db, at.channelId, at.agentId);
}

/**
 * The person's own browser of the agent on `machineId`, made on first use (`make`): one per computer, so a mission's
 * computer and the agent's own each keep theirs. Null where it can't be the agent's browser in full, stable facts on
 * which the DM keeps the agent's own browser as before: a system-mode computer (phase 2), a runner older than
 * `PERSONAL_BROWSER_PROTOCOL` (its files would not be the agent's), and a Chrome that shows on the agent's desktop
 * (`browserOnDesktop`), where everyone who watches that desktop, and the agent's desktop tools in anyone's run, would
 * see this person's signed-in window.
 */
export async function personalBrowserProfile(
  db: Database,
  hub: Pick<MachineCaller, "status" | "call"> | undefined,
  at: { orgId: string; agentId: string; personUserId: string; machineId: string },
  make = true,
): Promise<{ id: string; name: string; machineId: string } | null> {
  if (await systemModeMachine(db, at.orgId, at.machineId)) return null;
  if (await profileMachineProblem(db, hub, at.orgId, at.machineId, PERSONAL_BROWSER_PROTOCOL)) return null;
  if (await browserOnDesktop(db, at.orgId, at.agentId, at.machineId)) return null;
  const live = () =>
    db
      .select({ id: browserProfiles.id, name: browserProfiles.name, machineId: browserProfiles.machineId })
      .from(browserProfiles)
      .where(
        and(
          eq(browserProfiles.orgId, at.orgId),
          eq(browserProfiles.agentId, at.agentId),
          eq(browserProfiles.personUserId, at.personUserId),
          eq(browserProfiles.machineId, at.machineId),
          isNull(browserProfiles.deletedAt),
        ),
      );
  const [had] = await live();
  if (had || !make) return had ?? null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, at.personUserId));
  // Two first commands at once: one row wins (the partial unique index), and both read it.
  await db
    .insert(browserProfiles)
    .values({
      orgId: at.orgId,
      machineId: at.machineId,
      name: (person?.name?.trim() || "Personal").slice(0, PROFILE_NAME_MAX),
      createdBy: at.personUserId,
      agentId: at.agentId,
      personUserId: at.personUserId,
    })
    .onConflictDoNothing();
  const [made] = await live();
  return made ?? null;
}

/**
 * The person's own browser a run's commands go to, for its card: only to whoever reads the run's conversation, and
 * only while the run is in it (no workspace profile switched to or chosen as the agent's default). Null for the
 * agent's own browser or a workspace profile, which the card already knows from its steps.
 */
export async function runPersonalBrowser(
  db: Database,
  userId: string,
  orgId: string,
  runId: string,
): Promise<BrowserProfileView | null> {
  const [run] = await db
    .select({
      agentId: agentRuns.agentId,
      channelId: agentRuns.channelId,
      own: agentRuns.browserProfileOwn,
      profileId: agentRuns.browserProfileId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) throw new NotFoundError("Run not found");
  await requireChannelAccess(db, userId, orgId, run.channelId);
  if (!run.own && run.profileId) return null;
  if (!run.own) {
    const [agent] = await db
      .select({ profileId: agents.browserProfileId })
      .from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.orgId, orgId)));
    if (agent?.profileId) return null;
  }
  const person = await personalBrowserReader(db, { orgId, agentId: run.agentId, channelId: run.channelId });
  if (person !== userId) return null;
  // The one this run holds, else the one last used (a mission's computer has another).
  const [row] = await db
    .select()
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, orgId),
        eq(browserProfiles.agentId, run.agentId),
        eq(browserProfiles.personUserId, userId),
        isNull(browserProfiles.deletedAt),
        onSingleModeMachine,
      ),
    )
    .orderBy(
      sql`(${browserProfiles.heldByRunId} = ${runId}) desc nulls last`,
      sql`${browserProfiles.lastUsedAt} desc nulls last`,
      desc(browserProfiles.createdAt),
    )
    .limit(1);
  // Back on its desktop since (granted it, or a computer that serves desktops): the runs went to the agent's own.
  if (!row || (await browserOnDesktop(db, orgId, run.agentId, row.machineId))) return null;
  return viewOf(row, []);
}

/** How a person's control of a profile drives its runner session: the profile's key stands for the agent. */
export const profileScope = (profileId: string): AgentScope => ({ id: profileKey(profileId), handle: "profile" });

/**
 * A person's control of a profile as the live view and the apps read a take over: the same shape as an agent's
 * handoff, its id and agent the profile's key (`profile:<id>`). Null while no person holds it.
 */
export function profileControlRow(
  p: BrowserProfileRow,
  now = Date.now(),
): typeof schema.browserHandoffs.$inferSelect | null {
  const holder = holderOf(p, now);
  if (holder?.type !== "person" || !p.heldUntil) return null;
  const key = profileKey(p.id);
  return {
    id: key,
    orgId: p.orgId,
    agentId: key,
    runId: null,
    machineId: p.machineId,
    screen: "browser",
    kind: "takeover",
    instructions: "",
    status: "active",
    requestedForUserId: holder.userId,
    controllerUserId: holder.userId,
    seatUserId: null,
    note: null,
    expiresAt: p.heldUntil,
    pageReadAt: null,
    createdAt: p.heldSince ?? p.heldUntil,
    resolvedAt: null,
  };
}

export interface ProfileControlDeps extends ProfileDeps {
  pubsub?: PubSub;
}

/** Every replica's live views of the profile read its control again (`opened`: start the stream again too). */
async function announceProfile(deps: ProfileControlDeps, orgId: string, profileId: string, opened = false) {
  await deps.pubsub
    ?.publish(BROWSER_HANDOFF_TOPIC, {
      type: opened ? "browser.opened" : "browser.handoff.changed",
      orgId,
      agentId: profileKey(profileId),
      screen: "browser",
    })
    .catch(() => {});
}

/**
 * "Fazer login": the person who may drive it takes control of the profile (agents wait meanwhile) and its Chrome
 * starts, so the live view shows a page at once. 409 `browser_profile.busy` while another person has it.
 */
export async function startProfileControl(deps: ProfileControlDeps, userId: string, orgId: string, profileId: string) {
  const row = await requireProfileDriver(deps.db, userId, orgId, profileId);
  const problem = await profileMachineProblem(deps.db, deps.hub, orgId, row.machineId);
  if (problem) throw new ValidationError(problem, "browser_profile.machine");
  const taken = await takeProfileControl(deps.db, orgId, profileId, userId);
  if (!taken) throw new ConflictError("Someone else is using this profile", "browser_profile.busy");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "browser_profile.control",
    target: { type: "browser_profile", id: profileId },
    details: { name: row.name },
  });
  const refused = await warmRefusal(deps, row.machineId, profileId);
  if (refused) {
    // Nothing opens on a refusal: the row says why, with its one way out, instead of a dialog that waits forever.
    await releaseProfileControl(deps.db, orgId, profileId, userId);
    await announceProfile(deps, orgId, profileId);
    throw await profileRefusalError(deps.db, userId, row.machineId, refused);
  }
  await announceProfile(deps, orgId, profileId, true);
  return browserProfileView(deps.db, orgId, profileId);
}

/**
 * Starts the profile's Chrome before its live view opens; the runner's refusal, if any. A timeout is no refusal: a
 * first Chrome download goes on past it, and the live view says so meanwhile.
 */
async function warmRefusal(deps: ProfileControlDeps, machineId: string, profileId: string) {
  if (!deps.hub) return null;
  try {
    await deps.hub.call(
      machineId,
      { op: "browser.warm", agent: profileScope(profileId), profile: { id: profileId } },
      { timeoutMs: 90_000 },
    );
    return null;
  } catch (err) {
    if (err instanceof MachineOfflineError) return { code: "offline", message: err.message };
    if (!(err instanceof MachineRequestError) || err.code === "timeout" || err.code === "canceled") return null;
    return { code: err.code, message: err.message };
  }
}

/**
 * Why "Fazer login" didn't open: `browser_profile.tool_off` when the browser is off on that computer (with whether
 * this person may turn it on there, else whom to ask), else `browser_profile.unavailable` with the computer's words.
 */
async function profileRefusalError(
  db: Executor,
  userId: string,
  machineId: string,
  refused: { code: string; message: string },
) {
  const [m] = await db
    .select({
      name: machines.name,
      kind: machines.kind,
      protocol: machines.protocol,
      pairedByUserId: machines.pairedByUserId,
      ownerName: users.name,
    })
    .from(machines)
    .leftJoin(users, eq(users.id, machines.pairedByUserId))
    .where(eq(machines.id, machineId));
  if (refused.code === "not_allowed" && m) {
    const owner = m.pairedByUserId;
    return new ValidationError(`The browser is turned off on ${m.name}`, "browser_profile.tool_off", {
      machineId,
      machineName: m.name,
      tool: "browser",
      mayAllow: owner === userId && m.kind !== "managed" && m.protocol >= ACCESS_ALLOW_PROTOCOL,
      outdated: owner === userId && m.protocol < ACCESS_ALLOW_PROTOCOL,
      ownerId: owner && owner !== userId && m.kind !== "managed" ? owner : null,
      ownerName: owner && owner !== userId ? (m.ownerName ?? "") : null,
    });
  }
  return new ValidationError(refused.message.slice(0, 300), "browser_profile.unavailable", {
    machineId,
    machineName: m?.name ?? "",
    cause: refused.code,
  });
}

/** Devolver: the person's control ends; agents granted it may use it again. */
export async function endProfileControl(deps: ProfileControlDeps, userId: string, orgId: string, profileId: string) {
  await requireProfile(deps.db, orgId, profileId, true);
  await releaseProfileControl(deps.db, orgId, profileId, userId);
  await announceProfile(deps, orgId, profileId);
  return browserProfileView(deps.db, orgId, profileId);
}

/** How long a person's open may take on the computer (a slow page, or Chrome starting). */
const OPEN_PAGE_SECONDS = 60;

/** The person in control opens a site in the profile (its live view's address field); the views show it at once. */
export async function openProfilePage(
  deps: ProfileControlDeps,
  userId: string,
  orgId: string,
  profileId: string,
  to: string | { go: PageMove },
) {
  const row = await requireProfileDriver(deps.db, userId, orgId, profileId);
  if (holderOf(row)?.type !== "person" || row.heldByUserId !== userId) {
    throw new ConflictError("Take control of the profile first", "browser.not_in_control");
  }
  const { command, args } = pageCommand(to);
  if (!deps.hub) throw new ValidationError("Connected computers are not available on this server");
  const reply = await deps.hub.call<"browser.act">(
    row.machineId,
    {
      op: "browser.act",
      agent: profileScope(profileId),
      profile: { id: profileId },
      command,
      args,
      timeoutSeconds: OPEN_PAGE_SECONDS,
      // The person in control's own move: it runs while they drive (anything else waits for them).
      person: true,
    },
    { timeoutMs: (OPEN_PAGE_SECONDS + 30) * 1000 },
  );
  await touchProfileControl(deps.db, profileId, userId);
  await announceProfile(deps, orgId, profileId, true);
  if (!reply.success) throw new ValidationError(reply.error || "The page didn't open", "browser.open_failed");
}

/** A profile's signed-in sites as the apps show them (ADR 0110, addendum 2026-11-15). */
export interface ProfileSites {
  sites: BrowserSite[];
}

/** What "Sair" removed from one site, and the sites after. */
export interface ProfileSiteSignOut extends ProfileSites {
  site: string;
  cookies: number;
  storage: number;
}

/** How long listing or signing out may take on the computer: its Chrome may have to start first. */
const SITES_TIMEOUT_MS = 90_000;

/** The profile, its driver checked, on a computer whose runner speaks `BROWSER_SITES_PROTOCOL`. */
async function requireSitesProfile(deps: ProfileDeps, userId: string, orgId: string, profileId: string) {
  const row = await requireProfileDriver(deps.db, userId, orgId, profileId);
  const problem = await profileMachineProblem(deps.db, deps.hub, orgId, row.machineId, BROWSER_SITES_PROTOCOL);
  if (problem) throw new ValidationError(problem, "browser_profile.machine");
  if (!deps.hub) throw new ValidationError("Connected computers are not available on this server");
  return { row, hub: deps.hub };
}

/**
 * The sites a profile is signed in to: hosts and counts, never a cookie or what a site stored. Its drivers only
 * (`requireProfileDriver`); its Chrome starts on the computer when it isn't running, so the apps ask only when a person
 * opens the list.
 */
export async function listProfileSites(
  deps: ProfileDeps,
  userId: string,
  orgId: string,
  profileId: string,
): Promise<ProfileSites> {
  const { row, hub } = await requireSitesProfile(deps, userId, orgId, profileId);
  const reply = await hub.call<"browser.sites">(
    row.machineId,
    { op: "browser.sites", agent: profileScope(profileId), profile: { id: profileId } },
    { timeoutMs: SITES_TIMEOUT_MS },
  );
  return { sites: reply.sites };
}

/**
 * "Sair": the profile signs out of one site, its cookies and its stored data. Refused (409 `browser_profile.busy`)
 * while an agent's run or another person has the profile; otherwise the person holds it for the moment it runs, so no
 * agent's command lands meanwhile, and gives it back unless they were in control already.
 */
export async function signOutProfileSite(
  deps: ProfileControlDeps,
  userId: string,
  orgId: string,
  profileId: string,
  site: string,
): Promise<ProfileSiteSignOut> {
  const host = site.trim().toLowerCase();
  if (!BROWSER_SITE_HOST.test(host)) throw new ValidationError("Which site?", "browser_profile.site");
  const { row, hub } = await requireSitesProfile(deps, userId, orgId, profileId);
  const holder = holderOf(row);
  const already = holder?.type === "person" && holder.userId === userId;
  const taken = await takeProfileControl(deps.db, orgId, profileId, userId, PROFILE_CONTROL_MS, false);
  if (!taken) throw new ConflictError("Someone else is using this profile", "browser_profile.busy");
  let reply: MachineReplies["browser.sites.forget"];
  try {
    reply = await hub.call<"browser.sites.forget">(
      row.machineId,
      { op: "browser.sites.forget", site: host, agent: profileScope(profileId), profile: { id: profileId } },
      { timeoutMs: SITES_TIMEOUT_MS },
    );
  } finally {
    if (!already) {
      await releaseProfileControl(deps.db, orgId, profileId, userId);
      await announceProfile(deps, orgId, profileId);
    }
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "browser_profile.site_signed_out",
    target: { type: "browser_profile", id: profileId },
    details: { name: row.name, site: host, cookies: reply.cookies, storage: reply.storage },
  });
  return { site: host, cookies: reply.cookies, storage: reply.storage, sites: reply.sites };
}
