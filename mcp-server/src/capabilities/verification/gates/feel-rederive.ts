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
 * STAGE 1 (ledger L45/L48): the legacy path DIES for produced evidence. A source
 * carrying `producedBy:"loombridge-capture"` with an ABSENT `derivation` is
 * REFUSED rather than reported as legacy. Otherwise the CLI's own producer could
 * emit exactly the file shape this gate declines to grade. See
 * `producerMarkerRefusals`.
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
  /** The value the file reports, or `null` when the refusal fired before any value was read. */
  reported: number | null;
  rederived: number | null;
  status: Extract<CheckStatus, "pass" | "fail">;
  detail: string;
}

/**
 * The producer marker (see `FeelMeasurementSource.producedBy`). A source that
 * carries it has declared "a CLI capture recipe wrote me", and the legacy
 * opt-out (an ABSENT `derivation` reading as not_applicable) dies for it.
 */
const PRODUCER_MARKER = "loombridge-capture";

/**
 * Metrics the input-timing bisection legitimately owns. A source declaring
 * `derivation:"input-bisection"` may only cover these; listing a
 * trajectory-derivable metric there would be laundering (declare the derivation
 * that skips re-derivation, report a number nothing re-derives).
 */
const BISECTION_METRICS: ReadonlySet<string> = new Set(["coyoteTime", "jumpBuffer"]);

/**
 * The refusals a source owes BEFORE its metrics are re-derived (stage 1).
 *
 * Ordering matters and is load-bearing (M19): these fire on the source itself,
 * so they are reached even when the source reports no re-derivable metric, which
 * is exactly the shape a legacy-masquerading producer file would have.
 */
function producerMarkerRefusals(source: FeelMeasurementSource, index: number): RederiveVerdict[] {
  if (source.producedBy !== PRODUCER_MARKER) return [];
  const metrics = (source.measuredMetrics ?? []).filter((m) => typeof m === "string" && m.length > 0);
  const labels = metrics.length > 0 ? metrics : [`(source ${index}: no measuredMetrics)`];

  if (source.derivation === undefined) {
    return labels.map((metric) => ({
      metric,
      reported: null,
      rederived: null,
      status: "fail" as const,
      detail: `${metric}: source declares producedBy:"${PRODUCER_MARKER}" but records NO derivation: refused. A produced source must say how the value was derived ("trajectory", "phase-delta" or "input-bisection"); the absent-marker legacy path is for hand-assembled files only and cannot be claimed by a producer.`,
    }));
  }
  if (source.derivation === "input-bisection") {
    const offOwnership = metrics.filter((metric) => !BISECTION_METRICS.has(metric));
    if (offOwnership.length > 0) {
      return offOwnership.map((metric) => ({
        metric,
        reported: null,
        rederived: null,
        status: "fail" as const,
        detail: `${metric}: source declares derivation:"input-bisection", which owns only ${[...BISECTION_METRICS].join("/")}: refused (a trajectory-derivable metric cannot be routed around re-derivation by declaring the bisection derivation).`,
      }));
    }
  }
  return [];
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
  for (const [index, source] of sources.entries()) {
    // Producer-marker refusals first: they must be reachable on a source that
    // lists no re-derivable metric at all, which is where the legacy skip lived.
    const refusals = producerMarkerRefusals(source, index);
    if (refusals.length > 0) {
      verdicts.push(...refusals);
      continue;
    }
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
