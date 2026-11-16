import { deflateSync } from "node:zlib";
import type { ScreenKind } from "@agenteschat/adapters";
import {
  observeSnapshot,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenImage,
  type ScreenRegion,
  type ScreenSurface,
} from "../src";
import { crc32 } from "../src/docx";

/** An XFCE desktop as the runner writes it: the panel, Thunar in front, and its window buttons. */
export const THUNAR = `- toolbar "Panel"
  - button "Applications" [ref=e1]
  - button "Files - Thunar" [window, active, ref=e2]
  - button "Terminal - agent@desktop: ~" [window, ref=e3]
  - button "Pay [window, active]" [ref=e4]
- window "Files - Thunar" [active, ref=e20]
  - toolbar
    - button "Back" [ref=e25]
    - textbox "Location" [ref=e29]: /home/agent/
  - list "Files" [ref=e30]
    - listitem "report.pdf" [ref=e31]
    - listitem "Documents" [ref=e32]
  - status: 8 folders | 6 files`;

/**
 * A screen whose text a test sets, as a surface: every action and every capture recorded, the next
 * action failed on demand, images from `capture` (with `regions`, close-ups too).
 */
export function fakeScreen(
  text: string,
  options: {
    kind?: ScreenKind;
    url?: string;
    title?: string;
    capture?: (region?: ScreenRegion) => ScreenImage | null;
    regions?: boolean;
  } = {},
) {
  let current = text;
  let failNext: string | null = null;
  const actions: ScreenAction[] = [];
  const captures: (ScreenRegion | undefined)[] = [];
  const look = () =>
    observeSnapshot({
      text: current,
      url: options.url ?? "desktop://thunar/main",
      title: options.title ?? "Files - Thunar",
    });
  const make = options.capture;
  const surface: ScreenSurface & {
    actions: ScreenAction[];
    captures: (ScreenRegion | undefined)[];
    show(next: string): void;
    fail(error: string): void;
  } = {
    kind: options.kind ?? "desktop",
    actions,
    captures,
    show(next) {
      current = next;
    },
    fail(error) {
      failNext = error;
    },
    async observe() {
      return look();
    },
    async perform(action): Promise<ScreenActOutcome> {
      actions.push(action);
      if (failNext) {
        const error = failNext;
        failNext = null;
        return { ok: false, error };
      }
      return { ok: true, observation: look() };
    },
    ...(make
      ? {
          async capture(region?: ScreenRegion) {
            captures.push(region);
            return make(region);
          },
          ...(options.regions ? { regions: true } : {}),
        }
      : {}),
  };
  return surface;
}

/** The whole 1280×800 desktop as an image. */
export const screenImage = (marks: ScreenImage["marks"] = []): ScreenImage => ({
  data: "FULL",
  width: 1280,
  height: 800,
  viewport: { width: 1280, height: 800 },
  marks,
});

/** A close-up of `region` at the screen's native size: a real image (one pixel), since a close-up is enlarged. */
export const closeUpOf = (region: ScreenRegion): ScreenImage => ({
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPom7XoPwAGTgLKI4t8IAAAAABJRU5ErkJggg==",
  width: region.width,
  height: region.height,
  viewport: { width: region.width, height: region.height },
  origin: { x: region.x, y: region.y },
});

/** A clock that moves 100 ms each time it is read: waits and graces end without real time passing. */
export function ticking() {
  let t = 0;
  return () => {
    t += 100;
    return t;
  };
}

/** Steps' actions without the pauses of waits and checks. */
export const acted = (actions: ScreenAction[]) => actions.filter((a) => a.kind !== "pause");

/** A PNG of one color, written by hand (`colorType` 2: RGB, 6: RGBA), so frames in other layouts can be tested. */
export function plainPng(width: number, height: number, rgb: [number, number, number], colorType: 2 | 6 = 2) {
  const channels = colorType === 2 ? 3 : 4;
  const raw = new Uint8Array((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * channels + 1) + 1 + x * channels;
      raw.set(channels === 3 ? rgb : [...rgb, 255], at);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colorType;
  return pngOf([
    ["IHDR", header],
    ["IDAT", new Uint8Array(deflateSync(raw))],
    ["IEND", new Uint8Array(0)],
  ]);
}

export function pngOf(chunks: [string, Uint8Array][]) {
  const parts: Uint8Array[] = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
  for (const [type, data] of chunks) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    const typed = new TextEncoder().encode(type);
    out.set(typed, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typed);
    crcInput.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcInput));
    parts.push(out);
  }
  return Buffer.concat(parts);
}

/** A JPEG of one color, as a browser screenshot or the desktop's capture comes. */
export const jpegOf = (rgb: [number, number, number], width = 400, height = 300) =>
  new Bun.Image(plainPng(width, height, rgb)).jpeg({ quality: 70 }).bytes();
