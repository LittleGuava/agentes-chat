import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { createFakeImages, type FakeImages } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  createAgent,
  createCredential,
  createOrganization,
  decideApproval,
  IMAGES_PER_RUN_MAX,
  insertMessage,
  type RoutineBrief,
  type RunAuthority,
  type ToolContext,
} from "../src";
import { REFUSALS, toolKind, toolPolicy } from "../src/tools/run-policy";
import { addUser, type Fixture, setup } from "./fixtures";

// `generate_image` (ADR 0213): on the workspace's own key, through the Model Gateway (budget held before the call,
// cost recorded), saved in the Drive with its card on the reply, a few per reply and per day, and a routine asks first.

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** gpt-image-2, square, at `medium` (`IMAGE_MODELS`). */
const SQUARE_NANO_USD = 53_000_000;

async function withImages(
  options: { images?: FakeImages; perDay?: number; budgetNanoUsd?: number | null; platformKey?: boolean } = {},
) {
  const images = options.images ?? createFakeImages("openai");
  f = await setup({
    ...(options.platformKey ? { platform: { resolve: async () => ({ apiKey: "platform-key" }) } } : {}),
    imageTools: true,
    images: { openai: images },
    imagesPerDay: options.perDay,
    budgetNanoUsd: options.budgetNanoUsd,
  });
  return images;
}

/** The workspace's own OpenAI key (an image provider's). */
const addOpenAIKey = () =>
  createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "images",
    apiKey: "sk-openai-images-0001",
  });

/** A run of `agentId` (Dev by default) on a message in #general, and the tool context its calls get. */
async function runOn(meta: Record<string, unknown> = {}, background = false, agentId = f.agent.id) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Make a picture of a rocket over the sea.",
    meta,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      background,
    })
    .returning();
  if (!run) throw new Error("no run");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    ...(background ? { background: true } : {}),
  };
  return ctx;
}

const tools = () => {
  if (!f.tools) throw new Error("no tools");
  return f.tools;
};
const listed = async (ctx: ToolContext) =>
  (await tools().list(ctx)).filter((t) => t.name === "generate_image").map((t) => t.name);
const generate = (ctx: ToolContext, input: Record<string, unknown> = { prompt: "A red rocket over a calm sea" }) =>
  tools().invoke(ctx, { toolUseId: `tu_img_${crypto.randomUUID()}`, name: "generate_image", input });

const imageUsage = () =>
  f.db
    .select()
    .from(schema.usageRecords)
    .where(and(eq(schema.usageRecords.orgId, f.org.id), eq(schema.usageRecords.model, "gpt-image-2")));
const files = () => f.db.select().from(schema.artifacts).where(eq(schema.artifacts.orgId, f.org.id));
const spent = async () => {
  const [row] = await f.db
    .select({ spent: schema.agentBudgetPeriods.spentNanoUsd, reserved: schema.agentBudgetPeriods.reservedNanoUsd })
    .from(schema.agentBudgetPeriods)
    .where(eq(schema.agentBudgetPeriods.agentId, f.agent.id));
  return row ?? { spent: 0, reserved: 0 };
};
const outputOf = (result: Awaited<ReturnType<typeof generate>>) => {
  if (result.type !== "result") throw new Error(`expected a result, got ${result.type}`);
  return result.output;
};

describe("which runs list it", () => {
  test("only with an image provider's key of the workspace's own", async () => {
    const images = await withImages();
    const ctx = await runOn();
    // The workspace has only its Anthropic key: no picture can be made.
    expect(await listed(ctx)).toEqual([]);
    const refused = outputOf(await generate(ctx));
    expect(refused.isError).toBe(true);
    expect(images.calls).toHaveLength(0);
    await addOpenAIKey();
    expect(await listed(ctx)).toEqual(["generate_image"]);
  });

  test("never on the server's own key: a picture is the workspace's spend", async () => {
    const images = await withImages({ platformKey: true });
    const ctx = await runOn();
    expect(await listed(ctx)).toEqual([]);
    expect(outputOf(await generate(ctx)).isError).toBe(true);
    expect(images.calls).toHaveLength(0);
  });
});

