import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanServerUrl,
  isSettingName,
  LOCAL_CONFIG_LIMITS,
  type LocalConfig,
  type LocalConfigApp,
  type LocalMcpServer,
  type LocalServerKind,
  programName,
} from "@agenteschat/adapters/machine-protocol";
import { redactCommon } from "@agenteschat/adapters/redact";

/**
 * `local.config` (ADR 0055, addendum 2026-11-15): the MCP servers and skills the person who runs this computer set up
 * for Claude Code, Cursor and Codex, read only when they ask from the apps. Read-only, never through a link, each file
 * capped. Of a server, only what `LocalMcpServer` names leaves: no header, env or argument value ever does, so a key
 * kept in those files stays here.
 */

/** Where each tool keeps its settings, and how each place is shown (`~` for the home, the variable when one is set). */
export interface LocalConfigPaths {
  claudeJson: Place;
  cursorJson: Place;
  codexToml: Place;
  claudeSkills: Place;
}
interface Place {
  file: string;
  shown: string;
}

/** The places as the tools find them: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set, else the home's. */
export function localConfigPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): LocalConfigPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim();
  const codexHome = env.CODEX_HOME?.trim();
  return {
    claudeJson: claudeDir
      ? { file: path.join(claudeDir, ".claude.json"), shown: "$CLAUDE_CONFIG_DIR/.claude.json" }
      : { file: path.join(home, ".claude.json"), shown: "~/.claude.json" },
    cursorJson: { file: path.join(home, ".cursor", "mcp.json"), shown: "~/.cursor/mcp.json" },
    codexToml: codexHome
      ? { file: path.join(codexHome, "config.toml"), shown: "$CODEX_HOME/config.toml" }
      : { file: path.join(home, ".codex", "config.toml"), shown: "~/.codex/config.toml" },
    claudeSkills: claudeDir
      ? { file: path.join(claudeDir, "skills"), shown: "$CLAUDE_CONFIG_DIR/skills" }
      : { file: path.join(home, ".claude", "skills"), shown: "~/.claude/skills" },
  };
}

type FileRead = { state: "read"; text: string } | { state: "missing" | "too_big" | "unreadable" | "link" };

/**
 * A regular file of at most `max` bytes, never through a link: looked at before it is opened (Windows has no
 * `O_NOFOLLOW`), and the file opened must be the one looked at.
 */
