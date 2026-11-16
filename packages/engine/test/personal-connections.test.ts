import { afterEach, describe, expect, test } from "bun:test";
import { type ComposioTool, createFakeComposioClient, fakeMailAuthError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  acceptCustomSuggestion,
  beginPersonalConnect,
  type CustomDeps,
  completeOAuth,
  composioToolkitUrl,
  connectCustomServer,
  createAgentRuns,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  disconnectPersonal,
  ForbiddenError,
  insertMessage,
  listCustomServers,
  mcpPreset,
  meterComposio,
  type RoutineBrief,
  revokeConnection,
  setPerPerson,
  syncCustomTools,
  type ToolContext,
  ValidationError,
  withComposio,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const DRIVE = composioToolkitUrl("googledrive");
const VERSION = mcpPreset("drive")?.composio?.version ?? "";
const WHY = "The client asked for the report in the shared folder: this gives them read access to it.";

const tool = (slug: string, tags: string[] = []): ComposioTool => ({
  slug,
  description: `${slug} (fake)`,
  inputSchema: { type: "object", properties: { q: { type: "string" }, folder: { type: "string" } } },
  tags,
});

/**
 * Google Drive through a fake Composio, connected by the owner as the workspace's account and turned per person, with
 * Bea, a member who doesn't manage connectors.
 */
async function world() {
  f = await setup();
  const fake = createFakeComposioClient({ beforeToolCall: meterComposio({ db: f.db, cap: 0 }) });
  fake.addTools("googledrive", VERSION, [
    tool("GOOGLEDRIVE_FIND_FILE", ["readOnlyHint"]),
    tool("GOOGLEDRIVE_CREATE_FOLDER"),
    tool("GOOGLEDRIVE_CREATE_PERMISSION", ["readOnlyHint"]),
  ]);
  const signedIn = { email: "admin@acme.com" };
  fake.answer("GOOGLEDRIVE_GET_ABOUT", () => ({ user: { emailAddress: signedIn.email, displayName: "Someone" } }));
  fake.answer("GOOGLEDRIVE_FIND_FILE", { files: [{ id: "f1", name: "Contrato" }] });
  const composio = { client: fake.client };
  const deps: CustomDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: withComposio(async () => {
      throw new Error("no MCP server in this test");
    }, composio),
    composio,
    composioPollMs: 0,
  };
  const started = await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: DRIVE, returnTo: "/x" });
  if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
  const workspaceCode = fake.state.links.at(-1)?.connectedAccountId ?? "";
  fake.activate(workspaceCode, "", null);
  const { connection } = await completeOAuth(
    deps,
    { id: f.owner.id },
    { state: new URL(started.authorizeUrl).searchParams.get("state") ?? "", code: workspaceCode },
  );
  await syncCustomTools(deps, connection);
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, connection.id);
  const bea = await addMember(f.db, f.org.id, "member", "Bea");

  /** `person` connects their own account, signed in to `email` at Composio, as the callback finishes it. */
  const connectMine = async (person: { id: string }, email: string) => {
    const { authorizeUrl } = await beginPersonalConnect(deps, person.id, f.org.id, connection.id, { returnTo: "/y" });
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    const code = fake.state.links.at(-1)?.connectedAccountId ?? "";
    signedIn.email = email;
    fake.activate(code, "", null);
    const done = await completeOAuth(deps, person, { state, code });
    return { ...done, code };
  };
  const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...deps, artifacts: f.artifactDeps })] });
  return { fake, composio, deps, connection, workspaceCode, bea, connectMine, gateway };
}

/** A run that `author`'s message (or a routine's brief, `meta`) started. */
async function runOf(author: { id: string }, options: { meta?: Record<string, unknown>; agent?: boolean } = {}) {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: options.agent
      ? { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null }
      : { type: "person", userId: author.id },
    body: "procure o contrato",
    meta: options.meta ?? {},
  });
  const background = options.meta?.background === true;
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, msg as never, [f.agent.id], "mention", background ? { background: true } : {}),
  );
  if (!run) throw new Error("no run");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  return ctx;
}

let seq = 0;
const call = (w: Awaited<ReturnType<typeof world>>, ctx: ToolContext, name: string, input: object = {}) =>
  w.gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input: input as Record<string, unknown> });

