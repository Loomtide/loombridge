import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveJumpApex,
  deriveTimeToApex,
  deriveRunSpeed,
  deriveProjectileSpeed,
  deriveAimTurnRateDegPerSec,
  deriveLookInputToYawLatencyMs,
  deriveShotAimAlignmentDeg,
  shortestAngleDeltaDeg,
  deriveShortHopApex,
  deriveRunAcceleration,
  deriveRunDeceleration,
  deriveFallGravityMultiplier,
  deriveInputLatency,
  INPUT_LATENCY_EPSILON_U,
  deriveMetric,
  interpretBisection,
  isValidTrajectory,
  REDERIVABLE_METRIC_SET,
  firstRisingEdge,
  firstStateEntryEdge,
  deriveEdgeLatency,
  deriveInputToSfxLatency,
  deriveInputToSpawnLatency,
  deriveTimeToKill,
  deriveHitstopMs,
  deriveScreenShakeMag,
  SCREEN_SHAKE_MIN_REGISTERED_U,
  isImmediateImpactFeedback,
  deriveInputToAnimStateLatency,
  deriveDashToGhostLatency,
  deriveGroundContactEdge,
  deriveGroundContactToDustLatency,
  syncSeriesRefusal,
  type BisectionTrial,
  type SyncSeries,
} from "../verification/feel-derive.js";
import {
  evaluateFeelRederive,
  rederiveFromSources,
} from "../verification/gates/feel-rederive.js";
import { evaluateFeelProvenance, validMeasurementSource } from "../verification/gates/feel-provenance.js";
import type { FeelMeasurements, FeelMeasurementSource, FeelTrajectorySample } from "../verification/gates/feel.js";
import type { AcceptanceContract } from "../verification/types.js";

// A jump arc peaking at +3.0u above start at 280ms (0..560ms, 40ms step).
function jumpArc(apex = 3.0, apexMs = 280, endMs = 560, stepMs = 40): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const y = apex * (1 - ((t - apexMs) / apexMs) ** 2);
    out.push({ tMs: t, x: 0, y });
  }
  return out;
}

// A run: x advances at 9 u/s for 1000ms, flat y.
function runTrack(speed = 9, durMs = 1000, stepMs = 100): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= durMs; t += stepMs) out.push({ tMs: t, x: (speed * t) / 1000, y: 0 });
  return out;
}

// A run with KNOWN physics: accelerate from rest at `accel` u/s² to `steady` u/s,
// hold for `holdMs`, then decelerate at `decel` u/s² back to rest. Built by
// integrating piecewise-constant velocity per tick, so per-tick speed |Δx|/Δt
// over the ramp recovers the chosen accel/decel as the least-squares slope.
function runRamp(
  accel = 90,
  steady = 9,
  decel = 120,
  holdMs = 200,
  stepMs = 5,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const dt = stepMs / 1000;
  let x = 0;
  let v = 0;
  let t = 0;
  out.push({ tMs: t, x, y: 0 });
  // accel ramp
  while (v < steady) {
    v = Math.min(steady, v + accel * dt);
    x += v * dt;
    t += stepMs;
    out.push({ tMs: t, x, y: 0 });
  }
  // hold at steady
  const holdEnd = t + holdMs;
  while (t < holdEnd) {
    x += steady * dt;
    t += stepMs;
    out.push({ tMs: t, x, y: 0 });
  }
  // decel ramp to rest
  v = steady;
  while (v > 0) {
    v = Math.max(0, v - decel * dt);
    x += v * dt;
    t += stepMs;
    out.push({ tMs: t, x, y: 0 });
  }
  return out;
}

// A jump arc with KNOWN, ASYMMETRIC gravity: rise under gUp u/s², fall under
// gDown u/s², launched at vUp. Built by integrating constant accel per tick, so
// the descent/ascent vertical-accel ratio is exactly gDown/gUp. `cut` truncates
// the trajectory after `cut` samples (to model a window that ends before apex/
// ground contact — the inconclusive path).
function asymJump(gUp = 30, gDown = 60, vUp = 12, stepMs = 5, cut = Infinity): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const dt = stepMs / 1000;
  let y = 0;
  let v = vUp;
  let t = 0;
  out.push({ tMs: t, x: 0, y });
  while (out.length < cut) {
    const g = v > 0 ? gUp : gDown; // rising vs falling
    v -= g * dt;
    y += v * dt;
    t += stepMs;
    out.push({ tMs: t, x: 0, y });
    if (y <= 0 && v < 0) break; // reached ground on the way down
  }
  return out;
}

const ACCEPTANCE = {} as AcceptanceContract; // feel-rederive ignores acceptance

// ── pure derivation ──────────────────────────────────────────────────────────

test("derive jumpApex / timeToApex from a jump arc", () => {
  const arc = jumpArc(3.0, 280);
  assert.ok(Math.abs(deriveJumpApex(arc) - 3.0) < 1e-9);
  assert.equal(deriveTimeToApex(arc), 280);
});

test("derive runSpeed from a run track (avg |Δx|/Δt, matching MotionMetrics)", () => {
  assert.ok(Math.abs(deriveRunSpeed(runTrack(9)) - 9) < 1e-9);
});

function projectileTrack(speed = 18, startMs = 100, endMs = 400, stepMs = 50): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const movingMs = Math.max(0, t - startMs);
    out.push({ tMs: t, x: (speed * movingMs) / 1000, y: 0 });
  }
  return out;
}

test("deriveProjectileSpeed uses moving trajectory intervals and refuses insufficient motion", () => {
  assert.ok(Math.abs((deriveProjectileSpeed(projectileTrack(18)) ?? NaN) - 18) < 1e-9);
  assert.equal(deriveMetric("projectileSpeed", projectileTrack(18)), 18);
  assert.equal(deriveProjectileSpeed(runTrack(0)), null);
  assert.equal(deriveProjectileSpeed([{ tMs: 0, x: 0, y: 0 }, { tMs: 50, x: 3, y: 0 }]), null);
});

// A pure +Z projectile (x/y never change) — the 3D measurement substrate shape. The motion is
// entirely in z, so the value is only recoverable because the {x,y,z} trajectory carries z.
function projectileTrack3D(speed = 18, startMs = 100, endMs = 400, stepMs = 50): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const movingMs = Math.max(0, t - startMs);
    out.push({ tMs: t, x: 0, y: 0, z: (speed * movingMs) / 1000 });
  }
  return out;
}

test("deriveProjectileSpeed measures a true 3D (+Z) trajectory and proves z is load-bearing", () => {
  // 3D track: speed comes from the z axis.
  assert.ok(Math.abs((deriveProjectileSpeed(projectileTrack3D(18)) ?? NaN) - 18) < 1e-9);
  assert.equal(deriveMetric("projectileSpeed", projectileTrack3D(18)), 18);
  // Same samples with z STRIPPED collapse to a stationary x/y track → refuse (never a minted 0).
  // This is the headline proof that the new z term is what makes the 3D value measurable.
  const zStripped = projectileTrack3D(18).map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
  assert.equal(deriveProjectileSpeed(zStripped), null);
  // Diagonal 3D motion combines all axes (3-4-5 → 5 u over 1s windows scaled): a track moving
  // 3 in x and 4 in z per 1s reads 5 u/s.
  const diag: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 0, z: 0 },
    { tMs: 1000, x: 3, y: 0, z: 4 },
    { tMs: 2000, x: 6, y: 0, z: 8 },
  ];
  assert.ok(Math.abs((deriveProjectileSpeed(diag) ?? NaN) - 5) < 1e-9);
  // A 2D track (no z) is byte-identical to before — z defaults to 0.
  assert.equal(deriveProjectileSpeed(projectileTrack(18)), deriveProjectileSpeed(projectileTrack3D(18)));
});

// ── 3D measurement substrate v2: aim turn rate (rotation/aim sampling) ────────

// A yaw sweep: the object is stationary in position (x/y/z fixed) and its yaw (ry)
// turns at `rateDegPerSec` after a stationary prefix. `wrap` lets the sweep start at
// an offset so it crosses the 360→0 seam (to prove wrap-awareness).
function yawSweep(
  rateDegPerSec = 90,
  startMs = 100,
  endMs = 700,
  stepMs = 50,
  startYawDeg = 0,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const movingMs = Math.max(0, t - startMs);
    const yaw = (startYawDeg + (rateDegPerSec * movingMs) / 1000) % 360;
    out.push({ tMs: t, x: 0, y: 1, z: 0, rx: 0, ry: yaw, rz: 0 });
  }
  return out;
}

