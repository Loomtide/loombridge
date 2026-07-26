import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  planMeasurements,
  validateInputMap,
  MEASURABLE_METRICS,
  SHORT_HOP_CANONICAL_TAP_TICKS,
  tapMsToTicks,
  type InputMap,
} from "../../../../capabilities/genre/genre-packs/platformer-2d/measure-recipe.js";
import {
  assembleMeasurements,
  type MetricCapture,
} from "../../../../capabilities/genre/genre-packs/platformer-2d/assemble-measurements.js";
import { parseMeasurements } from "../../../../capabilities/genre/genre-packs/platformer-2d/measurements.js";
import { rederiveFromSources } from "../../../../capabilities/verification/gates/feel-rederive.js";
import { buildProfileReport } from "../../../../capabilities/genre/genre-packs/platformer-2d/verify-profile.js";
import type { FeelTrajectorySample } from "../../../../capabilities/verification/gates/feel.js";

function jumpArc(apex: number, apexMs = 280, endMs = 560, stepMs = 40): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) out.push({ tMs: t, x: 0, y: apex * (1 - ((t - apexMs) / apexMs) ** 2) });
  return out;
}
function runTrack(speed: number, durMs = 1000, stepMs = 100): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= durMs; t += stepMs) out.push({ tMs: t, x: (speed * t) / 1000, y: 0 });
  return out;
}
function projectileTrack(speed = 18, startMs = 100, endMs = 400, stepMs = 50): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const movingMs = Math.max(0, t - startMs);
    out.push({ tMs: t, x: (speed * movingMs) / 1000, y: 0 });
  }
  return out;
}
// Known-physics run: accel from rest to steady, hold, decel to rest (see feel-derive test).
function runRamp(accel = 90, steady = 9, decel = 120, holdMs = 200, stepMs = 5): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const dt = stepMs / 1000;
  let x = 0, v = 0, t = 0;
  out.push({ tMs: 0, x, y: 0 });
  while (v < steady) { v = Math.min(steady, v + accel * dt); x += v * dt; t += stepMs; out.push({ tMs: t, x, y: 0 }); }
  const holdEnd = t + holdMs;
  while (t < holdEnd) { x += steady * dt; t += stepMs; out.push({ tMs: t, x, y: 0 }); }
  v = steady;
  while (v > 0) { v = Math.max(0, v - decel * dt); x += v * dt; t += stepMs; out.push({ tMs: t, x, y: 0 }); }
  return out;
}
// Known-physics asymmetric jump (rise gUp, fall gDown). `cut` truncates the window.
function asymJump(gUp = 30, gDown = 60, vUp = 12, stepMs = 5, cut = Infinity): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const dt = stepMs / 1000;
  let y = 0, v = vUp, t = 0;
  out.push({ tMs: 0, x: 0, y });
  while (out.length < cut) {
    const g = v > 0 ? gUp : gDown;
    v -= g * dt; y += v * dt; t += stepMs;
    out.push({ tMs: t, x: 0, y });
    if (y <= 0 && v < 0) break;
  }
  return out;
}
const PROV = {
  captureFps: 120,
  measuredAt: "2026-06-02T00:00:00.000Z",
  projectFixedTimestepBeforeMeasurement: 0.02,
  measurementFixedTimestep: 0.02,
};

async function unityRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-s5c-"));
  await fs.mkdir(path.join(dir, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3\n", "utf-8");
  return dir;
}

// ── recipe / input-map planning ──────────────────────────────────────────────

test("planMeasurements: a metric whose required key is declared is planned; missing -> skipped w/ reason", () => {
  const map: InputMap = { jump: "Space", moveRight: "RightArrow" }; // no jumpCut
  const plan = planMeasurements(map);
  const byId = Object.fromEntries(plan.metrics.map((m) => [m.metric, m]));
  assert.equal(byId.jumpApex.status, "planned");
  assert.equal(byId.runSpeed.status, "planned");
  assert.equal(byId.shortHopApex.status, "skipped"); // needs jumpCut
  assert.match(byId.shortHopApex.reason ?? "", /jumpCut/);
  // F5 metrics: accel/decel need moveRight (declared → planned); fallGravity needs jump (planned).
  assert.equal(byId.runAcceleration.status, "planned");
  assert.equal(byId.runDeceleration.status, "planned");
  assert.equal(byId.fallGravityMultiplier.status, "planned");
  assert.equal(byId.runAcceleration.derivation, "trajectory");
  assert.equal(byId.fallGravityMultiplier.derivation, "trajectory");
  // plan covers every measurable metric (planned or skipped — never silently dropped)
  assert.equal(plan.metrics.length, MEASURABLE_METRICS.length);
});

test("planMeasurements: accel/decel skip without moveRight; fallGravity skips without jump", () => {
  const plan = planMeasurements({ jump: "Space" }); // no moveRight
  const byId = Object.fromEntries(plan.metrics.map((m) => [m.metric, m]));
  assert.equal(byId.runAcceleration.status, "skipped");
  assert.match(byId.runAcceleration.reason ?? "", /moveRight/);
  assert.equal(byId.fallGravityMultiplier.status, "planned"); // jump declared
});

test("planMeasurements: empty input map skips everything with reasons", () => {
  const plan = planMeasurements({});
  assert.ok(plan.metrics.every((m) => m.status === "skipped" && m.reason));
});

test("validateInputMap rejects an empty-string binding", () => {
  assert.equal(validateInputMap({ jump: "Space" }).valid, true);
  assert.equal(validateInputMap({ jump: "" }).valid, false);
  assert.equal(validateInputMap(42).valid, false);
});

// ── assembler ────────────────────────────────────────────────────────────────

test("assembleMeasurements derives metrics + carries trajectory provenance; round-trips through loadMeasurements", () => {
  const captures: MetricCapture[] = [
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["jumpApex", "timeToApex"], samples: jumpArc(3.0, 280), ...PROV },
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["runSpeed"], samples: runTrack(9), ...PROV },
    { kind: "bisection", metric: "coyoteTime", trials: [{ delayMs: 100, jumped: true }, { delayMs: 140, jumped: false }], ...PROV },
  ];
  const { measurements, omitted } = assembleMeasurements(captures);
  assert.equal(omitted.length, 0);
  assert.ok(Math.abs(measurements.metrics.jumpApex - 3.0) < 1e-3);
  assert.equal(measurements.metrics.timeToApex, 280);
  assert.ok(Math.abs(measurements.metrics.runSpeed - 9) < 1e-3);
  assert.ok(Math.abs(measurements.metrics.coyoteTime - 0.12) < 1e-3);

  // trajectory sources carry the marker + samples; the bisection source does not.
  const traj = measurements.provenance!.sources!.filter((s) => s.derivation === "trajectory");
  assert.equal(traj.length, 2);
  assert.ok(traj.every((s) => Array.isArray(s.samples) && s.samples.length > 0));
  const bis = measurements.provenance!.sources!.find((s) => s.measuredMetrics?.includes("coyoteTime"));
  assert.equal(bis?.derivation, undefined);
  assert.equal(bis?.source, "runtime.probe");

  // round-trip through the S5b loader (nested shape preserved)
  const roundTripped = parseMeasurements(measurements);
  assert.deepEqual(roundTripped.metrics, measurements.metrics);

  // every assembled value re-derives from its own samples
  const verdicts = rederiveFromSources(measurements.provenance!.sources!, measurements.metrics);
  assert.ok(verdicts.length >= 3 && verdicts.every((v) => v.status === "pass"));
});

