import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  archiveAgent,
  auditCsv,
  auditInput,
  auditsCall,
  changeMemberRole,
  createToolGateway,
  decideApproval,
  ForbiddenError,
  grantScopes,
  inviteMany,
  listAudit,
  postPersonMessage,
  recordAudit,
  recordToolCall,
  removeMember,
  revokeConnection,
  rotateCredential,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("what the audit keeps of a call", () => {
  test("secrets masked, keys under secret names dropped, long text cut", () => {
    const kept = auditInput({
      to: "joao@acme.com",
      subject: "Proposta",
      headers: { Authorization: "Bearer abcdefghijklmnop", "X-Trace": "1" },
      password: "hunter2",
      note: "use sk-ant-abcdefghijklmnopqrstuv to call it",
      body: "x".repeat(800),
      list: Array.from({ length: 25 }, (_, i) => i),
    });
    expect(kept).toMatchObject({
      to: "joao@acme.com",
      subject: "Proposta",
      headers: { Authorization: "***", "X-Trace": "1" },
      password: "***",
    });
    expect(kept.note).not.toContain("abcdefghijklmnopqrstuv");
    expect(String(kept.body).length).toBeLessThan(510);
    expect(kept.list).toHaveLength(21);
    expect(JSON.stringify(kept)).not.toContain("hunter2");
  });

  test("changes, sends and a connected app's reads; not looking around inside; every refusal", () => {
    expect(auditsCall("external", {}, "done")).toBe(true);
    expect(auditsCall("internal", {}, "done")).toBe(true);
    expect(auditsCall("computer", {}, "pending")).toBe(true);
    expect(auditsCall("elsewhere", {}, "done")).toBe(true);
    expect(auditsCall("read", { connectionId: "c1" }, "done")).toBe(true);
    expect(auditsCall("read", {}, "done")).toBe(false);
    expect(auditsCall("here", {}, "done")).toBe(false);
    expect(auditsCall("pass", {}, "done")).toBe(false);
    expect(auditsCall("directory", {}, "done")).toBe(false);
    expect(auditsCall("read", {}, "refused")).toBe(true);
    expect(auditsCall("here", {}, "failed")).toBe(true);
    expect(auditsCall("directory", {}, "refused")).toBe(false);
  });
});

