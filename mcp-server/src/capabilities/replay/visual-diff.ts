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
 *
 * It also owns the DRIFT VOCABULARY: the default tolerance, the hard cap on an
 * approved one, the consent sentence a human reads before stamping one, and the two
 * human-facing lines (the regression line and the re-tolerance suggestion) that must
 * read identically at the `trace` verb and at the unified `verify` flow section. The
 * words live here, beside the number they describe, because two doors printing two
 * sentences about the same fact is how a drift stops being one fact.
 */

import { createHash } from "node:crypto";

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
  /**
   * The human-approved mask rects in force for this comparison (M10/M11). They are
   * BLANKED in both images before the diff; see {@link blankBoxes} for why blanking
   * rather than excluding.
   */
  maskRects?: readonly MaskRect[];
  /**
   * Which capture is being compared. Selects the capture-scoped rects: a rect with no
   * `captureId` applies to EVERY capture, one with a `captureId` only to that capture.
   * Absent here means "the trace-wide rects only".
   */
  captureId?: string;
}

export type VisualStatus = "match" | "drift";

/** A rect on the frame, in image pixels (top-left origin). Integers. */
export interface RectGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * ONE approved mask rect on a trace baseline.
 *
 * HOW THIS DIFFERS FROM THE MINIGAME MASKS (`minigame/minigame-baseline.ts`), because
 * both are called "masks" and they are not the same concept:
 *  - a MINIGAME mask names a DECLARED OBJECT id, and the blanked box is that object's
 *    `screenRect` as measured in each capture (so a mask follows dynamic content that
 *    MOVED);
 *  - a TRACE `MaskRect` is a FRAME RECT in pixels, fixed for every run, carrying a
 *    MANDATORY `reason` a human typed. It cannot follow anything: it is a region of the
 *    screen an operator has stated is ambient, and the reason is what makes that
 *    statement auditable later.
 */
export interface MaskRect extends RectGeometry {
  /**
   * Restrict this rect to ONE capture. Absent = every capture in the trace (allowed,
   * and the consent sentence says "every capture" so nobody has to infer it).
   */
  captureId?: string;
  /**
   * WHY this region is excluded, typed by a human. MANDATORY: a mask is a piece of the
   * frame nobody will ever grade again, and an unexplained one is indistinguishable
   * from a laundered failure.
   */
  reason: string;
}

export interface VisualDiff {
  dimensionsMatch: boolean;
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  /**
   * diffPixels / totalPixels, in [0,1].
   *
   * THE DENOMINATOR IS THE FULL FRAME, masked or not (M11). Masked pixels are blanked
   * in both images, so they cannot differ and cannot contribute to the numerator, but
   * dividing by the unmasked area instead would silently re-scale every stamped
   * tolerance: a 1.5% allowance a human consented to over the whole frame would start
   * grading as 1.5% of whatever was left, which is a bigger hole than the one that was
   * approved. `maskedFraction` reports the size of the blanked region separately.
   */
  diffFraction: number;
  status: VisualStatus;
  /** Fraction of the FULL frame blanked before comparing, in [0,1]. 0 when unmasked. */
  maskedFraction: number;
  /** sha256 of the per-pixel drift bitmap, present only when something drifted. */
  driftDiffSha?: string;
  /** Bounding box of every drifted pixel, present only when something drifted. */
  driftBounds?: RectGeometry;
  /**
   * At most {@link MAX_SUGGESTED_RECTS} TIGHT rects covering every drifted pixel, present
   * only when the drift is concentrated enough for masks to cover it honestly (see
   * {@link clusterDriftRects}). Absent means diffuse.
   */
  driftClusters?: RectGeometry[];
}

const DEFAULT_PIXEL_THRESHOLD = 0.1;

/**
 * The tolerance a baseline is graded at when nothing approved another one: 0.5% of
 * pixels may differ. Exported because the manifest reader resolves an ABSENT
 * `driftTolerance` to exactly this (schema-tolerant: a legacy manifest grades today
 * exactly as it graded yesterday).
 */
export const DEFAULT_DRIFT_FRACTION = 0.005;

