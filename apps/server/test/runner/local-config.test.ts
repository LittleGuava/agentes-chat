import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_CONFIG_LIMITS, parseLocalConfig } from "@agenteschat/adapters/machine-protocol";
import { localConfigPaths, readLocalConfig } from "../../runner/local-config";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

/** A home folder of its own, never the one of whoever runs the tests. */
function home() {
  const dir = tempDir("local-config-");
  dirs.push(dir);
  return dir;
}

function put(root: string, file: string, text: string) {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

const skill = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${name} for tests\n---\n\n${body}\n`;

test("the three tools' MCP servers: names, kinds and addresses, never a value of a header, an env or an argument", () => {
  const h = home();
  put(
    h,
    ".claude.json",
    JSON.stringify({
      oauthAccount: { emailAddress: "someone@example.com" },
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_secret" } },
        legacy: { type: "sse", url: "https://old.example.com/sse?token=abc123#frag" },
        files: { command: "/usr/local/bin/npx", args: ["-y", "files", "--api-key=sk-live-1"], env: { FILES_KEY: "k" } },
      },
      projects: { "/repo": { mcpServers: { hidden: { type: "http", url: "https://project.example.com/mcp" } } } },
    }),
  );
  put(
    h,
    ".cursor/mcp.json",
    JSON.stringify({
      mcpServers: {
        notion: { url: "https://user:pass@mcp.notion.com/mcp", headers: { "X-Key": "nt_secret" } },
        local: { url: "http://localhost:3000/mcp" },
      },
    }),
  );
  put(
    h,
    ".codex/config.toml",
    [
      "model = 'gpt-5'",
      "[mcp_servers.github]",
      'url = "https://api.githubcopilot.com/mcp/"',
      'bearer_token_env_var = "GITHUB_TOKEN"',
      'http_headers = { "X-Team" = "acme" }',
      "[mcp_servers.db]",
      'command = "uvx"',
      'args = ["db-mcp", "--password", "hunter2"]',
      "env = { DB_URL = 'postgres://u:p@h/db' }",
    ].join("\n"),
  );

  const config = readLocalConfig(localConfigPaths({ HOME: h }, h));
  expect(config.files).toEqual([
    { app: "claude", path: "~/.claude.json", state: "read" },
    { app: "cursor", path: "~/.cursor/mcp.json", state: "read" },
    { app: "codex", path: "~/.codex/config.toml", state: "read" },
    { app: "claude", path: "~/.claude/skills", state: "missing" },
  ]);
  expect(config.servers).toEqual([
    {
      app: "claude",
      name: "linear",
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      headers: ["Authorization"],
      env: [],
      query: [],
    },
    {
      app: "claude",
      name: "legacy",
      kind: "sse",
      url: "https://old.example.com/sse",
      headers: [],
      env: [],
      query: ["token"],
    },
    { app: "claude", name: "files", kind: "stdio", command: "npx", headers: [], env: ["FILES_KEY"], query: [] },
    {
      app: "cursor",
      name: "notion",
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: ["X-Key"],
      env: [],
      query: [],
    },
    { app: "cursor", name: "local", kind: "http", url: "http://localhost:3000/mcp", headers: [], env: [], query: [] },
    {
      app: "codex",
      name: "github",
      kind: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: ["Authorization", "X-Team"],
      env: ["GITHUB_TOKEN"],
      query: [],
    },
    { app: "codex", name: "db", kind: "stdio", command: "uvx", headers: [], env: ["DB_URL"], query: [] },
  ]);
  const wire = JSON.stringify(config);
  for (const secret of ["lin_secret", "abc123", "sk-live-1", "nt_secret", "pass@", "hunter2", "postgres://", "acme"]) {
    expect(wire).not.toContain(secret);
  }
  // Only the top level of `.claude.json`: a project's own servers and the account stay on the computer.
  expect(wire).not.toContain("project.example.com");
  expect(wire).not.toContain("someone@example.com");
  // What the runner sends passes the server's own check unchanged.
  expect(parseLocalConfig(JSON.parse(wire))).toEqual(config);
});

test("a key where a value isn't looked for: in the address's path, in a SKILL.md, and a settings file that is a link", () => {
  const h = home();
  const pathKey = "a1B2c3D4e5F6g7H8i9J0k1L2m3";
  put(
    h,
    ".claude.json",
    JSON.stringify({ mcpServers: { hook: { type: "http", url: `https://hooks.example.com/s/${pathKey}/mcp` } } }),
  );
  const key = "sk-ant-api03-abcdefghijklmnop0123456789";
  put(
    h,
    ".claude/skills/deploy/SKILL.md",
    skill(
      "deploy",
      `Call the API with
Authorization: Bearer ${key}
`,
    ),
  );
  put(h, ".claude/skills/plain/SKILL.md", skill("plain"));
  const elsewhere = home();
  put(elsewhere, "mcp.json", JSON.stringify({ mcpServers: { far: { url: "https://far.example.com/mcp" } } }));
  mkdirSync(path.join(h, ".cursor"), { recursive: true });
  let linked = true;
  try {
    symlinkSync(path.join(elsewhere, "mcp.json"), path.join(h, ".cursor", "mcp.json"), "file");
  } catch {
    linked = false; // Windows without the right to make links.
  }

  const config = readLocalConfig(localConfigPaths({ HOME: h }, h));
  expect(config.servers.find((s) => s.name === "hook")).toEqual({
    app: "claude",
    name: "hook",
    kind: "http",
    url: "https://hooks.example.com/s/***/mcp",
    headers: [],
    env: [],
    query: [],
    keyInAddress: true,
  });
  const deploy = config.skills.find((s) => s.name === "deploy");
  expect(deploy?.masked).toBe(true);
  expect(deploy?.markdown).toContain("Authorization: Bearer ***");
  expect(config.skills.find((s) => s.name === "plain")).toEqual({ name: "plain", markdown: skill("plain") });
  if (linked) {
    expect(config.files.find((f) => f.app === "cursor")?.state).toBe("link");
    expect(config.servers.find((s) => s.name === "far")).toBeUndefined();
  }
  const wire = JSON.stringify(config);
  expect(wire).not.toContain(pathKey);
  expect(wire).not.toContain(key);
  expect(parseLocalConfig(JSON.parse(wire))).toEqual(config);
});

