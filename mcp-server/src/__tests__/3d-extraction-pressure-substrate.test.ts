/**
 * Extraction-PRESSURE substrate (dogfood findings RCL-G03 + RCL-G04 + RCL-G05) — the three feel knobs
 * that make a raid tense, sitting alongside the win/loss + hold-channel proofs.
 *
 * Pure, synthetic-trace unit tests for the three calculators in `verification/feel-derive.ts`, mirroring
 * the cover/wave/hold-channel/extraction proof tests' style:
 *
 *   deriveThreatRampSlope     — the difficulty curve: the spawn RATE rises monotonically as run-time
 *                               advances (inter-spawn intervals strictly shrink) AND the grace window is
 *                               respected. Refuses flat / non-monotonic / grace-violated / too-few / degraded.
 *   deriveAutoAimAcquisition  — did the auto-aim lock the RIGHT enemy for the declared priority rule
 *                               (nearest / lowest-hp / highest-threat)? A WRONG lock is an honest MEASURED
 *                               MISS (correct: false), NOT a refusal; refusal is "could not decide".
 *   deriveSprintProfile       — the sprint speed MULTIPLIER, the boost DURATION, and the COOLDOWN lockout,
 *                               read from the boost WINDOWS in the planar-speed series. Refuses no-sprint /
 *                               no-base-speed / no-boost / no-second-boost / degraded.
 *
 * All three are dimension-agnostic (they count edges/levels/windows on sampled scalar series),
 * honest-or-refuse, MEASURE-ONLY, and re-derivable. LIVE Unity capture evidence is DEFERRED: a real
 * heat-ramp / auto-aim / sprint capture needs a built extraction-pressure scene (no committed
 * demo-bundles/* transcript yet, unlike the cover/wave substrates). The calculators plus these
 * synthetic-trace tests are the slice deliverable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveThreatRampSlope,
  deriveAutoAimAcquisition,
  deriveSprintProfile,
  type AimCandidate,
} from "../capabilities/verification/feel-derive.js";

type FieldSample = { tMs: number; value: number | boolean };
type FieldSeries = { id: string; samples: FieldSample[]; unresolved?: string; readError?: string };

const FRAME_MS = 16.67;

const counter = (id: string, vals: number[]): FieldSeries => ({
  id,
  samples: vals.map((v, i) => ({ tMs: i * FRAME_MS, value: v })),
});
const bools = (id: string, vals: boolean[]): FieldSeries => ({
  id,
  samples: vals.map((v, i) => ({ tMs: i * FRAME_MS, value: v })),
});

// ── deriveThreatRampSlope (RCL-G03 — heat ramp) ──────────────────────────────────────────

// Spawn counter incrementing at frames 5, 9, 12, 14, 15 → inter-spawn intervals [4,3,2,1] frames
// (strictly shrinking = rising rate). First spawn at frame 5 (~83ms) respects a sub-83ms grace.
const risingRamp = (): FieldSeries =>
  counter("SpawnCount", [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5]);

test("heat-ramp: (a) a rising spawn rate respecting grace → ok with a positive slope + monotone evidence", () => {
  const r = deriveThreatRampSlope(risingRamp(), 50);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.spawnCount, 5);
  assert.equal(r.ok && r.monotonic, true);
  assert.equal(r.ok && r.graceMs, 50);
  // intervals [4,3,2,1] frames, strictly decreasing.
  assert.deepEqual(
    r.ok ? r.intervalsMs.map((d) => Math.round(d / FRAME_MS)) : [],
    [4, 3, 2, 1],
  );
  // rates rise as intervals shrink, slope of rate-vs-time is positive.
  assert.ok(r.ok && r.slopePerSec > 0, "slope must be positive for a rising ramp");
  assert.ok(
    r.ok && r.ratesPerSec.every((v, i, a) => i === 0 || v > a[i - 1]),
    "rates strictly increasing",
  );
});

test("heat-ramp: defaults grace to 0 and still proves the rising ramp", () => {
  const r = deriveThreatRampSlope(risingRamp());
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.graceMs, 0);
});

test("heat-ramp: (b) a FLAT (constant-cadence) spawn rate → refuse (no difficulty ramp)", () => {
  // increments at frames 2,4,6,8 → intervals [2,2,2] (equal) = flat.
  const flat = counter("SpawnCount", [0, 0, 1, 1, 2, 2, 3, 3, 4]);
  const r = deriveThreatRampSlope(flat);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /flat/i);
});

test("heat-ramp: (c) a NON-MONOTONIC spawn rate → refuse (rate did not rise monotonically)", () => {
  // increments at frames 2,4,5,9 → intervals [2,1,4]; 4 ≥ 1 breaks the strict descent.
  const nonMono = counter("SpawnCount", [0, 0, 1, 1, 2, 3, 3, 3, 3, 4]);
  const r = deriveThreatRampSlope(nonMono);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /did not rise monotonically|non-monotonic/i);
});

test("heat-ramp: (d) a spawn before the grace window ends → refuse (grace violated)", () => {
  // first spawn is at frame 5 (~83.35ms); a 100ms grace window is violated.
  const r = deriveThreatRampSlope(risingRamp(), 100);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /grace violated|before the grace window/i);
});

test("heat-ramp: (e) a degraded series → refuse (F1 invariant)", () => {
  assert.equal(
    deriveThreatRampSlope({ id: "SpawnCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" }).ok,
    false,
  );
  assert.equal(
    deriveThreatRampSlope({ id: "SpawnCount", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" }).ok,
    false,
  );
});

test("heat-ramp: refuses when no spawns were observed (nothing ramped)", () => {
  const r = deriveThreatRampSlope(counter("SpawnCount", [0, 0, 0, 0]));
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no spawns/i);
});

test("heat-ramp: refuses fewer than 3 spawns (< 2 intervals — no rate change to fit)", () => {
  // two spawns only → one interval, cannot establish a RISING rate.
  const r = deriveThreatRampSlope(counter("SpawnCount", [0, 0, 1, 1, 2]));
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /need ≥3|establish a rising rate/i);
});

test("heat-ramp: refuses an invalid (negative / NaN) grace window", () => {
  assert.equal(deriveThreatRampSlope(risingRamp(), -1).ok, false);
  assert.equal(deriveThreatRampSlope(risingRamp(), Number.NaN).ok, false);
});

// ── deriveAutoAimAcquisition (RCL-G04 — auto-aim acquisition) ─────────────────────────────

const ORIGIN = { x: 0, y: 0, z: 0 };
const at = (id: string, z: number, hp: number, threat: number, alive = true): AimCandidate => ({
  id,
  position: { x: 0, y: 0, z },
  hp,
  alive,
  threat,
});
// A: dist 5, hp 50, threat 1   B: dist 3, hp 10, threat 5   C: dist 10, hp 30, threat 3
const trio = (): AimCandidate[] => [at("A", 5, 50, 1), at("B", 3, 10, 5), at("C", 10, 30, 3)];

test("auto-aim: (a) the 'nearest' rule picks the closest enemy → correct lock", () => {
  const r = deriveAutoAimAcquisition(trio(), "B", "nearest", ORIGIN);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.correct, true);
  assert.equal(r.ok && r.expectedTargetId, "B");
  assert.equal(r.ok && r.lockedTargetId, "B");
});

test("auto-aim: the 'lowest-hp' rule picks the weakest enemy → correct lock", () => {
  const r = deriveAutoAimAcquisition(trio(), "B", "lowest-hp");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.correct, true);
  assert.equal(r.ok && r.expectedTargetId, "B");
});

test("auto-aim: the 'highest-threat' rule picks the most dangerous enemy → correct lock", () => {
  const r = deriveAutoAimAcquisition(trio(), "B", "highest-threat");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.correct, true);
  assert.equal(r.ok && r.expectedTargetId, "B");
});

test("auto-aim: (b) a WRONG lock is an honest MEASURED MISS (correct: false), NOT a refusal", () => {
  // nearest is B, but the auto-aim locked C — surfaced as a measured miss, not hidden behind a refusal.
  const r = deriveAutoAimAcquisition(trio(), "C", "nearest", ORIGIN);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.correct, false);
  assert.equal(r.ok && r.expectedTargetId, "B");
  assert.equal(r.ok && r.lockedTargetId, "C");
});

test("auto-aim: a DEAD nearest enemy is excluded — the pick is the nearest ALIVE candidate", () => {
  // B is closest but dead → expected pick is A (next nearest alive).
  const cands: AimCandidate[] = [at("A", 5, 50, 1), at("B", 3, 10, 5, /*alive*/ false), at("C", 10, 30, 3)];
  const r = deriveAutoAimAcquisition(cands, "A", "nearest", ORIGIN);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.correct, true);
  assert.equal(r.ok && r.expectedTargetId, "A");
});

