/**
 * GATE-SIDE ENGAGEMENT with the produced feel.json (evidence arc stage 2, S2d).
 *
 * Three bindings land here, each closing a specific ledger hole:
 *
 *   L38/L75  `SOURCE_METRIC_OWNERSHIP` made `runtime.probe` the sole owner of
 *            coyoteTime/jumpBuffer while `validMeasurementSource` demanded three
 *            fields the probe does not echo, so the only route to a green was for the
 *            writer to type them. The producer's sweeps run on
 *            `runtime.capture_input_motion`, which echoes them: and that ownership is
 *            granted ONLY to a source that also retains its trials.
 *
 *   L76/L77  the sweep headline is re-derived from the retained trials by the same
 *            pure function the producer used. A bumped headline no longer survives.
 *
 *   H8       a produced source records requested vs effective captureFps, and the
 *            gate re-derives the effective one from the source's own echoes.
 *
 * M19 ordering: every fixture below carries a VALID producer stamp and complete
 * echo fields, so the check under test is the one that fires. A fixture that failed
 * an earlier refusal would prove nothing about the check it is named after.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFeelRederive } from "../../../../capabilities/verification/gates/feel-rederive.js";
import {
  evaluateFeelProvenance,
  validMeasurementSourceForMetric,
} from "../../../../capabilities/verification/gates/feel-provenance.js";
import { evaluatePhysicsTimestep } from "../../../../capabilities/verification/gates/physics-timestep.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import type { FeelMeasurements } from "../../../../capabilities/verification/gates/feel.js";
import { deriveSweepMetric, type SweepTrialEcho } from "../../../../domain/feel-primitives.js";

const DT = 1 / 60;

// ── synthetic sweep trials (the echo shape the producer retains) ─────────────

/**
 * One coyote trial: flat ground until `ungroundIndex`, then a fall; when `jumped`,
 * the trajectory rises again right after the press. Shaped exactly like the bridge's
 * echo (per-phase sampleCounts + samples), because that is what the gate re-reads.
 */
function coyoteTrial(index: number, pressIndex: number, ungroundIndex: number, jumped: boolean): SweepTrialEcho {
  const total = 60;
  const samples = [];
  let y = 0;
  let vy = 0;
  for (let i = 0; i <= total; i += 1) {
    if (i >= ungroundIndex) {
      if (jumped && i === pressIndex + 1) vy = 0.4;
      vy -= 0.03;
      y += vy;
    }
    samples.push({ tMs: i * DT * 1000, x: i * 0.1, y });
  }
  return {
    index,
    pressPhaseIndex: 1,
    phases: [
      { index: 0, sampleCount: pressIndex, keys: ["D"] },
      { index: 1, sampleCount: 2, keys: ["D", "Space"], requestedFixedTicks: 2, actualFixedTicks: 2 },
      { index: 2, sampleCount: total - pressIndex - 2, keys: ["D"] },
    ],
    samples,
  };
}

/** A whole sweep whose true threshold is `thresholdTicks` (elapsed = index offset). */
function coyoteSweep(thresholdTicks: number): SweepTrialEcho[] {
  const ungroundIndex = 20;
  const trials: SweepTrialEcho[] = [];
  for (let offset = 1; offset <= 12; offset += 1) {
    // elapsed = press - unground + 2  ⇒  press = unground + offset - 2
    const pressIndex = ungroundIndex + offset - 2;
    trials.push(coyoteTrial(offset, pressIndex, ungroundIndex, offset <= thresholdTicks));
  }
  return trials;
}

const SWEEP = coyoteSweep(6);
const SWEEP_VALUE = deriveSweepMetric("coyoteTime", SWEEP, DT).windowSeconds!;

/**
 * The sweep's cadence pair, summed off the TRIALS rather than typed: a sweep source's
 * `sampleCount`/`durationMs` aggregate its trial windows, and the fixture has to be
 * the shape the producer really writes or it proves nothing about the check. Each of
 * the 12 trials is 61 samples spanning 1000ms, so the pair is 732 samples over
 * 12000ms with 12 fenceposts, which re-derives exactly 60fps.
 */
const SWEEP_SAMPLE_COUNT = SWEEP.reduce((sum, t) => sum + t.samples.length, 0);
const SWEEP_DURATION_MS = SWEEP.reduce((sum, t) => sum + (t.samples[t.samples.length - 1].tMs - t.samples[0].tMs), 0);
const SWEEP_EFFECTIVE_FPS = (SWEEP_SAMPLE_COUNT - SWEEP.length) / (SWEEP_DURATION_MS / 1000);

function sweepSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "runtime.capture_input_motion",
    producedBy: "loombridge-capture",
    derivation: "input-bisection",
    measuredMetrics: ["coyoteTime"],
    sampleCount: SWEEP_SAMPLE_COUNT,
    durationMs: SWEEP_DURATION_MS,
    windowCount: SWEEP.length,
    captureFps: 60,
    requestedCaptureFps: 60,
    effectiveCaptureFps: Math.round(SWEEP_EFFECTIVE_FPS * 1e4) / 1e4,
    measuredAt: "2026-07-30T00:00:00.000Z",
    projectFixedTimestepBeforeMeasurement: DT,
    measurementFixedTimestep: DT,
    trials: SWEEP,
    ...overrides,
  };
}

function acceptance(): AcceptanceContract {
  return {
    schemaVersion: "1",
    game: "fixture",
    physics: { fixedTimestep: DT },
    feel: {
      coyoteTime: { target: 0.1, unit: "s", band: { abs: 0.02 } },
      dashDistance: { target: 2.8, unit: "u", band: { percent: 10 } },
    },
  } as unknown as AcceptanceContract;
}

function measurements(overrides: Record<string, unknown> = {}): FeelMeasurements {
  return {
    coyoteTime: SWEEP_VALUE,
    provenance: { sources: [sweepSource()] },
    ...overrides,
  } as unknown as FeelMeasurements;
}

function checkFor(report: { checks: { id: string; status: string; detail?: string }[] }, id: string) {
  const check = report.checks.find((c) => c.id === id);
  assert.ok(check, `no check ${id} in ${report.checks.map((c) => c.id).join(", ")}`);
  return check!;
}

// ── the sweep binding (L76/L77) ─────────────────────────────────────────────

test("positive control: a produced sweep whose headline re-derives from its trials PASSES", () => {
  const report = evaluateFeelRederive(measurements(), acceptance());
  assert.equal(checkFor(report, "feel-rederive.coyoteTime").status, "pass");
});

test("LITMUS: bumping the headline by ONE TICK is refused (the laundering detector)", () => {
  // One tick is the whole point: the ledger's `+2` convention swing moved coyoteTime
  // from 0.0667 to 0.1000 across the pass boundary, and nothing re-derived it.
  const report = evaluateFeelRederive(measurements({ coyoteTime: SWEEP_VALUE + DT }), acceptance());
  const check = checkFor(report, "feel-rederive.coyoteTime");
  assert.equal(check.status, "fail");
  assert.match(check.detail ?? "", /does NOT match the re-derivation/);
});

test("a sweep source that reports a value and retains NO trials is refused (L77)", () => {
  const source = sweepSource();
  delete source.trials;
  const report = evaluateFeelRederive(
    measurements({ provenance: { sources: [source] } }),
    acceptance(),
  );
  const check = checkFor(report, "feel-rederive.coyoteTime");
  assert.equal(check.status, "fail");
  assert.match(check.detail ?? "", /retains NO trials/);
});

test("a sweep source with no echoed measurementFixedTimestep is refused, not skipped", () => {
  const source = sweepSource();
  delete source.measurementFixedTimestep;
  const report = evaluateFeelRederive(
    measurements({ provenance: { sources: [source] } }),
    acceptance(),
  );
  assert.equal(checkFor(report, "feel-rederive.coyoteTime").status, "fail");
});

test("trials that no longer bracket a threshold refuse rather than pass the old headline", () => {
  const everyTrialJumped = coyoteSweep(99);
  const report = evaluateFeelRederive(
    measurements({ provenance: { sources: [sweepSource({ trials: everyTrialJumped })] } }),
    acceptance(),
  );
  const check = checkFor(report, "feel-rederive.coyoteTime");
  assert.equal(check.status, "fail");
  assert.match(check.detail ?? "", /do not resolve a threshold/);
});

// ── ownership (L38/L75) ─────────────────────────────────────────────────────

test("a capture_input_motion sweep source with retained trials may certify coyoteTime", () => {
  assert.equal(validMeasurementSourceForMetric(sweepSource() as never, "coyoteTime"), true);
  assert.equal(validMeasurementSourceForMetric(sweepSource() as never, "jumpBuffer"), false, "it did not measure jumpBuffer");
});

test("the same source WITHOUT trials may not: the ownership is granted to the evidence, not the label", () => {
  const bare = sweepSource();
  delete bare.trials;
  assert.equal(validMeasurementSourceForMetric(bare as never, "coyoteTime"), false);
  const undeclared = sweepSource({ derivation: "trajectory" });
  assert.equal(validMeasurementSourceForMetric(undeclared as never, "coyoteTime"), false);
});

