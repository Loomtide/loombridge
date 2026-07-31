/**
 * THE FEEL INSTRUMENT, PINNED TO THE LIVE RUN THAT BROKE IT (E6).
 *
 * Every fixture here is READ FROM the committed evidence bundle
 * `demos/evidence-bundles/feel-instrument-e6-live`, which is the verbatim output of
 * the first run in which the feel producer and the physics-timestep gate met a real
 * editor. They shipped in one commit and had only ever been exercised against a
 * scripted bridge whose echoes are not rounded and whose game has no hazards, and the
 * live run failed on all of it at once.
 *
 * So these tests are not synthetic. A fixture invented for this file would be free to
 * be as clean as the one that let the bug ship: the numbers below are the bridge's.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { effectiveCadenceFor, evaluatePhysicsTimestep } from "../../../../capabilities/verification/gates/physics-timestep.js";
import { evaluateFeelProvenance } from "../../../../capabilities/verification/gates/feel-provenance.js";
import {
  collapseExactDuplicateSamples,
  deriveJumpApex,
  deriveRunSpeed,
  deriveTimeToApex,
  isStaticTrajectory,
  isValidTrajectory,
} from "../../../../capabilities/verification/feel-derive.js";
import { effectiveCaptureFps } from "../../../../capabilities/verification/capture-feel.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import type { FeelMeasurements, FeelMeasurementSource, FeelTrajectorySample } from "../../../../capabilities/verification/gates/feel.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const BUNDLE = join(REPO_ROOT, "demos/evidence-bundles/feel-instrument-e6-live");

function readBundle<T>(name: string): T {
  return JSON.parse(readFileSync(join(BUNDLE, name), "utf8")) as T;
}

interface LiveFeel {
  [metric: string]: unknown;
  provenance: { sources: FeelMeasurementSource[] };
}

const RUN1 = readBundle<LiveFeel>("tiderunner-feel-run1-2026-07-31.json");
const RUN2 = readBundle<LiveFeel>("tiderunner-feel-run2-2026-07-31.json");
const RAW_RUN_LEG = readBundle<{ samples: FeelTrajectorySample[]; sampleCount: number; durationMs: number }>(
  "tiderunner-raw-run-leg-duplicate-2026-07-31.json",
);

function sourceFor(feel: LiveFeel, metric: string): FeelMeasurementSource {
  const found = feel.provenance.sources.find((s) => s.measuredMetrics?.includes(metric));
  assert.ok(found, `no live source measures ${metric}`);
  return found!;
}

/** The contract TideRunner was graded against, in the fields these gates read. */
function acceptance(): AcceptanceContract {
  return {
    schemaVersion: "1",
    game: "tiderunner",
    physics: { fixedTimestep: 0.016667 },
    feel: {
      runSpeed: { target: 7, unit: "u/s", band: { percent: 5 } },
      jumpApex: { target: 2.2, unit: "u", band: { percent: 5 } },
      timeToApex: { target: 325, unit: "ms", band: { percent: 10 } },
      shortHopApex: { target: 1.41, unit: "u", band: { percent: 10 } },
      dashDistance: { target: 2.8125, unit: "u", band: { percent: 5 } },
      coyoteTime: { target: 0.1, unit: "s", band: { abs: 0.02 } },
      jumpBuffer: { target: 0.1, unit: "s", band: { abs: 0.02 } },
    },
  } as unknown as AcceptanceContract;
}

// ── 1. cadence arithmetic ───────────────────────────────────────────────────

test("E6: every source the LIVE run produced re-derives its own declared cadence", () => {
  // The exact triples the bridge echoed. All four are honest captures and all four
  // failed the shipped gate; the fencepost is what they were missing.
  const expected = [
    { n: 218, durationMs: 1808.33, fps: 120, windows: 1 },
    { n: 182, durationMs: 1508.33, fps: 120, windows: 1 },
    { n: 815, durationMs: 13416.67, fps: 60, windows: 10 },
    { n: 58, durationMs: 950, fps: 60, windows: 1 },
  ];
  assert.equal(RUN1.provenance.sources.length, expected.length);

  RUN1.provenance.sources.forEach((source, index) => {
    const want = expected[index];
    assert.equal(source.sampleCount, want.n, `source ${index} sampleCount`);
    assert.equal(source.durationMs, want.durationMs, `source ${index} durationMs`);
    assert.equal(source.captureFps, want.fps, `source ${index} captureFps`);

    const cadence = effectiveCadenceFor(source);
    assert.equal(cadence.refusal, null);
    assert.equal(cadence.windows, want.windows, `source ${index} windows counted off its own evidence`);
    assert.ok(
      cadence.divergenceSamples! <= cadence.slackSamples!,
      `source ${index}: off by ${cadence.divergenceSamples} against slack ${cadence.slackSamples}`,
    );
  });
});