/**
 * The HARD CAP on a human-approved per-trace tolerance (2%).
 *
 * It sits beside the default on purpose: the two numbers are one decision, and a cap
 * spelled somewhere else is a cap the reader forgets to apply. Both the approve-time
 * stamp (`trace tolerance`) and the READ side (`loadTraceBaselineManifest`) enforce
 * it, so a hand-edited 0.9 in a manifest never grades.
 *
 * WHY 2% AND NOT LOWER. A tolerance is the honest stopgap for a game that animates
 * under its own clock, where a frozen frame legitimately differs run to run. 1% kills
 * the measured real-world case, and a permanently red gate protects nothing: it gets
 * ignored, which is worse than a bounded allowance an operator consented to. Above 2%
 * the comparison is vacuous (see {@link toleranceConsentSentence} for the size of what
 * can change undetected). A tolerance is a hole ANYWHERE in the frame; {@link MaskRect}
 * is the localized fix, and the two are graded together, not instead of each other.
 */
export const MAX_DRIFT_TOLERANCE = 0.02;

/**
 * THE VACUITY CAP ON MASKS: at most 10% of any one frame may be excluded from the pixel
 * comparison (P2 as amended by Q4).
 *
 * "Mask the whole frame" is the obvious laundering move, and it is not even dishonest by
 * intent: an operator chasing a red gate will grow a mask until the gate goes green, one
 * rect at a time, exactly the way a tolerance ratchets. The cap is what makes that stop
 * being possible, and it is enforced PER FRAME (Q2): a trace-wide rect plus a
 * capture-scoped one must together stay under the cap for the capture they both cover,
 * because the frame either got graded or it did not.
 *
 * 10% and not 40%: at 40% the comparison is already theatre, and the measured case this
 * feature was built for (a cumulative phase desync of an ambient animation layer) fits
 * in a few percent. Both sides enforce it through ONE predicate ({@link maskRefusal}).
 */
export const MAX_MASKED_FRACTION = 0.1;

/** At most this many rects may be suggested per capture; beyond it the drift is diffuse. */
export const MAX_SUGGESTED_RECTS = 3;

/**
 * A suggested rect set must be this TIGHT: drifted pixels / suggested rect area. Below
 * it the rects are mostly empty space, so masking them would blind far more of the frame
 * than the drift actually occupies, and the honest answer is that masks do not fit.
 */
export const MIN_CLUSTER_TIGHTNESS = 0.5;

/**
 * Beyond this many connected components the drift is diffuse BY DEFINITION: sub-pixel
 * noise scattered over the frame produces hundreds of one-pixel components, and no set
 * of three rects covers them without covering the frame. Bounding the count also bounds
 * the merge below, which is quadratic in it.
 */
const MAX_DRIFT_COMPONENTS = 64;

/** A defensive bound on a hand-edited mask list, so validation stays cheap and finite. */
export const MAX_MASK_RECTS = 32;

// pixelmatch's maximum YIQ delta for two maximally-different pixels.
const MAX_YIQ_DELTA = 35215;

export function comparePerceptual(
  actual: RgbaLike,
  baseline: RgbaLike,
  options: VisualDiffOptions = {},
): VisualDiff {
  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const driftFraction = options.driftFraction ?? DEFAULT_DRIFT_FRACTION;

  // A size mismatch can't be pixel-aligned: it is unambiguous drift. Masks are moot
  // here, because there is no common pixel space to blank, and a resolution change is
  // not the thing a human excused when they masked an ambient corner.
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
      maskedFraction: 0,
    };
  }

  const W = actual.width;
  const H = actual.height;
  const totalPixels = W * H;

  // BLANKING, NOT EXCLUSION (M10/M11). Both images get the same rects painted opaque
  // black BEFORE the diff, so a masked region simply cannot differ, while the
  // denominator stays the full frame and every stamped tolerance keeps the meaning it
  // was consented to. This is the same operation the minigame baseline path performs on
  // its own masks, lifted here so one implementation serves both.
  const boxes = maskPixelBoxes(options.maskRects ?? [], options.captureId, W, H);
  const a = blankBoxes(actual, boxes);
  const b = blankBoxes(baseline, boxes);
  const maskedFraction = totalPixels === 0 ? 0 : unionArea(boxes) / totalPixels;

  const maxDelta = MAX_YIQ_DELTA * pixelThreshold * pixelThreshold;
  let diffPixels = 0;
  // Allocated lazily on the first differing pixel: an all-match comparison (the common
  // case) never pays for a full-frame bitmap, and every earlier index is 0 anyway.
  let bitmap: Uint8Array | null = null;
  for (let i = 0; i < totalPixels; i += 1) {
    if (yiqDelta(a.data, b.data, i * 4) > maxDelta) {
      diffPixels += 1;
      if (bitmap === null) bitmap = new Uint8Array(totalPixels);
      bitmap[i] = 1;
    }
  }

  const fraction = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const analysis = bitmap === null ? {} : analyzeDrift(bitmap, W, H, diffPixels);
  return {
    dimensionsMatch: true,
    width: W,
    height: H,
    diffPixels,
    totalPixels,
    diffFraction: fraction,
    // STRICTLY GREATER, so a fraction exactly EQUAL to the tolerance passes. Documented
    // rather than left to be discovered: an approved tolerance is a consented allowance,
    // and "up to N%" is what the consent sentence promises.
    status: fraction > driftFraction ? "drift" : "match",
    maskedFraction,
    ...analysis,
  };
}