test("shortestAngleDeltaDeg is wrap-aware (the 360/0 seam reads as a small step)", () => {
  assert.equal(shortestAngleDeltaDeg(10, 20), 10);
  assert.equal(shortestAngleDeltaDeg(350, 10), 20); // across the seam, not −340
  assert.equal(shortestAngleDeltaDeg(10, 350), -20);
  assert.equal(shortestAngleDeltaDeg(0, 180), 180);
});

test("deriveAimTurnRateDegPerSec measures yaw turn rate and is wrap-aware", () => {
  // A clean 90 deg/s yaw sweep → 90 deg/s (median of constant moving intervals).
  assert.ok(Math.abs((deriveAimTurnRateDegPerSec(yawSweep(90)) ?? NaN) - 90) < 1e-6);
  assert.ok(Math.abs((deriveAimTurnRateDegPerSec(yawSweep(180)) ?? NaN) - 180) < 1e-6);
  // A sweep that crosses the 360→0 seam still reads the true rate (no fabricated spike).
  assert.ok(Math.abs((deriveAimTurnRateDegPerSec(yawSweep(90, 100, 700, 50, 320)) ?? NaN) - 90) < 1e-6);
  // Routes through deriveMetric (yaw is the default axis).
  assert.ok(Math.abs((deriveMetric("aimTurnRateDegPerSec", yawSweep(90)) ?? NaN) - 90) < 1e-6);
});

test("deriveAimTurnRateDegPerSec selects the pitch/roll axis on request", () => {
  const pitch = yawSweep(45).map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z, rx: s.ry, ry: 0, rz: 0 }));
  assert.ok(Math.abs((deriveAimTurnRateDegPerSec(pitch, "pitch") ?? NaN) - 45) < 1e-6);
  // The default (yaw) axis is flat on this track → refuse.
  assert.equal(deriveAimTurnRateDegPerSec(pitch, "yaw"), null);
});

test("deriveAimTurnRateDegPerSec proves rotation is LOAD-BEARING (strip rotation → refuse)", () => {
  // Same samples with the euler fields stripped collapse to a position-only track → refuse.
  const stripped = yawSweep(90).map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
  assert.equal(deriveAimTurnRateDegPerSec(stripped), null);
  // A single sample missing its yaw is enough to refuse (never treat absent as 0).
  const holed = yawSweep(90).map((s, i) => (i === 3 ? { tMs: s.tMs, x: s.x, y: s.y, z: s.z } : s));
  assert.equal(deriveAimTurnRateDegPerSec(holed), null);
});

test("deriveLookInputToYawLatencyMs measures input-onset -> first yaw response and refuses false greens", () => {
  const samples: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 1, z: 0, rx: 0, ry: 0, rz: 0 },
    { tMs: 16.67, x: 0, y: 1, z: 0, rx: 0, ry: 0, rz: 0 },
    { tMs: 33.34, x: 0, y: 1, z: 0, rx: 0, ry: 5, rz: 0 },
    { tMs: 50.01, x: 0, y: 1, z: 0, rx: 0, ry: 10, rz: 0 },
  ];
  assert.ok(Math.abs((deriveLookInputToYawLatencyMs(samples, 16.67) ?? NaN) - 16.67) < 1e-6);
  assert.ok(Math.abs((deriveMetric("lookInputToYawLatencyMs", samples, 16.67) ?? NaN) - 16.67) < 1e-6);
  assert.ok(REDERIVABLE_METRIC_SET.has("lookInputToYawLatencyMs"));
  assert.equal(deriveLookInputToYawLatencyMs(samples, undefined), null, "missing input onset refuses");
  assert.equal(deriveLookInputToYawLatencyMs(samples, 1000), null, "out-of-window onset refuses");
  // Onset AT the first sample leaves no pre-onset baseline window, so the "already-moving" guard
  // is vacuous — a capture already turning from sample 0 must REFUSE, never a fake-responsive latency.
  assert.equal(
    deriveLookInputToYawLatencyMs(
      [
        { tMs: 0, x: 0, y: 1, z: 0, rx: 0, ry: 0, rz: 0 },
        { tMs: 16.67, x: 0, y: 1, z: 0, rx: 0, ry: 5, rz: 0 },
        { tMs: 33.34, x: 0, y: 1, z: 0, rx: 0, ry: 10, rz: 0 },
      ],
      0,
    ),
    null,
    "onset at the first sample (no pre-onset baseline) refuses, even when yaw is already moving",
  );
  assert.equal(
    deriveLookInputToYawLatencyMs(samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z })), 16.67),
    null,
    "rotation-stripped samples refuse",
  );
  assert.equal(
    deriveLookInputToYawLatencyMs([
      { tMs: 0, x: 0, y: 1, z: 0, rx: 0, ry: 0, rz: 0 },
      { tMs: 16.67, x: 0, y: 1, z: 0, rx: 0, ry: 5, rz: 0 },
      { tMs: 33.34, x: 0, y: 1, z: 0, rx: 0, ry: 10, rz: 0 },
    ], 33.34),
    null,
    "pre-armed yaw before the input onset refuses",
  );
});

test("deriveShotAimAlignmentDeg measures shot/camera alignment and catches fixed-forward shots", () => {
  const yaw45 = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
  assert.ok((deriveShotAimAlignmentDeg(yaw45, yaw45) ?? 999) < 1e-5);
  const fixedForward = { x: 0, y: 0, z: 1 };
  const err = deriveShotAimAlignmentDeg(yaw45, fixedForward);
  assert.ok(err !== null && Math.abs(err - 45) < 1e-9, `expected 45 deg fixed-forward error, got ${err}`);
  assert.equal(deriveShotAimAlignmentDeg({ x: 0, y: 0, z: 0 }, yaw45), null, "zero aim vector refuses");
  assert.equal(deriveShotAimAlignmentDeg(yaw45, { x: Number.NaN, y: 0, z: 1 }), null, "malformed shot vector refuses");
});

test("deriveAimTurnRateDegPerSec fails closed on flat/no-motion, insufficient, and malformed timing", () => {
  // Flat aim (never turns) → fewer than two moving intervals → refuse (never a fabricated 0).
  const flat = yawSweep(0).map((s) => ({ ...s, ry: 0 }));
  assert.equal(deriveAimTurnRateDegPerSec(flat), null);
  // Fewer than two samples → no usable trajectory.
  assert.equal(deriveAimTurnRateDegPerSec([{ tMs: 0, x: 0, y: 0, ry: 0 }]), null);
  // A single moving interval (one snap) is rejected (needs ≥2 moving intervals).
  assert.equal(
    deriveAimTurnRateDegPerSec([
      { tMs: 0, x: 0, y: 0, ry: 0 },
      { tMs: 50, x: 0, y: 0, ry: 45 },
    ]),
    null,
  );
  // Non-monotonic / duplicate time → isValidTrajectory refuses.
  assert.equal(
    deriveAimTurnRateDegPerSec([
      { tMs: 0, x: 0, y: 0, ry: 0 },
      { tMs: 0, x: 0, y: 0, ry: 10 },
      { tMs: 50, x: 0, y: 0, ry: 20 },
    ]),
    null,
  );
});

function spawnCount(edgeMs: number, endMs = 300, stepMs = 10): SyncSeries {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "projectile-spawn-count", samples };
}

function spawnVisible(edgeMs: number, endMs = 300, stepMs = 10): SyncSeries {
  const samples: { tMs: number; value: boolean }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs });
  return { id: "projectile-visible", samples };
}

test("deriveInputToSpawnLatency derives from explicit spawn counter or visibility edges", () => {
  assert.deepEqual(deriveInputToSpawnLatency(spawnCount(140), 100), { ok: true, latencyMs: 40 });
  assert.deepEqual(deriveInputToSpawnLatency(spawnVisible(150), 100), { ok: true, latencyMs: 50 });
});

test("deriveInputToSpawnLatency refuses missing onset, missing edge, degraded series, and non-causal ordering", () => {
  const missingOnset = deriveInputToSpawnLatency(spawnCount(140), undefined);
  assert.equal(missingOnset.ok, false);
  assert.match(missingOnset.reason, /no input onset/i);

  const missingEdge = deriveInputToSpawnLatency(spawnCount(9999), 100);
  assert.equal(missingEdge.ok, false);
  assert.match(missingEdge.reason, /no projectile spawn edge/i);

  const degraded = deriveInputToSpawnLatency({ id: "projectile-spawn-count", samples: [], unresolved: "field absent" }, 100);
  assert.equal(degraded.ok, false);
  assert.match(degraded.reason, /spawn series.*unresolved/i);

  const nonCausal = deriveInputToSpawnLatency(spawnCount(80), 100);
  assert.equal(nonCausal.ok, false);
  assert.match(nonCausal.reason, /precedes the input onset/i);
});

