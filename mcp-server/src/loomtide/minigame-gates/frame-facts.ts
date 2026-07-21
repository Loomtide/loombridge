/**
 * Mini-game frame-facts producer (S6c-2).
 *
 * Derives the per-state pixel facts the `no-black-bars` and `render-frame` gates
 * grade — `{ borderFraction, uniformBorderFraction, contentCoverage,
 * dominantBorderColor }` — from a captured `<state>.png`. Decoding reuses
 * `analyze-frames.ts`'s dependency-free `readPng`.
 *
 * LETTERBOX-SPECIFIC by design (this is the key S6c-2 decision). A "border" here
 * is a band at a frame edge that is BOTH near-uniform AND DARK (near camera-clear
 * black) — i.e. an actual letterbox/pillarbox bar. A BRIGHT uniform edge band is
 * NOT counted: kids games legitimately fill the frame with a flat-colour
 * background, and empirically the real CountTheFruits captures carry a bright
 * uniform bottom band of up to ~14% of the edge (the ground/floor) with ZERO dark
 * border. The platformer `render-frame` gate treats ANY uniform edge band as
 * boxing; that assumption does not hold for flat-background mini-games, which is
 * exactly why this is a separate producer rather than a reuse of that gate.
 *
 * Anti-false-green: this is an INPUT producer. The refuse-on-absent discipline
 * lives in the runner/evaluators — a missing/unreadable `<state>.png` yields no
 * frame facts, and the two frame gates FAIL (never pass) when frame facts are
 * absent.
 */

import { readPng } from "../../verification/analyze-frames.js";
import type { MinigameRect } from "./types.js";

/** Minimal decoded-image shape (structurally compatible with `readPng`'s result). */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major, 4 per pixel. */
  data: Uint8Array;
}

/** Pixel facts derived from one `<state>.png`. */
export interface MinigameFrameFacts {
  /** Fraction of the frame AREA consumed by dark letterbox border bands (all edges). */
  borderFraction: number;
  /** Worst single edge's dark+uniform border band, as a fraction of that edge's perpendicular dimension. */
  uniformBorderFraction: number;
  /** Fraction of the frame inside the dark border bands (content area / total). */
  contentCoverage: number;
  /** Average colour of the outer 1px ring — informational (is the border black?). */
  dominantBorderColor: { r: number; g: number; b: number };
}

/** Luma at/below this is treated as dark / camera-clear (matches analyze-frames default). */
const DARK_LUMA = 42;
/** A row/column whose per-channel range is at/below this is "uniform". */
const UNIFORM_RANGE = 12;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface LineStat {
  meanR: number;
  meanG: number;
  meanB: number;
  /** Max per-channel (max−min) across the line. */
  range: number;
}

