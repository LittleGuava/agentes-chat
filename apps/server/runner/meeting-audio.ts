import { readFileSync } from "node:fs";
import {
  encodeMeetingPiece,
  MEETING_AUDIO,
  type MeetingEndReason,
  type RunnerMeetingAudioInfo,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import type { DataSocket } from "./streams";

/** Samples in a 20 ms frame: what the cutter judges loud or quiet at a time. */
const FRAME_MS = 20;
const FRAME_BYTES = ((MEETING_AUDIO.sampleRate * FRAME_MS) / 1000) * 2;
/** A frame whose loudest sample passes this (about -36 dBFS) has sound in it. */
const LOUD = 500;

export interface MeetingPiece {
  startMs: number;
  ms: number;
  pcm: Uint8Array;
}

/**
 * Cuts a meeting's audio (16 kHz mono 16-bit, `MEETING_AUDIO`) into pieces (ADR 0199 §4): a piece ends at a pause
 * once it is `pieceMinMs` long, or at `pieceMaxMs` whatever is said; a piece with no sound in it is dropped, so a
 * lobby or a silent call sends nothing. `quietMs` is how long it has heard nothing.
 */
export class PieceCutter {
  private rest = new Uint8Array(0);
  private frames: Uint8Array[] = [];
  private startMs = 0;
  private atMs = 0;
  private quietRun = 0;
  private sound = false;
  private lastSoundMs = 0;

  /** How long the audio has had no sound, up to now. */
  get quietMs() {
    return this.atMs - this.lastSoundMs;
  }

  /** How much audio it has heard. */
  get heardMs() {
    return this.atMs;
  }

  push(bytes: Uint8Array): MeetingPiece[] {
    const all = new Uint8Array(this.rest.byteLength + bytes.byteLength);
    all.set(this.rest);
    all.set(bytes, this.rest.byteLength);
    const pieces: MeetingPiece[] = [];
    let at = 0;
    for (; at + FRAME_BYTES <= all.byteLength; at += FRAME_BYTES) {
      const frame = all.slice(at, at + FRAME_BYTES);
      const loud = peak(frame) > LOUD;
      this.frames.push(frame);
      this.atMs += FRAME_MS;
      if (loud) {
        this.sound = true;
        this.quietRun = 0;
        this.lastSoundMs = this.atMs;
      } else this.quietRun += FRAME_MS;
      const ms = this.atMs - this.startMs;
      if (
        ms >= MEETING_AUDIO.pieceMaxMs ||
        (ms >= MEETING_AUDIO.pieceMinMs && this.quietRun >= MEETING_AUDIO.pauseMs)
      ) {
        const piece = this.take();
        if (piece) pieces.push(piece);
      }
    }
    this.rest = all.slice(at);
    return pieces;
  }

  /** What is left as a last piece (null when it holds no sound). */
  flush(): MeetingPiece | null {
    return this.take();
  }

  private take(): MeetingPiece | null {
    const { frames, sound, startMs } = this;
    const ms = this.atMs - startMs;
    this.frames = [];
    this.startMs = this.atMs;
    this.sound = false;
    this.quietRun = 0;
    if (!sound || frames.length === 0) return null;
    const pcm = new Uint8Array(frames.length * FRAME_BYTES);
    frames.forEach((f, i) => {
      pcm.set(f, i * FRAME_BYTES);
    });
    return { startMs, ms, pcm };
  }
}

function peak(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let max = 0;
  for (let i = 0; i + 1 < frame.byteLength; i += 2) max = Math.max(max, Math.abs(view.getInt16(i, true)));
  return max;
}

/** 16-bit mono PCM as a WAV file at `MEETING_AUDIO.sampleRate`. */
export function wavOf(pcm: Uint8Array): Uint8Array {
  const rate = MEETING_AUDIO.sampleRate;
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, MEETING_AUDIO.channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2 * MEETING_AUDIO.channels, true);
  v.setUint16(32, 2 * MEETING_AUDIO.channels, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** The null sink an agent's meeting plays into: only that agent's Chrome is moved there. */
export const meetingSinkName = (agentId: string) => `agentes_meeting_${agentId.replace(/[^A-Za-z0-9]/g, "")}`;

/** The recorder of a sink's monitor: raw 16 kHz mono 16-bit PCM, as it comes. */
export interface Recorder {
  onData(cb: (bytes: Uint8Array) => void): void;
  /** It stopped by itself (not through `stop`). */
  onExit(cb: () => void): void;
  stop(): void;
}

export interface MeetingAudioDeps {
  platform?: NodeJS.Platform;
  /** System mode (ADR 0058 §10): each agent's Chrome is its own user's, whose sound server root doesn't reach. */
  system?: boolean;
  which?: (cmd: string) => string | null;
  /** Runs `pactl` and resolves its output; rejects when it fails. */
  pactl?: (args: string[]) => Promise<string>;
  record?: (source: string) => Recorder;
  /** Dials the data socket the server named (`DataSockets.dial`). */
  dial(streamId: string): Promise<DataSocket>;
  /** The agent's Chrome while it runs (`BrowserManager.chromePid`). */
  chromePid(agentId: string): number | null;
  parentOf?: (pid: number) => number | null;
  /** Calls `fn` every `ms` until the returned stop. */
  every?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

interface Capture {
  agentId: string;
  meetingId: string;
  sink: string;
  module: string;
  socket: DataSocket;
  recorder: Recorder;
  cutter: PieceCutter;
  seq: number;
  moved: Set<string>;
  stopMoving: () => void;
  /** Set as it starts ending, before anything it does can call back into it. */
  ending: boolean;
  ended: Promise<void> | null;
}

/** How often Chrome's new sounds (a tab's audio starts when the call does) are looked for and moved. */
const MOVE_EVERY_MS = 2000;
/** Bytes left unsent on the data socket past which a piece waits out (the server is slow): it is dropped. */
const BUFFERED_MAX = 8 << 20;

const UNAVAILABLE = {
  platform: {
    available: false,
    code: "meeting_audio_platform",
    reason: "Hearing meetings needs a Linux computer.",
  },
  missing: {
    available: false,
    code: "meeting_audio_missing",
    reason: "Hearing meetings needs PulseAudio or PipeWire's pulse server, with pactl and parecord installed.",
  },
  system: {
    available: false,
    code: "meeting_audio_system_mode",
    reason: "Hearing meetings doesn't work yet on a computer where each agent runs as its own user.",
  },
} satisfies Record<string, RunnerMeetingAudioInfo>;

/**
 * Hears the meetings agents' browsers are in (ADR 0199 §4, protocol 79): for each, a null sink of the agent's own,
 * that agent's Chrome's sounds moved there (looked for every few seconds by its process tree, never another app's,
 * never a microphone), the sink's monitor recorded, cut at pauses (`PieceCutter`) and sent on the data socket the
 * server named. It ends on `stop`, after ten minutes without a sound, at four hours, or when the recorder dies; its
 * last text frame says which, then the sink goes (Chrome's sounds go back where they were).
 */
export class MeetingAudio {
  private readonly captures = new Map<string, Capture>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: MeetingAudioDeps) {}

  info(): RunnerMeetingAudioInfo {
    if ((this.deps.platform ?? process.platform) !== "linux") return UNAVAILABLE.platform;
    if (this.deps.system) return UNAVAILABLE.system;
    const which = this.deps.which ?? ((cmd: string) => Bun.which(cmd));
    if (!which("pactl") || !which("parecord")) return UNAVAILABLE.missing;
    return { available: true };
  }

  /** `meeting.listen`: the agent's earlier capture, if any, ends first (one meeting per agent). */
  async listen(agentId: string, meetingId: string, streamId: string): Promise<{ listening: true }> {
    const info = this.info();
    if (!info.available) throw new RunnerError("unsupported", info.reason ?? "Hearing meetings isn't available here.");
    if (this.deps.chromePid(agentId) === null) {
      throw new RunnerError("browser_closed", "The agent's browser isn't open: it isn't in a meeting to hear.");
    }
    for (const c of this.captures.values()) if (c.agentId === agentId) await this.end(c, "stopped");
    const pactl = this.deps.pactl ?? runPactl;
    const sink = meetingSinkName(agentId);
    let module: string;
    try {
      module = (
        await pactl([
          "load-module",
          "module-null-sink",
          `sink_name=${sink}`,
          "sink_properties=device.description=agentes-meeting",
        ])
      ).trim();
    } catch (err) {
      throw new RunnerError(
        "unsupported",
        `The computer's sound server didn't take a sink for the meeting: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let socket: DataSocket;
    try {
      socket = await this.deps.dial(streamId);
    } catch (err) {
      await pactl(["unload-module", module]).catch(() => undefined);
      throw err;
    }
    const recorder = (this.deps.record ?? spawnRecorder)(`${sink}.monitor`);
    const capture: Capture = {
      agentId,
      meetingId,
      sink,
      module,
      socket,
      recorder,
      cutter: new PieceCutter(),
      seq: 0,
      moved: new Set(),
      stopMoving: () => undefined,
      ending: false,
      ended: null,
    };
    this.captures.set(meetingId, capture);
    socket.listen({
      bytes: () => undefined,
      closed: () => this.track(this.end(capture, null)),
    });
    recorder.onData((bytes) => this.heard(capture, bytes));
    recorder.onExit(() => this.track(this.end(capture, "failed")));
    await this.move(capture);
    capture.stopMoving = (this.deps.every ?? every)(() => this.track(this.move(capture)), MOVE_EVERY_MS);
    this.deps.log?.(`meeting audio: listening for agent ${agentId}`);
    return { listening: true };
  }

  /** `meeting.stop`: what was heard goes, then `meeting.end`. */
  async stop(meetingId: string): Promise<{ stopped: boolean }> {
    const capture = this.captures.get(meetingId);
    if (!capture) return { stopped: false };
    await this.end(capture, "stopped");
    return { stopped: true };
  }

  /** The runner stops, or the server connection ended for good. */
  async stopAll() {
    await Promise.all([...this.captures.values()].map((c) => this.end(c, "stopped")));
  }

  /** Tests: whatever ended on its own has finished ending. */
  async settled() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private track(p: Promise<void>) {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private heard(capture: Capture, bytes: Uint8Array) {
    if (capture.ending) return;
    for (const piece of capture.cutter.push(bytes)) this.send(capture, piece);
    if (capture.cutter.quietMs >= MEETING_AUDIO.silenceEndMs) this.track(this.end(capture, "silence"));
    else if (capture.cutter.heardMs >= MEETING_AUDIO.maxMs) this.track(this.end(capture, "max"));
  }

  private send(capture: Capture, piece: MeetingPiece) {
    const seq = capture.seq++;
    if (capture.socket.bufferedAmount > BUFFERED_MAX) {
      this.deps.log?.(`meeting audio: piece ${seq} dropped, the server isn't taking them`);
      return;
    }
    capture.socket.send(encodeMeetingPiece({ seq, startMs: piece.startMs, ms: piece.ms }, wavOf(piece.pcm)));
  }

  /** `reason` null: the server closed the socket, so nothing more is said on it. */
  private end(capture: Capture, reason: MeetingEndReason | null): Promise<void> {
    if (capture.ended) return capture.ended;
    if (capture.ending) return Promise.resolve();
    capture.ending = true;
    capture.ended = (async () => {
      this.captures.delete(capture.meetingId);
      capture.stopMoving();
      capture.recorder.stop();
      if (reason) {
        const last = capture.cutter.flush();
        if (last) this.send(capture, last);
        capture.socket.send(JSON.stringify({ type: "meeting.end", reason }));
        capture.socket.close(STREAM_CLOSE.normal, reason);
      }
      await (this.deps.pactl ?? runPactl)(["unload-module", capture.module]).catch(() => undefined);
      this.deps.log?.(`meeting audio: ended for agent ${capture.agentId} (${reason ?? "closed by the server"})`);
    })();
    return capture.ended;
  }

  /** Moves the agent's Chrome's sounds to its sink: a sink input whose process descends from that Chrome. */
  private async move(capture: Capture) {
    if (capture.ending) return;
    const chrome = this.deps.chromePid(capture.agentId);
    if (chrome === null) return;
    const pactl = this.deps.pactl ?? runPactl;
    const listed = await pactl(["list", "sink-inputs"]).catch(() => "");
    for (const input of sinkInputs(listed)) {
      if (capture.moved.has(input.id) || !this.descends(input.pid, chrome)) continue;
      try {
        await pactl(["move-sink-input", input.id, capture.sink]);
        capture.moved.add(input.id);
      } catch {
        // It went away meanwhile; the next look finds whatever replaced it.
      }
    }
  }

  private descends(pid: number, ancestor: number): boolean {
    const parentOf = this.deps.parentOf ?? procParent;
    let at: number | null = pid;
    for (let hops = 0; at !== null && at > 1 && hops < 32; hops++) {
      if (at === ancestor) return true;
      at = parentOf(at);
    }
    return false;
  }
}

/** `pactl list sink-inputs`: each input's index and the process that plays it. */
export function sinkInputs(text: string): { id: string; pid: number }[] {
  const out: { id: string; pid: number }[] = [];
  let id: string | null = null;
  for (const line of text.split("\n")) {
    const head = /^Sink Input #(\d+)/.exec(line);
    if (head) {
      id = head[1] ?? null;
      continue;
    }
    const pid = /application\.process\.id = "(\d+)"/.exec(line);
    if (id && pid) {
      out.push({ id, pid: Number(pid[1]) });
      id = null;
    }
  }
  return out;
}

function procParent(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (name) state ppid …`: the name may hold spaces and parentheses, so read after the last ")".
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

async function runPactl(args: string[]): Promise<string> {
  const proc = Bun.spawn(["pactl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim().slice(0, 300) || `pactl exited with ${code}`);
  return out;
}

function spawnRecorder(source: string): Recorder {
  const proc = Bun.spawn(
    [
      "parecord",
      "--raw",
      "--format=s16le",
      `--rate=${MEETING_AUDIO.sampleRate}`,
      `--channels=${MEETING_AUDIO.channels}`,
      `--device=${source}`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  let stopping = false;
  let onData: (bytes: Uint8Array) => void = () => undefined;
  let onExit: () => void = () => undefined;
  void (async () => {
    for await (const chunk of proc.stdout) onData(chunk);
  })().catch(() => undefined);
  void proc.exited.then(() => {
    if (!stopping) onExit();
  });
  return {
    onData: (cb) => {
      onData = cb;
    },
    onExit: (cb) => {
      onExit = cb;
    },
    stop: () => {
      stopping = true;
      proc.kill();
    },
  };
}

function every(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
