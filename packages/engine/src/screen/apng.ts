import { deflateSync, inflateSync } from "node:zlib";
import { crc32 } from "../docx";

/**
 * Animated PNG (APNG) for screen recordings (ADR 0054 addendum 2026-11-15): every browser shows it as a picture that
 * plays, and no video encoder is needed. After the first frame, a frame holds only the part of the screen that
 * changed, drawn over the one before it: a step that fills a field costs that field, not a whole screen again.
 */

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

/** A PNG's chunks in order (no CRC check: these come from our own image encoder). */
export function pngChunks(bytes: Uint8Array): PngChunk[] {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    if (at + 12 + length > bytes.length) throw new Error("a PNG cut short");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

const RGBA = 6;
/** Bytes per pixel of the 8-bit layouts read here: gray, RGB, palette, gray + alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The pixels of an image, 4 bytes (RGBA) each, row after row. */
export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A PNG's pixels. Throws on what isn't read here (16-bit, interlaced). */
export function decodePng(png: Uint8Array): Pixels {
  const chunks = pngChunks(png);
  const ihdr = chunks[0];
  if (ihdr?.type !== "IHDR" || ihdr.data.length < 13) throw new Error("a PNG without its header");
  const v = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = v.getUint32(0);
  const height = v.getUint32(4);
  const [depth, colorType, , , interlace] = ihdr.data.subarray(8, 13);
  const channels = CHANNELS[colorType as number];
  if (depth !== 8 || interlace !== 0 || !channels) {
    throw new Error(`a PNG in a layout not read here (depth ${depth}, color ${colorType})`);
  }
  const data = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const palette = chunks.find((c) => c.type === "PLTE")?.data;
  const alphas = chunks.find((c) => c.type === "tRNS")?.data;
  const stride = width * channels;
  if (data.length < (stride + 1) * height) throw new Error("a PNG cut short");
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] as number;
    const row = new Uint8Array(data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (row[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      row[i] = ((row[i] as number) + add) & 0xff;
    }
    const base = y * width * 4;
    if (colorType === RGBA) rgba.set(row, base);
    else {
      for (let x = 0; x < width; x++) {
        const p = x * channels;
        const at = base + x * 4;
        if (colorType === 3) {
          const i = row[p] as number;
          rgba.set(
            [palette?.[i * 3] ?? 0, palette?.[i * 3 + 1] ?? 0, palette?.[i * 3 + 2] ?? 0, alphas?.[i] ?? 255],
            at,
          );
        } else if (colorType === 2) rgba.set([row[p] as number, row[p + 1] as number, row[p + 2] as number, 255], at);
        else {
          const g = row[p] as number;
          rgba.set([g, g, g, colorType === 4 ? (row[p + 1] as number) : 255], at);
        }
      }
    }
    prev = row;
  }
  return { width, height, rgba };
}

/** A part of an image. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest box around every pixel that differs between two images of the same size, or null: the same. */
export function changedBox(before: Pixels, after: Pixels): Box | null {
  const { width, height } = after;
  const a = new Uint32Array(before.rgba.buffer, before.rgba.byteOffset, width * height);
  const b = new Uint32Array(after.rgba.buffer, after.rgba.byteOffset, width * height);
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (a[row + x] !== b[row + x]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (a[row + x] !== b[row + x]) {
        last = x;
        break;
      }
    }
    if (top < 0) top = y;
    bottom = y;
    left = Math.min(left, first);
    right = Math.max(right, last);
  }
  return top < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** One row of a box with PNG's filter `type` before it (each byte against its left, upper and upper-left ones). */
function filtered(type: number, row: Uint8Array, up: Uint8Array | null, out: Uint8Array) {
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const a = i >= 4 ? (row[i - 4] as number) : 0;
    const b = up ? (up[i] as number) : 0;
    const c = up && i >= 4 ? (up[i - 4] as number) : 0;
    const pred = type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0;
    out[i + 1] = ((row[i] as number) - pred) & 0xff;
  }
}

/** A box of an image as APNG frame data (zlib): each row with the filter that leaves the smallest numbers. */
function encodeBox(image: Pixels, box: Box): Uint8Array {
  const rowBytes = box.width * 4;
  const out = new Uint8Array((rowBytes + 1) * box.height);
  const trial = new Uint8Array(rowBytes + 1);
  let up: Uint8Array | null = null;
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    const row = image.rgba.subarray(from, from + rowBytes);
    let best = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type++) {
      filtered(type, row, up, trial);
      let sum = 0;
      for (let i = 1; i < trial.length; i++) {
        const v = trial[i] as number;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < best) {
        best = sum;
        out.set(trial, y * (rowBytes + 1));
      }
    }
    up = row;
  }
  return new Uint8Array(deflateSync(out));
}

/** A frame as it goes into an APNG: where it is drawn on the first frame, its size, and its image data. */
export interface ApngImage extends Box {
  data: Uint8Array;
}

/** A box of an image (the whole of it by default) made ready for an APNG. */
export function apngImage(image: Pixels, box: Box = { x: 0, y: 0, width: image.width, height: image.height }) {
  return { ...box, data: encodeBox(image, box) };
}

export interface ApngFrame extends ApngImage {
  /** How long it shows (up to 65.5 s). */
  delayMs: number;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const u32s = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setUint32(i * 4, v);
  return out;
};

/**
 * The frames as one APNG that plays over and over. The first one is the whole picture; each later one is drawn over
 * what shows (a part of it, or all). Throws on no frames, or a frame outside the first one.
 */
export function encodeApng(frames: readonly ApngFrame[]): Uint8Array {
  const first = frames[0];
  if (!first) throw new Error("no frames");
  if (first.x !== 0 || first.y !== 0) throw new Error("the first frame is the whole picture");
  const { width, height } = first;
  const parts: Uint8Array[] = [
    SIGNATURE,
    chunk("IHDR", Uint8Array.of(...u32s(width, height), 8, RGBA, 0, 0, 0)),
    chunk("acTL", u32s(frames.length, 0)),
  ];
  let seq = 0;
  for (const [index, frame] of frames.entries()) {
    if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > width || frame.y + frame.height > height) {
      throw new Error("a frame outside the picture");
    }
    const control = new Uint8Array(26);
    const view = new DataView(control.buffer);
    view.setUint32(0, seq++);
    view.setUint32(4, frame.width);
    view.setUint32(8, frame.height);
    view.setUint32(12, frame.x);
    view.setUint32(16, frame.y);
    // The delay in milliseconds; the frame stays when the next one is drawn (dispose none) and replaces what was
    // under it (blend source): the screen as it is now.
    view.setUint16(20, Math.max(1, Math.min(0xffff, Math.round(frame.delayMs))));
    view.setUint16(22, 1000);
    parts.push(chunk("fcTL", control));
    if (index === 0) parts.push(chunk("IDAT", frame.data));
    else {
      const fdat = new Uint8Array(4 + frame.data.length);
      new DataView(fdat.buffer).setUint32(0, seq++);
      fdat.set(frame.data, 4);
      parts.push(chunk("fdAT", fdat));
    }
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  return new Uint8Array(Buffer.concat(parts));
}
