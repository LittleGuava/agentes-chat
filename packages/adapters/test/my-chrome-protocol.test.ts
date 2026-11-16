import { expect, test } from "bun:test";
import { MY_CHROME_PROTOCOL, parseRunnerFrame } from "../src/machine-protocol";

/** Who holds a person's lent Chrome, on the wire (ADR 0202): agent ids and expiry times only, nothing else believed. */

const AGENT = "0193f6b4-1111-7000-8000-000000000001";
const UNTIL = "2026-11-16T12:30:00.000Z";

test("hello says which agents hold the person's Chrome and until when; anything else is dropped", () => {
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "1.0.0",
      protocol: MY_CHROME_PROTOCOL,
      myChrome: [
        { agentId: AGENT, expiresAt: UNTIL, port: 9222, url: "https://bank.example" },
        { agentId: "not-an-id", expiresAt: UNTIL },
        { agentId: AGENT, expiresAt: "tomorrow" },
        "x",
      ],
    }),
  );
  expect(frame).toMatchObject({ type: "hello", myChrome: [{ agentId: AGENT, expiresAt: UNTIL }] });
  expect(JSON.stringify(frame)).not.toContain("9222");
  expect(JSON.stringify(frame)).not.toContain("bank.example");
});

test("an empty list in hello is kept: nothing is lent now", () => {
  const frame = parseRunnerFrame(
    JSON.stringify({ type: "hello", token: "agm_x", version: "1.0.0", protocol: MY_CHROME_PROTOCOL, myChrome: [] }),
  );
  expect(frame).toMatchObject({ type: "hello", myChrome: [] });
});

test("mychrome.changed carries the whole list", () => {
  expect(
    parseRunnerFrame(JSON.stringify({ type: "mychrome.changed", lent: [{ agentId: AGENT, expiresAt: UNTIL }] })),
  ).toEqual({ type: "mychrome.changed", lent: [{ agentId: AGENT, expiresAt: UNTIL }] });
  expect(parseRunnerFrame(JSON.stringify({ type: "mychrome.changed", lent: [] }))).toEqual({
    type: "mychrome.changed",
    lent: [],
  });
  expect(parseRunnerFrame(JSON.stringify({ type: "mychrome.changed" }))).toBeNull();
});
