import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  createContextToolSource,
  drainOutbox,
  indexSource,
  insertMessage,
  postPersonMessage,
  resolvePeriod,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const iso = (d: Date | undefined) => d?.toISOString();

describe("a period in the person's time zone (ADR 0017 addendum 2026-11-15)", () => {
  // 22:30 on Nov 14 in São Paulo, already Nov 15 in UTC.
  const now = new Date("2026-11-15T01:30:00Z");
  const sp = "America/Sao_Paulo";
  const period = (input: { since?: string; until?: string }, zone = sp) => {
    const r = resolvePeriod(input, zone, now);
    if (!r.ok) throw new Error(r.error);
    return { after: iso(r.period.after), before: iso(r.period.before) };
  };

  test("today and yesterday are the person's local days, not UTC's", () => {
    expect(period({ since: "today" })).toEqual({ after: "2026-11-14T03:00:00.000Z", before: undefined });
    expect(period({ since: "yesterday", until: "yesterday" })).toEqual({
      after: "2026-11-13T03:00:00.000Z",
      before: "2026-11-14T03:00:00.000Z",
    });
    expect(period({ since: "Yesterday" }, "UTC")).toEqual({ after: "2026-11-14T00:00:00.000Z", before: undefined });
  });

  test("a span counts back from now; a day runs whole; a time without a zone is local", () => {
    expect(period({ since: "7d" }).after).toBe("2026-11-08T01:30:00.000Z");
    expect(period({ since: "6h" }).after).toBe("2026-11-14T19:30:00.000Z");
    expect(period({ since: "2w" }).after).toBe("2026-11-01T01:30:00.000Z");
    expect(period({ since: "2026-11-10", until: "2026-11-10" })).toEqual({
      after: "2026-11-10T03:00:00.000Z",
      before: "2026-11-11T03:00:00.000Z",
    });
    expect(period({ since: "2026-11-10T09:00" }).after).toBe("2026-11-10T12:00:00.000Z");
    expect(period({ since: "2026-11-10T09:00Z" }).after).toBe("2026-11-10T09:00:00.000Z");
    expect(period({ since: "2026-11-10T09:00:30-05:00" }).after).toBe("2026-11-10T14:00:30.000Z");
  });

  test("a midnight a DST change skips starts the day at its first minute", () => {
    // São Paulo moved its clocks from 00:00 to 01:00 on Nov 4, 2018.
    expect(period({ since: "2018-11-04" }).after).toBe("2018-11-04T03:00:00.000Z");
  });

  test("an unknown zone reads as UTC", () => {
    expect(period({ since: "today" }, "Mars/Olympus")).toEqual({
      after: "2026-11-15T00:00:00.000Z",
      before: undefined,
    });
  });

  test("words it doesn't know, impossible days and a backwards period are refused", () => {
    for (const since of ["last tuesday", "2026-02-30", "2026-11-10T25:00", "7m"]) {
      const r = resolvePeriod({ since }, sp, now);
      expect(r.ok).toBe(false);
    }
    const backwards = resolvePeriod({ since: "today", until: "yesterday" }, sp, now);
    expect(backwards).toEqual({ ok: false, error: "`since` must come before `until`." });
  });
});

/** A message written straight to the table at a given time, then indexed. */
async function said(body: string, at: Date, channelId = f.general.id) {
  const [m] = await f.db
    .insert(schema.messages)
    .values({
      orgId: f.org.id,
      channelId,
      authorType: "person",
      authorUserId: f.owner.id,
      body,
      createdAt: at,
    })
    .returning();
  if (!m) throw new Error("no message");
  await indexSource(
    { db: f.db, search: f.search, gateway: f.gateway },
    { orgId: f.org.id, kind: "message", sourceId: m.id },
  );
  return m;
}

/** A run of @dev asked by the owner in #general. */
async function ownerRun(): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev o que rolou?",
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
      status: "running",
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

async function search(ctx: ToolContext, input: Record<string, unknown>) {
  const all: ToolDefinition[] = await createContextToolSource(f.context).tools(ctx);
  const tool = all.find((t) => t.name === "search_context");
  if (!tool) throw new Error("no search_context");
  return tool.execute(input, ctx);
}

