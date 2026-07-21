import assert from "node:assert/strict";
import test from "node:test";

import {
  interpretAirDash,
  interpretVariableJump,
  interpretFallGravityAsymmetry,
  interpretWindowMechanism,
  AIR_DASH_SPIKE_FACTOR,
  FALL_ASYMMETRY_MARGIN,
  evaluateMechanisms,
  type MechanismEvidence,
} from "../loomtide/genre-packs/platformer-2d/mechanisms.js";
import type { PlatformerFeelProfile } from "../loomtide/genre-packs/platformer-2d/types.js";
import type { FeelTrajectorySample } from "../verification/gates/feel.js";
import type { BisectionTrial } from "../verification/feel-derive.js";

// ── synthetic-fixture builders ───────────────────────────────────────────────

/** A steady run at `speed` u/s for `durMs` (flat y), uniform sampling. */
function runTrack(speed = 9, durMs = 800, stepMs = 50): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= durMs; t += stepMs) {
    out.push({ tMs: t, x: speed * (t / 1000), y: 0 });
  }
  return out;
}

/**
 * A run that, midway, briefly bursts to `dashSpeed` u/s for a few ticks (an air
 * dash) before returning to `runSpeed`. The peak tick-speed is `dashSpeed`.
 */
function runWithDash(
  runSpeed = 9,
  dashSpeed = 40,
  durMs = 800,
  stepMs = 50,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  let x = 0;
  let prevT = 0;
  for (let t = 0; t <= durMs; t += stepMs) {
    const dt = (t - prevT) / 1000;
    // Dash window: 300–400ms.
    const v = t > 300 && t <= 400 ? dashSpeed : runSpeed;
    x += v * dt;
    out.push({ tMs: t, x, y: 0 });
    prevT = t;
  }
  return out;
}

/** A symmetric parabolic jump arc peaking at `apex`u above start. */
function jumpArc(apex = 3.0, apexMs = 280, endMs = 560, stepMs = 20): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const y = apex * (1 - ((t - apexMs) / apexMs) ** 2);
    out.push({ tMs: t, x: 0, y });
  }
  return out;
}

/**
 * An ASYMMETRIC jump arc: it rises with a gentle (floaty) accel and falls with a
 * heavier accel, so descentAccel/ascentAccel > 1. Built piecewise around the apex.
 */
function asymmetricArc(
  riseAccel = 30, // |a| during ascent (u/s^2)
  fallAccel = 60, // |a| during descent (u/s^2)
  v0 = 12, // launch vertical speed (u/s)
  stepMs = 20,
): FeelTrajectorySample[] {
  const out: FeelTrajectorySample[] = [];
  const riseDurS = v0 / riseAccel; // time to apex
  let t = 0;
  let y = 0;
  // ascent
  for (; t / 1000 <= riseDurS; t += stepMs) {
    const s = t / 1000;
    y = v0 * s - 0.5 * riseAccel * s * s;
    out.push({ tMs: t, x: 0, y });
  }
  const apexY = (v0 * v0) / (2 * riseAccel);
  // descent: fall from apex with fallAccel until back near 0
  const apexT = t;
  for (; ; t += stepMs) {
    const s = (t - apexT) / 1000;
    const yy = apexY - 0.5 * fallAccel * s * s;
    if (yy < 0) break;
    out.push({ tMs: t, x: 0, y: yy });
  }
  return out;
}

function bracketedTrials(): BisectionTrial[] {
  return [
    { delayMs: 50, jumped: true },
    { delayMs: 90, jumped: true },
    { delayMs: 120, jumped: false },
    { delayMs: 200, jumped: false },
  ];
}

function unbracketedTrials(): BisectionTrial[] {
  // Nothing jumped → no positive window (signature ABSENT).
  return [
    { delayMs: 50, jumped: false },
    { delayMs: 120, jumped: false },
  ];
}

// ── interpreter: airDash ─────────────────────────────────────────────────────

test("airDash: a horizontal velocity spike past run speed reads PRESENT", () => {
  const r = interpretAirDash(runWithDash(9, 40), 9);
  assert.equal(r.present, true);
  assert.ok(r.peakSpeed && r.peakSpeed > 9 * AIR_DASH_SPIKE_FACTOR);
});

test("airDash: a steady run with no spike reads ABSENT", () => {
  const r = interpretAirDash(runTrack(9), 9);
  assert.equal(r.present, false);
});

