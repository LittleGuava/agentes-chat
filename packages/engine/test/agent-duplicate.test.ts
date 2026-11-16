import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { and, asc, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createAgentGroup,
  duplicateAgent,
  ForbiddenError,
  grantScopes,
  listAgentGroups,
  NotFoundError,
  setAgentAudience,
  setAgentBrowserDomains,
  setAgentRepositories,
  setReportsTo,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * "Duplicar" on an agent: a new agent with its settings, owned by whoever duplicates it, each part set by the call
 * that sets it on any agent. What the agent lived (memory, routines, conversations, mailboxes) stays with it.
 */
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const MODEL = "claude-sonnet-5-5";
const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const BIAS = "0193dddd-0000-4000-8000-0000000000b1";
const ANAS_ONE = "0193dddd-0000-4000-8000-0000000000a2";

async function world() {
  const fx = await setup();
  f = fx;
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const scopesOf = async (agentId: string) =>
    (
      await fx.db
        .select({ connectionId: schema.agentScopes.connectionId, scope: schema.agentScopes.scope })
        .from(schema.agentScopes)
        .where(eq(schema.agentScopes.agentId, agentId))
    )
      .map((g) => `${g.connectionId ?? "-"}:${g.scope}`)
      .sort();
  return { fx, bia, scopesOf };
}

describe("duplicating an agent", () => {
  test("the copy takes its settings, owned by whoever duplicates it; what it lived stays behind", async () => {
    const { fx, bia, scopesOf } = await world();
    const { db, org, owner } = fx;
    const dev = fx.agent;
    await updateAgent(db, owner.id, org.id, dev.id, {
      role: "Developer",
      instructions: "Write the test first.",
      monthlyBudgetNanoUsd: 50_000_000_000,
      mediaReplies: false,
      approvalsLevel: "always",
      autonomyBrakes: { maxPrsPerHour: 1 },
    });
    await db
      .update(schema.agents)
      .set({
        missionCommandApproval: "never",
        appearance: { color: "teal", eyes: "happy", accessory: "none" },
        contextTokens: 200_000,
        mergeRepos: ["acme/api"],
      })
      .where(eq(schema.agents.id, dev.id));
    await setAgentAudience(db, owner.id, org.id, dev.id, {
      mode: "people",
      userIds: [bia.id],
      roleIds: [],
      consultable: false,
    });
    await grantScopes(db, org.id, dev.id, [{ connectionId: null, scope: "calendar:read" }]);
    // A mailbox Ana gave it (only a mailbox's owner gives it, ADR 0038).
    const [mailbox] = await db
      .insert(schema.mailAccounts)
      .values({ orgId: org.id, provider: "imap", via: "imap", createdByUserId: owner.id })
      .returning();
    await grantScopes(db, org.id, dev.id, [{ connectionId: mailbox?.id ?? "", scope: "mail:read" }]);
    const skill = async (slug: string, values: Partial<typeof schema.skills.$inferInsert> = {}) => {
      const [row] = await db
        .insert(schema.skills)
        .values({ orgId: org.id, slug, name: slug, description: slug, body: slug, source: "manual", ...values })
        .returning();
      await db.insert(schema.agentSkills).values({ orgId: org.id, agentId: dev.id, skillId: row?.id ?? "" });
      return row?.id ?? "";
    };
    const team = await skill("deploy");
    const learned = await skill("how-we-ship", { origin: "agent", ownerAgentId: dev.id });
    const bias = await skill("bia-notes", { ownerUserId: bia.id });
    await setAgentRepositories(db, owner.id, org.id, dev.id, ["acme/api", "acme/web"]);
    await setAgentBrowserDomains(db, undefined, owner.id, org.id, dev.id, ["example.com"]);
    const lead = await createAgent(db, owner.id, org.id, { name: "Lead", handle: "lead" }, { model: MODEL });
    const other = await createAgent(db, owner.id, org.id, { name: "Ops", handle: "ops" }, { model: MODEL });
    await setReportsTo({ db }, owner.id, org.id, [{ agentId: dev.id, reportsToAgentId: lead.id }]);
    await createAgentGroup({ db }, owner.id, org.id, { name: "Product", agentIds: [dev.id, other.id] });
    // What it lived: a note in its memory, a routine, its channel.
    await db.insert(schema.contextItems).values({
      orgId: org.id,
      kind: "note",
      scopeType: "agent",
      scopeId: dev.id,
      agentId: dev.id,
      content: "Ana likes short answers.",
    });
    await db.insert(schema.routines).values({
      orgId: org.id,
      agentId: dev.id,
      name: "Resumo",
      prompt: "Resuma o dia",
      target: { type: "dm" },
      triggerType: "schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: new Date(Date.now() + 3_600_000),
      createdByUserId: owner.id,
    });

    const admin = await addMember(db, org.id, "admin", "caio");
    const { agent: copy, skipped } = await duplicateAgent({ db }, admin.id, org.id, dev.id, { name: "Dev (cópia)" });

    expect(skipped).toEqual([]);
    expect(copy).toMatchObject({
      name: "Dev (cópia)",
      handle: "dev-2",
      ownerUserId: admin.id,
      role: "Developer",
      instructions: "Write the test first.",
      model: dev.model,
      credentialId: fx.credential.id,
      monthlyBudgetNanoUsd: 50_000_000_000,
      mediaReplies: false,
      approvalsLevel: "always",
      autonomyBrakes: { maxPrsPerHour: 1 },
      missionCommandApproval: "never",
      appearance: { color: "teal", eyes: "happy", accessory: "none" },
      contextTokens: 200_000,
      audienceMode: "people",
      audienceUserIds: [bia.id],
      consultable: false,
      browserAllowedDomains: ["example.com"],
      reportsToAgentId: lead.id,
      // Merging without asking is given to an agent on purpose, never by a copy.
      mergeRepos: [],
    });
    expect(copy.id).not.toBe(dev.id);
    // Its access as the original's (without the computer the test fixture took off), the mailbox left behind.
    const original = await scopesOf(dev.id);
    expect(await scopesOf(copy.id)).toEqual(original.filter((g) => !g.endsWith(":mail:read")));
    expect(original.some((g) => g.endsWith(":mail:read"))).toBe(true);
    // The team's skill, never what it learned nor someone else's own.
    const copySkills = await db
      .select({ skillId: schema.agentSkills.skillId, enabled: schema.agentSkills.enabled })
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.agentId, copy.id));
    expect(copySkills).toEqual([{ skillId: team, enabled: true }]);
    expect(copySkills.map((s) => s.skillId)).not.toContain(learned);
    expect(copySkills.map((s) => s.skillId)).not.toContain(bias);
    const repos = await db
      .select({ repo: schema.agentRepositories.repo })
      .from(schema.agentRepositories)
      .where(eq(schema.agentRepositories.agentId, copy.id))
      .orderBy(asc(schema.agentRepositories.position));
    expect(repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
    // Right after the original in its group.
    const groups = await listAgentGroups(db, owner.id, org.id);
    expect(groups[0]?.agentIds).toEqual([dev.id, copy.id, other.id]);
    // Nothing it lived: no memory, no routine, no channel.
    const notes = await db.select().from(schema.contextItems).where(eq(schema.contextItems.agentId, copy.id));
    expect(notes).toEqual([]);
    expect(await db.select().from(schema.routines).where(eq(schema.routines.agentId, copy.id))).toEqual([]);
    const channels = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.agentId, copy.id));
    expect(channels).toEqual([]);
    // The original is as it was.
    const [after] = await db.select().from(schema.agents).where(eq(schema.agents.id, dev.id));
    expect(after).toMatchObject({ ownerUserId: owner.id, handle: "dev", mergeRepos: ["acme/api"] });
    // Audited as a creation, naming what it copies.
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.created"), eq(schema.auditLog.targetId, copy.id)));
    expect(audit).toMatchObject({ actorId: admin.id, details: { handle: "dev-2", duplicateOf: dev.id } });
  });

  test("a member's copy of their own agent takes only what they could give a new agent", async () => {
    const { fx, bia, scopesOf } = await world();
    const { db, org, owner } = fx;
    const mine = await createAgent(db, bia.id, org.id, { name: "Lia", handle: "lia" }, { model: MODEL });
    const defaults = await scopesOf(mine.id);
    // An admin gave it more than a member may: more access, a bigger budget, no asking, a place in the team.
    await updateAgent(db, owner.id, org.id, mine.id, {
      approvalsLevel: "never",
      monthlyBudgetNanoUsd: 900_000_000_000,
      autonomyBrakes: { costly: "go" },
    });
    await grantScopes(db, org.id, mine.id, [{ connectionId: null, scope: "calendar:read" }]);
    await setReportsTo({ db }, owner.id, org.id, [{ agentId: mine.id, reportsToAgentId: fx.agent.id }]);

    const { agent: copy, skipped } = await duplicateAgent({ db }, bia.id, org.id, mine.id);

    expect(copy).toMatchObject({
      name: "Lia (copy)",
      handle: "lia-2",
      ownerUserId: bia.id,
      approvalsLevel: "risky",
      monthlyBudgetNanoUsd: null,
      autonomyBrakes: {},
      reportsToAgentId: null,
    });
    expect(await scopesOf(copy.id)).toEqual(defaults);
    expect(skipped.sort()).toEqual(["access", "approvals", "brakes", "budget", "team"]);
  });

  test("only who may create agents and edit this one duplicates it; never the right hand, an archived or held one", async () => {
    const { fx, bia } = await world();
    const { db, org, owner } = fx;
    const refuse = (actor: string, agentId: string) => duplicateAgent({ db }, actor, org.id, agentId);
    // Someone else's agent.
    await expect(refuse(bia.id, fx.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    const hand = await createAgent(db, owner.id, org.id, { name: "Jev", handle: "jev" }, { model: MODEL });
    await db.update(schema.agents).set({ builtin: "right_hand" }).where(eq(schema.agents.id, hand.id));
    await expect(refuse(owner.id, hand.id)).rejects.toMatchObject({ code: "agent.right_hand_permanent" });
    const old = await createAgent(db, owner.id, org.id, { name: "Old", handle: "old" }, { model: MODEL });
    await db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, old.id));
    await expect(refuse(owner.id, old.id)).rejects.toBeInstanceOf(NotFoundError);
    await db
      .update(schema.agents)
      .set({ operatorHoldAt: new Date(), operatorHoldReason: "abuse" })
      .where(eq(schema.agents.id, fx.agent.id));
    await expect(refuse(owner.id, fx.agent.id)).rejects.toMatchObject({ code: "agent.paused" });
    // Nothing was made by the refusals.
    const handles = await db.select({ handle: schema.agents.handle }).from(schema.agents);
    expect(handles.map((h) => h.handle).sort()).toEqual(["dev", "jev", "old"]);
  });

  test("a plan thinks for the copy only where it may think for its owner (ADR 0059), and is never taken", async () => {
    const { fx, bia } = await world();
    const { db, org, owner } = fx;
    const { machineId: mac } = await pairMachine({ db, pubsub: fx.pubsub }, owner.id, org.id, {
      name: "MacBook",
      protocol: ACCOUNTS_PROTOCOL,
      exec: true,
    });
    await db
      .update(schema.machines)
      .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
      .where(eq(schema.machines.id, mac));
    const [anas, bias] = await db
      .insert(schema.machineAccounts)
      .values([
        // Ana's, for all of her agents there.
        {
          id: ANAS,
          orgId: org.id,
          machineId: mac,
          kind: "claude_code",
          label: "Claude",
          status: "active",
          createdBy: owner.id,
          shared: true,
        },
        {
          id: BIAS,
          orgId: org.id,
          machineId: mac,
          kind: "claude_code",
          label: "GLM",
          provider: "zai",
          status: "active",
          createdBy: bia.id,
        },
      ])
      .returning();
    // A sign-in of Ana's that thinks for one agent at most.
    await db.insert(schema.machineAccounts).values({
      id: ANAS_ONE,
      orgId: org.id,
      machineId: mac,
      kind: "claude_code",
      label: "Claude (one)",
      status: "active",
      createdBy: owner.id,
      shared: false,
    });
    const onPlan = async (name: string, ownerUserId: string, account: string) => {
      const [row] = await db
        .insert(schema.agents)
        .values({
          orgId: org.id,
          name,
          handle: name.toLowerCase(),
          model: MODEL,
          ownerUserId,
          machineId: mac,
          brain: "claude_code",
          brainModel: "opus",
          brainEffort: "high",
          brainAccountId: account,
          audienceMode: "owner",
        })
        .returning();
      return row?.id ?? "";
    };
    const theo = await onPlan("Theo", owner.id, anas?.id ?? "");
    const zoe = await onPlan("Zoe", bia.id, bias?.id ?? "");
    const max = await onPlan("Max", owner.id, ANAS_ONE);

    // Ana's own copy thinks with her plan, as the original does.
    const mine = await duplicateAgent({ db }, owner.id, org.id, theo);
    expect(mine.skipped).toEqual([]);
    expect(mine.agent).toMatchObject({
      machineId: mac,
      brain: "claude_code",
      brainModel: "opus",
      brainEffort: "high",
      brainAccountId: anas?.id,
      audienceMode: "owner",
    });

    // An admin's copy of Bia's agent can't think with Bia's plan: it goes on the API, and Zoe keeps it.
    const theirs = await duplicateAgent({ db }, owner.id, org.id, zoe);
    expect(theirs.skipped).toEqual(["ai"]);
    expect(theirs.agent).toMatchObject({ ownerUserId: owner.id, brain: "model", brainAccountId: null });
    const [zoeNow] = await db.select().from(schema.agents).where(eq(schema.agents.id, zoe));
    expect(zoeNow).toMatchObject({ brain: "claude_code", brainAccountId: bias?.id });

    // A sign-in that thinks for one agent stays with the original: the copy goes on the API.
    const single = await duplicateAgent({ db }, owner.id, org.id, max);
    expect(single.skipped).toEqual(["ai"]);
    expect(single.agent).toMatchObject({ brain: "model", brainAccountId: null });
    const [maxNow] = await db.select().from(schema.agents).where(eq(schema.agents.id, max));
    expect(maxNow).toMatchObject({ brain: "claude_code", brainAccountId: ANAS_ONE });
  });
});
