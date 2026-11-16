import { describe, expect, test } from "bun:test";
import { parseMcpPaste, pasteForForm } from "../src/lib/mcp-paste";

const header = (name: string, value: string, missing: string[] = []) => ({ name, value, missing });

describe("parseMcpPaste: claude mcp add", () => {
  test("a server by address with its transport, scope and headers", () => {
    expect(
      parseMcpPaste(
        `claude mcp add --transport http -s user acme https://mcp.acme.com/mcp --header "Authorization: Bearer abc12345" -H 'X-Team: blue'`,
      ),
    ).toEqual({
      kind: "url",
      name: "acme",
      url: "https://mcp.acme.com/mcp",
      headers: [header("Authorization", "Bearer abc12345"), header("X-Team", "blue")],
      missing: [],
    });
  });

  test("lines continued with a backslash, a prompt sign, = options and terminal variables", () => {
    const paste = [
      "$ claude mcp add --transport=sse internal https://tools.example.com/sse \\",
      '  --header "CF-Access-Client-Id: $CF_ID" \\',
      `  --header "CF-Access-Client-Secret: \${CF_SECRET}"`,
    ].join("\n");
    expect(parseMcpPaste(paste)).toEqual({
      kind: "url",
      name: "internal",
      url: "https://tools.example.com/sse",
      headers: [
        header("CF-Access-Client-Id", "$CF_ID", ["CF_ID"]),
        header("CF-Access-Client-Secret", `\${CF_SECRET}`, ["CF_SECRET"]),
      ],
      missing: [],
    });
  });

  test("a value given with -e fills the variable it names", () => {
    expect(
      parseMcpPaste(
        `claude mcp add -e TOKEN=tok_987654 -t http notes https://notes.example.com/mcp -H "Authorization: Bearer \${TOKEN}"`,
      ),
    ).toMatchObject({ kind: "url", headers: [header("Authorization", "Bearer tok_987654")] });
  });

  test("a variable named like an object's own property stays a variable", () => {
    expect(
      parseMcpPaste(
        `claude mcp add -t http odd https://odd.example.com/mcp -H "X-Key: \${constructor}" -H "X-Other: $toString"`,
      ),
    ).toMatchObject({
      headers: [header("X-Key", `\${constructor}`, ["constructor"]), header("X-Other", "$toString", ["toString"])],
    });
  });

  test("a command (stdio), with or without --, is a command", () => {
    expect(parseMcpPaste("claude mcp add files -- npx -y @modelcontextprotocol/server-filesystem /tmp")).toEqual({
      kind: "command",
      name: "files",
      command: "npx -y @modelcontextprotocol/server-filesystem /tmp",
    });
    expect(parseMcpPaste("claude mcp add -e KEY=1 db uvx mcp-server-sqlite")).toMatchObject({
      kind: "command",
      name: "db",
      command: "uvx mcp-server-sqlite",
    });
  });

  test("add-json carries its JSON", () => {
    expect(
      parseMcpPaste(
        `claude mcp add-json -s project weather '{"type":"http","url":"https://weather.example.com/mcp","headers":{"X-Api-Key":"<your key>"}}'`,
      ),
    ).toEqual({
      kind: "url",
      name: "weather",
      url: "https://weather.example.com/mcp",
      headers: [header("X-Api-Key", "<your key>", ["your key"])],
      missing: [],
    });
  });
});

