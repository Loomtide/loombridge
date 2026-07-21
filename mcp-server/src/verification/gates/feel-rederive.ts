/**
 * Feel re-derivation gate (S5c).
 *
 * Closes the S4b self-grade hole. `feel-provenance` proves a source CLAIMS to have
 * measured N samples; this gate proves the reported value was actually DERIVED
 * from raw evidence — trajectory samples or per-phase bridge motion evidence — and
 * rejects a mismatch.
 *
 * Discriminator (the crisp marker, not a heuristic): sources declare their
 * derivation. A `trajectory` source MUST carry `samples`; a `phase-delta` source
 * MUST carry the bridge phase breakdown plus selected phase/axis. Every
 * re-derivable metric it lists must match within epsilon. A source WITHOUT the
 * marker is legacy → its metrics are `not_applicable` here (existing feel.json
 * keeps working). A new S5c output always sets the marker, so it can never
 * masquerade as legacy and skip re-derivation.
 *
 * Scope: re-derives the trajectory-derivable metrics (jumpApex/timeToApex/
 * runSpeed/shortHopApex and the F5 accel/decel/fall/inputLatency metrics).
 * `inputLatency` additionally needs the source's recorded `inputOnsetMs` (passed to
 * deriveMetric); a source reporting it with no usable onset is refused.
 * coyote/jumpBuffer come from input-timing bisection, a different derivation, and
 * remain covered by feel-provenance.
 */

import type { AcceptanceContract } from "../types.js";
import { makeGateReport, type GateCheck, type GateReport, type CheckStatus } from "./types.js";
import type { FeelMeasurements, FeelMeasurementSource } from "./feel.js";
import {
  deriveMetric,
  isValidTrajectory,
  REDERIVABLE_METRIC_SET,
} from "../feel-derive.js";

export const GATE_NAME = "feel-rederive";

