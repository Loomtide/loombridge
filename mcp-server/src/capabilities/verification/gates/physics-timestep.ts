/**
 * Physics-timestep gate.
 *
 * Checks that both the project's configured fixed timestep and the measurement
 * timestep used by feel captures match the acceptance contract. This prevents a
 * harness from pinning measurement time to 60Hz while the shipped project still
 * runs at Unity's default 50Hz.
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

  return makeGateReport(GATE_NAME, checks);
}