function hitCount(edgeMs: number, endMs = 1000, stepMs = 10): SyncSeries {
  const samples: { tMs: number; value: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "enemy-hit-count", samples };
}
function isDead(edgeMs: number, endMs = 1000, stepMs = 10): SyncSeries {
  const samples: { tMs: number; value: boolean }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs });
  return { id: "enemy-is-dead", samples };
}

test("deriveTimeToKill measures death edge − first-hit edge (series→series, counter or bool death signal)", () => {
  assert.deepEqual(deriveTimeToKill(hitCount(200), isDead(500)), { ok: true, latencyMs: 300 });
  // a counter death signal works the same as a bool
  assert.deepEqual(deriveTimeToKill(hitCount(120), hitCount(420)), { ok: true, latencyMs: 300 });
});

test("deriveTimeToKill refuses degraded series, no hit, no death, and non-causal ordering", () => {
  const degradedDamage = deriveTimeToKill(
    { id: "enemy-hit-count", samples: [], unresolved: "HitCount field absent" },
    isDead(500),
  );
  assert.equal(degradedDamage.ok, false);
  assert.match(degradedDamage.reason, /damage series.*unresolved/i);

  const degradedDeath = deriveTimeToKill(hitCount(200), {
    id: "enemy-is-dead",
    samples: [],
    readError: "IsDead getter threw",
  });
  assert.equal(degradedDeath.ok, false);
  assert.match(degradedDeath.reason, /death series.*readError/i);

  const neverHit = deriveTimeToKill(hitCount(9999), isDead(500));
  assert.equal(neverHit.ok, false);
  assert.match(neverHit.reason, /never hit/i);

  const neverDied = deriveTimeToKill(hitCount(200), isDead(9999));
  assert.equal(neverDied.ok, false);
  assert.match(neverDied.reason, /never died/i);

  // death edge BEFORE the first-hit edge → non-causal, inconclusive (never a clamped 0)
  const nonCausal = deriveTimeToKill(hitCount(500), isDead(200));
  assert.equal(nonCausal.ok, false);
  assert.match(nonCausal.reason, /precedes the first-hit edge/i);
});

// A hit-stop window bool: false until openMs, true for windowMs, then false again.
function hitStopWindow(openMs: number, windowMs: number, endMs = 1000, stepMs = 10): SyncSeries {
  const samples: { tMs: number; value: boolean }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= openMs && t < openMs + windowMs });
  return { id: "hit-stop-active", samples };
}

test("deriveHitstopMs measures the first hit-stop window (rising edge → falling edge), bool or numeric", () => {
  // bool window: opens at 200, closes at 320 → 120ms
  assert.deepEqual(deriveHitstopMs(hitStopWindow(200, 120)), { ok: true, latencyMs: 120 });

  // a numeric remaining-time/counter series works the same (active === value > baseline 0)
  const numeric: SyncSeries = {
    id: "hit-stop-remaining",
    samples: [
      { tMs: 0, value: 0 },
      { tMs: 10, value: 0 },
      { tMs: 20, value: 5 }, // window opens
      { tMs: 30, value: 3 },
      { tMs: 40, value: 1 },
      { tMs: 50, value: 0 }, // window closes
      { tMs: 60, value: 0 },
    ],
  };
  assert.deepEqual(deriveHitstopMs(numeric), { ok: true, latencyMs: 30 });

  // only the FIRST window is measured even when later hits re-open it
  const twoWindows: SyncSeries = {
    id: "hit-stop-active",
    samples: hitStopWindow(200, 120).samples.map((s) => ({
      tMs: s.tMs,
      value: s.value || (s.tMs >= 500 && s.tMs < 620),
    })),
  };
  assert.deepEqual(deriveHitstopMs(twoWindows), { ok: true, latencyMs: 120 });
});

test("deriveHitstopMs refuses degraded series, no window, and an unclosed window", () => {
  const degraded = deriveHitstopMs({ id: "hit-stop-active", samples: [], unresolved: "HitStopActive field absent" });
  assert.equal(degraded.ok, false);
  assert.match(degraded.reason, /hit-stop series.*unresolved/i);

  const readError = deriveHitstopMs({ id: "hit-stop-active", samples: [], readError: "getter threw" });
  assert.equal(readError.ok, false);
  assert.match(readError.reason, /hit-stop series.*readError/i);

  // never hit → window never opens → refuse, never a fabricated 0
  const noWindow = deriveHitstopMs(hitStopWindow(9999, 120));
  assert.equal(noWindow.ok, false);
  assert.match(noWindow.reason, /no hit-stop window opened/i);

  // window opens but is still open at the end of the capture → inconclusive, refuse
  const unclosed = deriveHitstopMs(hitStopWindow(900, 500));
  assert.equal(unclosed.ok, false);
  assert.match(unclosed.reason, /did not close in-window/i);
});

// A camera shake trajectory: at rest until shakeMs, then a decaying circular displacement of `amp`.
function shakeTrack(amp: number, shakeMs = 200, endMs = 1000, stepMs = 10): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const durMs = 250;
  for (let t = 0; t <= endMs; t += stepMs) {
    const e = t - shakeMs;
    if (e < 0 || e > durMs) {
      out.push({ tMs: t, x: 0, y: 0 });
    } else {
      const decay = 1 - e / durMs; // 1 → 0 over the shake window
      const phase = (e / 1000) * 60 * 2 * Math.PI;
      out.push({ tMs: t, x: amp * decay * Math.cos(phase), y: amp * decay * Math.sin(phase) });
    }
  }
  return out;
}

test("deriveScreenShakeMag returns the peak camera displacement from rest", () => {
  // circular decaying shake of amplitude 0.3u → peak ≈ 0.3 (at shake onset, decay ≈ 1)
  const peak = deriveScreenShakeMag(shakeTrack(0.3));
  assert.ok(peak !== null);
  assert.ok(Math.abs(peak! - 0.3) < 1e-6);
});

test("deriveScreenShakeMag refuses a non-trajectory and a camera that never moved (no fabricated 0)", () => {
  // fewer than two samples / invalid trajectory → null
  assert.equal(deriveScreenShakeMag([{ tMs: 0, x: 0, y: 0 }]), null);

  // a perfectly static camera (no shake observed) → null, never a fabricated 0
  const staticCam: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 500; t += 10) staticCam.push({ tMs: t, x: 0, y: 0 });
  assert.equal(deriveScreenShakeMag(staticCam), null);

  // a sub-floor jitter below the registration epsilon is still "no shake"
  const jitter = staticCam.map((s, i) => ({ ...s, x: i % 2 === 0 ? SCREEN_SHAKE_MIN_REGISTERED_U / 2 : 0 }));
  assert.equal(deriveScreenShakeMag(jitter), null);
});

test("deriveScreenShakeMag(onsetMs): windows to post-impact and refuses pre-impact camera motion", () => {
  // Shake onset at 200ms; with onsetMs=200 the peak is the post-impact shake.
  const clean = shakeTrack(0.3, 200);
  const windowed = deriveScreenShakeMag(clean, 200);
  assert.ok(windowed !== null && Math.abs(windowed! - 0.3) < 1e-6);

  // P1 regression: the camera PANS before impact (a 0.9u pan in 300-450ms; samples[0] stays at rest),
  // then a small shake fires at 600ms. A whole-trajectory peak would certify the big pre-impact pan as
  // "shake"; the onset-windowed derivation REFUSES because the camera was not at rest before the hit.
  const prePan = shakeTrack(0.15, 600).map((s) =>
    s.tMs >= 300 && s.tMs <= 450 ? { tMs: s.tMs, x: 0.9, y: 0 } : s,
  );
  // Without onset, the pre-pan dominates the (wrong) peak — demonstrating the hazard.
  const naive = deriveScreenShakeMag(prePan);
  assert.ok(naive !== null && naive! > 0.5, "whole-trajectory peak is misled by pre-impact motion");
  // With the impact onset, pre-impact motion is refused outright (never certified as shake).
  assert.equal(deriveScreenShakeMag(prePan, 600), null);

  // onset outside the sampled window → refused.
  assert.equal(deriveScreenShakeMag(clean, 99999), null);
  // onset finite but no shake after it (camera goes still post-onset) → refused, never a fabricated 0.
  const stillAfter = clean.map((s) => (s.tMs >= 460 ? s : { tMs: s.tMs, x: 0, y: 0 }));
  assert.equal(deriveScreenShakeMag(stillAfter, 460), null);
});

