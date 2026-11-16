import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { HealthIssue } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const issue = (over: Partial<HealthIssue> & Pick<HealthIssue, "id" | "kind">): HealthIssue => ({
  signature: `${over.kind}:0123456789abcdef`,
  title: "",
  source: null,
  subject: null,
  agentId: null,
  count: 1,
  firstAt: at(90),
  lastAt: at(5),
  examples: [],
  ...over,
});

const go = async (issues: HealthIssue[], role?: "member") => {
  const state = seedState({ healthIssues: issues });
  if (role && state.me?.organizations[0]) state.me.organizations[0].role = role;
  await renderApp(`/org/${ORG_ID}/settings/health`, { api: createFakeApi(state) });
  await settle(6);
};

describe("Configurações › Saúde", () => {
  test("one card per cause: what failed, how often and the latest occurrences", async () => {
    await go([
      issue({
        id: "h1",
        kind: "tool_error",
        source: "github_get_issue",
        title: "issue <n> not found in <path>",
        count: 12,
        examples: [{ at: at(5), runId: "r1", agent: { id: ADA_ID, name: "Ada" } }],
      }),
      issue({ id: "h2", kind: "timeout", source: "run.provider_timeout", subject: "Anthropic", count: 3 }),
      issue({ id: "h3", kind: "queue_stalled", source: "vault.sync" }),
      issue({
        id: "h4",
        kind: "cost_spike",
        agentId: ADA_ID,
        examples: [{ at: at(8), runId: "r9", agent: { id: ADA_ID, name: "Ada" } }],
      }),
    ]);
    const cards = [...document.querySelectorAll(".health-issue")].map((c) => c.textContent ?? "");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain("Erro de ferramenta");
    expect(cards[0]).toContain("github_get_issue");
    expect(cards[0]).toContain("issue <n> not found in <path>");
    expect(cards[0]).toContain("Ocorrências: 12");
    expect(cards[0]).toContain("Ada");
    // A run's failure in the words the conversation uses.
    expect(cards[1]).toContain("Tempo esgotado");
    expect(cards[1]).toContain("Anthropic");
    expect(cards[2]).toContain("Parado na fila");
    expect(cards[2]).toContain("vault.sync");
    expect(cards[3]).toContain("Uma execução de Ada custou ao workspace mais de US$ 5.");
  });

  test("nothing failing says so", async () => {
    await go([]);
    expect(screen().getByText("Nada falhando")).toBeTruthy();
  });

  test("a member without the audit log doesn't open it", async () => {
    await go([issue({ id: "h1", kind: "tool_error", source: "web_fetch", title: "boom" })], "member");
    expect(document.querySelector(".health-issue")).toBeNull();
  });
});
