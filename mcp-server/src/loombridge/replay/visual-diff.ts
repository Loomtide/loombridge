/**
 * Replay Verification — perceptual visual diff (baseline regression).
 *
 * `comparePerceptual(actual, baseline)` is a PURE function over decoded RGBA
 * images. It uses a YIQ-weighted per-pixel colour delta (the pixelmatch metric)
 * and counts pixels whose delta exceeds a perceptual threshold — NOT hash
 * equality, which the design forbids (a single-pixel GPU/AA/driver difference
 * must not read as a regression). A size mismatch is itself a drift (e.g. a
 * resolution change), reported with a full diff fraction.
 *
 * Decoding is the caller's job (reuse `verification/analyze-frames`'s `readPng`);
 * this module stays image-library-free and fully unit-testable from in-memory
 * pixel buffers.
 */

/** Structurally compatible with `RgbaImage` from `verification/analyze-frames`. */
export interface RgbaLike {
  width: number;
  height: number;
  /** RGBA bytes, row-major, 4 per pixel. */
  data: Uint8Array;
}

export interface VisualDiffOptions {
  /**
   * Per-pixel sensitivity in [0,1] (pixelmatch's `threshold`, default 0.1). Lower
   * = stricter. A pixel counts as different when its YIQ delta exceeds this.
   */
  pixelThreshold?: number;
  /**
   * Fraction of differing pixels above which the images are "drift" rather than
   * "match" (default 0.005 = 0.5%). Absorbs minor sub-pixel noise.
   */
  driftFraction?: number;
}

export type VisualStatus = "match" | "drift";

export interface VisualDiff {
  dimensionsMatch: boolean;
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  /** diffPixels / totalPixels, in [0,1]. */
  diffFraction: number;
  status: VisualStatus;
}

const DEFAULT_PIXEL_THRESHOLD = 0.1;
const DEFAULT_DRIFT_FRACTION = 0.005;
// pixelmatch's maximum YIQ delta for two maximally-different pixels.
const MAX_YIQ_DELTA = 35215;

export function comparePerceptual(
  actual: RgbaLike,
  baseline: RgbaLike,
  options: VisualDiffOptions = {},
): VisualDiff {
  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const driftFraction = options.driftFraction ?? DEFAULT_DRIFT_FRACTION;

  // A size mismatch can't be pixel-aligned — it is unambiguous drift.
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    const totalPixels = actual.width * actual.height;
    return {
      dimensionsMatch: false,
      width: actual.width,
      height: actual.height,
      diffPixels: totalPixels,
      totalPixels,
      diffFraction: 1,
      status: "drift",
    };
  }

  const totalPixels = actual.width * actual.height;
  const maxDelta = MAX_YIQ_DELTA * pixelThreshold * pixelThreshold;
  let diffPixels = 0;
  for (let i = 0; i < totalPixels; i += 1) {
    if (yiqDelta(actual.data, baseline.data, i * 4) > maxDelta) diffPixels += 1;
  }

  const fraction = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  return {
    dimensionsMatch: true,
    width: actual.width,
    height: actual.height,
    diffPixels,
    totalPixels,
    diffFraction: fraction,
    status: fraction > driftFraction ? "drift" : "match",
  };
}

/**
 * Squared YIQ colour distance between two pixels (pixelmatch's `colorDelta`).
 * Alpha is ignored: the bridge screenshots are opaque, so this matches
 * pixelmatch for them. A baseline PNG with real transparency would compare raw
 * un-premultiplied RGB (a documented limitation; blend alpha if that's ever in
 * scope).
 */
function yiqDelta(a: Uint8Array, b: Uint8Array, o: number): number {
  const r1 = a[o] ?? 0, g1 = a[o + 1] ?? 0, b1 = a[o + 2] ?? 0;
  const r2 = b[o] ?? 0, g2 = b[o + 1] ?? 0, b2 = b[o + 2] ?? 0;
  if (r1 === r2 && g1 === g2 && b1 === b2) return 0;

  const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}
function rgb2i(r: number, g: number, b: number): number {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
}
function rgb2q(r: number, g: number, b: number): number {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
}
