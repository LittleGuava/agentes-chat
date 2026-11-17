import { describe, expect, test } from "bun:test";
import type { AgentBrain } from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { acpInput, acpRows, modelInput, modelRows } from "../../src/features/ai/logic";
import { BRAIN_NAME } from "../../src/features/outages/logic";
import { translator } from "./fixtures";

// ADR 0216 on the phone: the agent's AI lists the ACP agents its computer declares; a tap thinks with one.

const VIBE = { id: "vibe", name: "Mistral Vibe", models: [{ value: "vibe/devstral-3", label: "Devstral 3" }] };
const ACP = {
  kind: "acp" as const,
  available: true,
  models: [],
  defaultModel: null,
  engines: [VIBE, { id: "zed", name: "Zed agent", models: [] }],
};
const view = (over: Partial<AgentBrain> = {}) =>
  ({
    brain: "model",
    model: null,
    effectiveModel: null,
    effort: null,
    options: [{ kind: "model", available: true, models: [], defaultModel: null }],
    account: null,
    accounts: [],
    acp: ACP,
    ...over,
  }) as AgentBrain;

describe("ACP agents on the agent's AI", () => {
  test("each agent its computer declares is a row, the one in use checked, with how many models it offers", async () => {
    const t = await translator("pt-BR");
    expect(acpRows(t, view())).toEqual([
      { key: "vibe", label: "Mistral Vibe", sub: "1 modelo", checked: false },
      { key: "zed", label: "Zed agent", sub: "Usa o modelo padrão dele", checked: false },
    ]);
    expect(acpRows(t, view({ brain: "acp", engine: "zed" })).map((r) => r.checked)).toEqual([false, true]);
    // Nothing to pick where its computer can't run one.
    expect(acpRows(t, view({ acp: { ...ACP, available: false, reason: "runner_old" } }))).toEqual([]);
  });

  test("a tap thinks with it on its own default; the one in use saves nothing", () => {
    expect(acpInput(view(), "vibe")).toEqual({ brain: "acp", engine: "vibe", model: null });
    expect(acpInput(view({ brain: "acp", engine: "vibe" }), "zed")).toEqual({
      brain: "acp",
      engine: "zed",
      model: null,
    });
    expect(acpInput(view({ brain: "acp", engine: "vibe" }), "vibe")).toBeNull();
  });

  test("waiting for its computer: named as an ACP agent, never Claude Code or nothing", () => {
    expect(BRAIN_NAME.acp).toBe("ACP");
  });

  test("its line and its models, as the web's: by its name, never Claude", async () => {
    const t = await translator("pt-BR");
    expect(brainLine(t, { kind: "acp", engine: "Mistral Vibe", model: "Devstral 3" }, "").text).toBe(
      "Devstral 3 pelo Mistral Vibe",
    );
    const on = view({ brain: "acp", engine: "vibe" });
    const rows = modelRows(t, on, undefined);
    expect(rows.map((r) => r.label)).toEqual(["Padrão do Mistral Vibe", "Devstral 3"]);
    expect(modelInput(rows[1]?.value ?? "", on)).toEqual({ model: "vibe/devstral-3" });
  });
});