test("airDash: a tiny over-speed wobble below the factor does NOT count as a dash", () => {
  // peak ~ 9*1.5 = 13.5 → ratio 1.5×, below the 1.8× factor → not a dash.
  const r = interpretAirDash(runWithDash(9, 13.5), 9);
  assert.equal(r.present, false);
});

test("airDash: an invalid/short trajectory is unprobeable (present=null)", () => {
  assert.equal(interpretAirDash([{ tMs: 0, x: 0, y: 0 }], 9).present, null);
});

test("airDash: the cruise reference is DERIVED from the trajectory — no supplied speed needed", () => {
  // Review #1: the dash reference must not be a self-reported scalar. With no supplied
  // run speed the cruise is derived from the trajectory (median of moving ticks).
  assert.equal(interpretAirDash(runWithDash(9, 40)).present, true);
  assert.equal(interpretAirDash(runTrack(9)).present, false);
});

test("airDash: a supplied run speed that disagrees with the derived cruise REFUSES (no self-report denominator)", () => {
  // Review #1: a biased harness inflating the reference to hide a real dash is refused.
  const r = interpretAirDash(runWithDash(9, 40), 30); // trajectory cruise is 9, not 30
  assert.equal(r.present, null);
  assert.match(r.reason ?? "", /disagrees|self-report/i);
});

test("airDash: a SINGLE-tick position glitch is NOT a dash (review #2 — sustained ≥2 ticks)", () => {
  // A dashless 9 u/s run with a one-tick teleport (respawn/screen-wrap): every sample
  // from index 5 on is shifted +2u, so exactly ONE interval spikes (~5x) and its
  // neighbors are normal. A real dash bursts over ≥2 ticks; this must read ABSENT.
  const glitch = runTrack(9).map((s, i) => (i >= 5 ? { ...s, x: s.x + 2 } : s));
  const r = interpretAirDash(glitch);
  assert.equal(r.present, false, `single-tick glitch must not read as a dash (peak=${r.peakSpeed})`);
});

// ── airDash CALIBRATION pinned to tiderunner's REAL numbers (F3 follow-up) ───────
// The threshold was recalibrated from 2.5× (the Celeste "dash ≫ run" assumption) to
// 1.8× because tiderunner's FIXED 18.75 u/s dash gives a ratio that depends on the
// profile's run speed. These tests pin the calibration to that real controller so it
// can't silently regress back to a Celeste assumption.

test("airDash: tiderunner's real 18.75 dash over a 9 u/s precision run (2.08×) reads PRESENT", () => {
  // The F3 bug: 18.75/9 = 2.08× was below the old 2.5× factor → false negative, so
  // precision.requires(airDash) failed spuriously. Must now read PRESENT.
  const r = interpretAirDash(runWithDash(9, 18.75), 9);
  assert.equal(r.present, true, `precision dash 18.75 over run 9 (2.08×) must be detected (peak=${r.peakSpeed}, cruise=${r.steadyRunSpeed})`);
  assert.ok(Math.abs((r.steadyRunSpeed ?? 0) - 9) < 1e-6, `cruise ≈ 9 (got ${r.steadyRunSpeed})`);
  assert.ok(Math.abs((r.peakSpeed ?? 0) - 18.75) < 1e-6, `peak ≈ 18.75 (got ${r.peakSpeed})`);
});

test("airDash: a plain 9 u/s precision run (no dash, with injection wobble) reads ABSENT", () => {
  // The reject side of failure mode (b): a dashless fast run whose sustained-2-tick
  // peak sits near cruise must NOT trip the gate. Inject a +20% over-speed wobble
  // sustained over the 2-tick window (9 → 10.8 = 1.2× cruise) — the upper edge of the
  // dead zone — and assert it stays below the 1.8× threshold.
  const r = interpretAirDash(runWithDash(9, 10.8), 9);
  assert.equal(r.present, false, `plain run with 1.2× wobble must not read as a dash (peak=${r.peakSpeed}, cruise=${r.steadyRunSpeed})`);
});

test("airDash: tiderunner's real 18.75 dash over a 7 u/s classic run (2.68×) reads PRESENT", () => {
  // Classic forbids airDash; the gate's correctness there depends on the dash still
  // being detected at the higher 2.68× ratio (it was, even at 2.5×).
  const r = interpretAirDash(runWithDash(7, 18.75), 7);
  assert.equal(r.present, true, `classic dash 18.75 over run 7 (2.68×) must be detected (peak=${r.peakSpeed}, cruise=${r.steadyRunSpeed})`);
});

