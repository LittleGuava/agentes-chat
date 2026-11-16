import { afterEach, expect, test } from "bun:test";
import { BROWSER_PROFILE_PROTOCOL, type MachineRequest, PERSONAL_BROWSER_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createBrowserHandoffToolSource,
  createBrowserProfile,
  createBrowserToolSource,
  DESKTOP_SCOPE,
  deleteBrowserProfile,
  ForbiddenError,
  grantScopes,
  listBrowserProfiles,
  type MachineCaller,
  missingPermissions,
  NotFoundError,
  openDm,
  personalBrowserProfile,
  renameBrowserProfile,
  requireProfileDriver,
  requireProfileWatcher,
  runPersonalBrowser,
  setAgentBrowserProfile,
  setBrowserProfileAgents,
  type ToolContext,
  transitionRun,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as never;
});

/** A computer at `state.protocol` that answers every browser command with a page, recording each request. */
function fakeHub(state: { machineId: string; orgId: string; protocol: number }) {
  const calls: MachineRequest[] = [];
  const hub: MachineCaller = {
    async status(id) {
      if (id !== state.machineId) return null;
      return {
        id,
        orgId: state.orgId,
        name: "Laptop",
        online: true,
        execAllowed: true,
        os: "linux",
        protocol: state.protocol,
        executors: { browser: { available: true, version: "0.39.1" } },
        paused: null,
        access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
      };
    },
    async call(_id, sent) {
      const request = sent as MachineRequest;
      calls.push(request);
      if (request.op === "browser.batch") {
        return {
          answers: request.commands.map(() => ({ success: true, data: { snapshot: '- button "Send" [ref=e1]' } })),
        } as never;
      }
      if (request.op === "browser.warm") return { started: true } as never;
      return { success: true, data: { snapshot: '- button "Send" [ref=e1]', url: "https://mail.example/" } } as never;
    },
  };
  return { hub, calls };
}

async function personalSetup() {
  const holder: { hub?: MachineCaller } = {};
  const source = createBrowserToolSource({
    machines: {
      hub: {
        status: (id) => (holder.hub as MachineCaller).status(id),
        call: (id, request, options) => (holder.hub as MachineCaller).call(id, request, options),
      },
    },
    pubsub: {
      publish: (topic, event) => f.pubsub.publish(topic, event),
      subscribe: (topic, fn) => f.pubsub.subscribe(topic, fn),
    } as Fixture["pubsub"],
    profileWaitMs: 150,
    profilePollMs: 30,
  });
  f = await setup({ toolSources: [source] });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Laptop" });
  await f.db
    .update(schema.machines)
    .set({ protocol: PERSONAL_BROWSER_PROTOCOL })
    .where(eq(schema.machines.id, paired.machineId));
  const state = { machineId: paired.machineId, orgId: f.org.id, protocol: PERSONAL_BROWSER_PROTOCOL };
  const fake = fakeHub(state);
  holder.hub = fake.hub;
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  const rui = await addMember(f.db, f.org.id, "member", "Rui");
  const tools = f.tools as NonNullable<Fixture["tools"]>;
  const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
    const r = await tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
    if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
    return r.output;
  };
  const ops = () => fake.calls.filter((c) => c.op === "browser.act" || c.op === "browser.batch");
  /** The profile every browser command sent after `from` went to (undefined: the agent's own browser). */
  const sentTo = (from: number) => {
    const sent = ops().slice(from);
    if (sent.length === 0) throw new Error("no browser command reached the computer");
    const ids = new Set(sent.map((c) => c.profile?.id));
    if (ids.size !== 1) throw new Error(`commands went to several browsers: ${[...ids].join(", ")}`);
    return [...ids][0];
  };
  /** Opens a page in a run and says which browser it went to. */
  const openIn = async (ctx: ToolContext) => {
    const n = ops().length;
    const out = await call(ctx, "browser_open", { url: "https://mail.example/" });
    if (out.isError) throw new Error(`browser_open failed: ${out.content}`);
    return sentTo(n);
  };
  return { ...fake, state, machineId: paired.machineId, rui, call, ops, openIn, tools };
}

