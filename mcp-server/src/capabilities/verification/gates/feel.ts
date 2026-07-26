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
 * Missing measurements (metric in acceptance but not measured) -> WARN
 * ("not measured"). Measured metrics with no acceptance target are skipped.
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
   * legacy and `feel-rederive` treats it as not_applicable.
   */
  derivation?: "trajectory" | "phase-delta";
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

/** The feel metrics this gate evaluates, in report order. */
const FEEL_KEYS: Array<keyof FeelMeasurements & keyof FeelSection> = [
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

  for (const key of FEEL_KEYS) {
    const target = feel[key] as NumericTarget | undefined;
    if (!target) continue; // no spec for this metric -> nothing to check
    const measured = measurements[key];
    const { label } = bandWindow(target);

    if (measured === undefined) {
      checks.push({
        id: `feel.${key}`,
        expected: `${target.target}${target.unit} (${label})`,
        actual: "(not measured)",
        status: "warn",
        detail: `${key}: target ${target.target}${target.unit} ${label} — not measured this run.`,
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
