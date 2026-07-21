/**
 * Tier-1 gate report types — the common shape every deterministic gate
 * evaluator emits, plus the aggregated build verdict.
 *
 * Each evaluator is a PURE function `(opOutput, acceptance) -> GateReport`, so
 * it is fully unit-testable from captured op-output fixtures with no live
 * editor. Live orchestration (calling the ops + feeding their output in) is
 * Phase E/F; the recipe for that wiring is documented in `README.md`.
 */

/** A single check result. */
export type CheckStatus = "pass" | "warn" | "fail" | "not_applicable";

/**
 * Optional structured geometry for a check, so the report can DRAW it (not just
 * describe it). Carried alongside the human `detail` string — present only for the
 * checks that have a rect (safe-area today); absent everywhere else.
 */
export interface GateCheckAnnotation {
  /** Element's normalized viewport rect, bottom-left origin, 0..1 (as captured). */
  rect: { x: number; y: number; width: number; height: number };
  /** Safe-area inset fractions of the frame (top/bottom/left/right). */
  safeInsets?: { top: number; bottom: number; left: number; right: number };
  /** Which edge overflowed and by how much (fraction of frame). Present on fail. */
  overflow?: { edge: "left" | "right" | "top" | "bottom"; fraction: number };
  /** Frame pixel size, to turn fractions into px in the copy. */
  viewport?: { width: number; height: number };
  /** The element's scene locator, e.g. "CountTheFruits:/HUD/HomeButton". */
  locator?: string;
  /** Tap-target sizing (present on a tap-target-size finding): the measured size vs the floor,
   * so the report draws the control + a "Ndp · needs ≥Mdp" badge instead of a safe-area box. */
  tapTarget?: { actualDp: number; minDp: number };
  /** Set by the sweep when the flagged element is an INTERACTIVE control (`raycastTarget`), so the
   * report never buckets a real control as "likely background" / proposes its container to exempt. */
  interactive?: boolean;
}

/**
 * One drawable cut-edge seam: the exposed edge of a background layer that shows
 * inside the camera frame. Coordinates are normalized TOP-origin (image space),
 * clamped to [0,1], so the report can draw the line + strip directly over the
 * gameplay screenshot (unlike `GateCheckAnnotation.rect`, which is bottom-origin).
 */
export interface SeamSegment {
  edge: "bottom" | "left" | "right";
  /** The layer's scene locator, e.g. "CountTheFruits:/Background/Ground". */
  layerLocator: string;
  /** normalized, TOP-origin, 0..1: the cut-edge line. */
  line: { x0: number; y0: number; x1: number; y1: number };
  /** normalized, TOP-origin: the exposed strip to shade (cut edge → frame edge). */
  strip: { x: number; y: number; width: number; height: number };
  /** exposed depth as a fraction of the frame (for px copy). */
  exposedFraction: number;
}

/**
 * Structured geometry for the `background-seam` gate so the report can DRAW each
 * flagged layer's cut edge (a red line + a shaded exposed strip) over the gameplay
 * screenshot. The seam gate has no screen of its own, so `verify-minigame` resolves
 * `screenshotKey` to a gameplay state's `<state>@<device>` thumbnail to draw on.
 */
export interface SeamAnnotation {
  /** Frame pixel size, to turn the exposed fraction into px copy. */
  viewport?: { width: number; height: number };
  /** `<state>@<device>` screenshot to draw on. Set by verify-minigame; absent → plain card. */
  screenshotKey?: string;
  segments: SeamSegment[];
}

/** One atomic check within a gate. */
export interface GateCheck {
  /** Stable id, e.g. "font.ScoreLabel" or "anchor.player". */
  id: string;
  /** The spec/expected value, stringified for the report. */
  expected: string;
  /** The observed/actual value, stringified for the report. */
  actual: string;
  /** Outcome of this check. */
  status: CheckStatus;
  /** Human-readable one-line explanation. */
  detail: string;
  /** Optional structured geometry so the report can DRAW the check (not just describe it). */
  annotation?: GateCheckAnnotation;
  /** Optional cut-edge seam geometry (background-seam) so the report can draw the exposed edges. */
  seamAnnotation?: SeamAnnotation;
}

/** A gate's report: its name, all checks, and an aggregate verdict. */
export interface GateReport {
  /** Gate name, e.g. "ui-conformance". */
  gate: string;
  /** Every check this gate ran. */
  checks: GateCheck[];
  /** Worst status across checks: any fail -> fail, else any warn -> warn, else pass. */
  verdict: CheckStatus;
}

/** The aggregated Tier-1 build verdict (`build-verdict.json`). */
export interface BuildVerdict {
  /** Overall status. Tier-1 `fail` ⇒ fail; only warns ⇒ warn; else pass. */
  status: CheckStatus;
  /** Per-gate verdict keyed by gate name. */
  gates: Record<string, CheckStatus>;
  /** Flat list of every check from every gate. */
  checks: GateCheck[];
  /** Every check whose status is `fail`. */
  failures: GateCheck[];
  /** Every check whose status is `warn`. */
  warnings: GateCheck[];
}

/** Worst-of reducer over a set of statuses. */
export function worstStatus(statuses: CheckStatus[]): CheckStatus {
  const applicable = statuses.filter((status) => status !== "not_applicable");
  if (applicable.includes("fail")) return "fail";
  if (applicable.includes("warn")) return "warn";
  if (applicable.length === 0) return "not_applicable";
  return "pass";
}

/** Roll a gate's checks up into a GateReport. */
export function makeGateReport(gate: string, checks: GateCheck[]): GateReport {
  return { gate, checks, verdict: worstStatus(checks.map((c) => c.status)) };
}