test("isImmediateImpactFeedback: same-frame and one-frame pass; pre-hit and delayed are refused", () => {
  const frame = 16.67;
  assert.equal(isImmediateImpactFeedback(516.67, 516.67, frame), true); // same frame
  assert.equal(isImmediateImpactFeedback(533.33, 516.67, frame), true); // one frame late (within tolerance)
  assert.equal(isImmediateImpactFeedback(550.0, 516.67, frame), false); // two frames late → refused
  assert.equal(isImmediateImpactFeedback(500.0, 516.67, frame), false); // BEFORE the hit → refused
  assert.equal(isImmediateImpactFeedback(null, 516.67, frame), false); // no feedback edge
  assert.equal(isImmediateImpactFeedback(516.67, null, frame), false); // no hit edge
});

test("deriveShortHopApex shares the apex-height derivation; deriveMetric routes correctly", () => {
  const hop = jumpArc(1.1, 120, 240, 40);
  assert.ok(Math.abs((deriveShortHopApex(hop) ?? NaN) - 1.1) < 1e-9);
  assert.equal(deriveMetric("jumpApex", jumpArc()), deriveJumpApex(jumpArc()));
  assert.equal(deriveMetric("coyoteTime", jumpArc()), null); // not trajectory-derivable
});

test("deriveShortHopApex REFUSES a flat (no-rise) trajectory — the tap never registered (null, NOT 0)", () => {
  // All y equal → deriveJumpApex is 0 (player never left the ground). A canonical short
  // hop that realizes sub-registration is a false 0, so it must be omitted, not reported.
  const flat: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 1.5 },
    { tMs: 40, x: 0, y: 1.5 },
    { tMs: 80, x: 0, y: 1.5 },
  ];
  assert.equal(deriveJumpApex(flat), 0); // the shared apex IS 0 here
  assert.equal(deriveShortHopApex(flat), null); // …but shortHop refuses it (no-jump floor)
  // jumpApex must NOT gain this floor — routed through deriveMetric it still returns 0.
  assert.equal(deriveMetric("jumpApex", flat), 0);
  assert.equal(deriveMetric("shortHopApex", flat), null);
});

test("deriveShortHopApex REFUSES a tiny sub-floor rise (~0.02u below the no-jump floor) → null", () => {
  const tiny = jumpArc(0.02, 120, 240, 40); // apex ~0.02u, below SHORT_HOP_MIN_REGISTERED_RISE_U (0.05)
  assert.ok(deriveJumpApex(tiny) < 0.05);
  assert.equal(deriveShortHopApex(tiny), null);
});

test("deriveShortHopApex returns a REAL hop (~1.4u) unchanged — only a no-jump is refused", () => {
  const real = jumpArc(1.4, 120, 240, 40);
  const apex = deriveShortHopApex(real);
  assert.notEqual(apex, null);
  assert.ok(Math.abs((apex ?? NaN) - 1.4) < 1e-9);
});

test("isValidTrajectory requires ≥2 finite, strictly time-ordered samples", () => {
  assert.equal(isValidTrajectory([]), false);
  assert.equal(isValidTrajectory([{ tMs: 0, x: 0, y: 0 }]), false); // single sample
  assert.equal(isValidTrajectory([{ tMs: 0, x: 0, y: NaN }, { tMs: 40, x: 0, y: 1 }]), false); // non-finite
  // duplicate timestamps (non-positive duration)
  assert.equal(isValidTrajectory([{ tMs: 40, x: 0, y: 0 }, { tMs: 40, x: 1, y: 1 }]), false);
  // non-monotonic (non-causal) time
  assert.equal(isValidTrajectory([{ tMs: 80, x: 0, y: 0 }, { tMs: 40, x: 1, y: 1 }]), false);
  assert.equal(isValidTrajectory(jumpArc()), true);
});

test("REDERIVABLE_METRIC_SET is the trajectory metrics (F5 adds accel/decel/fallGravity/inputLatency; v2 adds aimTurnRateDegPerSec; 3C adds look latency)", () => {
  assert.deepEqual([...REDERIVABLE_METRIC_SET].sort(), [
    "aimTurnRateDegPerSec",
    "fallGravityMultiplier",
    "inputLatency",
    "jumpApex",
    "lookInputToYawLatencyMs",
    "projectileSpeed",
    "runAcceleration",
    "runDeceleration",
    "runSpeed",
    "shortHopApex",
    "timeToApex",
  ]);
});

// ── F5: run acceleration / deceleration ──────────────────────────────────────

test("deriveRunAcceleration recovers the ramp rate from a known run (90 u/s²)", () => {
  // accel 90, decel 120 → the rising ramp slope must read ~90 well inside ±25% band.
  const a = deriveRunAcceleration(runRamp(90, 9, 120))!;
  assert.ok(a !== null);
  assert.ok(Math.abs(a - 90) / 90 < 0.05, `expected ~90 u/s², got ${a}`);
});

test("deriveRunDeceleration recovers the settle rate from a known run (120 u/s²)", () => {
  const d = deriveRunDeceleration(runRamp(90, 9, 120))!;
  assert.ok(d !== null);
  assert.ok(Math.abs(d - 120) / 120 < 0.05, `expected ~120 u/s², got ${d}`);
});

test("accel/decel are robust to an overshoot-then-settle controller (F5 review finding)", () => {
  // A controller that briefly OVERSHOOTS its sustained speed (peaks 9.5) then
  // settles to a 9.0 cruise. With steady=max(=9.5) the cruise falls below
  // 0.95·peak and the entire cruise is misclassified as the decel ramp — the
  // reviewer's repro read decel ~60 instead of ~120. The median-plateau estimator
  // must anchor steady at the sustained 9.0 cruise (accel ~180, decel ~120).
  const dt = 0.005;
  const vs = [
    0.9, 1.8, 2.7, 3.6, 4.5, 5.4, 6.3, 7.2, 8.1, 9.0, 9.5, // accel ramp → overshoot
    9.2, 9.0, // ease back to cruise
    ...Array(60).fill(9.0), // long sustained cruise
    8.4, 7.8, 7.2, 6.6, 6.0, 5.4, 4.8, 4.2, 3.6, 3.0, 2.4, 1.8, 1.2, 0.6, 0.0, // release @120
  ];
  const out: FeelTrajectorySample[] = [{ tMs: 0, x: 0, y: 0 }];
  let x = 0;
  vs.forEach((v, i) => {
    x += v * dt;
    out.push({ tMs: (i + 1) * 5, x, y: 0 });
  });
  const a = deriveRunAcceleration(out)!;
  const d = deriveRunDeceleration(out)!;
  assert.ok(d !== null && Math.abs(d - 120) / 120 < 0.15, `decel poisoned by overshoot: got ${d}`);
  assert.ok(a !== null && Math.abs(a - 180) / 180 < 0.2, `accel poisoned by overshoot: got ${a}`);
});

test("accel/decel route through deriveMetric and a slower controller reads slower", () => {
  // momentum-like gentle ramp (25 u/s²) — the derivation tracks the actual rate.
  const slow = deriveMetric("runAcceleration", runRamp(25, 14, 18, 300));
  assert.ok(slow !== null && Math.abs((slow as number) - 25) / 25 < 0.08, `got ${slow}`);
  assert.equal(deriveMetric("runDeceleration", runTrack(9)), null); // flat track: no settle ramp
});

test("deriveRunDeceleration OMITS (null) when the capture has no settle phase", () => {
  // A clean "accelerate then hold, never release" track — no falling ramp to measure.
  const noRelease = (() => {
    const out: FeelTrajectorySample[] = [];
    let x = 0, v = 0, t = 0;
    const dt = 0.005;
    out.push({ tMs: 0, x, y: 0 });
    while (v < 9) { v = Math.min(9, v + 90 * dt); x += v * dt; t += 5; out.push({ tMs: t, x, y: 0 }); }
    for (let k = 0; k < 60; k++) { x += 9 * dt; t += 5; out.push({ tMs: t, x, y: 0 }); }
    return out;
  })();
  assert.equal(deriveRunDeceleration(noRelease), null); // no settle → omit, never invent
});

// Build an INSTANT-velocity controller capture from a real per-tick speed sequence
// by HONESTLY integrating x (x[i+1] = x[i] + speed*dt) — so the samples are real
// positions, never hand-set speeds. The sequence is the live tiderunner-clean repro
// (instant controller, moveSpeed 7, captureFps 60, dt≈16.67ms): a single PARTIAL
// injection tick (2.2), the instant plateau (7.0), then a partial release tick
// (4.78) and stop (0). The partial ticks are the snap-on/off artifact, NOT a ramp.
function instantControllerTrack(): FeelTrajectorySample[] {
  const dt = 1 / 60; // ≈16.67ms
  const speeds = [2.2, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 7.0, 4.78, 0.0, 0.0];
  const out: FeelTrajectorySample[] = [{ tMs: 0, x: 0, y: 0 }];
  let x = 0;
  speeds.forEach((s, i) => {
    x += s * dt; // real position from integrating the speed sequence
    out.push({ tMs: Math.round((i + 1) * dt * 1000 * 1e6) / 1e6, x, y: 0 });
  });
  return out;
}

