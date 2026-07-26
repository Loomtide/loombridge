/**
 * Hold-channel feel substrate (dogfood finding RCL-G01 — the defining extraction mechanic).
 *
 * Pure, synthetic-trace unit tests for the two hold-channel calculators in
 * `verification/feel-derive.ts`, mirroring the cover/wave proof tests' style:
 *
 *   deriveHoldChannelDuration   — input-down edge → progress reaches the declared target
 *                                 while held continuously; the measured channel durationMs.
 *   deriveHoldInterruptOnDamage — does progress CANCEL/RESET after a damage edge while the
 *                                 channel is active (interruptible)?
 *
 * Both are dimension-agnostic (they count edges/levels on sampled scalar `fieldTimeline`
 * series), honest-or-refuse, and re-derivable. LIVE Unity capture evidence is DEFERRED:
 * a real hold-to-extract capture needs a built extraction scene (no committed
 * demo-bundles/* transcript yet, unlike the cover/wave substrates). The calculator plus
 * these synthetic-trace tests are the slice deliverable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveHoldChannelDuration,
  deriveHoldInterruptOnDamage,
  type HoldChannelSeries,
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

// A clean hold-to-complete channel: input pressed at frame 1 and held, progress ramps 0→1.0
// monotonically, reaching the 1.0 target at frame 5. Duration = (5 - 1) frames.
const channelOk = (): HoldChannelSeries => ({
  inputHeld: bools("HoldInputHeld", [false, true, true, true, true, true]),
  progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.7, 0.9, 1.0]),
});

// ── deriveHoldChannelDuration ──────────────────────────────────────────────────────────

test("hold-channel: (a) a clean hold-to-complete trace yields the correct durationMs", () => {
  const r = deriveHoldChannelDuration(channelOk(), 1.0);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  // input-down at frame 1, target reached at frame 5 → 4 frames.
  assert.ok(Math.abs(r.latencyMs - 4 * FRAME_MS) < 1e-9, `${r.latencyMs}`);
});

test("hold-channel: works for a 0..N (non-normalized) progress counter with an N target", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, true, true]),
    progress: counter("ChannelProgress", [0, 90, 180, 270, 350]),
  };
  const r = deriveHoldChannelDuration(ch, 350);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(Math.abs(r.latencyMs - 3 * FRAME_MS) < 1e-9);
});

test("hold-channel: (b) a hold RELEASED EARLY (never reaches target) refuses, not a fabricated value", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, false, false]),
    progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.45, 0.45]), // stalls at 0.45, never hits 1.0
  };
  const r = deriveHoldChannelDuration(ch, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /never completed|released/i);
});

test("hold-channel: (b') progress that never rises refuses (no channel observed)", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, true]),
    progress: counter("ChannelProgress", [0, 0, 0, 0]),
  };
  assert.equal(deriveHoldChannelDuration(ch, 1.0).ok, false);
});

test("hold-channel: refuses when the input was never held (nothing channeled)", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, false, false, false, false, false]),
    progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.7, 0.9, 1.0]),
  };
  const r = deriveHoldChannelDuration(ch, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /never held/i);
});

test("hold-channel: refuses a release BEFORE completion (no sustained hold)", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, false, true, true]), // released at frame 3
    progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.7, 0.9, 1.0]), // but progress still reaches 1.0
  };
  const r = deriveHoldChannelDuration(ch, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /released before completion|sustained hold/i);
});

test("hold-channel: refuses a mid-channel DROP (non-monotonic reset before completing)", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, true, true, true]),
    progress: counter("ChannelProgress", [0, 0.4, 0.6, 0.2, 0.7, 1.0]), // dips at frame 3
  };
  const r = deriveHoldChannelDuration(ch, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /non-monotonic|dropped/i);
});

test("hold-channel: refuses when progress is already at/above target at input-down", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true]),
    progress: counter("ChannelProgress", [1.0, 1.0, 1.0]),
  };
  const r = deriveHoldChannelDuration(ch, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /already at\/above the target/i);
});

test("hold-channel: refuses an invalid (non-positive) completion target", () => {
  assert.equal(deriveHoldChannelDuration(channelOk(), 0).ok, false);
  assert.equal(deriveHoldChannelDuration(channelOk(), Number.NaN).ok, false);
});

test("hold-channel: (e) refuses a degraded series — F1 invariant on either signal", () => {
  const degradedInput = channelOk();
  degradedInput.inputHeld = { id: "HoldInputHeld", samples: [{ tMs: 0, value: false }], readError: "threw" };
  assert.equal(deriveHoldChannelDuration(degradedInput, 1.0).ok, false);

  const degradedProgress = channelOk();
  degradedProgress.progress = { id: "ChannelProgress", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" };
  assert.equal(deriveHoldChannelDuration(degradedProgress, 1.0).ok, false);
});

test("hold-channel: (e') refuses an empty progress series", () => {
  const ch: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true]),
    progress: { id: "ChannelProgress", samples: [] },
  };
  assert.equal(deriveHoldChannelDuration(ch, 1.0).ok, false);
});

// ── deriveHoldInterruptOnDamage ────────────────────────────────────────────────────────

test("hold-channel: (c) progress rises then a damage edge RESETS it → interrupted: true", () => {
  // progress ramps 0→0.6 over frames 0-3, damage fires at frame 3, progress collapses to 0 after.
  const progress = counter("ChannelProgress", [0, 0.2, 0.4, 0.6, 0, 0]);
  const damage = counter("DamageTakenCount", [0, 0, 0, 1, 1, 1]); // edge at frame 3
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.interrupted, true);
  assert.ok(r.ok && r.progressBeforeDamage === 0.6 && r.progressAfterDamage === 0);
});

test("hold-channel: damage modeled as a bool false→true edge also resets → interrupted: true", () => {
  const progress = counter("ChannelProgress", [0, 0.3, 0.5, 0.5, 0]);
  const damage = bools("TookDamage", [false, false, false, true, true]); // edge at frame 3
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.interrupted, true);
});

test("hold-channel: (d) damage AFTER completion does NOT reset → interrupted: false", () => {
  // progress reaches and HOLDS at 1.0 (banked); a later damage edge does not drop it.
  const progress = counter("ChannelProgress", [0, 0.5, 1.0, 1.0, 1.0, 1.0]);
  const damage = counter("DamageTakenCount", [0, 0, 0, 0, 1, 1]); // edge at frame 4, after completion
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.interrupted, false);
  assert.ok(r.ok && r.progressBeforeDamage === 1.0 && r.progressAfterDamage === 1.0);
});

test("hold-channel: refuses when no damage event fired (interruptibility untested)", () => {
  const progress = counter("ChannelProgress", [0, 0.2, 0.4, 0.6]);
  const damage = counter("DamageTakenCount", [0, 0, 0, 0]);
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no damage event/i);
});

test("hold-channel: refuses when the channel was not active before the damage edge", () => {
  // damage fires at frame 1, but progress only starts rising at frame 3 → nothing to interrupt.
  const progress = counter("ChannelProgress", [0, 0, 0, 0.3, 0.6]);
  const damage = counter("DamageTakenCount", [0, 1, 1, 1, 1]);
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no active channel/i);
});

test("hold-channel: (e) interrupt proof refuses a degraded series — F1 invariant", () => {
  const progress = counter("ChannelProgress", [0, 0.3, 0.6, 0]);
  const badDamage = { id: "DamageTakenCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" };
  assert.equal(deriveHoldInterruptOnDamage(progress, badDamage).ok, false);

  const badProgress = { id: "ChannelProgress", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" };
  const damage = counter("DamageTakenCount", [0, 0, 1, 1]);
  assert.equal(deriveHoldInterruptOnDamage(badProgress, damage).ok, false);
});

test("hold-channel: (e') interrupt proof refuses an empty progress series", () => {
  const damage = counter("DamageTakenCount", [0, 1, 1]);
  assert.equal(deriveHoldInterruptOnDamage({ id: "ChannelProgress", samples: [] }, damage).ok, false);
});

// ── adversarial value-fabrication regressions (review of commit a12c2ab) ─────────────────

test("hold-channel: [HIGH-1] chip damage then the channel COMPLETES + loot teardown is NOT an interrupt", () => {
  // The exact extraction case: damage lands mid-channel, progress KEEPS rising to 1.0 (the hold
  // finished), then the bar tears down to 0 as loot is banked. The teardown is post-completion and
  // must not be charged to the damage edge (the pre-fix global-min scan wrongly read interrupted:true).
  const progress = counter("ChannelProgress", [0, 0.4, 0.8, 1.0, 1.0, 0]);
  const damage = counter("DamageTakenCount", [0, 0, 1, 1, 1, 1]); // edge at frame 2 (progress 0.8, still filling)
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.interrupted, false);
  assert.equal(r.progressBeforeDamage, 0.8); // contemporaneous, not the later 1.0 peak
});

test("hold-channel: [HIGH-2] a stale already-ended channel (progress 0 at the damage edge) refuses", () => {
  // progress rose to 0.6 then fell back to 0 BEFORE the damage edge → nothing in flight to interrupt.
  // The pre-fix code used the global peak (0.6) as `before` and flagged interrupted:true.
  const progress = counter("ChannelProgress", [0, 0.6, 0, 0, 0]);
  const damage = counter("DamageTakenCount", [0, 0, 0, 1, 1]); // edge at frame 3 (progress already 0)
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no active channel/i);
});

test("hold-channel: [HIGH-3] a NUMERIC inputHeld released mid-channel refuses (0 !== false bypass)", () => {
  // inputHeld encoded as a numeric (0/1) and released at frame 3. The pre-fix `=== false` check is
  // bypassed (0 !== false), so the sustained-hold refusal was silently skipped and a duration faked.
  const numericReleased: HoldChannelSeries = {
    inputHeld: counter("HoldInputHeld", [0, 1, 1, 0, 1, 1]), // released at frame 3
    progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.7, 0.9, 1.0]),
  };
  const r = deriveHoldChannelDuration(numericReleased, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /released before completion|sustained hold/i);
  // The boolean-encoded SAME trace must refuse identically (encoding parity).
  const boolReleased: HoldChannelSeries = {
    inputHeld: bools("HoldInputHeld", [false, true, true, false, true, true]),
    progress: counter("ChannelProgress", [0, 0.2, 0.45, 0.7, 0.9, 1.0]),
  };
  assert.equal(deriveHoldChannelDuration(boolReleased, 1.0).ok, false);
});

test("hold-channel: [MED] a sub-percent jitter on a SURVIVING channel reads interrupted: false", () => {
  // progress wobbles 0.6 -> 0.59 right after damage then recovers and completes — a surviving channel,
  // not a reset. The bare strict `<` (pre-fix) flagged the 0.01 dip as interrupted:true.
  const progress = counter("ChannelProgress", [0, 0.4, 0.6, 0.59, 0.8, 1.0]);
  const damage = counter("DamageTakenCount", [0, 0, 1, 1, 1, 1]); // edge at frame 2 (progress 0.6)
  const r = deriveHoldInterruptOnDamage(progress, damage);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.interrupted, false);
});