describe("parseMcpPaste: JSON", () => {
  test("mcpServers (Claude, Cursor): the first server by address wins over a command", () => {
    const json = JSON.stringify({
      mcpServers: {
        local: { command: "node", args: ["server.js"] },
        linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer YOUR_API_KEY" } },
      },
    });
    expect(parseMcpPaste(json)).toEqual({
      kind: "url",
      name: "linear",
      url: "https://mcp.linear.app/sse",
      headers: [header("Authorization", "Bearer YOUR_API_KEY", ["YOUR_API_KEY"])],
      missing: [],
    });
  });

  test("VS Code's servers, Windsurf's serverUrl, a bare entry and an entry cut from inside the object", () => {
    expect(
      parseMcpPaste(`{"servers":{"gh":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}`),
    ).toMatchObject({ kind: "url", name: "gh", url: "https://api.githubcopilot.com/mcp/" });
    expect(parseMcpPaste(`{"mcp":{"servers":{"gh":{"url":"https://api.githubcopilot.com/mcp/"}}}}`)).toMatchObject({
      kind: "url",
      name: "gh",
    });
    expect(parseMcpPaste(`{"deep":{"serverUrl":"https://deep.example.com/mcp"}}`)).toMatchObject({
      kind: "url",
      name: "deep",
      url: "https://deep.example.com/mcp",
    });
    expect(parseMcpPaste(`{"url":"https://solo.example.com/mcp"}`)).toMatchObject({ kind: "url", name: null });
    expect(
      parseMcpPaste(
        `"tickets": {\n  "url": "https://tickets.example.com/mcp",\n  "headers": {"X-Key": "\${env:TICKETS_KEY}"}\n},`,
      ),
    ).toEqual({
      kind: "url",
      name: "tickets",
      url: "https://tickets.example.com/mcp",
      headers: [header("X-Key", `\${env:TICKETS_KEY}`, ["TICKETS_KEY"])],
      missing: [],
    });
  });

  test("mcp-remote is its server's address, with its headers and the env filling them", () => {
    const json = JSON.stringify({
      mcpServers: {
        wiki: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote@latest",
            "https://wiki.example.com/sse",
            "--header",
            `Authorization:Bearer \${AUTH}`,
          ],
          env: { AUTH: "wiki_token_42" },
        },
      },
    });
    expect(parseMcpPaste(json)).toEqual({
      kind: "url",
      name: "wiki",
      url: "https://wiki.example.com/sse",
      headers: [header("Authorization", "Bearer wiki_token_42")],
      missing: [],
    });
  });

  test("only commands: the first one, named", () => {
    expect(
      parseMcpPaste(`{"mcpServers":{"git":{"command":"uvx","args":["mcp-server-git","--repository","."]}}}`),
    ).toEqual({
      kind: "command",
      name: "git",
      command: "uvx mcp-server-git --repository .",
    });
  });
});

describe("parseMcpPaste: anything else", () => {
  test("an address alone, with surrounding spaces; one with a variable in it", () => {
    expect(parseMcpPaste("  https://mcp.example.com/mcp \n")).toEqual({
      kind: "url",
      name: null,
      url: "https://mcp.example.com/mcp",
      headers: [],
      missing: [],
    });
    expect(parseMcpPaste(`https://mcp.example.com/mcp?key=\${KEY}`)).toMatchObject({ kind: "url", missing: ["KEY"] });
  });

  test("npx, uvx and docker run lines are commands", () => {
    for (const line of ["npx -y @upstash/context7-mcp", "uvx mcp-server-time", "docker run -i --rm mcp/fetch"]) {
      expect(parseMcpPaste(line)).toEqual({ kind: "command", name: null, command: line });
    }
  });

  test("text that is none of these, broken JSON and quotes left open never throw", () => {
    for (const text of [
      "",
      "hello world",
      "{not json",
      `claude mcp add "open`,
      "claude mcp add",
      "[1,2]",
      "{}",
      "null",
    ]) {
      expect(parseMcpPaste(text)).toEqual({ kind: "none" });
    }
  });
});

describe("pasteForForm: what the connect form can use", () => {
  const url = (headers: ReturnType<typeof header>[], missing: string[] = []) =>
    ({ kind: "url", name: "acme", url: "https://mcp.acme.com/mcp", headers, missing }) as const;

  test("a literal Bearer becomes the key; no other header goes", () => {
    expect(pasteForForm(url([header("Authorization", "Bearer abc12345")]))).toEqual({
      url: "https://mcp.acme.com/mcp",
      name: "acme",
      apiKey: "abc12345",
      keyAsked: [],
      headers: [],
    });
  });

  test("a Bearer from a variable asks for the key; other headers go to the form's request headers", () => {
    expect(
      pasteForForm(
        url([
          header("authorization", `Bearer \${TOKEN}`, ["TOKEN"]),
          header("CF-Access-Client-Id", "id.access"),
          header("CF-Access-Client-Secret", "s3cr3t"),
        ]),
      ),
    ).toEqual({
      url: "https://mcp.acme.com/mcp",
      name: "acme",
      apiKey: null,
      keyAsked: ["TOKEN"],
      headers: [
        { name: "CF-Access-Client-Id", value: "id.access" },
        { name: "CF-Access-Client-Secret", value: "s3cr3t" },
      ],
    });
  });

  test("another scheme in Authorization goes as a header, not as the key", () => {
    expect(pasteForForm(url([header("Authorization", "Token abc12345")]))).toMatchObject({
      apiKey: null,
      headers: [{ name: "Authorization", value: "Token abc12345" }],
    });
  });
});