test("assembleMeasurements omits a metric whose bisection didn't bracket a boundary", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "bisection", metric: "jumpBuffer", trials: [{ delayMs: 100, jumped: true }], ...PROV },
  ]);
  assert.equal(measurements.metrics.jumpBuffer, undefined); // never invented
  assert.ok(omitted.some((o) => o.metric === "jumpBuffer"));
});

// ── F5: assembler derives accel/decel/fallGravity + omits on inconclusive ─────

test("assembleMeasurements derives F5 metrics from a run-ramp + asymmetric-jump capture", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["runAcceleration", "runDeceleration"], samples: runRamp(90, 9, 120), ...PROV },
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["fallGravityMultiplier"], samples: asymJump(30, 60, 12), ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.ok(Math.abs(measurements.metrics.runAcceleration - 90) / 90 < 0.05);
  assert.ok(Math.abs(measurements.metrics.runDeceleration - 120) / 120 < 0.05);
  assert.ok(Math.abs(measurements.metrics.fallGravityMultiplier - 2.0) < 0.1);
  // every assembled F5 value re-derives from its own samples (§0 round-trip)
  const verdicts = rederiveFromSources(measurements.provenance!.sources!, measurements.metrics);
  assert.ok(verdicts.length >= 3 && verdicts.every((v) => v.status === "pass"));
});

test("assembleMeasurements OMITS fallGravityMultiplier when the jump window is truncated before apex (still derives jumpApex)", () => {
  const { measurements, omitted } = assembleMeasurements([
    {
      kind: "trajectory",
      source: "runtime.measure_motion",
      metrics: ["jumpApex", "fallGravityMultiplier"],
      samples: asymJump(30, 60, 12, 5, 6), // cut to 6 rising samples — no apex/descent
      ...PROV,
    },
  ]);
  assert.equal(measurements.metrics.fallGravityMultiplier, undefined); // never invented
  assert.ok(omitted.some((o) => o.metric === "fallGravityMultiplier"));
  assert.ok(measurements.metrics.jumpApex > 0); // sibling metric still measured from the same samples
});

test("assembleMeasurements OMITS runDeceleration when the run never settles (no release phase)", () => {
  // accel-then-hold, no decel: build a track that ramps up and holds to the end.
  const noRelease = (() => {
    const out: FeelTrajectorySample[] = [];
    let x = 0, v = 0, t = 0;
    const dt = 0.005;
    out.push({ tMs: 0, x, y: 0 });
    while (v < 9) { v = Math.min(9, v + 90 * dt); x += v * dt; t += 5; out.push({ tMs: t, x, y: 0 }); }
    for (let k = 0; k < 60; k++) { x += 9 * dt; t += 5; out.push({ tMs: t, x, y: 0 }); }
    return out;
  })();
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["runAcceleration", "runDeceleration"], samples: noRelease, ...PROV },
  ]);
  assert.ok(measurements.metrics.runAcceleration > 0); // accel measured
  assert.equal(measurements.metrics.runDeceleration, undefined); // decel omitted, not invented
  assert.ok(omitted.some((o) => o.metric === "runDeceleration"));
});

test("assembleMeasurements OMITS BOTH accel & decel for an instant controller (partial-tick artifact, no ramp)", () => {
  // Live tiderunner-clean repro (instant controller, moveSpeed 7, captureFps 60):
  // per-tick speeds [partial 2.2, plateau 7×9, partial 4.78, stop 0,0]. Integrate x
  // honestly so the samples are real positions. Neither the partial injection tick
  // (engage) nor the partial release tick is a genuine ramp — both must OMIT, not
  // fabricate runAcceleration=286 / runDeceleration=154 (the original fidelity bug).
  const instant = (() => {
    const dt = 1 / 60;
    const speeds = [2.2, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 4.78, 0.0, 0.0];
    const out: FeelTrajectorySample[] = [{ tMs: 0, x: 0, y: 0 }];
    let x = 0;
    speeds.forEach((s, i) => {
      x += s * dt;
      out.push({ tMs: Math.round((i + 1) * dt * 1000 * 1e6) / 1e6, x, y: 0 });
    });
    return out;
  })();
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["runAcceleration", "runDeceleration"], samples: instant, ...PROV },
  ]);
  assert.equal(measurements.metrics.runAcceleration, undefined); // accel omitted, not 286
  assert.equal(measurements.metrics.runDeceleration, undefined); // decel omitted, not 154
  assert.ok(omitted.some((o) => o.metric === "runAcceleration"));
  assert.ok(omitted.some((o) => o.metric === "runDeceleration"));
});

// ── §0 enforcement in verify --profile (the HIGH finding) ────────────────────

async function writeMeasurements(root: string, body: unknown): Promise<string> {
  const p = path.join(root, "m.json");
  await fs.writeFile(p, JSON.stringify(body), "utf-8");
  return p;
}

test("§0: an honest re-derivable measurement is graded normally (jumpApex in band -> pass)", async () => {
  const root = await unityRoot();
  const { measurements } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["jumpApex"], samples: jumpArc(3.0, 280), ...PROV },
  ]);
  const mPath = await writeMeasurements(root, measurements);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const jumpApex = report.metrics.find((m) => m.id === "jumpApex")!;
  assert.equal(jumpApex.status, "pass");
  assert.ok(report.rederivation.some((v) => v.metric === "jumpApex" && v.status === "pass"));
});