describe("a person's run", () => {
  test("makes the picture on the workspace's key, saves it in the Drive and charges the agent's budget", async () => {
    const images = await withImages({ budgetNanoUsd: 1_000_000_000 });
    await addOpenAIKey();
    const ctx = await runOn();
    const output = outputOf(await generate(ctx, { prompt: "A red rocket over a calm sea", title: "Rocket" }));
    expect(output.isError).toBeFalsy();
    expect(images.calls).toHaveLength(1);
    expect(images.calls[0]?.apiKey).toBe("sk-openai-images-0001");
    expect(images.calls[0]?.request).toMatchObject({ model: "gpt-image-2", prompt: "A red rocket over a calm sea" });

    // In the Drive, as a picture people open, and the reply's card.
    const [file] = await files();
    expect(file).toMatchObject({ kind: "file", title: "Rocket", channelId: f.general.id });
    expect(output.data?.artifact).toMatchObject({ id: file?.id, title: "Rocket" });
    const [version] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, file?.id ?? ""));
    expect(version).toMatchObject({ contentType: "image/png", width: 1, height: 1 });

    // Recorded as the agent's call, and on its month.
    const [usage] = await imageUsage();
    expect(usage).toMatchObject({
      kind: "agent",
      agentId: f.agent.id,
      runId: ctx.runId,
      provider: "openai",
      costNanoUsd: SQUARE_NANO_USD,
    });
    expect(await spent()).toEqual({ spent: SQUARE_NANO_USD, reserved: 0 });
  });

  test("a budget that can't pay for the picture asks no provider", async () => {
    const images = await withImages({ budgetNanoUsd: SQUARE_NANO_USD - 1 });
    await addOpenAIKey();
    const output = outputOf(await generate(await runOn()));
    expect(output.isError).toBe(true);
    expect(output.content).toContain("budget");
    expect(images.calls).toHaveLength(0);
    expect(await files()).toEqual([]);
  });

  test("a provider's failure costs nothing and gives the slot back", async () => {
    let fail = true;
    const images = await withImages({
      perDay: 1,
      budgetNanoUsd: 1_000_000_000,
      images: createFakeImages("openai", () =>
        fail ? new ProviderError("openai image generation failed (HTTP 400)", false, 400) : undefined,
      ),
    });
    await addOpenAIKey();
    const ctx = await runOn();
    expect(outputOf(await generate(ctx)).isError).toBe(true);
    expect(await imageUsage()).toEqual([]);
    expect(await spent()).toMatchObject({ spent: 0, reserved: 0 });
    fail = false;
    expect(outputOf(await generate(ctx)).isError).toBeFalsy();
    expect(images.calls).toHaveLength(2);
  });
});