/** A run of `agentId` started by `userId`'s message in `channelId`, as the executor would make it. */
async function runIn(channelId: string, userId: string, agentId = f.agent.id): Promise<ToolContext> {
  const [msg] = await f.db
    .insert(schema.messages)
    .values({ orgId: f.org.id, channelId, authorType: "person", authorUserId: userId, body: "check my mail" })
    .returning();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: msg?.id ?? "",
      triggerMessageId: msg?.id ?? "",
      trigger: "dm",
      hop: 1,
      status: "running",
    })
    .returning();
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run?.id ?? "",
    channelId,
    threadRootId: msg?.id ?? "",
    triggerMessageId: msg?.id ?? "",
  };
}

const dmOf = async (userId: string) => (await openDm(f.db, userId, f.org.id, { agentId: f.agent.id })).id;

test("each person's DM with a shared agent drives a browser of their own; a channel keeps the agent's", async () => {
  const b = await personalSetup();
  const anas = await b.openIn(await runIn(await dmOf(f.owner.id), f.owner.id));
  const first = await runIn(await dmOf(b.rui.id), b.rui.id);
  const ruis = await b.openIn(first);
  expect(anas).toBeString();
  expect(ruis).toBeString();
  expect(ruis).not.toBe(anas);
  // Made once: Rui's next run there opens the same one, signed in where he left it.
  await transitionRun(f.db, first.runId, "running", "done");
  expect(await b.openIn(await runIn(await dmOf(b.rui.id), b.rui.id))).toBe(ruis);
  // A channel run is the agent's own browser, as before.
  expect(await b.openIn(await runIn(f.general.id, b.rui.id))).toBeUndefined();
  // Never on a desktop: a profile's Chrome is headless.
  expect(b.ops().every((c) => !("desktop" in c && c.desktop))).toBe(true);
}, 30_000);

