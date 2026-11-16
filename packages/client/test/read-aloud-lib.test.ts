import { describe, expect, test } from "bun:test";
import { readAloudOffered } from "../src/lib/read-aloud";

/** Which replies show "Ouvir" (ADR 0209): only an agent's, and only one with its own words to read. */
describe("readAloudOffered", () => {
  const agent = { type: "agent" as const, id: "a-1" };
  test("an agent's reply in its own words", () => {
    expect(readAloudOffered({ author: agent, body: "Os 401 caíram.", meta: {} })).toBe(true);
  });

  test("a person's message, a line the server wrote, a voice message or nothing written: no button", () => {
    expect(readAloudOffered({ author: { type: "person", id: "u-1" }, body: "Oi" })).toBe(false);
    expect(readAloudOffered({ author: agent, body: "I can't answer yet.", meta: { bodyCode: "no_ai" } })).toBe(false);
    expect(readAloudOffered({ author: agent, body: "", meta: { voice: { durationMs: 900 } } })).toBe(false);
    expect(readAloudOffered({ author: agent, body: "  " })).toBe(false);
  });

  test("a message still on its way has no audio yet", () => {
    expect(readAloudOffered({ author: agent, body: "Oi", local: "pending" })).toBe(false);
  });
});