const resultOf = async (pending: ReturnType<typeof call>) => {
  const out = await pending;
  if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
  return out.output;
};

describe("a per-person connection", () => {
  test("each person's run goes through their own account, never the workspace's", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    const ana = await w.connectMine(f.owner, "ana@acme.com");
    // Bea doesn't manage connectors, and finishes her own sign-in all the same.
    const bea = await w.connectMine(w.bea, "bea@acme.com");
    expect(bea.connection.id).toBe(w.connection.id);

    const before = w.fake.state.executions.length;
    const anaRun = await runOf(f.owner);
    expect((await resultOf(call(w, anaRun, "google_drive_find_file", { q: "contrato" }))).isError).toBe(false);
    expect(w.fake.state.executions.at(-1)?.account.connectedAccountId).toBe(ana.code);

    const beaRun = await runOf(w.bea);
    expect((await resultOf(call(w, beaRun, "google_drive_find_file", { q: "contrato" }))).isError).toBe(false);
    expect(w.fake.state.executions.at(-1)?.account).toEqual({
      connectedAccountId: bea.code,
      // The workspace's Composio user: its calls count against the workspace's cap.
      userId: `org_${f.org.id}`,
      toolkit: "googledrive",
    });
    const ran = w.fake.state.executions.slice(before).map((e) => e.account.connectedAccountId);
    expect(ran).toEqual([ana.code, bea.code]);
  });

  test("with no account of the person's own, the agent is told what's missing and nothing runs or asks", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    const ran = w.fake.state.executions.length;
    const ctx = await runOf(w.bea);
    const read = await resultOf(call(w, ctx, "google_drive_find_file", { q: "contrato" }));
    expect(read).toMatchObject({ isError: true, data: { code: "connector.personal_missing" } });
    expect(read.content).toContain("Bea");
    expect(read.content).toContain("Connect my account");
    // A tool that would ask a person isn't put on a card nobody could make run.
    const share = await resultOf(call(w, ctx, "google_drive_create_permission", { q: "f1", why: WHY }));
    expect(share).toMatchObject({ isError: true, data: { code: "connector.personal_missing" } });
    expect(w.fake.state.executions).toHaveLength(ran);
  });

  test("a routine's run and a run nobody is behind never use anyone's account", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    await w.connectMine(f.owner, "ana@acme.com");
    const ran = w.fake.state.executions.length;
    const brief: RoutineBrief = {
      routineId: crypto.randomUUID(),
      routineRunId: crypto.randomUUID(),
      name: "Contratos",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    };
    const routine = await runOf(f.owner, { meta: { routineBrief: brief, background: true } });
    expect(await resultOf(call(w, routine, "google_drive_find_file", { q: "x" }))).toMatchObject({
      isError: true,
      data: { code: "connector.personal_routine" },
    });
    const nobody = await runOf(f.owner, { agent: true });
    expect(await resultOf(call(w, nobody, "google_drive_find_file", { q: "x" }))).toMatchObject({
      isError: true,
      data: { code: "connector.personal_nobody" },
    });
    expect(w.fake.state.executions).toHaveLength(ran);
  });

  test("someone who left the workspace is nobody here: their account never runs for it", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    await w.connectMine(w.bea, "bea@acme.com");
    const ctx = await runOf(w.bea);
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, w.bea.id));
    const ran = w.fake.state.executions.length;
    expect(await resultOf(call(w, ctx, "google_drive_find_file", { q: "x" }))).toMatchObject({
      isError: true,
      data: { code: "connector.personal_nobody" },
    });
    expect(w.fake.state.executions).toHaveLength(ran);
  });

  test("a person's account that stops working is theirs alone to reconnect", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    await w.connectMine(f.owner, "ana@acme.com");
    await w.connectMine(w.bea, "bea@acme.com");
    w.fake.answer("GOOGLEDRIVE_FIND_FILE", fakeMailAuthError());
    const anaRun = await runOf(f.owner);
    expect(await resultOf(call(w, anaRun, "google_drive_find_file", { q: "x" }))).toMatchObject({
      isError: true,
      data: { code: "connector.personal_needs_reconnect" },
    });
    const [workspace] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, w.connection.id));
    expect(workspace?.status).toBe("active");

    w.fake.answer("GOOGLEDRIVE_FIND_FILE", { files: [] });
    const beaRun = await runOf(w.bea);
    expect((await resultOf(call(w, beaRun, "google_drive_find_file", { q: "x" }))).isError).toBe(false);
    const ran = w.fake.state.executions.length;
    expect(await resultOf(call(w, anaRun, "google_drive_find_file", { q: "x" }))).toMatchObject({
      isError: true,
      data: { code: "connector.personal_needs_reconnect" },
    });
    expect(w.fake.state.executions).toHaveLength(ran);

    // Each person sees their own account only.
    const mine = async (who: { id: string }) =>
      (await listCustomServers(f.db, who.id, f.org.id)).find((s) => s.id === w.connection.id);
    expect(await mine(f.owner)).toMatchObject({
      perPerson: true,
      mine: { accountLabel: "ana@acme.com", status: "needs_reconnect" },
    });
    expect(await mine(w.bea)).toMatchObject({
      perPerson: true,
      mine: { accountLabel: "bea@acme.com", status: "active" },
    });
  });

  test("only who started a sign-in finishes it; connecting again replaces the account; disconnecting drops it", async () => {
    const w = await world();
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    const { authorizeUrl } = await beginPersonalConnect(w.deps, w.bea.id, f.org.id, w.connection.id, {});
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    const code = w.fake.state.links.at(-1)?.connectedAccountId ?? "";
    w.fake.activate(code, "", null);
    await expect(completeOAuth(w.deps, f.owner, { state, code })).rejects.toBeInstanceOf(ForbiddenError);

    const first = await w.connectMine(w.bea, "bea@acme.com");
    const second = await w.connectMine(w.bea, "bea.pessoal@acme.com");
    expect(w.fake.state.deletedAccounts).toContain(first.code);
    expect((await listCustomServers(f.db, w.bea.id, f.org.id)).find((s) => s.id === w.connection.id)?.mine).toEqual({
      accountLabel: "bea.pessoal@acme.com",
      status: "active",
    });
    await disconnectPersonal(w.deps, w.bea.id, f.org.id, w.connection.id);
    expect(w.fake.state.deletedAccounts).toContain(second.code);
    expect((await listCustomServers(f.db, w.bea.id, f.org.id)).find((s) => s.id === w.connection.id)?.mine).toBeNull();
  });

  test("managers of connectors turn it on, for a service through Composio; off or disconnected drops every account", async () => {
    const w = await world();
    await expect(setPerPerson(w.deps, w.bea.id, f.org.id, w.connection.id, true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Nobody connects their own account to a connection that isn't per person.
    await expect(beginPersonalConnect(w.deps, w.bea.id, f.org.id, w.connection.id, {})).rejects.toBeInstanceOf(
      ValidationError,
    );
    const linear = await createApiKeyConnection(w.deps, f.owner.id, f.org.id, {
      connector: "linear",
      apiKey: "lin_api_0123456789",
    });
    await expect(setPerPerson(w.deps, f.owner.id, f.org.id, linear.id, true)).rejects.toMatchObject({
      code: "connector.per_person_unsupported",
    });

    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    const ana = await w.connectMine(f.owner, "ana@acme.com");
    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, false);
    expect(w.fake.state.deletedAccounts).toContain(ana.code);
    // Off again: calls go through the workspace's account, as before.
    const ctx = await runOf(w.bea);
    expect((await resultOf(call(w, ctx, "google_drive_find_file", { q: "x" }))).isError).toBe(false);
    expect(w.fake.state.executions.at(-1)?.account.connectedAccountId).toBe(w.workspaceCode);

    await setPerPerson(w.deps, f.owner.id, f.org.id, w.connection.id, true);
    const bea = await w.connectMine(w.bea, "bea@acme.com");
    await revokeConnection(f.db, f.owner.id, f.org.id, w.connection.id, w.composio);
    expect(w.fake.state.deletedAccounts).toContain(bea.code);
    const live = await f.db.select().from(schema.connectorPersonalAccounts);
    expect(live.every((r) => r.revokedAt !== null)).toBe(true);
  });
});
