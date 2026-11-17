/**
 * Public pages (ADR 0211): a Drive page at one version, opened by anyone with its address on the server's pages host
 * (`PUBLISHED_PAGES_URL`). An agent publishes with `publish_page`, which a person approves; whoever reads the file and
 * every administrator take it down. The address answers only while the page is live, its file out of the trash and
 * its workspace open, and says nothing about which of these failed.
 */
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, isNull, schema, sql } from "@agenteschat/db";
import { type ArtifactActor, type ArtifactDeps, fileRefOf, getArtifact, pageHtmlAt } from "./artifacts";
import { recordAudit } from "./audit";
import { UUID } from "./authority";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { PUBLISHED_PAGES_MAX } from "./limits";
import { can, requireActiveMembership } from "./organizations";
import { personBehindCall } from "./requester";
import { replyThreadOf } from "./runs";
import { openOrg } from "./standing";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { publishedPages, artifacts, organizations } = schema;

export const PUBLISH_PAGE_TOOL = "publish_page";

/** 32 random bytes in base64url: 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const newToken = () => randomBytes(32).toString("base64url");

/** A page's address on the pages host. Its trailing `/` lets a later folder's relative links resolve under it. */
export const publishedPageUrl = (baseUrl: string, token: string) => `${baseUrl}/p/${token}/`;

export interface PublishedPageView {
  id: string;
  artifactId: string;
  title: string;
  version: number;
  url: string;
  createdBy: { type: "person" | "agent"; id: string };
  createdAt: string;
  updatedAt: string;
}

type PageRow = typeof publishedPages.$inferSelect;

const viewOf = (row: PageRow, title: string, baseUrl: string): PublishedPageView => ({
  id: row.id,
  artifactId: row.artifactId,
  title,
  version: row.version,
  url: publishedPageUrl(baseUrl, row.token),
  createdBy: { type: row.createdByType as "person" | "agent", id: row.createdById },
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type AgentActor = Extract<ArtifactActor, { type: "agent" }>;

/**
 * What must hold before anyone is asked and again when the approved call runs: the agent reaches the file, the person
 * behind the run reads it (a page never shows what the one who asked can't see), it is a page, and the version is
 * one it has. Returns the file's title.
 */
async function publishable(deps: ArtifactDeps, orgId: string, artifactId: string, version: number, agent: AgentActor) {
  const file = await getArtifact(deps, agent, orgId, artifactId, version);
  if (file.kind !== "html") {
    throw new ValidationError(
      `Only a page is published: "${file.title}" is a ${file.kind}. Make the page with create_artifact (kind html) first.`,
      "published_page.not_a_page",
    );
  }
  return file;
}

/**
 * Publishes a page at the version given (ADR 0211 §3). A file with a live page moves it to that version and keeps
 * its address, so running it again ends where it ended. Audited.
 */
export async function publishPage(
  deps: ArtifactDeps,
  input: { orgId: string; artifactId: string; version: number; agent: AgentActor; personId: string; baseUrl: string },
): Promise<PublishedPageView & { moved: boolean }> {
  const { db } = deps;
  const { orgId, artifactId, version, agent, personId } = input;
  const file = await publishable(deps, orgId, artifactId, version, agent);
  if (!(await fileRefOf(db, personId, orgId, artifactId))) {
    throw new ForbiddenError(
      "The person who asked can't open this file, so it isn't published for them. Ask someone who sees it.",
      "published_page.person_cannot_read",
    );
  }
  return db.transaction(async (tx) => {
    // One publish of a workspace at a time: the count and the insert agree.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`published_pages:${orgId}`}, 0))`);
    const [live] = await tx
      .select()
      .from(publishedPages)
      .where(and(eq(publishedPages.artifactId, artifactId), isNull(publishedPages.revokedAt)));
    let row: PageRow | undefined;
    if (live) {
      [row] = await tx
        .update(publishedPages)
        .set({ version, updatedAt: new Date() })
        .where(eq(publishedPages.id, live.id))
        .returning();
    } else {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(publishedPages)
        .where(and(eq(publishedPages.orgId, orgId), isNull(publishedPages.revokedAt)));
      if (n >= PUBLISHED_PAGES_MAX) {
        throw new ConflictError(
          `The workspace already has ${PUBLISHED_PAGES_MAX} public pages, the most it keeps. Ask the person to take one down in its file's Compartilhar first.`,
          "published_page.too_many",
          { max: PUBLISHED_PAGES_MAX },
        );
      }
      [row] = await tx
        .insert(publishedPages)
        .values({
          orgId,
          artifactId,
          version,
          token: newToken(),
          createdByType: "agent",
          createdById: agent.agentId,
          runId: agent.runId ?? null,
        })
        .returning();
    }
    if (!row) throw new NotFoundError("Published page not found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "agent", id: agent.agentId },
      action: "artifact.page_published",
      target: { type: "artifact", id: artifactId },
      details: { pageId: row.id, version, moved: Boolean(live) },
      runId: agent.runId ?? null,
      channelId: agent.channelId,
      onBehalfOfUserId: personId,
    });
    return { ...viewOf(row, file.title, input.baseUrl), moved: Boolean(live) };
  });
}

/** The live pages a person may take down: every one for an administrator, else those of files they read. */
export async function listPublishedPages(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  filter: { artifactId?: string; baseUrl: string },
): Promise<PublishedPageView[]> {
  const membership = await requireActiveMembership(deps.db, userId, orgId);
  if (filter.artifactId !== undefined && !UUID.test(filter.artifactId)) return [];
  const rows = await deps.db
    .select({ page: publishedPages, title: artifacts.title })
    .from(publishedPages)
    .innerJoin(artifacts, eq(artifacts.id, publishedPages.artifactId))
    .where(
      and(
        eq(publishedPages.orgId, orgId),
        isNull(publishedPages.revokedAt),
        isNull(artifacts.deletedAt),
        filter.artifactId ? eq(publishedPages.artifactId, filter.artifactId) : undefined,
      ),
    )
    .orderBy(desc(publishedPages.updatedAt));
  const admin = can(membership, "administrator");
  const seen = admin
    ? rows
    : (
        await Promise.all(
          rows.map(async (r) => ((await fileRefOf(deps.db, userId, orgId, r.page.artifactId)) ? r : null)),
        )
      ).filter((r) => r !== null);
  return seen.map((r) => viewOf(r.page, r.title, filter.baseUrl));
}

/**
 * Takes a page down at once (ADR 0211 §6): an administrator, or whoever reads its file. Its address never answers
 * again. Audited.
 */
export async function unpublishPage(deps: ArtifactDeps, userId: string, orgId: string, pageId: string) {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  const [page] = UUID.test(pageId)
    ? await db
        .select()
        .from(publishedPages)
        .where(and(eq(publishedPages.id, pageId), eq(publishedPages.orgId, orgId), isNull(publishedPages.revokedAt)))
    : [];
  // Not found for whoever may not take it down: which pages a workspace has is no business of theirs.
  if (!page || !(can(membership, "administrator") || (await fileRefOf(db, userId, orgId, page.artifactId)))) {
    throw new NotFoundError("Published page not found", "published_page.not_found");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(publishedPages)
      .set({ revokedAt: new Date(), revokedById: userId })
      .where(eq(publishedPages.id, page.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.page_unpublished",
      target: { type: "artifact", id: page.artifactId },
      details: { pageId: page.id, version: page.version },
    });
  });
}

