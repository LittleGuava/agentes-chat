import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { VIEWER_FACES, viewersShown } from "../src/lib/viewers";

const t = ((key: string, o?: Record<string, unknown>) => {
  if (key === "format.list") return ((o?.names ?? []) as string[]).join(", ");
  if (key === "notifications.namesMore") return `mais ${o?.count}`;
  if (key === "channel.viewers") return `Aqui agora: ${o?.names}`;
  return key;
}) as unknown as TFunction;

const NAMES: Record<string, string> = { a: "Ana", b: "Bruno", c: "Caio", d: "Duda", e: "Eva" };
const nameOf = (id: string) => NAMES[id];

test("nobody else there: no faces and no words", () => {
  expect(viewersShown([], nameOf, t)).toEqual({ faces: [], more: 0, label: "" });
});

test("one person: their face, their name in the tip", () => {
  expect(viewersShown(["b"], nameOf, t)).toEqual({
    faces: [{ id: "b", name: "Bruno" }],
    more: 0,
    label: "Aqui agora: Bruno",
  });
});

test("up to the faces' limit, in the order they opened it", () => {
  const shown = viewersShown(["c", "a", "b"], nameOf, t);
  expect(VIEWER_FACES).toBe(3);
  expect(shown.faces.map((f) => f.id)).toEqual(["c", "a", "b"]);
  expect(shown.more).toBe(0);
  expect(shown.label).toBe("Aqui agora: Caio, Ana, Bruno");
});

test("past the limit: the first faces, a count of the rest, every name in the tip", () => {
  const shown = viewersShown(["a", "b", "c", "d", "e"], nameOf, t);
  expect(shown.faces.map((f) => f.id)).toEqual(["a", "b", "c"]);
  expect(shown.more).toBe(2);
  expect(shown.label).toBe("Aqui agora: Ana, Bruno, Caio, Duda, Eva");
});

test("someone the app doesn't know yet (just joined, the people still loading) waits for the list", () => {
  const shown = viewersShown(["x", "a"], nameOf, t);
  expect(shown.faces).toEqual([{ id: "a", name: "Ana" }]);
  expect(shown.label).toBe("Aqui agora: Ana");
});

test("a long list says the first names in the tip and how many more", () => {
  const many = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const shown = viewersShown(many, (id) => id.toUpperCase(), t);
  expect(shown.more).toBe(9);
  expect(shown.label).toBe("Aqui agora: P0, P1, P2, P3, P4, P5, P6, P7, mais 4");
});
