import { expect, test } from "bun:test";
import {
  CALL_IDLE_MS,
  CALL_LEVEL_MS,
  CALL_QUIET_MS,
  heardSpeech,
  listenAgain,
  turnEnded,
} from "../src/components/call-turn";

/** A voice call's turn ends on silence (ADR 0198): only after speech, never on a room's hum or a click. */

const ms = (n: number) => Math.ceil(n / CALL_LEVEL_MS);
const levels = (...parts: [level: number, durationMs: number][]) =>
  parts.flatMap(([level, duration]) => Array<number>(ms(duration)).fill(level));

test("speech then a long enough quiet ends the turn", () => {
  expect(turnEnded(levels([0.02, 500], [0.4, 900], [0.03, CALL_QUIET_MS]))).toBe(true);
  expect(turnEnded(levels([0.02, 500], [0.4, 900], [0.03, CALL_QUIET_MS - 200]))).toBe(false);
});

test("a pause shorter than the quiet doesn't end it, and still talking never does", () => {
  expect(turnEnded(levels([0.4, 900], [0.03, 600], [0.5, 400]))).toBe(false);
  expect(turnEnded(levels([0.4, 5000]))).toBe(false);
});

test("silence, a hum or a click alone never counts as having spoken", () => {
  expect(heardSpeech(levels([0.03, 10_000]))).toBe(false);
  expect(turnEnded(levels([0.03, 10_000]))).toBe(false);
  expect(heardSpeech(levels([0.03, 1000], [0.9, 90], [0.03, 3000]))).toBe(false);
  expect(turnEnded(levels([0.03, 1000], [0.9, 90], [0.03, 3000]))).toBe(false);
  expect(heardSpeech(levels([0.03, 1000], [0.3, 300]))).toBe(true);
});

test("clicks spread over a while are not speech: a voice holds for a stretch", () => {
  const clicks = Array.from({ length: 10 }, () => levels([0.03, 400], [0.9, 90])).flat();
  expect(heardSpeech(clicks)).toBe(false);
  expect(turnEnded([...clicks, ...levels([0.03, CALL_QUIET_MS])])).toBe(false);
});

test("a take with no speech for a while starts again, so silence before speaking isn't sent", () => {
  const quiet = levels([0.03, CALL_IDLE_MS]);
  expect(listenAgain(quiet, CALL_IDLE_MS - 1)).toBe(false);
  expect(listenAgain(quiet, CALL_IDLE_MS)).toBe(true);
  expect(listenAgain(levels([0.4, 600], [0.03, CALL_IDLE_MS]), CALL_IDLE_MS + 600)).toBe(false);
});