/**
 * The HTML a page's address shows, or null: an unknown token, a revoked page, its file in the trash or gone, and a
 * workspace that is held, suspended or being deleted all read the same (ADR 0211 §3).
 */
export async function publishedPageHtml(deps: ArtifactDeps, token: string): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  const [page] = await deps.db
    .select({ orgId: publishedPages.orgId, artifactId: publishedPages.artifactId, version: publishedPages.version })
    .from(publishedPages)
    .innerJoin(organizations, eq(organizations.id, publishedPages.orgId))
    .where(and(eq(publishedPages.token, token), isNull(publishedPages.revokedAt), openOrg));
  if (!page) return null;
  return pageHtmlAt(deps, page.orgId, page.artifactId, page.version);
}

// ── The agent's tool ────────────────────────────────────────────────────────

const agentOf = (ctx: ToolContext): AgentActor => ({
  type: "agent",
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  threadId: replyThreadOf(ctx),
  runId: ctx.runId,
});

const str = (v: unknown) => (typeof v === "string" ? v : "");
const versionOf = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NOBODY_BEHIND =
  "Nobody asked for this in this run, so nothing is published: a public page goes out only when a person asks. Say what you'd publish in your reply.";

/** `publish_page`, listed only when the server serves pages (`baseUrl`, ADR 0211 §4). */
export function createPublishedPageToolSource(deps: ArtifactDeps & { baseUrl: string | undefined }): ToolSource {
  const { baseUrl } = deps;
  const check = async (input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck> => {
    try {
      const person = await personBehindCall(ctx);
      if (!person) return { ok: false, message: NOBODY_BEHIND };
      await publishable(deps, ctx.orgId, str(input.artifact_id), versionOf(input.version), agentOf(ctx));
      if (!(await fileRefOf(deps.db, person, ctx.orgId, str(input.artifact_id)))) {
        return { ok: false, message: "The person who asked can't open this file: it isn't published for them." };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  };
  const tool: ToolDefinition = {
    name: PUBLISH_PAGE_TOOL,
    description:
      "Publish a page you made (an html file in the Drive) at a public address: anyone with the link opens it, with no account, outside the workspace. Only when a person asks to show the page to someone outside. A person approves first. Give the file and the version you mean: that version is what goes public, and a later version only when you publish again, which keeps the address. The page loads nothing from the network and keeps nothing in the browser: inline every script, style, image and font.",
    scope: "drive:write",
    sensitive: true,
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string", minLength: 36, maxLength: 36 },
        version: { type: "integer", minimum: 1, description: "The file's version to publish (read_artifact says it)" },
      },
      required: ["artifact_id", "version"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Publicar uma página na internet (versão ${versionOf(input.version)})` }),
    checkCall: check,
    async execute(input, ctx): Promise<ToolOutput> {
      if (!baseUrl) return { content: "This server doesn't publish pages.", isError: true };
      const person = await personBehindCall(ctx);
      if (!person) return { content: NOBODY_BEHIND, isError: true };
      try {
        const page = await publishPage(deps, {
          orgId: ctx.orgId,
          artifactId: str(input.artifact_id),
          version: versionOf(input.version),
          agent: agentOf(ctx),
          personId: person,
          baseUrl,
        });
        const moved = page.moved ? " Its address is the same as before; it now shows this version." : "";
        return {
          content: `Published "${page.title}" (version ${page.version}) at ${page.url} : anyone with this link opens it.${moved} Give the person the link. They take it down in the file's Compartilhar (Despublicar).`,
          data: { page: { id: page.id, url: page.url, version: page.version } },
        };
      } catch (error) {
        return { content: messageOf(error), isError: true };
      }
    },
  };
  return { name: "published-pages", tools: async () => (baseUrl ? [tool] : []) };
}
