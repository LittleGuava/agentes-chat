import { describe, expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";

describe("an important email no routine took (ADR 0038, addendum 2026-11-15)", () => {
  test("says which mailbox in its own headline and opens Connectors, where the mailbox and its triage are", () => {
    const notice = {
      kind: "mail_important",
      source: { label: "support@example.com" },
      latest: { title: "Contract renewal", text: "legal@bank.com · Contract renewal" },
    } as unknown as AppNotification;
    expect(workspaceHeadline(notice)).toBe("mail.triage.notice");
    expect(openTarget(notice)).toEqual({ to: "/org/$orgId/settings/$section", params: { section: "connectors" } });
  });
});
