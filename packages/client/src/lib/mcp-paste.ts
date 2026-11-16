/**
 * What a person pastes to connect an MCP server, read without running anything (ADR 0016, addendum 2026-11-15): a
 * `claude mcp add …` or `claude mcp add-json …` line, an `mcpServers` block (Claude, Cursor; VS Code's `servers` and
 * a single entry too), an `npx`/`uvx`/`docker run` line, or the address alone. A server run as a command (stdio) is
 * recognized so the form can say the server can't run it. Pure: never throws, never reaches the network.
 */

/** A header the paste sends. `missing`: terminal variables or placeholders in its value, which can't go as written. */
export interface PastedHeader {
  name: string;
  value: string;
  missing: string[];
}

export type McpPaste =
  | { kind: "url"; name: string | null; url: string; headers: PastedHeader[]; missing: string[] }
  | { kind: "command"; name: string | null; command: string }
  | { kind: "none" };

const NONE: McpPaste = { kind: "none" };
const COMMANDS = /^(npx|bunx|pnpm|yarn|uvx|uv|pipx|python3?|node|deno|bun|docker|podman)$/;
const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseMcpPaste(text: string): McpPaste {
  const trimmed = text.trim();
  if (!trimmed) return NONE;
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) return fromJsonText(trimmed);
  const words = shellWords(trimmed);
  if (!words || words.length === 0) return NONE;
  if (words[0] === "claude" && words[1] === "mcp" && words[2] === "add") return fromClaudeAdd(words.slice(3));
  if (words[0] === "claude" && words[1] === "mcp" && words[2] === "add-json") return fromClaudeAddJson(words.slice(3));
  if (words.length === 1 && isUrl(words[0] ?? "")) return byAddress(null, words[0] ?? "", [], {});
  if (COMMANDS.test(words[0] ?? "")) return { kind: "command", name: null, command: words.join(" ") };
  return NONE;
}

/** The terminal variables and placeholders in a value: `$X`, `${X}`, `${env:X}`, `<your key>`, `YOUR_API_KEY`. */
function missingIn(value: string): string[] {
  const found = [
    ...[...value.matchAll(/\$\{(?:env:|input:)?([^}\s]+)\}/g)].map((m) => m[1] ?? ""),
    ...[...value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ""),
    ...[...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1] ?? ""),
    ...[...value.matchAll(/\b(YOUR[_-][A-Z0-9_-]+)\b/gi)].map((m) => m[1] ?? ""),
  ];
  return [...new Set(found.filter(Boolean))];
}

/** `${X}`, `${env:X}` and `$X` replaced by the value the paste itself gives X (an `env` block, `-e X=…`). */
function fill(value: string, env: Record<string, string>): string {
  // Own keys only: `${constructor}` is a placeholder, not a property of every object.
  const given = (all: string, name: string) => (Object.hasOwn(env, name) ? (env[name] ?? all) : all);
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, given).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, given);
}

function byAddress(
  name: string | null,
  url: string,
  headers: [string, string][],
  env: Record<string, string>,
): McpPaste {
  const filledUrl = fill(url.trim(), env);
  return {
    kind: "url",
    name,
    url: filledUrl,
    headers: headers.map(([n, v]) => {
      const value = fill(v.trim(), env);
      return { name: n.trim(), value, missing: missingIn(value) };
    }),
    missing: missingIn(filledUrl),
  };
}

/** `Name: value` (the first colon splits). */
function headerOf(line: string): [string, string] | null {
  const at = line.indexOf(":");
  if (at <= 0) return null;
  const name = line.slice(0, at).trim();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ? [name, line.slice(at + 1).trim()] : null;
}

