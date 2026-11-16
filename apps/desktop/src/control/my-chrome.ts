import { MY_CHROME_MAX_MINUTES, type RunnerTools } from "@agenteschat/adapters/machine-protocol";
import type { Home } from "./store";

/**
 * ADR 0202: the switches that let an agent run programs as the person on this computer. Any of them on in any
 * organization here, no Chrome is lent: such an agent could reach the debugging port itself, past the tab of its own.
 */
export const LEND_BLOCKERS = [
  "commands",
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "copilot",
] as const;
export type LendBlocker = (typeof LEND_BLOCKERS)[number];

/** A switch as the runner reads it: the newer coding programs follow Codex's until they have their own. */
const on = (tools: RunnerTools, tool: LendBlocker) =>
  (tool === "commands" || tool === "claude" || tool === "codex" ? tools[tool] : (tools[tool] ?? tools.codex)) === true;

/** The switches on now, in any organization's runner here, that keep the person's Chrome from being lent. */
export function lendBlockers(homes: readonly Home[]): LendBlocker[] {
  return LEND_BLOCKERS.filter((tool) => homes.some((h) => h.access && on(h.access.tools, tool)));
}

/** The form's port and minutes, checked as the runner checks them; `error` names the field that's wrong. */
export function lendInput(
  port: string,
  minutes: string,
): { port: number; minutes: number } | { error: "port" | "minutes" } {
  const p = Number(port.trim());
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: "port" };
  const m = Number(minutes.trim());
  if (!Number.isInteger(m) || m < 1 || m > MY_CHROME_MAX_MINUTES) return { error: "minutes" };
  return { port: p, minutes: m };
}
