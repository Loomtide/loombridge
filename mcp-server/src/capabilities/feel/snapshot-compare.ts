/**
 * Feel snapshot drift comparison (pure) + the exit-code contract.
 *
 * Compares a CURRENT measurements file against the frozen snapshot manifest.
 * The tolerance for a metric is frozen in the manifest's policy at approve time:
 * `applied = max(absFloor(derivation), relPct * |baseline|)`, per-metric
 * overrides winning over defaults. There is deliberately no verify-time
 * loosening: re-approval is the change path.
 *
 * Honesty rules (house invariants):
 *  - a current value refused by §0 / stimulus distrust NEVER compares as clean:
 *    it is `rejected` and drives the drift verdict;
 *  - a baseline metric with no current value is `missing`: a capture gap, not a
 *    regression, and not a pass (incomplete tier, exit 2 conventions);
 *  - a current metric absent from the baseline is informational (`newMetrics`),
 *    never gating.
 */

import type { FeelMeasurementsFile } from "./measurements.js";
import type { FeelSnapshotManifest, FeelSnapshotTolerancePolicy } from "./snapshot-manifest.js";

export interface SnapshotTolerance {
  /** The absolute floor applied (from the derivation kind, or override). */
  abs: number;
  /** The relative fraction applied. */
  relPct: number;
  /** max(abs, relPct * |baseline|): the drift threshold in native units. */
  applied: number;
}

export type SnapshotMetricStatus = "match" | "drift" | "rejected" | "missing";

export interface SnapshotMetricComparison {
  id: string;
  baseline: number;
  current: number | null;
  /** current - baseline (null when missing). */
  delta: number | null;
  tolerance: SnapshotTolerance;
  status: SnapshotMetricStatus;
  /** Trust of the CURRENT value (absent when missing). */
  confidence?: "verified" | "reported";
  detail: string;
}

export interface SnapshotNewMetric {
  id: string;
  value: number;
  confidence: "verified" | "reported" | "rejected";
}

export type SnapshotCompareStatus = "clean" | "drift" | "incomplete";

export interface SnapshotCompareResult {
  metrics: SnapshotMetricComparison[];
  newMetrics: SnapshotNewMetric[];
  summary: { total: number; match: number; drift: number; rejected: number; missing: number };
  status: SnapshotCompareStatus;
}

export function resolveTolerance(
  policy: FeelSnapshotTolerancePolicy,
  id: string,
  derivation: string | undefined,
  baselineValue: number,
): SnapshotTolerance {
  const override = policy.perMetric?.[id];
  const abs =
    override?.abs !== undefined
      ? override.abs
      : derivation !== undefined
        ? (policy.defaultAbsFloorByDerivation[derivation] ?? 0)
        : 0;
  const relPct = override?.relPct !== undefined ? override.relPct : policy.defaultRelPct;
  const applied = Math.max(abs, relPct * Math.abs(baselineValue));
  return { abs, relPct, applied };
}

/**
 * Pure drift compare. `currentDistrust`/`currentVerified` are the §0 view of the
 * CURRENT capture (see `rederiveView`); the caller strips coverage-refused
 * values from `current.metrics` first (a harness-gap value must read `missing`,
 * never compare).
 */
