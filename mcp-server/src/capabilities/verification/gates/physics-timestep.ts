/**
 * Physics-timestep gate.
 *
 * Checks that both the project's configured fixed timestep and the measurement
 * timestep used by feel captures match the acceptance contract. This prevents a
 * harness from pinning measurement time to 60Hz while the shipped project still
 * runs at Unity's default 50Hz.
 *
 * EFFECTIVE CADENCE (ledger L47). `captureFps` on its own is a number the file
 * declares about itself, and the door-one run shipped a capture whose real
 * sampling cadence was roughly 11Hz under a file that said 120: every timestep
 * check still passed. So the gate no longer grades the declared number alone. It
 * RE-DERIVES the cadence the run actually achieved from the source's own echoed
 * `sampleCount` and measurement window (`durationMs`, or the `samples[].tMs`
 * span when the op did not echo one) and refuses a divergence beyond ONE TICK of
 * the declared rate. One tick is the exact tolerance because it is also the
 * endpoint convention's whole ambiguity: N samples over a window span N-1
 * intervals, so an honest capture lands within one sample either way while an
 * order-of-magnitude lie cannot.
 *
 * A source that echoes NEITHER a window nor a sample count carries no cadence
 * evidence at all, and is refused rather than skipped (the same posture the
 * timestep checks above already take for their own absent fields).
 */

import type { AcceptanceContract } from "../types.js";
import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import type { FeelMeasurements, FeelMeasurementSource } from "./feel.js";
import { measuredAcceptedMetrics } from "./feel-provenance.js";

export const GATE_NAME = "physics-timestep";

const ABS_TOLERANCE = 1e-4;

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= ABS_TOLERANCE;
}

function sourcesCoveringMetrics(input: FeelMeasurements, acceptance: AcceptanceContract): FeelMeasurementSource[] {
  const metrics = new Set(measuredAcceptedMetrics(input, acceptance));
  const sources = input.provenance?.sources ?? [];
  return sources.filter((source) => source.measuredMetrics?.some((metric) => metrics.has(metric)));
}

function timestepCheck(
  id: string,
  expected: number,
  sources: FeelMeasurementSource[],
  field: "projectFixedTimestepBeforeMeasurement" | "measurementFixedTimestep",
  label: string,
): GateCheck {
  const missing = sources.filter((source) => typeof source[field] !== "number" || !Number.isFinite(source[field]));
  const mismatched = sources.filter((source) => typeof source[field] === "number" && Number.isFinite(source[field]) && !near(source[field]!, expected));
  const actual = sources
    .map((source, index) => `${index}:${source.source ?? "(missing source)"}=${source[field] ?? "(absent)"}`)
    .join(", ");
  return {
    id,
    expected: `${expected} ±${ABS_TOLERANCE}`,
    actual: actual || "(none)",
    status: missing.length === 0 && mismatched.length === 0 ? "pass" : "fail",
    detail:
      missing.length > 0
        ? `${label} is absent for ${missing.length} source(s); cannot verify feel timing.`
        : mismatched.length > 0
          ? `${label} does not match acceptance.physics.fixedTimestep for ${mismatched.length} source(s).`
          : `${label} matches acceptance.physics.fixedTimestep for every measurement source.`,
  };
}

/**
 * Divergence tolerance for the effective-cadence re-derivation, in SAMPLES.
 * Exactly one tick: `1 + eps` so a capture that differs only by the endpoint
 * convention (N samples spanning N-1 intervals) passes, and anything larger does
 * not.
 */
const CADENCE_TOLERANCE_SAMPLES = 1 + 1e-6;