describe("search_context by period, with or without words", () => {
  async function world() {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "America/Sao_Paulo" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    // Nov 10 in São Paulo runs from 03:00 UTC on the 10th to 03:00 UTC on the 11th.
    await said("standup: deploy da vitrine feito", new Date("2026-11-10T13:00:00Z"));
    await said("revisão do contrato com a Acme", new Date("2026-11-11T01:00:00Z"));
    await said("antes do dia: planejamento", new Date("2026-11-10T02:00:00Z"));
    await said("depois do dia: retrospectiva", new Date("2026-11-11T04:00:00Z"));
    await said("segredo do canal privado", new Date("2026-11-10T15:00:00Z"), secret.id);
    return { secret };
  }

  test("without words, it lists what the period holds, oldest first, in local time", async () => {
    await world();
    const ctx = await ownerRun();
    const found = await search(ctx, { since: "2026-11-10", until: "2026-11-10" });
    expect(found.isError).toBeFalsy();
    const content = found.content;
    expect(content).toContain("deploy da vitrine feito");
    expect(content).toContain("revisão do contrato");
    expect(content.indexOf("deploy da vitrine")).toBeLessThan(content.indexOf("revisão do contrato"));
    // Local wall time, not the UTC date (01:00 UTC on the 11th is 22:00 on the 10th).
    expect(content).toContain("2026-11-10 22:00");
    expect(content).toContain("America/Sao_Paulo");
    expect(content).not.toContain("planejamento");
    expect(content).not.toContain("retrospectiva");
    // The same visibility as a search with words: a private channel the agent isn't in stays out.
    expect(content).not.toContain("segredo");
  });

  test("with words, only what matches inside the period", async () => {
    await world();
    const ctx = await ownerRun();
    const found = await search(ctx, { query: "contrato", since: "2026-11-10", until: "2026-11-10" });
    expect(found.content).toContain("revisão do contrato");
    expect(found.content).not.toContain("deploy da vitrine");
    const outside = await search(ctx, { query: "retrospectiva", since: "2026-11-10", until: "2026-11-10" });
    expect(outside.content).toBe("No results.");
  });

  test("a private channel the agent belongs to is in", async () => {
    const { secret } = await world();
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const ctx = { ...(await ownerRun()), channelId: secret.id };
    const found = await search(ctx, { since: "2026-11-10", until: "2026-11-10" });
    expect(found.content).toContain("segredo do canal privado");
  });

  test("a list cut by the limit says so and keeps the newest", async () => {
    await world();
    const ctx = await ownerRun();
    const found = await search(ctx, { since: "2026-11-10", until: "2026-11-10", limit: 1 });
    expect(found.content).toContain("revisão do contrato");
    expect(found.content).not.toContain("deploy da vitrine");
    expect(found.content).toContain("more in this period");
  });

  test("neither words nor a period, or a period it can't read, is an error", async () => {
    await world();
    const ctx = await ownerRun();
    const none = await search(ctx, {});
    expect(none.isError).toBe(true);
    expect(none.content).toContain("since");
    const bad = await search(ctx, { since: "last tuesday" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("last tuesday");
  });

  test("through the Tool Gateway, a call with only `since` is accepted", async () => {
    f = await setup({
      contextTools: true,
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["ok"] };
        return last.includes("o que rolou")
          ? { chunks: [], toolUses: [{ name: "search_context", input: { since: "1d" } }] }
          : { chunks: ["anotado"] };
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev o pagamento da Acme caiu hoje",
    });
    await drainOutbox(f.db, f.handlers);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev o que rolou?",
    });
    await drainOutbox(f.db, f.handlers);
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result" && (s.data as { name: string }).name === "search_context")
      .map((s) => s.data as { content: string; isError: boolean });
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toContain("pagamento da Acme caiu hoje");
  });

  test("the agent's own earlier steps are bounded by the period too, dated in local time", async () => {
    await world();
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev publica a vitrine",
    });
    const [earlier] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!earlier) throw new Error("no run");
    const hour = 3_600_000;
    const step = (seq: number, url: string, hoursAgo: number) => ({
      orgId: f.org.id,
      runId: earlier.id,
      seq,
      kind: "tool_call" as const,
      data: { name: "fetch_url", toolUseId: `t${seq}`, input: { url } },
      createdAt: new Date(Date.now() - hoursAgo * hour),
    });
    await f.db
      .insert(schema.agentRunSteps)
      .values([step(1, "https://vitrine.example/deploy/recent", 2), step(2, "https://vitrine.example/deploy/old", 72)]);
    const ctx = await ownerRun();
    const stepsOf = (content: string) => content.split("\n").filter((l) => l.includes("[your earlier step]"));

    const always = stepsOf((await search(ctx, { query: "vitrine deploy" })).content);
    expect(always.some((l) => l.includes("deploy/old"))).toBe(true);
    expect(always.some((l) => l.includes("deploy/recent"))).toBe(true);

    const lately = stepsOf((await search(ctx, { query: "vitrine deploy", since: "1d" })).content);
    expect(lately).toHaveLength(1);
    expect(lately[0]).toContain("deploy/recent");
    expect(lately[0]).toMatch(/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
  });
});