test("E6: the live sweep's ten trial windows really do run at 60fps each, and 60.6708 was the producer's error", () => {
  const sweep = sourceFor(RUN1, "jumpBuffer");
  const trials = sweep.trials as { samples: { tMs: number }[] }[];
  assert.equal(trials.length, 10);
  for (const trial of trials) {
    const span = trial.samples[trial.samples.length - 1].tMs - trial.samples[0].tMs;
    const rate = (trial.samples.length - 1) / (span / 1000);
    assert.ok(Math.abs(rate - 60) < 1e-3, `a trial window ran at ${rate}fps`);
  }
  // The shipped producer divided by ONE fencepost across all ten windows.
  assert.equal(sweep.effectiveCaptureFps, 60.6708);
  assert.ok(Math.abs(effectiveCaptureFps(815, 13416.67, 1)! - 60.6708) < 1e-3);
  // With one fencepost PER window it is exactly the rate the trials show.
  assert.ok(Math.abs(effectiveCaptureFps(815, 13416.67, 10)! - 60) < 1e-4);
});

test("E6 LITMUS: the recorded-pair check catches the sweep's own wrong effectiveCaptureFps, and passes the corrected one", () => {
  const sweep = { ...sourceFor(RUN1, "jumpBuffer") };
  const measurements = { jumpBuffer: 0.1, provenance: { sources: [sweep] } } as unknown as FeelMeasurements;

  const asShipped = evaluatePhysicsTimestep(measurements, acceptance());
  const shippedCheck = asShipped.checks.find((c) => c.id === "physics-timestep.recordedCadencePair")!;
  assert.equal(shippedCheck.status, "fail", "60.6708 does not re-derive from ten windows");
  assert.match(shippedCheck.detail ?? "", /re-derive/);

  sweep.effectiveCaptureFps = 60;
  const corrected = evaluatePhysicsTimestep(measurements, acceptance());
  assert.equal(corrected.checks.find((c) => c.id === "physics-timestep.recordedCadencePair")!.status, "pass");
});

test("E6 LITMUS: the fps-0 disease (109 samples where 217 are expected) still FAILS", () => {
  // The shape a scripted harness produces when it samples once per physics step under
  // a declared 120fps: exactly half the samples. The tolerance fix must not soften it.
  const jump = { ...sourceFor(RUN1, "jumpApex"), sampleCount: 109 };
  delete (jump as { samples?: unknown }).samples;
  const check = evaluatePhysicsTimestep(
    { jumpApex: 2.2239, provenance: { sources: [jump] } } as unknown as FeelMeasurements,
    acceptance(),
  ).checks.find((c) => c.id === "physics-timestep.effectiveCadence")!;
  assert.equal(check.status, "fail");
  assert.match(check.actual, /off by 10[89]/);

  // POSITIVE CONTROL: the SAME source with the count the bridge really echoed passes,
  // so the refusal is about the cadence and nothing else.
  const honest = { ...jump, sampleCount: 218 };
  assert.equal(
    evaluatePhysicsTimestep(
      { jumpApex: 2.2239, provenance: { sources: [honest] } } as unknown as FeelMeasurements,
      acceptance(),
    ).checks.find((c) => c.id === "physics-timestep.effectiveCadence")!.status,
    "pass",
  );
});

// ── 2. timeToApex from launch ───────────────────────────────────────────────

test("E6: the live jump arc measures 308.33ms from LAUNCH, not the 533.33ms that shipped", () => {
  const jump = sourceFor(RUN1, "jumpApex");
  const samples = jump.samples as FeelTrajectorySample[];
  assert.equal(samples.length, 218);

  // What SHIPPED: first-sample-to-apex, which is 208.33ms of settle prefix plus the rise.
  assert.equal(RUN1.timeToApex, 533.33);
  const apexT = samples.reduce((best, s) => (s.y > best.y ? s : best), samples[0]).tMs;
  assert.equal(apexT - samples[0].tMs, 533.33);

  // What the fixed derivation reads off the SAME samples.
  assert.ok(Math.abs(deriveTimeToApex(samples)! - 308.33) < 1e-9, `timeToApex ${deriveTimeToApex(samples)}`);

  // …and that is inside the contract band the run was graded against (325ms +/-10%),
  // which the 533.33ms reading failed. The analytic v0/g for this arc is 312.5ms
  // (0.225u launch tick decaying 0.012u/tick => v0 13.5 u/s, g 43.2 u/s^2), so the
  // takeoff anchor is half a sample low where the risen-sample anchor is 1.5 low.
  assert.ok(Math.abs(308.33 - 325) / 325 <= 0.1);
  assert.ok(Math.abs(308.33 - 312.5) <= 8.34);

  // jumpApex is untouched by the anchor change: it was in band before and still is.
  assert.ok(Math.abs(deriveJumpApex(samples) - 2.2239) < 1e-3);
});

test("E6 LITMUS: a trajectory that never rises has no launch, so timeToApex is null, never a settle duration", () => {
  const flat = (RUN2.provenance.sources[0]!.samples as FeelTrajectorySample[]).slice(0, 40);
  assert.equal(deriveTimeToApex(flat), null);
  // POSITIVE CONTROL: the same function on the real rising arc answers.
  const rising = deriveTimeToApex(sourceFor(RUN1, "jumpApex").samples as FeelTrajectorySample[]);
  assert.ok(rising !== null && Math.abs(rising - 308.33) < 1e-9);
});

