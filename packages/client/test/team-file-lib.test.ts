import { describe, expect, test } from "bun:test";
import { parseTeamFile, TEAM_FILE_APP, TeamFileError } from "../src/lib/import/team-file";

/** A team file kept in git (ADR 0055, addendum 2026-11-15). */

const SKILL_MD = "---\nname: research\ndescription: Finds sources.\n---\n# Research\n\nCite every source.";

const TEAM = `version: 1
name: Launch Room
agents:
  - handle: scout
    name: Scout
    role: Researcher
    instructions: { file: agents/scout.md }
    model: claude-sonnet-5-5
    look: { color: sky }
    skills: [research, tone]
  - handle: lead
    name: Room Lead
    instructions: |
      Run the launch.
      Ask Scout for sources.
skills:
  - file: skills/research/SKILL.md
  - key: tone
    markdown: |
      ---
      name: tone
      description: Plain words.
      ---
      Write plainly.
channels:
  - name: launch
    topic: Rehearsal room
    agents: [scout, { handle: lead, autoReply: false }]
routines:
  - name: Morning digest
    agent: scout
    channel: launch
    cron: "0 9 * * 1-5"
    timezone: America/Sao_Paulo
    prompt: Sum up what changed overnight.
  - key: weekly
    name: Weekly note
    agent: lead
    cron: "0 17 * * 5"
    prompt: { file: prompts/weekly.md }
notes:
  - title: Launch date
    content: The launch is on the 3rd.
  - key: tone-rule
    agent: lead
    kind: decision
    content: No jargon in the release notes.
`;

const FILES: Record<string, string> = {
  "agents/scout.md": "Find three sources a day.\n",
  "skills/research/SKILL.md": SKILL_MD,
  "prompts/weekly.md": "Write the weekly note.",
};
const read = (files: Record<string, string>) => (path: string) => files[path] ?? null;

/** Every problem as `line:column message`, for comparing. */
function problemsOf(text: string, files: Record<string, string> = {}): string[] {
  try {
    parseTeamFile(text, { read: read(files) });
  } catch (error) {
    if (error instanceof TeamFileError) return error.problems.map((p) => `${p.line}:${p.column} ${p.message}`);
    throw error;
  }
  throw new Error("the file was read without a problem");
}

