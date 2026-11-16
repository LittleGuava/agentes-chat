import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { settleJoinRequests } from "./invite-requests";
import { addressDomain } from "./mail/text";
import {
  announceMembers,
  assertInviting,
  auditMember,
  getMembership,
  joinOrganization,
  requirePermission,
} from "./organizations";
import { givableRoleIds, stillGivableRoleIds } from "./roles";
import { accountInUse, assertCanWork, openOrg } from "./standing";

const { auditLog, organizationJoinDomains, organizationMembers, organizations, users } = schema;

/** Domains a workspace names at most. */
export const MAX_JOIN_DOMAINS = 10;

/**
 * Mailbox providers anyone can get an address at: a workspace naming one would take in strangers (ADR 0068, addendum
 * 2026-11-15). Never complete; the admin's own confirmed address at the domain is the stronger rule.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.br",
  "hotmail.com",
  "hotmail.com.br",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "yahoo.co.uk",
  "yahoo.fr",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
]);

/**
 * Providers with a domain per country (`outlook.de`, `hotmail.co.uk`, `yahoo.com.br`): the name and then only a
 * country's suffix, one or two labels of at most 3 letters. `live.acme.com` is a company's own subdomain.
 */
const PUBLIC_MAIL_FAMILIES: ReadonlySet<string> = new Set([
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "gmx",
  "aol",
  "yandex",
  "zoho",
  "proton",
  "protonmail",
]);

const isPublicMail = (domain: string) => {
  if (PUBLIC_MAIL_DOMAINS.has(domain)) return true;
  const [name = "", ...suffix] = domain.split(".");
  return PUBLIC_MAIL_FAMILIES.has(name) && suffix.length <= 2 && suffix.every((label) => label.length <= 3);
};

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A domain as typed (`@Acme.com `) as it is stored (`acme.com`); refused when it isn't a host or is public. */
export function normalizeJoinDomain(input: string) {
  const domain = input.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!HOST.test(domain)) throw new ValidationError("That isn't a domain", "join_domain.invalid");
  if (isPublicMail(domain)) {
    throw new ValidationError("Anyone can have an address at this domain", "join_domain.public", { domain });
  }
  return domain;
}

export interface JoinDomain {
  id: string;
  domain: string;
  roleIds: string[];
  createdAt: Date;
}

const DOMAIN_COLUMNS = {
  id: organizationJoinDomains.id,
  domain: organizationJoinDomains.domain,
  roleIds: organizationJoinDomains.roleIds,
  createdAt: organizationJoinDomains.createdAt,
};

/** The workspace's domains (`manage_members`). */
export async function listJoinDomains(db: Database, actorId: string, orgId: string): Promise<JoinDomain[]> {
  await requirePermission(db, actorId, orgId, "manage_members");
  return db
    .select(DOMAIN_COLUMNS)
    .from(organizationJoinDomains)
    .where(eq(organizationJoinDomains.orgId, orgId))
    .orderBy(organizationJoinDomains.domain);
}

/**
 * Adds a domain, or changes the cargos of one already there (`manage_members`). Only one the admin's own confirmed
 * address is at: otherwise any workspace could show itself to everyone at another company.
 */
export async function addJoinDomain(
  db: Database,
  actorId: string,
  orgId: string,
  input: { domain: string; roleIds?: string[] },
): Promise<JoinDomain> {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  assertInviting(actor);
  const domain = normalizeJoinDomain(input.domain);
  const [me] = await db
    .select({ email: users.email, verified: users.emailVerified })
    .from(users)
    .where(eq(users.id, actorId));
  if (!me?.verified || addressDomain(me.email) !== domain) {
    throw new ForbiddenError("Only a domain your own confirmed address is at", "join_domain.not_yours", { domain });
  }
  const roleIds = await givableRoleIds(db, actor, orgId, input.roleIds ?? []);
  return db.transaction(async (tx) => {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.orgId, orgId), sql`${organizationJoinDomains.domain} <> ${domain}`));
    if (n >= MAX_JOIN_DOMAINS) {
      throw new ConflictError("A workspace names at most 10 domains", "join_domain.too_many", {
        max: MAX_JOIN_DOMAINS,
      });
    }
    const [row] = await tx
      .insert(organizationJoinDomains)
      .values({ orgId, domain, roleIds, createdByUserId: actorId })
      .onConflictDoUpdate({
        target: [organizationJoinDomains.orgId, organizationJoinDomains.domain],
        set: { roleIds, createdByUserId: actorId },
      })
      .returning(DOMAIN_COLUMNS);
    if (!row) throw new Error("join domain not saved");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "join_domain.added",
      target: { type: "join_domain", id: row.id },
      details: { domain, roleIds },
    });
    return row;
  });
}