test("§0: a tampered measurement that WOULD pass the band is forced to FAIL by re-derivation", async () => {
  const root = await unityRoot();
  // reported jumpApex 3.0 (inside precision band) but samples re-derive to 1.0.
  const tampered = {
    metrics: { jumpApex: 3.0 },
    provenance: {
      sources: [
        {
          source: "runtime.measure_motion",
          derivation: "trajectory",
          samples: jumpArc(1.0, 120, 240, 40),
          sampleCount: 7,
          ...PROV,
          measuredMetrics: ["jumpApex"],
        },
      ],
    },
  };
  const mPath = await writeMeasurements(root, tampered);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const jumpApex = report.metrics.find((m) => m.id === "jumpApex")!;
  assert.equal(jumpApex.status, "fail"); // NOT a blind band pass
  assert.match(jumpApex.detail, /rejected/i);
  assert.equal(report.status, "fail");
  assert.ok(report.rederivation.some((v) => v.metric === "jumpApex" && v.status === "fail"));
});

test("§0: a tampered F5 metric (runAcceleration in-band but samples re-derive elsewhere) is forced to FAIL", async () => {
  const root = await unityRoot();
  // Report runAcceleration 90 (dead-center of precision's 90±25% band) but back it
  // with samples that re-derive to ~25 u/s² (a gentle momentum-style ramp).
  const tampered = {
    metrics: { runAcceleration: 90 },
    provenance: {
      sources: [
        {
          source: "runtime.measure_motion",
          derivation: "trajectory",
          samples: runRamp(25, 9, 18, 300), // re-derives to ~25, not 90
          sampleCount: 99,
          ...PROV,
          measuredMetrics: ["runAcceleration"],
        },
      ],
    },
  };
  const mPath = await writeMeasurements(root, tampered);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const accel = report.metrics.find((m) => m.id === "runAcceleration")!;
  assert.equal(accel.status, "fail"); // NOT a blind band pass — §0 refuted it
  assert.match(accel.detail, /rejected/i);
  assert.equal(report.status, "fail");
  assert.ok(report.rederivation.some((v) => v.metric === "runAcceleration" && v.status === "fail"));
});

test("§0: an honest F5 metric (runAcceleration backed by matching samples) grades & verifies", async () => {
  const root = await unityRoot();
  const { measurements } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["runAcceleration"], samples: runRamp(90, 9, 120), ...PROV },
  ]);
  const mPath = await writeMeasurements(root, measurements);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const accel = report.metrics.find((m) => m.id === "runAcceleration")!;
  assert.equal(accel.status, "pass"); // ~90 is inside precision 90±25%
  assert.ok(report.rederivation.some((v) => v.metric === "runAcceleration" && v.status === "pass"));
});

test("§0: a source claiming trajectory derivation but missing samples -> metric fail", async () => {
  const root = await unityRoot();
  const noSamples = {
    metrics: { jumpApex: 3.0 },
    provenance: {
      sources: [{ source: "runtime.measure_motion", derivation: "trajectory", ...PROV, measuredMetrics: ["jumpApex"] }],
    },
  };
  const mPath = await writeMeasurements(root, noSamples);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.metrics.find((m) => m.id === "jumpApex")!.status, "fail");
});

test("§0: a legacy number-only measurement is graded exactly as S5b (no regression, no rederivation)", async () => {
  const root = await unityRoot();
  const mPath = await writeMeasurements(root, { jumpApex: 3.0 }); // flat, no provenance
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.metrics.find((m) => m.id === "jumpApex")!.status, "pass");
  assert.equal(report.rederivation.length, 0);
});

// ── F5: canonical short-hop stimulus, recorded + enforced ─────────────────────
//
// shortHopApex is jointly set by jumpCut + tap duration. The recipe pins a canonical
// tap (SHORT_HOP_CANONICAL_TAP_TICKS fixed ticks). verify --profile now REFUSES a
// shortHopApex reading whose source records a non-canonical tap, or no tap at all —
// the operator can no longer pick the tap that passes. Scoped to shortHopApex only.

/** A short-hop arc peaking at `apex` u above start (precision band [0.88, 1.32]). */
function shortHopArc(apex: number, apexMs = 120, endMs = 320, stepMs = 16.67): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) out.push({ tMs: Number(t.toFixed(2)), x: 0, y: apex * (1 - ((t - apexMs) / apexMs) ** 2) });
  return out;
}

/** A shortHopApex measurements doc with a tap of `tapTicks`, or no stimulus when undefined. */
function shortHopDoc(apex: number, tapTicks: number | undefined, hasStimulus = true) {
  const samples = shortHopArc(apex);
  return {
    metrics: { shortHopApex: Number(apex.toFixed(4)) },
    provenance: {
      sources: [
        {
          source: "runtime.probe",
          derivation: "trajectory",
          samples,
          sampleCount: samples.length,
          ...PROV,
          measuredMetrics: ["shortHopApex"],
          ...(hasStimulus
            ? { stimulus: { metric: "shortHopApex", tapTicks, phases: `[jump ${tapTicks}t][jumpCut]` } }
            : {}),
        },
      ],
    },
  };
}

test("F5 constant: the canonical short-hop tap is the live-realized minimum of 6 fixed ticks", () => {
  assert.equal(SHORT_HOP_CANONICAL_TAP_TICKS, 6);
  // 100ms at the F1-pinned 60Hz timestep is ~6 ticks — the saturated, reliably-registered tap.
  assert.ok(Math.abs(tapMsToTicks(100, 0.016667) - 6) < 0.2);
  // A 2-tick (~33ms) tap is BELOW canonical — it realizes sub-registration (apex 0) live.
  assert.ok(tapMsToTicks(33, 0.016667) < 3);
});

test("F5 (a): shortHopApex measured with the canonical 6-tick tap is trusted and grades in band", async () => {
  const root = await unityRoot();
  const mPath = await writeMeasurements(root, shortHopDoc(1.1, SHORT_HOP_CANONICAL_TAP_TICKS));
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const sh = report.metrics.find((m) => m.id === "shortHopApex")!;
  assert.equal(sh.status, "pass"); // 1.1 is dead-center of the [0.88, 1.32] precision band
  assert.notEqual(sh.confidence, "rejected");
  // It still re-derives from its own samples (the stimulus check is additive, not a replacement).
  assert.ok(report.rederivation.some((v) => v.metric === "shortHopApex" && v.status === "pass"));
});