// ── masks: geometry, blanking, and the ONE refusal predicate ─────────────────

/** A pixel box in IMAGE coordinates (top-left origin), half-open on x1/y1. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The rects in force for ONE capture: every trace-wide rect (no `captureId`) plus the
 * rects scoped to this capture. The cap is applied to exactly this set (Q2), because the
 * question the cap answers is "how much of THIS frame went ungraded".
 */
export function masksForCapture(
  rects: readonly MaskRect[],
  captureId: string | undefined,
): MaskRect[] {
  return rects.filter((r) => r.captureId === undefined || r.captureId === captureId);
}

/** Clamp a mask rect into the frame and convert it to a pixel box. */
function toPixelBox(rect: RectGeometry, W: number, H: number): PixelBox {
  const x0 = clamp(Math.round(rect.x), 0, W);
  const y0 = clamp(Math.round(rect.y), 0, H);
  return {
    x0,
    y0,
    x1: clamp(Math.round(rect.x + rect.w), x0, W),
    y1: clamp(Math.round(rect.y + rect.h), y0, H),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The pixel boxes to blank for one capture, in the common WxH pixel space. */
export function maskPixelBoxes(
  rects: readonly MaskRect[],
  captureId: string | undefined,
  W: number,
  H: number,
): PixelBox[] {
  return masksForCapture(rects, captureId).map((r) => toPixelBox(r, W, H));
}

/**
 * Return a copy of `image` with every pixel inside any box set to opaque black.
 *
 * Lifted from the minigame baseline path so ONE implementation serves both mask
 * concepts. Returns the input untouched when there is nothing to blank, so the unmasked
 * path (every legacy baseline) allocates nothing and behaves exactly as it did before.
 */
export function blankBoxes(image: RgbaLike, boxes: readonly PixelBox[]): RgbaLike {
  if (boxes.length === 0) return image;
  const data = new Uint8Array(image.data); // copy, so the input stays pure
  const W = image.width;
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y += 1) {
      for (let x = box.x0; x < box.x1; x += 1) {
        const i = (y * W + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

/**
 * EXACT area of the union of a box set (overlaps counted once).
 *
 * Overlaps have to be counted once or the cap could be spent twice by the same pixels:
 * two identical 8% rects would read as 16% masked and be refused for hiding 8%.
 * Coordinate compression makes it exact and cheap for the handful of rects the cap allows.
 */
export function unionArea(boxes: readonly PixelBox[]): number {
  const live = boxes.filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  if (live.length === 0) return 0;
  const xs = [...new Set(live.flatMap((b) => [b.x0, b.x1]))].sort((p, q) => p - q);
  const ys = [...new Set(live.flatMap((b) => [b.y0, b.y1]))].sort((p, q) => p - q);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    for (let j = 0; j + 1 < ys.length; j += 1) {
      const x = xs[i]!;
      const y = ys[j]!;
      const covered = live.some((b) => b.x0 <= x && b.x1 > x && b.y0 <= y && b.y1 > y);
      if (covered) area += (xs[i + 1]! - x) * (ys[j + 1]! - y);
    }
  }
  return area;
}

/**
 * The masked fraction of ONE capture's frame: the union area of the rects in force for
 * it, over the full frame. The number the cap is applied to, and the number every
 * consent sentence prints.
 */
export function maskedFractionFor(
  rects: readonly MaskRect[],
  captureId: string | undefined,
  frameWidth: number,
  frameHeight: number,
): number {
  const total = frameWidth * frameHeight;
  if (!(total > 0)) return 0;
  return unionArea(maskPixelBoxes(rects, captureId, frameWidth, frameHeight)) / total;
}

/**
 * THE ONE MASK PREDICATE, used by the `trace mask` stamp verb AND by the manifest
 * reader (Q1).
 *
 * A stamp-time-only cap is theatre: the manifest is a JSON file an operator can edit, so
 * "mask the whole frame" would be one text editor away from a permanently green pixel
 * gate. A read-time-only cap would let the CLI print a cheerful success for a manifest it
 * had just made unreadable. Both sides call THIS, so the refusal sentence, the cap and
 * the bounds rule cannot drift apart, and neither side can be "simplified" without a
 * test on the other side going red.
 *
 * REFUSES ON AN ABSENT BINDING, never skips: masks with no stamped frame dimensions
 * cannot be measured against the cap, so they are refused rather than waved through.
 * `value` is `unknown` because the read side hands it straight off a parsed JSON.
 */
export function maskRefusal(
  value: unknown,
  frameWidth: number | undefined,
  frameHeight: number | undefined,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return `'maskRects' must be an array (got ${typeof value})`;
  }
  if (value.length === 0) return null;
  if (value.length > MAX_MASK_RECTS) {
    return `'maskRects' has ${value.length} rects, above the ${MAX_MASK_RECTS} limit`;
  }
  // THE BOUND FIELD IS ABSENT -> REFUSE (never skip). Without the frame dimensions there
  // is no denominator, so the cap cannot be computed, so nothing can be trusted about how
  // much of the frame these rects hide.
  if (
    typeof frameWidth !== "number" ||
    typeof frameHeight !== "number" ||
    !Number.isInteger(frameWidth) ||
    !Number.isInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return (
      "'maskRects' is stamped but 'frameWidth'/'frameHeight' are absent or unusable: " +
      "the masked fraction cannot be measured against the " +
      `${driftPercentText(MAX_MASKED_FRACTION)}% cap, so the masks cannot be trusted`
    );
  }
  const rects: MaskRect[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `'maskRects[${i}]' is not an object`;
    }
    const r = entry as Record<string, unknown>;
    for (const field of ["x", "y", "w", "h"] as const) {
      const n = r[field];
      if (typeof n !== "number" || !Number.isInteger(n)) {
        return `'maskRects[${i}].${field}' must be an integer (got ${JSON.stringify(n) ?? typeof n})`;
      }
    }
    const { x, y, w, h } = r as unknown as RectGeometry;
    if (w <= 0 || h <= 0) return `'maskRects[${i}]' must have positive w and h (got ${w}x${h})`;
    if (x < 0 || y < 0 || x + w > frameWidth || y + h > frameHeight) {
      return (
        `'maskRects[${i}]' (${x},${y},${w}x${h}) falls outside the ${frameWidth}x${frameHeight} frame: ` +
        "a rect that does not land on the frame masks nothing it claims to"
      );
    }
    if (typeof r.reason !== "string" || r.reason.trim().length === 0) {
      return (
        `'maskRects[${i}]' has no reason: every mask needs one, because a region nobody ` +
        "will ever grade again has to say why in the anchor itself"
      );
    }
    if (r.captureId !== undefined && (typeof r.captureId !== "string" || r.captureId.length === 0)) {
      return `'maskRects[${i}].captureId' must be a non-empty string when present`;
    }
    rects.push({
      x,
      y,
      w,
      h,
      reason: r.reason,
      ...(r.captureId !== undefined ? { captureId: r.captureId as string } : {}),
    });
  }
  // THE CAP, PER CAPTURE (Q2). A trace-wide rect and a capture-scoped one both cover the
  // same frame, so they are measured together for every capture id that appears.
  const scopes = new Set<string | undefined>([undefined, ...rects.map((r) => r.captureId)]);
  for (const scope of scopes) {
    const fraction = maskedFractionFor(rects, scope, frameWidth, frameHeight);
    if (fraction > MAX_MASKED_FRACTION) {
      const where = scope === undefined ? "every capture" : `capture '${scope}'`;
      return (
        `'maskRects' hides ${driftPercentText(fraction)}% of the frame for ${where}, above the ` +
        `${driftPercentText(MAX_MASKED_FRACTION)}% cap: beyond it the pixel comparison is vacuous. ` +
        "Mask the animating region, not the game"
      );
    }
  }
  return null;
}

// ── drift analysis: bounds, the two-run sha, and the cluster suggestion ──────

/** Bounding box, diff sha and (when it fits) the tight rects, for one drifted frame. */
function analyzeDrift(
  bitmap: Uint8Array,
  W: number,
  H: number,
  diffPixels: number,
): Pick<VisualDiff, "driftDiffSha" | "driftBounds" | "driftClusters"> {
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (bitmap[y * W + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const clusters = clusterDriftRects(bitmap, W, H, diffPixels);
  return {
    // THE TWO-RUN DISCRIMINATOR'S EVIDENCE (Q3). Hashing the drift BITMAP rather than the
    // frame answers one question exactly: did the same pixels move, or different ones? A
    // deterministic change (the game really did change) reproduces byte for byte; ambient
    // nondeterminism does not.
    driftDiffSha: createHash("sha256").update(bitmap).digest("hex"),
    ...(maxX >= 0 ? { driftBounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } } : {}),
    ...(clusters ? { driftClusters: clusters } : {}),
  };
}

/**
 * Cluster the drifted pixels into at most {@link MAX_SUGGESTED_RECTS} rects that a human
 * could honestly mask, or null when the drift is DIFFUSE.
 *
 * Connected components (8-connectivity), then greedy agglomeration of the pair of boxes
 * whose merged bounding box is smallest, until three remain. The result is refused unless
 * it is TIGHT (drifted pixels / covered area >= {@link MIN_CLUSTER_TIGHTNESS}) and fits
 * under {@link MAX_MASKED_FRACTION}. Both refusals matter: a loose cluster set would blind
 * a large region to hide a sparse drift, which is the laundering the cap exists to stop,
 * and it would be wearing a tool recommendation as cover.
 */
export function clusterDriftRects(
  bitmap: Uint8Array,
  W: number,
  H: number,
  diffPixels: number,
): RectGeometry[] | null {
  if (diffPixels === 0) return null;
  const seen = new Uint8Array(W * H);
  let boxes: PixelBox[] = [];
  const stack: number[] = [];
  for (let start = 0; start < bitmap.length; start += 1) {
    if (bitmap[start] !== 1 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let x0 = start % W;
    let x1 = x0 + 1;
    let y0 = Math.floor(start / W);
    let y1 = y0 + 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y + 1 > y1) y1 = y + 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (bitmap[n] !== 1 || seen[n] === 1) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    boxes.push({ x0, y0, x1, y1 });
    // Scattered sub-pixel noise produces components without end; past the bound no set of
    // three rects covers them without covering the frame, so stop and say diffuse.
    if (boxes.length > MAX_DRIFT_COMPONENTS) return null;
  }

  while (boxes.length > MAX_SUGGESTED_RECTS) {
    let best: { i: number; j: number; area: number } | null = null;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const merged = mergeBox(boxes[i]!, boxes[j]!);
        const area = (merged.x1 - merged.x0) * (merged.y1 - merged.y0);
        if (best === null || area < best.area) best = { i, j, area };
      }
    }
    if (best === null) break;
    const chosen = best;
    const merged = mergeBox(boxes[chosen.i]!, boxes[chosen.j]!);
    boxes = boxes.filter((_, k) => k !== chosen.i && k !== chosen.j);
    boxes.push(merged);
  }

  const area = unionArea(boxes);
  if (area === 0) return null;
  if (diffPixels / area < MIN_CLUSTER_TIGHTNESS) return null;
  if (area / (W * H) > MAX_MASKED_FRACTION) return null;
  return boxes
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }))
    .sort((p, q) => p.y - q.y || p.x - q.x);
}