test("feel-provenance passes a produced sweep end to end (all fields from the echo)", () => {
  const report = evaluateFeelProvenance(measurements(), acceptance());
  assert.equal(checkFor(report, "feel-provenance.coyoteTime").status, "pass");
});

test("THE WALL: the producer's runtime.probe dash source is REFUSED, because the op echoes no timestep fields (L75)", () => {
  // This is the honest outcome the stage-2 producer ships: the dash is measured and
  // written, and it cannot be certified, because the only way to satisfy
  // validMeasurementSource today is to TYPE the three fields runtime.probe never
  // echoes: which is exactly the door-one laundering this arc exists to end.
  const dashSource = {
    source: "runtime.probe",
    producedBy: "loombridge-capture",
    derivation: "window-delta",
    measuredMetrics: ["dashDistance"],
    sampleCount: 57,
    durationMs: 950,
    measuredAt: "2026-07-30T00:00:00.000Z",
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 950, x: 2.8125, y: 0 },
    ],
    notEchoedByOp: ["captureFps", "projectFixedTimestepBeforeMeasurement", "measurementFixedTimestep"],
  };
  assert.equal(validMeasurementSourceForMetric(dashSource as never, "dashDistance"), false);
  const report = evaluateFeelProvenance(
    { dashDistance: 2.8125, provenance: { sources: [dashSource] } } as unknown as FeelMeasurements,
    acceptance(),
  );
  assert.equal(checkFor(report, "feel-provenance.dashDistance").status, "fail");

  // …and the SAME source with the three fields present certifies, so the refusal is
  // about the missing echoes and nothing else (the positive control for the wall).
  const withEchoes = { ...dashSource, captureFps: 60, projectFixedTimestepBeforeMeasurement: DT, measurementFixedTimestep: DT };
  assert.equal(validMeasurementSourceForMetric(withEchoes as never, "dashDistance"), true);
});

test("the whole-window dash re-derives from its own samples, and a bumped value is refused (L42/L91)", () => {
  const dashSource = {
    source: "runtime.probe",
    producedBy: "loombridge-capture",
    derivation: "window-delta",
    measuredMetrics: ["dashDistance"],
    samples: [
      { tMs: 0, x: 1, y: 0 },
      { tMs: 500, x: 2.5, y: 0 },
      { tMs: 950, x: 3.8125, y: 0 },
    ],
  };
  const ok = evaluateFeelRederive(
    { dashDistance: 2.8125, provenance: { sources: [dashSource] } } as unknown as FeelMeasurements,
    acceptance(),
  );
  assert.equal(checkFor(ok, "feel-rederive.dashDistance").status, "pass");

  const bumped = evaluateFeelRederive(
    { dashDistance: 2.95, provenance: { sources: [dashSource] } } as unknown as FeelMeasurements,
    acceptance(),
  );
  assert.equal(checkFor(bumped, "feel-rederive.dashDistance").status, "fail");
});

// ── the recorded cadence pair (H8) ──────────────────────────────────────────

test("physics-timestep: a recorded requested/effective pair that matches the echoes passes", () => {
  const report = evaluatePhysicsTimestep(measurements(), acceptance());
  assert.equal(checkFor(report, "physics-timestep.recordedCadencePair").status, "pass");
});

test("LITMUS: a flattering effectiveCaptureFps is refused by the gate's own re-derivation", () => {
  const report = evaluatePhysicsTimestep(
    measurements({ provenance: { sources: [sweepSource({ effectiveCaptureFps: 120 })] } }),
    acceptance(),
  );
  const check = checkFor(report, "physics-timestep.recordedCadencePair");
  assert.equal(check.status, "fail");
  assert.match(check.detail ?? "", /re-derive/);
});

test("half a pair is a refusal: recording only the flattering member cannot pass", () => {
  const source = sweepSource();
  delete source.effectiveCaptureFps;
  const report = evaluatePhysicsTimestep(
    measurements({ provenance: { sources: [source] } }),
    acceptance(),
  );
  assert.equal(checkFor(report, "physics-timestep.recordedCadencePair").status, "fail");
});

test("a source recording NO pair is unaffected (legacy files keep their existing verdict)", () => {
  const legacy = sweepSource();
  delete legacy.requestedCaptureFps;
  delete legacy.effectiveCaptureFps;
  const report = evaluatePhysicsTimestep(
    measurements({ provenance: { sources: [legacy] } }),
    acceptance(),
  );
  assert.equal(
    report.checks.find((c) => c.id === "physics-timestep.recordedCadencePair"),
    undefined,
  );
});
