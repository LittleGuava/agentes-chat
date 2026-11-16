/**
 * `main.ts team plan|check|apply FILE --as EMAIL [--org ID] [--prune]` (ADR 0055, addendum 2026-11-15): a team file
 * kept in git, planned, checked for CI or applied, run in the server's own image against its database, like
 * `password-link`. It acts as the member `--as` names, with that person's permissions, and goes through the same
 * plan and apply as the import page.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { formatProblems, parseTeamFile, TeamFileError } from "@agenteschat/client/lib/import/team-file";
import { and, type Database, eq, schema } from "@agenteschat/db";
import {
  applyImport,
  IMPORT_LIMITS,
  type ImportItemResult,
  type ImportPlan,
  type ImportRemoval,
  type MigrationBundle,
  NEW_AGENT_DEFAULTS,
} from "@agenteschat/engine";
import { Bundle } from "./routes/app/agent-imports";

export const TEAM_USAGE =
  "Usage: team plan|check|apply FILE --as EMAIL [--org ID] [--prune]   (FILE - reads standard input)";

/** Exit codes CI can tell apart. */
export const TEAM_EXIT = { ok: 0, failed: 1, invalid: 2, differs: 6 } as const;

export interface TeamCommandDeps {
  db: Database;
  blobs: BlobStoreResolver;
  pubsub: PubSub;
}

export interface TeamCommandIO {
  /** A file's text, or null when it can't be read. */
  readFile(path: string): string | null;
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

type Mode = "plan" | "check" | "apply";
interface Args {
  mode: Mode;
  file: string;
  as: string;
  org?: string;
  prune: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const [mode, ...rest] = argv;
  if (mode !== "plan" && mode !== "check" && mode !== "apply") return TEAM_USAGE;
  let file: string | undefined;
  let as: string | undefined;
  let org: string | undefined;
  let prune = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--prune") prune = true;
    else if (arg === "--as") as = rest[++i];
    else if (arg === "--org") org = rest[++i];
    else if (arg?.startsWith("--")) return `Unknown option ${arg}.\n${TEAM_USAGE}`;
    else if (file === undefined) file = arg;
    else return `One file at a time.\n${TEAM_USAGE}`;
  }
  if (!file || !as) return TEAM_USAGE;
  return { mode, file, as, org, prune };
}

const describe = (i: ImportItemResult) => `${i.kind} ${i.kind === "agent" ? `@${i.key}` : JSON.stringify(i.label)}`;

function itemLine(i: ImportItemResult) {
  const notes = [
    i.renamedTo ? `as @${i.renamedTo}` : "",
    i.reason ?? "",
    i.trimmed?.length ? `cut: ${i.trimmed.join(", ")}` : "",
  ];
  const said = notes.filter(Boolean).join("; ");
  return `${describe(i)}: ${i.action}${said ? ` (${said})` : ""}`;
}

function removalLine(r: ImportRemoval) {
  const what = `${r.kind} ${r.kind === "agent" ? `@${r.key}` : JSON.stringify(r.key)}`;
  const verb = r.kind === "agent" || r.kind === "channel" ? "archive" : "delete";
  if (r.action === "keep") return `${what}: not in the file (kept; --prune would ${verb} it)`;
  if (r.action === "skip") return `${what}: ${verb} failed`;
  return `${what}: ${verb}`;
}

const count = (plan: ImportPlan, action: ImportItemResult["action"]) =>
  plan.items.filter((i) => i.action === action).length;
const removing = (plan: ImportPlan) => (plan.removals ?? []).filter((r) => r.action === "delete").length;

/** The file's answer: every item unchanged, nothing skipped, and (with prune) nothing to remove. */
export const inSync = (plan: ImportPlan) => plan.items.every((i) => i.action === "unchanged") && removing(plan) === 0;

async function personOf(db: Database, email: string, org: string | undefined) {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email.trim().toLowerCase()));
  if (!user) return `No account here uses ${email}.`;
  const memberships = await db
    .select({ orgId: schema.organizationMembers.orgId, name: schema.organizations.name })
    .from(schema.organizationMembers)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMembers.orgId))
    .where(
      and(eq(schema.organizationMembers.userId, user.id), ...(org ? [eq(schema.organizationMembers.orgId, org)] : [])),
    );
  if (org && memberships.length === 0) return `${email} isn't a member of the workspace ${org}.`;
  if (memberships.length !== 1) {
    const list = memberships.map((m) => `  ${m.orgId}  ${m.name}`).join("\n");
    return memberships.length === 0
      ? `${email} isn't in any workspace.`
      : `${email} is in ${memberships.length} workspaces: say which with --org.\n${list}`;
  }
  return { userId: user.id, orgId: (memberships[0] as { orgId: string }).orgId };
}

