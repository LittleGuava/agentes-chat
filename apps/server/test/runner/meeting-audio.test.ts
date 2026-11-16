import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { decodeMeetingPiece, MEETING_AUDIO, parseMeetingEnd } from "@agenteschat/adapters/machine-protocol";
import { handleRequest, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import {
  MeetingAudio,
  type MeetingAudioDeps,
  meetingSinkName,
  PieceCutter,
  type Recorder,
  wavOf,
} from "../../runner/meeting-audio";
import type { DataListener, DataSocket } from "../../runner/streams";

/** ADR 0199 §4: the computer hears only the agent's own browser, cut at pauses, and says why it stopped. */

const RATE = MEETING_AUDIO.sampleRate;
/** `ms` of 16-bit mono samples at `level` (0 is silence). */
const pcm = (ms: number, level: number) => {
  const samples = Math.round((RATE * ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, i % 2 === 0 ? level : -level, true);
  return out;
};
const LOUD = 4000;

describe("cutting the audio into pieces", () => {
  test("a piece ends at a pause once it is long enough, and silence alone is no piece", () => {
    const cut = new PieceCutter();
    expect(cut.push(pcm(3000, LOUD))).toEqual([]);
    // A pause before the piece is long enough doesn't cut it.
    expect(cut.push(pcm(700, 0))).toEqual([]);
    expect(cut.push(pcm(3000, LOUD))).toEqual([]);
    const [piece, ...more] = cut.push(pcm(700, 0));
    expect(more).toEqual([]);
    expect(piece?.startMs).toBe(0);
    expect(piece?.ms).toBeGreaterThanOrEqual(6700);
    expect(piece?.ms).toBeLessThan(7500);
    expect(cut.push(pcm(20_000, 0))).toEqual([]);
    expect(cut.quietMs).toBeGreaterThanOrEqual(20_000);
  });

  test("talk with no pause is cut at the longest piece, and the rest comes out at the end", () => {
    const cut = new PieceCutter();
    const pieces = cut.push(pcm(40_000, LOUD));
    expect(pieces.map((p) => p.ms)).toEqual([MEETING_AUDIO.pieceMaxMs]);
    expect(cut.quietMs).toBe(0);
    const rest = cut.flush();
    expect(rest?.startMs).toBe(MEETING_AUDIO.pieceMaxMs);
    expect(rest?.ms).toBe(10_000);
    expect(cut.flush()).toBeNull();
  });

  test("a piece is a WAV a speech engine reads: 16 kHz mono 16-bit", () => {
    const wav = wavOf(pcm(1000, LOUD));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(RATE * 2);
    expect(wav.byteLength).toBe(44 + RATE * 2);
  });
});

/** A fake computer: pactl's calls, the agent's Chrome and its children, one other app playing sound. */
function fakeComputer(opts: { chromePid?: number | null; failLoad?: boolean } = {}) {
  const calls: string[][] = [];
  const sent: (string | Uint8Array)[] = [];
  let closed: { code?: number } | null = null;
  let listener: DataListener | null = null;
  const socket: DataSocket = {
    send: (d) => void sent.push(d),
    close: (code) => {
      closed = { code };
      listener?.closed();
    },
    bufferedAmount: 0,
    listen: (on) => {
      listener = on;
    },
  };
  let recorder: { source: string; data?: (b: Uint8Array) => void; exit?: () => void; stopped: boolean } | null = null;
  const parents: Record<number, number> = { 5001: 5000, 5000: 4242, 4242: 1, 7001: 7000, 7000: 1 };
  const deps: MeetingAudioDeps = {
    platform: "linux",
    which: () => "/usr/bin/x",
    pactl: async (args) => {
      calls.push(args);
      if (args[0] === "load-module") {
        if (opts.failLoad) throw new Error("Connection refused");
        return "536870913\n";
      }
      if (args[0] === "list" && args[1] === "sink-inputs") {
        return [
          "Sink Input #11",
          "\tDriver: protocol-native.c",
          "\tProperties:",
          '\t\tapplication.name = "Chromium"',
          '\t\tapplication.process.id = "5001"',
          "",
          "Sink Input #12",
          "\tProperties:",
          '\t\tapplication.name = "Spotify"',
          '\t\tapplication.process.id = "7001"',
        ].join("\n");
      }
      return "";
    },
    record: (source): Recorder => {
      recorder = { source, stopped: false };
      const r = recorder;
      return {
        onData: (cb) => {
          r.data = cb;
        },
        onExit: (cb) => {
          r.exit = cb;
        },
        stop: () => {
          r.stopped = true;
        },
      };
    },
    dial: async () => socket,
    chromePid: () => (opts.chromePid === undefined ? 4242 : opts.chromePid),
    parentOf: (pid) => parents[pid] ?? null,
    every: () => () => undefined,
  };
  return {
    deps,
    calls,
    sent,
    get closed() {
      return closed;
    },
    get recorder() {
      return recorder;
    },
    serverCloses: () => listener?.closed(),
  };
}

const STREAM = "s".repeat(43);

describe("hearing a meeting", () => {
  test("only the agent's own Chrome goes to a sink of its own, whose monitor is recorded", async () => {
    const pc = fakeComputer();
    const audio = new MeetingAudio(pc.deps);
    expect(await audio.listen("agent-1", "m1", STREAM)).toEqual({ listening: true });
    const sink = meetingSinkName("agent-1");
    expect(pc.calls[0]?.[0]).toBe("load-module");
    expect(pc.calls[0]).toContain("module-null-sink");
    expect(pc.calls[0]).toContain(`sink_name=${sink}`);
    expect(pc.recorder?.source).toBe(`${sink}.monitor`);
    const moves = pc.calls.filter((c) => c[0] === "move-sink-input");
    expect(moves).toEqual([["move-sink-input", "11", sink]]);
  });

  test("pieces go on the data socket in order; stop sends what is left, says why and unloads the sink", async () => {
    const pc = fakeComputer();
    const audio = new MeetingAudio(pc.deps);
    await audio.listen("agent-1", "m1", STREAM);
    pc.recorder?.data?.(pcm(6000, LOUD));
    pc.recorder?.data?.(pcm(800, 0));
    pc.recorder?.data?.(pcm(2000, LOUD));
    expect(await audio.stop("m1")).toEqual({ stopped: true });
    const pieces = pc.sent.filter((d): d is Uint8Array => typeof d !== "string").map((b) => decodeMeetingPiece(b));
    expect(pieces.map((p) => p?.seq)).toEqual([0, 1]);
    expect(pieces[0]?.startMs).toBe(0);
    expect(pieces[1]?.startMs).toBeGreaterThanOrEqual(6000);
    expect(new TextDecoder().decode(pieces[0]?.wav.subarray(0, 4))).toBe("RIFF");
    const last = pc.sent.at(-1);
    expect(typeof last === "string" ? parseMeetingEnd(last) : null).toEqual({ reason: "stopped" });
    expect(pc.closed?.code).toBe(1000);
    expect(pc.recorder?.stopped).toBe(true);
    expect(pc.calls.at(-1)).toEqual(["unload-module", "536870913"]);
    expect(await audio.stop("m1")).toEqual({ stopped: false });
  });

  test("ten minutes without a sound end the capture as silence", async () => {
    const pc = fakeComputer();
    const audio = new MeetingAudio(pc.deps);
    await audio.listen("agent-1", "m1", STREAM);
    pc.recorder?.data?.(pcm(MEETING_AUDIO.silenceEndMs + 1000, 0));
    await audio.settled();
    const last = pc.sent.at(-1);
    expect(typeof last === "string" ? parseMeetingEnd(last) : null).toEqual({ reason: "silence" });
    expect(pc.sent.some((d) => typeof d !== "string")).toBe(false);
    expect(await audio.stop("m1")).toEqual({ stopped: false });
  });

  test("the recorder dying ends it as failed; the server closing the socket ends it quietly", async () => {
    const pc = fakeComputer();
    const audio = new MeetingAudio(pc.deps);
    await audio.listen("agent-1", "m1", STREAM);
    pc.recorder?.exit?.();
    await audio.settled();
    const last = pc.sent.at(-1);
    expect(typeof last === "string" ? parseMeetingEnd(last) : null).toEqual({ reason: "failed" });

    const pc2 = fakeComputer();
    const audio2 = new MeetingAudio(pc2.deps);
    await audio2.listen("agent-1", "m2", STREAM);
    pc2.serverCloses();
    await audio2.settled();
    expect(pc2.recorder?.stopped).toBe(true);
    expect(pc2.calls.at(-1)).toEqual(["unload-module", "536870913"]);
  });

  test("no Chrome, or no sound server, is a refusal that leaves nothing behind", async () => {
    const none = fakeComputer({ chromePid: null });
    await expect(new MeetingAudio(none.deps).listen("agent-1", "m1", STREAM)).rejects.toMatchObject({
      code: "browser_closed",
    });
    expect(none.calls).toEqual([]);
    const down = fakeComputer({ failLoad: true });
    await expect(new MeetingAudio(down.deps).listen("agent-1", "m1", STREAM)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(down.recorder).toBeNull();
  });

  test("what hello says: Linux with pactl and parecord only, and never in system mode yet", () => {
    const pc = fakeComputer();
    expect(new MeetingAudio(pc.deps).info()).toEqual({ available: true });
    expect(new MeetingAudio({ ...pc.deps, platform: "darwin" }).info()).toMatchObject({
      available: false,
      code: "meeting_audio_platform",
    });
    expect(new MeetingAudio({ ...pc.deps, which: () => null }).info()).toMatchObject({
      available: false,
      code: "meeting_audio_missing",
    });
    expect(new MeetingAudio({ ...pc.deps, system: true }).info()).toMatchObject({
      available: false,
      code: "meeting_audio_system_mode",
    });
  });
});

describe("the ops", () => {
  const scope: RequestScope = { signal: new AbortController().signal, output: () => undefined };

  test("they run in the process that holds the server's connection, and need the meeting audio", async () => {
    expect(OP_ROUTES["meeting.listen"]).toBe("machine");
    expect(OP_ROUTES["meeting.stop"]).toBe("machine");
    await expect(
      handleRequest(
        { workspace: tmpdir() } as never,
        { op: "meeting.listen", meetingId: "m1", streamId: STREAM, agent: { id: "agent-1", handle: "ada" } },
        scope,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("meeting.listen goes to the agent's own capture", async () => {
    const pc = fakeComputer();
    const meetingAudio = new MeetingAudio(pc.deps);
    const reply = await handleRequest(
      { workspace: tmpdir(), meetingAudio } as never,
      { op: "meeting.listen", meetingId: "m1", streamId: STREAM, agent: { id: "agent-1", handle: "ada" } },
      scope,
    );
    expect(reply).toEqual({ listening: true });
    expect(pc.recorder?.source).toBe(`${meetingSinkName("agent-1")}.monitor`);
  });
});