test("deriveRunAcceleration OMITS (null) for an instant controller (partial→plateau, no real ramp)", () => {
  // The single partial injection tick must NOT fabricate a 2-point accel ramp.
  assert.equal(deriveRunAcceleration(instantControllerTrack()), null);
});

test("deriveRunDeceleration OMITS (null) for an instant controller (plateau→partial→stop, no real ramp)", () => {
  // The single partial release tick must NOT fabricate a 2-point decel ramp.
  assert.equal(deriveRunDeceleration(instantControllerTrack()), null);
});

test("deriveRunAcceleration OMITS (null) on a never-moving track", () => {
  const still: FeelTrajectorySample[] = [
    { tMs: 0, x: 5, y: 0 },
    { tMs: 100, x: 5, y: 0 },
    { tMs: 200, x: 5, y: 0 },
  ];
  assert.equal(deriveRunAcceleration(still), null);
});

// ── F5: fall-gravity multiplier ──────────────────────────────────────────────

test("deriveFallGravityMultiplier recovers the descent/ascent ratio (gDown/gUp = 2)", () => {
  // rise under 30 u/s², fall under 60 u/s² → multiplier 2.0×
  const m = deriveFallGravityMultiplier(asymJump(30, 60, 12))!;
  assert.ok(m !== null);
  assert.ok(Math.abs(m - 2.0) < 0.1, `expected ~2.0×, got ${m}`);
});

test("deriveFallGravityMultiplier ~1.0 for a symmetric arc; routes via deriveMetric", () => {
  const m = deriveMetric("fallGravityMultiplier", asymJump(40, 40, 12));
  assert.ok(m !== null && Math.abs((m as number) - 1.0) < 0.1, `expected ~1.0×, got ${m}`);
});

test("deriveFallGravityMultiplier OMITS (null) when the window is truncated before apex", () => {
  // cut to 6 samples — still rising, no apex/descent captured.
  const rising = asymJump(30, 60, 12, 5, 6);
  assert.ok(rising[rising.length - 1].y > rising[0].y); // sanity: still going up
  assert.equal(deriveFallGravityMultiplier(rising), null); // inconclusive → omit
});

test("deriveFallGravityMultiplier OMITS (null) when the fall is cut short (never returns near launch)", () => {
  // Take a full arc, then keep only through apex + a couple descent ticks so the
  // window ends high above the launch level — the descent leg isn't trustworthy.
  const full = asymJump(30, 60, 12);
  let apexIdx = 0;
  for (let i = 1; i < full.length; i++) if (full[i].y > full[apexIdx].y) apexIdx = i;
  const cutShort = full.slice(0, apexIdx + 3); // ends ~near apex, barely descended
  assert.equal(deriveFallGravityMultiplier(cutShort), null);
});

// ── bisection interpreter ────────────────────────────────────────────────────

test("interpretBisection returns the midpoint window when trials bracket the boundary", () => {
  const trials: BisectionTrial[] = [
    { delayMs: 60, jumped: true },
    { delayMs: 100, jumped: true },
    { delayMs: 140, jumped: false },
  ];
  const r = interpretBisection(trials);
  assert.ok(r.windowSeconds !== null);
  assert.ok(Math.abs((r.windowSeconds as number) - 0.12) < 1e-9); // (100+140)/2 ms
});

test("interpretBisection refuses (null + reason) when un-bracketed or non-monotonic", () => {
  assert.equal(interpretBisection([{ delayMs: 60, jumped: true }]).windowSeconds, null);
  assert.equal(interpretBisection([{ delayMs: 60, jumped: false }]).windowSeconds, null);
  const nonMono = interpretBisection([
    { delayMs: 140, jumped: true },
    { delayMs: 100, jumped: false },
  ]);
  assert.equal(nonMono.windowSeconds, null);
  assert.match(nonMono.reason ?? "", /non-monotonic/);
});

// ── feel-rederive gate (the discriminator) ───────────────────────────────────

function trajectorySource(over: Partial<FeelMeasurementSource> = {}): FeelMeasurementSource {
  return {
    source: "runtime.measure_motion",
    derivation: "trajectory",
    samples: jumpArc(3.0, 280),
    sampleCount: 15,
    captureFps: 120,
    measuredAt: "2026-06-02T00:00:00.000Z",
    projectFixedTimestepBeforeMeasurement: 0.02,
    measurementFixedTimestep: 0.02,
    measuredMetrics: ["jumpApex", "timeToApex"],
    ...over,
  };
}

test("feel-rederive: marker + matching reported value -> pass", () => {
  const input: FeelMeasurements = {
    jumpApex: 3.0,
    timeToApex: 280,
    provenance: { sources: [trajectorySource()] },
  };
  const report = evaluateFeelRederive(input, ACCEPTANCE);
  assert.equal(report.verdict, "pass");
  assert.ok(report.checks.every((c) => c.status === "pass"));
});

test("feel-rederive: marker + tampered reported value -> fail", () => {
  const input: FeelMeasurements = {
    jumpApex: 9.0, // samples re-derive to 3.0
    timeToApex: 280,
    provenance: { sources: [trajectorySource()] },
  };
  const report = evaluateFeelRederive(input, ACCEPTANCE);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "feel-rederive.jumpApex" && c.status === "fail"));
});

test("feel-rederive: marker + claimed metric but NO samples -> fail", () => {
  const input: FeelMeasurements = {
    jumpApex: 3.0,
    provenance: { sources: [trajectorySource({ samples: undefined, measuredMetrics: ["jumpApex"] })] },
  };
  const report = evaluateFeelRederive(input, ACCEPTANCE);
  assert.equal(report.verdict, "fail");
});

test("feel-rederive: marker + non-monotonic samples (invalid trajectory) -> fail", () => {
  const input: FeelMeasurements = {
    jumpApex: 3.0,
    provenance: {
      sources: [
        trajectorySource({
          // timestamps go backwards — not a usable trajectory
          samples: [
            { tMs: 80, x: 0, y: 0 },
            { tMs: 40, x: 0, y: 3 },
          ],
          measuredMetrics: ["jumpApex"],
        }),
      ],
    },
  };
  assert.equal(evaluateFeelRederive(input, ACCEPTANCE).verdict, "fail");
});

test("feel-rederive: legacy source WITHOUT the marker -> not_applicable", () => {
  const input: FeelMeasurements = {
    jumpApex: 3.0,
    provenance: {
      sources: [{ source: "FeelHarness", measuredMetrics: ["jumpApex"], sampleCount: 10, captureFps: 60 }],
    },
  };
  const report = evaluateFeelRederive(input, ACCEPTANCE);
  assert.equal(report.verdict, "not_applicable");
});

test("rederiveFromSources only verdicts trajectory-marked sources", () => {
  const verdicts = rederiveFromSources(
    [{ source: "FeelHarness", measuredMetrics: ["jumpApex"] }],
    { jumpApex: 3 },
  );
  assert.equal(verdicts.length, 0);
});

// ── feel-provenance ownership for runtime.measure_motion ─────────────────────

test("runtime.measure_motion is a valid source owning the observe-only metrics", () => {
  const src = trajectorySource();
  assert.equal(validMeasurementSource(src), true);
  const acceptance = {
    feel: { jumpApex: { target: 3, unit: "u", band: { percent: 12 } } },
  } as unknown as AcceptanceContract;
  const input: FeelMeasurements = { jumpApex: 3.0, provenance: { sources: [src] } };
  const report = evaluateFeelProvenance(input, acceptance);
  assert.ok(report.checks.some((c) => c.id === "feel-provenance.jumpApex" && c.status === "pass"));
});

test("ownership-valid measure_motion source with NO samples still fails feel-rederive", () => {
  // feel-provenance is structural (passes), but re-derivation cannot (fail) — the two gates are complementary.
  const src = trajectorySource({ samples: undefined, measuredMetrics: ["jumpApex"] });
  const acceptance = {
    feel: { jumpApex: { target: 3, unit: "u", band: { percent: 12 } } },
  } as unknown as AcceptanceContract;
  const input: FeelMeasurements = { jumpApex: 3.0, provenance: { sources: [src] } };
  assert.ok(evaluateFeelProvenance(input, acceptance).checks.some((c) => c.id === "feel-provenance.jumpApex" && c.status === "pass"));
  assert.equal(evaluateFeelRederive(input, ACCEPTANCE).verdict, "fail");
});

// ── F5: input latency (input onset → first detectable motion) ────────────────