describe("reading a team file", () => {
  test("every section becomes the bundle the import plans", () => {
    const bundle = parseTeamFile(TEAM, { name: "team.yaml", read: read(FILES) });
    expect(bundle.source).toEqual({
      app: TEAM_FILE_APP,
      ref: "launch-room",
      name: "Launch Room",
      files: ["team.yaml"],
    });
    expect(bundle.agents).toEqual([
      {
        key: "scout",
        name: "Scout",
        handle: "scout",
        role: "Researcher",
        instructions: "Find three sources a day.\n",
        model: "claude-sonnet-5-5",
        appearance: { color: "sky" },
        skills: ["research", "tone"],
      },
      {
        key: "lead",
        name: "Room Lead",
        handle: "lead",
        role: "",
        instructions: "Run the launch.\nAsk Scout for sources.\n",
        model: null,
        appearance: {},
        skills: [],
      },
    ]);
    expect(bundle.skills).toEqual([
      { key: "research", markdown: SKILL_MD },
      { key: "tone", markdown: "---\nname: tone\ndescription: Plain words.\n---\nWrite plainly.\n" },
    ]);
    expect(bundle.channels).toEqual([
      {
        key: "launch",
        name: "launch",
        topic: "Rehearsal room",
        agents: [
          { key: "scout", autoReply: true },
          { key: "lead", autoReply: false },
        ],
      },
    ]);
    expect(bundle.routines).toEqual([
      {
        key: "Morning digest",
        name: "Morning digest",
        agent: "scout",
        prompt: "Sum up what changed overnight.",
        channel: "launch",
        trigger: { cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
      },
      {
        key: "weekly",
        name: "Weekly note",
        agent: "lead",
        prompt: "Write the weekly note.",
        channel: null,
        trigger: { cron: "0 17 * * 5", timezone: null },
      },
    ]);
    expect(bundle.notes).toEqual([
      { key: "Launch date", agent: null, kind: "note", title: "Launch date", content: "The launch is on the 3rd." },
      { key: "tone-rule", agent: "lead", kind: "decision", content: "No jargon in the release notes." },
    ]);
    expect(bundle.todo).toEqual([]);
    expect(bundle.leftOut).toEqual([]);
  });

  test("an id of its own names the package, so renaming the team keeps what it made", () => {
    const bundle = parseTeamFile(`version: 1\nid: launch\nname: Launch Room v2\nagents: []\n`);
    expect(bundle.source.ref).toBe("launch");
    expect(bundle.source.name).toBe("Launch Room v2");
  });

  test("a Windows checkout reads the same as Linux: BOM dropped, line ends LF, either path separator", () => {
    const unix = parseTeamFile(TEAM, { read: read(FILES) });
    const windowsFiles = Object.fromEntries(
      Object.entries(FILES).map(([path, text]) => [path, `\uFEFF${text.replace(/\n/g, "\r\n")}`]),
    );
    const windows = parseTeamFile(
      `\uFEFF${TEAM.replace("agents/scout.md", "agents\\scout.md").replace(/\n/g, "\r\n")}`,
      {
        read: read(windowsFiles),
      },
    );
    expect(windows).toEqual(unix);
  });
});

describe("refusing a team file, each problem at its line", () => {
  test("YAML that doesn't parse", () => {
    expect(problemsOf("version: 1\nname: [Launch\nagents: []\n")[0]).toMatch(/^\d+:\d+ /);
    const [problem] = problemsOf("version: 1\nname: x\nagents:\n  - handle: a\n   name: b\n");
    expect(problem?.startsWith("5:")).toBe(true);
  });

  test("version, name and the shape of each section", () => {
    expect(problemsOf("name: Launch\n")).toEqual(['1:1 "version" is required (version: 1)']);
    expect(problemsOf("version: 2\nname: Launch\n")).toEqual(['1:10 "version" must be 1']);
    expect(problemsOf("version: 1\nname: Launch\nagents: scout\n")).toEqual(['3:9 "agents" must be a list']);
    expect(problemsOf("- a\n- b\n")).toEqual(["1:1 a team file is a map (version, name, agents, …)"]);
  });

  test("an unknown field, a missing or mistyped one, every problem at once", () => {
    const text = `version: 1
name: Launch
agents:
  - handle: scout
    name: Scout
    rol: Researcher
  - handle: lead
    instructions: 3
  - handle: blank
    name: Blank
    instructions: "  "
routines:
  - name: Ping
    agent: scout
    at: "2030-01-01T09:00:00Z"
    prompt: Ping.
`;
    expect(problemsOf(text)).toEqual([
      // An agent with no instructions would never be updated: the import keeps what an earlier one brought.
      '4:5 agents[0] needs "instructions"',
      '6:5 unknown field "rol" in agents[0] (handle, name, role, instructions, model, look, skills)',
      '7:5 agents[1] needs "name"',
      "8:19 agents[1].instructions must be text or { file: PATH }",
      "11:19 agents[2].instructions is empty",
      '13:5 routines[0] needs "cron"',
      '15:5 unknown field "at" in routines[0] (key, name, agent, channel, cron, timezone, prompt)',
    ]);
  });

  test("a repeated key, a bad handle or channel name, a reference to nothing", () => {
    const text = `version: 1
name: Launch
agents:
  - { handle: scout, name: Scout, skills: [writing], instructions: Find. }
  - { handle: Scout!, name: Other, instructions: Other. }
  - { handle: scout, name: Again, instructions: Again. }
channels:
  - { name: Launch Room, agents: [ghost] }
routines:
  - { name: Ping, agent: scout, channel: nowhere, cron: "* * * * *", prompt: Ping. }
notes:
  - { agent: ghost, content: Hi. }
  - { kind: rumor, title: X, content: Y }
`;
    expect(problemsOf(text)).toEqual([
      '4:44 skill "writing" isn\'t in the file',
      '5:15 "Scout!" isn\'t a handle: 2-32 of a-z, 0-9, - or _, starting with a letter or digit',
      '6:5 agent "scout" appears twice',
      '8:13 "Launch Room" isn\'t a channel name: up to 80 of a-z, 0-9, - or _, starting with a letter or digit',
      '8:35 agent "ghost" isn\'t in the file',
      '10:42 channel "nowhere" isn\'t in the file',
      '12:5 notes[0] needs "key" or "title"',
      '12:14 agent "ghost" isn\'t in the file',
      "13:13 notes[1].kind must be one of fact, preference, decision, note, lesson",
    ]);
  });

  test("a { file } outside the file's folder, absolute, missing, or with no folder to read from", () => {
    const text = `version: 1
name: Launch
agents:
  - { handle: ann, name: A, instructions: { file: ../secrets.md } }
  - { handle: bob, name: B, instructions: { file: /etc/passwd } }
  - { handle: cat, name: C, instructions: { file: "C:\\\\notes.md" } }
  - { handle: dan, name: D, instructions: { file: agents/missing.md } }
`;
    expect(problemsOf(text)).toEqual([
      "4:51 ../secrets.md leaves the team file's folder",
      "5:51 /etc/passwd must be relative to the team file",
      "6:51 C:\\notes.md must be relative to the team file",
      "7:51 agents/missing.md isn't there",
    ]);
    expect(
      problemsOf(
        text
          .split("\n")
          .slice(0, 3)
          .concat(text.split("\n")[6] ?? "")
          .join("\n"),
      ),
    ).toEqual(["4:51 agents/missing.md isn't there"]);
    // Read from standard input there is no folder: a path can't be read.
    expect(() => parseTeamFile(text.split("\n").slice(0, 4).join("\n"))).toThrow(TeamFileError);
  });

  test("a skill file's key is its folder, and needs one", () => {
    const text = "version: 1\nname: Launch\nagents: []\nskills:\n  - file: SKILL.md\n";
    expect(problemsOf(text, { "SKILL.md": SKILL_MD })).toEqual(['5:5 skills[0] needs "key" (its file has no folder)']);
  });
});
