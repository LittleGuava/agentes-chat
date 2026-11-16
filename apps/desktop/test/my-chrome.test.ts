import { expect, test } from "bun:test";
import type { RunnerTools } from "@agenteschat/adapters/machine-protocol";
import { lendBlockers, lendInput } from "../src/control/my-chrome";
import type { Home } from "../src/control/store";

/** Lending the person's own Chrome (ADR 0202): never while an agent here may run programs as them. */

const home = (homeId: string, tools: RunnerTools | null): Home => ({
  homeId,
  dir: `/homes/${homeId}`,
  running: true,
  hello: null,
  status: null,
  jobs: [],
  requests: [],
  access: tools ? { folders: [], tools } : null,
  logo: null,
});
const off: RunnerTools = { claude: false, codex: false, commands: false };

test("commands in any organization here, or any coding program, keep the Chrome from being lent", () => {
  expect(lendBlockers([home("a", off), home("b", off)])).toEqual([]);
  expect(lendBlockers([home("a", off), home("b", { ...off, commands: true })])).toEqual(["commands"]);
  expect(lendBlockers([home("a", { ...off, claude: true })])).toEqual(["claude"]);
  // The newer programs follow Codex's switch until they have their own, as the runner reads them.
  expect(lendBlockers([home("a", { ...off, codex: true })])).toEqual([
    "codex",
    "cursor",
    "opencode",
    "grok",
    "antigravity",
    "copilot",
  ]);
  expect(
    lendBlockers([
      home("a", {
        ...off,
        codex: true,
        cursor: false,
        opencode: false,
        grok: false,
        antigravity: false,
        copilot: false,
      }),
    ]),
  ).toEqual(["codex"]);
  expect(lendBlockers([home("a", { ...off, copilot: true })])).toEqual(["copilot"]);
  // A runner that hasn't said its access yet holds nothing back here (its own runner still checks).
  expect(lendBlockers([home("a", null)])).toEqual([]);
});

test("the form's port and minutes are checked as the runner checks them", () => {
  expect(lendInput("9222", "30")).toEqual({ port: 9222, minutes: 30 });
  expect(lendInput(" 9222 ", "480")).toEqual({ port: 9222, minutes: 480 });
  expect(lendInput("", "30")).toEqual({ error: "port" });
  expect(lendInput("0", "30")).toEqual({ error: "port" });
  expect(lendInput("65536", "30")).toEqual({ error: "port" });
  expect(lendInput("92.5", "30")).toEqual({ error: "port" });
  expect(lendInput("9222", "0")).toEqual({ error: "minutes" });
  expect(lendInput("9222", "481")).toEqual({ error: "minutes" });
});
