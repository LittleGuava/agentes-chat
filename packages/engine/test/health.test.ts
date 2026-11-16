import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  enqueueHealthScan,
  ForbiddenError,
  HEALTH_SCAN_JOB,
  listHealthIssues,
  operatorHealthIssues,
  scanHealth,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const MINUTE = 60_000;
const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

async function run(status: "done" | "failed" | "canceled", options: { error?: string; finishedAt?: Date } = {}) {
  const id = crypto.randomUUID();
  const [row] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 1,
      status,
      error: options.error ?? null,
      createdAt: ago(30),
      finishedAt: options.finishedAt ?? ago(10),
    })
    .returning();
  if (!row) throw new Error("no run");
  return row;
}

let seq = 0;
async function toolResult(runId: string, name: string, content: string, data?: Record<string, unknown>) {
  seq += 1;
  await f.db.insert(schema.agentRunSteps).values({
    orgId: f.org.id,
    runId,
    seq,
    kind: "tool_result",
    data: { toolUseId: `t${seq}`, name, isError: true, content, ...(data ? { data } : {}) },
    createdAt: ago(20),
  });
}

describe("the health scan", () => {
  test("groups tool errors by tool and normalized text, leaving out refusals and what a person decided", async () => {
    f = await setup();
    const a = await run("done");
    const b = await run("done");
    await toolResult(a.id, "github_get_issue", "issue 12 not found in acme/api");
    await toolResult(b.id, "github_get_issue", "issue 9001 not found in acme/api");
    await toolResult(b.id, "linear_get_issue", "issue 12 not found in acme/api");
    await toolResult(b.id, "github_merge", "Not allowed: no scope", { refusal: "noAccess" });
    await toolResult(b.id, "mail_send", "Approval needed", { code: "tool.not_allowed", refusal: "policy" });
    // A secret or a question a person declined: their decision, written when the run goes on (`executor.ts`).
    await toolResult(b.id, "request_secret", "Walter declined to share the key.", {
      secretRequestId: crypto.randomUUID(),
    });
    await toolResult(b.id, "ask_user", "Walter said no.", { questionId: crypto.randomUUID() });

    await scanHealth(f.db, NOW);

    const owner = f.owner.id;
    const { issues } = await listHealthIssues(f.db, owner, f.org.id);
    const tools = issues.filter((i) => i.kind === "tool_error");
    expect(tools.map((i) => [i.source, i.count]).sort()).toEqual([
      ["github_get_issue", 2],
      ["linear_get_issue", 1],
    ]);
    const github = tools.find((i) => i.source === "github_get_issue");
    expect(github?.title).toBe("issue <n> not found in acme/api");
    expect(github?.firstAt).toBe(ago(20).toISOString());
    expect(github?.examples.map((e) => e.runId).sort()).toEqual([a.id, b.id].sort());
    expect(github?.examples[0]?.agent?.name).toBe(f.agent.name);
  });

  test("a second scan over the same rows counts nothing twice", async () => {
    f = await setup();
    const a = await run("failed", { error: "provider_error: timeout@Anthropic: request 4411 timed out" });
    await toolResult(a.id, "web_fetch", "fetch failed after 30 s");

    await scanHealth(f.db, NOW);
    await scanHealth(f.db, new Date(NOW.getTime() + 5 * MINUTE));

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    expect(issues.map((i) => [i.kind, i.count]).sort()).toEqual([
      ["timeout", 1],
      ["tool_error", 1],
    ]);
  });

  test("failed runs by their stable code; a person's stop is no failure", async () => {
    f = await setup();
    await run("failed", { error: "provider_error: timeout@Anthropic: no answer for req_88" });
    await run("failed", { error: "provider_error: timeout@Anthropic: no answer for req_91" });
    await run("failed", { error: "cli_failed: Claude Code: ENOENT 3" });
    await run("canceled", { error: "budget_exceeded" });
    await run("failed", { error: "This agent's model is from Anthropic, but the chosen key is from OpenAI" });

    await scanHealth(f.db, NOW);

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    const byCode = Object.fromEntries(issues.map((i) => [i.source, i]));
    expect(byCode["run.provider_timeout"]?.kind).toBe("timeout");
    expect(byCode["run.provider_timeout"]?.subject).toBe("Anthropic");
    expect(byCode["run.provider_timeout"]?.count).toBe(2);
    expect(byCode["run.cli_failed"]?.kind).toBe("run_failed");
    expect(byCode["run.cli_failed"]?.subject).toBe("Claude Code");
    // A wrong key's words need both providers: the model's as the name (by its label today), the key's as the text.
    expect(byCode["run.credential_wrong_provider"]).toMatchObject({ subject: "Claude", title: "OpenAI" });
    expect(issues).toHaveLength(3);
  });

  test("jobs left waiting or dead after their tries, by their kind", async () => {
    f = await setup();
    await f.db.insert(schema.outbox).values([
      { orgId: f.org.id, kind: "vault.sync", payload: {}, status: "pending", nextAttemptAt: ago(30) },
      { orgId: f.org.id, kind: "vault.sync", payload: {}, status: "pending", nextAttemptAt: ago(1) },
      {
        orgId: f.org.id,
        kind: "mail.poll",
        payload: {},
        status: "failed",
        lastError: "IMAP 1.2.3.4 refused",
        createdAt: ago(60),
        nextAttemptAt: ago(40),
      },
      { orgId: null, kind: "email.send", payload: {}, status: "failed", lastError: "SMTP down", createdAt: ago(60) },
    ]);

    await scanHealth(f.db, NOW);

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    expect(issues.map((i) => [i.kind, i.source, i.count, i.title]).sort()).toEqual([
      ["job_failed", "mail.poll", 1, "IMAP <n> refused"],
      ["queue_stalled", "vault.sync", 1, ""],
    ]);
  });

  test("a run that cost the workspace over $5 is a cost spike of its agent; the platform's calls don't count", async () => {
    f = await setup();
    const big = await run("done");
    const small = await run("done");
    const usage = (runId: string, costNanoUsd: number, billedTo = "org") => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      runId,
      provider: "anthropic",
      model: "m",
      requestedModel: "m",
      inputTokens: 1,
      outputTokens: 1,
      costNanoUsd,
      billedTo,
      createdAt: ago(15),
    });
    await f.db
      .insert(schema.usageRecords)
      .values([
        usage(big.id, 4_000_000_000),
        usage(big.id, 2_000_000_000),
        usage(small.id, 1_000_000_000),
        usage(small.id, 9_000_000_000, "platform"),
      ]);

    await scanHealth(f.db, NOW);

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    expect(issues.map((i) => [i.kind, i.agentId, i.count])).toEqual([["cost_spike", f.agent.id, 1]]);
    expect(issues[0]?.examples[0]?.runId).toBe(big.id);
  });

  test("only who may read the audit log sees it; the operator gets facts without the title", async () => {
    f = await setup();
    const a = await run("done");
    await toolResult(a.id, "web_fetch", 'secret plan "Q3" failed for ada@example.com');
    await scanHealth(f.db, NOW);

    const member = await addMember(f.db, f.org.id, "member");
    await expect(listHealthIssues(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await addMember(f.db, f.org.id, "admin");
    expect((await listHealthIssues(f.db, admin.id, f.org.id)).issues).toHaveLength(1);

    const facts = await operatorHealthIssues(f.db, f.org.id);
    expect(facts).toHaveLength(1);
    expect(facts?.[0]).not.toHaveProperty("title");
    expect(JSON.stringify(facts)).not.toContain("ada@");
    expect(await operatorHealthIssues(f.db, crypto.randomUUID())).toBeNull();
  });

  test("occurrences older than 14 days go; the issue keeps its count", async () => {
    f = await setup();
    const a = await run("done");
    await toolResult(a.id, "web_fetch", "boom");
    await scanHealth(f.db, NOW);
    await scanHealth(f.db, new Date(NOW.getTime() + 15 * 24 * 60 * MINUTE));

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    expect(issues[0]?.count).toBe(1);
    expect(issues[0]?.examples).toEqual([]);
  });

  test("a job stalled for longer than occurrences are kept is counted once, not again at every scan", async () => {
    f = await setup();
    await f.db.insert(schema.outbox).values({
      orgId: f.org.id,
      kind: "vault.sync",
      payload: {},
      status: "pending",
      nextAttemptAt: ago(20 * 24 * 60),
    });
    await scanHealth(f.db, NOW);
    await scanHealth(f.db, new Date(NOW.getTime() + 5 * MINUTE));
    await scanHealth(f.db, new Date(NOW.getTime() + 10 * MINUTE));

    const { issues } = await listHealthIssues(f.db, f.owner.id, f.org.id);
    expect(issues.map((i) => [i.kind, i.count])).toEqual([["queue_stalled", 1]]);
  });

  test("the scan is queued once per five-minute window", async () => {
    f = await setup();
    await enqueueHealthScan(f.db, NOW);
    await enqueueHealthScan(f.db, new Date(NOW.getTime() + MINUTE));
    await enqueueHealthScan(f.db, new Date(NOW.getTime() + 5 * MINUTE));
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === HEALTH_SCAN_JOB);
    expect(jobs).toHaveLength(2);
  });
});