// A latency capture: settle at rest (no motion) until `onsetMs`, then move at
// `speed` u/s. `latencyMs` is the gap between onset and when motion FIRST appears
// (a controller that responds `latencyMs` after the press). Flat-rezeroed samples
// every `stepMs` from 0.
function latencyTrack(
  onsetMs = 100,
  latencyMs = 50,
  speed = 9,
  endMs = 400,
  stepMs = 10,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const motionStart = onsetMs + latencyMs;
  for (let t = 0; t <= endMs; t += stepMs) {
    const moved = t > motionStart ? (speed * (t - motionStart)) / 1000 : 0;
    out.push({ tMs: t, x: moved, y: 0 });
  }
  return out;
}

test("deriveInputLatency recovers the press→first-motion gap within one sample step", () => {
  // onset 100ms, motion begins at 150ms → first MOVED sample is the one at 160ms
  // (the 150ms sample is still exactly at rest since motion is t>motionStart).
  const lat = deriveInputLatency(latencyTrack(100, 50, 9, 400, 10), 100);
  assert.ok(lat !== null);
  // True latency 50ms; quantized to the 10ms sampler → first moved sample at 160ms
  // → 60ms. Within one step of the true 50ms.
  assert.ok(Math.abs((lat as number) - 50) <= 10, `expected ~50ms (±1 step), got ${lat}`);
});

test("deriveInputLatency reads an instant (~1 step) response for a tight controller", () => {
  // motion begins the very next sampler tick after onset → latency ~ one step.
  const lat = deriveInputLatency(latencyTrack(100, 0, 9, 400, 10), 100);
  assert.ok(lat !== null && (lat as number) <= 20, `expected near-instant, got ${lat}`);
});

test("deriveInputLatency OMITS (null) when onset is absent", () => {
  assert.equal(deriveInputLatency(latencyTrack(100, 50), undefined), null);
  assert.equal(deriveInputLatency(latencyTrack(100, 50), Number.NaN), null);
});

test("deriveInputLatency OMITS (null) when no motion occurs after onset", () => {
  // A track that never moves after the press → no detectable motion → omit, not 0.
  const still: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 400; t += 10) still.push({ tMs: t, x: 0, y: 0 });
  assert.equal(deriveInputLatency(still, 100), null);
});

test("deriveInputLatency OMITS (null) when the onset is outside the sampled window", () => {
  const trk = latencyTrack(100, 50, 9, 400, 10);
  assert.equal(deriveInputLatency(trk, -10), null); // before window
  assert.equal(deriveInputLatency(trk, 9999), null); // after window
});

test("deriveInputLatency ignores sub-epsilon jitter at rest (no false-trigger before real motion)", () => {
  // Pre-motion samples jitter just under the epsilon; the first SUPRA-epsilon move
  // is the real response. Motion begins well after onset.
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 400; t += 10) {
    const jitter = (t % 20 === 0 ? 1 : -1) * INPUT_LATENCY_EPSILON_U * 0.5; // < epsilon
    const moved = t > 200 ? (9 * (t - 200)) / 1000 : jitter;
    out.push({ tMs: t, x: moved, y: 0 });
  }
  const lat = deriveInputLatency(out, 100);
  assert.ok(lat !== null);
  // Real motion at >200ms with onset 100ms → latency ~110ms, NOT triggered by jitter.
  assert.ok((lat as number) >= 100, `jitter should not pre-trigger; got ${lat}`);
});

test("deriveInputLatency anchors rest at the onset position (pre-onset drift not counted)", () => {
  // The body DRIFTS before onset (e.g. residual velocity), then onset, then a fresh
  // move. Rest must be anchored at the onset position so the drift isn't read as the
  // response. Pre-onset x climbs to 1.0 by 100ms; post-onset it moves further.
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 400; t += 10) {
    const x = t <= 100 ? (1.0 * t) / 100 : 1.0 + (t > 150 ? (9 * (t - 150)) / 1000 : 0);
    out.push({ tMs: t, x, y: 0 });
  }
  const lat = deriveInputLatency(out, 100);
  assert.ok(lat !== null);
  // Motion (beyond the 1.0 onset position) resumes after 150ms → latency ~60ms,
  // measured from onset 100ms, NOT from the start of the pre-onset drift.
  assert.ok((lat as number) >= 50 && (lat as number) <= 70, `expected ~60ms, got ${lat}`);
});

test("deriveMetric routes inputLatency through the onset arg; omits without it", () => {
  const trk = latencyTrack(100, 50, 9, 400, 10);
  const withOnset = deriveMetric("inputLatency", trk, 100);
  assert.ok(withOnset !== null && Math.abs((withOnset as number) - 50) <= 10);
  // No onset → omit (never fabricate a 0).
  assert.equal(deriveMetric("inputLatency", trk), null);
});

// ── L3b cross-modal sync edges ───────────────────────────────────────────────

/** A clean numeric SFX series (e.g. SfxPlayer.PlayCount) that increments at `edgeMs`. */
function playCountSeries(edgeMs: number, endMs = 400, stepMs = 10): SyncSeries {
  const samples: SyncSeries["samples"] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "jump-sfx", samples };
}

/** A clean bool SFX series (e.g. AudioSource.isPlaying) that goes false→true at `edgeMs`. */
function isPlayingSeries(edgeMs: number, endMs = 400, stepMs = 10): SyncSeries {
  const samples: SyncSeries["samples"] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs });
  return { id: "jump-sfx", samples };
}

test("firstRisingEdge detects a NUMERIC increment above the first-sample baseline", () => {
  // PlayCount baseline 0; first sample > 0 is at 150ms.
  assert.equal(firstRisingEdge(playCountSeries(150)), 150);
});

test("firstRisingEdge detects a BOOL false→true transition", () => {
  assert.equal(firstRisingEdge(isPlayingSeries(150)), 150);
});

test("firstRisingEdge returns null when the bool is ALREADY true at baseline (no visible transition)", () => {
  const samples = [
    { tMs: 0, value: true },
    { tMs: 10, value: true },
  ];
  assert.equal(firstRisingEdge({ id: "s", samples }), null);
});

test("firstRisingEdge returns null when a numeric never rises above its baseline", () => {
  const flat = playCountSeries(9999); // never crosses in-window
  assert.equal(firstRisingEdge(flat), null);
  const empty: SyncSeries = { id: "s", samples: [] };
  assert.equal(firstRisingEdge(empty), null);
});

test("deriveEdgeLatency = edge − reference for a numeric edge", () => {
  // edge at 150ms, reference (onset) at 100ms → 50ms.
  assert.equal(deriveEdgeLatency(playCountSeries(150), 100), 50);
});

test("deriveEdgeLatency = edge − reference for a bool edge", () => {
  assert.equal(deriveEdgeLatency(isPlayingSeries(160), 100), 60);
});

test("deriveEdgeLatency OMITS (null) when the reference edge is absent/non-finite — never a fabricated 0", () => {
  assert.equal(deriveEdgeLatency(playCountSeries(150), undefined), null);
  assert.equal(deriveEdgeLatency(playCountSeries(150), Number.NaN), null);
});

test("deriveEdgeLatency OMITS (null) when there is no rising edge", () => {
  assert.equal(deriveEdgeLatency(playCountSeries(9999), 100), null);
});

test("deriveEdgeLatency OMITS (null) when the edge PRECEDES the reference (negative → inconclusive)", () => {
  // SFX edge at 50ms but onset at 100ms → -50ms → non-causal → omit, never clamp to 0.
  assert.equal(deriveEdgeLatency(playCountSeries(50), 100), null);
});

test("syncSeriesRefusal: a CLEAN series (no unresolved, no readError) is not refused", () => {
  assert.equal(syncSeriesRefusal(playCountSeries(150)), null);
});

test("syncSeriesRefusal: an UNRESOLVED series is refused with the reason (F1 invariant)", () => {
  const r = syncSeriesRefusal({ id: "jump-sfx", samples: [], unresolved: "component 'SfxPlayer' not present on GameObject" });
  assert.ok(r && /unresolved/i.test(r) && /SfxPlayer/.test(r));
});

test("syncSeriesRefusal: a readError series is refused with the reason (F1 invariant)", () => {
  const r = syncSeriesRefusal({ id: "jump-sfx", samples: [{ tMs: 0, value: 0 }], readError: "read failed at tMs 120: NRE" });
  assert.ok(r && /readError/i.test(r) && /read failed/.test(r));
});

test("syncSeriesRefusal: an absent series is refused", () => {
  assert.ok(syncSeriesRefusal(undefined));
  assert.ok(syncSeriesRefusal(null));
});

test("deriveInputToSfxLatency measures latency from a clean numeric SFX edge vs onset", () => {
  const res = deriveInputToSfxLatency(playCountSeries(180), 100);
  assert.ok(res.ok && res.latencyMs === 80);
});