function mergeBox(a: PixelBox, b: PixelBox): PixelBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// ── the drift vocabulary (pure; shared by both doors) ────────────────────────

/**
 * A fraction as a percentage NUMBER string, at most two decimals, trailing zeros
 * trimmed: 0.02 -> "2", 0.005 -> "0.5", 0.013 -> "1.3". One formatter, so the
 * tolerance in a stamp, in a plan line and in a suggestion cannot be spelled three
 * ways for the same value.
 */
export function driftPercentText(fraction: number): string {
  return String(Number((fraction * 100).toFixed(2)));
}

/**
 * The CONSENT SENTENCE for an approved tolerance (A2).
 *
 * A tolerance is not a knob, it is a hole of a stated size, and the human stamping it
 * has to be told how big. A tolerance of N (as a fraction of all pixels) is spent
 * worst-case by one contiguous rectangle of area N, i.e. sqrt(N) of the frame's width
 * by sqrt(N) of its height: at 2%, a ~14% by ~14% block of the frame can change with
 * no refusal. Printed at the stamp AND on the unified plan line, because a silent
 * tolerance is the failure mode this whole feature has to avoid.
 */
export function toleranceConsentSentence(tolerance: number): string {
  if (tolerance <= 0) return "at 0%, every pixel must match exactly";
  const side = Math.round(Math.sqrt(tolerance) * 100);
  return (
    `at ${driftPercentText(tolerance)}%, anything covering up to ~${side}% of frame width ` +
    `by ~${side}% of height can change undetected`
  );
}

