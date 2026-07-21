/**
 * Extraction win/loss + greed-loop substrate (dogfood findings RCL-G02 + RCL-G07 — the OTHER half
 * of the extraction-shooter core loop, the inverse of the wave/objective proof).
 *
 * Pure, synthetic-trace unit tests for the two extraction calculators in
 * `verification/feel-derive.ts`, mirroring the cover/wave/hold-channel proof tests' style:
 *
 *   deriveZoneObjectiveComplete — enter the extraction zone → dwell/hold reaches the declared
 *                                 target while inZone stays true → banked flips AT/AFTER completion.
 *                                 The causal WIN sequence; refuses an interrupted/non-causal extract.
 *   deriveStashLossOnDeath      — on the playerDead edge, does the carried stash drop to baseline
 *                                 (the lose-everything-on-death greed rule)?
 *
 * Both are dimension-agnostic (they count edges/levels on sampled scalar `fieldTimeline` series),
 * honest-or-refuse, and re-derivable. LIVE Unity capture evidence is DEFERRED: a real reach-zone →
 * dwell → bank (and a death-wipe) capture needs a built extraction scene (no committed
 * demo-bundles/* transcript yet, unlike the cover/wave substrates). The calculators plus these
 * synthetic-trace tests are the slice deliverable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveZoneObjectiveComplete,
  deriveStashLossOnDeath,
  type ZoneObjectiveSeries,
} from "../verification/feel-derive.js";

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

// ── deriveZoneObjectiveComplete (RCL-G02) ───────────────────────────────────────────────

// A clean extraction: enter the zone at frame 1 and stay, dwell ramps 0→1.0 reaching the 1.0
// target at frame 4, then banked flips true at frame 5 (after the dwell). dwell = (4 - 1) frames.
const extractOk = (): ZoneObjectiveSeries => ({
  inZone: bools("InZone", [false, true, true, true, true, true]),
  holdProgress: counter("ExtractProgress", [0, 0.25, 0.5, 0.8, 1.0, 1.0]),
  banked: bools("LootBanked", [false, false, false, false, false, true]),
});

test("extraction: (a) a clean enter→dwell→bank trace proves the win with the right edges", () => {
  const r = deriveZoneObjectiveComplete(extractOk(), 1.0);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(r.ok && Math.abs(r.enteredMs - 1 * FRAME_MS) < 1e-9, "entered at frame 1");
  assert.ok(r.ok && Math.abs(r.holdCompleteMs - 4 * FRAME_MS) < 1e-9, "complete at frame 4");
  assert.ok(r.ok && Math.abs(r.bankedMs - 5 * FRAME_MS) < 1e-9, "banked at frame 5");
  assert.ok(r.ok && Math.abs(r.dwellMs - 3 * FRAME_MS) < 1e-9, "dwell = 3 frames");
});

test("extraction: works for a 0..N dwell counter and a 0→N banked counter", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true, true, true]),
    holdProgress: counter("ExtractProgress", [0, 90, 180, 300, 300]),
    banked: counter("BankedValue", [0, 0, 0, 0, 1]),
  };
  const r = deriveZoneObjectiveComplete(zone, 300);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(r.ok && Math.abs(r.holdCompleteMs - 3 * FRAME_MS) < 1e-9);
  assert.ok(r.ok && Math.abs(r.dwellMs - 2 * FRAME_MS) < 1e-9);
});

test("extraction: (b) LEFT the zone before the dwell completed → refuse (interrupted extraction)", () => {
  const zone: ZoneObjectiveSeries = {
    // re-enters at frame 4, but the player left at frame 3 BEFORE progress reached 1.0 at frame 4.
    inZone: bools("InZone", [false, true, true, false, true, true]),
    holdProgress: counter("ExtractProgress", [0, 0.25, 0.5, 0.8, 1.0, 1.0]),
    banked: bools("LootBanked", [false, false, false, false, false, true]),
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /left the zone before the dwell completed|interrupted extraction/i);
});

test("extraction: (c) the loot was NEVER banked → refuse (extraction did not finish)", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true, true, true, true]),
    holdProgress: counter("ExtractProgress", [0, 0.25, 0.5, 0.8, 1.0, 1.0]),
    banked: bools("LootBanked", [false, false, false, false, false, false]), // never flips
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /never banked/i);
});

test("extraction: (d) banked rose BEFORE the dwell completed → refuse (non-causal)", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true, true, true]),
    holdProgress: counter("ExtractProgress", [0, 0.3, 0.6, 0.9, 1.0]), // completes at frame 4
    banked: bools("LootBanked", [false, false, true, true, true]), // banked at frame 2 (before complete)
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /banked.*before the dwell completed|non-causal/i);
});

test("extraction: refuses when the player never entered the zone (nothing extracted)", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, false, false, false, false, false]),
    holdProgress: counter("ExtractProgress", [0, 0.25, 0.5, 0.8, 1.0, 1.0]),
    banked: bools("LootBanked", [false, false, false, false, false, true]),
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /never entered/i);
});

test("extraction: refuses a dwell that never reaches the target (too short / interrupted)", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true, true, true]),
    holdProgress: counter("ExtractProgress", [0, 0.25, 0.5, 0.5, 0.5]), // stalls at 0.5
    banked: bools("LootBanked", [false, false, false, false, true]),
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /never completed|too short/i);
});

test("extraction: refuses when dwell progress is already at/above target at entry", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true]),
    holdProgress: counter("ExtractProgress", [1.0, 1.0, 1.0]),
    banked: bools("LootBanked", [false, false, true]),
  };
  const r = deriveZoneObjectiveComplete(zone, 1.0);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /already at\/above the target/i);
});

test("extraction: refuses an invalid (non-positive / NaN) completion target", () => {
  assert.equal(deriveZoneObjectiveComplete(extractOk(), 0).ok, false);
  assert.equal(deriveZoneObjectiveComplete(extractOk(), Number.NaN).ok, false);
});

test("extraction: (e) refuses a degraded series — F1 invariant on any signal", () => {
  const badInZone = extractOk();
  badInZone.inZone = { id: "InZone", samples: [{ tMs: 0, value: false }], readError: "threw" };
  assert.equal(deriveZoneObjectiveComplete(badInZone, 1.0).ok, false);

  const badProgress = extractOk();
  badProgress.holdProgress = { id: "ExtractProgress", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" };
  assert.equal(deriveZoneObjectiveComplete(badProgress, 1.0).ok, false);

  const badBanked = extractOk();
  badBanked.banked = { id: "LootBanked", samples: [{ tMs: 0, value: false }], readError: "threw" };
  assert.equal(deriveZoneObjectiveComplete(badBanked, 1.0).ok, false);
});

test("extraction: refuses an empty holdProgress series", () => {
  const zone: ZoneObjectiveSeries = {
    inZone: bools("InZone", [false, true, true]),
    holdProgress: { id: "ExtractProgress", samples: [] },
    banked: bools("LootBanked", [false, false, true]),
  };
  assert.equal(deriveZoneObjectiveComplete(zone, 1.0).ok, false);
});

// ── deriveStashLossOnDeath (RCL-G07) ────────────────────────────────────────────────────

test("extraction: (f) death WIPES the carried stash to 0 → lostOnDeath: true", () => {
  // stash rises 0→5 (loot picked up), death edge at frame 3 (stash still 5 that frame), stash drops
  // to 0 the next frame and stays 0 — the contemporaneous before is 5, the post-death trough is 0.
  const stash = counter("CarriedStash", [0, 3, 5, 5, 0, 0]);
  const death = bools("PlayerDead", [false, false, false, true, true, true]); // edge at frame 3
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.lostOnDeath, true);
  assert.ok(r.ok && r.stashBeforeDeath === 5 && r.stashAfterDeath === 0);
});

test("extraction: death modeled as a 0→1 counter also wipes the stash → lostOnDeath: true", () => {
  const stash = counter("CarriedStash", [0, 4, 4, 0, 0]);
  const death = counter("DeathCount", [0, 0, 1, 1, 1]); // edge at frame 2 (stash still 4)
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.lostOnDeath, true);
  assert.ok(r.ok && r.stashBeforeDeath === 4 && r.stashAfterDeath === 0);
});

test("extraction: (g) stash UNCHANGED across death (the BUG the rule forbids) → lostOnDeath: false", () => {
  // stash rose to 5 then the player died but kept it all — the lose-everything rule was NOT applied.
  const stash = counter("CarriedStash", [0, 3, 5, 5, 5, 5]);
  const death = bools("PlayerDead", [false, false, false, true, true, true]); // edge at frame 3
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.lostOnDeath, false);
  assert.ok(r.ok && r.stashBeforeDeath === 5 && r.stashAfterDeath === 5);
});

test("extraction: a PARTIAL drop that never reaches baseline is NOT a full wipe → lostOnDeath: false", () => {
  // stash 5 → drops only to 3 after death (e.g. an insured partial) — not the lose-everything rule.
  const stash = counter("CarriedStash", [0, 5, 5, 3, 3]);
  const death = bools("PlayerDead", [false, false, true, true, true]); // edge at frame 2 (stash 5)
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.lostOnDeath, false);
  assert.ok(r.ok && r.stashBeforeDeath === 5 && r.stashAfterDeath === 3);
});

test("extraction: (h) death with the stash ALREADY at baseline → refuse (honest, nothing to lose)", () => {
  // The player died carrying no loot — the lose-on-death rule was never exercised, so we refuse
  // rather than fabricate a meaningless lostOnDeath. Testable + honest, NOT a false green/false bug.
  const stash = counter("CarriedStash", [0, 0, 0, 0]);
  const death = bools("PlayerDead", [false, false, true, true]); // edge at frame 2, stash 0
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /baseline|no loot was carried|not exercised/i);
});

test("extraction: (i) a stash that emptied BEFORE death (stale) refuses — not charged to this death", () => {
  // stash rose to 5 then fell to 0 BEFORE the death edge → the contemporaneous value at death is 0,
  // so there was nothing in flight for this death to wipe (mirrors the hold-interrupt stale guard).
  const stash = counter("CarriedStash", [0, 5, 0, 0, 0]);
  const death = bools("PlayerDead", [false, false, false, true, true]); // edge at frame 3 (stash already 0)
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /baseline|no loot was carried/i);
});

test("extraction: (j) refuses when no death event fired (lose-on-death untested)", () => {
  const stash = counter("CarriedStash", [0, 3, 5, 5]);
  const death = bools("PlayerDead", [false, false, false, false]);
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no death event/i);
});

test("extraction: refuses when there is no stash sample after the death edge (cannot observe)", () => {
  // death only fires on the very last sample — there is no post-death stash to observe.
  const stash = counter("CarriedStash", [0, 3, 5]);
  const death = bools("PlayerDead", [false, false, true]); // edge at the final frame
  const r = deriveStashLossOnDeath(stash, death);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /no stash sample after the death edge/i);
});

test("extraction: (k) refuses a degraded series — F1 invariant on either signal", () => {
  const stash = counter("CarriedStash", [0, 5, 5, 0]);
  const badDeath = { id: "PlayerDead", samples: [{ tMs: 0, value: false }], readError: "threw" };
  assert.equal(deriveStashLossOnDeath(stash, badDeath).ok, false);

  const badStash = { id: "CarriedStash", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" };
  const death = bools("PlayerDead", [false, false, true, true]);
  assert.equal(deriveStashLossOnDeath(badStash, death).ok, false);
});

test("extraction: refuses an empty stash series", () => {
  const death = bools("PlayerDead", [false, true, true]);
  assert.equal(deriveStashLossOnDeath({ id: "CarriedStash", samples: [] }, death).ok, false);
});