test("deriveInputToSfxLatency measures latency from a clean BOOL SFX edge vs onset", () => {
  const res = deriveInputToSfxLatency(isPlayingSeries(170), 100);
  assert.ok(res.ok && res.latencyMs === 70);
});

test("deriveInputToSfxLatency REFUSES an UNRESOLVED series with the reason (F1 invariant — never derives an edge)", () => {
  const res = deriveInputToSfxLatency(
    { id: "jump-sfx", samples: [], unresolved: "locator resolved to no GameObject" },
    100,
  );
  assert.ok(!res.ok && /unresolved/i.test(res.reason));
});

test("deriveInputToSfxLatency REFUSES a readError series with the reason (F1 invariant — never derives an edge)", () => {
  // Even though these (truncated) samples DO contain a rising edge, the readError
  // makes the stream untrusted → refuse, never derive the edge from it.
  const res = deriveInputToSfxLatency(
    { id: "jump-sfx", samples: [{ tMs: 0, value: 0 }, { tMs: 110, value: 1 }], readError: "read failed at tMs 120: NRE" },
    100,
  );
  assert.ok(!res.ok && /readError/i.test(res.reason));
});

test("deriveInputToSfxLatency refuses when the onset is missing (cannot measure)", () => {
  const res = deriveInputToSfxLatency(playCountSeries(180), undefined);
  assert.ok(!res.ok && /onset/i.test(res.reason));
});

test("deriveInputToSfxLatency omits (with reason) when no SFX cue fired", () => {
  const res = deriveInputToSfxLatency(playCountSeries(9999), 100);
  assert.ok(!res.ok && /no SFX cue|rising edge/i.test(res.reason));
});

test("deriveInputToSfxLatency omits (with reason) when the SFX edge precedes the onset", () => {
  const res = deriveInputToSfxLatency(playCountSeries(50), 100);
  assert.ok(!res.ok && /precede|non-causal/i.test(res.reason));
});

// ── L3c: dashToGhostMs (series→series sync) ──────────────────────────────────
/** A bool fieldTimeline series (false→true at edgeMs), e.g. IsDashing / ghost.enabled. */
function boolSeries(id: string, edgeMs: number, endMs = 400, stepMs = 10): SyncSeries {
  const samples: SyncSeries["samples"] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs });
  return { id, samples };
}

test("deriveDashToGhostLatency measures ghostEdge − dashEdge from two clean series", () => {
  // dash starts at 100ms, ghost spawns at 130ms → 30ms.
  const res = deriveDashToGhostLatency(boolSeries("dashing", 100), boolSeries("ghost", 130));
  assert.ok(res.ok && res.latencyMs === 30);
});

test("deriveDashToGhostLatency measures 0 for a same-tick (tight) sync", () => {
  // tiderunner's real case: the ghost is enabled the same frame the dash begins.
  const res = deriveDashToGhostLatency(boolSeries("dashing", 120), boolSeries("ghost", 120));
  assert.ok(res.ok && res.latencyMs === 0);
});

test("deriveDashToGhostLatency REFUSES when the DASH series is degraded — even if the ghost has a valid edge (F1)", () => {
  const res = deriveDashToGhostLatency(
    { id: "dashing", samples: [{ tMs: 0, value: false }, { tMs: 100, value: true }], readError: "getter threw at tMs 90" },
    boolSeries("ghost", 130),
  );
  assert.ok(!res.ok && /dash series/i.test(res.reason) && /readError/i.test(res.reason));
});

test("deriveDashToGhostLatency REFUSES when the GHOST series is degraded — even if the dash has a valid edge (F1)", () => {
  const res = deriveDashToGhostLatency(
    boolSeries("dashing", 100),
    { id: "ghost", samples: [{ tMs: 0, value: false }, { tMs: 130, value: true }], unresolved: "no GameObject '/DashGhost_0'" },
  );
  assert.ok(!res.ok && /ghost series/i.test(res.reason) && /unresolved/i.test(res.reason));
});

test("deriveDashToGhostLatency refuses when the dash never started (no dash edge)", () => {
  const res = deriveDashToGhostLatency(boolSeries("dashing", 9999), boolSeries("ghost", 130));
  assert.ok(!res.ok && /dash never started|rising edge/i.test(res.reason));
});

test("deriveDashToGhostLatency omits (with reason) when no ghost spawned after the dash", () => {
  const res = deriveDashToGhostLatency(boolSeries("dashing", 100), boolSeries("ghost", 9999));
  assert.ok(!res.ok && /no dash-ghost|rising edge/i.test(res.reason));
});

test("deriveDashToGhostLatency omits (with reason) when the ghost edge precedes the dash (non-causal)", () => {
  // ghost at 80ms but dash at 120ms → negative → omit, never a clamped 0.
  const res = deriveDashToGhostLatency(boolSeries("dashing", 120), boolSeries("ghost", 80));
  assert.ok(!res.ok && /precede|non-causal/i.test(res.reason));
});

// ── L3e: inputToAnimStateLatency (input onset → categorical anim-state entry) ─
const IDLE = 0;
const RUN = 1;
const JUMP = 2;
const FALL = 3;

/** A numeric anim-state series that ENTERS `state` (value === state) at `edgeMs`, idle before. */
function animStateSeries(state: number, edgeMs: number, endMs = 400, stepMs = 10): SyncSeries {
  const samples: SyncSeries["samples"] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? state : IDLE });
  return { id: "anim-state", samples };
}

test("firstStateEntryEdge returns the tMs of the first sample EQUAL to the target state", () => {
  // enters JUMP at 150ms.
  assert.equal(firstStateEntryEdge(animStateSeries(JUMP, 150), JUMP), 150);
});

test("firstStateEntryEdge catches a FALL(3)→JUMP(2) entry a rising edge would MISS (2<3, still an entry)", () => {
  // idle(0) → fall(3) at 100 → jump(2) at 200. Entering JUMP is value===2 at 200ms, even
  // though 2 < the prior fall ordinal 3 (a monotonic rising edge would never see this).
  const samples: SyncSeries["samples"] = [
    { tMs: 0, value: IDLE },
    { tMs: 100, value: FALL },
    { tMs: 200, value: JUMP },
    { tMs: 300, value: JUMP },
  ];
  assert.equal(firstStateEntryEdge({ id: "anim-state", samples }, JUMP), 200);
  // For comparison: firstRisingEdge (baseline 0) fires on the FALL(3) at 100 — NOT the jump.
  assert.equal(firstRisingEdge({ id: "anim-state", samples }), 100);
});

test("firstStateEntryEdge returns null when the state is never entered in-window", () => {
  assert.equal(firstStateEntryEdge(animStateSeries(RUN, 150), JUMP), null);
  assert.equal(firstStateEntryEdge({ id: "s", samples: [] }, JUMP), null);
});

test("firstStateEntryEdge works for a bool target (target===true)", () => {
  assert.equal(firstStateEntryEdge(isPlayingSeries(170), true), 170);
});

test("firstStateEntryEdge returns null when ALREADY in the target at capture start (no observed transition → no fabricated entry)", () => {
  // baseline === target (the series begins in JUMP and stays) → no entry transition observed.
  // Without this guard, a t0 onset would read a spurious 0 latency.
  const stuck: SyncSeries["samples"] = [
    { tMs: 0, value: JUMP }, { tMs: 100, value: JUMP }, { tMs: 200, value: JUMP },
  ];
  assert.equal(firstStateEntryEdge({ id: "anim-state", samples: stuck }, JUMP), null);
  // but a RE-entry (jump→idle→jump) IS an observed transition → the re-entry tMs.
  const reentry: SyncSeries["samples"] = [
    { tMs: 0, value: JUMP }, { tMs: 100, value: IDLE }, { tMs: 200, value: JUMP },
  ];
  assert.equal(firstStateEntryEdge({ id: "anim-state", samples: reentry }, JUMP), 200);
});

test("deriveInputToAnimStateLatency measures latency from a clean anim-state entry vs onset", () => {
  // enters JUMP at 180ms, onset 100ms → 80ms.
  const res = deriveInputToAnimStateLatency(animStateSeries(JUMP, 180), 100, JUMP);
  assert.ok(res.ok && res.latencyMs === 80);
});

test("deriveInputToAnimStateLatency measures 0 for a same-tick (tight) entry — a VALID measurement, not a refusal", () => {
  const res = deriveInputToAnimStateLatency(animStateSeries(JUMP, 100), 100, JUMP);
  assert.ok(res.ok && res.latencyMs === 0);
});

