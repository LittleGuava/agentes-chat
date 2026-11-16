import { CliError, EXIT } from "./exit";

/** Options that take a value (`--out FILE` or `--out=FILE`). */
const VALUED = new Set([
  "url",
  "token-file",
  "message-file",
  "channel",
  "thread",
  "task",
  "key",
  "timeout",
  "out",
  "format",
  "limit",
  "interval",
]);
/** Options that are on when given. */
const SWITCHES = new Set(["json", "quiet", "force", "until-done", "help"]);

/** Every command takes these. */
export const COMMON = ["url", "token-file", "json", "quiet", "help"] as const;

export interface Args {
  command: string | null;
  positionals: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

const usage = (message: string) => new CliError(message, EXIT.usage);

/** The command line, split: the first word is the command, `-` is a positional (standard input), `--` ends options. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, positionals: [], values: new Map(), switches: new Set() };
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = word.slice(2, eq === -1 ? undefined : eq);
      if (SWITCHES.has(name)) {
        if (eq !== -1) throw usage(`--${name} takes no value.`);
        args.switches.add(name);
        continue;
      }
      if (!VALUED.has(name)) throw usage(`Unknown option --${name}.`);
      const value = eq === -1 ? argv[++i] : word.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith("--"))) throw usage(`--${name} needs a value.`);
      if (args.values.has(name)) throw usage(`--${name} is given twice.`);
      args.values.set(name, value);
      continue;
    }
    if (options && word === "-h") {
      args.switches.add("help");
      continue;
    }
    if (args.command === null) args.command = word;
    else args.positionals.push(word);
  }
  return args;
}

/** Refuses an option the command doesn't take, so a typo never goes unnoticed. */
export function allowOnly(args: Args, command: string, allowed: readonly string[]) {
  const ok = new Set<string>([...COMMON, ...allowed]);
  for (const name of [...args.values.keys(), ...args.switches])
    if (!ok.has(name)) throw usage(`${command} doesn't take --${name}.`);
}

/** `90` and `90s` are seconds, `5m` minutes, `2h` hours. */
export function parseDuration(text: string, option: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(text.trim());
  if (!match) throw usage(`--${option} is a duration such as 90, 90s, 5m or 2h, not "${text}".`);
  const n = Number(match[1]);
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000;
  return n * unit;
}

/** A whole number within bounds. */
export function parseCount(text: string, option: string, min: number, max: number): number {
  const n = /^\d+$/.test(text.trim()) ? Number(text) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw usage(`--${option} is a number from ${min} to ${max}.`);
  return n;
}
