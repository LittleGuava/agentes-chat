import { describe, expect, test } from "bun:test";
import type { AgentSkill } from "../src/api/types";
import { skillMenuLine, slashSkills } from "../src/lib/skills";

const ME = "user-me";

const skill = (name: string, extra: Partial<AgentSkill> = {}): AgentSkill => ({
  id: `id-${name}-${extra.ownerUserId ?? "team"}`,
  name,
  description: `${name} description.`,
  version: 1,
  source: "manual",
  sourceUrl: null,
  defaultForNewAgents: false,
  metadata: {},
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  enabled: true,
  ...extra,
});

describe("the skills '/' offers for an agent (web)", () => {
  test("only those on for it, by name", () => {
    const list = [skill("triage"), skill("deploy"), skill("review", { enabled: false })];
    expect(slashSkills(list, ME).map((s) => s.name)).toEqual(["deploy", "triage"]);
  });

  test("someone else's personal skill is left out even when it's on: a message of mine can't use it", () => {
    const list = [skill("deploy"), skill("notes", { ownerUserId: "user-bia" })];
    expect(slashSkills(list, ME).map((s) => s.name)).toEqual(["deploy"]);
  });

  test("my own personal skill wins over the team's of the same name, as a run of mine picks it", () => {
    const mine = skill("deploy", { ownerUserId: ME, description: "Mine." });
    const list = [skill("deploy", { ownerUserId: null }), mine, skill("review")];
    expect(slashSkills(list, ME)).toEqual([mine, skill("review")]);
  });

  test("a server that leaves the person out lists them all as the team's", () => {
    expect(slashSkills([skill("deploy")], ME).map((s) => s.name)).toEqual(["deploy"]);
  });

  test("none on: nothing", () => {
    expect(slashSkills([skill("deploy", { enabled: false })], ME)).toEqual([]);
    expect(slashSkills([], ME)).toEqual([]);
  });
});

describe("a skill's line in the '/' menu", () => {
  test("its description's first sentence: SKILL.md descriptions say what, then when", () => {
    expect(skillMenuLine("Reviews a pull request. Use when someone asks for a review.")).toBe(
      "Reviews a pull request.",
    );
    expect(skillMenuLine("  Monta o resumo da semana  ")).toBe("Monta o resumo da semana");
    expect(skillMenuLine("First line\nsecond line")).toBe("First line");
    // A dot inside a word or a number isn't the end of a sentence.
    expect(skillMenuLine("Reads v1.2 files from example.com and more")).toBe(
      "Reads v1.2 files from example.com and more",
    );
  });

  test("a long first sentence stays whole: the menu wraps it, never cuts it", () => {
    const long = `${"word ".repeat(60)}end.`;
    expect(skillMenuLine(`${long} Use when asked.`)).toBe(long);
  });

  test("no description: no line", () => {
    expect(skillMenuLine("")).toBe("");
  });
});