test("skills: each folder's SKILL.md, sorted; links, big files and what passes the caps are listed, not read", () => {
  const h = home();
  put(h, ".claude/skills/review/SKILL.md", skill("review"));
  put(h, ".claude/skills/deploy/SKILL.md", skill("deploy"));
  put(h, ".claude/skills/deploy/script.sh", "echo hi");
  put(h, ".claude/skills/empty/notes.txt", "no SKILL.md here");
  put(h, ".claude/skills/huge/SKILL.md", skill("huge", "x".repeat(LOCAL_CONFIG_LIMITS.skillBytes)));
  put(h, ".claude/skills/README.md", "a file, not a skill");
  const outside = home();
  put(outside, "linked/SKILL.md", skill("linked"));
  let linked = true;
  try {
    symlinkSync(path.join(outside, "linked"), path.join(h, ".claude/skills/linked"), "dir");
  } catch {
    linked = false; // Windows without the right to make links.
  }

  const config = readLocalConfig(localConfigPaths({ HOME: h }, h));
  expect(config.skills.map((s) => s.name)).toEqual(["deploy", "review"]);
  expect(config.skills[0]?.markdown).toBe(skill("deploy"));
  expect(config.skipped).toEqual([
    { path: "~/.claude/skills/empty", reason: "no_skill" },
    { path: "~/.claude/skills/huge", reason: "too_big" },
    ...(linked ? [{ path: "~/.claude/skills/linked", reason: "link" as const }] : []),
  ]);
  expect(config.files.find((f) => f.path === "~/.claude/skills")?.state).toBe("read");
});

test("a file it can't use says so: too big, not JSON or TOML, and CLAUDE_CONFIG_DIR and CODEX_HOME are followed", () => {
  const h = home();
  const claudeDir = path.join(h, "elsewhere");
  put(claudeDir, ".claude.json", "{ not json");
  put(claudeDir, "skills/one/SKILL.md", skill("one"));
  put(h, ".cursor/mcp.json", `{"mcpServers":{}, "pad": "${"x".repeat(LOCAL_CONFIG_LIMITS.fileBytes)}"}`);
  put(h, "codex-home/config.toml", "[mcp_servers.x\nbroken");

  const config = readLocalConfig(
    localConfigPaths({ HOME: h, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(h, "codex-home") }, h),
  );
  expect(config.files).toEqual([
    { app: "claude", path: "$CLAUDE_CONFIG_DIR/.claude.json", state: "unreadable" },
    { app: "cursor", path: "~/.cursor/mcp.json", state: "too_big" },
    { app: "codex", path: "$CODEX_HOME/config.toml", state: "unreadable" },
    { app: "claude", path: "$CLAUDE_CONFIG_DIR/skills", state: "read" },
  ]);
  expect(config.servers).toEqual([]);
  expect(config.skills.map((s) => s.name)).toEqual(["one"]);
});

test("caps: past the most servers and skills one answer carries, the rest is counted as left out", () => {
  const h = home();
  const many = Object.fromEntries(
    Array.from({ length: LOCAL_CONFIG_LIMITS.servers + 5 }, (_, i) => [
      `s${i}`,
      { url: `https://s${i}.example.com/mcp` },
    ]),
  );
  put(h, ".cursor/mcp.json", JSON.stringify({ mcpServers: many }));
  for (let i = 0; i < LOCAL_CONFIG_LIMITS.skills + 2; i++) {
    put(h, `.claude/skills/k${String(i).padStart(3, "0")}/SKILL.md`, skill(`k${i}`));
  }
  const config = readLocalConfig(localConfigPaths({ HOME: h }, h));
  expect(config.servers).toHaveLength(LOCAL_CONFIG_LIMITS.servers);
  expect(config.skills).toHaveLength(LOCAL_CONFIG_LIMITS.skills);
  expect(config.skipped.filter((s) => s.reason === "too_many")).toHaveLength(7);
});
