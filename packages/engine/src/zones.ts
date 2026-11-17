import { and, type Database, eq, schema } from "@agenteschat/db";
import { caches } from "./cache";

/** The person's IANA zone in this organization, else the organization's ("UTC" without either). */
export async function zoneOf(db: Database, orgId: string, userId: string | null) {
  return (await caches.zones.getOrLoad(`${orgId}:${userId ?? ""}`, () => loadZone(db, orgId, userId))) as string;
}

async function loadZone(db: Database, orgId: string, userId: string | null) {
  const { organizations, organizationMembers, organizationSettings } = schema;
  const [row] = await db
    .select({ mine: organizationMembers.timezone, org: organizationSettings.timezone })
    .from(organizations)
    .leftJoin(organizationSettings, eq(organizationSettings.orgId, organizations.id))
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, organizations.id), eq(organizationMembers.userId, userId ?? "")),
    )
    .where(eq(organizations.id, orgId));
  return row?.mine ?? row?.org ?? "UTC";
}

/** A zone the formatter knows, else "UTC". */
export function safeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
