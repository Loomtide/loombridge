/**
 * F3 — behavioral mechanism PRESENCE interpreters + the `mechanisms` gate.
 *
 * Bands check metric VALUES; this module checks which movement CAPABILITIES exist.
 * The F1 hole (#166): omitting a *metric* is not a statement that the *mechanic* is
 * absent — a live air-dash passed `classic` because `classic` simply omitted dash
 * metrics. A profile's `mechanisms: { requires, forbids }` block states presence/
 * absence; this gate verifies it from a captured TRAJECTORY signature.
 *
 * SOURCE OF TRUTH = behavioral signature, never a controller self-report. A
 * `forceDash`/`forceJump` hook would only work on games Loomtide built (the verify
 * wedge must survive games it didn't) and is the controller self-grading "I have a
 * dash" — §3a-adjacent. So every interpreter here reads only the captured
 * `{tMs,x,y}[]` trajectory (the same shape feel-derive consumes) and, where the
 * derivation already exists in feel-derive, REUSES it unchanged
 * (`deriveFallGravityMultiplier`, `interpretBisection`).
 *
 * REFUSE-DON'T-SKIP (the moat — mirrors CLAUDE.md "an absent binding is a refusal"):
 * an interpreter returns `present: boolean | null`, where `null` = UNPROBEABLE (no
 * usable capture / undrivable). The gate turns a manifest mechanism with no usable
 * evidence into a REFUSAL (the gate cannot pass), never a silent skip. A
 * `requires`-absent or `forbids`-present is a FAIL that gates the verdict — a
 * mechanism mismatch is a definitional identity violation, unlike the unbanded
 * `alsoMeasured` which never gates.
 *
 * All functions pure + editor-free; fully unit-testable from synthetic trajectories.
 */

import type { FeelTrajectorySample } from "../../../verification/gates/feel.js";
import {
  deriveFallGravityMultiplier,
  deriveJumpApex,
  interpretBisection,
  isValidTrajectory,
  type BisectionTrial,
} from "../../../verification/feel-derive.js";
import {
  KNOWN_MECHANISM_SET,
  type MechanismId,
  type PlatformerFeelProfile,
} from "./types.js";

/** A presence read: PRESENT (true), ABSENT (false), or UNPROBEABLE (null → refuse). */
export interface PresenceResult {
  present: boolean | null;
  /** Why it could not be probed (set iff present === null). */
  reason?: string;
}

