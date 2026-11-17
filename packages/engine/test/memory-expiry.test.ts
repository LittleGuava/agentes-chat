import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  editContextItem,
  indexSource,
  insertContextItem,
  insertMessage,
  parseUntil,
  retrieveForRun,
  rulesForRun,
  type ToolContext,
  teamMemoryForPrompt,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 86_400_000;

/** @dev's run in #general answering the owner's message. */
async function runOn(body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  if (!f.tools) throw new Error("no tools");
  const res = await f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(res.type);
  return res.output as { content: string; isError?: boolean };
}

const memoryOf = (text = "") =>
  retrieveForRun(f.context, { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, text });

/** One of @dev's memories a person said, pinned so every run reads it whatever it is about. */
const said = (content: string, validUntil: Date | null) =>
  f.db.transaction((tx) =>
    insertContextItem(tx, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      content,
      channelIds: [f.general.id],
      pinned: true,
      createdByKind: "person",
      createdById: f.owner.id,
      evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
      validUntil,
    }),
  );

describe("a memory's end (ADR 0028 §2, addendum 2026-11-15)", () => {
  test("past its end it reads in no prompt; with its end ahead it reads, and says until when", async () => {
    f = await setup({ contextTools: true });
    await said("The office is closed for the holidays.", new Date(Date.now() - DAY));
    await said("Deploys are frozen during the launch.", new Date(Date.now() + 7 * DAY));
    await said("Invoices go out on the 5th.", null);
    const memory = await memoryOf();
    expect(memory.text).not.toContain("closed for the holidays");
    expect(memory.text).toContain("Deploys are frozen during the launch.");
    expect(memory.text).toContain("Invoices go out on the 5th.");
    expect(memory.text).toMatch(/holds until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC[^\n]*Deploys are frozen/);
  });

  test("the team's memory and the rules people gave leave the prompt at their end", async () => {
    f = await setup({ contextTools: true });
    const team = (content: string, validUntil: Date | null) =>
      f.db.transaction((tx) =>
        insertContextItem(tx, {
          orgId: f.org.id,
          kind: "preference",
          scopeType: "org",
          scopeId: f.org.id,
          content,
          createdByKind: "person",
          createdById: f.owner.id,
          validUntil,
        }),
      );
    await team("During the audit, reports go to Bia.", new Date(Date.now() - DAY));
    await team("Reports go out in Portuguese.", new Date(Date.now() + DAY));
    const prompt = await teamMemoryForPrompt(f.db, f.org.id);
    expect(prompt).not.toContain("During the audit");
    expect(prompt).toContain("Reports go out in Portuguese.");

    const ctx = await runOn("até sexta, não precisa me perguntar antes de mandar o relatório");
    const rule = (content: string, validUntil: Date | null) =>
      f.db.transaction((tx) =>
        insertContextItem(tx, {
          orgId: f.org.id,
          kind: "rule",
          scopeType: "agent",
          scopeId: f.agent.id,
          agentId: f.agent.id,
          content,
          createdByKind: "person",
          createdById: f.owner.id,
          validUntil,
        }),
      );
    await rule("No need to ask before sending the weekly report.", new Date(Date.now() - DAY));
    await rule("Send releases notes to #eng.", null);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ctx.runId));
    if (!run) throw new Error("no run");
    const rules = await rulesForRun(f.db, run, { id: f.agent.id, ownerUserId: f.owner.id });
    expect(rules.text).not.toContain("weekly report");
    expect(rules.text).toContain("Send releases notes to #eng.");
  });

  test("an agent's search finds it only while it holds", async () => {
    f = await setup({ contextTools: true });
    const gone = await said("The staging password rotation happens on Mondays.", new Date(Date.now() - DAY));
    const held = await said("The staging cluster rotation happens on Fridays.", new Date(Date.now() + DAY));
    for (const item of [gone, held])
      await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
    const out = await call(await runOn("quando é a rotação?"), "search_context", {
      query: "rotation",
      kinds: ["context_item"],
    });
    expect(out.content).toContain(held.id);
    expect(out.content).not.toContain(gone.id);
  });

  test("remember takes `until`: a day holds through its end in the workspace's time zone", async () => {
    f = await setup({ contextTools: true });
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, timezone: "America/Sao_Paulo" })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone: "America/Sao_Paulo" } });
    const year = new Date().getUTCFullYear() + 1;
    const out = await call(await runOn("até o fim de setembro o escritório fica fechado"), "remember", {
      content: "The office is closed for renovation.",
      until: `${year}-09-28`,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain(`until ${year}-09-28`);
    const [item] = await f.db.select().from(schema.contextItems);
    // The 29th at midnight in São Paulo (UTC-3).
    expect(item?.validUntil?.toISOString()).toBe(`${year}-09-29T03:00:00.000Z`);
    expect((await memoryOf("office renovation")).text).toContain("The office is closed for renovation.");
  });

  test("remember refuses an end already past and saves nothing; a span counts from now", async () => {
    f = await setup({ contextTools: true });
    const ctx = await runOn("lembra disso");
    const past = await call(ctx, "remember", { content: "The beta is open to everyone.", until: "2020-01-01" });
    expect(past.isError).toBe(true);
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
    const bad = await call(ctx, "remember", { content: "The beta is open to everyone.", until: "next friday-ish" });
    expect(bad.isError).toBe(true);
    const before = Date.now();
    await call(ctx, "remember", { content: "The beta is open to everyone.", until: "2w" });
    const [item] = await f.db.select().from(schema.contextItems);
    const end = item?.validUntil?.getTime() ?? 0;
    expect(end).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(end).toBeLessThan(before + 14 * DAY + 60_000);
  });

  test("update_memory brings an item past its end back with a new `until`, or takes the end away with never", async () => {
    f = await setup({ contextTools: true });
    const gone = await said("The office is closed for the holidays.", new Date(Date.now() - DAY));
    const ctx = await runOn("o recesso foi estendido por mais uma semana");
    const out = await call(ctx, "update_memory", {
      item_id: gone.id,
      content: "The office is closed for the holidays, one more week.",
      until: "7d",
    });
    expect(out.isError).toBeUndefined();
    expect((await memoryOf()).text).toContain("one more week");
    const [current] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.status, "active"));
    expect(current?.validUntil?.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    // Without `until` the end stays; `never` takes it away.
    if (!current) throw new Error("no item");
    await call(ctx, "update_memory", { item_id: current.id, content: "The office is closed for the holidays." });
    const [kept] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.status, "active"));
    expect(kept?.validUntil?.getTime()).toBe(current.validUntil?.getTime());
    if (!kept) throw new Error("no item");
    await call(ctx, "update_memory", { item_id: kept.id, content: "The office is closed.", until: "never" });
    const [open] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.status, "active"));
    expect(open?.validUntil).toBeNull();
  });

  test("a person sets, changes and takes away the end on the memory page", async () => {
    f = await setup({ contextTools: true });
    const item = await said("Deploys are frozen during the launch.", null);
    const end = new Date(Date.now() - DAY);
    const ended = await editContextItem(f.db, f.owner.id, f.org.id, item.id, { validUntil: end });
    // Changed in place: the same item, still on the page, out of the prompt.
    expect([ended.id, ended.status, ended.validUntil?.toISOString()]).toEqual([item.id, "active", end.toISOString()]);
    expect((await memoryOf()).text).not.toContain("Deploys are frozen");
    const back = await editContextItem(f.db, f.owner.id, f.org.id, item.id, { validUntil: null });
    expect(back.validUntil).toBeNull();
    expect((await memoryOf()).text).toContain("Deploys are frozen");
    // A text edit keeps the end it had.
    const ahead = new Date(Date.now() + DAY);
    await editContextItem(f.db, f.owner.id, f.org.id, item.id, { validUntil: ahead });
    const edited = await editContextItem(f.db, f.owner.id, f.org.id, item.id, {
      content: "Deploys are frozen until the launch ends.",
    });
    expect(edited.validUntil?.toISOString()).toBe(ahead.toISOString());
  });
});

describe("parseUntil", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  test("a day, a span, an instant, never", () => {
    expect(parseUntil("2026-11-20", { now })?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(parseUntil("2026-11-20", { now, timeZone: "America/Sao_Paulo" })?.toISOString()).toBe(
      "2026-11-21T03:00:00.000Z",
    );
    expect(parseUntil("3d", { now })?.toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(parseUntil("1m", { now })?.toISOString()).toBe("2026-12-15T12:00:00.000Z");
    expect(parseUntil("2026-11-16T09:30:00-03:00", { now })?.toISOString()).toBe("2026-11-16T12:30:00.000Z");
    expect(parseUntil("never", { now })).toBeNull();
    expect(parseUntil(undefined, { now })).toBeNull();
  });
  test("today still holds through its end; what can't be read or is past is refused", () => {
    expect(parseUntil("2026-11-15", { now })?.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(() => parseUntil("2026-11-14", { now })).toThrow("already passed");
    expect(() => parseUntil("2026-02-30", { now })).toThrow("not a date");
    expect(() => parseUntil("soon", { now })).toThrow("not a date");
    expect(() => parseUntil("0d", { now })).toThrow("not a date");
  });
});
