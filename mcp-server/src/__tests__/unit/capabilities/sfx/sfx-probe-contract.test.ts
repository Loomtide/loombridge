/**
 * SfxPlayer probe-snapshot contract validation. Refuse-shaped: every internal
 * inconsistency (stale/partial read) is a REFUSAL, never a tolerated read.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateSfxProbeSnapshot } from "../../../../capabilities/sfx/probe-contract.js";

test("a consistent snapshot with plays validates", () => {
  const r = validateSfxProbeSnapshot({
    playCount: 5,
    perCue: { fire: 3, hit: 2 },
    lastCueId: "hit",
    lastCueTimeMs: 1234.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.snapshot!.playCount, 5);
  assert.equal(r.snapshot!.lastCueId, "hit");
});

test("a zero-play snapshot with null last-cue fields validates", () => {
  const r = validateSfxProbeSnapshot({ playCount: 0, perCue: {}, lastCueId: null, lastCueTimeMs: null });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.snapshot!.lastCueId, null);
  assert.equal(r.snapshot!.lastCueTimeMs, null);
});

test("non-object snapshot is refused", () => {
  const r = validateSfxProbeSnapshot(42);
  assert.equal(r.ok, false);
  assert.match(r.refusals[0], /not an object/);
});

test("playCount != sum(perCue) is refused (partial/stale read)", () => {
  const r = validateSfxProbeSnapshot({ playCount: 9, perCue: { fire: 3, hit: 2 }, lastCueId: "hit", lastCueTimeMs: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /internally inconsistent/.test(x)));
});

test("a negative / non-integer perCue count is refused", () => {
  const neg = validateSfxProbeSnapshot({ playCount: 0, perCue: { fire: -1 }, lastCueId: null, lastCueTimeMs: null });
  assert.equal(neg.ok, false);
  assert.ok(neg.refusals.some((x) => /perCue.*non-negative integer/.test(x)));
});

test("plays but no lastCueId is refused", () => {
  const r = validateSfxProbeSnapshot({ playCount: 2, perCue: { fire: 2 }, lastCueId: "", lastCueTimeMs: 5 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /must name the last cue/.test(x)));
});

test("lastCueId not present in perCue with count>0 is refused", () => {
  const r = validateSfxProbeSnapshot({ playCount: 2, perCue: { fire: 2 }, lastCueId: "hit", lastCueTimeMs: 5 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /not present in perCue/.test(x)));
});

test("plays but non-finite lastCueTimeMs is refused", () => {
  const r = validateSfxProbeSnapshot({ playCount: 2, perCue: { fire: 2 }, lastCueId: "fire", lastCueTimeMs: null });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /lastCueTimeMs/.test(x)));
});

test("zero plays but a set lastCueId is refused (inconsistent)", () => {
  const r = validateSfxProbeSnapshot({ playCount: 0, perCue: {}, lastCueId: "fire", lastCueTimeMs: null });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /playCount === 0 but `lastCueId`/.test(x)));
});

test("a non-object lastPayload is refused", () => {
  const r = validateSfxProbeSnapshot({ playCount: 0, perCue: {}, lastCueId: null, lastCueTimeMs: null, lastPayload: 3 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /lastPayload/.test(x)));
});
