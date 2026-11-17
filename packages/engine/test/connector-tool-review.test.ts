import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  aheadRefusal,
  type CustomDeps,
  classifyByRules,
  connectCustomServer,
  connectorGrantValidator,
  createConnectorToolSource,
  createFakeJudge,
  createToolGateway,
  describeToolName,
  getAgentAccess,
  getApproval,
  type Judge,
  type McpConnect,
  mcpSessionOver,
  postPersonMessage,
  refreshCustomServer,
  saveCustomTools,
  setAgentScopes,
  sharedPrefix,
  updateAgent,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const WHY = "The person asked for this and the checks passed: this action finishes what was requested.";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("classification by the rules", () => {
  test("annotations first: readOnlyHint → read, destructiveHint → approval as a suggestion", () => {
    expect(classifyByRules({ name: "delete_preview", readOnlyHint: true })).toEqual({
      level: "read",
      source: "annotation",
      reason: "read_only_hint",
      sensitive: false,
    });
    expect(classifyByRules({ name: "status_update", destructiveHint: true })).toEqual({
      level: "approval",
      source: "annotation",
      reason: "destructive_hint",
      sensitive: false,
    });
    // The hint alone never locks, whatever the name's other verb; a verb of ours does, hint or not.
    expect(classifyByRules({ name: "move_task", destructiveHint: true })?.sensitive).toBe(false);
    expect(classifyByRules({ name: "task_delete" })?.sensitive).toBe(true);
    expect(classifyByRules({ name: "task_delete", destructiveHint: true })).toEqual({
      level: "approval",
      source: "verb",
      reason: "verb_sensitive",
      sensitive: true,
    });
    // With the hint, one of our words anywhere in the name locks; without it, only the name's verb decides.
    expect(classifyByRules({ name: "create_and_send_invoice", destructiveHint: true })?.sensitive).toBe(true);
    expect(classifyByRules({ name: "update_share_settings", destructiveHint: true })?.sensitive).toBe(true);
    expect(classifyByRules({ name: "update_share_settings" })?.sensitive).toBe(false);
    // A hinted tool with a sensitive verb stays locked even on a preset's read-only list.
    expect(classifyByRules({ name: "task_delete", destructiveHint: true }, ["task_delete"])?.sensitive).toBe(true);
    // A preset's read-only tools.
    expect(classifyByRules({ name: "execute_sql" }, ["execute_sql"])?.level).toBe("read");
  });

  test("then the verb, first or last in the name; sensitive verbs ask and can't be freed", () => {
    const level = (name: string) => {
      const c = classifyByRules({ name });
      return c ? `${c.level}${c.sensitive ? "!" : ""}` : null;
    };
    expect(
      ["list_tickets", "ad_get", "campaignBudget_get", "search-docs", "audience_size_estimate"].map(level),
    ).toEqual(["read", "read", "read", "read", "read"]);
    expect(
      ["create_ticket", "adgroup_budget_update", "catalog_product_set", "video_upload", "ad_copy"].map(level),
    ).toEqual(["write", "write", "write", "write", "write"]);
    expect(
      [
        "delete_customer",
        "bc_member_remove",
        "send_email",
        "invoice_pay",
        "identity_video_publish",
        "balance_transfer",
        "refund_payment",
        "spark_auth_unbind",
        "audience_share",
        "merge_pull_request",
        "github_delete_repo",
      ].map(level),
    ).toEqual(Array(11).fill("approval!"));
    // A noun that looks like a verb doesn't fool it: the verb is at the end.
    expect(level("balance_transfer_get")).toBe("read");
    // The name doesn't say: ambiguous (the judge suggests).
    expect(
      ["pixel_track", "report_task_run", "close_ticket", "execute_sql", "catalog_feed_refresh"].map(level),
    ).toEqual([null, null, null, null, null]);
  });

  test("readable parts and subjects from the name (shared prefixes dropped)", () => {
    expect(describeToolName("adgroup_budget_get")).toEqual({
      verb: "get",
      words: ["adgroup", "budget"],
      subject: "adgroup",
    });
    expect(describeToolName("get_campaign_budget")).toEqual({
      verb: "get",
      words: ["campaign", "budget"],
      subject: "campaign",
    });
    expect(describeToolName("close_ticket").subject).toBe("ticket");
    expect(describeToolName("list_tickets").subject).toBe("ticket");
    expect(describeToolName("categories").subject).toBe("category");
    expect(describeToolName("ping")).toEqual({ verb: null, words: ["ping"], subject: "ping" });
    expect(sharedPrefix(["github_create_issue", "github_list_repos"])).toBe("github");
    expect(sharedPrefix(["list_issues", "list_repos"])).toBeNull();
    expect(describeToolName("github_create_issue", "github")).toEqual({
      verb: "create",
      words: ["issue"],
      subject: "issue",
    });
  });
});