// ── airDash ──────────────────────────────────────────────────────────────────
//
// SIGNATURE: a horizontal velocity SPIKE far beyond the steady run speed. A dash is
// a discrete burst much faster than moveSpeed (dashSpeed ≫ moveSpeed), so the PEAK
// per-tick speed during a captured run far exceeds the controller's steady run
// speed. We don't band the dash — this is a coarse presence read.
//
// THRESHOLD: peak tick-speed > AIR_DASH_SPIKE_FACTOR × steadyRunSpeed.
//
// SIGNAL CHOICE — multiplicative ratio (peak/cruise), NOT an absolute margin.
// We considered three shapes against the two failure modes below:
//   (a) absolute margin (peak − cruise > K u/s): rejected. The cruise IS the
//       trajectory-derived run speed; an absolute K can't be both above a fast run's
//       wobble (which scales WITH cruise — a 14 u/s run wobbles in absolute u/s more
//       than a 9 u/s run) and below a slow run's dash. A fixed K calibrated on one
//       run speed false-positives or false-negatives on another. The ratio is the
//       only scale-free separator that survives the profile-swap (the whole F3 bug
//       was a fixed assumption that didn't survive a run-speed change).
//   (b) dash distance/duration: rejected for this gate — it needs a dash-window
//       segmentation we don't have from a plain run capture; over-engineered for a
//       coarse presence read.
//   (c) multiplicative ratio: CHOSEN. Robust to run speed by construction.
//
// CALIBRATION — pinned to a REAL controller (tiderunner), not the Celeste assumption.
// The prior 2.5× assumed dash ≫ run (Celeste ~5×). tiderunner's dash is a FIXED
// 18.75 u/s, so the ratio shrinks as the profile's run speed rises:
//   precision (run 9):  18.75/9  = 2.08×  ← a genuine dash that 2.5× MISSED (the bug)
//   classic   (run 7):  18.75/7  = 2.68×  ← detected by both 2.5× and 1.8×
//   momentum  (run 14): 18.75/14 = 1.34×  ← see MOMENTUM EDGE below
//
// FAILURE MODE (a) — catch a genuine dash: precision's real 2.08× must read PRESENT.
//   1.8× < 2.08× ✓ (and < classic's 2.68×). Headroom above the threshold: ~0.28×.
// FAILURE MODE (b) — reject a fast-but-dashless run: a plain run's SUSTAINED-2-tick
//   peak (the min of each adjacent interval pair, so a single partial-injection or
//   teleport tick can't lift it) sits at ~1.0–1.2× of the derived cruise — the
//   sustained-peak discipline (sustainedPeakSpeed) caps wobble there. So the dead
//   zone between dashless wobble (≤ ~1.2×) and the threshold (1.8×) is ~0.6× wide —
//   wider headroom on the reject side than the ~0.28× on the catch side, which is
//   the right bias (a false "dash present" is a definitional identity violation).
//   1.8× also still clears the single-tick-glitch (handled by sustainedPeak) and the
//   1.5× over-speed-wobble fixture.
//
// MOMENTUM EDGE — DOCUMENTED LIMITATION, deliberately NOT caught. At run 14 the same
//   18.75 dash is only 1.34× (+34%). +34% over cruise is inside the band a fast,
//   bursty-but-dashless run can reach (acceleration ramps, partial-injection
//   over-reads sustained over 2 ticks), so a threshold low enough to catch +34% (≤
//   ~1.3×) would start false-positiving plain runs — collapsing the reject-side dead
//   zone we rely on for failure mode (b). We accept that a dash adding only ~34% over
//   run is below confident behavioral detection and is read ABSENT. This is INERT
//   today: momentum's mechanisms manifest is empty (no requires/forbids airDash), so
//   the miss gates nothing. If a future profile with run ≈ dash/1.4 wants airDash
//   gated, it must supply a discrete dash-segment capture (distance/duration signal),
//   not a peak-ratio on a plain run. The regression test pins this 1.34× → absent so
//   the limitation is explicit, not accidental.

/** Peak tick-speed must exceed this multiple of the steady run speed to read as a dash. */
export const AIR_DASH_SPIKE_FACTOR = 1.8;

/** Per-interval horizontal speeds (|Δx|/Δt, u/s) across a trajectory. */
function tickSpeeds(samples: FeelTrajectorySample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtSec = (samples[i].tMs - samples[i - 1].tMs) / 1000;
    if (dtSec <= 0) continue;
    out.push(Math.abs(samples[i].x - samples[i - 1].x) / dtSec);
  }
  return out;
}

/**
 * Median of the MOVING tick speeds (the steady cruise), derived from the trajectory
 * itself — NOT a self-reported scalar. The median is robust to the dash burst (a
 * short minority of ticks) and to the partial-injection tick, so it recovers the run
 * cruise the dash spike is measured against.
 */
function derivedCruiseSpeed(speeds: number[]): number {
  const moving = speeds.filter((s) => s > 0.01).sort((a, b) => a - b);
  if (moving.length === 0) return 0;
  const mid = Math.floor(moving.length / 2);
  return moving.length % 2 === 1 ? moving[mid] : (moving[mid - 1] + moving[mid]) / 2;
}

/**
 * Peak speed that PERSISTS over ≥2 consecutive ticks (the min of each adjacent pair,
 * maximized). A real dash is a multi-tick burst; a single-tick position glitch
 * (respawn / screen-wrap / teleport / partial-injection artifact) spikes one interval
 * only and is rejected — mirroring feel-derive's ≥2-genuine-tick ramp discipline.
 */
