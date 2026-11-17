import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { callTool, connectApp, mcp } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** The tools that stop a task, search messages and change an agent's model (ADR 0119 addendum of 2026-11-15). */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Launch is on Friday."] }) });
});
afterEach(() => t.close());

const MANAGE = { access: "manage" as const, scope: "read write manage", name: "Claude" };

async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { b, ownerId, ...seeded };
}

const data = (r: Awaited<ReturnType<typeof callTool>>) => r.structuredContent as Record<string, unknown>;
const text = (r: Awaited<ReturnType<typeof callTool>>) => (r.content as { text: string }[])[0]?.text ?? "";

const auditRows = (orgId: string, action: string) =>
  t.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)));

describe("stop_task", () => {
  test("stops the agent's run on a task, audited with the app; a task that ended says so", async () => {
    const { b, orgId, ownerId, agentId } = await setup();
    const app = await connectApp(t, b, orgId);
    const sent = data(await callTool(t, app.access, "send_to_agent", { agent: "dev", message: "hi", wait_seconds: 0 }));
    const stopped = await callTool(t, app.access, "stop_task", { task_id: String(sent.task_id) });
    expect(stopped.isError).toBeFalsy();
    expect(data(stopped)).toMatchObject({
      stopped: true,
      status: "canceled",
      previous_status: "queued",
      agent: { id: agentId, handle: "dev" },
    });
    const [run] = await t.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, String(data(stopped).run_id)));
    expect(run?.status).toBe("canceled");
    const [row] = await auditRows(orgId, "apps.task_stopped");
    expect(row).toMatchObject({ actorId: ownerId, targetType: "agent_run", targetId: run?.id });
    expect(row?.details).toMatchObject({ client: "Claude Code", agentId });
    expect(await auditRows(orgId, "run.canceled")).toHaveLength(1);
    // Again: nothing to stop, and no error the app would retry.
    const again = await callTool(t, app.access, "stop_task", { task_id: String(sent.task_id) });
    expect(again.isError).toBeFalsy();
    expect(data(again)).toMatchObject({ stopped: false, status: "canceled" });

    const done = data(await callTool(t, app.access, "send_to_agent", { agent: "dev", message: "x", wait_seconds: 0 }));
    await t.drain();
    expect(data(await callTool(t, app.access, "stop_task", { task_id: String(done.task_id) }))).toMatchObject({
      stopped: false,
      status: "done",
    });
    expect(await auditRows(orgId, "apps.task_stopped")).toHaveLength(1);
  });

  test("a run from list_recent_tasks by its id; exactly one of task_id or run_id", async () => {
    const { b, orgId } = await setup();
    const app = await connectApp(t, b, orgId);
    await callTool(t, app.access, "send_to_agent", { agent: "dev", message: "hi", wait_seconds: 0 });
    const working = data(await callTool(t, app.access, "list_recent_tasks", { scope: "working" })) as {
      tasks: { run_id: string }[];
    };
    const runId = working.tasks[0]?.run_id ?? "";
    expect(data(await callTool(t, app.access, "stop_task", { run_id: runId }))).toMatchObject({
      stopped: true,
      run_id: runId,
    });
    const both = await callTool(t, app.access, "stop_task", { run_id: runId, task_id: crypto.randomUUID() });
    expect(both.isError).toBe(true);
    expect((await callTool(t, app.access, "stop_task", {})).isError).toBe(true);
    expect((await callTool(t, app.access, "stop_task", { run_id: crypto.randomUUID() })).isError).toBe(true);
  });

  test("only who asked, the agent's owner or an admin stops it; a read grant has no stop_task", async () => {
    const { b, orgId, channelId } = await setup();
    const ownerApp = await connectApp(t, b, orgId);
    const sent = data(
      await callTool(t, ownerApp.access, "send_to_agent", {
        agent: "dev",
        message: "draft the launch",
        channel_id: channelId,
        wait_seconds: 0,
      }),
    );
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const anaApp = await connectApp(t, ana, orgId);
    const refused = await callTool(t, anaApp.access, "stop_task", { task_id: String(sent.task_id) });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Only who asked");
    const [run] = await t.db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.triggerMessageId, String(sent.task_id)));
    expect(run?.status).toBe("queued");
    expect(await auditRows(orgId, "apps.task_stopped")).toEqual([]);

    const reader = await connectApp(t, b, orgId, { access: "read", name: "Reader" });
    const none = await toolCall(reader.access, "stop_task", { task_id: String(sent.task_id) });
    expect(none.error?.message).toBe("Tool stop_task not found");
  });

  test("a run id of another person's DM tells nothing, queued or ended", async () => {
    const { b, orgId } = await setup();
    const ownerApp = await connectApp(t, b, orgId);
    const sent = data(
      await callTool(t, ownerApp.access, "send_to_agent", { agent: "dev", message: "private", wait_seconds: 0 }),
    );
    const [run] = await t.db
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.triggerMessageId, String(sent.task_id)));
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const anaApp = await connectApp(t, ana, orgId);
    const queued = await callTool(t, anaApp.access, "stop_task", { run_id: String(run?.id) });
    expect([queued.isError, queued.structuredContent]).toEqual([true, undefined]);
    expect(text(queued)).not.toContain("Dev");
    await t.drain();
    const ended = await callTool(t, anaApp.access, "stop_task", { run_id: String(run?.id) });
    expect([ended.isError, ended.structuredContent]).toEqual([true, undefined]);
    expect(text(ended)).not.toContain("Dev");
  });
});

