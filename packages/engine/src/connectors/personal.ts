import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { type RunAuthority, runAuthorityById } from "../authority";
import { caches } from "../cache";
import { randomToken, sha256 } from "../crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { composioUserId } from "../mail/accounts";
import { getMembership, requireChangePermission } from "../organizations";
import { activeComposioAccount, type ComposioConnectors, composioServiceOf, forgetComposioAccount } from "./composio";
import {
  type ConnectOutcome,
  type ConnectorConnection,
  type ConnectorDeps,
  OAUTH_STATE_TTL_MS,
  oauthRedirectUri,
} from "./connections";
import { providerAccount } from "./custom";
import { oauthReturnTo } from "./oauth-return";

/**
 * Connections that use each person's own account (ADR 0195): the workspace connection keeps its tools, grants and
 * rules; a call goes through the account of the person behind the run, never the workspace connection's.
 */

const { connectorConnections, connectorPersonalAccounts, oauthStates, users } = schema;

export type PersonalAccount = typeof connectorPersonalAccounts.$inferSelect;

/** One's own account on a per-person connection, as its owner sees it (never anyone else's). */
export interface PersonalAccountView {
  accountLabel: string | null;
  status: "active" | "needs_reconnect";
}

/** Why a per-person connection's call can't run, as the code the agent and the apps read. */
export type PersonalRefusalCode =
  | "connector.personal_missing"
  | "connector.personal_needs_reconnect"
  | "connector.personal_routine"
  | "connector.personal_nobody";

/** What people and agents read for a per-person connection: the service ("Google Drive"), never one account. */
export const personalServiceLabel = (c: Pick<ConnectorConnection, "serverUrl" | "label">) =>
  composioServiceOf(c.serverUrl)?.preset.label ?? c.label;

const WHERE = "Settings › Connectors and MCPs";

/**
 * Whether a per-person connection's call may run, and why not (ADR 0195 §3): only a run a person is behind, with an
 * account of their own that works. The words are the agent's, in English like every tool result.
 */
export function personalRefusal(input: {
  behind: RunAuthority["kind"];
  service: string;
  person: string | null;
  account: Pick<PersonalAccount, "status"> | null;
}): { code: PersonalRefusalCode; message: string } | null {
  const { service } = input;
  if (input.behind === "routine") {
    return {
      code: "connector.personal_routine",
      message: `${service} uses each person's own account in this workspace, and a routine's run never acts as a person, its creator included. Say in hand_off that this needs ${service} and someone must do it themselves.`,
    };
  }
  if (input.behind !== "person" || !input.person) {
    return {
      code: "connector.personal_nobody",
      message: `${service} uses each person's own account in this workspace, and nobody is behind this run: only a run a person asked for can use their account.`,
    };
  }
  if (!input.account) {
    return {
      code: "connector.personal_missing",
      message: `${service} uses each person's own account in this workspace, and ${input.person} hasn't connected theirs. Ask them to connect it in ${WHERE} (Connect my account), then try again.`,
    };
  }
  if (input.account.status !== "active") {
    return {
      code: "connector.personal_needs_reconnect",
      message: `${input.person}'s ${service} account stopped working (its sign-in expired or was removed). Ask them to connect it again in ${WHERE} (Connect my account).`,
    };
  }
  return null;
}

/** The account a per-person connection's call goes through for this run, or why it can't (ADR 0195 §3). */
export async function personalAccountFor(
  db: Executor,
  connection: Pick<ConnectorConnection, "id" | "orgId" | "serverUrl" | "label">,
  runId: string,
): Promise<{ account: PersonalAccount } | { refused: { code: PersonalRefusalCode; message: string } }> {
  const service = personalServiceLabel(connection);
  const authority = await runAuthorityById(db, connection.orgId, runId);
  const nobody = (behind: RunAuthority["kind"]) => {
    const refused = personalRefusal({ behind, service, person: null, account: null });
    if (!refused) throw new Error("a run nobody is behind is always refused");
    return { refused };
  };
  if (authority.kind !== "person") return nobody(authority.kind);
  // Someone who left the workspace is nobody here: their account never runs for it.
  if (!(await getMembership(db, authority.personId, connection.orgId))) return nobody("unattended");
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, authority.personId));
  const [account] = await liveAccounts(db, connection.id, authority.personId);
  const refused = personalRefusal({
    behind: "person",
    service,
    person: person?.name || "the person you work for",
    account: account ?? null,
  });
  if (refused || !account) return { refused: refused ?? nobody("unattended").refused };
  return { account };
}