/** Removes a domain (`manage_members`): its addresses come in by invitation again; who joined stays. */
export async function removeJoinDomain(db: Database, actorId: string, orgId: string, id: string) {
  await requirePermission(db, actorId, orgId, "manage_members");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.orgId, orgId), eq(organizationJoinDomains.id, id)))
      .returning({ domain: organizationJoinDomains.domain });
    if (!row) throw new NotFoundError("Domain not found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "join_domain.removed",
      target: { type: "join_domain", id },
      details: { domain: row.domain },
    });
  });
}

/** Someone an admin removed from the workspace: they come back by invitation, never by domain. */
const removedFrom = (orgId: unknown, userId: string) => sql<boolean>`exists (
  select 1 from ${auditLog}
  where ${auditLog.orgId} = ${orgId} and ${auditLog.action} = 'member.removed'
    and ${auditLog.targetType} = 'person' and ${auditLog.targetId} = ${userId}
)`;

/** The account's domain, when it may join by it: a confirmed address, an account in use. */
async function joiningDomain(db: Executor, userId: string) {
  const [user] = await db
    .select({ email: users.email, verified: users.emailVerified, open: accountInUse })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.verified || !user.open) return null;
  return addressDomain(user.email) || null;
}

/**
 * The active workspaces naming this account's domain that it isn't in and may join: id, name and logo only, never
 * who is in them. None for an address that isn't confirmed.
 */
export async function domainWorkspaces(
  db: Database,
  userId: string,
): Promise<{ id: string; name: string; logo: string | null }[]> {
  const domain = await joiningDomain(db, userId);
  if (!domain) return [];
  return db
    .select({ id: organizations.id, name: organizations.name, logo: organizations.logo })
    .from(organizationJoinDomains)
    .innerJoin(organizations, eq(organizations.id, organizationJoinDomains.orgId))
    .where(
      and(
        eq(organizationJoinDomains.domain, domain),
        openOrg,
        sql`not exists (select 1 from ${organizationMembers} where ${organizationMembers.orgId} = ${organizations.id} and ${organizationMembers.userId} = ${userId})`,
        sql`not ${removedFrom(organizations.id, userId)}`,
      ),
    )
    .orderBy(organizations.name);
}

/**
 * Joins a workspace that names the account's domain. Everything is read again in the transaction; `joinOrganization`
 * takes the `org-members` lock and refuses a full or closed workspace. The cargos are those whoever added the domain
 * could still give. Audited as `member.joined { via: "domain" }`.
 */
export async function joinByDomain(deps: { db: Database; pubsub?: PubSub }, userId: string, orgId: string) {
  const notAllowed = () =>
    new ForbiddenError("This workspace doesn't take your address's domain", "join_domain.not_allowed");
  const joined = await deps.db.transaction(async (tx) => {
    const domain = await joiningDomain(tx, userId);
    if (!domain) throw notAllowed();
    const [row] = await tx
      .select({
        roleIds: organizationJoinDomains.roleIds,
        giverId: organizationJoinDomains.createdByUserId,
        removed: removedFrom(organizationJoinDomains.orgId, userId),
      })
      .from(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.orgId, orgId), eq(organizationJoinDomains.domain, domain)));
    if (!row || row.removed) throw notAllowed();
    await assertCanWork(tx, orgId);
    if (await getMembership(tx, userId, orgId, { includeBlocked: true })) return false;
    const giver = row.giverId ? await getMembership(tx, row.giverId, orgId) : null;
    const roleIds = await stillGivableRoleIds(tx, giver, orgId, row.roleIds);
    await joinOrganization(tx, orgId, userId, "member", roleIds);
    await auditMember(tx, orgId, userId, "member.joined", userId, { role: "member", roleIds, via: "domain", domain });
    return true;
  });
  if (joined) {
    await announceMembers(deps.pubsub, orgId);
    // A request to join they had waiting closed as they joined: the admins' notice goes with the last one.
    await settleJoinRequests(deps, orgId);
  }
  return { orgId };
}