describe("limits", () => {
  test("a few per reply, also when the calls come at once", async () => {
    const images = await withImages();
    await addOpenAIKey();
    const ctx = await runOn();
    const results = await Promise.all(
      Array.from({ length: IMAGES_PER_RUN_MAX + 2 }, () => generate(ctx).then(outputOf)),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(IMAGES_PER_RUN_MAX);
    expect(results.filter((r) => r.isError).every((r) => r.content.includes("this reply"))).toBe(true);
    expect(images.calls).toHaveLength(IMAGES_PER_RUN_MAX);
    // Another reply makes its own.
    expect(outputOf(await generate(await runOn())).isError).toBeFalsy();
  });

  test("a day's pictures are the workspace's, whichever agent makes them; another workspace has its own", async () => {
    const images = await withImages({ perDay: 2 });
    await addOpenAIKey();
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Design", handle: "design", role: "Designer", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: other.id });
    expect(outputOf(await generate(await runOn())).isError).toBeFalsy();
    expect(outputOf(await generate(await runOn({}, false, other.id))).isError).toBeFalsy();
    const third = outputOf(await generate(await runOn()));
    expect(third.isError).toBe(true);
    expect(third.content).toContain("today");
    expect(images.calls).toHaveLength(2);

    // Another workspace on the same server isn't held by this one's pictures.
    const bea = await addUser(f.db, "bea");
    const { organization: org2, general: general2 } = await createOrganization(f.db, bea.id, { name: "Beta" });
    const key2 = await createCredential(f.db, f.keyWrapper, bea.id, org2.id, {
      provider: "openai",
      label: "main",
      apiKey: "sk-openai-beta-0002",
    });
    const agent2 = await createAgent(
      f.db,
      bea.id,
      org2.id,
      { name: "Art", handle: "art", role: "Artist", credentialId: key2.id },
      { model: "gpt-6.1-sol" },
    );
    const trigger = await insertMessage(f.db, {
      orgId: org2.id,
      channelId: general2.id,
      author: { type: "person", userId: bea.id },
      body: "A picture, please.",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: org2.id,
        agentId: agent2.id,
        channelId: general2.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    const ctx2: ToolContext = {
      db: f.db,
      orgId: org2.id,
      agentId: agent2.id,
      runId: run.id,
      channelId: general2.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    };
    expect(outputOf(await generate(ctx2)).isError).toBeFalsy();
    expect(images.calls.at(-1)?.apiKey).toBe("sk-openai-beta-0002");
  });
});

describe("who is behind the run (ADR 0053)", () => {
  const brief = (creatorUserId: string): RoutineBrief => ({
    routineId: "00000000-0000-4000-8000-000000000001",
    routineRunId: "00000000-0000-4000-8000-000000000002",
    name: "Capa da semana",
    creatorUserId,
    deliverTo: { channelId: f.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  });

  test("a routine's run asks a person before any picture is made", async () => {
    const images = await withImages();
    await addOpenAIKey();
    const ctx = await runOn({ routineBrief: brief(f.owner.id) }, true);
    const [tool] = (await tools().list(ctx)).filter((t) => t.name === "generate_image");
    expect(tool?.sensitive).toBe(true);
    const asked = await generate(ctx, {
      prompt: "This week's cover: a rocket over the sea",
      why: "The routine makes this week's cover picture for the newsletter, as its brief asks every Monday.",
    });
    if (asked.type !== "approval") throw new Error(`expected an approval, got ${asked.type}`);
    expect(images.calls).toHaveLength(0);
    expect(await files()).toEqual([]);

    // A person says yes: the picture is made then, once.
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
      decision: "approve",
    });
    const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
    if (!approved) throw new Error("no approval");
    await tools().executeApproved(ctx, approved);
    expect(images.calls).toHaveLength(1);
    expect(await files()).toHaveLength(1);
  });

  test("the table: a person's run and the agent's own work make it, a routine and what it feeds ask, a widget never", () => {
    const tool = { name: "generate_image", scope: "drive:write", connectionId: null };
    expect(toolKind(tool).kind).toBe("paid");
    const person: RunAuthority = { kind: "person", personId: "u1" };
    const unattended: RunAuthority = { kind: "unattended", personId: null, reason: "agent" };
    const fed: RunAuthority = { kind: "unattended", personId: null, reason: "routine_report" };
    const routineBrief: RoutineBrief = {
      routineId: "r1",
      routineRunId: "rr1",
      name: "Capa",
      creatorUserId: "u1",
      deliverTo: { channelId: "c1", threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    };
    const routine: RunAuthority = { kind: "routine", personId: null, brief: routineBrief };
    const widget: RunAuthority = {
      kind: "routine",
      personId: null,
      brief: { ...routineBrief, widget: { widgetId: "w1", dashboardId: "d1" } },
    };
    expect(toolPolicy(person, tool)).toEqual({ action: "allow" });
    expect(toolPolicy(unattended, tool)).toEqual({ action: "allow" });
    expect(toolPolicy(routine, tool)).toEqual({ action: "approve" });
    expect(toolPolicy(fed, tool)).toEqual({ action: "approve" });
    expect(toolPolicy(widget, tool)).toEqual({ action: "refuse", reason: REFUSALS.widgetOnly });
    // An agent that always asks asks for every picture.
    expect(toolPolicy(person, tool, "always")).toEqual({ action: "approve" });
    // A connected app's tool of the same name stays that app's.
    expect(toolKind({ ...tool, scope: "higgsfield:write", connectionId: "conn-1" }).kind).toBe("external");
  });
});
