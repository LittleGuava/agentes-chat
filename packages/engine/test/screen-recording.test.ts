import { expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import {
  apngImage,
  createScreenRecorder,
  decodePng,
  encodeApng,
  pngChunks,
  RECORDING_LIMITS,
  recordedSurface,
  type ScreenSurface,
} from "../src";
import { crc32 } from "../src/docx";
import { jpegOf, plainPng, pngOf } from "./screen-fixtures";

/** Every chunk's CRC checks out (the file isn't torn anywhere). */
function crcsHold(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) return false;
    at += 12 + length;
  }
  return true;
}

/** Each frame of an APNG as a PNG of its own (its header, its data), so a decoder that knows no APNG reads it. */
function framesAsPngs(apng: Uint8Array) {
  const chunks = pngChunks(apng);
  const header = chunks.find((c) => c.type === "IHDR")?.data as Uint8Array;
  const frames: Uint8Array[][] = [];
  for (const c of chunks) {
    if (c.type === "fcTL") frames.push([]);
    if (c.type === "IDAT") frames.at(-1)?.push(c.data);
    if (c.type === "fdAT") frames.at(-1)?.push(c.data.subarray(4));
  }
  return frames.map((parts) =>
    pngOf([
      ["IHDR", header],
      ["IDAT", Buffer.concat(parts)],
      ["IEND", new Uint8Array(0)],
    ]),
  );
}