test("auto-aim: (c) an unresolved TIE for the best pick → refuse (ambiguous)", () => {
  // A and B are both at distance 5 → the nearest pick is tied.
  const cands: AimCandidate[] = [at("A", 5, 50, 1), at("B", 5, 10, 5), at("C", 10, 30, 3)];
  const r = deriveAutoAimAcquisition(cands, "A", "nearest", ORIGIN);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /tied|ambiguous|unresolved tie/i);
});

test("auto-aim: refuses when there are no candidates (nothing to acquire)", () => {
  const r = deriveAutoAimAcquisition([], "B", "nearest", ORIGIN);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no candidate/i);
});

test("auto-aim: refuses when no candidate is alive (no valid target exists)", () => {
  const cands: AimCandidate[] = [at("A", 5, 50, 1, false), at("B", 3, 10, 5, false)];
  const r = deriveAutoAimAcquisition(cands, "B", "nearest", ORIGIN);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no living candidate|no valid auto-aim target/i);
});

test("auto-aim: (d) refuses when the auto-aim never locked a target (no lock)", () => {
  assert.equal(deriveAutoAimAcquisition(trio(), undefined, "nearest", ORIGIN).ok, false);
  assert.equal(deriveAutoAimAcquisition(trio(), "", "lowest-hp").ok, false);
});