describe("agents' tool calls in the audit log", () => {
  async function runIn(fx: Fixture): Promise<ToolContext> {
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "abre a tarefa e manda o resumo",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    return {
      db: fx.db,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      runId: run?.id ?? "",
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    };
  }

  /** Fake tools: an internal write, one that throws, one that needs approval, a workspace read, a connector read. */
  function fakeTools(connectionId: string) {
    const obj = { type: "object", properties: { title: { type: "string" } }, additionalProperties: true };
    const tool = (name: string, scope: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
      name,
      description: name,
      scope,
      inputSchema: obj,
      async execute() {
        return { content: `${name} ok` };
      },
      ...extra,
    });
    const tools = [
      tool("create_issue", "issues:write"),
      tool("broken_issue", "issues:write", {
        async execute() {
          throw new Error("the issue tracker is down");
        },
      }),
      tool("close_all_issues", "issues:write", { sensitive: true }),
      tool("search_context", "context:read"),
      tool("sentry_list_issues", "sentry:issues.read", {
        connectionId,
        connectorLabel: "Sentry",
        describe: () => ({ title: "Sentry: List issues" }),
      }),
      tool("drive_delete", "drive:delete"),
    ];
    const source: ToolSource = { name: "fake", tools: async () => tools };
    return createToolGateway({ sources: [source] });
  }

  async function team(fx: Fixture) {
    const [conn] = await fx.db
      .insert(schema.connectorConnections)
      .values({
        orgId: fx.org.id,
        connector: "sentry",
        label: "Sentry",
        toolPrefix: "sentry",
        serverUrl: "https://mcp.sentry.dev",
        authType: "none",
      })
      .returning();
    await grantScopes(fx.db, fx.org.id, fx.agent.id, [
      { connectionId: null, scope: "issues:write" },
      { connectionId: null, scope: "context:read" },
      { connectionId: conn?.id ?? null, scope: "sentry:issues.read" },
    ]);
    return fakeTools(conn?.id ?? "");
  }

  const toolRows = (fx: Fixture) =>
    fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "tool.call")).orderBy(schema.auditLog.id);

  test("what went through, failed, was refused or waits; with the run, the channel and the person behind it", async () => {
    f = await setup();
    const tools = await team(f);
    const ctx = await runIn(f);
    const call = (name: string, input: Record<string, unknown> = {}) =>
      tools.invoke(ctx, { toolUseId: `tu_${name}_${Math.random()}`, name, input });

    await call("create_issue", { title: "Login quebrado" });
    await call("broken_issue", { title: "Outra" });
    await call("drive_delete", { title: "relatorio.pdf" }); // no drive:delete: refused
    await call("search_context", { title: "login" }); // looking around: not kept
    await call("sentry_list_issues", { title: "login" }); // someone's data: kept
    const asked = await call("close_all_issues", {
      title: "tudo",
      why: "the board was cleaned up by hand after the release",
    });
    expect(asked.type).toBe("approval");

    const rows = await toolRows(f);
    expect(rows.map((r) => [r.targetId, r.outcome])).toEqual([
      ["create_issue", "done"],
      ["broken_issue", "failed"],
      ["drive_delete", "refused"],
      ["sentry_list_issues", "done"],
      ["close_all_issues", "pending"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        orgId: f.org.id,
        actorType: "agent",
        actorId: f.agent.id,
        runId: ctx.runId,
        channelId: f.general.id,
        onBehalfOfUserId: f.owner.id,
      });
    }
    expect(rows[0]?.details).toMatchObject({ kind: "internal", behind: "person", input: { title: "Login quebrado" } });
    expect(rows[1]?.details.reason).toContain("the issue tracker is down");
    expect(rows[2]?.details.reason).toContain("lacks the scope drive:delete");
    expect(rows[3]?.details).toMatchObject({ kind: "read", connector: "Sentry", title: "Sentry: List issues" });
    const approvalId = asked.type === "approval" ? asked.approval.id : "";
    expect(rows[4]?.details).toMatchObject({
      approvalId,
      reason: "the board was cleaned up by hand after the release",
    });

    // Waiting on a person: the reader says so until someone answers.
    const waiting = await listAudit(f.db, f.owner.id, f.org.id, { waiting: true });
    expect(waiting.rows.map((r) => r.target.id)).toEqual(["close_all_issues"]);
    expect(waiting.rows[0]?.approval).toMatchObject({ id: approvalId, status: "pending", decidedBy: null });
    expect(waiting.rows[0]?.channel).toMatchObject({ id: f.general.id, kind: "channel" });

    // A person approves: their decision, then the action the agent ran.
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approvalId, { decision: "approve" });
    const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!approved) throw new Error("no approval");
    await tools.executeApproved(ctx, approved);
    const [decision] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
    expect(decision).toMatchObject({
      actorType: "person",
      actorId: f.owner.id,
      targetId: approvalId,
      runId: ctx.runId,
    });
    expect(decision?.details).toMatchObject({ tool: "close_all_issues", agentId: f.agent.id });
    const ran = (await toolRows(f)).at(-1);
    expect(ran).toMatchObject({ targetId: "close_all_issues", outcome: "done", onBehalfOfUserId: f.owner.id });
    expect(ran?.details.approvalId).toBe(approvalId);
    // The row that waited now reads as answered, and nothing waits any more.
    expect((await listAudit(f.db, f.owner.id, f.org.id, { waiting: true })).rows).toEqual([]);
    const asked2 = (await listAudit(f.db, f.owner.id, f.org.id, { outcome: ["pending"] })).rows[0];
    expect(asked2?.approval).toMatchObject({ status: "approved", decidedBy: { id: f.owner.id, name: "ana" } });
  });

  test("admins read it, newest first, with names, filters and pages; members can't", async () => {
    f = await setup();
    const tools = await team(f);
    const ctx = await runIn(f);
    for (const name of ["create_issue", "drive_delete", "create_issue"]) {
      await tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input: { title: name } });
    }

    const all = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool" });
    expect(all.rows.map((r) => r.target.id)).toEqual(["create_issue", "drive_delete", "create_issue"]);
    expect(all.rows[0]).toMatchObject({
      actor: { type: "agent", id: f.agent.id, name: f.agent.name },
      onBehalfOf: { id: f.owner.id, name: "ana" },
      channelId: f.general.id,
    });
    expect(all.next).toBeNull();

    const refused = await listAudit(f.db, f.owner.id, f.org.id, { outcome: ["refused"] });
    expect(refused.rows.map((r) => r.target.id)).toEqual(["drive_delete"]);
    const wrong = await listAudit(f.db, f.owner.id, f.org.id, { outcome: ["refused", "failed"] });
    expect(wrong.rows.map((r) => r.target.id)).toEqual(["drive_delete"]);
    const byAgent = await listAudit(f.db, f.owner.id, f.org.id, { actorType: "agent", actorId: f.agent.id });
    expect(byAgent.rows).toHaveLength(3);

    const first = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool", limit: 2 });
    expect(first.rows).toHaveLength(2);
    const second = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool", limit: 2, before: first.next ?? "" });
    expect(second.rows.map((r) => r.target.id)).toEqual(["create_issue"]);
    expect(second.next).toBeNull();

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(listAudit(f.db, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("one action is one row; what a change kept leaves cleaned", async () => {
    f = await setup();
    const ctx = await runIn(f);
    await recordToolCall(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: ctx.runId,
      channelId: f.general.id,
      authority: null,
      tool: "post_message",
      kind: "elsewhere",
      input: { channel: "geral", text: "oi" },
      outcome: "done",
    });
    // What the tool writes about itself next to the gateway's row.
    await recordAudit(f.db, {
      orgId: f.org.id,
      actor: { type: "agent", id: f.agent.id },
      action: "message.posted_elsewhere",
      target: { type: "channel", id: f.general.id },
    });
    await recordAudit(f.db, {
      orgId: f.org.id,
      actor: { type: "agent", id: f.agent.id },
      action: "mail.sent",
      target: { type: "mail_account", id: "m1" },
    });
    await recordAudit(f.db, {
      orgId: f.org.id,
      actor: { type: "person", id: f.owner.id },
      action: "connector.created",
      target: { type: "connector", id: "c1" },
      details: { serverUrl: "https://mcp.acme.com/sse?api_key=abc123supersecret", token: "t0ps3cret" },
    });

    // Newest first (setting up the workspace wrote rows of its own before these).
    const rows = (await listAudit(f.db, f.owner.id, f.org.id)).rows;
    expect(rows.slice(0, 2).map((r) => r.action)).toEqual(["connector.created", "tool.call"]);
    const change = JSON.stringify(rows[0]?.details);
    expect(change).toContain("mcp.acme.com");
    expect(change).not.toContain("abc123supersecret");
    expect(change).not.toContain("t0ps3cret");
  });

  test("a call waiting for a secret follows the request", async () => {
    f = await setup();
    const ctx = await runIn(f);
    const [request] = await f.db
      .insert(schema.secretRequests)
      .values({
        orgId: f.org.id,
        runId: ctx.runId,
        agentId: f.agent.id,
        channelId: f.general.id,
        toolUseId: "tu_secret",
        requestedForUserId: f.owner.id,
        name: "GITHUB_TOKEN",
        purpose: "push the fix",
        targetKind: "env",
        publicKey: "pk",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!request) throw new Error("no request");
    await recordToolCall(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: ctx.runId,
      channelId: f.general.id,
      authority: null,
      tool: "request_secret",
      kind: "elsewhere",
      input: { name: "GITHUB_TOKEN" },
      outcome: "pending",
      secretRequestId: request.id,
    });

    const waiting = await listAudit(f.db, f.owner.id, f.org.id, { waiting: true });
    expect(waiting.rows.map((r) => r.target.id)).toEqual(["request_secret"]);
    expect(waiting.rows[0]?.secret).toEqual({ id: request.id, status: "pending" });

    await f.db
      .update(schema.secretRequests)
      .set({ status: "delivered" })
      .where(eq(schema.secretRequests.id, request.id));
    expect((await listAudit(f.db, f.owner.id, f.org.id, { waiting: true })).rows).toEqual([]);
    const after = (await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool" })).rows[0];
    expect(after?.secret).toEqual({ id: request.id, status: "delivered" });
  });
});

