/**
 * Feel gate (§6).
 *
 * INPUT (measured via FeelHarness + `runtime.probe` recipes):
 *   {
 *     runSpeed?, jumpApex?, timeToApex?, dashDistance?,
 *     shortHopApex?, coyoteTime?, jumpBuffer?,  // any subset
 *     provenance?: { sources?: [...] }          // measurement evidence; enforced by feel-provenance
 *   }
 *
 * ACCEPTANCE: the `feel` section — each entry a `{ target, unit, band }` where
 * `band` is `{ percent }` (symmetric %) or `{ abs }` (symmetric absolute).
 *
 * CHECKS: for each measured metric that has an acceptance target, compare
 * measured-vs-target honoring the band → PASS/FAIL. Emits the proven feel-report
 * shape (metric, target, measured, band, result) in each check's fields/detail.
 *
 * Missing measurements (metric in acceptance but not measured) -> REFUSAL
 * ("(not measured)" is a FAIL, not a warn: see `evaluateFeel`). Measured
 * metrics with no acceptance target are skipped.
 */

import type { AcceptanceContract, FeelSection, NumericTarget } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export type FeelMeasurementSourceKind =
  | "FeelHarness"
  | "runtime.probe"
  // S5c: observe-only black-box measurement — drive declared input keys and read
  // the player transform trajectory (no controller assumptions).
  | "runtime.measure_motion"
  // S5c input-driven: the SAME sampler as runtime.measure_motion, but injects the
  // declared keys inside the sampling loop. The honest label for an input-driven capture.
  | "runtime.capture_input_motion";

/** One raw per-frame trajectory sample (the probe/capture_sequence shape). */
export interface FeelTrajectorySample {
  /** Milliseconds since the source's measurement start. */
  tMs: number;
  /** World X position. */
  x: number;
  /** World Y position. */
  y: number;
  /**
   * Optional world Z position. Present once the bridge emits a true {x,y,z} trajectory
   * (3D measurement substrate); absent for legacy 2D captures. Dimension-agnostic
   * calculators treat a missing z as 0 so 2D results are unchanged.
   */
  z?: number;
  /**
   * Optional world rotation in degrees (`transform.eulerAngles`), present once the bridge
   * emits a rotation trajectory (3D measurement substrate v2 — rotation/aim sampling);
   * absent for legacy position-only captures. `rx`=pitch (about X), `ry`=yaw (about Y),
   * `rz`=roll (about Z). Rotation calculators (e.g. `aimTurnRateDegPerSec`) REQUIRE these
   * on every sample and REFUSE when any are absent, so a position-only capture can never
   * fabricate a rotation value. Position metrics ignore them, so 2D results are unchanged.
   */
  rx?: number;
  ry?: number;
  rz?: number;
  /** Optional phase index within the measurement. */
  phase?: number;
}