/**
 * THE ONE COMBINED CONSENT SENTENCE (Q4): what this anchor hides, both ways, in one
 * place.
 *
 * The two allowances are one decision and have to be read as one: 4% of the frame
 * blanked outright PLUS a 1.5% tolerance over what is left is a different promise from
 * either half alone, and an operator told about them in two separate lines (or in two
 * separate verbs, on two separate days) will not add them up. Returns null when there is
 * nothing to disclose (no masks, default tolerance), because the default is the
 * strictest thing the fields can hold and a line about it says nothing new.
 *
 * Used by `trace mask`, `trace tolerance`, the unified plan line, the replay summary and
 * the HTML report header, so no door can describe this anchor's terms differently.
 */
export interface AnchorTerms {
  /** How many approved mask rects are in force. 0 = the whole frame is graded. */
  maskCount: number;
  /** The WORST frame's masked fraction, in [0,1]. */
  maskedFraction: number;
  /** How many of those rects are scoped to a single capture (so not every frame is equal). */
  scopedCount: number;
  /** The tolerance the UNMASKED remainder grades at. */
  tolerance: number;
}

export function anchorTermsSentence(terms: AnchorTerms): string | null {
  if (terms.maskCount === 0) {
    return terms.tolerance === DEFAULT_DRIFT_FRACTION
      ? null
      : `drift tolerance ${driftPercentText(terms.tolerance)}%: ${toleranceConsentSentence(terms.tolerance)}`;
  }
  const scope =
    terms.scopedCount === 0
      ? "every frame"
      : `a frame (${terms.scopedCount} of them scoped to one capture)`;
  return (
    `${terms.maskCount} mask(s) hide ${driftPercentText(terms.maskedFraction)}% of ${scope} outright; ` +
    `the rest grades ${toleranceConsentSentence(terms.tolerance)}`
  );
}