describe("search_messages", () => {
  test("finds messages the person reads, fenced as content, with where and who", async () => {
    const { b, orgId, channelId, agentId } = await setup();
    await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
      json: { body: "@dev when is the launch?" },
    });
    await t.drain();
    const app = await connectApp(t, b, orgId, { access: "read" });
    const res = await callTool(t, app.access, "search_messages", { query: "launch Friday" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toStartWith("Text inside untrusted_text fields");
    const { hits } = data(res) as {
      hits: {
        message_id: string;
        untrusted_text: string;
        channel: { id: string };
        author: { kind: string; name: string };
        url: string;
      }[];
    };
    const reply = hits.find((h) => h.untrusted_text === "Launch is on Friday.");
    expect(reply).toMatchObject({ channel: { id: channelId }, author: { kind: "agent", name: "Dev" } });
    expect(reply?.url).toContain(`/c/${channelId}?m=${reply?.message_id}`);
    expect(agentId).toBeTruthy();
    // In one channel only: one the person can't read finds nothing.
    const elsewhere = data(
      await callTool(t, app.access, "search_messages", { query: "launch", channel_id: crypto.randomUUID() }),
    ) as { hits: unknown[] };
    expect(elsewhere.hits).toEqual([]);
  });

  test("never another person's DM, nor a private channel the person isn't in", async () => {
    const { b, orgId } = await setup();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const anaApp = await connectApp(t, ana, orgId);
    await callTool(t, anaApp.access, "send_to_agent", {
      agent: "dev",
      message: "zebra salary review",
      wait_seconds: 0,
    });
    const priv = (await (
      await b(`/api/app/organizations/${orgId}/channels`, { json: { name: "board", visibility: "private" } })
    ).json()) as { id: string };
    await b(`/api/app/organizations/${orgId}/channels/${priv.id}/messages`, { json: { body: "quokka budget cut" } });
    await t.drain();
    const ownerApp = await connectApp(t, b, orgId, { access: "read" });
    const hitsOf = async (bearer: string, query: string) =>
      (
        data(await callTool(t, bearer, "search_messages", { query })) as { hits: { untrusted_text: string }[] }
      ).hits.map((h) => h.untrusted_text);
    // The owner is an admin: every channel, never someone else's DM.
    expect(await hitsOf(ownerApp.access, "zebra")).toEqual([]);
    expect(await hitsOf(anaApp.access, "zebra")).toEqual(["zebra salary review"]);
    expect(await hitsOf(anaApp.access, "quokka")).toEqual([]);
    expect(await hitsOf(ownerApp.access, "quokka")).toEqual(["quokka budget cut"]);
  });
});

