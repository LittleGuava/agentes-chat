import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  applyImport,
  createAgent,
  createChannel,
  type ImportInput,
  type ImportPlan,
  type MigrationBundle,
  unarchiveAgent,
  unarchiveChannel,
} from "../src";
import { addMember as addPerson, type Fixture, setup } from "./fixtures";

/** A team file kept in git, applied again without some of its items (ADR 0055, addendum 2026-11-15). */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SKILL_MD = "---\nname: research\ndescription: Finds sources.\n---\nCite every source.";

function team(over: Partial<MigrationBundle> = {}): MigrationBundle {
  return {
    format: "agenteschat.bundle",
    version: 1,
    source: { app: "team-file", ref: "launch-room", name: "Launch Room", files: ["team.yaml"] },
    agents: [
      {
        key: "scout",
        name: "Scout",
        handle: "scout",
        role: "Researcher",
        instructions: "Find sources.",
        model: null,
        appearance: {},
        skills: ["research"],
      },
      {
        key: "lead",
        name: "Lead",
        handle: "lead",
        role: "Lead",
        instructions: "Run the launch.",
        model: null,
        appearance: {},
        skills: [],
      },
    ],
    skills: [{ key: "research", markdown: SKILL_MD }],
    channels: [
      {
        key: "launch",
        name: "launch",
        topic: "",
        agents: [
          { key: "scout", autoReply: true },
          { key: "lead", autoReply: true },
        ],
      },
    ],
    routines: [
      {
        key: "digest",
        name: "Digest",
        agent: "lead",
        prompt: "Sum up the day.",
        channel: "launch",
        trigger: { cron: "0 9 * * 1-5", timezone: "UTC" },
      },
    ],
    notes: [{ key: "date", agent: "lead", kind: "fact", title: "Date", content: "The launch is on the 3rd." }],
    todo: [],
    leftOut: [],
    ...over,
  };
}
/** The team file with only Scout: the lead, its routine, its note, the channel and the skill are gone from it. */
const scoutOnly = () =>
  team({
    agents: [{ ...(team().agents[0] as MigrationBundle["agents"][number]), skills: [] }],
    skills: [],
    channels: [],
    routines: [],
    notes: [],
  });

const deps = () => ({ db: f.db, blobs: f.artifactDeps.blobs, pubsub: f.pubsub });
const run = (input: Partial<ImportInput> & { bundle: MigrationBundle }, actor = f.owner.id) =>
  applyImport(deps(), actor, f.org.id, { dryRun: false, ...input }, { model: "claude-sonnet-5-5" });
const removals = (plan: ImportPlan) => (plan.removals ?? []).map((r) => `${r.kind}:${r.key}:${r.action}`);
const idOf = (plan: ImportPlan, id: string) => plan.items.find((i) => `${i.kind}:${i.key}` === id)?.targetId ?? "";