test("auto-aim: the 'nearest' rule refuses when no/invalid origin is given", () => {
  assert.equal(deriveAutoAimAcquisition(trio(), "B", "nearest").ok, false);
  const r = deriveAutoAimAcquisition(trio(), "B", "nearest", { x: Number.NaN, y: 0, z: 0 });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /origin/i);
});

test("auto-aim: the 'highest-threat' rule refuses a candidate missing a threat score", () => {
  const cands: AimCandidate[] = [
    { id: "A", position: { x: 0, y: 0, z: 5 }, hp: 50, alive: true }, // no threat
    at("B", 3, 10, 5),
  ];
  const r = deriveAutoAimAcquisition(cands, "B", "highest-threat");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /threat/i);
});

test("auto-aim: (e) refuses a degraded metric (NaN position for nearest / NaN hp for lowest-hp)", () => {
  const badPos: AimCandidate[] = [
    { id: "A", position: { x: Number.NaN, y: 0, z: 5 }, hp: 50, alive: true },
    at("B", 3, 10, 5),
  ];
  assert.equal(deriveAutoAimAcquisition(badPos, "B", "nearest", ORIGIN).ok, false);

  const badHp: AimCandidate[] = [
    { id: "A", position: { x: 0, y: 0, z: 5 }, hp: Number.NaN, alive: true },
    at("B", 3, 10, 5),
  ];
  assert.equal(deriveAutoAimAcquisition(badHp, "B", "lowest-hp").ok, false);
});

// ── deriveSprintProfile (RCL-G05 — sprint profile) ───────────────────────────────────────

// base 4 (frames 0-2), boost to 8 at frames 3-5, back to base, second boost 8 at frames 10-12.
// boost window 1 = [f3,f5] (span 2 frames), window 2 starts f10 → cooldown = f10-f5 = 5 frames.
const sprintBurst = (): { speed: FieldSeries; input: FieldSeries } => ({
  speed: counter("PlanarSpeed", [4, 4, 4, 8, 8, 8, 4, 4, 4, 4, 8, 8, 8, 4]),
  input: bools("SprintInput", [false, false, true, true, true, true, false, false, false, true, true, true, true, false]),
});

test("sprint: (a) a clean two-burst sprint → correct multiplier, duration, and cooldown", () => {
  const { speed, input } = sprintBurst();
  const r = deriveSprintProfile(speed, input);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.baseSpeed, 4);
  assert.equal(r.ok && r.sprintSpeed, 8);
  assert.equal(r.ok && r.multiplier, 2);
  assert.ok(r.ok && Math.abs(r.durationMs - 2 * FRAME_MS) < 1e-9, "first boost held 2 frames");
  assert.ok(r.ok && Math.abs(r.cooldownMs - 5 * FRAME_MS) < 1e-9, "cooldown = 5 frames to the next boost");
});

test("sprint: (b) refuses when the sprint input was never held (no sprint engaged)", () => {
  const speed = counter("PlanarSpeed", [4, 4, 8, 8, 4, 8, 8, 4]);
  const input = bools("SprintInput", [false, false, false, false, false, false, false, false]);
  const r = deriveSprintProfile(speed, input);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /never held|no sprint engaged/i);
});

test("sprint: refuses when there is no moving base speed before sprint onset", () => {
  // stationary (speed 0) until sprint onset at frame 2 → no base speed to divide by.
  const speed = counter("PlanarSpeed", [0, 0, 8, 8, 8, 0, 0, 0, 8, 8, 8, 0]);
  const input = bools("SprintInput", [false, false, true, true, true, false, false, false, true, true, true, false]);
  const r = deriveSprintProfile(speed, input);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no moving speed before sprint onset|no base speed/i);
});

test("sprint: refuses when the sprint produced no observable boost (speed never increased)", () => {
  // sprint input held but speed stays flat at base → no boost window, nothing to measure.
  const speed = counter("PlanarSpeed", [4, 4, 4, 4, 4, 4, 4, 4]);
  const input = bools("SprintInput", [false, false, true, true, true, true, false, false]);
  const r = deriveSprintProfile(speed, input);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /did not meaningfully increase speed|no boost observed/i);
});

test("sprint: refuses a single burst (no second sprint to time the cooldown lockout)", () => {
  const speed = counter("PlanarSpeed", [4, 4, 8, 8, 8, 4, 4]);
  const input = bools("SprintInput", [false, false, true, true, true, false, false]);
  const r = deriveSprintProfile(speed, input);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /SECOND sprint|cooldown/i);
});

test("sprint: (c) refuses a degraded series — F1 invariant on either signal", () => {
  const { speed, input } = sprintBurst();
  assert.equal(
    deriveSprintProfile({ id: "PlanarSpeed", samples: [{ tMs: 0, value: 4 }], readError: "threw" }, input).ok,
    false,
  );
  assert.equal(
    deriveSprintProfile(speed, { id: "SprintInput", samples: [{ tMs: 0, value: false }], unresolved: "no field" }).ok,
    false,
  );
});

test("sprint: refuses an empty planar-speed series", () => {
  const input = bools("SprintInput", [false, true, true, false]);
  assert.equal(deriveSprintProfile({ id: "PlanarSpeed", samples: [] }, input).ok, false);
});