export function compareSnapshot(
  manifest: FeelSnapshotManifest,
  current: FeelMeasurementsFile,
  currentDistrust: ReadonlyMap<string, string>,
  currentVerified: ReadonlySet<string>,
): SnapshotCompareResult {
  const metrics: SnapshotMetricComparison[] = [];

  for (const [id, entry] of Object.entries(manifest.metrics)) {
    const tolerance = resolveTolerance(manifest.tolerancePolicy, id, entry.derivation, entry.value);
    const currentValue = current.metrics[id];

    if (currentValue === undefined) {
      metrics.push({
        id,
        baseline: entry.value,
        current: null,
        delta: null,
        tolerance,
        status: "missing",
        detail: `${id}: baseline ${entry.value}, not measured in the current capture (capture gap, not a regression).`,
      });
      continue;
    }

    const distrustReason = currentDistrust.get(id);
    if (distrustReason !== undefined) {
      metrics.push({
        id,
        baseline: entry.value,
        current: currentValue,
        delta: currentValue - entry.value,
        tolerance,
        status: "rejected",
        detail: `${id}: current value rejected by re-derivation (${distrustReason}); it cannot compare as clean.`,
      });
      continue;
    }

    const delta = currentValue - entry.value;
    // FAIL-CLOSED, and written as the NEGATION of "within tolerance" on purpose. For every
    // finite tolerance this is identical to `|delta| > applied + 1e-9`. It differs for
    // exactly one input: a non-finite `applied`, where every comparison against NaN is
    // false, so the old form reported `ok` at any drift. A tolerance that is not a finite
    // non-negative number is refused upstream at BOTH doors it can enter through
    // (`readTolerances` at approve, `verifySnapshotIntegrity` at read), so this line should
    // be unreachable; it is written this way so that if a third door ever opens the answer
    // is DRIFT rather than a silent, permanent green.
    const drifted = !(Math.abs(delta) <= tolerance.applied + 1e-9);
    metrics.push({
      id,
      baseline: entry.value,
      current: currentValue,
      delta,
      tolerance,
      status: drifted ? "drift" : "match",
      confidence: currentVerified.has(id) ? "verified" : "reported",
      detail: `${id}: ${entry.value} -> ${currentValue} (delta ${delta >= 0 ? "+" : ""}${round(delta)}, tolerance ${round(tolerance.applied)}) ${drifted ? "DRIFT" : "ok"}.`,
    });
  }

  const baselineIds = new Set(Object.keys(manifest.metrics));
  const newMetrics: SnapshotNewMetric[] = Object.entries(current.metrics)
    .filter(([id, v]) => !baselineIds.has(id) && Number.isFinite(v))
    .map(([id, v]) => ({
      id,
      value: v,
      confidence: currentDistrust.has(id) ? "rejected" : currentVerified.has(id) ? "verified" : "reported",
    }));

  const summary = {
    total: metrics.length,
    match: metrics.filter((m) => m.status === "match").length,
    drift: metrics.filter((m) => m.status === "drift").length,
    rejected: metrics.filter((m) => m.status === "rejected").length,
    missing: metrics.filter((m) => m.status === "missing").length,
  };
  const status: SnapshotCompareStatus =
    summary.drift > 0 || summary.rejected > 0 ? "drift" : summary.missing > 0 ? "incomplete" : "clean";

  return { metrics, newMetrics, summary, status };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export type SnapshotContractBinding = "verified" | "mismatch" | "unverified";

/**
 * The exit-code contract (0 clean, 1 drift/behavior, 2 harness/integrity):
 *  - broken integrity or a contract-binding mismatch is a 2 (not a trustworthy
 *    comparison, never a pass, never a game bug);
 *  - `incomplete` (a baseline metric unmeasured now) is a 2: capture gap tier;
 *  - `drift` (including a rejected current value) is a 1;
 *  - clean is 0, except an UNVERIFIED binding (offline --measurements cannot
 *    prove the same contract measured both sides) which is 1 under --strict.
 * Pure + exported so the whole table is unit-tested without fixtures.
 */
export function exitCodeForSnapshotDrift(
  report: { status: SnapshotCompareStatus; contractBinding: SnapshotContractBinding; integrity: { ok: boolean } },
  opts: { strict: boolean },
): number {
  if (!report.integrity.ok) return 2;
  if (report.contractBinding === "mismatch") return 2;
  if (report.status === "incomplete") return 2;
  if (report.status === "drift") return 1;
  if (report.contractBinding === "unverified" && opts.strict) return 1;
  return 0;
}