/** Runs one `agentes team …` command; returns its exit code. */
export async function runTeamCommand(deps: TeamCommandDeps, argv: string[], io: TeamCommandIO): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(args);
    return TEAM_EXIT.invalid;
  }

  const fromStdin = args.file === "-";
  const text = fromStdin ? await io.readStdin() : io.readFile(args.file);
  if (text === null) {
    io.err(`Can't read ${args.file}.`);
    return TEAM_EXIT.failed;
  }
  const shown = fromStdin ? "<stdin>" : args.file;
  let bundle: MigrationBundle;
  try {
    const parsed = parseTeamFile(text, {
      name: fromStdin ? "team.yaml" : args.file.replace(/\\/g, "/").split("/").pop(),
      ...(fromStdin ? {} : { read: (path: string) => io.readFile(join(dirname(args.file), path)) }),
    });
    // The same caps as the import route, which this skips.
    const checked = Bundle.safeParse(parsed);
    if (!checked.success) {
      io.err(checked.error.issues.map((issue) => `${shown}: ${issue.path.join(".")}: ${issue.message}`).join("\n"));
      return TEAM_EXIT.invalid;
    }
    bundle = checked.data;
  } catch (error) {
    if (!(error instanceof TeamFileError)) throw error;
    io.err(formatProblems(shown, error.problems));
    return TEAM_EXIT.invalid;
  }

  const person = await personOf(deps.db, args.as, args.org);
  if (typeof person === "string") {
    io.err(person);
    return TEAM_EXIT.failed;
  }
  const { userId, orgId } = person;
  const run = (input: { dryRun: boolean; pick?: string[] }) =>
    applyImport(deps, userId, orgId, { bundle, prune: args.prune, ...input }, NEW_AGENT_DEFAULTS);

  try {
    const plan = await run({ dryRun: true });
    for (const item of plan.items) if (item.action !== "unchanged") io.out(itemLine(item));
    for (const removal of plan.removals ?? []) io.out(removalLine(removal));
    const summary = `${count(plan, "create")} to create, ${count(plan, "update")} to change, ${count(plan, "unchanged")} unchanged, ${count(plan, "skip")} skipped, ${removing(plan)} to remove.`;
    if (args.mode === "plan") {
      io.out(`Plan: ${summary}`);
      return TEAM_EXIT.ok;
    }
    if (args.mode === "check") {
      if (inSync(plan)) {
        io.out("In sync.");
        return TEAM_EXIT.ok;
      }
      io.out(`Out of sync: ${summary}`);
      return TEAM_EXIT.differs;
    }
    if (inSync(plan)) {
      io.out("No changes.");
      return TEAM_EXIT.ok;
    }
    io.out(`Plan: ${summary}`);

    // At most `perApply` writes a call, in the plan's order: what an earlier chunk made counts as there.
    const writes = [
      ...plan.items.filter((i) => i.action === "create" || i.action === "update"),
      ...(plan.removals ?? []).filter((r) => r.action === "delete"),
    ].map((i) => `${i.kind}:${i.key}`);
    const done: ImportPlan = { items: [], removals: [] };
    for (let i = 0; i < writes.length; i += IMPORT_LIMITS.perApply) {
      const applied = await run({ dryRun: false, pick: writes.slice(i, i + IMPORT_LIMITS.perApply) });
      done.items.push(...applied.items);
      done.removals?.push(...(applied.removals ?? []));
    }
    const failed = [
      ...done.items.filter((i) => i.action === "skip").map(itemLine),
      ...(done.removals ?? []).filter((r) => r.action === "skip").map(removalLine),
    ];
    for (const line of failed) io.err(line);
    const skipped = count(plan, "skip") + failed.length;
    io.out(
      `Applied: ${count(done, "create")} created, ${count(done, "update")} changed, ${removing(done)} removed, ${skipped} skipped.`,
    );
    return skipped > 0 ? TEAM_EXIT.failed : TEAM_EXIT.ok;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return TEAM_EXIT.failed;
  }
}

/** The command's files and streams on this machine. */
export const processIO: TeamCommandIO = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  readStdin: () => Bun.stdin.text(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};
