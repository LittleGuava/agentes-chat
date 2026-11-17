import { type ApngImage, apngImage, changedBox, decodePng, encodeApng, type Pixels } from "./apng";
import type { ScreenSurface } from "./plan";

/**
 * A recording of a plan on a screen (ADR 0054 addendum 2026-11-15): a picture of the screen after each step, as one
 * animated PNG. Recording never changes the plan: a picture that fails is skipped, once a person has the screen
 * nothing more is looked at (only the person in control sees it, ADR 0040 §6), and nothing after a secret is typed
 * (a code in boxes that show it would be in the picture).
 */
export const RECORDING_LIMITS = {
  /** Frames at most: a plan has fewer steps, and dismissed banners or retries add a few. */
  frames: 40,
  /**
   * Bytes at most, under what one file write to the computer takes (`MAX_INLINE_FILE_BYTES`, 5 MB). A whole 1280×800
   * screen is about 0.5 MB; a step that changes part of it costs that part.
   */
  bytes: 4_500_000,
  /** The longest side of a frame: a 2560-wide screen comes down to 1280. */
  edge: 1280,
  /** How long a frame shows: the time to the next one, between these. */
  minMs: 500,
  maxMs: 3000,
  /** The last frame, before it plays again. */
  lastMs: 3000,
} as const;

export interface ScreenRecorderOptions {
  /** A picture of the screen now (JPEG or PNG), or null when there's none. */
  grab(): Promise<Uint8Array | null>;
  /** A person has the screen, or was asked to take it: nothing is looked at from then on. */
  held(): Promise<boolean>;
  /** Tests: the byte limit (`RECORDING_LIMITS.bytes`). */
  maxBytes?: number;
  now?: () => number;
}

export interface Recording {
  /** The APNG. */
  bytes: Uint8Array;
  frames: number;
  width: number;
  height: number;
}

/** Why a recording stopped before its plan did: a person took the screen, a secret was typed, or it's full. */
export type RecordingStop = "person" | "secret" | "full";

export interface ScreenRecorder {
  /** Adds the screen as it is now (the same screen as the last frame only shows that one longer). */
  frame(): Promise<void>;
  /** Takes no more pictures. */
  stop(why: RecordingStop): void;
  /** The animation, or null when no frame was taken. */
  finish(): Promise<Recording | null>;
  readonly skipped: number;
  readonly stopped: RecordingStop | null;
}

/** The surface, with a frame taken after each action that went through, up to the first secret typed. */
export function recordedSurface(surface: ScreenSurface, recorder: ScreenRecorder): ScreenSurface {
  return {
    ...surface,
    async perform(action, options) {
      if (action.kind === "type_secret") recorder.stop("secret");
      const outcome = await surface.perform(action, options);
      if (outcome.ok) await recorder.frame();
      return outcome;
    },
  };
}

const fit = (width: number, height: number) => {
  const scale = Math.min(1, RECORDING_LIMITS.edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export function createScreenRecorder(options: ScreenRecorderOptions): ScreenRecorder {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? RECORDING_LIMITS.bytes;
  const frames: (ApngImage & { at: number })[] = [];
  let size: { width: number; height: number } | null = null;
  /** The screen as the frames so far draw it. */
  let shown: Pixels | null = null;
  let bytes = 0;
  let skipped = 0;
  let stopped: RecordingStop | null = null;
  return {
    get skipped() {
      return skipped;
    },
    get stopped() {
      return stopped;
    },
    stop(why) {
      stopped ??= why;
    },
    async frame() {
      if (stopped) return;
      if (frames.length >= RECORDING_LIMITS.frames) {
        stopped = "full";
        return;
      }
      if (await options.held().catch(() => true)) {
        stopped = "person";
        return;
      }
      const at = now();
      try {
        const shot = await options.grab();
        if (!shot) {
          skipped++;
          return;
        }
        const image = new Bun.Image(shot);
        if (!size) {
          const m = await image.metadata();
          size = fit(m.width, m.height);
        }
        // Every frame the first one's size: a page whose window changed size is drawn into it.
        const pixels = decodePng(await image.resize(size.width, size.height).png().bytes());
        // The first frame is the whole screen; each one after it only what changed (the same screen: none).
        const box = shown ? changedBox(shown, pixels) : undefined;
        if (box === null) return;
        // Made ready for the file now, so the bytes counted are the ones it will hold.
        const ready = apngImage(pixels, box);
        if (frames.length > 0 && bytes + ready.data.length > maxBytes) {
          stopped = "full";
          return;
        }
        frames.push({ ...ready, at });
        bytes += ready.data.length;
        shown = pixels;
      } catch {
        skipped++;
      }
    },
    async finish() {
      if (!size || frames.length === 0) return null;
      const delays = frames.map((f, i) => {
        const next = frames[i + 1];
        return next
          ? Math.max(RECORDING_LIMITS.minMs, Math.min(RECORDING_LIMITS.maxMs, next.at - f.at))
          : RECORDING_LIMITS.lastMs;
      });
      return {
        bytes: encodeApng(frames.map((f, i) => ({ ...f, delayMs: delays[i] as number }))),
        frames: frames.length,
        ...size,
      };
    },
  };
}
