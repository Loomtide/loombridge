/**
 * `validateTelemetryRun` refusal classes — one test per dogfood honesty bug the gate
 * exists to catch: freshness (stale + unparseable producedAt), run-id binding
 * (cross-run mix-up AND a missing per-event binding field — D2: a stale events file
 * renamed onto a fresh summary's stem must not pair cleanly), unknown event type,
 * missing/typed summary + payload fields, and non-monotonic timestamps (global AND
 * per-entity lanes — D10). Plus the clean-pass case.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateTelemetrySchema, type TelemetrySchema } from "../capabilities/telemetry/schema.js";
import { validateTelemetryRun } from "../capabilities/telemetry/validate.js";

const SCHEMA: TelemetrySchema = validateTelemetrySchema({
  schemaVersion: "1",
  id: "t.v1",
  runSummary: {
    requiredFreshnessFields: ["runId", "producedAt"],
    fields: [
      { name: "runId", type: "string", required: true, binding: "events-file" },
      { name: "producedAt", type: "string", required: true, format: "iso-8601" },
      { name: "persona", type: "string", required: true, segmentable: true },
      { name: "bankedValue", type: "number", required: true, aggregate: "mean" },
    ],
  },
  eventStream: {
    timestampField: "t",
    events: [
      { type: "loot_pickup", payload: [{ name: "t", type: "number", required: true }, { name: "tier", type: "string", required: true }] },
    ],
  },
}).schema!;

/** A per-entity-monotonicity schema (D10): enemy samples interleave across lanes. */
const PER_ENTITY_SCHEMA: TelemetrySchema = validateTelemetrySchema({
  schemaVersion: "1",
  id: "t.per-entity.v1",
  runSummary: {
    requiredFreshnessFields: ["runId", "producedAt"],
    fields: [
      { name: "runId", type: "string", required: true, binding: "events-file" },
      { name: "producedAt", type: "string", required: true, format: "iso-8601" },
    ],
  },
  eventStream: {
    timestampField: "t",
    monotonicity: "per-entity",
    entityField: "enemyId",
    events: [
      { type: "enemy_position_sample", payload: [{ name: "t", type: "number", required: true }, { name: "enemyId", type: "string", required: true }] },
      { type: "loot_pickup", payload: [{ name: "t", type: "number", required: true }] },
    ],
  },
}).schema!;

const GOOD_SUMMARY = { runId: "run-1", producedAt: "2026-07-04T00:00:00Z", persona: "greedy", bankedValue: 100 };
const GOOD_EVENTS = [
  { type: "loot_pickup", t: 10, tier: "rare", runId: "run-1" },
  { type: "loot_pickup", t: 20, tier: "common", runId: "run-1" },
];

test("clean run passes", () => {
  const r = validateTelemetryRun(GOOD_SUMMARY, GOOD_EVENTS, SCHEMA);
  assert.equal(r.ok, true, r.refusals.join("; "));
});

test("freshness: missing producedAt is REFUSED, not skipped", () => {
  const { producedAt, ...noProduced } = GOOD_SUMMARY;
  void producedAt;
  const r = validateTelemetryRun(noProduced, GOOD_EVENTS, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /freshness: summary field `producedAt` is absent/.test(x)));
});

test("freshness: empty-string runId is refused", () => {
  const r = validateTelemetryRun({ ...GOOD_SUMMARY, runId: "" }, [], SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /freshness: summary field `runId` is absent\/empty/.test(x)));
});

test("freshness: unparseable ISO-8601 producedAt is refused (D4)", () => {
  const r = validateTelemetryRun({ ...GOOD_SUMMARY, producedAt: "not-a-timestamp" }, GOOD_EVENTS, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`producedAt` is not parseable ISO-8601/.test(x)));
});

test("binding: an event runId that disagrees with the summary is refused (cross-run)", () => {
  const events = [{ type: "loot_pickup", t: 5, tier: "rare", runId: "OTHER-RUN" }];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /cross-run\/stale binding/.test(x)));
});

test("binding: an event MISSING the binding field is refused, not skipped (D2 — stale file renamed onto a fresh stem)", () => {
  const events = [
    { type: "loot_pickup", t: 5, tier: "rare" }, // no runId at all
    { type: "loot_pickup", t: 9, tier: "rare" }, // no runId at all
    { type: "loot_pickup", t: 12, tier: "common", runId: "run-1" },
  ];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  // One collapsed refusal, counting the offenders and naming the FIRST offending line.
  assert.ok(
    r.refusals.some((x) => /binding field `runId` is MISSING on 2 event\(s\) \(first at events\[0\]\)/.test(x)),
    r.refusals.join("; "),
  );
});

