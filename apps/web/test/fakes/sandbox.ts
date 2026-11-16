/**
 * Test fake — the agents' computers (`ApiClient.sandbox`). Mirrors `GET/PUT …/sandbox-settings`,
 * `GET …/agents/{id}/computer` and `PUT …/computer/target`
 * (apps/server/src/routes/app/sandboxes.ts, routes/machines.ts).
 */
import type { AgentRelaySite, ApiClient, ComputerTarget, SandboxSettings } from "@agenteschat/client";
import { clone, type MockContext } from "./context";
import type { FakeMachines } from "./machines";

export function createFakeSandbox(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
  machines?: FakeMachines,
): ApiClient["sandbox"] {
  /** `PUT …/computer/target`: agent → machine id (absent = none). */
  const targets = new Map<string, string>();
  const targetOf = (agentId: string): ComputerTarget => {
    const id = targets.get(agentId);
    const m = id ? machines?.peek(id) : undefined;
    return m ? { kind: "machine", machineId: m.id, name: m.name, online: m.online } : { kind: "none" };
  };
  /**
   * As `agentRelaySites` (packages/engine/src/relay.ts): the sites a person's other computer lends this agent, by
   * site; an agent with no computer has none. `online` is whether that computer answers now.
   */
  const relayOf = (agentId: string): AgentRelaySite[] => {
    const home = targets.get(agentId);
    if (!home || !machines) return [];
    return machines
      .all()
      .filter((m) => m.id !== home && m.kind !== "managed" && m.kind !== "host" && m.mode !== "system")
      .flatMap((m) =>
        (m.access?.relay ?? [])
          .filter((g) => g.agents.includes("*") || g.agents.includes(agentId))
          .map((g) => ({
            site: g.site,
            machine: { id: m.id, name: m.name },
            by: m.pairedBy,
            online: m.online && !m.paused,
          })),
      )
      .sort((a, b) => a.site.localeCompare(b.site) || a.machine.name.localeCompare(b.machine.name));
  };
  let settings: SandboxSettings = {
    enabled: true,
    execTimeoutSeconds: 120,
    maxTimeoutSeconds: 900,
    requireApproval: false,
  };
  return {
    settings: async () => clone(settings),
    saveSettings: async (orgId, input) => {
      log("sandbox.saveSettings", orgId, input);
      settings = { ...settings, ...input };
      return clone(settings);
    },
    computer: async (_orgId, agentId) => clone({ target: targetOf(agentId), relay: relayOf(agentId) }),
    setTarget: async (orgId, agentId, machineId) => {
      log("sandbox.setTarget", orgId, agentId, machineId);
      const before = targets.get(agentId);
      if (machineId) targets.set(agentId, machineId);
      else targets.delete(agentId);
      if (machines) {
        const agents = await ctx.lookup.agents(orgId);
        for (const id of new Set([before, machineId].filter((x): x is string => Boolean(x)))) {
          machines.setAgents(
            id,
            agents.filter((a) => targets.get(a.id) === id).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
          );
        }
      }
      return targetOf(agentId);
    },
  };
}