describe("pruning what a team file no longer has", () => {
  test("left out, removals aren't looked at; false: listed and kept; true: planned, then made through the app", async () => {
    f = await setup();
    const first = await run({ bundle: team() });
    expect(first.removals).toBeUndefined();

    // The same file again: nothing to change, nothing to remove.
    const same = await run({ bundle: team(), dryRun: true, prune: true });
    expect(same.items.every((i) => i.action === "unchanged")).toBe(true);
    expect(same.removals).toEqual([]);

    const kept = await run({ bundle: scoutOnly(), dryRun: true, prune: false });
    expect(removals(kept)).toEqual([
      "note:date:keep",
      "routine:digest:keep",
      "channel:launch:keep",
      "agent:lead:keep",
      "skill:research:keep",
    ]);
    const planned = await run({ bundle: scoutOnly(), dryRun: true, prune: true });
    expect(removals(planned)).toEqual([
      "note:date:delete",
      "routine:digest:delete",
      "channel:launch:delete",
      "agent:lead:delete",
      "skill:research:delete",
    ]);
    // A dry run writes nothing.
    const [lead] = await f.db.select().from(schema.agents).where(eq(schema.agents.handle, "lead"));
    expect(lead?.archivedAt).toBeNull();

    const pruned = await run({ bundle: scoutOnly(), prune: true });
    expect(removals(pruned)).toEqual(removals(planned));
    const [agent] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, idOf(first, "agent:lead")));
    expect(agent?.archivedAt).toBeInstanceOf(Date);
    const [scout] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, idOf(first, "agent:scout")));
    expect(scout?.archivedAt).toBeNull();
    const [channel] = await f.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, idOf(first, "channel:launch")));
    expect(channel?.archivedAt).toBeInstanceOf(Date);
    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, idOf(first, "routine:digest")));
    expect(routine?.deletedAt).toBeInstanceOf(Date);
    const [skill] = await f.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, idOf(first, "skill:research")));
    expect(skill?.deletedAt).toBeInstanceOf(Date);
    const notes = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.id, idOf(first, "note:date")));
    expect(notes).toEqual([]);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "import.applied"));
    expect(audit.at(-1)?.details).toMatchObject({ removed: 5 });

    // In sync with the smaller file now.
    const after = await run({ bundle: scoutOnly(), dryRun: true, prune: true });
    expect(after.items.map((i) => i.action)).toEqual(["unchanged"]);
    expect(after.removals).toEqual([]);
  });

  test("never another person's file, another file, something made by hand, a joined channel, or an item the file keeps but skips", async () => {
    f = await setup();
    // A public channel that was here already: the import only joins its agents to it.
    await createChannel(f.db, f.owner.id, f.org.id, { name: "launch", topic: "" }, { pubsub: f.pubsub });
    await run({ bundle: team() });
    const admin = await addPerson(f.db, f.org.id, "admin");
    const theirs = await run({ bundle: team() }, admin.id);
    const otherFile = await run({ bundle: team({ source: { ...team().source, ref: "support" } }) });
    const byHand = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Lead by hand", handle: "lead-hand", role: "", instructions: "" },
      { model: "claude-sonnet-5-5" },
      { pubsub: f.pubsub },
    );

    // The file keeps its note, but its text now holds a key: skipped, never removed.
    const leaky = scoutOnly();
    leaky.notes = [{ key: "date", agent: null, kind: "fact", content: "senha: hunter2hunter2" }];
    const plan = await run({ bundle: leaky, prune: true });
    expect(plan.items.find((i) => i.kind === "note")).toMatchObject({ action: "skip", reason: "secret_like" });
    expect(removals(plan)).toEqual(["routine:digest:delete", "agent:lead:delete", "skill:research:delete"]);

    const live = async (id: string) =>
      (await f.db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]?.archivedAt === null;
    expect(await live(idOf(theirs, "agent:lead"))).toBe(true);
    expect(await live(idOf(otherFile, "agent:lead"))).toBe(true);
    expect(await live(byHand.id)).toBe(true);
    const [joined] = await f.db.select().from(schema.channels).where(eq(schema.channels.name, "launch"));
    expect(joined?.archivedAt).toBeNull();
  });

  test("a pick narrows the removals one call applies", async () => {
    f = await setup();
    await run({ bundle: team() });
    const plan = await run({ bundle: scoutOnly(), prune: true, pick: ["agent:scout", "note:date"] });
    expect(removals(plan)).toEqual(["note:date:delete"]);
    const rest = await run({ bundle: scoutOnly(), dryRun: true, prune: true });
    expect(removals(rest)).toEqual([
      "routine:digest:delete",
      "channel:launch:delete",
      "agent:lead:delete",
      "skill:research:delete",
    ]);
  });

  test("put back in the file, a removed skill comes back as it was; an agent and a channel unarchived in the app are matched again", async () => {
    f = await setup();
    const first = await run({ bundle: team() });
    await run({ bundle: scoutOnly(), prune: true });
    await unarchiveAgent(f.db, f.owner.id, f.org.id, idOf(first, "agent:lead"), { pubsub: f.pubsub });
    await unarchiveChannel(f.db, f.owner.id, f.org.id, idOf(first, "channel:launch"), { pubsub: f.pubsub });

    const back = await run({ bundle: team() });
    const actions = new Map(back.items.map((i) => [`${i.kind}:${i.key}`, i]));
    expect(actions.get("skill:research")).toMatchObject({ action: "create", targetId: idOf(first, "skill:research") });
    expect(actions.get("agent:lead")).toMatchObject({ action: "unchanged", targetId: idOf(first, "agent:lead") });
    expect(actions.get("channel:launch")).toMatchObject({ targetId: idOf(first, "channel:launch") });
    expect(actions.get("routine:digest")?.action).toBe("create");
    expect(actions.get("note:date")?.action).toBe("create");
    const again = await run({ bundle: team(), dryRun: true, prune: true });
    expect(again.items.every((i) => i.action === "unchanged")).toBe(true);
    expect(again.removals).toEqual([]);
  });

  test("put back without unarchiving: a new agent with the next handle, and the archived channel keeps its name", async () => {
    f = await setup();
    await run({ bundle: team() });
    await run({ bundle: scoutOnly(), prune: true });
    const back = await run({ bundle: team() });
    const actions = new Map(back.items.map((i) => [`${i.kind}:${i.key}`, i]));
    expect(actions.get("agent:lead")).toMatchObject({ action: "create", renamedTo: "lead-2" });
    expect(actions.get("channel:launch")).toMatchObject({ action: "skip", reason: "exists" });
    expect(actions.get("skill:research")?.action).toBe("create");
  });
});