test("airDash: tiderunner's real 18.75 dash over a 14 u/s momentum run (1.34×) reads ABSENT (documented limitation)", () => {
  // MOMENTUM EDGE: 18.75/14 = 1.34× (+34% over run) is below confident behavioral
  // detection — a threshold low enough to catch +34% would false-positive plain runs.
  // We DELIBERATELY read this ABSENT (inert today: momentum's manifest is empty). This
  // test pins the limitation so it's explicit, not an accident. See AIR_DASH_SPIKE_FACTOR.
  const r = interpretAirDash(runWithDash(14, 18.75), 14);
  assert.equal(r.present, false, `momentum dash 18.75 over run 14 (1.34×) is below detection → ABSENT by design (peak=${r.peakSpeed}, cruise=${r.steadyRunSpeed})`);
});

// ── interpreter: variableJump ────────────────────────────────────────────────

test("variableJump: a short-hold tap apex below the full-hold apex reads PRESENT", () => {
  const r = interpretVariableJump(jumpArc(1.1), jumpArc(3.0), 50, 300);
  assert.equal(r.present, true);
});

test("variableJump: same hold, ~equal apex (fixed-height controller, no cut) reads ABSENT", () => {
  const r = interpretVariableJump(jumpArc(3.0), jumpArc(3.05), 50, 300);
  assert.equal(r.present, false);
});

test("variableJump: a missing capture is unprobeable (present=null)", () => {
  const r = interpretVariableJump([{ tMs: 0, x: 0, y: 0 }], jumpArc(3.0), 50, 300);
  assert.equal(r.present, null);
});

test("variableJump: captures NOT differing by hold duration REFUSE (review #3 — can't impersonate a cut)", () => {
  // Two different apexes but the 'tap' was NOT held shorter → the height gap doesn't
  // prove an early-release cut (two unrelated fixed jumps would pass otherwise).
  assert.equal(interpretVariableJump(jumpArc(1.1), jumpArc(3.0), 300, 300).present, null); // equal holds
  assert.equal(interpretVariableJump(jumpArc(1.1), jumpArc(3.0), 300, 50).present, null); // tap held LONGER
  const r = interpretVariableJump(jumpArc(1.1), jumpArc(3.0), 0, 300); // missing tap duration
  assert.equal(r.present, null);
});

// ── interpreter: fallGravityAsymmetry ────────────────────────────────────────

test("fallGravityAsymmetry: an asymmetric arc (heavier fall) reads PRESENT", () => {
  const r = interpretFallGravityAsymmetry(asymmetricArc(30, 90));
  assert.equal(r.present, true);
  assert.ok(r.multiplier && r.multiplier > 1 + FALL_ASYMMETRY_MARGIN);
});

test("fallGravityAsymmetry: a symmetric arc reads ABSENT", () => {
  const r = interpretFallGravityAsymmetry(jumpArc(3.0));
  assert.equal(r.present, false);
});

test("fallGravityAsymmetry: a half arc (no descent) is unprobeable (present=null)", () => {
  // only the ascent half → deriveFallGravityMultiplier returns null
  const half = jumpArc(3.0).filter((s) => s.tMs <= 280);
  assert.equal(interpretFallGravityAsymmetry(half).present, null);
});

// ── interpreter: coyote / jumpBuffer (bisection window) ──────────────────────

test("window mechanism: a bracketed bisection (positive window) reads PRESENT", () => {
  const r = interpretWindowMechanism(bracketedTrials());
  assert.equal(r.present, true);
  assert.ok(r.windowSeconds && r.windowSeconds > 0);
});

test("window mechanism: nothing jumped (no window) reads ABSENT", () => {
  const r = interpretWindowMechanism(unbracketedTrials());
  assert.equal(r.present, false);
});

test("window mechanism: every trial jumped (boundary above range) is unprobeable", () => {
  // unbounded-above → cannot establish absence OR a window → refuse (null).
  const r = interpretWindowMechanism([
    { delayMs: 50, jumped: true },
    { delayMs: 200, jumped: true },
  ]);
  assert.equal(r.present, null);
});

test("window mechanism: no trials provided is unprobeable (present=null)", () => {
  assert.equal(interpretWindowMechanism([]).present, null);
});

// ── the gate: evaluateMechanisms ─────────────────────────────────────────────

function profileWith(
  requires: string[],
  forbids: string[],
): PlatformerFeelProfile {
  return {
    schemaVersion: "1",
    id: "test",
    title: "Test",
    summary: "test",
    metrics: { jumpApex: { target: 3, unit: "u", band: { percent: 12 } } },
    mechanisms: { requires, forbids },
  } as PlatformerFeelProfile;
}