/** Tolerance on |reported − rederived|: generous for rounding, tight for tampering. */
function withinTolerance(reported: number, rederived: number): boolean {
  return Math.abs(reported - rederived) <= Math.max(1e-3, Math.abs(rederived) * 1e-3);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function includesAllKeys(actualKeys: unknown, requiredKeys: unknown): boolean {
  const required = stringArray(requiredKeys);
  if (required.length === 0) return false;
  // Case-insensitive: required keys carry the developer's typed casing ("d", "leftShift");
  // captured phase keys are canonical InputSystem Key enum names ("D", "LeftShift").
  const actual = new Set(stringArray(actualKeys).map((key) => key.toLowerCase()));
  return required.every((key) => actual.has(key.toLowerCase()));
}

function rederivePhaseDelta(source: FeelMeasurementSource): number | null {
  if (!Array.isArray(source.phases)) return null;
  if (!Number.isInteger(source.phaseIndex) || (source.phaseIndex ?? -1) < 0) return null;
  const phase = source.phases.find((entry) => isRecord(entry) && entry.index === source.phaseIndex);
  if (!isRecord(phase)) return null;
  if (!includesAllKeys(source.phaseKeys, source.requiredKeys)) return null;
  if (!includesAllKeys(phase.keys, source.requiredKeys)) return null;
  const key = source.axis === "y" ? "deltaY" : "deltaX";
  const delta = phase[key];
  return isFiniteNumber(delta) ? Math.abs(delta) : null;
}

export interface RederiveVerdict {
  metric: string;
  reported: number;
  rederived: number | null;
  status: Extract<CheckStatus, "pass" | "fail">;
  detail: string;
}

/**
 * Re-derive every marked metric from its source evidence. Pure +
 * shared by the gate and the verify-first §0 enforcement. `reported` maps metric
 * id → the value the file reports (flat feel.json keys, or S5b `measurements.metrics`).
 *
 * A metric is verdicted ONLY when some marked derivation source lists it;
 * legacy/unmarked sources produce no verdict (the caller treats absence as
 * "not re-derived here"). Failure modes:
 *  - source marked trajectory but `samples` missing/invalid → fail (absent binding = refusal)
 *  - re-derived value ≠ reported beyond tolerance → fail (tampered/param-read)
 */
export function rederiveFromSources(
  sources: FeelMeasurementSource[],
  reported: Record<string, number | undefined>,
): RederiveVerdict[] {
  const verdicts: RederiveVerdict[] = [];
  for (const source of sources) {
    if (source.derivation === "phase-delta") {
      const metrics = (source.measuredMetrics ?? []).filter((m) => m === "dashDistance");
      for (const metric of metrics) {
        const reportedValue = reported[metric];
        if (!isFiniteNumber(reportedValue)) continue;
        const rederived = rederivePhaseDelta(source);
        if (rederived === null) {
          verdicts.push({
            metric,
            reported: reportedValue,
            rederived: null,
            status: "fail",
            detail: `${metric}: source declares derivation:"phase-delta" and reports a value but carries no valid phase delta evidence — cannot re-derive (refused as self-grading).`,
          });
          continue;
        }
        const ok = withinTolerance(reportedValue, rederived);
        verdicts.push({
          metric,
          reported: reportedValue,
          rederived,
          status: ok ? "pass" : "fail",
          detail: ok
            ? `${metric}: reported ${reportedValue} matches re-derivation ${rederived.toFixed(4)} from phase ${source.phaseIndex}.`
            : `${metric}: reported ${reportedValue} does NOT match phase-delta re-derivation ${rederived.toFixed(4)} — tampered or param-read.`,
        });
      }
      continue;
    }
    if (source.derivation !== "trajectory") continue; // only marked sources opt in
    const metrics = (source.measuredMetrics ?? []).filter((m) => REDERIVABLE_METRIC_SET.has(m));
    for (const metric of metrics) {
      const reportedValue = reported[metric];
      if (!isFiniteNumber(reportedValue)) continue; // not reported → nothing to re-derive against

      if (!isValidTrajectory(source.samples)) {
        verdicts.push({
          metric,
          reported: reportedValue,
          rederived: null,
          status: "fail",
          detail: `${metric}: source declares derivation:"trajectory" and reports a value but carries no valid samples — cannot re-derive (refused as self-grading).`,
        });
        continue;
      }
      // inputLatency also needs the recorded input onset (same timeline as
      // samples). For all other metrics deriveMetric ignores the extra arg.
      const rederived = deriveMetric(metric, source.samples, source.inputOnsetMs);
      // A trajectory source that REPORTS a value but whose own VALID samples do NOT
      // re-derive it is refused (absent binding = refusal, never a silent skip — §3a).
      // The honest assembler OMITS any metric whose derivation is null, so a REPORTED
      // metric that re-derives null was NOT produced from these samples → self-grade
      // / param-read. Examples: inputLatency with no usable onset; shortHopApex from a
      // tap that did not register a hop (apex below the no-jump floor); accel/decel
      // reported over an instant-controller capture that has no ramp. Fail all of them.
      if (rederived === null) {
        verdicts.push({
          metric,
          reported: reportedValue,
          rederived: null,
          status: "fail",
          detail:
            metric === "inputLatency"
              ? `${metric}: source reports a value but its inputOnsetMs/samples do not re-derive a latency (absent onset or no post-onset motion) — refused as self-grading.`
              : `${metric}: source reports a value but its own samples do not re-derive ${metric} (the stimulus did not produce the measured signal) — refused as self-grading.`,
        });
        continue;
      }
      const ok = withinTolerance(reportedValue, rederived);
      verdicts.push({
        metric,
        reported: reportedValue,
        rederived,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${metric}: reported ${reportedValue} matches re-derivation ${rederived.toFixed(4)} from ${source.samples.length} samples.`
          : `${metric}: reported ${reportedValue} does NOT match re-derivation ${rederived.toFixed(4)} from the source's own samples — tampered or param-read.`,
      });
    }
  }
  return verdicts;
}

/** Gate form: re-derive over a flat feel.json (`FeelMeasurements`). */
export function evaluateFeelRederive(
  input: FeelMeasurements,
  _acceptance: AcceptanceContract,
): GateReport {
  const sources = input.provenance?.sources ?? [];
  const reported = input as unknown as Record<string, number | undefined>;
  const verdicts = rederiveFromSources(sources, reported);

  if (verdicts.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "feel-rederive.data",
        expected: 'a provenance source with derivation:"trajectory" + samples',
        actual: "(none)",
        status: "not_applicable",
        detail:
          "No trajectory-derivation sources present; re-derivation not applicable (legacy feel.json).",
      },
    ]);
  }

  const checks: GateCheck[] = verdicts.map((v) => ({
    id: `feel-rederive.${v.metric}`,
    expected: "reported value re-derives from the source's raw samples",
    actual: v.rederived === null ? "(no samples)" : `${v.rederived.toFixed(4)}`,
    status: v.status,
    detail: v.detail,
  }));
  return makeGateReport(GATE_NAME, checks);
}
