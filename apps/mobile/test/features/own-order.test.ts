import { describe, expect, test } from "bun:test";
import type { Channel } from "@agenteschat/client";
import { buildConversations, homeLayout } from "../../src/features/chats/logic";
import { at } from "./fixtures";

/**
 * "Usar a minha ordem" on the phone (ADR 0080, addendum of 2026-11-16): off, Conversas lists each section by latest
 * activity; on, in the person's order, a channel they never ordered keeping its place by activity.
 */

const channel = (id: string, minutesAgo: number, over: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  topic: "",
  visibility: "public",
  isMember: true,
  createdAt: at(1000),
  lastMessage: {
    id: `m-${id}`,
    authorType: "person",
    authorId: "u1",
    authorName: "Caio",
    preview: "oi",
    meta: null,
    createdAt: at(minutesAgo),
  },
  ...over,
});
const CATEGORIES = [{ id: "mkt", name: "Marketing", position: 0 }];
const NO_PINS = { agents: [], channels: [], people: [] };

describe("Conversas in my own order", () => {
  const rows = buildConversations({
    channels: [
      channel("a", 1),
      channel("b", 2),
      channel("c", 3),
      channel("novo", 4),
      channel("x", 1, { categoryId: "mkt" }),
      channel("y", 2, { categoryId: "mkt" }),
    ],
    dms: [],
    threads: [],
  });
  const keys = (blocks: ReturnType<typeof homeLayout>) => blocks.map((b) => [b.key, b.rows.map((r) => r.key)]);

  test("off (no order given): by latest activity, as before", () => {
    expect(keys(homeLayout(rows, CATEGORIES, undefined, [], NO_PINS))).toEqual([
      ["channels", ["c:a", "c:b", "c:c", "c:novo"]],
      ["category:mkt", ["c:x", "c:y"]],
    ]);
  });

  test("on: each section in my order, a channel I never ordered where activity puts it; each block says its order", () => {
    const own = { channels: ["c", "b", "a", "y", "x"], people: [], agents: [] };
    const blocks = homeLayout(rows, CATEGORIES, undefined, [], NO_PINS, own);
    expect(keys(blocks)).toEqual([
      ["channels", ["c:c", "c:b", "c:a", "c:novo"]],
      ["category:mkt", ["c:y", "c:x"]],
    ]);
    // What a long press moves among: the whole section, not only the rows the home shows.
    expect(blocks[0]?.order).toEqual(["c", "b", "a", "novo"]);
  });
});