test("F5 (b): shortHopApex measured with a LONGER (non-canonical) tap is REFUSED with a reason", async () => {
  const root = await unityRoot();
  // 4-tick tap (the F1 70ms hop). Even an in-band apex value must be refused — the tap
  // is not the canonical one, so the reading is not comparable to the band.
  const mPath = await writeMeasurements(root, shortHopDoc(1.1, 4));
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const sh = report.metrics.find((m) => m.id === "shortHopApex")!;
  assert.equal(sh.status, "fail"); // refused, NOT a blind band pass
  assert.equal(sh.confidence, "rejected");
  assert.match(sh.detail, /non-canonical tap|4 ticks/i);
  assert.equal(report.status, "fail");
});

test("F5 (c): shortHopApex with the stimulus field ABSENT is REFUSED (not silently passed)", async () => {
  const root = await unityRoot();
  // Same in-band apex, same valid re-derivable samples, but NO stimulus recorded.
  const mPath = await writeMeasurements(root, shortHopDoc(1.1, undefined, /*hasStimulus*/ false));
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const sh = report.metrics.find((m) => m.id === "shortHopApex")!;
  assert.equal(sh.status, "fail"); // absent stimulus = refusal, exactly like an absent binding
  assert.equal(sh.confidence, "rejected");
  assert.match(sh.detail, /no stimulus|records no/i);
});

test("F5 scope: a NON-stimulus metric (jumpApex) never requires a stimulus field", async () => {
  const root = await unityRoot();
  // jumpApex measured with valid samples and NO stimulus — must still grade normally.
  const { measurements } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["jumpApex"], samples: jumpArc(3.0, 280), ...PROV },
  ]);
  const mPath = await writeMeasurements(root, measurements);
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.metrics.find((m) => m.id === "jumpApex")!.status, "pass");
});

test("F5 assembler: a shortHopApex capture carries its stimulus onto the emitted source", () => {
  const captures: MetricCapture[] = [
    {
      kind: "trajectory",
      source: "runtime.probe",
      metrics: ["shortHopApex"],
      samples: shortHopArc(1.1),
      stimulus: { metric: "shortHopApex", tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS, phases: "[jump 6t][jumpCut]" },
      ...PROV,
    },
  ];
  const { measurements } = assembleMeasurements(captures);
  const src = measurements.provenance!.sources!.find((s) => s.measuredMetrics?.includes("shortHopApex"))!;
  assert.equal(src.stimulus?.metric, "shortHopApex");
  assert.equal(src.stimulus?.tapTicks, SHORT_HOP_CANONICAL_TAP_TICKS);
});

test("F5 assembler: a non-shortHop capture does NOT get a spurious stimulus", () => {
  const { measurements } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.measure_motion", metrics: ["jumpApex"], samples: jumpArc(3.0, 280), ...PROV },
  ]);
  const src = measurements.provenance!.sources!.find((s) => s.measuredMetrics?.includes("jumpApex"))!;
  assert.equal(src.stimulus, undefined);
});

test("F5 assembler: a shortHopApex capture on a flat (no-hop) trajectory OMITS the metric (not a fabricated 0)", () => {
  // A flat trajectory (the canonical tap never registered a jump → apex 0). The
  // assembler must report shortHopApex as not-measured (omitted with a reason), NOT
  // emit a spurious 0 into measurements.metrics.
  const flat: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 1.5 },
    { tMs: 16.67, x: 0, y: 1.5 },
    { tMs: 33.34, x: 0, y: 1.5 },
    { tMs: 50.01, x: 0, y: 1.5 },
  ];
  const { measurements, omitted } = assembleMeasurements([
    {
      kind: "trajectory",
      source: "runtime.probe",
      metrics: ["shortHopApex"],
      samples: flat,
      stimulus: { metric: "shortHopApex", tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS, phases: "[jump 6t][jumpCut]" },
      ...PROV,
    },
  ]);
  assert.equal(measurements.metrics.shortHopApex, undefined); // NOT a fabricated 0
  const om = omitted.find((o) => o.metric === "shortHopApex");
  assert.ok(om, "shortHopApex must be reported as omitted (not measured)");
  assert.ok(om!.reason.length > 0, "the omit must carry a reason");
});

// ── shortHop retry / multi-capture coalesce (reliability) ────────────────────
/** A canonical shortHop attempt capture (registering arc, or a flat no-hop miss). */
function shortHopAttempt(apex: number) {
  const samples = apex > 0 ? shortHopArc(apex) : [
    { tMs: 0, x: 0, y: 1.5 }, { tMs: 16.67, x: 0, y: 1.5 }, { tMs: 33.34, x: 0, y: 1.5 },
  ];
  return {
    kind: "trajectory" as const, source: "runtime.capture_input_motion" as const,
    metrics: ["shortHopApex"], samples,
    stimulus: { metric: "shortHopApex" as const, tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS, phases: "[jump 6t][jumpCut]" },
    ...PROV,
  };
}

test("shortHop retry: a stochastic miss among attempts is DISCARDED — the registering value wins", () => {
  // 3 canonical attempts: two register (~1.40), one is a stochastic miss (flat, apex 0).
  const { measurements, omitted } = assembleMeasurements([
    shortHopAttempt(1.4), shortHopAttempt(0), shortHopAttempt(1.4),
  ]);
  assert.ok(Math.abs((measurements.metrics.shortHopApex ?? NaN) - 1.4) < 0.02, "the registering value is reported");
  assert.ok(!omitted.some((o) => o.metric === "shortHopApex"), "a one-off miss must NOT omit the metric");
  // Exactly ONE source is emitted (the chosen attempt), not one per attempt.
  assert.equal(measurements.provenance!.sources!.filter((s) => (s.measuredMetrics ?? []).includes("shortHopApex")).length, 1);
});

test("shortHop retry: the median REGISTERING attempt is chosen (a miss is never blended in)", () => {
  // Registering values 1.40 and 1.44 + a miss → median of the registering set (lower-median 1.40),
  // and crucially never (1.40+0+1.44)/3 — a miss must not drag the value down.
  const { measurements } = assembleMeasurements([
    shortHopAttempt(1.44), shortHopAttempt(0), shortHopAttempt(1.4),
  ]);
  const v = measurements.metrics.shortHopApex ?? NaN;
  assert.ok(v === 1.4 || Math.abs(v - 1.4) < 0.02, `median registering value, got ${v}`);
  assert.ok(v > 1.0, "a discarded miss (0) was not averaged in");
});