function envOf(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** One server's entry, as Claude, Cursor, VS Code, Windsurf or Gemini write it. */
function fromEntry(name: string | null, entry: Record<string, unknown>): McpPaste {
  const env = envOf(entry.env);
  const url = [entry.url, entry.serverUrl, entry.httpUrl].find((u): u is string => typeof u === "string");
  if (url) {
    const headers = isRecord(entry.headers)
      ? Object.entries(entry.headers).filter((e): e is [string, string] => typeof e[1] === "string")
      : [];
    return byAddress(name, url, headers, env);
  }
  if (typeof entry.command !== "string") return NONE;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  // mcp-remote only bridges a server by address to a client that runs commands: the address is what it reaches.
  if (args.some((a) => /(^|\/)mcp-remote(@[^/\s]*)?$/.test(a))) {
    const target = args.find(isUrl);
    if (target) {
      const headers = args
        .map((a, i) => (args[i - 1] === "--header" ? headerOf(a) : null))
        .filter((h): h is [string, string] => h !== null);
      return byAddress(name, target, headers, env);
    }
  }
  return { kind: "command", name, command: [entry.command, ...args].join(" ") };
}

/** The servers a JSON block names, in order: `mcpServers`, `servers`, `mcp.servers`, a name → entry map or one entry. */
function entriesOf(json: unknown): [string | null, Record<string, unknown>][] {
  if (!isRecord(json)) return [];
  const isEntry = (v: unknown) =>
    isRecord(v) && ["url", "serverUrl", "httpUrl", "command"].some((k) => typeof v[k] === "string");
  if (isEntry(json)) return [[null, json]];
  const map = [json.mcpServers, json.servers, isRecord(json.mcp) ? json.mcp.servers : undefined].find(isRecord) ?? json;
  return Object.entries(map).filter((e): e is [string, Record<string, unknown>] => isEntry(e[1]));
}

function fromJson(json: unknown, name: string | null = null): McpPaste {
  const all = entriesOf(json).map(([n, e]) => fromEntry(n ?? name, e));
  return all.find((p) => p.kind === "url") ?? all.find((p) => p.kind === "command") ?? NONE;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A whole block, or one entry cut from inside one (`"name": { … },`). */
function fromJsonText(text: string): McpPaste {
  const json = parseJson(text) ?? parseJson(`{${text.replace(/,\s*$/, "")}}`);
  return fromJson(json);
}

/** Options of `claude mcp add` that take a value. */
const ADD_VALUE_OPTIONS = new Set([
  "-t",
  "--transport",
  "-s",
  "--scope",
  "-e",
  "--env",
  "-H",
  "--header",
  "--client-id",
  "--callback-port",
]);

function fromClaudeAdd(words: string[]): McpPaste {
  const headers: [string, string][] = [];
  const env: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") {
      positional.push(...words.slice(i + 1));
      break;
    }
    const eq = word.indexOf("=");
    const option = eq > 0 && word.startsWith("--") ? word.slice(0, eq) : word;
    // Its own options go anywhere; another dash word is a flag of its own before the command, the command's after.
    if (word.startsWith("-") && (ADD_VALUE_OPTIONS.has(option) || positional.length < 2)) {
      if (!ADD_VALUE_OPTIONS.has(option)) continue;
      const value = eq > 0 && word.startsWith("--") ? word.slice(eq + 1) : (words[++i] ?? "");
      if (option === "-H" || option === "--header") {
        const h = headerOf(value);
        if (h) headers.push(h);
      } else if (option === "-e" || option === "--env") {
        const at = value.indexOf("=");
        if (at > 0) env[value.slice(0, at)] = value.slice(at + 1);
      }
      continue;
    }
    positional.push(word);
  }
  const [name, target, ...rest] = positional;
  if (!name || !target) return NONE;
  if (isUrl(target)) return byAddress(name, target, headers, env);
  return { kind: "command", name, command: [target, ...rest].join(" ") };
}

function fromClaudeAddJson(words: string[]): McpPaste {
  const positional = words.filter((w, i) => !w.startsWith("-") && !["-s", "--scope"].includes(words[i - 1] ?? ""));
  const [name, json] = positional;
  return name && json ? fromJson(parseJson(json), name) : NONE;
}

/**
 * A command line split as a POSIX shell would: single and double quotes, backslash escapes, a backslash (or `^`, `)
 * at a line's end continuing it, and a leading prompt sign. Null for a quote left open.
 */
function shellWords(text: string): string[] | null {
  const line = text.replace(/^\s*[$>#]\s+/, "").replace(/[\\^`]\r?\n/g, " ");
  const words: string[] = [];
  // `word` is in progress while `started` (an empty pair of quotes is a word too).
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && /["\\$`]/.test(line[i + 1] ?? "")) word += line[++i] ?? "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i] ?? "";
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** What the connect form takes from a server by address: the server sends one key, as `Authorization: Bearer`. */
export interface PasteForForm {
  url: string;
  name: string | null;
  /** The literal Bearer token; null when there is none or it came from a variable. */
  apiKey: string | null;
  /** The variables or placeholders the key was written with, for the person to type its value. */
  keyAsked: string[];
  /** Names of the other headers, which aren't sent (their values are never shown). */
  unsent: string[];
}

export function pasteForForm(paste: Extract<McpPaste, { kind: "url" }>): PasteForForm {
  let apiKey: string | null = null;
  let keyAsked: string[] = [];
  const unsent: string[] = [];
  for (const h of paste.headers) {
    const bearer = /^bearer\s+(\S+)$/i.exec(h.value);
    if (h.name.toLowerCase() !== "authorization" || !bearer) {
      unsent.push(h.name);
    } else if (h.missing.length > 0) {
      keyAsked = h.missing;
    } else {
      apiKey = bearer[1] ?? null;
    }
  }
  return { url: paste.url, name: paste.name, apiKey, keyAsked, unsent };
}