test("encodeApng: one animated PNG, every frame with its own time, readable frame by frame", async () => {
  const frames = [
    { ...apngImage(decodePng(await new Bun.Image(await jpegOf([200, 30, 30])).png().bytes())), delayMs: 800 },
    { ...apngImage(decodePng(await new Bun.Image(await jpegOf([30, 200, 30])).png().bytes())), delayMs: 1200 },
    // Another layout (RGB, as another image backend may write it): read the same.
    { ...apngImage(decodePng(plainPng(400, 300, [30, 30, 200]))), delayMs: 3000 },
  ];
  const apng = encodeApng(frames);
  expect(Array.from(apng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(crcsHold(apng)).toBe(true);
  const chunks = pngChunks(apng);
  // The animation control comes before the first image data, as the format asks.
  const order = chunks
    .map((c) => c.type)
    .join(",")
    .replace(/(IDAT,)+/g, "IDAT+,")
    .replace(/(fdAT,)+/g, "fdAT+,");
  expect(order).toBe("IHDR,acTL,fcTL,IDAT+,fcTL,fdAT+,fcTL,fdAT+,IEND");
  const control = chunks[1]?.data as Uint8Array;
  const actl = new DataView(control.buffer, control.byteOffset);
  expect(actl.getUint32(0)).toBe(3);
  // Plays over and over.
  expect(actl.getUint32(4)).toBe(0);
  const controls = chunks.filter((c) => c.type === "fcTL").map((c) => new DataView(c.data.buffer, c.data.byteOffset));
  expect(controls.map((v) => [v.getUint32(4), v.getUint32(8), v.getUint16(20) / v.getUint16(22)])).toEqual([
    [400, 300, 0.8],
    [400, 300, 1.2],
    [400, 300, 3],
  ]);
  // Sequence numbers run 0, 1, 2… across frame controls and frame data alike.
  const seqs = chunks
    .filter((c) => c.type === "fcTL" || c.type === "fdAT")
    .map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
  expect(seqs).toEqual(seqs.map((_, i) => i));
  const pngs = framesAsPngs(apng);
  expect(pngs).toHaveLength(3);
  for (const png of pngs) expect(await new Bun.Image(png).metadata()).toMatchObject({ width: 400, height: 300 });
  // The frame from another layout shows its own color.
  const [r, g, b] = await pixelOf(pngs[2] as Uint8Array);
  expect(b).toBeGreaterThan(150);
  expect(r + g).toBeLessThan(150);
});

test("encodeApng refuses no frames, and a frame outside the first one", () => {
  expect(() => encodeApng([])).toThrow();
  expect(() =>
    encodeApng([
      { ...apngImage(decodePng(plainPng(4, 4, [0, 0, 0]))), delayMs: 100 },
      { ...apngImage(decodePng(plainPng(5, 4, [0, 0, 0]))), delayMs: 100 },
    ]),
  ).toThrow("outside the picture");
});

/** A screen of one color with a box of another (a field filled in, a menu opened). */
function screenWith(box: { x: number; y: number; width: number; height: number } | null) {
  const width = 400;
  const height = 300;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
      rgba.set(inside ? [20, 20, 20, 255] : [240, 240, 240, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

test("a recording keeps only what changed after its first frame: a filled field costs the field", async () => {
  const pngOfPixels = (p: ReturnType<typeof screenWith>) =>
    pngOf([
      ["IHDR", Uint8Array.of(0, 0, 1, 144, 0, 0, 1, 44, 8, 6, 0, 0, 0)],
      [
        "IDAT",
        new Uint8Array(
          deflateSync(
            Buffer.concat(
              Array.from({ length: p.height }, (_, y) =>
                Buffer.concat([Buffer.of(0), p.rgba.subarray(y * p.width * 4, (y + 1) * p.width * 4)]),
              ),
            ),
          ),
        ),
      ],
      ["IEND", new Uint8Array(0)],
    ]);
  const screens = [screenWith(null), screenWith({ x: 50, y: 60, width: 120, height: 20 }), screenWith(null)];
  let i = 0;
  const r = recorder(async () => pngOfPixels(screens[i++] as ReturnType<typeof screenWith>));
  for (let n = 0; n < 3; n++) await r.frame();
  const done = await r.finish();
  expect(done?.frames).toBe(3);
  const chunks = pngChunks(done?.bytes as Uint8Array);
  const boxes = chunks
    .filter((c) => c.type === "fcTL")
    .map((c) => {
      const v = new DataView(c.data.buffer, c.data.byteOffset);
      return { x: v.getUint32(12), y: v.getUint32(16), width: v.getUint32(4), height: v.getUint32(8) };
    });
  expect(boxes).toEqual([
    { x: 0, y: 0, width: 400, height: 300 },
    { x: 50, y: 60, width: 120, height: 20 },
    // Back to how it was: the same box, drawn over again.
    { x: 50, y: 60, width: 120, height: 20 },
  ]);
  // Each frame is read back as the screen it shows (the box over the screen before it).
  const frames = chunks.filter((c) => c.type === "IDAT" || c.type === "fdAT");
  const rows = (c: (typeof frames)[number]) => inflateSync(c.type === "fdAT" ? c.data.subarray(4) : c.data);
  expect(rows(frames[0] as (typeof frames)[number]).length).toBe(300 * (400 * 4 + 1));
  expect(rows(frames[1] as (typeof frames)[number]).length).toBe(20 * (120 * 4 + 1));
});

test("a recording stops before a secret is typed: nothing after it is pictured", async () => {
  const kinds: string[] = [];
  const surface: ScreenSurface = {
    observe: async () => {
      throw new Error("not looked at here");
    },
    perform: async (action) => {
      kinds.push(action.kind);
      return { ok: true, observation: null };
    },
  };
  let grabs = 0;
  const r = recorder(async () => {
    grabs++;
    return jpegOf([grabs * 40, 30, 30]);
  });
  const recorded = recordedSurface(surface, r);
  await recorded.perform({ kind: "click", at: { ref: "e1" } }, { settle: true });
  await recorded.perform({ kind: "type_secret", at: { ref: "e2" }, secret: "code" }, { settle: true });
  await recorded.perform({ kind: "click", at: { ref: "e3" } }, { settle: true });
  // The actions all ran; only the first was pictured.
  expect(kinds).toEqual(["click", "type_secret", "click"]);
  expect(grabs).toBe(1);
  expect(r.stopped).toBe("secret");
});

/** One pixel's color, read back through a JPEG at 1×1 (a decoder independent of ours). */
async function pixelOf(png: Uint8Array): Promise<[number, number, number]> {
  const tiny = await new Bun.Image(png).resize(1, 1).png().bytes();
  const chunks = pngChunks(tiny);
  const header = chunks.find((c) => c.type === "IHDR")?.data as Uint8Array;
  const data = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = inflateSync(data);
  expect(header[8]).toBe(8);
  return [raw[1] as number, raw[2] as number, raw[3] as number];
}

function recorder(grab: () => Promise<Uint8Array | null>, held: () => Promise<boolean> = async () => false) {
  let t = 0;
  return createScreenRecorder({
    grab,
    held,
    now: () => {
      t += 1000;
      return t;
    },
  });
}

test("a recording: a frame per look, the same screen twice is one frame shown longer, at most the edge's size", async () => {
  const shots = [
    await jpegOf([200, 30, 30], 2560, 1600),
    await jpegOf([200, 30, 30], 2560, 1600),
    await jpegOf([30, 200, 30], 2560, 1600),
  ];
  let i = 0;
  const r = recorder(async () => shots[i++] ?? null);
  for (let n = 0; n < 3; n++) await r.frame();
  const done = await r.finish();
  expect(done).not.toBeNull();
  expect(done).toMatchObject({ frames: 2, width: RECORDING_LIMITS.edge, height: 800 });
  const chunks = pngChunks(done?.bytes as Uint8Array);
  const delays = chunks
    .filter((c) => c.type === "fcTL")
    .map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint16(20));
  // The first screen stayed two looks (2 s); the last one is held at the end.
  expect(delays).toEqual([2000, RECORDING_LIMITS.lastMs]);
});

test("a recording never fails its plan: a look that fails is skipped, nothing recorded is null", async () => {
  const r = recorder(async () => {
    throw new Error("the computer went offline");
  });
  await r.frame();
  expect(r.skipped).toBe(1);
  expect(await r.finish()).toBeNull();
  // Not a picture at all: skipped too.
  const junk = recorder(async () => new TextEncoder().encode("not an image"));
  await junk.frame();
  expect(junk.skipped).toBe(1);
  expect(await junk.finish()).toBeNull();
});

test("a recording stops at a person in control: nothing they see is kept from then on", async () => {
  let person = false;
  const grabbed: number[] = [];
  const colors: [number, number, number][] = [
    [200, 30, 30],
    [30, 200, 30],
    [30, 30, 200],
  ];
  let i = 0;
  const r = recorder(
    async () => {
      grabbed.push(i);
      return jpegOf(colors[i++] as [number, number, number]);
    },
    async () => person,
  );
  await r.frame();
  person = true;
  await r.frame();
  person = false;
  await r.frame();
  // The screen was never even looked at once a person had it.
  expect(grabbed).toEqual([0]);
  expect(r.stopped).toBe("person");
  expect(await r.finish()).toMatchObject({ frames: 1 });
});

test("a recording stops at its frame and byte limits", async () => {
  let n = 0;
  const r = recorder(async () => jpegOf([n % 256, (n * 7) % 256, (n++ * 13) % 256], 64, 48));
  for (let k = 0; k < RECORDING_LIMITS.frames + 5; k++) await r.frame();
  expect(r.stopped).toBe("full");
  expect((await r.finish())?.frames).toBe(RECORDING_LIMITS.frames);
  const small = createScreenRecorder({
    grab: async () => jpegOf([n % 256, (n * 7) % 256, (n++ * 13) % 256], 64, 48),
    held: async () => false,
    maxBytes: 1,
  });
  await small.frame();
  await small.frame();
  // The first frame always fits: a recording of one frame is still a picture.
  expect(small.stopped).toBe("full");
  expect((await small.finish())?.frames).toBe(1);
});
