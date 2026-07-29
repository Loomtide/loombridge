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
 * can change undetected). Per-capture MASKS are the real fix and are not implemented.
 */
export const MAX_DRIFT_TOLERANCE = 0.02;

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
    // STRICTLY GREATER, so a fraction exactly EQUAL to the tolerance passes. Documented
    // rather than left to be discovered: an approved tolerance is a consented allowance,
    // and "up to N%" is what the consent sentence promises.
    status: fraction > driftFraction ? "drift" : "match",
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

/** The measured drift of one replay run, as both doors report it. */
export interface DriftFacts {
  /** Captures whose diff fraction exceeded the tolerance in force. */
  driftCaptures: number;
  /** The largest diff fraction observed across compared captures, in [0,1]. */
  maxDiffFraction: number;
  /** The tolerance that decided those statuses (the approved one, or the default). */
  toleranceUsed: number;
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
    `${facts.driftCaptures} capture(s) over tolerance, max ${driftPercentText(facts.maxDiffFraction)}%`
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
    `${input.driftCaptures} capture(s)`;
  if (input.toleranceUsed >= MAX_DRIFT_TOLERANCE) {
    return [
      `${observed}; the approved tolerance is already at the ${driftPercentText(MAX_DRIFT_TOLERANCE)}% cap, ` +
        "so this is drift to investigate (per-capture masks are the real fix and are not implemented yet).",
    ];
  }
  const suggested = suggestedDriftTolerance(input.maxDiffFraction);
  return [
    `${observed}; if this game animates, re-approve the tolerance with ` +
      `\`loombridge trace tolerance --id ${input.traceId} --set ${suggested}\``,
    `this value applies to every capture in the trace: ${toleranceConsentSentence(suggested)}.`,
  ];
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