function readCapped(file: string, max: number): FileRead {
  let fd: number | undefined;
  try {
    const seen = lstatSync(file);
    if (seen.isSymbolicLink()) return { state: "link" };
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== seen.ino || st.dev !== seen.dev) return { state: "unreadable" };
    if (st.size > max) return { state: "too_big" };
    const bytes = Buffer.alloc(st.size);
    return { state: "read", text: bytes.toString("utf8", 0, readSync(fd, bytes, 0, st.size, 0)) };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const masked = (keyInPath: boolean) => (keyInPath ? { keyInAddress: true as const } : {});
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysOf = (v: unknown) => (isRecord(v) ? Object.keys(v).filter(isSettingName) : []);

/**
 * One server of Claude Code's or Cursor's `mcpServers` (both write the same shape): `url` (with `type` `sse` for the
 * older transport) or `command`. Nothing but names and the cleaned address is kept.
 */
function jsonServer(app: LocalConfigApp, name: string, entry: unknown): LocalMcpServer | null {
  if (!isRecord(entry)) return null;
  const base = { app, name: name.slice(0, LOCAL_CONFIG_LIMITS.name), headers: keysOf(entry.headers) };
  if (typeof entry.url === "string") {
    const clean = cleanServerUrl(entry.url);
    if (!clean) return null;
    const kind: LocalServerKind = entry.type === "sse" ? "sse" : "http";
    return { ...base, kind, url: clean.url, env: [], query: clean.query, ...masked(clean.keyInPath) };
  }
  if (typeof entry.command === "string") {
    return { ...base, kind: "stdio", command: programName(entry.command) ?? "?", env: keysOf(entry.env), query: [] };
  }
  return null;
}

/**
 * One table of Codex's `[mcp_servers.<name>]`: `url` (Streamable HTTP, with `bearer_token_env_var`, `http_headers`
 * and `env_http_headers`) or `command` (with `env`).
 */
function codexServer(name: string, entry: unknown): LocalMcpServer | null {
  if (!isRecord(entry)) return null;
  const base = { app: "codex" as const, name: name.slice(0, LOCAL_CONFIG_LIMITS.name) };
  if (typeof entry.url === "string") {
    const clean = cleanServerUrl(entry.url);
    if (!clean) return null;
    const bearer = isSettingName(entry.bearer_token_env_var) ? entry.bearer_token_env_var : undefined;
    const headers = [
      ...(bearer ? ["Authorization"] : []),
      ...keysOf(entry.http_headers),
      ...keysOf(entry.env_http_headers),
    ];
    const env = [...(bearer ? [bearer] : []), ...Object.values(entry.env_http_headers ?? {}).filter(isSettingName)];
    return {
      ...base,
      kind: "http",
      url: clean.url,
      headers: [...new Set(headers)],
      env: [...new Set(env)],
      query: clean.query,
      ...masked(clean.keyInPath),
    };
  }
  if (typeof entry.command === "string") {
    return {
      ...base,
      kind: "stdio",
      command: programName(entry.command) ?? "?",
      headers: [],
      env: keysOf(entry.env),
      query: [],
    };
  }
  return null;
}

function parseText(
  read: FileRead,
  as: "json" | "toml",
): { state: LocalConfig["files"][number]["state"]; value?: unknown } {
  if (read.state !== "read") return { state: read.state };
  try {
    return { state: "read", value: as === "json" ? JSON.parse(read.text) : Bun.TOML.parse(read.text) };
  } catch {
    return { state: "unreadable" };
  }
}

/** Reads every place in `paths`: what it found, what it couldn't use and why. */
export function readLocalConfig(paths: LocalConfigPaths): LocalConfig {
  const config: LocalConfig = { files: [], servers: [], skills: [], skipped: [] };
  const skip = (p: string, reason: LocalConfig["skipped"][number]["reason"]) => {
    if (config.skipped.length < LOCAL_CONFIG_LIMITS.skipped) config.skipped.push({ path: p, reason });
  };
  const addServers = (place: Place, entries: [string, LocalMcpServer | null][]) => {
    for (const [name, server] of entries) {
      if (!server) continue;
      if (config.servers.length >= LOCAL_CONFIG_LIMITS.servers) skip(`${place.shown} › ${name}`, "too_many");
      else config.servers.push(server);
    }
  };

  const sources: [LocalConfigApp, Place, "json" | "toml"][] = [
    ["claude", paths.claudeJson, "json"],
    ["cursor", paths.cursorJson, "json"],
    ["codex", paths.codexToml, "toml"],
  ];
  for (const [app, place, as] of sources) {
    const parsed = parseText(readCapped(place.file, LOCAL_CONFIG_LIMITS.fileBytes), as);
    config.files.push({ app, path: place.shown, state: parsed.state });
    if (!isRecord(parsed.value)) continue;
    // Claude Code: only the top level (the person's own servers), never a project's.
    const table = app === "codex" ? parsed.value.mcp_servers : parsed.value.mcpServers;
    if (!isRecord(table)) continue;
    addServers(
      place,
      Object.entries(table).map(([name, entry]) => [
        name,
        app === "codex" ? codexServer(name, entry) : jsonServer(app, name, entry),
      ]),
    );
  }

  config.files.push({
    app: "claude",
    path: paths.claudeSkills.shown,
    state: readSkills(paths.claudeSkills, config, skip),
  });
  return config;
}

/** Each folder of `skills/` with its SKILL.md, by name; a link is listed, never followed. */
function readSkills(
  place: Place,
  config: LocalConfig,
  skip: (p: string, reason: LocalConfig["skipped"][number]["reason"]) => void,
): LocalConfig["files"][number]["state"] {
  let names: string[];
  try {
    if (!lstatSync(place.file).isDirectory()) return "unreadable";
    names = readdirSync(place.file).sort();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  let bytes = 0;
  for (const name of names) {
    const shown = `${place.shown}/${name}`;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path.join(place.file, name));
    } catch {
      skip(shown, "unreadable");
      continue;
    }
    if (st.isSymbolicLink()) {
      skip(shown, "link");
      continue;
    }
    if (!st.isDirectory()) continue;
    const read = readCapped(path.join(place.file, name, "SKILL.md"), LOCAL_CONFIG_LIMITS.skillBytes);
    if (read.state !== "read") {
      skip(shown, read.state === "missing" ? "no_skill" : read.state);
      continue;
    }
    if (
      config.skills.length >= LOCAL_CONFIG_LIMITS.skills ||
      bytes + read.text.length > LOCAL_CONFIG_LIMITS.skillsBytes
    ) {
      skip(shown, "too_many");
      continue;
    }
    bytes += read.text.length;
    const markdown = redactCommon(read.text);
    config.skills.push({
      name: name.slice(0, LOCAL_CONFIG_LIMITS.name),
      markdown,
      ...(markdown !== read.text ? { masked: true as const } : {}),
    });
  }
  return "read";
}