test("shortHop retry: when EVERY attempt misses, the metric still REFUSES honestly", () => {
  const { measurements, omitted } = assembleMeasurements([
    shortHopAttempt(0), shortHopAttempt(0), shortHopAttempt(0),
  ]);
  assert.equal(measurements.metrics.shortHopApex, undefined, "all-miss → not measured, never a fabricated 0");
  assert.ok(omitted.some((o) => o.metric === "shortHopApex"), "all-miss must omit with a reason");
});

// ── F5: inputLatency (recipe + assembler + §0) ───────────────────────────────

// Settle at rest until onsetMs, then move at `speed` u/s. flat-rezeroed samples.
function latencyTrack(onsetMs = 100, latencyMs = 50, speed = 9, endMs = 400, stepMs = 10): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const motionStart = onsetMs + latencyMs;
  for (let t = 0; t <= endMs; t += stepMs) out.push({ tMs: t, x: t > motionStart ? (speed * (t - motionStart)) / 1000 : 0, y: 0 });
  return out;
}

test("recipe: inputLatency is measurable, needs moveRight, derives via trajectory", () => {
  assert.ok((MEASURABLE_METRICS as readonly string[]).includes("inputLatency"));
  const plan = planMeasurements({ moveRight: "RightArrow" });
  const byId = Object.fromEntries(plan.metrics.map((m) => [m.metric, m]));
  assert.equal(byId.inputLatency.status, "planned");
  assert.equal(byId.inputLatency.derivation, "trajectory");
  // No moveRight → skipped with a reason naming the missing key.
  const noMove = planMeasurements({ jump: "Space" });
  const il = noMove.metrics.find((m) => m.metric === "inputLatency")!;
  assert.equal(il.status, "skipped");
  assert.match(il.reason ?? "", /moveRight/);
});

test("assembler: inputLatency derives from samples + inputOnsetMs and carries the onset onto the source", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["inputLatency"], samples: latencyTrack(100, 50), inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.ok(Math.abs(measurements.metrics.inputLatency - 50) <= 10, `got ${measurements.metrics.inputLatency}`);
  const src = measurements.provenance!.sources!.find((s) => s.measuredMetrics?.includes("inputLatency"))!;
  assert.equal(src.inputOnsetMs, 100);
});

test("assembler: inputLatency with NO inputOnsetMs is OMITTED (not measured), never a fabricated 0", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["inputLatency"], samples: latencyTrack(100, 50), ...PROV },
  ]);
  assert.equal(measurements.metrics.inputLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputLatency"));
});

test("assembler: inputLatency with no motion after onset is OMITTED", () => {
  const still: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 400; t += 10) still.push({ tMs: t, x: 0, y: 0 });
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["inputLatency"], samples: still, inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputLatency"));
});

test("§0: an honest inputLatency re-derives cleanly (verified); a tampered one is rejected by §0", () => {
  const samples = latencyTrack(100, 50);
  const honest = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["inputLatency"], samples, inputOnsetMs: 100, ...PROV },
  ]).measurements;
  const v1 = rederiveFromSources(honest.provenance!.sources!, honest.metrics);
  assert.ok(v1.some((v) => v.metric === "inputLatency" && v.status === "pass"));
  // Tamper: keep the (samples, onset) but assert a fake low latency → §0 must reject.
  const tampered = { metrics: { ...honest.metrics, inputLatency: 3 }, provenance: honest.provenance };
  const v2 = rederiveFromSources(tampered.provenance!.sources!, tampered.metrics);
  assert.ok(v2.some((v) => v.metric === "inputLatency" && v.status === "fail"));
});

test("§0: an inputLatency source reporting a value but carrying NO onset is refused (fail), not skipped", () => {
  const samples = latencyTrack(100, 50);
  const sources = [{ source: "runtime.capture_input_motion", derivation: "trajectory" as const, samples, measuredMetrics: ["inputLatency"], ...PROV }];
  const v = rederiveFromSources(sources, { inputLatency: 60 });
  assert.ok(v.some((x) => x.metric === "inputLatency" && x.status === "fail"));
});

test("§0: a reported shortHopApex backed by flat (no-hop) samples is refused (fail), not silently skipped", () => {
  // The self-grade the shortHop refusal could otherwise reopen: a canonical-stimulus source
  // REPORTS shortHopApex 1.1 but its own (valid) samples are flat — the tap never registered a
  // hop, so deriveShortHopApex re-derives null. A null re-derivation on a REPORTED metric must
  // FAIL (refuse), never continue (the honest assembler omits null-derivations, so a reported
  // metric that re-derives null was not produced from these samples).
  const samples = jumpArc(0); // flat, valid trajectory → apex 0 → shortHopApex re-derives null
  const sources = [{ source: "runtime.capture_input_motion", derivation: "trajectory" as const, samples, measuredMetrics: ["shortHopApex"], ...PROV }];
  const v = rederiveFromSources(sources, { shortHopApex: 1.1 });
  assert.ok(v.some((x) => x.metric === "shortHopApex" && x.status === "fail"), "a no-hop trajectory reporting shortHopApex must be distrusted");
});

// ── L3b cross-modal sync assembler (inputToSfxLatency, measure-only) ─────────

/** A clean numeric SFX fieldTimeline entry (PlayCount) incrementing at `edgeMs`. */
function sfxPlayCount(edgeMs: number, endMs = 400, stepMs = 10) {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "jump-sfx", samples };
}

test("assembleMeasurements derives inputToSfxLatency from a clean SFX series + onset", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToSfxLatency", sfxSeries: sfxPlayCount(180), inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.inputToSfxLatency, 80);
  // Measure-only: no trajectory re-derivation source is emitted for it.
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("inputToSfxLatency")));
});

test("assembleMeasurements REFUSES inputToSfxLatency on an unresolved SFX series (F1 invariant) — omitted with reason", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToSfxLatency", sfxSeries: { id: "jump-sfx", samples: [], unresolved: "component 'SfxPlayer' not present on GameObject" }, inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputToSfxLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputToSfxLatency" && /unresolved/i.test(o.reason)));
});

