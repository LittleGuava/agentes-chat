import { describe, expect, test } from "bun:test";
import { failureSignature, normalizeFailure } from "../src/health-signature";

describe("normalizeFailure", () => {
  test("numbers, ids and paths become placeholders, so one cause is one line", () => {
    expect(normalizeFailure("no layer 12 in /srv/data/maps.json")).toBe("no layer <n> in <path>");
    expect(normalizeFailure("no layer 104 in /home/ada/other/file.json")).toBe("no layer <n> in <path>");
    expect(normalizeFailure("Issue 0214a2b3-4c5d-4e6f-8a9b-0c1d2e3f4a5b not found")).toBe("Issue <id> not found");
    expect(normalizeFailure("commit deadbeefcafe1234 is gone")).toBe("commit <hex> is gone");
  });

  test("nothing a person wrote or a secret survives", () => {
    const raw =
      'Request to https://api.example.com/v1/users?key=abc failed for ada@example.com: channel "plans for Q3" ' +
      "with Authorization: Bearer sk-ant-api03-supersecretvalue123456789 at C:\\Users\\ada\\notes.txt";
    const line = normalizeFailure(raw);
    for (const leaked of ["example.com", "ada@", "plans for Q3", "supersecret", "sk-ant", "notes.txt", "abc"]) {
      expect(line).not.toContain(leaked);
    }
    expect(line).toContain("<url>");
    expect(line).toContain("<email>");
    expect(line).toContain("<q>");
  });

  test("only the first line, whitespace collapsed, at most 160 characters", () => {
    expect(normalizeFailure("  bad   gateway\n  at stack frame 1\n")).toBe("bad gateway");
    expect(normalizeFailure(`${"word ".repeat(80)}`).length).toBeLessThanOrEqual(160);
    expect(normalizeFailure("")).toBe("");
  });
});

describe("failureSignature", () => {
  test("the same cause with other numbers is one signature; another tool or kind is another", () => {
    const a = failureSignature("tool_error", "github_get_issue", normalizeFailure("issue 12 not found"));
    const b = failureSignature("tool_error", "github_get_issue", normalizeFailure("issue 9001 not found"));
    const c = failureSignature("tool_error", "linear_get_issue", normalizeFailure("issue 12 not found"));
    const d = failureSignature("run_failed", "github_get_issue", normalizeFailure("issue 12 not found"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^tool_error:[0-9a-f]{16}$/);
  });
});
