import { afterEach, expect, test } from "bun:test";
import {
  addChannelMember,
  addContextItemByPerson,
  applyImport,
  createAgent,
  createAgentGroup,
  createChannel,
  createOrganization,
  createRoutine,
  exportBundle,
  ForbiddenError,
  insertContextItem,
  type MigrationBundle,
  NotFoundError,
  parseSkillMarkdown,
  saveSkill,
  setAgentAppearance,
  setAgentSkills,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SKILL_MD = `---
name: relatorio-semanal
description: Escreve o relatório semanal.
metadata:
  openclaw:
    requires:
      bins: [gh]
---
# Relatório

Junte as entregas.`;

/** A bundle by names instead of ids: what must be equal in both workspaces. */
function shape(b: MigrationBundle) {
  const handle = new Map(b.agents.map((a) => [a.key, a.handle]));
  const channel = new Map(b.channels.map((c) => [c.key, c.name]));
  return {
    agents: b.agents.map(({ key: _key, skills, ...a }) => ({ ...a, skills: skills.length })),
    skills: b.skills.map((s) => parseSkillMarkdown(s.markdown)),
    channels: b.channels.map((c) => ({
      name: c.name,
      topic: c.topic,
      agents: c.agents.map((m) => ({ handle: handle.get(m.key), autoReply: m.autoReply })),
    })),
    routines: b.routines.map(({ key: _key, agent, channel: c, ...r }) => ({
      ...r,
      agent: handle.get(agent),
      channel: c && channel.get(c),
    })),
    notes: b.notes.map(({ key: _key, agent, ...n }) => ({ ...n, agent: agent && handle.get(agent) })),
  };
}

test("export: what everyone may see, never keys; imported into another workspace it comes back the same", async () => {
  f = await setup();
  const { db, owner, org, agent, general } = f;
  const deps = { db, pubsub: f.pubsub };
  await setAgentAppearance(db, owner.id, org.id, agent.id, { color: "teal", eyes: "happy", accessory: "cap" });
  const skill = await saveSkill({ db, blobs: f.artifactDeps.blobs }, owner.id, org.id, {
    ...parseSkillMarkdown(SKILL_MD),
    source: "manual",
    files: [{ path: "templates/relatorio.md", data: new TextEncoder().encode("# Modelo") }],
  });
  await setAgentSkills(db, owner.id, org.id, agent.id, [{ skillId: skill.id, enabled: true }]);
  const ops = await createChannel(db, owner.id, org.id, { name: "ops", topic: "Operação" });
  await addChannelMember(db, owner.id, org.id, ops.id, { agentId: agent.id, autoReply: false });
  const board = await createChannel(db, owner.id, org.id, { name: "diretoria", visibility: "private" });
  await addChannelMember(db, owner.id, org.id, board.id, { agentId: agent.id });
  const weekly = { freq: "weekly" as const, byWeekday: ["MO"], times: ["09:00"], timezone: "America/Sao_Paulo" };
  await createRoutine(deps, owner.id, org.id, {
    name: "Bom dia",
    agentId: agent.id,
    prompt: "Diga bom dia ao time.",
    target: { type: "channel", channelId: ops.id },
    trigger: { type: "schedule", rule: weekly },
  });
  await createRoutine(deps, owner.id, org.id, {
    name: "Nova issue",
    agentId: agent.id,
    prompt: "Olhe a issue nova.",
    target: { type: "dm" },
    trigger: { type: "event", event: "issue.created" },
  });
  await createRoutine(deps, owner.id, org.id, {
    name: "Resumo da diretoria",
    agentId: agent.id,
    prompt: "Resuma a semana.",
    target: { type: "channel", channelId: board.id },
    trigger: { type: "schedule", rule: weekly },
  });
  await addContextItemByPerson(db, owner.id, org.id, { kind: "fact", content: "A Acme lança foguetes às sextas." });
  await db.transaction(async (tx) => {
    // Learned in the private channel; and a claim from an untrusted source.
    await insertContextItem(tx, {
      orgId: org.id,
      kind: "note",
      scopeType: "agent",
      agentId: agent.id,
      content: "A diretoria quer cortar custos.",
      channelIds: [board.id],
    });
    await insertContextItem(tx, {
      orgId: org.id,
      kind: "fact",
      scopeType: "org",
      content: "Diz o e-mail.",
      trust: "low",
    });
  });

  const member = await addMember(db, org.id, "member");
  await expect(exportBundle(db, member.id, org.id)).rejects.toThrow(ForbiddenError);

  const bundle = await exportBundle(db, owner.id, org.id);
  expect(bundle.source).toEqual({ app: "agenteschat", ref: org.id, name: "Acme", files: [] });
  expect(bundle.agents).toEqual([
    {
      key: agent.id,
      name: "Dev",
      handle: "dev",
      role: "Developer",
      instructions: "Answer briefly.",
      model: "claude-sonnet-5-5",
      appearance: { color: "teal", eyes: "happy", accessory: "cap" },
      skills: [skill.id],
    },
  ]);
  expect(parseSkillMarkdown(bundle.skills[0]?.markdown ?? "")).toEqual(parseSkillMarkdown(SKILL_MD));
  expect(bundle.channels.map((c) => [c.name, c.agents])).toEqual([
    ["general", [{ key: agent.id, autoReply: true }]],
    ["ops", [{ key: agent.id, autoReply: false }]],
  ]);
  expect(bundle.routines).toHaveLength(1);
  expect(bundle.routines[0]).toMatchObject({ name: "Bom dia", channel: ops.id, trigger: { rule: weekly } });
  expect(bundle.notes.map((n) => n.content)).toEqual(["A Acme lança foguetes às sextas."]);
  expect(bundle.leftOut).toEqual(
    expect.arrayContaining([
      { kind: "routine", label: "Nova issue" },
      { kind: "routine", label: "Resumo da diretoria" },
      { kind: "file", label: "relatorio-semanal/templates/relatorio.md" },
    ]),
  );
  const text = JSON.stringify(bundle);
  for (const secret of ["sk-ant-test-key-1234", f.credential.id, board.id, "cortar custos", "Diz o e-mail"]) {
    expect(text.includes(secret)).toBe(false);
  }

  // Another workspace (self-host → Cloud): everything comes; #general is joined, not made.
  const other = await addUser(db, "bia");
  const { organization: orgB } = await createOrganization(db, other.id, { name: "Acme Cloud" });
  const into = (input: Partial<Parameters<typeof applyImport>[3]> = {}) =>
    applyImport(
      { db, blobs: f.artifactDeps.blobs, pubsub: f.pubsub },
      other.id,
      orgB.id,
      { bundle, dryRun: false, ...input },
      { model: "claude-haiku-5-5" },
    );
  const applied = await into();
  expect(applied.items.filter((i) => i.action !== "create").map((i) => [i.kind, i.label, i.action, i.reason])).toEqual([
    ["channel", "general", "update", "exists"],
  ]);
  const copy = await exportBundle(db, other.id, orgB.id);
  expect(shape(copy)).toEqual(shape(bundle));
  expect(copy.channels[0]?.key).not.toBe(general.id);
  expect((await into()).items.every((i) => i.action === "unchanged")).toBe(true);
});

test("export of a setor or chosen agents: them and what they use, nothing of the rest", async () => {
  f = await setup();
  const { db, owner, org, agent: dev, general } = f;
  const deps = { db, pubsub: f.pubsub };
  const model = { model: "claude-sonnet-5-5" };
  const sales = await createAgent(db, owner.id, org.id, { name: "Vendedora", handle: "vendas" }, model);
  const solo = await createAgent(db, owner.id, org.id, { name: "Avulso", handle: "avulso" }, model);
  await addChannelMember(db, owner.id, org.id, general.id, { agentId: sales.id });
  /** A new setor's id (the call answers with every setor). */
  const setor = async (orgId: string, by: string, name: string, agentIds: string[] = []) =>
    (await createAgentGroup(deps, by, orgId, { name, agentIds })).find((g) => g.name === name)?.id ?? "";
  const eng = await setor(org.id, owner.id, "Engenharia", [dev.id]);
  const comercial = await setor(org.id, owner.id, "Comercial", [sales.id]);
  const empty = await setor(org.id, owner.id, "Vazio");
  const skill = async (name: string, files: { path: string; data: Uint8Array }[] = []) =>
    saveSkill({ db, blobs: f.artifactDeps.blobs }, owner.id, org.id, {
      ...parseSkillMarkdown(`---\nname: ${name}\ndescription: ${name}.\n---\n# ${name}`),
      source: "manual",
      files,
    });
  const review = await skill("revisar-codigo");
  const pitch = await skill("proposta-comercial", [
    { path: "modelo-proposta.md", data: new TextEncoder().encode("# Proposta") },
  ]);
  await skill("ninguem-usa");
  await setAgentSkills(db, owner.id, org.id, dev.id, [{ skillId: review.id, enabled: true }]);
  await setAgentSkills(db, owner.id, org.id, sales.id, [{ skillId: pitch.id, enabled: true }]);
  const deploys = await createChannel(db, owner.id, org.id, { name: "deploys" });
  await addChannelMember(db, owner.id, org.id, deploys.id, { agentId: dev.id });
  const leads = await createChannel(db, owner.id, org.id, { name: "leads" });
  await addChannelMember(db, owner.id, org.id, leads.id, { agentId: sales.id });
  // No chosen agent is in it: it stays.
  await createChannel(db, owner.id, org.id, { name: "cafezinho" });
  const weekly = { freq: "weekly" as const, byWeekday: ["MO"], times: ["09:00"], timezone: "America/Sao_Paulo" };
  const routine = (agentId: string, name: string, channelId: string) =>
    createRoutine(deps, owner.id, org.id, {
      name,
      agentId,
      prompt: `${name}.`,
      target: { type: "channel", channelId },
      trigger: { type: "schedule", rule: weekly },
    });
  await routine(dev.id, "Changelog semanal", deploys.id);
  await routine(sales.id, "Funil da semana", leads.id);
  await createRoutine(deps, owner.id, org.id, {
    name: "Lead novo",
    agentId: sales.id,
    prompt: "Olhe o lead.",
    target: { type: "dm" },
    trigger: { type: "event", event: "issue.created" },
  });
  await addContextItemByPerson(db, owner.id, org.id, { kind: "fact", content: "A Acme fecha o mês no dia 25." });
  await db.transaction(async (tx) => {
    for (const [agentId, content] of [
      [dev.id, "O deploy sai às terças."],
      [sales.id, "O cliente Beta pede desconto."],
    ] as const) {
      await insertContextItem(tx, { orgId: org.id, kind: "note", scopeType: "agent", agentId, content });
    }
  });

  const member = await addMember(db, org.id, "member");
  await expect(exportBundle(db, member.id, org.id, { groupIds: [eng] })).rejects.toThrow(ForbiddenError);

  const summary = (b: MigrationBundle) => ({
    agents: b.agents.map((a) => a.handle),
    skills: b.skills.map((s) => parseSkillMarkdown(s.markdown).name),
    channels: b.channels.map((c) => [c.name, c.agents.map((m) => m.key)]),
    routines: b.routines.map((r) => r.name),
    notes: b.notes.map((n) => n.content),
    leftOut: b.leftOut.map((l) => l.label),
  });

  const engineering = await exportBundle(db, owner.id, org.id, { groupIds: [eng] });
  expect(summary(engineering)).toEqual({
    agents: ["dev"],
    skills: ["revisar-codigo"],
    channels: [
      ["general", [dev.id]],
      ["deploys", [dev.id]],
    ],
    routines: ["Changelog semanal"],
    // The workspace's own memory isn't any agent's: a part carries only its agents' notes.
    notes: ["O deploy sai às terças."],
    leftOut: [],
  });
  const text = JSON.stringify(engineering);
  for (const other of [sales.id, solo.id, "Vendedora", "proposta-comercial", "ninguem-usa", "leads", "cafezinho"]) {
    expect(text.includes(other)).toBe(false);
  }
  for (const other of ["Funil", "Lead novo", "Beta", "fecha o mês", "sk-ant-test-key-1234", f.credential.id]) {
    expect(text.includes(other)).toBe(false);
  }

  expect(summary(await exportBundle(db, owner.id, org.id, { agentIds: [sales.id] }))).toEqual({
    agents: ["vendas"],
    skills: ["proposta-comercial"],
    channels: [
      ["general", [sales.id]],
      ["leads", [sales.id]],
    ],
    routines: ["Funil da semana"],
    notes: ["O cliente Beta pede desconto."],
    leftOut: ["Lead novo", "proposta-comercial/modelo-proposta.md"],
  });

  // Setores and agents add up; an agent named twice comes once.
  const both = await exportBundle(db, owner.id, org.id, { groupIds: [comercial], agentIds: [solo.id, sales.id] });
  expect(both.agents.map((a) => a.handle)).toEqual(["vendas", "avulso"]);

  // A setor with nobody in it brings nothing, never the whole workspace.
  expect(summary(await exportBundle(db, owner.id, org.id, { groupIds: [empty] }))).toEqual({
    agents: [],
    skills: [],
    channels: [],
    routines: [],
    notes: [],
    leftOut: [],
  });

  // Another workspace's agent or setor isn't here.
  const other = await addUser(db, "bia");
  const { organization: orgB } = await createOrganization(db, other.id, { name: "Acme Cloud" });
  const theirs = await setor(orgB.id, other.id, "Deles");
  await expect(exportBundle(db, owner.id, org.id, { groupIds: [theirs] })).rejects.toThrow(NotFoundError);
  await expect(exportBundle(db, owner.id, org.id, { agentIds: [crypto.randomUUID()] })).rejects.toThrow(NotFoundError);

  // The part imports whole into another workspace: nothing points outside it.
  const applied = await applyImport(
    { db, blobs: f.artifactDeps.blobs, pubsub: f.pubsub },
    other.id,
    orgB.id,
    { bundle: engineering, dryRun: false },
    { model: "claude-haiku-5-5" },
  );
  expect(applied.items.filter((i) => i.action !== "create").map((i) => [i.kind, i.label, i.reason])).toEqual([
    ["channel", "general", "exists"],
  ]);
});