test("assembleMeasurements REFUSES inputToSfxLatency on a readError SFX series (F1 invariant) — omitted with reason", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToSfxLatency", sfxSeries: { id: "jump-sfx", samples: [{ tMs: 0, value: 0 }, { tMs: 120, value: 1 }], readError: "read failed at tMs 120: NRE" }, inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputToSfxLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputToSfxLatency" && /readError/i.test(o.reason)));
});

test("assembleMeasurements omits inputToSfxLatency when no SFX cue fired (no rising edge)", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToSfxLatency", sfxSeries: sfxPlayCount(9999), inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputToSfxLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputToSfxLatency"));
});

test("assembleMeasurements: a derived inputToSfxLatency lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  // Assemble a sync metric, then merge it into an otherwise-clean banded measurements doc.
  const sync = assembleMeasurements([
    { kind: "sync", metric: "inputToSfxLatency", sfxSeries: sfxPlayCount(170), inputOnsetMs: 100, ...PROV },
  ]).measurements;
  assert.equal(sync.metrics.inputToSfxLatency, 70);
  const doc = { metrics: { ...allAtTarget, ...sync.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  // Not in the graded list; present in alsoMeasured with the canonical unit + family.
  assert.ok(!report.metrics.some((m: any) => m.id === "inputToSfxLatency"));
  const il = report.alsoMeasured.find((m: any) => m.id === "inputToSfxLatency");
  assert.ok(il, "inputToSfxLatency must appear under alsoMeasured");
  assert.equal(il.unit, "ms");
  assert.equal(il.family, "sync");
  assert.equal(il.measured, 70);
  // The summary counts only graded metrics — the sync metric never enters it.
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
  assert.ok(!Object.keys(report.summary).some((k) => k === "inputToSfxLatency"));
});

test("assembleMeasurements derives fireInputToSpawnLatency from a clean spawn series + fire onset", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "fireInputToSpawnLatency", spawnSeries: sfxPlayCount(140), inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.fireInputToSpawnLatency, 40);
});

test("assembleMeasurements REFUSES fireInputToSpawnLatency on a degraded or edge-less spawn series", () => {
  const unresolved = assembleMeasurements([
    {
      kind: "sync",
      metric: "fireInputToSpawnLatency",
      spawnSeries: { id: "projectile-spawn-count", samples: [], unresolved: "ProjectileSpawnCount field absent" },
      inputOnsetMs: 100,
      ...PROV,
    },
  ]);
  assert.equal(unresolved.measurements.metrics.fireInputToSpawnLatency, undefined);
  assert.ok(unresolved.omitted.some((o) => o.metric === "fireInputToSpawnLatency" && /spawn series.*unresolved/i.test(o.reason)));

  const noEdge = assembleMeasurements([
    { kind: "sync", metric: "fireInputToSpawnLatency", spawnSeries: sfxPlayCount(9999), inputOnsetMs: 100, ...PROV },
  ]);
  assert.equal(noEdge.measurements.metrics.fireInputToSpawnLatency, undefined);
  assert.ok(noEdge.omitted.some((o) => o.metric === "fireInputToSpawnLatency" && /spawn edge/i.test(o.reason)));
});

/** A clean numeric counter fieldTimeline entry (0→1 at edgeMs), e.g. Enemy.HitCount / Enemy.DeathCount. */
function counterEdge(id: string, edgeMs: number, endMs = 1000, stepMs = 10) {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id, samples };
}

test("assembleMeasurements derives ttkMs from a first-hit series + death series (series→series)", () => {
  const { measurements, omitted } = assembleMeasurements([
    {
      kind: "sync",
      metric: "ttkMs",
      damageSeries: counterEdge("enemy-hit-count", 200),
      deathSeries: counterEdge("enemy-death-count", 500),
      ...PROV,
    },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.ttkMs, 300);
  // Measure-only: no trajectory re-derivation source is emitted for it.
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("ttkMs")));
});

test("assembleMeasurements REFUSES ttkMs on a degraded series, no hit, or no death edge", () => {
  const degraded = assembleMeasurements([
    {
      kind: "sync",
      metric: "ttkMs",
      damageSeries: { id: "enemy-hit-count", samples: [], unresolved: "HitCount field absent" },
      deathSeries: counterEdge("enemy-death-count", 500),
      ...PROV,
    },
  ]);
  assert.equal(degraded.measurements.metrics.ttkMs, undefined);
  assert.ok(degraded.omitted.some((o) => o.metric === "ttkMs" && /damage series.*unresolved/i.test(o.reason)));

  const noDeath = assembleMeasurements([
    {
      kind: "sync",
      metric: "ttkMs",
      damageSeries: counterEdge("enemy-hit-count", 200),
      deathSeries: counterEdge("enemy-death-count", 9999),
      ...PROV,
    },
  ]);
  assert.equal(noDeath.measurements.metrics.ttkMs, undefined);
  assert.ok(noDeath.omitted.some((o) => o.metric === "ttkMs" && /never died/i.test(o.reason)));
});

// ── L3c cross-modal sync assembler (dashToGhostMs, measure-only) ─────────────
/** A clean bool fieldTimeline entry (false→true at edgeMs), e.g. IsDashing / ghost.enabled. */
function boolEdge(id: string, edgeMs: number, endMs = 400, stepMs = 10) {
  const samples: { tMs: number; value: boolean }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs });
  return { id, samples };
}

test("assembleMeasurements derives dashToGhostMs from two clean series (dash→ghost)", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "dashToGhostMs", dashingSeries: boolEdge("dashing", 100), ghostSeries: boolEdge("ghost", 130), ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.dashToGhostMs, 30);
  // Measure-only: no trajectory re-derivation source emitted for it.
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("dashToGhostMs")));
});

test("assembleMeasurements REFUSES dashToGhostMs when the GHOST series is degraded (F1) — omitted with reason", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "dashToGhostMs", dashingSeries: boolEdge("dashing", 100),
      ghostSeries: { id: "ghost", samples: [{ tMs: 0, value: false }, { tMs: 130, value: true }], readError: "getter threw at tMs 120" }, ...PROV },
  ]);
  assert.equal(measurements.metrics.dashToGhostMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "dashToGhostMs" && /ghost series/i.test(o.reason) && /readError/i.test(o.reason)));
});

test("assembleMeasurements omits dashToGhostMs when no ghost spawned after the dash", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "dashToGhostMs", dashingSeries: boolEdge("dashing", 100), ghostSeries: boolEdge("ghost", 9999), ...PROV },
  ]);
  assert.equal(measurements.metrics.dashToGhostMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "dashToGhostMs"));
});