const liveAccounts = (db: Executor, connectionId: string, ownerUserId: string) =>
  db
    .select()
    .from(connectorPersonalAccounts)
    .where(
      and(
        eq(connectorPersonalAccounts.connectionId, connectionId),
        eq(connectorPersonalAccounts.ownerUserId, ownerUserId),
        isNull(connectorPersonalAccounts.revokedAt),
      ),
    );

/** A person's account the provider refused: theirs alone to reconnect (ADR 0195 §4). */
export async function markPersonalToReconnect(db: Database, account: Pick<PersonalAccount, "id">, reason: string) {
  await db
    .update(connectorPersonalAccounts)
    .set({ status: "needs_reconnect", lastError: reason.slice(0, 300), updatedAt: new Date() })
    .where(and(eq(connectorPersonalAccounts.id, account.id), isNull(connectorPersonalAccounts.revokedAt)));
}

async function liveConnection(db: Executor, orgId: string, connectionId: string) {
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, connectionId),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) throw new NotFoundError("This connection is no longer here", "connector.gone");
  return c;
}

/**
 * Turns each person's own account on or off for a connection (managers of connectors). Only a service through
 * Composio, for now. Off drops every personal account of it at Composio: calls go through the workspace's again.
 */
export async function setPerPerson(
  deps: Pick<ConnectorDeps, "db" | "composio">,
  actorId: string,
  orgId: string,
  connectionId: string,
  perPerson: boolean,
) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await liveConnection(deps.db, orgId, connectionId);
  if (perPerson && !composioServiceOf(c.serverUrl)) {
    throw new ValidationError(
      "Only a service through Composio can use each person's own account for now",
      "connector.per_person_unsupported",
    );
  }
  if (c.perPerson !== perPerson) {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(connectorConnections)
        .set({ perPerson, updatedAt: new Date() })
        .where(eq(connectorConnections.id, c.id));
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "connector.per_person_changed",
        target: { type: "connector", id: c.id },
        details: { label: c.label, perPerson },
      });
    });
    caches.connections.delete(`${orgId}:active`);
  }
  if (!perPerson) await forgetPersonalAccounts(deps, orgId, c.id);
  return { ...c, perPerson };
}

/**
 * Drops every live personal account of a connection, here and at Composio (best effort, never revoking a grant
 * Composio's apps share): the connection went away or stopped being per person.
 */
export async function forgetPersonalAccounts(
  deps: { db: Executor; composio?: Pick<ComposioConnectors, "client"> | null },
  orgId: string,
  connectionId: string,
) {
  const gone = await deps.db
    .update(connectorPersonalAccounts)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(connectorPersonalAccounts.orgId, orgId),
        eq(connectorPersonalAccounts.connectionId, connectionId),
        isNull(connectorPersonalAccounts.revokedAt),
      ),
    )
    .returning({ accountId: connectorPersonalAccounts.composioAccountId });
  if (deps.composio) for (const g of gone) await forgetComposioAccount(deps.composio.client, g.accountId);
}

/**
 * "Connect my account" (any member): a Composio Connect Link under the workspace's Composio user, so its calls count
 * against the workspace's cap, back to our OAuth callback with a state only this person finishes.
 */
export async function beginPersonalConnect(
  deps: ConnectorDeps,
  actorId: string,
  orgId: string,
  connectionId: string,
  input: { returnTo?: string },
): Promise<{ authorizeUrl: string }> {
  await requireChangePermission(deps.db, actorId, orgId, "read");
  const c = await liveConnection(deps.db, orgId, connectionId);
  if (!c.perPerson) {
    throw new ValidationError("This connection doesn't use each person's own account", "connector.not_per_person");
  }
  const service = composioServiceOf(c.serverUrl);
  const composio = deps.composio;
  if (!service || !composio) {
    throw new ValidationError(`${personalServiceLabel(c)} can't be connected on this server`, "connector.unavailable");
  }
  const state = randomToken(32);
  const link = await composio.client.createConnectLink({
    toolkit: service.way.toolkit,
    userId: composioUserId(orgId),
    callbackUrl: `${oauthRedirectUri(deps.publicUrl)}?state=${state}`,
  });
  await deps.db.insert(oauthStates).values({
    orgId,
    connector: c.connector,
    userId: actorId,
    stateHash: sha256(state),
    serverUrl: c.serverUrl,
    returnTo: oauthReturnTo(input.returnTo),
    connectionId: c.id,
    composioAccountId: link.connectedAccountId,
    forPerson: true,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + OAUTH_STATE_TTL_MS),
  });
  const url = new URL(link.redirectUrl);
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString() };
}

