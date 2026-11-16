import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { runTeamCommand, TEAM_EXIT, type TeamCommandIO } from "../src/team-file";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** `agentes team plan|check|apply` (ADR 0055, addendum 2026-11-15): a team file kept in git, against the database. */

let t: TestServer;
let orgId: string;
beforeEach(async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  orgId = (await seedOrg(owner)).orgId;
});
afterEach(async () => {
  await t.close();
});

const TEAM = `version: 1
name: Launch Room
agents:
  - handle: scout
    name: Scout
    instructions: { file: agents/scout.md }
  - handle: lead
    name: Lead
    instructions: Run the launch.
channels:
  - name: launch
    agents: [scout]
routines:
  - name: Digest
    agent: lead
    channel: launch
    cron: "0 9 * * 1-5"
    prompt: Sum up the day.
`;

/** A checkout on disk: the team file and what it points at, by path. */
function command(files: Record<string, string>, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: TeamCommandIO = {
    readFile: (path) => files[path.replace(/\\/g, "/")] ?? null,
    readStdin: async () => stdin,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const deps = { db: t.db, blobs: t.engine.artifacts.blobs, pubsub: t.adapters.pubsub };
  return {
    out,
    err,
    run: async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      return runTeamCommand(deps, argv, io);
    },
  };
}
const checkout = (team: string) => ({ "repo/team.yaml": team, "repo/agents/scout.md": "Find sources.\r\n" });
const agentNamed = async (handle: string) =>
  (await t.db.select().from(schema.agents).where(eq(schema.agents.handle, handle)))[0];

test("plan writes nothing, apply makes the team, check says it is in sync, and a change in the file is out of sync", async () => {
  const cli = command(checkout(TEAM));
  expect(await cli.run("plan", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(cli.out).toContain("agent @scout: create");
  expect(cli.out.at(-1)).toBe("Plan: 4 to create, 0 to change, 0 unchanged, 0 skipped, 0 to remove.");
  expect(await agentNamed("scout")).toBeUndefined();

  expect(await cli.run("check", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.differs);
  expect(await cli.run("apply", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(cli.out.at(-1)).toBe("Applied: 4 created, 0 changed, 0 removed, 0 skipped.");
  const scout = await agentNamed("scout");
  expect(scout).toMatchObject({ orgId, instructions: "Find sources." });

  expect(await cli.run("check", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(cli.out).toEqual(["In sync."]);
  expect(await cli.run("apply", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(cli.out).toEqual(["No changes."]);

  const edited = command(checkout(TEAM.replace("Run the launch.", "Run the launch, calmly.")));
  expect(await edited.run("check", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.differs);
  expect(edited.out).toEqual([
    "agent @lead: update",
    "Out of sync: 0 to create, 1 to change, 3 unchanged, 0 skipped, 0 to remove.",
  ]);
});

test("what the file no longer has is kept and listed, unless --prune, which archives it through the app", async () => {
  await command(checkout(TEAM)).run("apply", "repo/team.yaml", "--as", "ana@example.com");
  const smaller = command(
    checkout(`${TEAM.split("  - handle: lead")[0]}channels:\n  - name: launch\n    agents: [scout]\n`),
  );

  // Kept, so still in sync: listed for whoever reads the log.
  expect(await smaller.run("check", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(smaller.out.at(-1)).toBe("In sync.");
  expect(await smaller.run("plan", "repo/team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);
  expect(smaller.out).toContain('routine "Digest": not in the file (kept; --prune would delete it)');
  expect(smaller.out).toContain("agent @lead: not in the file (kept; --prune would archive it)");

  expect(await smaller.run("check", "repo/team.yaml", "--as", "ana@example.com", "--prune")).toBe(TEAM_EXIT.differs);
  expect(await smaller.run("apply", "repo/team.yaml", "--as", "ana@example.com", "--prune")).toBe(TEAM_EXIT.ok);
  expect(smaller.out.at(-1)).toBe("Applied: 0 created, 0 changed, 2 removed, 0 skipped.");
  expect((await agentNamed("lead"))?.archivedAt).toBeInstanceOf(Date);
  expect((await agentNamed("scout"))?.archivedAt).toBeNull();
  expect(await smaller.run("check", "repo/team.yaml", "--as", "ana@example.com", "--prune")).toBe(TEAM_EXIT.ok);
});

test("an invalid file says where, standard input has no folder, and the person must be a member", async () => {
  const typo = command({
    "team.yaml": TEAM.replace("    name: Lead", "    nmae: Lead"),
    "agents/scout.md": "Find sources.",
  });
  expect(await typo.run("check", "team.yaml", "--as", "ana@example.com")).toBe(TEAM_EXIT.invalid);
  expect(typo.err).toEqual([
    'team.yaml:7:5: agents[1] needs "name"\nteam.yaml:8:5: unknown field "nmae" in agents[1] (handle, name, role, instructions, model, look, skills)',
  ]);

  const piped = command({}, TEAM);
  expect(await piped.run("check", "-", "--as", "ana@example.com")).toBe(TEAM_EXIT.invalid);
  expect(piped.err.join("\n")).toContain("<stdin>:6:27: agents/scout.md can't be read");
  const inline = command({}, TEAM.replace("{ file: agents/scout.md }", "Find sources."));
  expect(await inline.run("apply", "-", "--as", "ana@example.com")).toBe(TEAM_EXIT.ok);

  expect(await inline.run("check", "-", "--as", "bruno@example.com")).toBe(TEAM_EXIT.failed);
  expect(inline.err).toEqual(["No account here uses bruno@example.com."]);
  expect(await inline.run("check", "-", "--as", "ana@example.com", "--org", crypto.randomUUID())).toBe(
    TEAM_EXIT.failed,
  );
  expect(await inline.run("check", "-")).toBe(TEAM_EXIT.invalid);
});