function sustainedPeakSpeed(speeds: number[]): number {
  let peak = 0;
  for (let i = 1; i < speeds.length; i += 1) {
    const sustained = Math.min(speeds[i], speeds[i - 1]);
    if (sustained > peak) peak = sustained;
  }
  return peak;
}

export interface AirDashResult extends PresenceResult {
  peakSpeed?: number;
  steadyRunSpeed?: number;
}

/**
 * airDash signature: during a captured run with a dash injected, a speed spike that
 * PERSISTS ≥2 ticks exceeds `AIR_DASH_SPIKE_FACTOR` × the cruise speed.
 *
 * Behavioral-source-of-truth: the cruise reference is DERIVED from the same
 * trajectory (median of moving ticks), never trusted from a self-reported scalar. An
 * optional `suppliedRunSpeed` is only a cross-check — if it disagrees with the
 * trajectory-derived cruise by >20% the capture is refused (the dash reference must
 * come from the capture, not the harness). Unprobeable (null) when the trajectory is
 * unusable or shows no steady run motion.
 */
export function interpretAirDash(
  runTrajectory: FeelTrajectorySample[],
  suppliedRunSpeed?: number,
): AirDashResult {
  if (!isValidTrajectory(runTrajectory)) {
    return { present: null, reason: "run trajectory has fewer than 2 usable samples" };
  }
  const speeds = tickSpeeds(runTrajectory);
  const cruise = derivedCruiseSpeed(speeds);
  if (!(cruise > 0)) {
    return { present: null, reason: "no steady run motion in the trajectory — no dash reference" };
  }
  if (typeof suppliedRunSpeed === "number" && suppliedRunSpeed > 0) {
    const rel = Math.abs(suppliedRunSpeed - cruise) / cruise;
    if (rel > 0.2) {
      return {
        present: null,
        reason: `supplied steadyRunSpeed ${suppliedRunSpeed} disagrees with the trajectory-derived cruise ${cruise.toFixed(2)} u/s by >20% — refused (the dash reference must come from the capture, not a self-report).`,
      };
    }
  }
  const peak = sustainedPeakSpeed(speeds);
  return {
    present: peak > cruise * AIR_DASH_SPIKE_FACTOR,
    peakSpeed: peak,
    steadyRunSpeed: cruise,
  };
}

// ── variableJump ───────────────────────────────────────────────────────────
//
// SIGNATURE: a short TAP hop peaks meaningfully BELOW a full HOLD jump — i.e. an
// early release cuts the rise (the jump-cut works). Needs TWO captures: a tap and a
// hold. We reuse deriveJumpApex (peak Y above start) on each.
//
// THRESHOLD: tapApex < holdApex × VARIABLE_JUMP_RATIO. A controller with no cut
// produces ~equal apexes (ratio ~1); a real variable jump cuts the tap to a fraction
// of the full hop. 0.8 means "the tap must be at least 20% shorter than the hold" —
// comfortably above measurement noise on two captures, well below any real cut
// (Celeste/Mario tap ≈ 40–60% of full). Unprobeable when either capture is unusable.

/** A tap apex must be at most this fraction of the full-hold apex to read as a cut. */
export const VARIABLE_JUMP_RATIO = 0.8;

export interface VariableJumpResult extends PresenceResult {
  tapApex?: number;
  holdApex?: number;
}

