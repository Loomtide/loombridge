/**
 * 3D move-speed feel substrate (dogfood finding RCL-G06 — the missing 3D movement metric).
 *
 * Pure, synthetic-trajectory unit tests for the two move-speed calculators in
 * `verification/feel-derive.ts`, mirroring the trajectory-calculator tests'
 * (`deriveProjectileSpeed` / `deriveAimTurnRateDegPerSec`) style:
 *
 *   deriveMoveSpeed  — steady-state PLANAR (XZ ground-plane) move speed `hypot(Δx,Δz)/Δt`,
 *                      dimension-agnostic so a top-down +Z run (the Z-blind case the old
 *                      horizontal `runSpeed` broke on, RCL-T02) measures correctly.
 *   deriveAccelTo90  — time from movement start to reaching 90% of steady planar speed.
 *
 * Both are dimension-agnostic, honest-or-omit, and re-derivable from a raw trajectory.
 * LIVE Unity capture evidence is DEFERRED: a real top-down move capture needs a built
 * locomotion scene (no committed demo-bundles/* transcript yet, like the hold-channel
 * substrate). The calculators plus these synthetic-trajectory tests are the slice deliverable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMoveSpeed, deriveAccelTo90 } from "../capabilities/verification/feel-derive.js";
import type { FeelTrajectorySample } from "../capabilities/verification/gates/feel.js";

// Constant planar motion at `speed` u/s along a chosen ground axis ("x" or "z"),
// with a constant up-axis (`y`) height. Models a character cruising at steady speed.
function moveTrack(
  axis: "x" | "z",
  speed: number,
  durMs = 1000,
  stepMs = 100,
  y = 1,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= durMs; t += stepMs) {
    const d = (speed * t) / 1000;
    out.push({ tMs: t, x: axis === "x" ? d : 0, y, z: axis === "z" ? d : 0 });
  }
  return out;
}

// ── deriveMoveSpeed ────────────────────────────────────────────────────────────

test("(a) move-speed measures a top-down +Z run — THE case the Z-blind bug broke (non-zero)", () => {
  const fwd = moveTrack("z", 6);
  const v = deriveMoveSpeed(fwd);
  assert.ok(v !== null, "a real +Z run must not refuse");
  assert.ok(Math.abs((v ?? NaN) - 6) < 1e-9, `expected 6 u/s, got ${v}`);
  // HEADLINE PROOF: the old horizontal-X measure read ~0 on this exact track because
  // all motion is in z. Strip z → a stationary x track → refuse (never a fabricated 0).
  const zStripped = fwd.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
  assert.equal(deriveMoveSpeed(zStripped), null, "z-stripped pure +Z run must refuse");
});

test("(b) move-speed measures a +X run at the same speed (axis-agnostic)", () => {
  assert.ok(Math.abs((deriveMoveSpeed(moveTrack("x", 6)) ?? NaN) - 6) < 1e-9);
  // +X and +Z runs at the same speed read identically.
  assert.equal(deriveMoveSpeed(moveTrack("x", 6)), deriveMoveSpeed(moveTrack("z", 6)));
});

test("(c) move-speed measures an X+Z diagonal as the planar hypotenuse (3-4-5 → 5)", () => {
  // 3 u/s in x and 4 u/s in z → planar speed 5 u/s.
  const diag: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 1000; t += 100) {
    diag.push({ tMs: t, x: (3 * t) / 1000, y: 1, z: (4 * t) / 1000 });
  }
  assert.ok(Math.abs((deriveMoveSpeed(diag) ?? NaN) - 5) < 1e-9);
});

test("move-speed EXCLUDES the up (Y) axis — a vertical bob does not inflate ground speed", () => {
  // Pure vertical motion (a hop/bob in y, no XZ travel) is NOT ground movement → refuse.
  const bob: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 1000; t += 100) {
    bob.push({ tMs: t, x: 0, y: 1 + Math.sin(t / 100), z: 0 });
  }
  assert.equal(deriveMoveSpeed(bob), null, "a y-only bob is not ground movement");
});

test("(d) move-speed OMITS (null) for an idle / no-motion character — never a fabricated 0", () => {
  const idle: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 1000; t += 100) idle.push({ tMs: t, x: 2, y: 1, z: 3 });
  assert.equal(deriveMoveSpeed(idle), null);
  // A single moved interval (a teleport/spawn snap) is rejected (needs ≥2 moving intervals).
  assert.equal(
    deriveMoveSpeed([
      { tMs: 0, x: 0, y: 1, z: 0 },
      { tMs: 100, x: 0, y: 1, z: 5 },
    ]),
    null,
  );
});

test("(f) move-speed REFUSES a malformed / empty / too-short trajectory", () => {
  assert.equal(deriveMoveSpeed([]), null);
  assert.equal(deriveMoveSpeed([{ tMs: 0, x: 0, y: 1, z: 0 }]), null); // <2 samples
  // Non-monotonic time (scrambled / non-causal) → isValidTrajectory refuses.
  assert.equal(
    deriveMoveSpeed([
      { tMs: 100, x: 0, y: 1, z: 0 },
      { tMs: 100, x: 1, y: 1, z: 1 },
      { tMs: 50, x: 2, y: 1, z: 2 },
    ]),
    null,
  );
  assert.equal(deriveMoveSpeed(undefined as unknown as FeelTrajectorySample[]), null);
});

// ── deriveAccelTo90 ──────────────────────────────────────────────────────────

// A top-down +Z ramp with a KNOWN per-interval planar speed sequence, integrated
// into positions (z accumulates speed·dt per 50ms step). The speeds ramp from rest
// to a steady cruise so accelTo90 is the time to first reach 90% of cruise.
function rampTrack(speeds: number[], stepMs = 50, y = 1): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [{ tMs: 0, x: 0, y, z: 0 }];
  let z = 0;
  let t = 0;
  for (const sp of speeds) {
    z += (sp * stepMs) / 1000;
    t += stepMs;
    out.push({ tMs: t, x: 0, y, z });
  }
  return out;
}

test("(e) accelTo90 measures the time to reach 90% of steady on a ramp-then-steady trace", () => {
  // Per-interval planar speeds: ramp 2,4,6,8 → steady 9,9,9 (cruise = 9 u/s).
  // 90% of 9 = 8.1; the first interval at/above 8.1 is the 5th (speed 9), which ENDS at
  // t=250ms; movement starts at the START of the first moving interval, t=0. → 250ms.
  const trace = rampTrack([2, 4, 6, 8, 9, 9, 9]);
  const a = deriveAccelTo90(trace);
  assert.ok(a !== null, "a real accel ramp must not refuse");
  assert.ok(Math.abs((a ?? NaN) - 250) < 1e-9, `expected 250 ms, got ${a}`);
  // The same trace's steady move speed is the 9 u/s cruise (plateau, not the ramp avg).
  assert.ok(Math.abs((deriveMoveSpeed(trace) ?? NaN) - 9) < 1e-9);
});

test("accelTo90 OMITS (null) for an INSTANT controller (snaps straight to cruise, no ramp)", () => {
  // Every moving interval is already at the 9 u/s cruise → zero intermediate ramp ticks.
  const instant = rampTrack([9, 9, 9, 9, 9]);
  assert.equal(deriveAccelTo90(instant), null);
});

test("accelTo90 OMITS (null) for an idle character and refuses a malformed trajectory", () => {
  const idle: FeelTrajectorySample[] = [];
  for (let t = 0; t <= 500; t += 50) idle.push({ tMs: t, x: 0, y: 1, z: 0 });
  assert.equal(deriveAccelTo90(idle), null);
  assert.equal(deriveAccelTo90([]), null);
  assert.equal(deriveAccelTo90([{ tMs: 0, x: 0, y: 1, z: 0 }]), null);
});

test("accelTo90 is dimension-agnostic — a +X ramp reads the same as the +Z ramp", () => {
  const zRamp = rampTrack([2, 4, 6, 8, 9, 9, 9]);
  // Same speeds along x instead of z.
  const xRamp: FeelTrajectorySample[] = [{ tMs: 0, x: 0, y: 1, z: 0 }];
  let x = 0;
  let t = 0;
  for (const sp of [2, 4, 6, 8, 9, 9, 9]) {
    x += (sp * 50) / 1000;
    t += 50;
    xRamp.push({ tMs: t, x, y: 1, z: 0 });
  }
  assert.equal(deriveAccelTo90(xRamp), deriveAccelTo90(zRamp));
});
