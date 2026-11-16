import { accessSync, constants, lstatSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { CLI_NAMES, type CliName } from "@agenteschat/adapters/machine-protocol";
import { trustedRootFile } from "./agent-users";
import type { Binaries } from "./config";

/**
 * Each brain's CLI as the PATH names it. A computer's own binary for a brain (ADR 0187, `binaries` in the runner's
 * `config.json`) is chosen by whoever runs the computer, never by the server or an agent; every lookup of a brain's
 * CLI by name asks `binaryFor` first.
 */
export const CLI_COMMANDS = {
  claude: "claude",
  codex: "codex",
  cursor: "agent",
  opencode: "opencode",
  grok: "grok",
  antigravity: "agy",
  copilot: "copilot",
} as const satisfies Record<CliName, string>;

let current: { binaries: Binaries; system: boolean } = { binaries: {}, system: false };

/**
 * The binaries this process starts from now on. `system`: a system-mode computer's, whose binaries root runs too
 * (`binaryRefusal`). Root takes them from its config; an agent's worker only from `worker.state`.
 */
export function useBinaries(binaries: Binaries, opts: { system?: boolean } = {}) {
  current = { binaries: { ...binaries }, system: opts.system === true };
}

/** The configured binaries, as the last `useBinaries` set them. */
export const configuredBinaries = (): Binaries => current.binaries;

/** The brain a CLI's bare name belongs to. */
const cliOf = (command: string): CliName | undefined => CLI_NAMES.find((name) => CLI_COMMANDS[name] === command);

/**
 * Why `file` can't be a brain's binary; null when it can. It must be a file this process can run. In system mode root
 * runs it too, and each agent as its own user: it and every folder above it must be root's alone and no links (as the
 * network launcher), and others must be able to run it (the file's execute bit, each folder's search bit).
 */
export function binaryRefusal(
  file: string,
  opts: { system?: boolean; stat?: typeof lstatSync; platform?: NodeJS.Platform } = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  if (opts.system && platform !== "win32") {
    const stat = opts.stat ?? lstatSync;
    try {
      trustedRootFile(file, "binary", stat);
      for (let at = path.resolve(file); ; at = path.dirname(at)) {
        if ((stat(at).mode & 0o001) === 0) {
          return "the agents' users can't run it: others must execute it and search each folder above it";
        }
        if (path.dirname(at) === at) return null;
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  // A person's own computer may pin a link: what it points at counts.
  let info: Stats;
  try {
    info = (opts.stat ?? statSync)(file);
  } catch {
    return "it isn't there";
  }
  if (!info.isFile()) return "it isn't a file";
  if (platform === "win32") return null;
  try {
    accessSync(file, constants.X_OK);
    return null;
  } catch {
    return "it isn't executable";
  }
}

/**
 * The binary a CLI's bare name (`claude`, `agent`…) starts: `{ file }` when one is configured and can run,
 * with `refused` saying why when one is configured and can't run (never replaced by the PATH's), undefined when none
 * is (the PATH decides).
 */
export function binaryFor(command: string): { file: string; refused?: string } | undefined {
  const cli = cliOf(command);
  const file = cli ? current.binaries[cli] : undefined;
  if (!file) return undefined;
  const refused = binaryRefusal(file, { system: current.system });
  return refused ? { file, refused } : { file };
}
