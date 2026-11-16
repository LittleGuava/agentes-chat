import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createArtifact,
  createChannel,
  createPublishedPageToolSource,
  decideApproval,
  deleteArtifact,
  drainOutbox,
  grantScopes,
  listPublishedPages,
  NotFoundError,
  PUBLISHED_PAGES_MAX,
  postPersonMessage,
  publishedPageHtml,
  type ToolContext,
  type ToolSource,
  unpublishPage,
  updateArtifact,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { agentRunRow, channelRoutine, fire } from "./routine-fixtures";

/** Public pages (ADR 0211): `publish_page` through the real Tool Gateway, then what the page's address shows. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const BASE = "https://pages.example.net";
const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));
const page = (html: string, channelId: string | null) => ({
  title: "Proposta",
  channelId,
  content: { kind: "html" as const, html },
});

/** @dev with the Drive's tools and `publish_page`, served from `baseUrl` (unset: the server serves no pages). */
async function world(baseUrl: string | null = BASE) {
  let pages: ToolSource | undefined;
  const lazy: ToolSource = { name: "published-pages", tools: (ctx) => pages?.tools(ctx) ?? Promise.resolve([]) };
  f = await setup({ artifactTools: true, toolSources: [lazy] });
  pages = createPublishedPageToolSource({ ...f.artifactDeps, baseUrl: baseUrl ?? undefined });
  await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
}

const ctxOf = (run: Awaited<ReturnType<typeof agentRunRow>>): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
  background: run.background,
});

/** The run the owner's message started in #general, finished: calls go through it afterwards. */
async function askedRun(userId = f.owner.id, channelId = f.general.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, channelId, { body: "@dev publica" });
  await drainOutbox(f.db, f.handlers);
  const runs = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, f.agent.id), eq(schema.agentRuns.channelId, channelId)));
  const run = runs.at(-1);
  if (!run) throw new Error("no run");
  return ctxOf(run);
}

const agentIn = (ctx: ToolContext) => ({
  type: "agent" as const,
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  runId: ctx.runId,
});

/** Calls `publish_page`, approves its card as the owner and runs the approved call: the tool's answer. */
async function publishApproved(ctx: ToolContext, input: Record<string, unknown>) {
  const before = await f.db.select().from(schema.publishedPages);
  const asked = await f.tools?.invoke(ctx, {
    toolUseId: crypto.randomUUID(),
    name: "publish_page",
    input: { ...input, why: WHY },
  });
  if (asked?.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
  // Nothing changes while a person hasn't answered.
  expect(await f.db.select().from(schema.publishedPages)).toEqual(before);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
    decision: "approve",
  });
  const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
  if (!approved || !f.tools) throw new Error("no approval");
  return f.tools.executeApproved(ctx, approved);
}

const WHY = "A pessoa pediu para mostrar a proposta a um cliente que não tem conta no workspace.";

const tokenOf = (url: string) => url.slice(`${BASE}/p/`.length, -1);

describe("publish_page", () => {
  test("asks a person, then the approved version is what the address shows, whatever the file becomes", async () => {
    await world();
    const ctx = await askedRun();
    const file = await createArtifact(f.artifactDeps, agentIn(ctx), f.org.id, page("<h1>v1</h1>", f.general.id));
    // A second version lands between the card and "Aprovar": the card said version 1.
    const out = await publishApproved(ctx, { artifact_id: file.id, version: 1 });
    await updateArtifact(f.artifactDeps, agentIn(ctx), f.org.id, file.id, {
      content: { kind: "html", html: "<h1>v2</h1>" },
    });
    expect(out.isError).toBeFalsy();
    const url = (out.data as { page: { url: string } }).page.url;
    expect(url).toMatch(/^https:\/\/pages\.example\.net\/p\/[A-Za-z0-9_-]{43}\/$/);
    expect(out.content).toContain(url);
    expect(await publishedPageHtml(f.artifactDeps, tokenOf(url))).toBe("<h1>v1</h1>");

    // Publishing again moves the same address to the new version.
    const again = await publishApproved(ctx, { artifact_id: file.id, version: 2 });
    expect((again.data as { page: { url: string } }).page.url).toBe(url);
    expect(await publishedPageHtml(f.artifactDeps, tokenOf(url))).toBe("<h1>v2</h1>");
    expect(await f.db.select().from(schema.publishedPages)).toHaveLength(1);

    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "artifact.page_published"));
    expect(audit.map((a) => a.details)).toEqual([
      expect.objectContaining({ version: 1, moved: false }),
      expect.objectContaining({ version: 2, moved: true }),
    ]);
    expect(audit[0]).toMatchObject({ actorType: "agent", onBehalfOfUserId: f.owner.id, targetId: file.id });
  });

  test("isn't listed when the server serves no pages", async () => {
    await world(null);
    const ctx = await askedRun();
    const listed = await f.tools?.list(ctx);
    expect(listed?.map((t) => t.name)).not.toContain("publish_page");
    expect(listed?.map((t) => t.name)).toContain("create_artifact");
  });

  test("refused before anyone is asked: not a page, a version it doesn't have, a file the person can't open", async () => {
    await world();
    const ctx = await askedRun();
    const doc = await createArtifact(f.artifactDeps, agentIn(ctx), f.org.id, {
      title: "Notas",
      channelId: f.general.id,
      content: { kind: "document", markdown: "# Notas" },
    });
    const html = await createArtifact(f.artifactDeps, agentIn(ctx), f.org.id, page("<p>x</p>", f.general.id));
    const call = (input: Record<string, unknown>) =>
      f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name: "publish_page", input: { ...input, why: WHY } });
    const notPage = await call({ artifact_id: doc.id, version: 1 });
    expect(notPage?.type === "result" && notPage.output.content).toContain("Only a page is published");
    const noVersion = await call({ artifact_id: html.id, version: 7 });
    expect(noVersion?.type).toBe("result");

    // A private channel the agent is in and the person behind the run isn't.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    const hidden = await createArtifact(
      f.artifactDeps,
      { type: "agent", agentId: f.agent.id, channelId: secret.id },
      f.org.id,
      page("<p>salários</p>", secret.id),
    );
    await f.db
      .insert(schema.channelMembers)
      .values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id })
      .onConflictDoNothing();
    const biaRun = await askedRun(bia.id);
    const refused = await f.tools?.invoke(biaRun, {
      toolUseId: crypto.randomUUID(),
      name: "publish_page",
      input: { artifact_id: hidden.id, version: 1, why: WHY },
    });
    expect(refused?.type).toBe("result");
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await f.db.select().from(schema.publishedPages)).toEqual([]);
  });

  test("a routine's run publishes nothing", async () => {
    await world();
    const file = await createArtifact(
      f.artifactDeps,
      { type: "person", userId: f.owner.id },
      f.org.id,
      page("<p>x</p>", null),
    );
    const routine = await channelRoutine(f, {});
    const run = ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId));
    const out = await f.tools?.invoke(run, {
      toolUseId: crypto.randomUUID(),
      name: "publish_page",
      input: { artifact_id: file.id, version: 1, why: WHY },
    });
    expect(out?.type).toBe("result");
    expect(out?.type === "result" && out.output.isError).toBe(true);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await f.db.select().from(schema.publishedPages)).toEqual([]);
  });
});