/** Mean colour + per-channel range of one row (`axis="row"`) or column (`axis="col"`). */
function lineStat(img: DecodedImage, index: number, axis: "row" | "col"): LineStat {
  const n = axis === "row" ? img.width : img.height;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (let k = 0; k < n; k += 1) {
    const x = axis === "row" ? k : index;
    const y = axis === "row" ? index : k;
    const i = (y * img.width + x) * 4;
    const r = img.data[i] ?? 0;
    const g = img.data[i + 1] ?? 0;
    const b = img.data[i + 2] ?? 0;
    sr += r;
    sg += g;
    sb += b;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return {
    meanR: sr / n,
    meanG: sg / n,
    meanB: sb / n,
    range: Math.max(maxR - minR, maxG - minG, maxB - minB),
  };
}

/** A line is a dark letterbox line iff it is uniform AND dark. */
function isDarkUniform(s: LineStat): boolean {
  return s.range <= UNIFORM_RANGE && luma(s.meanR, s.meanG, s.meanB) <= DARK_LUMA;
}

/** Count the inward run of dark+uniform lines from one edge. */
function edgeBand(img: DecodedImage, axis: "row" | "col", fromStart: boolean): number {
  const count = axis === "row" ? img.height : img.width;
  let band = 0;
  for (let k = 0; k < count; k += 1) {
    const index = fromStart ? k : count - 1 - k;
    if (isDarkUniform(lineStat(img, index, axis))) band += 1;
    else break;
  }
  return band;
}

/** Compute frame facts from a decoded image. Pure + exported for unit tests. */
export function computeFrameFacts(img: DecodedImage): MinigameFrameFacts {
  const W = img.width;
  const H = img.height;
  if (W <= 0 || H <= 0) {
    return {
      borderFraction: 1,
      uniformBorderFraction: 1,
      contentCoverage: 0,
      dominantBorderColor: { r: 0, g: 0, b: 0 },
    };
  }

  let top = edgeBand(img, "row", true);
  let bottom = edgeBand(img, "row", false);
  let left = edgeBand(img, "col", true);
  let right = edgeBand(img, "col", false);

  // Clamp opposing bands so they cannot overlap past the frame (all-dark frame).
  if (top + bottom > H) bottom = Math.max(0, H - top);
  if (left + right > W) right = Math.max(0, W - left);

  const uniformBorderFraction = Math.max(top / H, bottom / H, left / W, right / W);

  // Union area of the four bands (subtract the four corner double-counts).
  const unionArea =
    top * W +
    bottom * W +
    left * H +
    right * H -
    (top * left + top * right + bottom * left + bottom * right);
  const borderFraction = clamp01(unionArea / (W * H));

  const innerW = Math.max(0, W - left - right);
  const innerH = Math.max(0, H - top - bottom);
  const contentCoverage = clamp01((innerW * innerH) / (W * H));

  // Dominant border colour = mean of the outer 1px ring.
  const ring = [
    lineStat(img, 0, "row"),
    lineStat(img, H - 1, "row"),
    lineStat(img, 0, "col"),
    lineStat(img, W - 1, "col"),
  ];
  const dominantBorderColor = {
    r: Math.round(ring.reduce((s, l) => s + l.meanR, 0) / ring.length),
    g: Math.round(ring.reduce((s, l) => s + l.meanG, 0) / ring.length),
    b: Math.round(ring.reduce((s, l) => s + l.meanB, 0) / ring.length),
  };

  return { borderFraction, uniformBorderFraction, contentCoverage, dominantBorderColor };
}

/** Decode `<pngPath>` to RGBA. Throws if missing/unreadable/not a PNG. */
export async function readFrameImage(pngPath: string): Promise<DecodedImage> {
  return readPng(pngPath);
}

/**
 * Load `<pngPath>` and compute its frame facts. Throws if the file is
 * missing/unreadable/not a PNG — the runner catches that and FAILs the two frame
 * gates (refuse-on-absent), never treating an absent capture as clean.
 */
export async function loadFrameFacts(pngPath: string): Promise<MinigameFrameFacts> {
  return computeFrameFacts(await readFrameImage(pngPath));
}

/** Default tolerance (avg per-channel) for matching a pixel to a declared fill colour. */
export const FILL_COLOR_TOLERANCE = 18;

/** Parse a `#RRGGBB` colour to `[r,g,b]`, or null if malformed. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}

/**
 * Fraction of a background object's layout rect that its rendered FILL colour
 * covers — the `background-fit` signal. `rect` is the captured `screenRect`
 * (bottom-left origin, px); it is flipped to the image's top-left pixel box using
 * the image height. A low fraction means the background sprite is rendering far
 * smaller than its layout rect (not scaled/9-sliced to envelop its content), so
 * content sits on the bare frame instead of the card. Returns 0 for an empty rect.
 */
export function backgroundFillFraction(
  image: DecodedImage,
  rect: MinigameRect,
  fill: [number, number, number],
  tol: number = FILL_COLOR_TOLERANCE,
): number {
  const W = image.width;
  const H = image.height;
  const x0 = clampInt(rect.x, 0, W);
  const x1 = clampInt(rect.x + rect.width, 0, W);
  const yTop0 = clampInt(H - (rect.y + rect.height), 0, H);
  const yTop1 = clampInt(H - rect.y, 0, H);
  const area = (x1 - x0) * (yTop1 - yTop0);
  if (area <= 0) return 0;
  let hit = 0;
  for (let y = yTop0; y < yTop1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * W + x) * 4;
      const d =
        (Math.abs((image.data[i] ?? 0) - fill[0]) +
          Math.abs((image.data[i + 1] ?? 0) - fill[1]) +
          Math.abs((image.data[i + 2] ?? 0) - fill[2])) /
        3;
      if (d <= tol) hit += 1;
    }
  }
  return hit / area;
}
