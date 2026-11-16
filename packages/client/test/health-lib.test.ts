import { describe, expect, test } from "bun:test";
import { en as EN, resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { HealthIssue } from "../src/api/types";
import { healthHeadline, healthSource } from "../src/lib/health";

function translator(lng: string): TFunction {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t.bind(i18n) as TFunction;
}
const en = translator("en");
const pt = translator("pt-BR");

const issue = (over: Partial<HealthIssue> & Pick<HealthIssue, "kind">): HealthIssue => ({
  id: "h1",
  signature: `${over.kind}:0123456789abcdef`,
  title: "",
  source: null,
  subject: null,
  agentId: null,
  count: 1,
  firstAt: "2026-11-15T10:00:00Z",
  lastAt: "2026-11-15T11:00:00Z",
  examples: [],
  ...over,
});

describe("healthHeadline", () => {
  // The scan keeps a run's error code, one name (`subject`: the provider, brain, model or the model's provider) and
  // one text (`title`: the detail, or the key's provider). Every sentence the conversation has for a code is whole.
  const codes = Object.keys(EN.agentPage.activity.errors);
  test.each(codes)("run.%s reads whole, with no empty placeholder", (code) => {
    const line = healthHeadline(
      en,
      issue({ kind: "run_failed", source: `run.${code}`, subject: "Acme", title: "Zeta" }),
    );
    expect(line).not.toContain("{{");
    expect(line).not.toMatch(/\s[.,:]|\s{2}|^\s|\s$/);
    const template = (EN.agentPage.activity.errors as Record<string, string>)[code] ?? "";
    if (/\{\{/.test(template)) expect(line).toMatch(/Acme|Zeta/);
  });

  test("a stalled job, a failed one, a costly run and a tool's error, in the person's language", () => {
    expect(healthHeadline(pt, issue({ kind: "queue_stalled", source: "vault.sync" }))).toBe(
      "Esperou mais de 5 minutos além da hora de começar.",
    );
    expect(healthHeadline(pt, issue({ kind: "job_failed", source: "mail.poll" }))).toBe(
      "Desistiu depois da última tentativa.",
    );
    expect(healthHeadline(pt, issue({ kind: "job_failed", title: "IMAP <n> refused" }))).toBe("IMAP <n> refused");
    expect(
      healthHeadline(
        pt,
        issue({
          kind: "cost_spike",
          examples: [{ at: "2026-11-15T11:00:00Z", runId: "r", agent: { id: "a", name: "Ada" } }],
        }),
      ),
    ).toBe("Uma execução de Ada custou ao workspace mais de US$ 5.");
    expect(healthHeadline(pt, issue({ kind: "tool_error", source: "web_fetch", title: "boom" }))).toBe("boom");
  });

  test("the source shows as code only for tools and jobs: a run's words already name it", () => {
    expect(healthSource(issue({ kind: "tool_error", source: "web_fetch" }))).toBe("web_fetch");
    expect(healthSource(issue({ kind: "job_failed", source: "mail.poll" }))).toBe("mail.poll");
    expect(healthSource(issue({ kind: "timeout", source: "run.provider_timeout" }))).toBeNull();
  });
});