/** An ads server: read, write and sensitive verbs, two annotations and two names the verb can't decide. */
function adsMcp() {
  const state = { calls: [] as string[], extra: false, warnLate: false };
  const tool = (server: McpServer, name: string, annotations: Record<string, boolean> = {}) =>
    server.registerTool(
      name,
      { description: `${name} (as the server describes it)`, inputSchema: { id: z.number().optional() }, annotations },
      async () => {
        state.calls.push(name);
        return { content: [{ type: "text", text: `${name} done` }] };
      },
    );
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "ads", version: "1" });
    tool(server, "campaign_list");
    tool(server, "campaign_budget_update", state.warnLate ? { destructiveHint: true } : {});
    tool(server, "campaign_delete");
    tool(server, "report_export", { readOnlyHint: true });
    tool(server, "campaign_status_toggle", { destructiveHint: true });
    tool(server, "pixel_track");
    tool(server, "report_task_run");
    if (state.extra) tool(server, "catalog_feed_refresh");
    const [client, end] = InMemoryTransport.createLinkedPair();
    await server.connect(end);
    return mcpSessionOver(client);
  };
  return { connect, state };
}

const depsOf = (fx: Fixture, extra: Partial<CustomDeps> = {}): CustomDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
  ...extra,
});

/** The judge's suggestion for each tool, by the tool's id in the batch. */
function adsJudge() {
  const answers: Record<string, [string, string]> = {
    pixel_track: ["write", "changes_undoable"],
    report_task_run: ["read", "reads_only"],
    catalog_feed_refresh: ["write", "replaces_data"],
  };
  return createFakeJudge((kind, id, state) => {
    if (kind !== "connector_tool_level") return undefined;
    const i = Number(id.split("_").at(-1));
    const tools = state.tools as { id: string; name: string }[];
    const pair = answers[tools[i]?.name ?? ""];
    if (!pair) return undefined;
    return id.startsWith("level_") ? pair[0] : pair[1];
  });
}

async function connectAds(fx: Fixture, deps: CustomDeps) {
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: "https://ads.example.com/mcp",
    apiKey: "ads_secret_12345",
    label: "Ads",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  return started.server;
}

