import { expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "../src/api/types";
import {
  addReserve,
  MAX_RESERVES,
  moveReserve,
  offersReserves,
  removeReserve,
  reserveCandidates,
  reserveRows,
  sameReserves,
} from "../src/lib/brain-reserves";

const account = (id: string, label: string, kind: MachineAccount["kind"] = "claude_code"): MachineAccount => ({
  id,
  kind,
  label,
  email: null,
  plan: null,
  status: "active",
  ownerId: "u1",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
});

const view = (patch: Partial<AgentBrain> = {}) =>
  ({
    brain: "claude_code",
    account: "main",
    accountsSupported: true,
    accounts: [
      account("main", "Principal"),
      account("work", "Trabalho"),
      account("gpt", "Pessoal", "codex"),
      account("spare", "Sobra"),
      account("more", "Mais uma"),
    ],
    fallbackChain: [],
    ...patch,
  }) as AgentBrain;

test("the candidates: the computer's accounts but the one it thinks with and the ones already chosen, none once full", () => {
  expect(reserveCandidates(view(), [], "u1").map((a) => a.id)).toEqual(["work", "gpt", "spare", "more"]);
  const two = [{ accountId: "gpt" }, { accountId: "work" }];
  expect(reserveCandidates(view(), two, "u1").map((a) => a.id)).toEqual(["spare", "more"]);
  const full = addReserve(two, "spare");
  expect(full).toHaveLength(MAX_RESERVES);
  expect(reserveCandidates(view(), full, "u1")).toEqual([]);
  // Full, or already there: nothing changes.
  expect(addReserve(full, "more")).toBe(full);
  expect(addReserve(two, "gpt")).toBe(two);
});

test("the chosen ones in order, moved one place at a time, removed; an account the computer no longer lists isn't shown", () => {
  const chain = [{ accountId: "work" }, { accountId: "gone" }, { accountId: "gpt" }];
  expect(reserveRows(view(), chain).map((r) => r.account.label)).toEqual(["Trabalho", "Pessoal"]);
  const up = moveReserve([{ accountId: "work" }, { accountId: "gpt" }], "gpt", -1);
  expect(up.map((r) => r.accountId)).toEqual(["gpt", "work"]);
  // At either end it stays.
  expect(moveReserve(up, "gpt", -1)).toBe(up);
  expect(moveReserve(up, "work", 1)).toBe(up);
  expect(removeReserve(up, "gpt").map((r) => r.accountId)).toEqual(["work"]);
  expect(sameReserves(up, [{ accountId: "gpt" }, { accountId: "work" }])).toBe(true);
  expect(sameReserves(up, [{ accountId: "work" }, { accountId: "gpt" }])).toBe(false);
  expect(sameReserves([{ accountId: "gpt", model: "opus" }], [{ accountId: "gpt" }])).toBe(false);
});

test("offered on a plan brain with accounts to choose, never on a key, an older server or the team's right hand", () => {
  expect(offersReserves(view(), "u1")).toBe(true);
  expect(offersReserves(view({ brain: "model" }), "u1")).toBe(false);
  expect(offersReserves(view({ fallbackChain: undefined }), "u1")).toBe(false);
  expect(offersReserves(view({ accountsSupported: false }), "u1")).toBe(false);
  expect(offersReserves(view({ scope: "workspace" }), "u1")).toBe(false);
  expect(offersReserves(view({ accounts: [account("main", "Principal")] }), "u1")).toBe(false);
  // One already chosen stays editable even with nothing left to add.
  expect(
    offersReserves(
      view({ accounts: [account("main", "P"), account("w", "T")], fallbackChain: [{ accountId: "w" }] }),
      "u1",
    ),
  ).toBe(true);
});

test("only accounts the server takes: the agent's owner's, or someone's that serves everyone, never one kept to its owner", () => {
  // An admin edits Walter's agent: Bia's plan kept to herself is listed on the computer but can't be a reserve.
  const bias = { ...account("bia", "Bia"), ownerId: "u2", ownerName: "Bia", mine: false, serves: "owner" as const };
  const team = {
    ...account("team", "Equipe"),
    ownerId: "u2",
    ownerName: "Bia",
    mine: false,
    serves: "everyone" as const,
  };
  const nobodys = {
    ...account("loose", "Solta"),
    ownerId: null,
    ownerName: null,
    mine: false,
    serves: "everyone" as const,
  };
  const v = view({ accounts: [account("main", "Principal"), bias, team, nobodys, account("work", "Trabalho")] });
  expect(reserveCandidates(v, [], "u1").map((a) => a.id)).toEqual(["team", "work"]);
  // An agent nobody owns takes only what serves everyone.
  expect(reserveCandidates(v, [], null).map((a) => a.id)).toEqual(["team"]);
  // Nothing it may take: not offered.
  expect(offersReserves(view({ accounts: [account("main", "Principal"), bias] }), "u1")).toBe(false);
});