describe("people's changes in the audit log", () => {
  test("members, invitations, agents, connectors and AI keys; a key never kept", async () => {
    f = await setup();
    const changes = async () =>
      (await listAudit(f.db, f.owner.id, f.org.id, { kind: "change", actorType: "person" })).rows;
    // Setting up the workspace: its key and its agent.
    expect((await changes()).map((r) => r.action)).toEqual(["agent.created", "credential.added"]);

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await changeMemberRole(f.db, f.owner.id, f.org.id, bia.id, "owner");
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["caio@acme.com"] });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { instructions: "Be brief.", role: "Support" });
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
      apiKey: "sk-new-abcdefgh1234",
    });
    const [connection] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "linear",
        label: "Linear",
        toolPrefix: "linear",
        serverUrl: "https://mcp.linear.app/sse",
        authType: "none",
      })
      .returning();
    await revokeConnection(f.db, f.owner.id, f.org.id, connection?.id ?? "");
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);

    const rows = await changes();
    expect(rows.map((r) => r.action).slice(0, 7)).toEqual([
      "agent.archived",
      "connector.disconnected",
      "credential.key_changed",
      "agent.updated",
      "invitation.sent",
      "member.removed",
      "member.role_changed",
    ]);
    const byAction = (action: string) => rows.find((r) => r.action === action);
    expect(byAction("member.role_changed")).toMatchObject({
      actor: { id: f.owner.id },
      target: { type: "person", id: bia.id },
      details: { name: "bia", from: "member", to: "owner" },
    });
    expect(byAction("invitation.sent")?.details).toMatchObject({ email: "caio@acme.com", role: "member" });
    expect(byAction("agent.updated")?.details).toMatchObject({ changed: ["instructions", "role"], role: "Support" });
    expect(JSON.stringify(byAction("agent.updated")?.details)).not.toContain("Be brief");
    expect(byAction("credential.key_changed")?.details).toMatchObject({ keyHint: "1234" });
    expect(JSON.stringify(rows)).not.toContain("sk-new-abcdefgh");
  });
});