export function interpretVariableJump(
  tapTrajectory: FeelTrajectorySample[],
  holdTrajectory: FeelTrajectorySample[],
  tapHoldMs: number,
  fullHoldMs: number,
): VariableJumpResult {
  if (!isValidTrajectory(tapTrajectory) || !isValidTrajectory(holdTrajectory)) {
    return { present: null, reason: "tap and/or hold trajectory has fewer than 2 usable samples" };
  }
  // The two captures must be the SAME jump input held for DIFFERENT durations (tap
  // shorter). Without that, a lower tap apex proves nothing — two unrelated fixed
  // jump heights would impersonate a cut. Requiring tapHold < fullHold means a
  // fixed-height controller (ignores hold) yields ~equal apexes → absent, while a
  // real variable jump (respects hold) cuts the tap → present. Refuse-don't-skip:
  // absent/non-positive/non-ordered durations are a refusal, not a skipped check.
  if (!(typeof tapHoldMs === "number" && typeof fullHoldMs === "number" && tapHoldMs > 0 && fullHoldMs > 0)) {
    return { present: null, reason: "tap/hold durations absent or non-positive — cannot confirm the captures differ only by hold time" };
  }
  if (!(tapHoldMs < fullHoldMs)) {
    return { present: null, reason: `tap hold (${tapHoldMs}ms) is not shorter than the full hold (${fullHoldMs}ms) — the captures do not isolate an early release; cannot test the cut` };
  }
  const tapApex = deriveJumpApex(tapTrajectory);
  const holdApex = deriveJumpApex(holdTrajectory);
  // A non-positive hold apex means the player never actually jumped on the full-hold
  // capture — we can't compare against a non-jump. Refuse.
  if (!(holdApex > 0)) {
    return { present: null, reason: "full-hold capture shows no jump (apex ≤ 0) — no reference" };
  }
  return {
    present: tapApex < holdApex * VARIABLE_JUMP_RATIO,
    tapApex,
    holdApex,
  };
}

// ── fallGravityAsymmetry ─────────────────────────────────────────────────────
//
// SIGNATURE: the fall accel differs from the rise accel — the multiplier
// (descentAccel/ascentAccel) is off 1 beyond a margin. REUSES feel-derive's
// deriveFallGravityMultiplier unchanged (which itself returns null for a half-arc /
// truncated capture → unprobeable). A symmetric arc reads ~1.0; a heavier fall > 1.
//
// THRESHOLD: |multiplier − 1| > FALL_ASYMMETRY_MARGIN. A clean symmetric arc
// re-derives within a few % of 1.0; the canonical "floaty rise, fast fall" targets
// 1.6–2.0×, well past the margin.
//
// NOISE-FLOOR CAVEAT (review): on a LIVE capture a plain single-gravity controller
// has measured ~0.79× (|m−1| = 0.21), only ~0.04 below this margin — so a noisier
// live capture of a symmetric controller could flip to "asymmetry present". This is
// inert today (no shipped profile requires/forbids fallGravityAsymmetry — it is
// defined-but-unused), but before a profile adopts it, widen the margin or add a
// live noise-floor calibration. 0.3 gives more headroom over the live-artifact floor.

/** The multiplier must differ from 1 by more than this to read as asymmetric. */
export const FALL_ASYMMETRY_MARGIN = 0.3;

export interface FallAsymmetryResult extends PresenceResult {
  multiplier?: number;
}

export function interpretFallGravityAsymmetry(
  jumpTrajectory: FeelTrajectorySample[],
): FallAsymmetryResult {
  if (!isValidTrajectory(jumpTrajectory)) {
    return { present: null, reason: "jump trajectory has fewer than 2 usable samples" };
  }
  const multiplier = deriveFallGravityMultiplier(jumpTrajectory);
  if (multiplier === null) {
    // half-arc / truncated capture — feel-derive could not honestly measure descent.
    return { present: null, reason: "no measurable descent in the capture (half/truncated arc)" };
  }
  return { present: Math.abs(multiplier - 1) > FALL_ASYMMETRY_MARGIN, multiplier };
}