/**
 * The {@link AnchorTerms} for a rect list measured against a frame. The bridge between
 * "I have the manifest" callers (the stamp verbs, the replay summary, the HTML header)
 * and the one sentence; the unified plan builds the same struct from typed row fields it
 * already carries, so both reach the same words without re-measuring anything.
 *
 * The masked fraction is the WORST frame's: with capture-scoped rects the frames are not
 * all hidden equally, and the honest number to disclose is the largest one.
 */
export function maskAnchorTerms(
  rects: readonly MaskRect[],
  frameWidth: number,
  frameHeight: number,
  tolerance: number,
): AnchorTerms {
  const scopes = new Set<string | undefined>([undefined, ...rects.map((r) => r.captureId)]);
  let worst = 0;
  for (const scope of scopes) {
    worst = Math.max(worst, maskedFractionFor(rects, scope, frameWidth, frameHeight));
  }
  return {
    maskCount: rects.length,
    maskedFraction: worst,
    scopedCount: rects.filter((r) => r.captureId !== undefined).length,
    tolerance,
  };
}

/** The measured drift of one replay run, as both doors report it. */
export interface DriftFacts {
  /** Captures whose diff fraction exceeded the tolerance in force. */
  driftCaptures: number;
  /** The largest diff fraction observed across compared captures, in [0,1]. */
  maxDiffFraction: number;
  /** The tolerance that decided those statuses (the approved one, or the default). */
  toleranceUsed: number;
  /**
   * Q7: the largest fraction of a frame that was BLANKED before comparing, in [0,1]. It
   * qualifies every drift number in this struct: a "max 1.3%" measured with 4% of the
   * frame blacked out is a different claim from the same number measured over the whole
   * frame, and the lines below say so whenever it is non-zero. 0 (the default) prints
   * nothing, so an unmasked run reads exactly as it always did.
   */
  maskedFraction?: number;
}

/**
 * The masked qualifier appended to a drift line, or "" when nothing was masked. One
 * spelling, so the trace verb and the unified section cannot describe the same blanked
 * region two ways.
 */
function maskedQualifier(facts: DriftFacts): string {
  const masked = facts.maskedFraction ?? 0;
  if (masked <= 0) return "";
  return ` (${driftPercentText(masked)}% of the frame is masked and cannot differ)`;
}

/**
 * THE RED LINE, leading with the failing word (A3).
 *
 * "pass (exit 1)" was the display dishonesty this replaces: the artifact really did
 * pass its actuation, so the engine's own status word is `pass`, and printing that
 * word next to a 1 taught readers that exit codes are noise. The line now names the
 * thing that failed first and keeps the actuation result as the qualifier.
 */
