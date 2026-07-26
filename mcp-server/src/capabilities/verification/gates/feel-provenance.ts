/**
 * Feel-provenance gate.
 *
 * The `feel` gate intentionally grades numeric measurements only. This gate
 * closes the self-grading hole by requiring each accepted measured metric in
 * feel.json to be covered by a valid measurement source.
 */

import type { AcceptanceContract, FeelSection, NumericTarget } from "../types.js";
import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import type { FeelMeasurements, FeelMeasurementSource } from "./feel.js";
import {
  SHORT_HOP_CANONICAL_TAP_TICKS,
  SHORT_HOP_TAP_TICK_TOLERANCE,
} from "../../../domain/feel-primitives.js";

export const GATE_NAME = "feel-provenance";

/**
 * Metrics whose value is determined by the input stimulus, not just the controller
 * params — they REQUIRE a recorded canonical stimulus on their certifying source.
 * Scoped deliberately: only `shortHopApex` is stimulus-sensitive (jointly set by
 * jumpCut + tap duration). runSpeed/jumpApex/etc. do NOT require a stimulus field.
 */
const STIMULUS_REQUIRED_METRICS: ReadonlySet<string> = new Set(["shortHopApex"]);

const VALID_SOURCES = new Set([
  "FeelHarness",
  "runtime.probe",
  "runtime.measure_motion",
  "runtime.capture_input_motion",
]);
const TRAJECTORY_METRICS: ReadonlySet<string> = new Set([
  "runSpeed",
  "jumpApex",
  "timeToApex",
  "shortHopApex",
  // F5: re-derived from the same trajectory samples (run ramp / jump-arc asymmetry),
  // so the trajectory sources own them too. (maxFallSpeed is deferred — needs a
  // dedicated tall-drop capture, not a flat-ground trajectory.)
  "runAcceleration",
  "runDeceleration",
  "fallGravityMultiplier",
  "projectileSpeed",
  "aimTurnRateDegPerSec",
  // 3C: lookInputToYawLatencyMs re-derives from sampled yaw (ry) + a recorded look-input onset,
  // so the trajectory/capture source owns it like the other input-bound rotation metrics.
  "lookInputToYawLatencyMs",
]);
const SOURCE_METRIC_OWNERSHIP: Record<string, ReadonlySet<string>> = {
  FeelHarness: TRAJECTORY_METRICS,
  // shortHopApex is also certifiable by runtime.probe: the FeelHarness HopMeasure
  // is frame-quantized and cannot reliably resolve a tight band, so the behavioral
  // runtime.probe peak-Y measurement is the authoritative source for the shortest hop.
  "runtime.probe": new Set(["dashDistance", "coyoteTime", "jumpBuffer", "shortHopApex"]),
  // S5c observe-only: drive declared input keys and read the player transform
  // trajectory. Owns the trajectory-derivable metrics. NOTE: ownership here is a
  // structural claim only — a runtime.measure_motion source that declares
  // derivation:"trajectory" must ALSO pass feel-rederive (its samples must
  // re-derive the reported value), which feel-provenance does not check.
  "runtime.measure_motion": TRAJECTORY_METRICS,
  // runtime.capture_input_motion is the SAME sampler as runtime.measure_motion
  // (same MotionMetrics.Compute, same samples[]:{tMs,x,y} shape) but injects the
  // declared input keys INSIDE the sampling loop — so it owns the identical
  // trajectory metrics. It is the honest source label for an input-driven capture
  // (relabeling it to runtime.measure_motion to pass this gate is a §3a hazard).
  "runtime.capture_input_motion": TRAJECTORY_METRICS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => isNonEmptyString(entry))
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

function validPhaseDeltaDashSource(source: FeelMeasurementSource | undefined): boolean {
  if (!source) return false;
  if (!validMeasurementSource(source)) return false;
  if (source.source !== "runtime.capture_input_motion") return false;
  if (source.derivation !== "phase-delta") return false;
  if (!Array.isArray(source.phases)) return false;
  const phaseIndex = source.phaseIndex;
  if (!Number.isInteger(phaseIndex) || phaseIndex === undefined || phaseIndex < 0) return false;
  if (source.axis !== undefined && source.axis !== "x" && source.axis !== "y") return false;

  const phase = source.phases.find((candidate) =>
    isRecord(candidate) && candidate.index === phaseIndex);
  if (!isRecord(phase)) return false;
  if (!includesAllKeys(source.phaseKeys, source.requiredKeys)) return false;
  if (!includesAllKeys(phase.keys, source.requiredKeys)) return false;
  const field = source.axis === "y" ? "deltaY" : "deltaX";
  return isFiniteNumber(phase[field]);
}

function acceptedMetricNames(feel: FeelSection): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(feel)) {
    if (key === "extra") continue;
    if (isRecord(value) && isFiniteNumber(value.target)) names.push(key);
  }
  for (const [key, value] of Object.entries(feel.extra ?? {})) {
    if (isRecord(value) && isFiniteNumber((value as NumericTarget).target)) names.push(key);
  }
  return names;
}