/** A CSV's rows as a spreadsheet reads them: quoted cells may hold commas, quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  return rows;
}

describe("the audit log as CSV", () => {
  test("every row the list shows, newest first, with the list's filters; cells a spreadsheet won't run", async () => {
    f = await setup();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { name: "=HYPERLINK(1)" });
    await recordAudit(f.db, {
      orgId: f.org.id,
      actor: { type: "person", id: f.owner.id },
      action: "storage.activated",
      target: { type: "storage", id: null },
      details: { note: 'a "quoted", two-line\nnote', apiKey: "sk-ant-api-secret-9876" },
    });
    await recordToolCall(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: null,
      channelId: f.general.id,
      authority: { kind: "person", personId: f.owner.id },
      tool: "mail_sales_send",
      kind: "external",
      connector: "Gmail",
      input: { to: "joao@acme.com", password: "hunter2" },
      outcome: "refused",
    });

    const csv = await auditCsv(f.db, f.owner.id, f.org.id);
    expect(csv).not.toContain("sk-ant-api-secret-9876");
    expect(csv).not.toContain("hunter2");
    const [header, ...rows] = parseCsv(csv);
    expect(header).toEqual([
      "at",
      "actor_type",
      "actor_id",
      "actor",
      "action",
      "target_type",
      "target_id",
      "outcome",
      "channel_id",
      "channel",
      "on_behalf_of",
      "approval",
      "approval_decided_by",
      "secret",
      "run_id",
      "details",
    ]);
    const listed = (await listAudit(f.db, f.owner.id, f.org.id)).rows;
    expect(rows.map((r) => r[4])).toEqual(listed.map((r) => r.action));
    const col = (row: string[] | undefined, name: string) => row?.[header?.indexOf(name) ?? -1];
    const [call, change] = rows;
    expect(col(call, "actor")).toBe("'=HYPERLINK(1)");
    expect(col(call, "outcome")).toBe("refused");
    expect(col(call, "channel")).toBe(f.general.name);
    expect(col(call, "on_behalf_of")).toBe(listed[0]?.onBehalfOf?.name ?? "");
    expect(JSON.parse(col(call, "details") ?? "{}")).toMatchObject({
      connector: "Gmail",
      input: { to: "joao@acme.com" },
    });
    expect(JSON.parse(col(change, "details") ?? "{}")).toMatchObject({ note: 'a "quoted", two-line\nnote' });

    const onlyChanges = parseCsv(await auditCsv(f.db, f.owner.id, f.org.id, { kind: "change" })).slice(1);
    expect(onlyChanges.length).toBe(listed.length - 1);
    expect(onlyChanges.some((r) => r[4] === "tool.call")).toBe(false);
    const problems = parseCsv(await auditCsv(f.db, f.owner.id, f.org.id, { outcome: ["refused", "failed"] }));
    expect(problems.slice(1).map((r) => r[4])).toEqual(["tool.call"]);

    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(auditCsv(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("past one page of the list, every row once, up to the cap", async () => {
    f = await setup();
    for (let i = 0; i < 230; i++) {
      await recordAudit(f.db, {
        orgId: f.org.id,
        actor: { type: "person", id: f.owner.id },
        action: "test.row",
        target: { type: "test", id: String(i) },
      });
    }
    const ids = (csv: string) =>
      parseCsv(csv)
        .slice(1)
        .filter((r) => r[4] === "test.row")
        .map((r) => r[6]);
    const all = ids(await auditCsv(f.db, f.owner.id, f.org.id));
    expect(all).toEqual(Array.from({ length: 230 }, (_, i) => String(229 - i)));
    const capped = ids(await auditCsv(f.db, f.owner.id, f.org.id, {}, 210));
    expect(capped).toEqual(all.slice(0, 210));
  });
});