export function driftRegressionLine(facts: DriftFacts & { exitTier: number }): string {
  return (
    `pixel-drift regression (exit ${facts.exitTier}): actuation passed, ` +
    `${facts.driftCaptures} capture(s) over tolerance, max ${driftPercentText(facts.maxDiffFraction)}%` +
    maskedQualifier(facts)
  );
}

/**
 * The tolerance to SUGGEST for an observed max drift (A6): three decimals, a fixed
 * 0.002 of headroom above the observed ceiling, capped. No floor, so a tiny drift
 * suggests a tiny tolerance rather than being rounded up to a generous one.
 */
export function suggestedDriftTolerance(maxDiffFraction: number): number {
  const ceilTo3 = Math.ceil(maxDiffFraction * 1000) / 1000;
  return Math.min(MAX_DRIFT_TOLERANCE, Number((ceilTo3 + 0.002).toFixed(3)));
}

/**
 * THE SUGGESTION LOOP (R1/A6): what to print when a replay failed ONLY on pixel drift.
 *
 * It names `trace tolerance`, NEVER `trace approve` (A1): approve re-freezes frames, so
 * an operator following an approve-shaped suggestion would promote the drifted frames
 * and destroy the anchor they were trying to keep. `trace tolerance` stamps the
 * allowance onto the EXISTING baseline and touches no PNG.
 *
 * The caller is responsible for never calling this on a harness fault (an unreadable
 * PNG is not drift, and suggesting a wider tolerance for it would be advice to paper
 * over a broken capture).
 */
export function driftSuggestionLines(input: DriftFacts & { traceId: string }): string[] {
  const observed =
    `pixel drift only: max ${driftPercentText(input.maxDiffFraction)}% across ` +
    `${input.driftCaptures} capture(s)${maskedQualifier(input)}`;
  if (input.toleranceUsed >= MAX_DRIFT_TOLERANCE) {
    return [
      `${observed}; the approved tolerance is already at the ${driftPercentText(MAX_DRIFT_TOLERANCE)}% cap, ` +
        "so this is drift to investigate, or to MASK if it is localized ambient animation " +
        `(\`loombridge trace mask --id ${input.traceId} --list\`).`,
    ];
  }
  const suggested = suggestedDriftTolerance(input.maxDiffFraction);
  return [
    `${observed}; if this game animates, re-approve the tolerance with ` +
      `\`loombridge trace tolerance --id ${input.traceId} --set ${suggested}\``,
    `this value applies to every capture in the trace: ${toleranceConsentSentence(suggested)}.`,
  ];
}

// ── the mask suggestion, and the two-run discriminator that gates it ─────────

/** What one capture's comparison observed, as the suggestion needs to read it. */
export interface CaptureDriftEvidence {
  captureId: string;
  drifted: boolean;
  /** sha256 of the drift bitmap, when this capture drifted. */
  driftDiffSha?: string;
  driftBounds?: RectGeometry;
  /** The tight rects that would cover this capture's drift, absent when diffuse. */
  driftClusters?: RectGeometry[];
}

/**
 * The four things the tool may honestly say about masking an observed drift.
 *
 * `suggest` is the ONLY one that names rects, and it is the hardest to reach on purpose:
 * everything else is a reason not to mask yet.
 */
export type MaskSuggestion =
  | { kind: "first-run" }
  | { kind: "identical"; captures: string[] }
  | { kind: "diffuse" }
  | { kind: "suggest"; rects: MaskRect[]; captures: number; fraction: number };

/** The placeholder reason a suggested command carries until a human replaces it. */
export const SUGGESTED_MASK_REASON = "ambient-animation";

/**
 * THE TWO-RUN DISCRIMINATOR (Q3).
 *
 * A mask is permanent blindness in a region of the frame, so the bar for suggesting one
 * is not "something moved" but "something moves DIFFERENTLY every run". One run cannot
 * tell those apart: a real regression and an ambient animation layer look identical in a
 * single report. So:
 *
 *  - no previous evidence at all -> say so and ask for a second run. Never a rect.
 *  - the SAME drift bitmap twice -> that is deterministic. The game changed, and masking
 *    it would erase the finding. This is the case that makes the whole feature safe, and
 *    it wins over every other branch when any capture exhibits it.
 *  - drift in overlapping regions with DIFFERENT bitmaps -> nondeterministic, and the
 *    rects are offered (still only when they cluster tightly enough to be honest).
 *
 * Pure, so both doors derive the same suggestion from the same two reports.
 */