test("deriveInputToAnimStateLatency REFUSES an UNRESOLVED series with the reason (F1 invariant)", () => {
  const res = deriveInputToAnimStateLatency(
    { id: "anim-state", samples: [], unresolved: "no Animator on '/Player'" },
    100,
    JUMP,
  );
  assert.ok(!res.ok && /unresolved/i.test(res.reason));
});

test("deriveInputToAnimStateLatency REFUSES a readError series EVEN IF it contains a valid entry (F1 invariant)", () => {
  // These truncated samples DO contain a JUMP entry at 110ms, but the readError makes
  // the stream untrusted → refuse, never derive the entry from it.
  const res = deriveInputToAnimStateLatency(
    { id: "anim-state", samples: [{ tMs: 0, value: IDLE }, { tMs: 110, value: JUMP }], readError: "getter threw at tMs 120" },
    100,
    JUMP,
  );
  assert.ok(!res.ok && /readError/i.test(res.reason));
});

test("deriveInputToAnimStateLatency refuses when the onset is missing (cannot measure)", () => {
  const res = deriveInputToAnimStateLatency(animStateSeries(JUMP, 180), undefined, JUMP);
  assert.ok(!res.ok && /onset/i.test(res.reason));
});

test("deriveInputToAnimStateLatency refuses (with reason) when the state is never entered in-window", () => {
  const res = deriveInputToAnimStateLatency(animStateSeries(RUN, 180), 100, JUMP);
  assert.ok(!res.ok && /never entered|state-entry/i.test(res.reason));
});

test("deriveInputToAnimStateLatency refuses when the entry PRECEDES the onset (non-causal, not 0)", () => {
  // enters JUMP at 50ms but onset 100ms → -50ms → non-causal → refuse, never clamp to 0.
  const res = deriveInputToAnimStateLatency(animStateSeries(JUMP, 50), 100, JUMP);
  assert.ok(!res.ok && /precede|non-causal/i.test(res.reason));
});

// ── L3d: groundContactToDustMs (trajectory-edge → dust series) ───────────────
//
// A full jump arc: rise from y=0 to apex, fall back, then LAND flat at the ground.
// The y values are chosen so per-interval vy clearly crosses the fall floor (≤ -1.0)
// on the descent and arrests (≥ -0.5) at the landing tMs. Steps are 20ms so 1u of
// fall in a step is 50 u/s — comfortably past the fall floor.
function fallLandArc(): FeelTrajectorySample[] {
  // rise: 0→3 over 0..100ms; fall: 3→0 over 100..200ms; LAND flat at 200ms onward.
  // vy on the last falling interval (180→200, y 0.6→0) = -30 u/s (a real fall);
  // vy on the flat post-landing intervals = 0 (arrested) → contact tMs = 220.
  return [
    { tMs: 0, x: 0, y: 0 },
    { tMs: 20, x: 0, y: 1.2 },
    { tMs: 40, x: 0, y: 2.2 },
    { tMs: 60, x: 0, y: 2.8 },
    { tMs: 80, x: 0, y: 3.0 }, // apex (vy here ≈ 0 — must NOT be read as a landing)
    { tMs: 100, x: 0, y: 2.8 },
    { tMs: 120, x: 0, y: 2.2 },
    { tMs: 140, x: 0, y: 1.4 },
    { tMs: 160, x: 0, y: 0.6 },
    { tMs: 180, x: 0, y: 0.1 },
    { tMs: 200, x: 0, y: 0.0 }, // touchdown (fall arrests at the interval ENDING here)
    { tMs: 220, x: 0, y: 0.0 }, // settled — vy 0, confirms the arrest
    { tMs: 240, x: 0, y: 0.0 },
  ];
}

// The same arc but truncated mid-fall (still descending at the last sample → no landing).
function stillFallingArc(): FeelTrajectorySample[] {
  return [
    { tMs: 0, x: 0, y: 0 },
    { tMs: 20, x: 0, y: 1.2 },
    { tMs: 40, x: 0, y: 2.2 },
    { tMs: 60, x: 0, y: 2.8 },
    { tMs: 80, x: 0, y: 3.0 },
    { tMs: 100, x: 0, y: 2.4 },
    { tMs: 120, x: 0, y: 1.6 }, // still falling fast at the end → no arrest in window
  ];
}

// A clean numeric dust series (e.g. LandingDustCount) incrementing 0→1 at edgeMs.
function dustCountSeries(edgeMs: number, endMs = 600, stepMs = 20): SyncSeries {
  const samples: SyncSeries["samples"] = [];
  for (let t = 0; t <= endMs; t += stepMs) samples.push({ tMs: t, value: t >= edgeMs ? 1 : 0 });
  return { id: "landing-dust", samples };
}

test("deriveGroundContactEdge returns the LANDING tMs (not the apex) on a full jump arc", () => {
  // Fall arrests at the interval ending at 200ms (y stops decreasing), so contact = 200.
  assert.equal(deriveGroundContactEdge(fallLandArc()), 200);
});

test("deriveGroundContactEdge returns the landing on a pure fall→land (no rise)", () => {
  const samples: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 3.0 },
    { tMs: 20, x: 0, y: 2.0 },
    { tMs: 40, x: 0, y: 1.0 },
    { tMs: 60, x: 0, y: 0.2 },
    { tMs: 80, x: 0, y: 0.0 }, // arrests here
    { tMs: 100, x: 0, y: 0.0 },
  ];
  assert.equal(deriveGroundContactEdge(samples), 80);
});

test("deriveGroundContactEdge returns null when still falling at the end of the window", () => {
  assert.equal(deriveGroundContactEdge(stillFallingArc()), null);
});

test("deriveGroundContactEdge returns null for a flat / no-fall trajectory", () => {
  const flat: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 1.0 },
    { tMs: 20, x: 0, y: 1.0 },
    { tMs: 40, x: 0, y: 1.0 },
    { tMs: 60, x: 0, y: 1.0 },
  ];
  assert.equal(deriveGroundContactEdge(flat), null);
});

test("deriveGroundContactEdge returns null with fewer than 3 samples", () => {
  assert.equal(deriveGroundContactEdge([{ tMs: 0, x: 0, y: 3 }, { tMs: 20, x: 0, y: 0 }]), null);
  assert.equal(deriveGroundContactEdge([{ tMs: 0, x: 0, y: 3 }]), null);
});

test("deriveGroundContactToDustLatency measures dustEdge − groundContact on a clean fall→land", () => {
  // contact at 200ms, dust at 240ms → 40ms.
  const res = deriveGroundContactToDustLatency(fallLandArc(), dustCountSeries(240));
  assert.ok(res.ok && res.latencyMs === 40);
});

test("deriveGroundContactToDustLatency measures 0 for a same-tick (tight) landing dust", () => {
  // dust spawns the same tick the fall arrests (200ms) → 0, a VALID measurement.
  const res = deriveGroundContactToDustLatency(fallLandArc(), dustCountSeries(200));
  assert.ok(res.ok && res.latencyMs === 0);
});

test("deriveGroundContactToDustLatency REFUSES when the DUST series is degraded — even with a valid edge (F1)", () => {
  const res = deriveGroundContactToDustLatency(fallLandArc(), {
    id: "landing-dust",
    samples: [{ tMs: 0, value: 0 }, { tMs: 240, value: 1 }],
    readError: "getter threw at tMs 230",
  });
  assert.ok(!res.ok && /dust series/i.test(res.reason) && /readError/i.test(res.reason));
});

test("deriveGroundContactToDustLatency REFUSES an unresolved dust series (F1)", () => {
  const res = deriveGroundContactToDustLatency(fallLandArc(), {
    id: "landing-dust",
    samples: [],
    unresolved: "no member 'LandingDustCount' on PlayerController",
  });
  assert.ok(!res.ok && /dust series/i.test(res.reason) && /unresolved/i.test(res.reason));
});

test("deriveGroundContactToDustLatency refuses when there was no landing (no completed fall→land)", () => {
  const res = deriveGroundContactToDustLatency(stillFallingArc(), dustCountSeries(240));
  assert.ok(!res.ok && /no ground contact|fall.?land/i.test(res.reason));
});

test("deriveGroundContactToDustLatency omits (with reason) when no landing dust spawned", () => {
  const res = deriveGroundContactToDustLatency(fallLandArc(), dustCountSeries(9999));
  assert.ok(!res.ok && /no landing dust|rising edge/i.test(res.reason));
});

test("deriveGroundContactToDustLatency omits (with reason) when the dust edge precedes contact (non-causal)", () => {
  // dust at 100ms but contact at 200ms → negative → omit, never a clamped 0.
  const res = deriveGroundContactToDustLatency(fallLandArc(), dustCountSeries(100));
  assert.ok(!res.ok && /precede|non-causal/i.test(res.reason));
});