export interface FeelMeasurementSource {
  source?: FeelMeasurementSourceKind | string;
  sampleCount?: number;
  /**
   * The measurement WINDOW the bridge echoed back, in milliseconds (the op's own
   * `durationMs`). Together with `sampleCount` it makes the EFFECTIVE sampling
   * cadence re-derivable, which is the whole point: `captureFps` alone is a
   * self-declared number, and the ledger (L45/L47) records a capture that ran at
   * roughly 11Hz while its file said 120. `physics-timestep` re-derives the
   * effective cadence from this pair and refuses a divergence beyond one tick.
   * Absent here, the window falls back to the `samples[].tMs` span; a source with
   * neither carries no cadence evidence at all and is refused.
   */
  durationMs?: number;
  captureFps?: number;
  measuredAt?: string;
  projectFixedTimestepBeforeMeasurement?: number;
  measurementFixedTimestep?: number;
  measuredMetrics?: string[];
  /**
   * S5c re-derivation marker. When `"trajectory"`, this source opts INTO the
   * `feel-rederive` gate: it MUST carry `samples`, and every re-derivable metric
   * it lists is re-computed from those samples and must match the reported value
   * (a tampered/param-read value can't survive). A source without this marker is
   * legacy and `feel-rederive` treats it as not_applicable, EXCEPT on a source
   * carrying the `producedBy` marker, where an absent derivation is a refusal
   * (see `PRODUCER_MARKER`).
   *
   * `"input-bisection"` is the explicit declaration for the coyote/jumpBuffer
   * threshold sweep: a real derivation that is NOT a trajectory re-derivation.
   * It exists so a producer can declare "this value came from a bisection" out
   * loud instead of leaving the marker absent, which is the legacy escape. Stage 2
   * gives it teeth: a source declaring it must carry `trials`, and the reported
   * window is re-derived from them (`deriveSweepMetric`): the sweep binding.
   *
   * `"window-delta"` is the dash derivation the ledger's own technique produced
   * (L42/L91): the phase-delta dash recipe is off by one tick BY CONSTRUCTION
   * (one dash tick always lands in the next phase), so the honest recipe pins the
   * horizontal drive to 0 for the whole window, making the whole-window
   * displacement the dash distance with no phase boundary involved.
   */
  derivation?: "trajectory" | "phase-delta" | "input-bisection" | "window-delta";
  /**
   * PRODUCER MARKER (stage 1, ledger L45/L48/L75).
   *
   * A closed-enum, machine-checkable field a CLI capture recipe sets on every
   * source it writes. It is deliberately NOT the `_provenance.writer` string:
   * that is free text, a report LABEL, and a label cannot be a control.
   *
   * The marker only ever makes grading STRICTER: a source that carries it must
   * declare a `derivation` and must satisfy that derivation's evidence rule, or
   * `feel-rederive` refuses it. An agent that stamps it to look official gains
   * nothing and loses the legacy opt-out, which is the property that makes a
   * self-declared marker safe to trust in this direction.
   */
  producedBy?: "loombridge-capture";
  /** Raw trajectory the value was derived from (required when derivation==="trajectory"). */
  samples?: FeelTrajectorySample[];
  /** Raw phase breakdown the value was derived from (required when derivation==="phase-delta"). */
  phases?: unknown[];
  /** Captured phase index used by a phase-delta derivation. */
  phaseIndex?: number;
  /** Captured axis used by a phase-delta derivation. */
  axis?: "x" | "y";
  /** Keys the selected phase actually held, copied from the bridge phase breakdown. */
  phaseKeys?: string[];
  /** Keys the recipe expected on the selected phase, copied from the capture contract. */
  requiredKeys?: string[];
  /**
   * F5: the input stimulus that produced a stimulus-sensitive metric, so the
   * measurement convention is machine-checkable instead of operator-conditional.
   *
   * For `shortHopApex` the metric is jointly determined by the jumpCut multiplier
   * AND the tap duration (how long `jump` was held before `jumpCut`); the recipe
   * pins a CANONICAL tap (`SHORT_HOP_CANONICAL_TAP_TICKS` fixed ticks). This field
   * records the tap actually used so a verifier can confirm it matches the canon —
   * an absent stimulus on a shortHopApex source is a REFUSAL, not a silent pass.
   *
   * `metric` names which measured metric the stimulus belongs to; `tapTicks` is the
   * tap duration in fixed physics ticks (the canonical, timestep-relative unit);
   * `phases` is an optional human-readable echo (e.g. "[jump 2t][jumpCut]").
   */
  stimulus?: FeelMeasurementStimulus;
  /**
   * F5: the input ONSET time for an `inputLatency` capture, in MILLISECONDS in the
   * SAME timeline as this source's `samples[].tMs` (samples are flat re-zeroed to
   * capture start, so the phase0→phase1 boundary — where the measured key is first
   * pressed — is otherwise lost). `inputLatency` = (first post-onset moved sample
   * tMs) − `inputOnsetMs`. Required for a source that measures `inputLatency`: an
   * absent onset makes the metric un-re-derivable and it is OMITTED ("not measured"),
   * never a fabricated 0. Absent for non-latency captures.
   */
  inputOnsetMs?: number;
  /**
   * H8. `captureFps` is an INPUT to the capture ops and is never echoed back, so a
   * file recording it alone says only what the writer asked for. A produced source
   * records the pair: `requestedCaptureFps` (what was asked) and
   * `effectiveCaptureFps` (re-derived from the echoed sampleCount/durationMs). The
   * physics-timestep gate re-derives the effective value itself and refuses a
   * recorded one that does not match, so writing a flattering number gains nothing.
   */
  requestedCaptureFps?: number;
  effectiveCaptureFps?: number;
  /**
   * How many INDEPENDENT capture windows this source's `sampleCount`/`durationMs`
   * pair aggregates (a sweep sums its trials into one pair). Each window sampled
   * both of its endpoints, so the structural sample count carries one fencepost per
   * window and the cadence re-derivation has to allow exactly that many.
   *
   * Recording it makes the file self-describing; it does NOT buy the tolerance.
   * `physics-timestep` COUNTS the windows from the source's own retained arrays and
   * refuses a `windowCount` that disagrees with them, so an inflated number is a
   * refusal rather than slack. Absent means one window.
   */
  windowCount?: number;
  /**
   * The RETAINED raw echo of every threshold-sweep trial (required when
   * `derivation === "input-bisection"`). Ledger L77: the door-one jumpBuffer trial
   * table was a literal array retyped from console output, and three of its six
   * rows had no raw file on disk at all. The gate re-derives the reported window
   * from these, so the headline is bound to the trials in the same file.
   */
  trials?: unknown[];
  /** What the sweep derivation read out of `trials` (report only; never its input). */
  observations?: unknown[];
  /** The tick-indexing convention the sweep used (`BRIDGE_SAMPLE_TICK_OFFSET`). */
  tickOffset?: number;
  /** Largest still-registering offset in ticks, and the first failing one. */
  boundaryTicks?: number;
  firstFailedTicks?: number;
}

