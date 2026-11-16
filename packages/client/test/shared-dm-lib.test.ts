import { describe, expect, test } from "bun:test";
import type { SharedDmLine } from "../src/api/types";
import { sharedDmOf, sharePlaceOf, shareReaders, shareTargetOf } from "../src/lib/shared-dm";

const line: SharedDmLine = {
  author: { type: "agent", id: "a1", name: "Dev" },
  at: "2026-11-15T10:00:00.000Z",
  body: "Done.",
};

describe("a shared DM's copy", () => {
  test("is read from the message's meta, skipping lines it can't draw", () => {
    const copy = sharedDmOf({
      sharedDm: { agent: { id: "a1", name: "Dev", handle: "dev" }, count: 2, omitted: 3, lines: [line, { body: 1 }] },
    });
    expect(copy).toEqual({ agent: { id: "a1", name: "Dev", handle: "dev" }, count: 2, omitted: 3, lines: [line] });
    expect(sharedDmOf({})).toBeNull();
    expect(sharedDmOf({ sharedDm: { lines: [line] } })).toBeNull();
    expect(sharedDmOf(null)).toBeNull();
  });

  test("goes to a channel or a person, the select's value and back", () => {
    expect(shareTargetOf(sharePlaceOf({ channelId: "c1" }))).toEqual({ channelId: "c1" });
    expect(shareTargetOf(sharePlaceOf({ userId: "u1" }))).toEqual({ userId: "u1" });
  });

  test("says who reads it there: administrators too in a private channel", () => {
    expect(shareReaders({ channel: { name: "ops", visibility: "public" } }).key).toBe("dmShare.readersChannel");
    expect(shareReaders({ channel: { name: "ops", visibility: "private" } }).key).toBe("dmShare.readersPrivate");
    expect(shareReaders({ person: { name: "Bia" } })).toEqual({
      key: "dmShare.readersPerson",
      params: { name: "Bia" },
    });
  });
});