test("assembleMeasurements: a derived dashToGhostMs lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  const sync = assembleMeasurements([
    { kind: "sync", metric: "dashToGhostMs", dashingSeries: boolEdge("dashing", 100), ghostSeries: boolEdge("ghost", 120), ...PROV },
  ]).measurements;
  assert.equal(sync.metrics.dashToGhostMs, 20);
  const doc = { metrics: { ...allAtTarget, ...sync.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.ok(!report.metrics.some((m: any) => m.id === "dashToGhostMs"), "must not enter the graded list");
  const dg = report.alsoMeasured.find((m: any) => m.id === "dashToGhostMs");
  assert.ok(dg, "dashToGhostMs must appear under alsoMeasured");
  assert.equal(dg.unit, "ms");
  assert.equal(dg.family, "sync");
  assert.equal(dg.measured, 20);
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
});

// ── L3d cross-modal sync assembler (groundContactToDustMs, measure-only) ─────
// A full jump arc that rises, falls, then LANDS flat (vy arrests) at 200ms.
function fallLandArc(): FeelTrajectorySample[] {
  return [
    { tMs: 0, x: 0, y: 0 },
    { tMs: 20, x: 0, y: 1.2 },
    { tMs: 40, x: 0, y: 2.2 },
    { tMs: 60, x: 0, y: 2.8 },
    { tMs: 80, x: 0, y: 3.0 },
    { tMs: 100, x: 0, y: 2.8 },
    { tMs: 120, x: 0, y: 2.2 },
    { tMs: 140, x: 0, y: 1.4 },
    { tMs: 160, x: 0, y: 0.6 },
    { tMs: 180, x: 0, y: 0.1 },
    { tMs: 200, x: 0, y: 0.0 }, // touchdown (contact = 200)
    { tMs: 220, x: 0, y: 0.0 },
    { tMs: 240, x: 0, y: 0.0 },
  ];
}
// A clean numeric landing-dust fieldTimeline entry (LandingDustCount) → 1 at edgeMs.
function dustCount(edgeMs: number, endMs = 600, stepMs = 20) {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "landing-dust", samples };
}

test("assembleMeasurements derives groundContactToDustMs from a trajectory + dust series", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "groundContactToDustMs", samples: fallLandArc(), dustSeries: dustCount(240), ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.groundContactToDustMs, 40); // contact 200 → dust 240 = 40ms
  // Measure-only: no trajectory re-derivation source emitted for it.
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("groundContactToDustMs")));
});

test("assembleMeasurements REFUSES groundContactToDustMs when the DUST series is degraded (F1) — omitted with reason", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "groundContactToDustMs", samples: fallLandArc(),
      dustSeries: { id: "landing-dust", samples: [{ tMs: 0, value: 0 }, { tMs: 240, value: 1 }], readError: "getter threw at tMs 230" }, ...PROV },
  ]);
  assert.equal(measurements.metrics.groundContactToDustMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "groundContactToDustMs" && /dust series/i.test(o.reason) && /readError/i.test(o.reason)));
});

test("assembleMeasurements omits groundContactToDustMs when no landing dust spawned", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "groundContactToDustMs", samples: fallLandArc(), dustSeries: dustCount(9999), ...PROV },
  ]);
  assert.equal(measurements.metrics.groundContactToDustMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "groundContactToDustMs"));
});

test("assembleMeasurements: a derived groundContactToDustMs lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  const sync = assembleMeasurements([
    { kind: "sync", metric: "groundContactToDustMs", samples: fallLandArc(), dustSeries: dustCount(220), ...PROV },
  ]).measurements;
  assert.equal(sync.metrics.groundContactToDustMs, 20);
  const doc = { metrics: { ...allAtTarget, ...sync.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.ok(!report.metrics.some((m: any) => m.id === "groundContactToDustMs"), "must not enter the graded list");
  const gd = report.alsoMeasured.find((m: any) => m.id === "groundContactToDustMs");
  assert.ok(gd, "groundContactToDustMs must appear under alsoMeasured");
  assert.equal(gd.unit, "ms");
  assert.equal(gd.family, "sync");
  assert.equal(gd.measured, 20);
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
});

// ── shooter v1 event-cadence assembler (fireIntervalMs, measure-only) ─────────

/** A clean numeric fire counter fieldTimeline entry with increments at the given shot times. */
function fireCount(edges: number[], endMs = 600, stepMs = 10) {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    samples.push({ tMs: t, value: edges.filter((edge) => t >= edge).length });
  }
  return { id: "weapon-fire-count", samples };
}

test("assembleMeasurements derives fireIntervalMs from a clean fire counter series", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "fireIntervalMs", fireSeries: fireCount([100, 220, 340, 460]), ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.fireIntervalMs, 120);
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("fireIntervalMs")));
});

test("assembleMeasurements omits fireIntervalMs with fewer than two fire events", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "fireIntervalMs", fireSeries: fireCount([120]), ...PROV },
  ]);
  assert.equal(measurements.metrics.fireIntervalMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "fireIntervalMs" && /at least two/i.test(o.reason)));
});

test("assembleMeasurements REFUSES fireIntervalMs on a degraded fire series (F1 invariant)", () => {
  const { measurements, omitted } = assembleMeasurements([
    {
      kind: "sync",
      metric: "fireIntervalMs",
      fireSeries: { id: "weapon-fire-count", samples: [{ tMs: 0, value: 0 }, { tMs: 120, value: 1 }], readError: "getter threw at tMs 130" },
      ...PROV,
    },
  ]);
  assert.equal(measurements.metrics.fireIntervalMs, undefined);
  assert.ok(omitted.some((o) => o.metric === "fireIntervalMs" && /fire series/i.test(o.reason) && /readError/i.test(o.reason)));
});

test("assembleMeasurements: a derived fireIntervalMs lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  const sync = assembleMeasurements([
    { kind: "sync", metric: "fireIntervalMs", fireSeries: fireCount([100, 210, 320]), ...PROV },
  ]).measurements;
  assert.equal(sync.metrics.fireIntervalMs, 110);
  const doc = { metrics: { ...allAtTarget, ...sync.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.ok(!report.metrics.some((m: any) => m.id === "fireIntervalMs"), "must not enter the graded list");
  const cadence = report.alsoMeasured.find((m: any) => m.id === "fireIntervalMs");
  assert.ok(cadence, "fireIntervalMs must appear under alsoMeasured");
  assert.equal(cadence.unit, "ms");
  assert.equal(cadence.family, "sync");
  assert.equal(cadence.measured, 110);
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
});