/**
 * Back from Composio with a person's own account (the caller checked the state is theirs, unused, and that they are
 * still a member of a workspace that isn't closing). It replaces the account they had here, which goes away at
 * Composio.
 */
export async function completePersonalConnect(
  deps: ConnectorDeps,
  user: { id: string },
  row: typeof oauthStates.$inferSelect,
  code: string,
): Promise<{ connection: ConnectorConnection; returnTo: string; outcome: ConnectOutcome; personal: true }> {
  const composio = deps.composio;
  if (!composio) throw new ValidationError("Composio is not set up on this server", "connector.unavailable");
  const remote = await activeComposioAccount(deps, composio, row, code);
  try {
    const c = await liveConnection(deps.db, row.orgId, row.connectionId ?? "");
    if (!c.perPerson) throw new ConflictError("This connection no longer uses each person's account", "connector.gone");
    const service = composioServiceOf(c.serverUrl);
    const asked = await providerAccount(
      deps,
      service?.preset.account,
      { serverUrl: c.serverUrl, orgId: c.orgId, composioAccountId: code },
      {},
    );
    const accountLabel = asked?.name ?? remote.displayName ?? remote.address ?? null;
    const replaced = await deps.db.transaction(async (tx) => {
      const old = await tx
        .update(connectorPersonalAccounts)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(connectorPersonalAccounts.connectionId, c.id),
            eq(connectorPersonalAccounts.ownerUserId, user.id),
            isNull(connectorPersonalAccounts.revokedAt),
          ),
        )
        .returning({ accountId: connectorPersonalAccounts.composioAccountId });
      await tx.insert(connectorPersonalAccounts).values({
        orgId: c.orgId,
        connectionId: c.id,
        ownerUserId: user.id,
        composioAccountId: code,
        accountLabel,
      });
      await recordAudit(tx, {
        orgId: c.orgId,
        actor: { type: "person", id: user.id },
        action: "connector.personal_connected",
        target: { type: "connector", id: c.id },
        details: { label: c.label },
      });
      return old;
    });
    for (const old of replaced) await forgetComposioAccount(composio.client, old.accountId);
    return {
      connection: c,
      returnTo: row.returnTo,
      outcome: replaced.length > 0 ? "reconnected" : "connected",
      personal: true,
    };
  } catch (error) {
    await forgetComposioAccount(composio.client, code);
    throw error;
  }
}

/** "Disconnect my account": one's own account on a connection goes, here and at Composio. */
export async function disconnectPersonal(
  deps: Pick<ConnectorDeps, "db" | "composio">,
  actorId: string,
  orgId: string,
  connectionId: string,
) {
  await requireChangePermission(deps.db, actorId, orgId, "read");
  const gone = await deps.db
    .update(connectorPersonalAccounts)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(connectorPersonalAccounts.orgId, orgId),
        eq(connectorPersonalAccounts.connectionId, connectionId),
        eq(connectorPersonalAccounts.ownerUserId, actorId),
        isNull(connectorPersonalAccounts.revokedAt),
      ),
    )
    .returning({ accountId: connectorPersonalAccounts.composioAccountId });
  if (gone.length === 0) return;
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "connector.personal_disconnected",
    target: { type: "connector", id: connectionId },
    details: {},
  });
  if (deps.composio) for (const g of gone) await forgetComposioAccount(deps.composio.client, g.accountId);
}

/** The caller's own live accounts in a workspace, by connection. */
export async function myPersonalAccounts(db: Executor, userId: string, orgId: string) {
  const rows = await db
    .select({
      connectionId: connectorPersonalAccounts.connectionId,
      accountLabel: connectorPersonalAccounts.accountLabel,
      status: connectorPersonalAccounts.status,
    })
    .from(connectorPersonalAccounts)
    .where(
      and(
        eq(connectorPersonalAccounts.orgId, orgId),
        eq(connectorPersonalAccounts.ownerUserId, userId),
        isNull(connectorPersonalAccounts.revokedAt),
      ),
    );
  return new Map<string, PersonalAccountView>(
    rows.map((r) => [
      r.connectionId,
      { accountLabel: r.accountLabel, status: r.status === "needs_reconnect" ? "needs_reconnect" : "active" },
    ]),
  );
}