async function runContext(fx: Fixture) {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
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

describe("listing a connection's tools", () => {
  test("each tool comes classified; the ambiguous ones by the judge, in one batch, kept for the next listing", async () => {
    f = await setup();
    const mcp = adsMcp();
    const judge = adsJudge();
    const deps = depsOf(f, { connect: mcp.connect, judge });
    const server = await connectAds(f, deps);
    const by = new Map(server.tools.map((t) => [t.name, t]));
    const row = (name: string) => {
      const t = by.get(name);
      return [t?.level, t?.suggestionSource, t?.suggestionReason, t?.sensitive, t?.pending];
    };
    expect(row("campaign_list")).toEqual(["read", "verb", "verb_read", false, false]);
    expect(row("campaign_budget_update")).toEqual(["write", "verb", "verb_write", false, false]);
    expect(row("campaign_delete")).toEqual(["approval", "verb", "verb_sensitive", true, false]);
    expect(row("report_export")).toEqual(["read", "annotation", "read_only_hint", false, false]);
    expect(row("campaign_status_toggle")).toEqual(["approval", "annotation", "destructive_hint", false, false]);
    expect(row("pixel_track")).toEqual(["write", "judge", "changes_undoable", false, true]);
    expect(row("report_task_run")).toEqual(["read", "judge", "reads_only", false, true]);
    // Subjects and readable parts come from the name; nothing is decided yet.
    expect(by.get("campaign_budget_update")).toMatchObject({
      subject: "campaign",
      nameParts: { verb: "update", words: ["campaign", "budget"] },
      access: null,
      off: false,
    });
    // One request for both ambiguous tools; only their names and descriptions go in.
    expect(judge.calls.filter((c) => c.kind === "connector_tool_level")).toHaveLength(1);
    expect(((judge.calls[0]?.state.tools ?? []) as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "pixel_track",
      "report_task_run",
    ]);

    // Listing again asks only about the new ambiguous tool (answers are kept per tool name).
    mcp.state.extra = true;
    const again = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
    expect(judge.calls).toHaveLength(2);
    expect(((judge.calls[1]?.state.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual([
      "catalog_feed_refresh",
    ]);
    expect(again.tools.find((t) => t.name === "catalog_feed_refresh")).toMatchObject({
      level: "write",
      suggestionReason: "replaces_data",
      pending: true,
    });
    expect(again.tools.find((t) => t.name === "pixel_track")?.suggestionReason).toBe("changes_undoable");
  });

  test("the judge fails (or there is none): approval, 'couldn't tell', still waiting; asked again next time", async () => {
    f = await setup();
    const mcp = adsMcp();
    let fail = true;
    const working = adsJudge();
    const judge: Judge = {
      name: "flaky",
      async ask(request) {
        if (fail) throw new Error("judge down");
        return working.ask(request);
      },
    };
    const deps = depsOf(f, { connect: mcp.connect, judge });
    const server = await connectAds(f, deps);
    expect(server.tools.find((t) => t.name === "pixel_track")).toMatchObject({
      level: "approval",
      suggestionSource: "judge_failed",
      suggestionReason: "unknown",
      pending: true,
      sensitive: false,
    });
    fail = false;
    const again = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
    expect(again.tools.find((t) => t.name === "pixel_track")).toMatchObject({
      level: "write",
      suggestionSource: "judge",
      pending: true,
    });

    // No judge at all: the same safe suggestion.
    const none = await connectCustomServer(depsOf(f, { connect: mcp.connect }), f.owner.id, f.org.id, {
      serverUrl: "https://ads2.example.com/mcp",
      apiKey: "ads_secret_12345",
    });
    if (none.status !== "connected") throw new Error("expected connected");
    expect(none.server.tools.find((t) => t.name === "report_task_run")).toMatchObject({
      level: "approval",
      suggestionReason: "unknown",
    });
  });
});

describe("a preset's tools that call, buy or write to people under other words", () => {
  test("AgentPhone: calling and buying a number always ask, like a send; its other tools keep our usual rules", async () => {
    f = await setup();
    const connect: McpConnect = async () => {
      const server = new McpServer({ name: "agentphone", version: "1" });
      for (const name of ["make_call", "buy_number", "send_message", "list_calls", "create_agent"]) {
        server.registerTool(name, { description: name }, async () => ({ content: [{ type: "text", text: "ok" }] }));
      }
      const [client, end] = InMemoryTransport.createLinkedPair();
      await server.connect(end);
      return mcpSessionOver(client);
    };
    const started = await connectCustomServer(depsOf(f, { connect }), f.owner.id, f.org.id, {
      serverUrl: "https://mcp.agentphone.ai/mcp",
      apiKey: "agentphone_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const row = (name: string) => {
      const t = started.server.tools.find((x) => x.name === name);
      return [t?.level, t?.suggestionReason, t?.sensitive];
    };
    expect(row("make_call")).toEqual(["approval", "reaches_people", true]);
    expect(row("buy_number")).toEqual(["approval", "spends_money", true]);
    expect(row("send_message")).toEqual(["approval", "verb_sensitive", true]);
    expect(row("list_calls")).toEqual(["read", "verb_read", false]);
    expect(row("create_agent")).toEqual(["write", "verb_write", false]);
    // Another server's tool of the same name keeps the rule of its words, and our verb's reason comes first.
    expect(classifyByRules({ name: "make_call" })).toBeNull();
    expect(classifyByRules({ name: "send_draft" }, [], [], { send_draft: "reaches_people" })).toMatchObject({
      reason: "verb_sensitive",
      sensitive: true,
    });
  });
});

describe("Telnyx and Agentcard: every call of theirs asks a person, one call at a time", () => {
  /** A server with these tools that records each call; `amount_cents` and `request` as Agentcard's take them. */
  function serverWith(name: string, tools: readonly string[]) {
    const calls: string[] = [];
    const connect: McpConnect = async () => {
      const server = new McpServer({ name, version: "1" });
      for (const tool of tools) {
        server.registerTool(
          tool,
          { description: tool, inputSchema: { amount_cents: z.number().optional(), request: z.string().optional() } },
          async () => {
            calls.push(tool);
            return { content: [{ type: "text", text: "ok" }] };
          },
        );
      }
      const [client, end] = InMemoryTransport.createLinkedPair();
      await server.connect(end);
      return mcpSessionOver(client);
    };
    return { connect, calls };
  }

  test("each tool they list asks, the ones the preset doesn't name too, and none can be made a read", async () => {
    f = await setup();
    const telnyx = serverWith("telnyx", ["list_api_endpoints", "invoke_api_endpoint"]);
    const t = await connectCustomServer(depsOf(f, { connect: telnyx.connect }), f.owner.id, f.org.id, {
      serverUrl: "https://api.telnyx.com/v2/mcp",
      apiKey: "telnyx_secret_12345",
    });
    if (t.status !== "connected") throw new Error(`expected connected, got ${t.status}`);
    const agentcard = serverWith("agentcard", ["get_balance", "buy", "send_support_message", "plan_a_trip"]);
    const deps = depsOf(f, { connect: agentcard.connect });
    const a = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: "https://mcp.agentcard.sh/mcp",
      apiKey: "agentcard_secret_12345",
    });
    if (a.status !== "connected") throw new Error(`expected connected, got ${a.status}`);
    const row = (tools: typeof t.server.tools, name: string) => {
      const tool = tools.find((x) => x.name === name);
      return [tool?.level, tool?.suggestionReason, tool?.sensitive];
    };
    expect(row(t.server.tools, "list_api_endpoints")).toEqual(["approval", "every_call", true]);
    expect(row(t.server.tools, "invoke_api_endpoint")).toEqual(["approval", "spends_money", true]);
    expect(row(a.server.tools, "get_balance")).toEqual(["approval", "every_call", true]);
    expect(row(a.server.tools, "buy")).toEqual(["approval", "spends_money", true]);
    expect(row(a.server.tools, "send_support_message")).toEqual(["approval", "verb_sensitive", true]);
    // A tool its server lists later, which the preset never named.
    expect(row(a.server.tools, "plan_a_trip")).toEqual(["approval", "every_call", true]);
    await expect(
      saveCustomTools(deps, f.owner.id, f.org.id, a.server.id, {
        label: "Agentcard",
        tools: [{ name: "get_balance", access: "read", label: "x" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect([...telnyx.calls, ...agentcard.calls]).toEqual([]);
  });

  test("never kept with Aprovar sempre nor approved ahead, whatever is stored; the card names the request and the amount", async () => {
    f = await setup();
    const fx = f;
    const agentcard = serverWith("agentcard", ["get_balance", "buy"]);
    const deps = depsOf(fx, { connect: agentcard.connect });
    const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl: "https://mcp.agentcard.sh/mcp",
      apiKey: "agentcard_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, id);
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: id, scope: `custom:${id}:read` },
        { connectionId: id, scope: `custom:${id}:write` },
      ],
      connectorGrantValidator,
    );
    const source = createConnectorToolSource(deps);
    const gateway = createToolGateway({ sources: [source] });
    const ctx = await runContext(fx);
    const request = "a pack of AA batteries from Amazon";
    const buy = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "agentcard_buy",
      input: { request, amount_cents: 1299, why: WHY },
    });
    const balance = await gateway.invoke(ctx, {
      toolUseId: "t2",
      name: "agentcard_get_balance",
      input: { why: WHY },
    });
    if (buy.type !== "approval" || balance.type !== "approval") throw new Error("expected both to ask");
    const rows = await fx.db.select().from(schema.approvals);
    expect(rows.map((r) => r.approveAlways)).toEqual([null, null]);
    expect((await getApproval(fx.db, fx.owner.id, fx.org.id, buy.approval.id)).callArgs).toEqual({
      does: "request",
      usdCents: "amount_cents",
    });
    expect((await getApproval(fx.db, fx.owner.id, fx.org.id, balance.approval.id)).callArgs).toBeNull();
    const tools = (await source.tools(ctx)).filter((tool) => tool.name.startsWith("agentcard_"));
    expect(tools.length).toBe(2);
    // Neither approved ahead nor a routine's own action: both go through this refusal (`ownJobCovers`, `routineKind`).
    for (const tool of tools) expect(aheadRefusal(tool, {})).toContain("decides each call of this service");

    // A level stored as a free read before the preset said otherwise still asks.
    await fx.db
      .update(schema.customTools)
      .set({ access: "read", sensitive: false })
      .where(eq(schema.customTools.connectionId, id));
    const again = await gateway.invoke(ctx, { toolUseId: "t3", name: "agentcard_get_balance", input: { why: WHY } });
    expect(again.type).toBe("approval");
    expect(agentcard.calls).toEqual([]);

    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { approvalsLevel: "always" });
    const always = await gateway.invoke(ctx, {
      toolUseId: "t4",
      name: "agentcard_buy",
      input: { request, amount_cents: 1299, why: WHY },
    });
    expect(always.type).toBe("approval");
    expect(agentcard.calls).toEqual([]);
  });

  test("an agent that never asks (ADR 0173) is neither offered them nor runs them, and its access says why", async () => {
    f = await setup();
    const fx = f;
    const agentcard = serverWith("agentcard", ["get_balance", "buy"]);
    const deps = depsOf(fx, { connect: agentcard.connect });
    const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl: "https://mcp.agentcard.sh/mcp",
      apiKey: "agentcard_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, id);
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: id, scope: `custom:${id}:read` },
        { connectionId: id, scope: `custom:${id}:write` },
      ],
      connectorGrantValidator,
    );
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(fx);
    const offered = async () => (await gateway.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("agentcard_"));
    expect(await offered()).toEqual(["agentcard_buy", "agentcard_get_balance"]);

    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { approvalsLevel: "never" });
    // The agent still never asks: these tools are simply not its to use at that level.
    expect(await offered()).toEqual([]);
    for (const name of ["agentcard_buy", "agentcard_get_balance"]) {
      const refused = await gateway.invoke(ctx, {
        toolUseId: `t-${name}`,
        name,
        input: { request: "a pack of AA batteries", amount_cents: 1299, why: WHY },
      });
      if (refused.type !== "result") throw new Error(`expected a refusal, got ${refused.type}`);
      expect(refused.output.isError).toBe(true);
      expect(refused.output.data).toMatchObject({ code: "tool.not_allowed", refusal: "policy" });
      expect(refused.output.content).toContain("never asks");
    }
    expect(agentcard.calls).toEqual([]);
    expect(await fx.db.select().from(schema.approvals)).toEqual([]);

    // Its access page says the connection's tools are unavailable at that level, by the same preset.
    const access = await getAgentAccess(fx.db, fx.owner.id, fx.org.id, fx.agent.id);
    expect(access.connectors.find((c) => c.connectionId === id)?.everyCall).toBe(true);

    // Back at the default level they ask again, one call at a time.
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { approvalsLevel: "risky" });
    const asked = await gateway.invoke(ctx, {
      toolUseId: "t-again",
      name: "agentcard_buy",
      input: { request: "a pack of AA batteries", amount_cents: 1299, why: WHY },
    });
    expect(asked.type).toBe("approval");
  });

  test("a tool that would put a card's number and CVV in the agent's history is never listed, stored or offered", async () => {
    f = await setup();
    const fx = f;
    const agentcard = serverWith("agentcard", ["get_balance", "get_card_details", "approve_request", "buy"]);
    const deps = depsOf(fx, { connect: agentcard.connect });
    const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl: "https://mcp.agentcard.sh/mcp",
      apiKey: "agentcard_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    expect(started.server.tools.map((t) => t.name).sort()).toEqual(["buy", "get_balance"]);
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, id);
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: id, scope: `custom:${id}:read` },
        { connectionId: id, scope: `custom:${id}:write` },
      ],
      connectorGrantValidator,
    );
    // A row stored for it before the preset withheld it (here the balance's, renamed) still offers nothing.
    await fx.db
      .update(schema.customTools)
      .set({ name: "get_card_details" })
      .where(eq(schema.customTools.name, "get_balance"));
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(fx);
    const names = (await gateway.list(ctx)).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("agentcard_"))).toEqual(["agentcard_buy"]);
    const tried = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "agentcard_get_card_details",
      input: { why: WHY },
    });
    if (tried.type !== "result") throw new Error(`expected a refusal, got ${tried.type}`);
    expect(tried.output.isError).toBe(true);
    expect(agentcard.calls).toEqual([]);
    expect(await fx.db.select().from(schema.approvals)).toEqual([]);
  });

  /** Read and write on this connection for the fixture's agent. */
  const grantAll = (fx: Fixture, id: string) =>
    setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: id, scope: `custom:${id}:read` },
        { connectionId: id, scope: `custom:${id}:write` },
      ],
      connectorGrantValidator,
    );

  // The locks go by the preset's host: a query, another case in the path or extra slashes don't make it another service.
  test.each([
    "https://mcp.agentcard.sh/mcp?team=growth",
    "https://MCP.Agentcard.sh/MCP",
    "https://mcp.agentcard.sh/mcp//",
  ])("typed as %s, the preset's locks still hold", async (serverUrl) => {
    f = await setup();
    const fx = f;
    const agentcard = serverWith("agentcard", ["get_balance", "get_card_details", "buy"]);
    const deps = depsOf(fx, { connect: agentcard.connect });
    const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl,
      label: "Agentcard",
      apiKey: "agentcard_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    expect(started.server.tools.map((t) => t.name).sort()).toEqual(["buy", "get_balance"]);
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, id);
    await grantAll(fx, id);
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(fx);
    const offered = async () => (await gateway.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("agentcard_"));
    expect(await offered()).toEqual(["agentcard_buy", "agentcard_get_balance"]);
    const balance = await gateway.invoke(ctx, { toolUseId: "t1", name: "agentcard_get_balance", input: { why: WHY } });
    expect(balance.type).toBe("approval");
    expect((await getAgentAccess(fx.db, fx.owner.id, fx.org.id, fx.agent.id)).connectors[0]?.everyCall).toBe(true);
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { approvalsLevel: "never" });
    expect(await offered()).toEqual([]);
    expect(agentcard.calls).toEqual([]);
  });

  test("a connection stored before, at an address of the preset's host, gets the locks too", async () => {
    f = await setup();
    const fx = f;
    const agentcard = serverWith("agentcard", ["get_balance", "get_card_details", "buy"]);
    const deps = depsOf(fx, { connect: agentcard.connect });
    // Stored as a plain server would have been: every tool kept, each one a free read or write.
    const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl: "https://cards.example.com/mcp",
      label: "Agentcard",
      apiKey: "agentcard_secret_12345",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    expect(started.server.tools.map((t) => t.name).sort()).toEqual(["buy", "get_balance", "get_card_details"]);
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, id);
    await fx.db
      .update(schema.customTools)
      .set({ access: "write", sensitive: false })
      .where(eq(schema.customTools.connectionId, id));
    await fx.db
      .update(schema.connectorConnections)
      .set({ serverUrl: "https://mcp.agentcard.sh/mcp?team=growth" })
      .where(eq(schema.connectorConnections.id, id));
    await grantAll(fx, id);
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(fx);
    const offered = async () => (await gateway.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("agentcard_"));
    expect(await offered()).toEqual(["agentcard_buy", "agentcard_get_balance"]);
    const buy = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "agentcard_buy",
      input: { request: "a pack of AA batteries", amount_cents: 1299, why: WHY },
    });
    expect(buy.type).toBe("approval");
    const details = await gateway.invoke(ctx, {
      toolUseId: "t2",
      name: "agentcard_get_card_details",
      input: { why: WHY },
    });
    if (details.type !== "result") throw new Error(`expected a refusal, got ${details.type}`);
    expect(details.output.isError).toBe(true);
    expect(agentcard.calls).toEqual([]);
    // Its next sync closes the withheld tool's row.
    await refreshCustomServer(deps, fx.owner.id, fx.org.id, id);
    const [row] = await fx.db.select().from(schema.customTools).where(eq(schema.customTools.name, "get_card_details"));
    expect(row?.removedAt).not.toBeNull();
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { approvalsLevel: "never" });
    expect(await offered()).toEqual([]);
  });
});