// ── coyote / jumpBuffer (a forgiveness WINDOW) ───────────────────────────────
//
// SIGNATURE: a positive (non-null) bisection window. coyote = jump shortly AFTER
// leaving a ledge still jumps; jumpBuffer = jump shortly BEFORE landing still jumps.
// Both interpret the SAME bisection-trials shape via feel-derive's interpretBisection.
//
// PRESENCE mapping (the honest read of interpretBisection's result):
//   - a positive window           → PRESENT (the forgiveness window exists).
//   - "no trial jumped"           → ABSENT (boundary below the smallest delay tried —
//                                    no usable window: the mechanism isn't there).
//   - "every trial jumped"        → UNPROBEABLE (boundary is above the largest delay
//                                    tried — the trials never bracketed the edge, so
//                                    we can't honestly call it present OR absent → refuse).
//   - "no valid trials" / non-monotonic → UNPROBEABLE (refuse).

export interface WindowResult extends PresenceResult {
  windowSeconds?: number;
}

export function interpretWindowMechanism(trials: BisectionTrial[]): WindowResult {
  const bisection = interpretBisection(trials);
  if (bisection.windowSeconds !== null) {
    return { present: bisection.windowSeconds > 0, windowSeconds: bisection.windowSeconds };
  }
  const reason = bisection.reason ?? "no boundary";
  // "no trial jumped" is a CONFIDENT absence: every probed delay failed to jump, so
  // there is no forgiveness window — the mechanism is not present.
  if (reason.startsWith("no trial jumped")) {
    return { present: false, windowSeconds: 0 };
  }
  // Everything else (unbounded-above, no trials, non-monotonic) is unprobeable.
  return { present: null, reason };
}

// ── the mechanism evidence input + the gate ──────────────────────────────────
//
// The evidence shape mirrors how `measurements` is an OPTIONAL input to
// verify-profile: a minimal per-mechanism payload carrying exactly the captures its
// probe needs. A mechanism with NO key here (or an unusable capture) refuses.

/** Captured evidence for each probeable mechanism (any subset; minimal per probe). */
export interface MechanismEvidence {
  // steadyRunSpeed is OPTIONAL (cross-check only — the cruise is derived from the
  // trajectory; a disagreeing supplied value refuses).
  airDash?: { runTrajectory: FeelTrajectorySample[]; steadyRunSpeed?: number };
  // tapHoldMs/fullHoldMs prove the two captures are the SAME jump held for different
  // durations (tap shorter) — required so a height difference can read as a cut.
  variableJump?: {
    tapTrajectory: FeelTrajectorySample[];
    holdTrajectory: FeelTrajectorySample[];
    tapHoldMs: number;
    fullHoldMs: number;
  };
  fallGravityAsymmetry?: { jumpTrajectory: FeelTrajectorySample[] };
  coyote?: { trials: BisectionTrial[] };
  jumpBuffer?: { trials: BisectionTrial[] };
}

/** Run a mechanism's probe against the supplied evidence (null = no evidence). */
function probe(id: MechanismId, evidence: MechanismEvidence): PresenceResult {
  switch (id) {
    case "airDash": {
      const e = evidence.airDash;
      if (!e) return { present: null, reason: "no airDash evidence captured" };
      return interpretAirDash(e.runTrajectory, e.steadyRunSpeed);
    }
    case "variableJump": {
      const e = evidence.variableJump;
      if (!e) return { present: null, reason: "no variableJump evidence captured" };
      return interpretVariableJump(e.tapTrajectory, e.holdTrajectory, e.tapHoldMs, e.fullHoldMs);
    }
    case "fallGravityAsymmetry": {
      const e = evidence.fallGravityAsymmetry;
      if (!e) return { present: null, reason: "no fallGravityAsymmetry evidence captured" };
      return interpretFallGravityAsymmetry(e.jumpTrajectory);
    }
    case "coyote": {
      const e = evidence.coyote;
      if (!e) return { present: null, reason: "no coyote evidence captured" };
      return interpretWindowMechanism(e.trials);
    }
    case "jumpBuffer": {
      const e = evidence.jumpBuffer;
      if (!e) return { present: null, reason: "no jumpBuffer evidence captured" };
      return interpretWindowMechanism(e.trials);
    }
    default:
      return { present: null, reason: `unknown mechanism '${id}'` };
  }
}

