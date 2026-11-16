import { expect, test } from "bun:test";
import {
  dayOnePins,
  pinsOf,
  placePin,
  repinAgent,
  SIDEBAR_VIEW_DEFAULT,
  sortAgents,
  splitPinned,
  stepPin,
  togglePin,
  unpinAgents,
} from "../src/lib/sidebar-view";

const agent = (id: string, name: string, ownerUserId: string | null = null) => ({ id, name, ownerUserId });

test("day one pins my own agents, the most recently active first, then in the workspace's order, five at most", () => {
  const agents = [
    agent("a", "Ada", "me"),
    agent("b", "Bia", "me"),
    agent("c", "Caio", "other"),
    ...["d", "e", "f", "g"].map((id) => agent(id, id.toUpperCase(), "me")),
  ];
  expect(dayOnePins(agents, "me", new Map([["b", "2026-11-03T10:00:00Z"]]))).toEqual(["b", "a", "d", "e", "f"]);
  expect(dayOnePins(agents, "nobody")).toEqual([]);
  // A template team as it was made: its template's order, the one the onboarding and the team's hello show.
  const team = [agent("iara", "Iara", "me"), agent("otto", "Otto", "me"), agent("lia", "Lia", "me")];
  expect(dayOnePins(team, "me")).toEqual(["iara", "otto", "lia"]);
});

test("day one never pins an agent in a group: its group keeps it whatever its DM's activity", () => {
  const agents = [agent("a", "Ada", "me"), agent("b", "Bia", "me"), agent("c", "Caio", "me")];
  const groups = [
    { id: "g1", name: "Vendas", agentIds: ["a"] },
    { id: "g2", name: "Suporte", agentIds: ["b"] },
  ];
  const active = new Map([
    ["a", "2026-11-03T10:00:00Z"],
    ["b", "2026-11-03T11:00:00Z"],
  ]);
  expect(dayOnePins(agents, "me", active, groups)).toEqual(["c"]);
});

test("saved pins win over day one's; pinning puts it first, a sixth is refused, unpinning takes it off", () => {
  expect(pinsOf(SIDEBAR_VIEW_DEFAULT, ["a"])).toEqual({ agents: ["a"], channels: [], people: [] });
  const saved = { ...SIDEBAR_VIEW_DEFAULT, pins: { agents: [], channels: ["1", "2", "3", "4"], people: [] } };
  expect(pinsOf(saved, ["a"]).agents).toEqual([]);
  // First, where the person looks: at the end of the pinned rows, the row next to them hardly moved.
  const five = togglePin(saved.pins, "channels", "5");
  expect(five?.channels).toEqual(["5", "1", "2", "3", "4"]);
  expect(five && togglePin(five, "channels", "6")).toBeNull();
  expect(five && togglePin(five, "channels", "2")?.channels).toEqual(["5", "1", "3", "4"]);
});

test("a pin of something gone (a deleted agent, a channel I left) holds no place once its list is known", () => {
  const saved = { ...SIDEBAR_VIEW_DEFAULT, pins: { agents: ["a", "gone"], channels: ["x"], people: ["p"] } };
  expect(pinsOf(saved, [], { agents: ["a", "b"], people: ["q"] })).toEqual({
    agents: ["a"],
    channels: ["x"],
    people: [],
  });
  // A list still loading (missing, or empty) keeps its pins.
  expect(pinsOf(saved, [], { agents: [], channels: undefined })).toEqual(saved.pins);
});

test("a section's pinned rows lead it, in the pins' order; the rest keep theirs", () => {
  expect(splitPinned(["a", "b", "c", "d"], ["c", "z", "a"], (x) => x)).toEqual({ top: ["c", "a"], rest: ["b", "d"] });
});

test("a group's order: the workspace's, mine first or working first, each keeping the rest in place", () => {
  const list = [agent("a", "Ada"), agent("b", "Bia", "me"), agent("c", "Caio"), agent("d", "Dario", "me")];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  expect(ids(sortAgents(list, "workspace", "me"))).toEqual(["a", "b", "c", "d"]);
  expect(ids(sortAgents(list, "mine", "me"))).toEqual(["b", "d", "a", "c"]);
  expect(ids(sortAgents(list, "working", "me", new Set(["c"])))).toEqual(["c", "a", "b", "d"]);
});

test("an agent put in a group by hand leaves the pins (it lands where it was dropped); Desfazer pins it back in its place", () => {
  const view = { ...SIDEBAR_VIEW_DEFAULT, pins: { agents: ["a", "b", "c"], channels: ["x"], people: [] } };
  expect(unpinAgents(view, ["b"])).toEqual({ ...view, pins: { agents: ["a", "c"], channels: ["x"], people: [] } });
  // Nothing pinned to take off, or day one (no saved pins): nothing to save.
  expect(unpinAgents(view, ["z"])).toBeNull();
  expect(unpinAgents(SIDEBAR_VIEW_DEFAULT, ["a"])).toBeNull();
  const off = unpinAgents(view, ["b"]) ?? view;
  expect(repinAgent(off, "b", 1).pins?.agents).toEqual(["a", "b", "c"]);
  // Already pinned again, or five pinned meanwhile: as it is.
  expect(repinAgent(view, "b", 0)).toBe(view);
  const full = { ...view, pins: { ...view.pins, agents: ["a", "c", "d", "e", "f"] } };
  expect(repinAgent(full, "b", 1)).toBe(full);
});

test("a pinned row moves one place up or down among the pinned rows shown with it; the other pins stay put", () => {
  const pins = { agents: ["a", "x", "b", "y", "c"], channels: ["1", "2", "3"], people: [] };
  expect(stepPin(pins, "channels", "2", -1)?.channels).toEqual(["2", "1", "3"]);
  expect(stepPin(pins, "channels", "2", 1)?.channels).toEqual(["1", "3", "2"]);
  // At either end, or not pinned: nowhere to go.
  expect(stepPin(pins, "channels", "1", -1)).toBeNull();
  expect(stepPin(pins, "channels", "3", 1)).toBeNull();
  expect(stepPin(pins, "channels", "9", 1)).toBeNull();
  // An agent moves among its own setor's pinned agents (a, b and c here), past the other setor's x and y.
  const moved = stepPin(pins, "agents", "c", -1, ["a", "b", "c"]);
  expect(moved?.agents).toEqual(["a", "x", "c", "y", "b"]);
  expect(moved && splitPinned(["a", "b", "c"], moved.agents, (id) => id).top).toEqual(["a", "c", "b"]);
  expect(moved?.channels).toEqual(pins.channels);
});

test("a dragged pinned row lands before another pinned row, or last; dropped where it was, nothing to save", () => {
  const pins = { agents: [], channels: ["1", "2", "3", "4"], people: ["p", "q"] };
  expect(placePin(pins, "channels", "4", "2")?.channels).toEqual(["1", "4", "2", "3"]);
  expect(placePin(pins, "channels", "1", null)?.channels).toEqual(["2", "3", "4", "1"]);
  expect(placePin(pins, "people", "q", "p")?.people).toEqual(["q", "p"]);
  expect(placePin(pins, "channels", "2", "3")).toBeNull();
  expect(placePin(pins, "channels", "2", "2")).toBeNull();
  expect(placePin(pins, "channels", "4", null)).toBeNull();
  // Not pinned, or before a row that isn't: nothing moves.
  expect(placePin(pins, "channels", "9", "1")).toBeNull();
  expect(placePin(pins, "channels", "1", "9")).toBeNull();
});