test("a person's own browser is nobody's workspace profile: not listed, not offered, not granted, not managed", async () => {
  const b = await personalSetup();
  const ruis = await b.openIn(await runIn(await dmOf(b.rui.id), b.rui.id));
  if (!ruis) throw new Error("no profile");
  expect(await listBrowserProfiles(f.db, f.owner.id, f.org.id)).toEqual([]);
  const channelRun = await runIn(f.general.id, f.owner.id);
  expect((await b.tools.list(channelRun)).map((t) => t.name)).not.toContain("browser_profile");
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
  expect((await missingPermissions(channelRun)).some((m) => m.profileId === ruis)).toBe(false);
  // A workspace profile may take the person's name: theirs is not in the way.
  await createBrowserProfile({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, {
    machineId: b.machineId,
    name: "Rui",
    agentIds: [],
  });
  await expect(renameBrowserProfile(f.db, f.owner.id, f.org.id, ruis, "Mine")).rejects.toBeInstanceOf(NotFoundError);
  await expect(setBrowserProfileAgents(f.db, f.owner.id, f.org.id, ruis, [f.agent.id])).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, ruis)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(deleteBrowserProfile({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, ruis)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  // The agent can't switch to it by name from a channel either: the tool offers only the workspace's "Rui".
  const sentToRuis = b.ops().filter((c) => c.profile?.id === ruis).length;
  await setBrowserProfileAgents(
    f.db,
    f.owner.id,
    f.org.id,
    (await listBrowserProfiles(f.db, f.owner.id, f.org.id))[0]?.id ?? "",
    [f.agent.id],
  );
  await b.call(channelRun, "browser_profile", { name: "Rui" });
  expect(await b.openIn(channelRun)).not.toBe(ruis);
  expect(b.ops().filter((c) => c.profile?.id === ruis).length).toBe(sentToRuis);
});

test("only its person watches and drives their own browser, admins included", async () => {
  const b = await personalSetup();
  const ruis = await b.openIn(await runIn(await dmOf(b.rui.id), b.rui.id));
  if (!ruis) throw new Error("no profile");
  expect((await requireProfileWatcher(f.db, b.rui.id, f.org.id, ruis)).id).toBe(ruis);
  expect((await requireProfileDriver(f.db, b.rui.id, f.org.id, ruis)).id).toBe(ruis);
  // The workspace's owner manages every profile and owns the agent, and still sees nothing of Rui's.
  await expect(requireProfileWatcher(f.db, f.owner.id, f.org.id, ruis)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(requireProfileDriver(f.db, f.owner.id, f.org.id, ruis)).rejects.toBeInstanceOf(ForbiddenError);
});

test("the card reads which browser a run is in: the person's own, only for them", async () => {
  const b = await personalSetup();
  const run = await runIn(await dmOf(b.rui.id), b.rui.id);
  expect(await runPersonalBrowser(f.db, b.rui.id, f.org.id, run.runId)).toBeNull();
  const ruis = await b.openIn(run);
  expect(await runPersonalBrowser(f.db, b.rui.id, f.org.id, run.runId)).toMatchObject({
    id: ruis,
    personal: true,
    agentIds: [f.agent.id],
  });
  // Nobody else reads Rui's DM, so nobody else learns of its browser.
  await expect(runPersonalBrowser(f.db, f.owner.id, f.org.id, run.runId)).rejects.toThrow();
  // A channel run is in the agent's own browser.
  const channelRun = await runIn(f.general.id, f.owner.id);
  await b.openIn(channelRun);
  expect(await runPersonalBrowser(f.db, f.owner.id, f.org.id, channelRun.runId)).toBeNull();
});

test("an agent only its owner talks to keeps one browser", async () => {
  const b = await personalSetup();
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
  expect(await b.openIn(await runIn(await dmOf(f.owner.id), f.owner.id))).toBeUndefined();
  expect(await f.db.select().from(schema.browserProfiles)).toEqual([]);
});

test("a workspace profile chosen for the agent still wins in a DM", async () => {
  const b = await personalSetup();
  const shop = await createBrowserProfile({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, {
    machineId: b.machineId,
    name: "Shop chat",
    agentIds: [f.agent.id],
  });
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, shop.id);
  const run = await runIn(await dmOf(b.rui.id), b.rui.id);
  expect(await b.openIn(run)).toBe(shop.id);
  // "own" in the DM is the person's own browser, never the agent's shared one.
  await b.call(run, "browser_profile", { name: "own" });
  const own = await b.openIn(run);
  expect(own).toBeString();
  expect(own).not.toBe(shop.id);
});

test("on a system-mode computer, where profiles don't exist yet, the DM keeps the agent's browser", async () => {
  const b = await personalSetup();
  await f.db
    .update(schema.machines)
    .set({ executors: { mode: "system", browser: { available: true } } })
    .where(eq(schema.machines.id, b.machineId));
  expect(await b.openIn(await runIn(await dmOf(b.rui.id), b.rui.id))).toBeUndefined();
  expect(await f.db.select().from(schema.browserProfiles)).toEqual([]);
});

test("in a person's own browser, files are the agent's own as before; asking for a hand says so plainly", async () => {
  const b = await personalSetup();
  const run = await runIn(await dmOf(b.rui.id), b.rui.id);
  const mine = await b.openIn(run);
  // A screenshot and an upload go to Rui's own browser, saying so, so the computer keeps the files in the agent's
  // folder as its own browser did.
  const n = b.ops().length;
  const shot = await b.call(run, "browser_screenshot", { path: "screenshots/inbox.png" });
  expect(shot.isError).toBeFalsy();
  expect(shot.content).toContain("Saved screenshots/inbox.png in your folder.");
  const sent = await b.call(run, "browser_upload", { target: "e1", path: "reports/q3.pdf" });
  expect(sent.isError).toBeFalsy();
  const files = b.ops().slice(n);
  expect(files.map((c) => (c.op === "browser.act" ? [c.command, c.args] : c.op))).toEqual([
    ["screenshot", ["screenshots/inbox.png"]],
    ["upload", ["@e1", "reports/q3.pdf"]],
  ]);
  for (const c of b.ops()) expect(c.profile).toEqual({ id: mine as string, personal: true });
  // Asking for a hand opens no take over of the agent's shared browser: Rui signs in to his own from the card.
  const source = createBrowserHandoffToolSource({ machines: { hub: b.hub }, pubsub: f.pubsub });
  const ask = (await source.tools(run)).find((t) => t.name === "browser_ask_person");
  if (!ask) throw new Error("browser_ask_person not offered");
  const out = await ask.execute({ instructions: "Sign in to the mail" }, run);
  expect(out.isError).toBe(true);
  expect(out.content).toContain("the person's own browser");
  expect(out.content).toContain("Fazer login");
  expect(await f.db.select().from(schema.browserHandoffs)).toEqual([]);
});

test("where the agent's Chrome shows on its desktop, the DM keeps it there, the agent's own as before", async () => {
  const b = await personalSetup();
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: DESKTOP_SCOPE }]);
  await f.db
    .update(schema.machines)
    .set({
      executors: { browser: { available: true }, desktop: { available: true } },
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true, desktop: true } },
    })
    .where(eq(schema.machines.id, b.machineId));
  const run = await runIn(await dmOf(b.rui.id), b.rui.id);
  expect(await b.openIn(run)).toBeUndefined();
  expect(b.ops().at(-1)).toMatchObject({ desktop: true });
  expect(await f.db.select().from(schema.browserProfiles)).toEqual([]);
  expect(await runPersonalBrowser(f.db, b.rui.id, f.org.id, run.runId)).toBeNull();
});

