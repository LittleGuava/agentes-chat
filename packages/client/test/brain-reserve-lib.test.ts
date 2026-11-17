import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { brainReserveText } from "../src/lib/plan-usage";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) =>
  `${key} ${JSON.stringify(values)}`) as unknown as TFunction;

test("a reply a reserve AI gave says which, and why its own plan didn't", () => {
  const limit = {
    brainReserve: {
      from: { brain: "claude_code", account: "Principal" },
      to: { brain: "codex", account: "Reserva", accountId: "a2" },
      code: "plan_limit",
    },
  };
  expect(brainReserveText(t, limit)).toBe(
    'chat.brainReserve.limit {"from":"Principal (Claude Code)","to":"Reserva (Codex)"}',
  );
  // The computer's own sign-in has no account name: the brain's alone.
  const signedOut = { brainReserve: { ...limit.brainReserve, from: { brain: "claude_code" }, code: "not_logged_in" } };
  expect(brainReserveText(t, signedOut)).toBe(
    'chat.brainReserve.signedOut {"from":"Claude Code","to":"Reserva (Codex)"}',
  );
  // Nothing on any other reply, nor on one that doesn't say who.
  expect(brainReserveText(t, {})).toBeNull();
  expect(brainReserveText(t, { brainReserve: { from: { brain: "claude_code" }, code: "plan_limit" } })).toBeNull();
});
