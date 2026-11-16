import { and, asc, type Database, eq, schema, sql } from "@agenteschat/db";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { requirePermission } from "./organizations";

const { sidebarLinks } = schema;

/**
 * A person's own links in their sidebar (ADR 0083, amendment of 2026-11-15): at most this many per workspace. Mirrors
 * `SIDEBAR_LINK_LIMIT` in packages/client/src/lib/sidebar-links.ts.
 */
export const SIDEBAR_LINK_LIMIT = 10;
export const SIDEBAR_LINK_TITLE_MAX = 60;
export const SIDEBAR_LINK_URL_MAX = 2048;

export interface SidebarLink {
  id: string;
  title: string;
  url: string;
}

/** `new URL` throws on what isn't an address: that is the answer, not a failure. */
function parsed(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * The address as stored, or null when it can't be one: `https:` with a host, no user or password in it, at most
 * `SIDEBAR_LINK_URL_MAX` characters once the URL parser writes it back. The apps open it in a new tab and the server
 * never fetches it. Mirrors `sidebarLinkUrl` in packages/client/src/lib/sidebar-links.ts.
 */
export function sidebarLinkUrl(raw: string): string | null {
  const url = parsed(raw.trim());
  if (url?.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.href.length <= SIDEBAR_LINK_URL_MAX ? url.href : null;
}

const mine = (orgId: string, userId: string) => and(eq(sidebarLinks.orgId, orgId), eq(sidebarLinks.userId, userId));

const list = (db: Database, orgId: string, userId: string): Promise<SidebarLink[]> =>
  db
    .select({ id: sidebarLinks.id, title: sidebarLinks.title, url: sidebarLinks.url })
    .from(sidebarLinks)
    .where(mine(orgId, userId))
    .orderBy(asc(sidebarLinks.position), asc(sidebarLinks.createdAt));

/** The person's links in this workspace, in their order. */
export async function mySidebarLinks(db: Database, orgId: string, userId: string): Promise<SidebarLink[]> {
  await requirePermission(db, userId, orgId, "read");
  return list(db, orgId, userId);
}

/**
 * Adds a link at the end of the person's list here and answers with the whole list. A per-person lock counts and
 * inserts as one step, so two adds at once never pass `SIDEBAR_LINK_LIMIT`.
 */
export async function addMySidebarLink(
  db: Database,
  orgId: string,
  userId: string,
  input: { title: string; url: string },
): Promise<SidebarLink[]> {
  await requirePermission(db, userId, orgId, "read");
  const title = input.title.trim();
  if (!title || title.length > SIDEBAR_LINK_TITLE_MAX)
    throw new ValidationError(`A title is 1 to ${SIDEBAR_LINK_TITLE_MAX} characters`, "sidebar_link.title", {
      max: SIDEBAR_LINK_TITLE_MAX,
    });
  const url = sidebarLinkUrl(input.url);
  if (!url) throw new ValidationError("A link is an https address", "sidebar_link.url");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sidebar-links:${orgId}:${userId}`}))`);
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int`, last: sql<number | null>`max(${sidebarLinks.position})` })
      .from(sidebarLinks)
      .where(mine(orgId, userId));
    if ((row?.count ?? 0) >= SIDEBAR_LINK_LIMIT)
      throw new ConflictError(`At most ${SIDEBAR_LINK_LIMIT} links`, "sidebar_link.full", { max: SIDEBAR_LINK_LIMIT });
    await tx.insert(sidebarLinks).values({ orgId, userId, title, url, position: (row?.last ?? -1) + 1 });
  });
  return list(db, orgId, userId);
}

/** Removes one of the person's links here (another's is not found) and answers with the rest, in their order. */
export async function removeMySidebarLink(
  db: Database,
  orgId: string,
  userId: string,
  linkId: string,
): Promise<SidebarLink[]> {
  await requirePermission(db, userId, orgId, "read");
  const gone = await db
    .delete(sidebarLinks)
    .where(and(mine(orgId, userId), eq(sidebarLinks.id, linkId)))
    .returning({ id: sidebarLinks.id });
  if (gone.length === 0) throw new NotFoundError("No such link");
  return list(db, orgId, userId);
}