// ── 4. the frozen corpse ────────────────────────────────────────────────────

test("E6: run 2's flat 218-sample trajectory is DEGENERATE, and deriving it yields the zeroes that shipped", () => {
  const source = RUN2.provenance.sources[0]!;
  const samples = source.samples as FeelTrajectorySample[];
  assert.equal(samples.length, 218);
  assert.ok(samples.every((s) => s.x === 6.4 && s.y === 1.51499975), "the player never moved");

  // THE LITMUS, standing in for reverting the refusal: the derivations themselves are
  // still perfectly willing to answer 0, which is exactly the shipped verdict shape.
  assert.equal(deriveJumpApex(samples), 0);
  assert.equal(RUN2.jumpApex, 0);
  assert.equal(RUN2.timeToApex, 0);
  assert.equal(deriveRunSpeed(samples), 0);

  // The named refusal is what stops the zero from being written.
  assert.equal(isStaticTrajectory(samples), true);
  assert.equal(isValidTrajectory(samples), true, "a frozen trajectory is well-formed; that is the whole problem");
  // POSITIVE CONTROL: the live MOVING trajectory is not degenerate.
  assert.equal(isStaticTrajectory(sourceFor(RUN1, "jumpApex").samples as FeelTrajectorySample[]), false);
});

test("E6: feel-provenance cannot bless a metric that was omitted for degeneracy", () => {
  // The corpse's own source, with the metrics omitted the way the fixed producer omits
  // them: no value, and the source does not list them. The gate must not certify them.
  const source = { ...RUN2.provenance.sources[0]!, measuredMetrics: [] as string[] };
  const report = evaluateFeelProvenance(
    { provenance: { sources: [source] } } as unknown as FeelMeasurements,
    acceptance(),
  );
  assert.equal(report.checks.find((c) => c.id === "feel-provenance.jumpApex"), undefined);
  assert.equal(report.checks.find((c) => c.id === "feel-provenance.data")!.status, "warn");

  // LITMUS: put the zero BACK (what shipped) and the gate certifies it happily: the
  // gate never was the thing standing between a frozen player and a green metric.
  const blessed = evaluateFeelProvenance(
    {
      jumpApex: 0,
      timeToApex: 0,
      provenance: { sources: [RUN2.provenance.sources[0]!] },
    } as unknown as FeelMeasurements,
    acceptance(),
  );
  assert.equal(blessed.checks.find((c) => c.id === "feel-provenance.jumpApex")!.status, "pass");
});

// ── 5. the duplicate frame ──────────────────────────────────────────────────

test("E6: ONE duplicate-timestamp frame no longer discards the whole live run leg", () => {
  const samples = RAW_RUN_LEG.samples;
  assert.equal(samples.length, 183);
  assert.equal(RAW_RUN_LEG.sampleCount, 183);

  // The real artifact: index 133 repeats index 132 exactly.
  const duplicates = samples.filter((s, i) => i > 0 && s.tMs === samples[i - 1].tMs);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].tMs, 1100);
  assert.equal(samples[132].x, samples[133].x);
  assert.equal(samples[132].y, samples[133].y);

  assert.equal(isValidTrajectory(samples), true, "an exact duplicate is collapsible, not fatal");
  const collapsed = collapseExactDuplicateSamples(samples);
  assert.equal(collapsed.length, 182);
  for (let i = 1; i < collapsed.length; i += 1) {
    assert.ok(collapsed[i].tMs > collapsed[i - 1].tMs, "the collapsed trajectory is strictly increasing");
  }
  // The whole trajectory is usable again: a real number comes out where the shipped
  // validator discarded 183 real samples and reported "no usable trajectory".
  assert.equal(Number.isFinite(deriveRunSpeed(samples)), true);

  // AND the leg is corroboration for the runway fix, not a clean run: the duplicate
  // sits on a RESPAWN. The player ran from 5.7 to 8.6167 into the hazard field and was
  // teleported back to the spawn at 1100ms, which is why the whole-window average is
  // 0.46 u/s for a 7 u/s controller. A run leg driven past the level's runway cannot
  // measure runSpeed however cleanly the samples are validated.
  assert.equal(samples[131].x, 8.616669);
  assert.equal(samples[132].x, 6.4);
  assert.ok(Math.abs(deriveRunSpeed(samples) - 0.4641) < 1e-3);
});

test("E6 LITMUS: the ordering contract is unchanged: contradictory and non-causal time still refuse", () => {
  const samples = RAW_RUN_LEG.samples;
  // Same timestamp, DIFFERENT position: the player in two places at one instant is
  // contradictory evidence, not a rounding artifact.
  const contradictory = samples.map((s, i) => (i === 133 ? { ...s, x: s.x + 1 } : s));
  assert.equal(isValidTrajectory(contradictory), false);

  // Decreasing time is non-causal.
  const nonCausal = samples.map((s, i) => (i === 133 ? { ...s, tMs: s.tMs - 50 } : s));
  assert.equal(isValidTrajectory(nonCausal), false);
});
