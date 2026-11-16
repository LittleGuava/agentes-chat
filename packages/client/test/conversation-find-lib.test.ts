import { describe, expect, test } from "bun:test";
import type { SearchHit } from "../src/api/types";
import {
  FIND_LIMIT,
  type FindKey,
  findFilters,
  findIdsIn,
  findPosition,
  isFindShortcut,
  stepFind,
} from "../src/lib/conversation-find";

const hit = (id: string, at: string, patch: Partial<SearchHit> = {}): SearchHit => ({
  kind: "message",
  sourceId: id,
  channelIds: ["c1"],
  title: "Ana",
  snippet: "zebra",
  score: 1,
  createdAt: at,
  messageId: id,
  threadId: null,
  ...patch,
});

const key = (patch: Partial<FindKey>): FindKey => ({
  key: "f",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("the find's shortcut", () => {
  test("Ctrl+F and ⌘F, in either case, and nothing else", () => {
    expect(isFindShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key({ metaKey: true, key: "F" }))).toBe(true);
    expect(isFindShortcut(key({}))).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true, key: "g" }))).toBe(false);
  });
});

describe("what the find asks the server", () => {
  test("words search this conversation's channel, newest first", () => {
    expect(findFilters("c1", "  zebra ")).toEqual({ in: ["c1"], sort: "newest" });
  });
  test("no words, no search: a filter alone would list the channel's latest messages", () => {
    expect(findFilters("c1", "   ")).toBeUndefined();
  });
});

describe("the hits in this conversation", () => {
  const hits = [
    hit("old", "2026-11-01T10:00:00.000Z"),
    hit("new", "2026-11-03T10:00:00.000Z"),
    hit("root", "2026-11-02T10:00:00.000Z", { threadId: "root" }),
    hit("reply", "2026-11-02T11:00:00.000Z", { threadId: "root" }),
    hit("other-reply", "2026-11-02T12:00:00.000Z", { threadId: "elsewhere" }),
    hit("gone", "2026-11-04T10:00:00.000Z", { messageId: null }),
    hit("dm", "2026-11-05T10:00:00.000Z", { channelIds: ["c2"] }),
    { ...hit("ctx", "2026-11-06T10:00:00.000Z"), kind: "context_item" as const },
  ];

  test("a channel's are its main timeline's, newest first: a thread's replies aren't rows there", () => {
    expect(findIdsIn(hits, { channelId: "c1" })).toEqual(["new", "root", "old"]);
  });

  test("a thread's are its root and its replies, newest first", () => {
    expect(findIdsIn(hits, { channelId: "c1", threadId: "root" })).toEqual(["reply", "root"]);
  });

  test("a message found twice is one stop", () => {
    expect(findIdsIn([...hits, hit("new", "2026-11-03T10:00:00.000Z")], { channelId: "c1" })).toEqual([
      "new",
      "root",
      "old",
    ]);
  });
});

describe("stepping through the hits", () => {
  const ids = ["new", "mid", "old"];
  test("older goes up the conversation, newer comes back down, both wrap around", () => {
    expect(stepFind(ids, "new", "older")).toBe("mid");
    expect(stepFind(ids, "old", "older")).toBe("new");
    expect(stepFind(ids, "mid", "newer")).toBe("new");
    expect(stepFind(ids, "new", "newer")).toBe("old");
  });
  test("from nowhere (or a hit gone since) it starts at the newest", () => {
    expect(stepFind(ids, null, "older")).toBe("new");
    expect(stepFind(ids, "vanished", "newer")).toBe("new");
  });
  test("nothing found, nowhere to go", () => {
    expect(stepFind([], null, "older")).toBeNull();
  });
});

describe("where the find stands", () => {
  test("its place among the hits, counted from the newest", () => {
    expect(findPosition(["a", "b", "c"], "b", 3)).toEqual({ at: 2, total: 3, more: false });
    expect(findPosition(["a", "b", "c"], null, 3)).toEqual({ at: 0, total: 3, more: false });
  });
  test("a full page from the server means there may be more than it shows", () => {
    expect(findPosition(["a"], "a", FIND_LIMIT)).toEqual({ at: 1, total: 1, more: true });
  });
});