/** Per-mechanism gate outcome. */
export type MechanismCheckResult = "present" | "absent" | "unprobed";

export interface MechanismCheck {
  id: string;
  /** "requires" (must be present) or "forbids" (must be absent). */
  expectation: "requires" | "forbids";
  /** What the behavioral probe found. */
  result: MechanismCheckResult;
  /** Does the probed result satisfy the expectation? (false for any unprobed). */
  ok: boolean;
  /** Human one-liner for the report. */
  detail: string;
}

/**
 * Gate verdict (mirrors the feel-rederive verdict shape):
 *  - `not_applicable` — the profile makes no mechanism claim (no `mechanisms` block).
 *  - `pass`           — every claim satisfied (and an empty block claims nothing).
 *  - `fail`           — at least one mismatch (a required mechanism absent, or a
 *                       forbidden one present) — a definitional identity violation.
 *  - `refused`        — a claimed mechanism could not be probed (no/unusable
 *                       evidence) and nothing FAILED. The gate cannot pass; the
 *                       metric is reported unprobed (never a silent skip).
 *
 * Precedence: any `fail` outranks any `refused` (a definitional violation gates over
 * an unprobed metric); a `refused` outranks `pass` (can't pass while a claim is unprobed).
 */
export type MechanismGateStatus = "pass" | "fail" | "refused" | "not_applicable";

export interface MechanismGateResult {
  status: MechanismGateStatus;
  checks: MechanismCheck[];
}

/**
 * Evaluate a profile's `mechanisms` block against captured evidence. Pure +
 * exported for tests. Refuse-don't-skip throughout: a claimed mechanism with no
 * usable evidence is `unprobed` (ok:false) and forces `refused`, never skipped.
 */
export function evaluateMechanisms(
  profile: PlatformerFeelProfile,
  evidence: MechanismEvidence,
): MechanismGateResult {
  const block = profile.mechanisms;
  if (block === undefined) {
    return { status: "not_applicable", checks: [] };
  }

  const checks: MechanismCheck[] = [];

  const run = (id: string, expectation: "requires" | "forbids"): void => {
    // Defensive: a non-vocabulary id should have been refused at validation; treat
    // it as unprobeable rather than silently skipping it.
    if (!KNOWN_MECHANISM_SET.has(id)) {
      checks.push({
        id,
        expectation,
        result: "unprobed",
        ok: false,
        detail: `${id}: not a known mechanism — cannot probe (validation should have refused this).`,
      });
      return;
    }
    const r = probe(id as MechanismId, evidence);
    if (r.present === null) {
      checks.push({
        id,
        expectation,
        result: "unprobed",
        ok: false,
        detail: `${id} (${expectation}): unprobed — ${r.reason ?? "no evidence"}. Cannot pass without a behavioral capture.`,
      });
      return;
    }
    const present = r.present;
    const ok = expectation === "requires" ? present : !present;
    checks.push({
      id,
      expectation,
      result: present ? "present" : "absent",
      ok,
      detail:
        expectation === "requires"
          ? `${id}: required and ${present ? "PRESENT → pass" : "ABSENT → fail (the mechanism is missing)"}.`
          : `${id}: forbidden and ${present ? "PRESENT → fail (a forbidden mechanism is live)" : "ABSENT → pass"}.`,
    });
  };

  for (const id of block.requires) run(id, "requires");
  for (const id of block.forbids) run(id, "forbids");

  if (checks.length === 0) {
    // An empty (but present) block claims nothing — a clean pass with no checks.
    return { status: "pass", checks };
  }

  const anyFail = checks.some((c) => c.result !== "unprobed" && !c.ok);
  if (anyFail) return { status: "fail", checks };
  const anyUnprobed = checks.some((c) => c.result === "unprobed");
  if (anyUnprobed) return { status: "refused", checks };
  return { status: "pass", checks };
}