/** The input stimulus that produced a stimulus-sensitive feel metric (F5). */
export interface FeelMeasurementStimulus {
  /** Which measured metric this stimulus produced (e.g. "shortHopApex"). */
  metric: string;
  /** Tap duration in FIXED physics ticks (for shortHopApex: jump held N ticks then jumpCut). */
  tapTicks?: number;
  /** Optional human-readable phase string the tap came from (e.g. "[jump 2t][jumpCut]"). */
  phases?: string;
}

export interface FeelProvenance {
  sources?: FeelMeasurementSource[];
}

/** Measured feel metrics Phase F feeds in. */
export interface FeelMeasurements {
  runSpeed?: number;
  jumpApex?: number;
  timeToApex?: number;
  dashDistance?: number;
  shortHopApex?: number;
  coyoteTime?: number;
  jumpBuffer?: number;
  provenance?: FeelProvenance;
}

export const GATE_NAME = "feel";

/**
 * THE GRADED SET: the feel metrics this gate evaluates, in report order.
 *
 * Exported because it is the authoritative answer to "which banded metric does a
 * verdict actually grade", and more than one caller needs it. The feel CAPTURE reads
 * it to decide what it OWES: a contract may band a metric this gate does not grade
 * (TideRunner bands `dashTime` and `dashCooldown`, which no leg measures and no check
 * here reads), and failing the capture over one of those is a refusal nothing can
 * clear. Never duplicate this list: an out-of-sync copy would either demand a metric
 * that is never graded or hide one that is.
 */
export const GRADED_FEEL_METRICS: Array<keyof FeelMeasurements & keyof FeelSection> = [
  "runSpeed",
  "jumpApex",
  "timeToApex",
  "shortHopApex",
  "dashDistance",
  "coyoteTime",
  "jumpBuffer",
];

/** Compute the [lo, hi] tolerance window for a target. Exact when no band. */
export function bandWindow(t: NumericTarget): { lo: number; hi: number; label: string } {
  if (t.band?.abs !== undefined) {
    return { lo: t.target - t.band.abs, hi: t.target + t.band.abs, label: `±${t.band.abs}${t.unit}` };
  }
  if (t.band?.percent !== undefined) {
    const d = (Math.abs(t.target) * t.band.percent) / 100;
    return { lo: t.target - d, hi: t.target + d, label: `±${t.band.percent}%` };
  }
  return { lo: t.target, hi: t.target, label: "exact" };
}

/** Is a measured value inside the target's band? */
export function withinBand(measured: number, t: NumericTarget): boolean {
  const { lo, hi } = bandWindow(t);
  const eps = 1e-9;
  return measured >= lo - eps && measured <= hi + eps;
}

export function evaluateFeel(
  measurements: FeelMeasurements,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];
  const feel = acceptance.feel ?? {};

  for (const key of GRADED_FEEL_METRICS) {
    const target = feel[key] as NumericTarget | undefined;
    if (!target) continue; // no spec for this metric -> nothing to check
    const measured = measurements[key];
    const { label } = bandWindow(target);

    if (measured === undefined) {
      // REFUSE, never warn (ledger L49, CLAUDE.md "a gate predicate must REFUSE
      // when a bound field is absent"). A metric the contract accepts and the run
      // did not measure is an EVIDENCE GAP: the contract's claim about it is
      // ungraded. Warning made "measured nothing hard" cheaper than measuring, and
      // an unmeasured metric is exactly the one an agent could not make pass. This
      // is the harness tier in intent; the deterministic gate vocabulary has no
      // separate harness status, so it is a fail whose detail says why.
      checks.push({
        id: `feel.${key}`,
        expected: `${target.target}${target.unit} (${label})`,
        actual: "(not measured)",
        status: "fail",
        detail: `${key}: target ${target.target}${target.unit} ${label}: NOT MEASURED this run, so the contract's band for it was never graded. Refused (not a warn): measure it, or remove the acceptance target if the metric does not apply to this game.`,
      });
      continue;
    }

    const ok = withinBand(measured, target);
    checks.push({
      id: `feel.${key}`,
      expected: `${target.target}${target.unit} (${label})`,
      actual: `${measured}${target.unit}`,
      status: ok ? "pass" : "fail",
      // Proven feel-report line: metric | target | measured | band | result
      detail: `${key}: target ${target.target}${target.unit}, measured ${measured}${target.unit}, band ${label} -> ${ok ? "PASS" : "FAIL"}.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