describe("a page's address", () => {
  async function published() {
    await world();
    const ctx = await askedRun();
    const file = await createArtifact(f.artifactDeps, agentIn(ctx), f.org.id, page("<p>oi</p>", f.general.id));
    const out = await publishApproved(ctx, { artifact_id: file.id, version: 1 });
    const { id, url } = (out.data as { page: { id: string; url: string } }).page;
    return { file, pageId: id, token: tokenOf(url) };
  }

  test("answers nothing for an unknown token, a file in the trash, or a workspace that is closed", async () => {
    const { file, token } = await published();
    expect(await publishedPageHtml(f.artifactDeps, "x".repeat(43))).toBeNull();
    expect(await publishedPageHtml(f.artifactDeps, "../etc/passwd")).toBeNull();

    await f.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, f.org.id));
    expect(await publishedPageHtml(f.artifactDeps, token)).toBeNull();
    await f.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, f.org.id));
    expect(await publishedPageHtml(f.artifactDeps, token)).toBe("<p>oi</p>");

    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
    expect(await publishedPageHtml(f.artifactDeps, token)).toBeNull();
  });

  test("whoever reads the file or an administrator takes it down; anyone else doesn't even see it", async () => {
    const { file, pageId, token } = await published();
    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, outsider.id));
    await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
    expect(await listPublishedPages(f.artifactDeps, outsider.id, f.org.id, { baseUrl: BASE })).toEqual([]);
    await expect(unpublishPage(f.artifactDeps, outsider.id, f.org.id, pageId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await publishedPageHtml(f.artifactDeps, token)).toBe("<p>oi</p>");

    const listed = await listPublishedPages(f.artifactDeps, f.owner.id, f.org.id, {
      artifactId: file.id,
      baseUrl: BASE,
    });
    expect(listed).toEqual([
      expect.objectContaining({
        id: pageId,
        artifactId: file.id,
        title: "Proposta",
        version: 1,
        url: `${BASE}/p/${token}/`,
      }),
    ]);
    await unpublishPage(f.artifactDeps, f.owner.id, f.org.id, pageId);
    expect(await publishedPageHtml(f.artifactDeps, token)).toBeNull();
    expect(await listPublishedPages(f.artifactDeps, f.owner.id, f.org.id, { baseUrl: BASE })).toEqual([]);
    const [row] = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "artifact.page_unpublished"));
    expect(row).toMatchObject({ actorType: "person", actorId: f.owner.id, targetId: file.id });

    // Published again: a new address; the old one never comes back.
    const ctx = await askedRun();
    const out = await publishApproved(ctx, { artifact_id: file.id, version: 1 });
    expect(tokenOf((out.data as { page: { url: string } }).page.url)).not.toBe(token);
    expect(await publishedPageHtml(f.artifactDeps, token)).toBeNull();
  });

  test(`a workspace keeps at most ${PUBLISHED_PAGES_MAX} live pages`, async () => {
    const { file } = await published();
    const others = await f.db
      .insert(schema.artifacts)
      .values(
        Array.from({ length: PUBLISHED_PAGES_MAX - 1 }, (_, i) => ({
          orgId: f.org.id,
          kind: "html" as const,
          title: `p${i}`,
          createdByType: "person",
          createdById: f.owner.id,
          updatedByType: "person",
          updatedById: f.owner.id,
        })),
      )
      .returning({ id: schema.artifacts.id });
    await f.db.insert(schema.publishedPages).values(
      others.map((a, i) => ({
        orgId: f.org.id,
        artifactId: a.id,
        version: 1,
        token: `t${String(i).padStart(42, "0")}`,
        createdByType: "person",
        createdById: f.owner.id,
      })),
    );
    const ctx = await askedRun();
    // Moving the file's own page to another version still works at the cap.
    expect((await publishApproved(ctx, { artifact_id: file.id, version: 1 })).isError).toBeFalsy();
    const next = await createArtifact(f.artifactDeps, agentIn(ctx), f.org.id, page("<p>mais</p>", f.general.id));
    const out = await publishApproved(ctx, { artifact_id: next.id, version: 1 });
    expect(out.isError).toBe(true);
    expect(out.content).toContain(`${PUBLISHED_PAGES_MAX} public pages`);
  });
});