test("assembleMeasurements derives projectileSpeed from moving projectile trajectory", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["projectileSpeed"], samples: projectileTrack(18), ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.projectileSpeed, 18);
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(srcs.some((s: any) => s.derivation === "trajectory" && (s.measuredMetrics ?? []).includes("projectileSpeed")));
});

test("assembleMeasurements: a derived projectileSpeed lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  const projectile = assembleMeasurements([
    { kind: "trajectory", source: "runtime.capture_input_motion", metrics: ["projectileSpeed"], samples: projectileTrack(22), ...PROV },
  ]).measurements;
  assert.equal(projectile.metrics.projectileSpeed, 22);
  const doc = { metrics: { ...allAtTarget, ...projectile.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.ok(!report.metrics.some((m: any) => m.id === "projectileSpeed"), "must not enter the graded list");
  const speed = report.alsoMeasured.find((m: any) => m.id === "projectileSpeed");
  assert.ok(speed, "projectileSpeed must appear under alsoMeasured");
  assert.equal(speed.unit, "u/s");
  assert.equal(speed.family, "weapon");
  assert.equal(speed.measured, 22);
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
});

// ── L3e cross-modal sync assembler (inputToAnimStateLatency, measure-only) ───
const ANIM_IDLE = 0;
const ANIM_JUMP = 2;
/** A clean numeric anim-state fieldTimeline entry that ENTERS `state` at `edgeMs` (idle before). */
function animState(state: number, edgeMs: number, endMs = 400, stepMs = 10) {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? state : ANIM_IDLE });
  return { id: "anim-state", samples };
}

test("assembleMeasurements derives inputToAnimStateLatency from a clean anim-state series + onset", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToAnimStateLatency", animStateSeries: animState(ANIM_JUMP, 180), inputOnsetMs: 100, targetState: ANIM_JUMP, ...PROV },
  ]);
  assert.equal(omitted.length, 0);
  assert.equal(measurements.metrics.inputToAnimStateLatency, 80);
  // Measure-only: no trajectory re-derivation source emitted for it.
  const srcs = measurements.provenance?.sources ?? [];
  assert.ok(!srcs.some((s: any) => (s.measuredMetrics ?? []).includes("inputToAnimStateLatency")));
});

test("assembleMeasurements REFUSES inputToAnimStateLatency on a degraded anim-state series (F1) — omitted with reason", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToAnimStateLatency",
      animStateSeries: { id: "anim-state", samples: [{ tMs: 0, value: ANIM_IDLE }, { tMs: 110, value: ANIM_JUMP }], readError: "getter threw at tMs 120" },
      inputOnsetMs: 100, targetState: ANIM_JUMP, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputToAnimStateLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputToAnimStateLatency" && /readError/i.test(o.reason)));
});

test("assembleMeasurements omits inputToAnimStateLatency when the state is never entered in-window", () => {
  const { measurements, omitted } = assembleMeasurements([
    { kind: "sync", metric: "inputToAnimStateLatency", animStateSeries: animState(ANIM_JUMP, 9999), inputOnsetMs: 100, targetState: ANIM_JUMP, ...PROV },
  ]);
  assert.equal(measurements.metrics.inputToAnimStateLatency, undefined);
  assert.ok(omitted.some((o) => o.metric === "inputToAnimStateLatency"));
});

test("assembleMeasurements: a derived inputToAnimStateLatency lands in alsoMeasured and NEVER gates the verdict", async () => {
  const root = await unityRoot();
  const mPath = path.join(root, "m.json");
  const { loadProfile } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const prof = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(prof.metrics).map(([id, t]) => [id, (t as any).target]));
  const sync = assembleMeasurements([
    { kind: "sync", metric: "inputToAnimStateLatency", animStateSeries: animState(ANIM_JUMP, 120), inputOnsetMs: 100, targetState: ANIM_JUMP, ...PROV },
  ]).measurements;
  assert.equal(sync.metrics.inputToAnimStateLatency, 20);
  const doc = { metrics: { ...allAtTarget, ...sync.metrics } };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.ok(!report.metrics.some((m: any) => m.id === "inputToAnimStateLatency"), "must not enter the graded list");
  const ia = report.alsoMeasured.find((m: any) => m.id === "inputToAnimStateLatency");
  assert.ok(ia, "inputToAnimStateLatency must appear under alsoMeasured");
  assert.equal(ia.unit, "ms");
  assert.equal(ia.family, "sync");
  assert.equal(ia.measured, 20);
  assert.equal(report.summary.total, Object.keys(prof.metrics).length);
  assert.ok(!Object.keys(report.summary).some((k) => k === "inputToAnimStateLatency"));
});

// Belt-and-suspenders for the measure-only invariant: `inputToSfxLatency` is ungateable
// only because no shipped profile bands it. The one way to break that is a profile author
// adding a band for a `sync`-family metric. Lock it: no shipped profile may band any
// metric whose KNOWN_PROFILE_METRICS family is "sync" (those are measure-only by design).
test("no shipped profile bands a sync-family metric (measure-only invariant)", async () => {
  const { loadAllProfiles } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  const { KNOWN_PROFILE_METRICS } = await import("../../../../capabilities/genre/genre-packs/platformer-2d/types.js");
  const syncMetricIds = new Set(
    Object.values(KNOWN_PROFILE_METRICS)
      .filter((m) => m.family === "sync")
      .map((m) => m.id),
  );
  assert.ok(syncMetricIds.has("inputToSfxLatency"), "inputToSfxLatency must be a sync-family metric");
  assert.ok(syncMetricIds.has("fireIntervalMs"), "fireIntervalMs must be a sync-family metric");
  assert.ok(syncMetricIds.has("fireInputToSpawnLatency"), "fireInputToSpawnLatency must be a sync-family metric");
  assert.ok(syncMetricIds.has("ttkMs"), "ttkMs must be a sync-family metric");
  for (const profile of await loadAllProfiles()) {
    for (const bandedId of Object.keys(profile.metrics)) {
      assert.ok(
        !syncMetricIds.has(bandedId),
        `profile '${profile.id}' bands sync-family metric '${bandedId}' — sync metrics are measure-only and must never gate`,
      );
    }
  }
});