test("unknown event type is refused (closed set)", () => {
  const events = [{ type: "mystery_event", t: 1 }];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /unknown event type `mystery_event`/.test(x)));
});

test("missing required summary field is refused", () => {
  const { bankedValue, ...noBank } = GOOD_SUMMARY;
  void bankedValue;
  const r = validateTelemetryRun(noBank, GOOD_EVENTS, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /required field `bankedValue` is absent/.test(x)));
});

test("summary type mismatch is refused", () => {
  const r = validateTelemetryRun({ ...GOOD_SUMMARY, bankedValue: "lots" }, GOOD_EVENTS, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /field `bankedValue` expected number, got "lots"/.test(x)));
});

test("payload type mismatch is refused", () => {
  const events = [{ type: "loot_pickup", t: 5, tier: 99, runId: "run-1" }];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /payload `tier` expected string, got 99/.test(x)));
});

test("missing required payload field is refused", () => {
  const events = [{ type: "loot_pickup", t: 5, runId: "run-1" }];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /required payload field `tier` is absent/.test(x)));
});

test("non-monotonic timestamps are refused (global)", () => {
  const events = [
    { type: "loot_pickup", t: 30, tier: "rare", runId: "run-1" },
    { type: "loot_pickup", t: 10, tier: "common", runId: "run-1" },
  ];
  const r = validateTelemetryRun(GOOD_SUMMARY, events, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /non-monotonic `t`.*time-sorted, monotonicity: global/.test(x)));
});

test("per-entity monotonicity: interleaved entities that regress ACROSS lanes pass (D10 — the realistic multi-enemy emitter)", () => {
  const summary = { runId: "run-1", producedAt: "2026-07-04T00:00:00Z" };
  const events = [
    { type: "enemy_position_sample", t: 100, enemyId: "e1", runId: "run-1" },
    { type: "enemy_position_sample", t: 90, enemyId: "e2", runId: "run-1" }, // < e1's 100, but a different lane
    { type: "loot_pickup", t: 95, runId: "run-1" }, // common (no-entity) lane starts at 95
    { type: "enemy_position_sample", t: 110, enemyId: "e1", runId: "run-1" },
    { type: "enemy_position_sample", t: 92, enemyId: "e2", runId: "run-1" },
    { type: "loot_pickup", t: 120, runId: "run-1" },
  ];
  const r = validateTelemetryRun(summary, events, PER_ENTITY_SCHEMA);
  assert.equal(r.ok, true, r.refusals.join("; "));
});

test("per-entity monotonicity: a regression WITHIN one entity lane is refused", () => {
  const summary = { runId: "run-1", producedAt: "2026-07-04T00:00:00Z" };
  const events = [
    { type: "enemy_position_sample", t: 100, enemyId: "e1", runId: "run-1" },
    { type: "enemy_position_sample", t: 80, enemyId: "e1", runId: "run-1" }, // same lane, backwards
  ];
  const r = validateTelemetryRun(summary, events, PER_ENTITY_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /non-monotonic `t`.*in lane `e1`.*monotonicity: per-entity/.test(x) || /in lane `e1`/.test(x)), r.refusals.join("; "));
});

test("per-entity monotonicity: the shared no-entity lane is itself checked", () => {
  const summary = { runId: "run-1", producedAt: "2026-07-04T00:00:00Z" };
  const events = [
    { type: "loot_pickup", t: 100, runId: "run-1" },
    { type: "loot_pickup", t: 50, runId: "run-1" }, // no-entity lane, backwards
  ];
  const r = validateTelemetryRun(summary, events, PER_ENTITY_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /in lane `\(no entity\)`/.test(x)), r.refusals.join("; "));
});

test("non-object summary / non-array events refuse cleanly", () => {
  assert.equal(validateTelemetryRun(42, GOOD_EVENTS, SCHEMA).ok, false);
  assert.equal(validateTelemetryRun(GOOD_SUMMARY, { not: "array" }, SCHEMA).ok, false);
});

test("refusals are deterministically sorted", () => {
  const r = validateTelemetryRun({ persona: 5 }, [{ type: "x" }], SCHEMA);
  assert.equal(r.ok, false);
  assert.deepEqual(r.refusals, [...r.refusals].sort());
});
