import { expect, test } from "bun:test";
import {
  decodeMeetingPiece,
  encodeMeetingPiece,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  MEETING_AUDIO,
  MEETING_PROTOCOL,
  parseMeetingEnd,
  parseRunnerFrame,
  parseServerFrame,
} from "../src/machine-protocol";

/** Meeting audio on the wire (ADR 0199 §4, protocol 79): what the runner says it serves, the ops, the pieces. */

test("hello says whether the computer can hear a meeting, cut like the other availabilities", () => {
  expect(MEETING_PROTOCOL).toBe(79);
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(MEETING_PROTOCOL);
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "1.0.0",
      protocol: MEETING_PROTOCOL,
      meetingAudio: { available: false, reason: "x".repeat(5000), code: "meeting_audio_missing", extra: 1 },
    }),
  );
  expect(frame?.type === "hello" && frame.meetingAudio?.available).toBe(false);
  expect(frame?.type === "hello" && frame.meetingAudio?.code).toBe("meeting_audio_missing");
  expect(frame?.type === "hello" && (frame.meetingAudio?.reason?.length ?? 0) < 5000).toBe(true);
  expect(frame?.type === "hello" && "extra" in (frame.meetingAudio ?? {})).toBe(false);
});

test("the server's meeting ops reach a runner that knows them", () => {
  expect(MACHINE_OPS).toContain("meeting.listen");
  expect(MACHINE_OPS).toContain("meeting.stop");
  const frame = parseServerFrame(
    JSON.stringify({
      type: "request",
      id: "r1",
      op: "meeting.listen",
      meetingId: "m1",
      streamId: "s".repeat(43),
      agent: { id: "a", handle: "a" },
    }),
  );
  expect(frame).toMatchObject({ type: "request", op: "meeting.listen", meetingId: "m1" });
});

test("a piece is its header and its WAV, read back as they went", () => {
  const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const bytes = encodeMeetingPiece({ seq: 3, startMs: 61_500, ms: 4200 }, wav);
  const piece = decodeMeetingPiece(bytes);
  expect(piece).toEqual({ seq: 3, startMs: 61_500, ms: 4200, wav });
});

test("bytes that aren't a piece, or a piece too long or too big, are dropped", () => {
  expect(decodeMeetingPiece(new Uint8Array([9, 0, 0, 0, 2, 123, 125]))).toBeNull();
  expect(decodeMeetingPiece(new Uint8Array([1, 0, 0]))).toBeNull();
  const wav = new Uint8Array(8);
  expect(decodeMeetingPiece(encodeMeetingPiece({ seq: -1, startMs: 0, ms: 100 }, wav))).toBeNull();
  expect(
    decodeMeetingPiece(encodeMeetingPiece({ seq: 0, startMs: 0, ms: MEETING_AUDIO.pieceMaxMs + 1 }, wav)),
  ).toBeNull();
  const big = new Uint8Array(MEETING_AUDIO.pieceBytesMax + 1);
  expect(decodeMeetingPiece(encodeMeetingPiece({ seq: 0, startMs: 0, ms: 1000 }, big))).toBeNull();
});

test("the runner's last word says why the capture ended; anything else isn't one", () => {
  expect(parseMeetingEnd(JSON.stringify({ type: "meeting.end", reason: "silence" }))).toEqual({ reason: "silence" });
  expect(parseMeetingEnd(JSON.stringify({ type: "meeting.end", reason: "max" }))).toEqual({ reason: "max" });
  expect(parseMeetingEnd(JSON.stringify({ type: "meeting.end", reason: "whatever" }))).toBeNull();
  expect(parseMeetingEnd("{")).toBeNull();
});
