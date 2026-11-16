import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { AgentBrain } from "../src/api/types";
import { acpEngineOf, acpEngines } from "../src/lib/acp";
import { brainLine } from "../src/lib/brain";
import { modelInput, modelRows } from "../src/lib/brain-picker";
import { waitToolOff } from "../src/lib/machine-outages";
import { aiChoiceOf } from "../src/lib/no-ai";
import { brainName } from "../src/lib/outages";

// ADR 0216: the ACP agents a computer declares, as "Quem pensa" shows and saves them on the web and the phone.

const i18n = i18next.createInstance();
void i18n.init({ lng: "pt-BR", resources, initAsync: false });
const t = i18n.t.bind(i18n) as TFunction;

const VIBE = {
  id: "vibe",
  name: "Mistral Vibe",
  models: [
    { value: "vibe/devstral-3", label: "Devstral 3" },
    { value: "vibe/mistral-large-4", label: "Mistral Large 4" },
  ],
};
const ZED = { id: "zed", name: "Zed agent", models: [] };
const ACP = { kind: "acp" as const, available: true, models: [], defaultModel: null, engines: [VIBE, ZED] };

const view = (over: Partial<AgentBrain> = {}) =>
  ({
    brain: "acp",
    engine: "vibe",
    model: null,
    effectiveModel: null,
    effort: null,
    options: [{ kind: "model", available: true, models: [], defaultModel: null }],
    account: null,
    accounts: [],
    acp: ACP,
    ...over,
  }) as AgentBrain;

describe("ACP agents in Quem pensa", () => {
  test("an agent on one thinks with that agent by its name, never with Claude", () => {
    const line = brainLine(t, { kind: "acp", engine: "Mistral Vibe", model: "Devstral 3" }, "Sonnet");
    expect(line.text).toBe("Devstral 3 pelo Mistral Vibe");
    expect(line.text).not.toContain("Claude");
    expect(line.mark).toBeNull();
    // No model chosen: the ACP agent alone, on its own default.
    expect(brainLine(t, { kind: "acp", engine: "Mistral Vibe", model: null }, "Sonnet").text).toBe("Mistral Vibe");
    // A list from before the server named it: what it is, still not Claude.
    expect(brainLine(t, { kind: "acp", model: null }, "Sonnet").text).toBe("Agente ACP");
    expect(aiChoiceOf(view())).toBe("acp");
  });

  test("the agents the computer declares, and the one in use with its models", () => {
    expect(acpEngines(view()).map((e) => e.name)).toEqual(["Mistral Vibe", "Zed agent"]);
    // None while the computer can't run one (commands off, an older runner): nothing to pick.
    expect(acpEngines(view({ acp: { ...ACP, available: false, reason: "tool_off" } }))).toEqual([]);
    expect(acpEngineOf(view())).toMatchObject({ id: "vibe", name: "Mistral Vibe" });
    expect(acpEngineOf(view({ brain: "claude_code" }))).toBeNull();
    // One the computer stopped declaring keeps its id as its name.
    expect(acpEngineOf(view({ engine: "gone" }))).toEqual({ id: "gone", name: "gone", models: [] });
  });

  test("waiting for its computer, an agent on one is named as an ACP agent, not Claude Code", () => {
    expect(brainName("acp")).toBe("ACP");
    expect(brainName("claude_code")).toBe("Claude Code");
    // Its switch is the computer's commands: that is the one the wait note turns on.
    expect(waitToolOff({ brain: "acp", code: "tool_off", machineId: "m" })).toEqual({
      machineId: "m",
      tool: "commands",
    });
  });

  test("its models: the agent's own default first, then each it offered; a pick saves the id, the default none", () => {
    const rows = modelRows(t, view(), undefined);
    expect(rows.map((r) => [r.label, r.checked])).toEqual([
      ["Padrão do Mistral Vibe", true],
      ["Devstral 3", false],
      ["Mistral Large 4", false],
    ]);
    expect(rows.some((r) => r.label === "Automático")).toBe(false);
    const chosen = modelRows(t, view({ model: "vibe/devstral-3", effectiveModel: "vibe/devstral-3" }), undefined);
    expect(chosen.find((r) => r.checked)?.label).toBe("Devstral 3");
    // A model the agent no longer lists stays a row, checked.
    const kept = modelRows(t, view({ model: "vibe/old", effectiveModel: "vibe/old" }), undefined);
    expect(kept.find((r) => r.checked)?.label).toBe("vibe/old");
    expect(modelInput(rows[1]?.value ?? "", view())).toEqual({ model: "vibe/devstral-3" });
    expect(modelInput(rows[0]?.value ?? "", view())).toEqual({ model: null });
  });
});