/** One source's cadence, re-derived from its own echoes (never from the label). */
interface EffectiveCadence {
  /** Refusal text when the source carries no re-derivable cadence evidence. */
  refusal: string | null;
  sampleCount: number | null;
  windowMs: number | null;
  /** Where the window came from, for the report. */
  windowFrom: "durationMs" | "samples[].tMs span" | null;
  effectiveFps: number | null;
  expectedSamples: number | null;
  /** |sampleCount - expectedSamples|, in samples. */
  divergenceSamples: number | null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Re-derive the sampling cadence a source ACTUALLY achieved. Pure: it reads only
 * fields the bridge echoed back, never the reported metric values.
 */
export function effectiveCadenceFor(source: FeelMeasurementSource): EffectiveCadence {
  const empty: EffectiveCadence = {
    refusal: null,
    sampleCount: null,
    windowMs: null,
    windowFrom: null,
    effectiveFps: null,
    expectedSamples: null,
    divergenceSamples: null,
  };

  const declaredFps = positive(source.captureFps);
  const sampleCount = positive(source.sampleCount) ?? (source.samples && source.samples.length > 0 ? source.samples.length : null);

  let windowMs = positive(source.durationMs);
  let windowFrom: EffectiveCadence["windowFrom"] = windowMs === null ? null : "durationMs";
  if (windowMs === null && source.samples && source.samples.length >= 2) {
    const times = source.samples.map((s) => s.tMs).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    if (times.length >= 2) {
      const span = Math.max(...times) - Math.min(...times);
      if (span > 0) {
        windowMs = span;
        windowFrom = "samples[].tMs span";
      }
    }
  }

  const absent: string[] = [];
  if (declaredFps === null) absent.push("captureFps");
  if (sampleCount === null) absent.push("sampleCount (and no samples[])");
  if (windowMs === null) absent.push("durationMs (and no usable samples[].tMs span)");
  if (absent.length > 0) {
    return {
      ...empty,
      refusal: `absent ${absent.join(" + ")}`,
      sampleCount,
      windowMs,
      windowFrom,
    };
  }

  const effectiveFps = sampleCount! / (windowMs! / 1000);
  const expectedSamples = declaredFps! * (windowMs! / 1000);
  return {
    refusal: null,
    sampleCount,
    windowMs,
    windowFrom,
    effectiveFps,
    expectedSamples,
    divergenceSamples: Math.abs(sampleCount! - expectedSamples),
  };
}

/**
 * L47: grade the cadence the run ACHIEVED, not the one it declares. A source is
 * refused when it carries no cadence evidence, and failed when the re-derived
 * cadence diverges from `captureFps` by more than one tick.
 */
function effectiveCadenceCheck(sources: FeelMeasurementSource[]): GateCheck {
  const rows = sources.map((source, index) => ({ index, source, cadence: effectiveCadenceFor(source) }));
  const unbacked = rows.filter((row) => row.cadence.refusal !== null);
  const diverged = rows.filter(
    (row) => row.cadence.refusal === null && row.cadence.divergenceSamples! > CADENCE_TOLERANCE_SAMPLES,
  );

  const actual =
    rows
      .map(({ index, source, cadence }) =>
        cadence.refusal !== null
          ? `${index}:${source.source ?? "(missing source)"} NOT RE-DERIVABLE (${cadence.refusal})`
          : `${index}:${source.source ?? "(missing source)"} declared=${source.captureFps}fps, effective=${cadence.effectiveFps!.toFixed(2)}fps ` +
            `(${cadence.sampleCount} samples / ${cadence.windowMs!.toFixed(2)}ms from ${cadence.windowFrom}), ` +
            `expected ${cadence.expectedSamples!.toFixed(2)} samples, off by ${cadence.divergenceSamples!.toFixed(2)}`,
      )
      .join("; ") || "(none)";

  const ok = unbacked.length === 0 && diverged.length === 0;
  return {
    id: "physics-timestep.effectiveCadence",
    expected: `re-derived sampling cadence within ${CADENCE_TOLERANCE_SAMPLES.toFixed(0)} sample of the declared captureFps`,
    actual,
    status: ok ? "pass" : "fail",
    detail: ok
      ? "Every source's echoed sampleCount and measurement window re-derive the cadence it declares."
      : unbacked.length > 0
        ? `${unbacked.length} source(s) carry no re-derivable cadence evidence (need captureFps + sampleCount + durationMs, or samples[] with tMs); a self-declared captureFps cannot be graded against itself, so this is refused, not skipped (ledger L47).`
        : `${diverged.length} source(s) sampled at a cadence more than one tick from the captureFps they declare; the file's timing convention does not describe the run that produced it (ledger L47).`,
  };
}

/**
 * H8: the request/reality PAIR a produced source records.
 *
 * `captureFps` is an INPUT to the capture ops; none of them echo it back. A file
 * carrying it alone therefore states an intention, and the door-one run shipped an
 * ~11Hz capture under a file that said 120 (L45/L47). A producer records both
 * `requestedCaptureFps` (what it asked for) and `effectiveCaptureFps` (what the run
 * achieved): but a recorded derivation is only worth something if someone
 * re-derives it, so this check refuses when the recorded effective value disagrees
 * with the gate's own re-derivation, or when the recorded request disagrees with the
 * `captureFps` every other check grades. Half a pair is also a refusal: a source
 * that records the flattering member and drops the other is exactly the shape this
 * exists to catch.
 */
function recordedCadencePairCheck(sources: FeelMeasurementSource[]): GateCheck {
  const problems: string[] = [];
  const rows: string[] = [];
  for (const [index, source] of sources.entries()) {
    const label = `${index}:${source.source ?? "(missing source)"}`;
    const requested = source.requestedCaptureFps;
    const effective = source.effectiveCaptureFps;
    rows.push(`${label} requested=${requested ?? "(absent)"}, effective=${effective ?? "(absent)"}`);
    if (requested === undefined || !Number.isFinite(requested)) {
      problems.push(`${label} records effectiveCaptureFps but no requestedCaptureFps`);
    } else if (typeof source.captureFps === "number" && !near(requested, source.captureFps)) {
      problems.push(`${label} records requestedCaptureFps ${requested} while captureFps says ${source.captureFps}`);
    }
    if (effective === undefined || !Number.isFinite(effective)) {
      problems.push(`${label} records requestedCaptureFps but no effectiveCaptureFps`);
      continue;
    }
    const cadence = effectiveCadenceFor(source);
    if (cadence.refusal !== null || cadence.effectiveFps === null) {
      problems.push(`${label} records an effectiveCaptureFps that cannot be re-derived (${cadence.refusal ?? "no cadence"})`);
      continue;
    }
    // One sample of slack: N samples span N-1 intervals, so the two honest endpoint
    // conventions differ by exactly that and nothing larger.
    const spread = Math.abs(effective - cadence.effectiveFps);
    const oneSample = cadence.windowMs === null ? 0 : 1000 / cadence.windowMs;
    if (spread > oneSample + 1e-6) {
      problems.push(
        `${label} records effectiveCaptureFps ${effective.toFixed(2)} but its own echoes re-derive ${cadence.effectiveFps.toFixed(2)}`,
      );
    }
  }
  return {
    id: "physics-timestep.recordedCadencePair",
    expected: "requestedCaptureFps === captureFps, and effectiveCaptureFps === the cadence re-derived from the source's own echoes",
    actual: rows.join("; ") || "(none)",
    status: problems.length === 0 ? "pass" : "fail",
    detail:
      problems.length === 0
        ? "Every source recording a request/reality cadence pair agrees with the re-derivation from its own echoes."
        : `${problems.length} problem(s): ${problems.join("; ")}. A recorded derivation nobody re-derives is a self-declared number (ledger L45/L47, review H8).`,
  };
}

export function evaluatePhysicsTimestep(
  input: FeelMeasurements,
  acceptance: AcceptanceContract,
): GateReport {
  const expected = acceptance.physics?.fixedTimestep;
  if (expected === undefined) {
    return makeGateReport(GATE_NAME, [
      {
        id: "physics-timestep.contract",
        expected: "acceptance.physics.fixedTimestep",
        actual: "(absent)",
        status: "not_applicable",
        detail: "No physics.fixedTimestep contract is declared; timestep verification is not applicable.",
      },
    ]);
  }

  const metrics = measuredAcceptedMetrics(input, acceptance);
  if (metrics.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "physics-timestep.data",
        expected: "≥1 measured accepted feel metric",
        actual: "(none)",
        status: "warn",
        detail: "No accepted feel measurements were captured; physics timestep provenance was not evaluated.",
      },
    ]);
  }

  const sources = sourcesCoveringMetrics(input, acceptance);
  if (sources.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "physics-timestep.sources",
        expected: "provenance source(s) covering measured accepted metrics",
        actual: "(none)",
        status: "fail",
        detail: "No provenance source covers the measured feel metrics; cannot verify project or measurement timestep.",
      },
    ]);
  }

  const checks: GateCheck[] = [
    timestepCheck(
      "physics-timestep.project",
      expected,
      sources,
      "projectFixedTimestepBeforeMeasurement",
      "Project fixed timestep before measurement",
    ),
    timestepCheck(
      "physics-timestep.measurement",
      expected,
      sources,
      "measurementFixedTimestep",
      "Measurement fixed timestep",
    ),
  ];

  const fpsMismatched = sources.filter((source) => {
    if (typeof source.captureFps !== "number" || !Number.isFinite(source.captureFps) || source.captureFps <= 0) return true;
    if (typeof source.measurementFixedTimestep !== "number" || !Number.isFinite(source.measurementFixedTimestep)) return true;
    // captureFps is the transform-SAMPLING cadence; measurementFixedTimestep is the
    // PHYSICS step rate (already pinned-equal to the project's fixedTimestep by the
    // checks above). They match when captureFps == 1/measurementFixedTimestep, OR when
    // sampling is a finer integer multiple of the physics rate (e.g. 120fps sampling of
    // a 60Hz sim) — finer sampling never corrupts the physics, it only resolves a tight
    // transient (the shortest hop) the physics-rate sampling would frame-quantize.
    // samplesPerStep = captureFps / physicsFps = captureFps * measurementFixedTimestep;
    // computed multiplicatively so a rounded timestep (0.0166667 ≈ 1/60) stays robust
    // rather than amplifying through a 1/x. A finer multiple is a near-integer ≥ 1; the
    // 1e-3 window cleanly separates real multiples from non-multiples (1.5×, 1.2×).
    if (near(1 / source.captureFps, source.measurementFixedTimestep)) return false;
    const samplesPerStep = source.captureFps * source.measurementFixedTimestep;
    const isFinerInteger = samplesPerStep >= 1 - 1e-3 && Math.abs(samplesPerStep - Math.round(samplesPerStep)) <= 1e-3;
    return !isFinerInteger;
  });
  checks.push({
    id: "physics-timestep.captureFps",
    expected: "1 / captureFps ≈ measurementFixedTimestep",
    actual: sources
      .map((source, index) => `${index}:${source.source ?? "(missing source)"} fps=${source.captureFps ?? "(absent)"}, measurement=${source.measurementFixedTimestep ?? "(absent)"}`)
      .join(", "),
    status: fpsMismatched.length === 0 ? "pass" : "warn",
    detail:
      fpsMismatched.length === 0
        ? "captureFps is consistent with measurementFixedTimestep for every measurement source."
        : "One or more sources has captureFps inconsistent with measurementFixedTimestep; verify harness pinning.",
  });

  // L47: the declared cadence, re-derived from the run's own echoes.
  checks.push(effectiveCadenceCheck(sources));

  // H8: a produced source records the request/reality PAIR. Grade the recorded pair
  // against this gate's own re-derivation so the second number cannot be flattering.
  const recordedPair = sources.filter(
    (source) => source.requestedCaptureFps !== undefined || source.effectiveCaptureFps !== undefined,
  );
  if (recordedPair.length > 0) checks.push(recordedCadencePairCheck(recordedPair));

  return makeGateReport(GATE_NAME, checks);
}