export function measuredAcceptedMetrics(input: FeelMeasurements, acceptance: AcceptanceContract): string[] {
  const record = input as Record<string, unknown>;
  return acceptedMetricNames(acceptance.feel ?? {}).filter((metric) => isFiniteNumber(record[metric]));
}

export function validMeasurementSource(source: FeelMeasurementSource | undefined): boolean {
  return Boolean(
    source &&
      VALID_SOURCES.has(String(source.source)) &&
      isFiniteNumber(source.sampleCount) &&
      source.sampleCount > 0 &&
      isFiniteNumber(source.captureFps) &&
      source.captureFps > 0 &&
      isNonEmptyString(source.measuredAt) &&
      isFiniteNumber(source.projectFixedTimestepBeforeMeasurement) &&
      isFiniteNumber(source.measurementFixedTimestep) &&
      Array.isArray(source.measuredMetrics) &&
      source.measuredMetrics.every(isNonEmptyString),
  );
}

export function validMeasurementSourceForMetric(source: FeelMeasurementSource | undefined, metric: string): boolean {
  if (!validMeasurementSource(source)) return false;
  if (metric === "dashDistance" && source?.source === "runtime.capture_input_motion") {
    return validPhaseDeltaDashSource(source);
  }
  const owned = SOURCE_METRIC_OWNERSHIP[String(source!.source)];
  return Boolean(owned?.has(metric));
}

function sourcesForMetric(sources: FeelMeasurementSource[], metric: string): FeelMeasurementSource[] {
  return sources.filter((source) => source.measuredMetrics?.includes(metric));
}

/** Is `metric` stimulus-sensitive (must carry a recorded canonical stimulus)? */
export function isStimulusRequired(metric: string): boolean {
  return STIMULUS_REQUIRED_METRICS.has(metric);
}

export interface StimulusVerdict {
  ok: boolean;
  /** Why the stimulus was refused (absent / off-canon), when `ok` is false. */
  reason?: string;
}

/**
 * Check that the stimulus recorded on a source matches the canonical short-hop tap.
 *
 * Refuse-don't-skip (CLAUDE.md "an absent binding is a refusal"): a shortHopApex
 * source with NO `stimulus`, or a `stimulus` whose `tapTicks` is absent / non-finite
 * / not the canonical value, is REFUSED — never silently accepted. An honest
 * canonical tap (`tapTicks === SHORT_HOP_CANONICAL_TAP_TICKS` within tick tolerance)
 * is the only accepted reading. Used by both the feel-provenance gate and the
 * verify-first §0 path so the convention is enforced everywhere shortHopApex bands.
 */
export function checkShortHopStimulus(source: FeelMeasurementSource | undefined): StimulusVerdict {
  const stimulus = source?.stimulus;
  if (!stimulus) {
    return {
      ok: false,
      reason: `shortHopApex is stimulus-sensitive but its measurement records no stimulus — refused (cannot tell which tap produced the reading; the canonical tap is ${SHORT_HOP_CANONICAL_TAP_TICKS} fixed ticks held before jumpCut).`,
    };
  }
  // The stimulus must self-declare it belongs to shortHopApex. A present-but-
  // mismatched `metric` is a refusal (not ignored): on a multi-metric capture the
  // assembler emits the stimulus whenever the capture measured stimulus.metric, so
  // a stimulus tagged for another metric must not silently certify shortHopApex.
  if (stimulus.metric !== "shortHopApex") {
    return {
      ok: false,
      reason: `shortHopApex stimulus is tagged for '${stimulus.metric}', not shortHopApex — refused (the recorded tap does not declare it produced the short hop).`,
    };
  }
  const tapTicks = stimulus.tapTicks;
  if (!isFiniteNumber(tapTicks)) {
    return {
      ok: false,
      reason: `shortHopApex stimulus records no numeric tapTicks — refused (the canonical short hop is jump held for ${SHORT_HOP_CANONICAL_TAP_TICKS} fixed ticks then jumpCut).`,
    };
  }
  if (Math.abs(tapTicks - SHORT_HOP_CANONICAL_TAP_TICKS) > SHORT_HOP_TAP_TICK_TOLERANCE) {
    return {
      ok: false,
      reason: `shortHopApex measured with a non-canonical tap (${tapTicks} ticks; canonical is ${SHORT_HOP_CANONICAL_TAP_TICKS} ticks) — refused (a longer/shorter tap changes the hop height, so this reading is not comparable to the band).`,
    };
  }
  return { ok: true };
}

/**
 * Distrust verdicts for stimulus-sensitive metrics, keyed metric id → refusal
 * reason, for any measured-and-accepted metric whose certifying source lacks a
 * canonical stimulus. Shared by verify-first §0 (folds into the distrusted map so
 * the metric is forced to fail) — the same refuse-don't-skip discipline as
 * re-derivation. A metric with a valid canonical stimulus yields no entry.
 */