const dashPresentEvidence: MechanismEvidence = {
  airDash: { runTrajectory: runWithDash(9, 40), steadyRunSpeed: 9 },
};
const dashAbsentEvidence: MechanismEvidence = {
  airDash: { runTrajectory: runTrack(9), steadyRunSpeed: 9 },
};

test("gate: requires PRESENT → pass", () => {
  const r = evaluateMechanisms(profileWith(["airDash"], []), dashPresentEvidence);
  assert.equal(r.status, "pass");
  assert.equal(r.checks[0].result, "present");
  assert.equal(r.checks[0].ok, true);
});

test("gate: requires ABSENT → fail (the mechanism is missing)", () => {
  const r = evaluateMechanisms(profileWith(["airDash"], []), dashAbsentEvidence);
  assert.equal(r.status, "fail");
  assert.equal(r.checks[0].result, "absent");
  assert.equal(r.checks[0].ok, false);
});

test("gate: forbids PRESENT → fail (the F1 hole — classic forbids airDash but a dash is live)", () => {
  const r = evaluateMechanisms(profileWith([], ["airDash"]), dashPresentEvidence);
  assert.equal(r.status, "fail");
  assert.equal(r.checks[0].result, "present");
  assert.equal(r.checks[0].ok, false);
});

test("gate: forbids ABSENT → pass", () => {
  const r = evaluateMechanisms(profileWith([], ["airDash"]), dashAbsentEvidence);
  assert.equal(r.status, "pass");
  assert.equal(r.checks[0].result, "absent");
  assert.equal(r.checks[0].ok, true);
});

test("gate: a manifest mechanism with NO evidence REFUSES (not skips) and cannot pass", () => {
  const r = evaluateMechanisms(profileWith(["airDash"], []), {});
  assert.equal(r.status, "refused");
  assert.equal(r.checks[0].result, "unprobed");
  assert.equal(r.checks[0].ok, false);
  // refusal is NOT a pass and NOT a silent skip — the check is present and not-ok.
  assert.equal(r.checks.length, 1);
});

test("gate: unprobeable evidence (provided but undrivable) REFUSES, never skips", () => {
  // airDash evidence present but the trajectory is too short to probe.
  const r = evaluateMechanisms(profileWith(["airDash"], []), {
    airDash: { runTrajectory: [{ tMs: 0, x: 0, y: 0 }], steadyRunSpeed: 9 },
  });
  assert.equal(r.status, "refused");
  assert.equal(r.checks[0].result, "unprobed");
});

test("gate: an empty mechanisms block (claims nothing) passes with no checks", () => {
  const r = evaluateMechanisms(profileWith([], []), {});
  assert.equal(r.status, "pass");
  assert.equal(r.checks.length, 0);
});

test("gate: a profile with NO mechanisms block is not_applicable (no checks)", () => {
  const noBlock = {
    schemaVersion: "1",
    id: "test",
    title: "Test",
    summary: "test",
    metrics: { jumpApex: { target: 3, unit: "u", band: { percent: 12 } } },
  } as PlatformerFeelProfile;
  const r = evaluateMechanisms(noBlock, {});
  assert.equal(r.status, "not_applicable");
  assert.equal(r.checks.length, 0);
});

test("gate: a fail (forbids present) outranks an unprobed requires in the rollup", () => {
  // forbids airDash (present → fail) AND requires variableJump (no evidence → refuse).
  const r = evaluateMechanisms(
    profileWith(["variableJump"], ["airDash"]),
    dashPresentEvidence,
  );
  // any fail → fail (a definitional violation gates over a refusal).
  assert.equal(r.status, "fail");
});

test("gate: multiple requires all present → pass; one absent → fail", () => {
  const ev: MechanismEvidence = {
    airDash: { runTrajectory: runWithDash(9, 40), steadyRunSpeed: 9 },
    variableJump: { tapTrajectory: jumpArc(1.1), holdTrajectory: jumpArc(3.0), tapHoldMs: 50, fullHoldMs: 300 },
  };
  assert.equal(
    evaluateMechanisms(profileWith(["airDash", "variableJump"], []), ev).status,
    "pass",
  );
  const evMissingVarJump: MechanismEvidence = {
    airDash: { runTrajectory: runWithDash(9, 40), steadyRunSpeed: 9 },
    variableJump: { tapTrajectory: jumpArc(3.0), holdTrajectory: jumpArc(3.05), tapHoldMs: 50, fullHoldMs: 300 },
  };
  assert.equal(
    evaluateMechanisms(profileWith(["airDash", "variableJump"], []), evMissingVarJump).status,
    "fail",
  );
});