test("a computer whose runner predates a person's own browser keeps the DM in the agent's", async () => {
  const b = await personalSetup();
  b.state.protocol = BROWSER_PROFILE_PROTOCOL;
  await f.db
    .update(schema.machines)
    .set({ protocol: BROWSER_PROFILE_PROTOCOL })
    .where(eq(schema.machines.id, b.machineId));
  const run = await runIn(await dmOf(b.rui.id), b.rui.id);
  expect(await b.openIn(run)).toBeUndefined();
  expect(await f.db.select().from(schema.browserProfiles)).toEqual([]);
  const shot = await b.call(run, "browser_screenshot", {});
  expect(shot.isError).toBeFalsy();
});

test("each computer keeps the person's own browser there: another one never removes it", async () => {
  const b = await personalSetup();
  const other = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Desk" });
  await f.db
    .update(schema.machines)
    .set({ protocol: PERSONAL_BROWSER_PROTOCOL })
    .where(eq(schema.machines.id, other.machineId));
  const at = { orgId: f.org.id, agentId: f.agent.id, personUserId: b.rui.id };
  const here = await personalBrowserProfile(f.db, b.hub, { ...at, machineId: b.machineId });
  const there = await personalBrowserProfile(f.db, b.hub, { ...at, machineId: other.machineId });
  expect(here?.id).toBeString();
  expect(there?.id).toBeString();
  expect(there?.id).not.toBe(here?.id);
  // Back on the first computer: the same one, signed in where Rui left it.
  expect((await personalBrowserProfile(f.db, b.hub, { ...at, machineId: b.machineId }))?.id).toBe(here?.id);
  const live = await f.db.select().from(schema.browserProfiles);
  expect(live.filter((r) => r.deletedAt === null).length).toBe(2);
  expect(b.calls.some((c) => c.op === "browser.profile.delete")).toBe(false);
});