export function stimulusDistrust(
  measuredMetrics: readonly string[],
  sources: FeelMeasurementSource[],
): Map<string, string> {
  const distrust = new Map<string, string>();
  for (const metric of measuredMetrics) {
    if (!isStimulusRequired(metric)) continue;
    const covering = sourcesForMetric(sources, metric);
    // Trust the metric only if SOME covering source carries a canonical stimulus.
    // No covering source at all is also a refusal (absent stimulus).
    const verdicts = covering.map((s) => checkShortHopStimulus(s));
    if (verdicts.some((v) => v.ok)) continue;
    const reason =
      verdicts.find((v) => v.reason)?.reason ??
      checkShortHopStimulus(undefined).reason!;
    distrust.set(metric, reason);
  }
  return distrust;
}

export function evaluateFeelProvenance(
  input: FeelMeasurements,
  acceptance: AcceptanceContract,
): GateReport {
  const metrics = measuredAcceptedMetrics(input, acceptance);
  if (metrics.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "feel-provenance.data",
        expected: "≥1 measured accepted feel metric",
        actual: "(none)",
        status: "warn",
        detail: "No accepted feel measurements were captured; provenance was not evaluated.",
      },
    ]);
  }

  const sources = input.provenance?.sources ?? [];
  const checks: GateCheck[] = [];
  if (sources.length === 0) {
    checks.push({
      id: "feel-provenance.present",
      expected: "provenance.sources[] with per-metric measurement evidence",
      actual: "(absent)",
      status: "fail",
      detail:
        "feel.json contains measured numbers but no provenance.sources[]; numbers-only feel captures are refused as self-grading.",
    });
  } else {
    checks.push({
      id: "feel-provenance.present",
      expected: "provenance.sources[] with per-metric measurement evidence",
      actual: `${sources.length} source(s)`,
      status: "pass",
      detail: "feel.json includes measurement provenance sources.",
    });
  }

  for (const metric of metrics) {
    const covering = sourcesForMetric(sources, metric);
    const valid = covering.find((source) => validMeasurementSourceForMetric(source, metric));
    checks.push({
      id: `feel-provenance.${metric}`,
      expected:
        'covered by the owning valid source: FeelHarness / runtime.measure_motion / runtime.capture_input_motion own runSpeed/jumpApex/timeToApex/shortHopApex; runtime.capture_input_motion may own dashDistance only with derivation:"phase-delta" + valid phase evidence; runtime.probe owns dashDistance/coyoteTime/jumpBuffer/shortHopApex; source must also have sampleCount>0, captureFps>0, measuredAt, projectFixedTimestepBeforeMeasurement, measurementFixedTimestep',
      actual:
        covering.length === 0
          ? "(uncovered)"
          : covering
              .map((source) => `${source.source ?? "(missing source)"}:${validMeasurementSourceForMetric(source, metric) ? "valid-owner" : validMeasurementSource(source) ? "wrong-owner" : "invalid"}`)
              .join(", "),
      status: valid ? "pass" : "fail",
      detail: valid
        ? `${metric} is covered by valid ${valid.source} measurement evidence.`
        : covering.length === 0
          ? `${metric} is measured and accepted, but no provenance source lists it in measuredMetrics[].`
          : `${metric} is listed by provenance source(s), but none is both structurally valid and allowed to certify that metric.`,
    });

    // F5: a stimulus-sensitive metric (shortHopApex) must ALSO carry a canonical
    // stimulus on a covering source. Absent / off-canon stimulus = refusal, so an
    // operator can't pick the tap that passes. This is an extra check on top of the
    // ownership check above — both must pass.
    if (isStimulusRequired(metric)) {
      // Prefer the owning-valid source's stimulus; otherwise accept any covering
      // source that carries a canonical stimulus (the value is what matters here).
      const stimulusOk = (valid ? [valid, ...covering] : covering).some(
        (s) => checkShortHopStimulus(s).ok,
      );
      const refusal =
        stimulusDistrust([metric], sources).get(metric) ??
        checkShortHopStimulus(undefined).reason!;
      checks.push({
        id: `feel-provenance.${metric}.stimulus`,
        expected: `canonical tap recorded: stimulus.tapTicks === ${SHORT_HOP_CANONICAL_TAP_TICKS} (fixed ticks held before jumpCut)`,
        actual: stimulusOk
          ? `${SHORT_HOP_CANONICAL_TAP_TICKS} ticks (canonical)`
          : covering.length === 0
            ? "(no covering source)"
            : covering.map((s) => (s.stimulus?.tapTicks ?? "(absent)")).join(", "),
        status: stimulusOk ? "pass" : "fail",
        detail: stimulusOk
          ? `${metric} was measured with the canonical ${SHORT_HOP_CANONICAL_TAP_TICKS}-tick tap.`
          : refusal,
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