export function deriveMaskSuggestion(
  current: readonly CaptureDriftEvidence[],
  previous: readonly CaptureDriftEvidence[],
  frameWidth: number,
  frameHeight: number,
): MaskSuggestion | null {
  const drifted = current.filter((c) => c.drifted);
  if (drifted.length === 0) return null;
  const previousById = new Map(previous.map((p) => [p.captureId, p]));

  const identical: string[] = [];
  const nondeterministic: CaptureDriftEvidence[] = [];
  for (const capture of drifted) {
    const before = previousById.get(capture.captureId);
    if (!before?.drifted || before.driftDiffSha === undefined || capture.driftDiffSha === undefined) {
      continue;
    }
    if (before.driftDiffSha === capture.driftDiffSha) {
      identical.push(capture.captureId);
      continue;
    }
    // Different bitmaps, but in the SAME part of the frame: an ambient layer redrawing
    // itself. Two drifts in unrelated regions are two findings, not one mask.
    if (before.driftBounds && capture.driftBounds && overlaps(before.driftBounds, capture.driftBounds)) {
      nondeterministic.push(capture);
    }
  }
  if (identical.length > 0) return { kind: "identical", captures: identical.sort() };
  if (nondeterministic.length === 0) return { kind: "first-run" };
  if (nondeterministic.some((c) => c.driftClusters === undefined)) return { kind: "diffuse" };

  const rects: MaskRect[] = [];
  for (const capture of nondeterministic) {
    for (const rect of capture.driftClusters ?? []) {
      rects.push({ ...rect, captureId: capture.captureId, reason: SUGGESTED_MASK_REASON });
    }
  }
  // The cap has the last word even here: a per-capture cluster set that fits individually
  // must still fit as the list that would be stamped.
  if (maskRefusal(rects, frameWidth, frameHeight) !== null) return { kind: "diffuse" };
  let worst = 0;
  for (const capture of nondeterministic) {
    worst = Math.max(worst, maskedFractionFor(rects, capture.captureId, frameWidth, frameHeight));
  }
  return { kind: "suggest", rects, captures: nondeterministic.length, fraction: worst };
}

function overlaps(a: RectGeometry, b: RectGeometry): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** `x,y,wxh`, the geometry spelling the `--set` flag parses back. One formatter. */
export function formatRectGeometry(rect: RectGeometry): string {
  return `${rect.x},${rect.y},${rect.w}x${rect.h}`;
}

/** One `--set` flag for a suggested rect, exactly as it must be typed. */
export function formatMaskSetFlag(rect: MaskRect): string {
  const prefix = rect.captureId === undefined ? "" : `${rect.captureId}:`;
  return `--set ${prefix}${formatRectGeometry(rect)}@${rect.reason}`;
}

/**
 * The human-facing lines for a mask suggestion, identical at both doors.
 *
 * The `identical` wording is VERBATIM and load-bearing: it is the one line that stands
 * between an operator and masking a real regression they were about to be told was
 * ambient noise.
 */
export function maskSuggestionLines(suggestion: MaskSuggestion, traceId: string): string[] {
  switch (suggestion.kind) {
    case "first-run":
      return ["re-run replay once more to characterize the drift before masking."];
    case "identical":
      return [
        "the drift is IDENTICAL across two runs: that is a deterministic change, not ambient noise; " +
          "investigate before masking.",
      ];
    case "diffuse":
      return [
        "drift is diffuse; masks cannot cover it honestly. A mask is a region, and this drift is not one: " +
          "investigate it, or record the game-time alignment limit (see the RFC).",
      ];
    case "suggest": {
      const bounds = boundingRect(suggestion.rects);
      const command = `loombridge trace mask --id ${traceId} ${suggestion.rects.map(formatMaskSetFlag).join(" ")}`;
      return [
        `drift concentrates in ${formatRectGeometry(bounds)} across ${suggestion.captures} capture(s); ` +
          `if this region is ambient animation, mask it: ${command}`,
        `that masks ${driftPercentText(suggestion.fraction)}% of the frame (cap ` +
          `${driftPercentText(MAX_MASKED_FRACTION)}%) and is NEVER applied for you; ` +
          `replace @${SUGGESTED_MASK_REASON} with what actually animates there, because the reason is ` +
          "the only record of why those pixels stopped being graded.",
      ];
    }
  }
}

function boundingRect(rects: readonly RectGeometry[]): RectGeometry {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x1 - x, h: y1 - y };
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