describe("the person's choices", () => {
  test("saved per tool: off is hidden, approval asks, change runs and is audited; confirming ends 'pending'", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect, judge: adsJudge() });
    const server = await connectAds(fx, deps);

    // A sensitive tool may only ask or be off.
    await expect(
      saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
        label: "Ads",
        tools: [{ name: "campaign_delete", access: "read", label: "x" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
        label: "Ads",
        tools: [{ name: "campaign_delete", access: "write", label: "x" }],
      }),
    ).rejects.toThrow("can only ask for approval or be off");

    const decisions: Record<string, "read" | "write" | "approval" | "off"> = {
      campaign_list: "read",
      campaign_budget_update: "write",
      campaign_delete: "approval",
      report_export: "off",
      campaign_status_toggle: "off",
      pixel_track: "approval", // decided by the person
      report_task_run: "read", // the suggestion applies, but it still waits for a decision
    };
    const saved = await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: Object.entries(decisions).map(([name, access]) => ({
        name,
        access,
        label: name,
        confirmed: name !== "report_task_run",
      })),
    });
    const pending = saved.tools.filter((t) => t.pending).map((t) => t.name);
    expect(pending).toEqual(["report_task_run"]);
    expect(saved.tools.find((t) => t.name === "report_export")).toMatchObject({ off: true, level: "off" });

    const source = createConnectorToolSource(deps);
    const gateway = createToolGateway({ sources: [source] });
    const ctx = await runContext(fx);
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: server.id, scope: `custom:${server.id}:read` },
        { connectionId: server.id, scope: `custom:${server.id}:write` },
      ],
      connectorGrantValidator,
    );
    const offered = (await gateway.list(ctx)).map((t) => t.name).sort();
    // Off tools are never offered.
    expect(offered).toEqual([
      "ads_campaign_budget_update",
      "ads_campaign_delete",
      "ads_campaign_list",
      "ads_pixel_track",
      "ads_report_task_run",
    ]);
    const call = (name: string, id: string, why?: string) =>
      gateway.invoke(ctx, { toolUseId: id, name, input: why ? { id: 1, why } : { id: 1 } });
    expect((await call("ads_campaign_list", "t1")).type).toBe("result");
    expect((await call("ads_campaign_budget_update", "t2")).type).toBe("result");
    const ask = await call("ads_campaign_delete", "t3", WHY);
    expect(ask.type).toBe("approval");
    expect((await call("ads_pixel_track", "t4", WHY)).type).toBe("approval");
    expect(mcp.state.calls).toEqual(["campaign_list", "campaign_budget_update"]);
    const audit = await fx.db.select().from(schema.auditLog);
    const changed = audit.filter((a) => a.action === "connector.tool_changed");
    expect(changed.map((a) => [a.actorType, a.actorId, (a.details as { tool: string }).tool])).toEqual([
      ["agent", fx.agent.id, "campaign_budget_update"],
    ]);

    // Accepting the suggestions keeps decisions and doesn't confirm what still waits.
    const accepted = await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, server.id);
    expect(accepted.server.tools.find((t) => t.name === "report_export")?.access).toBe("off");
    expect(accepted.server.tools.filter((t) => t.pending).map((t) => t.name)).toEqual(["report_task_run"]);
  });

  test("a stored free decision on a sensitive tool still asks for approval", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect });
    const server = await connectAds(fx, deps);
    await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: [{ name: "campaign_delete", access: "approval", label: "Apagar campanha" }],
    });
    // Written around the API (old data): the gateway still gates it.
    await fx.db.update(schema.customTools).set({ access: "write" });
    const source = createConnectorToolSource(deps);
    const tools = await source.tools(await runContext(fx));
    expect(tools.find((t) => t.name === "ads_campaign_delete")?.sensitive).toBe(true);
    // Listing again turns it back to approval.
    const again = await refreshCustomServer(deps, fx.owner.id, fx.org.id, server.id);
    expect(again.tools.find((t) => t.name === "campaign_delete")?.access).toBe("approval");
  });

  test("a tool the server only warns about starts at approval and obeys the level an admin gives it", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect });
    const server = await connectAds(fx, deps);
    const accepted = await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, server.id);
    expect(accepted.server.tools.find((t) => t.name === "campaign_status_toggle")).toMatchObject({
      access: "approval",
      sensitive: false,
    });
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [{ connectionId: server.id, scope: `custom:${server.id}:write` }],
      connectorGrantValidator,
    );
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(fx);
    const call = (id: string) =>
      gateway.invoke(ctx, { toolUseId: id, name: "ads_campaign_status_toggle", input: { id: 1, why: WHY } });
    expect((await call("t1")).type).toBe("approval");
    expect(mcp.state.calls).toEqual([]);

    await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: [{ name: "campaign_status_toggle", access: "write", label: "Mudar status" }],
    });
    expect((await call("t2")).type).toBe("result");
    expect(mcp.state.calls).toEqual(["campaign_status_toggle"]);
    // Listing again keeps the admin's level: the server's warning is only a suggestion.
    const again = await refreshCustomServer(deps, fx.owner.id, fx.org.id, server.id);
    expect(again.tools.find((t) => t.name === "campaign_status_toggle")).toMatchObject({
      access: "write",
      sensitive: false,
    });
  });

  test("a warning the server starts sending after the level was chosen asks again, and the admin can set it back", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect });
    const server = await connectAds(fx, deps);
    await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, server.id);
    const budget = (tools: { name: string; access: string | null; sensitive: boolean }[]) => {
      const t = tools.find((x) => x.name === "campaign_budget_update");
      return [t?.access, t?.sensitive];
    };
    const relist = async () => budget((await refreshCustomServer(deps, fx.owner.id, fx.org.id, server.id)).tools);
    expect(await relist()).toEqual(["write", false]);

    mcp.state.warnLate = true;
    expect(await relist()).toEqual(["approval", false]);

    const saved = await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: [{ name: "campaign_budget_update", access: "write", label: "Mudar verba" }],
    });
    expect(budget(saved.tools)).toEqual(["write", false]);
    expect(await relist()).toEqual(["write", false]);
  });
});
