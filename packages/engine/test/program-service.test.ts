import { expect, test } from "bun:test";
import { programService } from "../src/connectors/computer-programs";

/*
 * ADR 0215, addendum 2026-11-17: a program on a computer never stands in for a service a preset locks (ADR 0016: it
 * signs in, every call asks, tools are withheld). The locks go by a connection's host and a program's address is its
 * computer's, so the service is read from the program's own words.
 */

const program = (args: string[], env: Record<string, string> = {}, command = "npx") => ({ command, args, env });

test("an address on a locked host, in an argument, a variable or the command, names the service", () => {
  expect(programService(program(["-y", "mcp-remote", "https://mcp.agentcard.sh/mcp"]))).toBe("mcp.agentcard.sh");
  expect(programService(program(["bridge"], { MCP_URL: "https://api.telnyx.com/v2/mcp" }))).toBe("api.telnyx.com");
  expect(programService(program([], {}, "https://mcp.agentcard.sh/mcp"))).toBe("mcp.agentcard.sh");
});

test("however the address is written: another path or query, any case, a trailing dot, after a flag's =, in quotes", () => {
  for (const word of [
    "https://MCP.Agentcard.sh/MCP?team=growth",
    "https://mcp.agentcard.sh./mcp//",
    "--url=https://mcp.agentcard.sh/other",
    'sh -c "exec bridge https://mcp.agentcard.sh/mcp"',
    "http://mcp.agentcard.sh/mcp",
  ]) {
    expect(programService(program(["-y", "bridge", word]))).toBe("mcp.agentcard.sh");
  }
});

test("any other address, and a word that only looks like one, is the program's own business", () => {
  expect(programService(program(["-y", "mcp-remote", "https://notes.example.com/mcp"]))).toBeNull();
  expect(programService(program(["mcp.agentcard.sh", "agentcard", "https://agentcard.example.com/mcp"]))).toBeNull();
  expect(programService(program([]))).toBeNull();
});