describe("set_agent_model", () => {
  test("changes the agent's model, audited with the app; a model nobody offers is refused with the choices", async () => {
    const { b, orgId, ownerId, agentId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const res = await callTool(t, app.access, "set_agent_model", { agent: "dev", model: "claude-haiku-5-5" });
    expect(res.isError).toBeFalsy();
    expect(data(res)).toMatchObject({ id: agentId, brain: "model", model: "claude-haiku-5-5" });
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent?.model).toBe("claude-haiku-5-5");
    const updated = await auditRows(orgId, "apps.updated");
    expect(updated[0]).toMatchObject({ actorId: ownerId, targetType: "agent", targetId: agentId });
    expect(updated[0]?.details).toMatchObject({ client: "Claude", changed: ["model"] });

    const bad = await callTool(t, app.access, "set_agent_model", { agent: "dev", model: "gpt-nonexistent-9" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("claude-sonnet-5-5");
    const [after] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(after?.model).toBe("claude-haiku-5-5");
  });

  test("only an admin or the agent's owner; not the team's right hand; not without manage", async () => {
    const { b, orgId, agentId } = await setup();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const anaApp = await connectApp(t, ana, orgId, MANAGE);
    const refused = await callTool(t, anaApp.access, "set_agent_model", { agent: "dev", model: "claude-haiku-5-5" });
    expect(refused.isError).toBe(true);
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent?.model).toBe("claude-sonnet-5-5");

    const ownerApp = await connectApp(t, b, orgId, MANAGE);
    const rightHand = await callTool(t, ownerApp.access, "set_agent_model", {
      agent: "lodi",
      model: "claude-haiku-5-5",
    });
    expect(rightHand.isError).toBe(true);
    expect(text(rightHand)).toContain("right hand");

    const writer = await connectApp(t, b, orgId, { access: "write", name: "Writer" });
    const none = await toolCall(writer.access, "set_agent_model", { agent: "dev", model: "claude-haiku-5-5" });
    expect(none.error?.message).toBe("Tool set_agent_model not found");
  });

  test("on a computer brain: the brain's own model names", async () => {
    const { b, orgId, agentId } = await setup();
    await t.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, agentId));
    const app = await connectApp(t, b, orgId, MANAGE);
    const res = await callTool(t, app.access, "set_agent_model", { agent: "dev", model: "opus" });
    expect(res.isError).toBeFalsy();
    expect(data(res)).toMatchObject({ brain: "claude_code", model: "opus" });
    const bad = await callTool(t, app.access, "set_agent_model", { agent: "dev", model: "gpt-9" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Opus, Sonnet, Haiku");
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent?.brainModel).toBe("opus");
  });
});

describe("create_channel", () => {
  test("needs the permission to create channels, and manage", async () => {
    const { b, orgId } = await setup();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const anaApp = await connectApp(t, ana, orgId, MANAGE);
    const off = await b(`/api/app/organizations/${orgId}/permissions/create_channels`, {
      method: "PUT",
      json: { everyone: 0, roles: [] },
    });
    expect(off.status).toBe(200);
    const refused = await callTool(t, anaApp.access, "create_channel", { name: "side-project" });
    expect(refused.isError).toBe(true);
    const made = await t.db.select().from(schema.channels).where(eq(schema.channels.name, "side-project"));
    expect(made).toEqual([]);
    const writer = await connectApp(t, b, orgId, { access: "write", name: "Writer" });
    expect((await toolCall(writer.access, "create_channel", { name: "x" })).error?.message).toBe(
      "Tool create_channel not found",
    );
  });
});

/** A `tools/call` whose answer may be a JSON-RPC error (a tool this connection doesn't have). */
const toolCall = async (bearer: string, name: string, args: Record<string, unknown>) =>
  (await (
    await mcp(t, bearer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  ).json()) as { error?: { message: string } };
