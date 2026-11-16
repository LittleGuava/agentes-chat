import { expect, test } from "bun:test";
import { inOwnOrder, OWN_ORDER_DEFAULT, placeInOwnOrder, stepInOwnOrder } from "../src/lib/own-order";

const id = (x: string) => x;

test("off, or nothing saved: the section reads as everyone's", () => {
  expect(OWN_ORDER_DEFAULT).toEqual({ on: false, channels: [], people: [], agents: [] });
  expect(inOwnOrder(["a", "b", "c"], [], id)).toEqual(["a", "b", "c"]);
});

test("my order holds the places of the rows I ordered; a row I never ordered keeps its place in everyone's order", () => {
  // I put c before a; d is new (nobody ordered it for me), so it keeps its place in the common order.
  expect(inOwnOrder(["a", "b", "c", "d"], ["c", "a", "b"], id)).toEqual(["c", "a", "b", "d"]);
  expect(inOwnOrder(["d", "a", "b", "c"], ["c", "a", "b"], id)).toEqual(["d", "c", "a", "b"]);
  // An admin moves b to the top of everyone's order: my order of a, b and c still holds.
  expect(inOwnOrder(["b", "a", "c"], ["c", "a", "b"], id)).toEqual(["c", "a", "b"]);
  // A row gone from the section (left, archived, another category) holds no place.
  expect(inOwnOrder(["a", "c"], ["c", "gone", "a"], id)).toEqual(["c", "a"]);
});

test("a move keeps the whole section as I see it, so the first move and a move past a new row both show", () => {
  // Nothing saved yet: c moved before a.
  const first = placeInOwnOrder([], ["a", "b", "c"], "c", "a");
  expect(first).toEqual(["c", "a", "b"]);
  expect(first && inOwnOrder(["a", "b", "c"], first, id)).toEqual(["c", "a", "b"]);
  // d, new, sits last as everyone sees it: moving it up past b takes it there for me.
  const shown = inOwnOrder(["a", "b", "c", "d"], ["c", "a", "b"], id);
  const moved = stepInOwnOrder(["c", "a", "b"], shown, "d", -1);
  expect(moved && inOwnOrder(["a", "b", "c", "d"], moved, id)).toEqual(["c", "a", "d", "b"]);
  // Other sections' rows in my order stay as they were.
  expect(placeInOwnOrder(["x", "a", "y"], ["a", "b"], "b", "a")).toEqual(["x", "y", "b", "a"]);
  expect(placeInOwnOrder(["x", "y"], ["a", "b"], "a", null)).toEqual(["x", "y", "b", "a"]);
});

test("nowhere to go: the ends, a row not in the section, or dropped where it was", () => {
  expect(stepInOwnOrder([], ["a", "b"], "a", -1)).toBeNull();
  expect(stepInOwnOrder([], ["a", "b"], "b", 1)).toBeNull();
  expect(stepInOwnOrder([], ["a", "b"], "z", 1)).toBeNull();
  expect(placeInOwnOrder([], ["a", "b"], "a", "b")).toBeNull();
  expect(placeInOwnOrder([], ["a", "b"], "b", null)).toBeNull();
  expect(placeInOwnOrder([], ["a", "b"], "a", "z")).toBeNull();
});
