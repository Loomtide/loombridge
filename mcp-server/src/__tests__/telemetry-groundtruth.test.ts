/**
 * Ground-truth tests (T3-T): the 3d-topdown-arena telemetry SEED validated against REAL
 * the dogfood project's TelemetryLogger output. Fixtures are VERBATIM lines copied from the real
 * PlaytestData capture set (our own data) — see fixtures/extraction-telemetry/.
 *
 * What these lock in:
 *  - The ground-truthed event closed-set + merged `player_pos` payload + SECONDS `t`
 *    make real event STREAMS representable: a real contiguous slice, once its per-event
 *    run-binding is stamped (the one migration step), validates CLEAN.
 *  - Every one of the 17 real event types typechecks against the seed.
 *  - The honesty gates STAY: a real (un-migrated) events file — which carries no
 *    per-event run binding — is REFUSED for missing binding, and the real run SUMMARY
 *    shape (utc/eventsFile, not producedAt/runId) is REFUSED for missing freshness.
 *    Those refusals are the fresh-not-stale moat working, not a schema bug (the shape
 *    the game's emitter must migrate to is documented in EMITTER-MIGRATION.md).
 *
 * Fixtures are resolved via import.meta.url since tsc does not copy them into dist.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateTelemetrySchema,
  telemetrySchemaPathForGenre,
  type TelemetrySchema,
} from "../loombridge/telemetry/schema.js";
import { validateTelemetryRun } from "../loombridge/telemetry/validate.js";
import { aggregateSet } from "../loombridge/telemetry/report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FX = path.resolve(
  __dirname,
  "../../..",
  "mcp-server/src/__tests__/fixtures/extraction-telemetry",
);

/** Load + validate the shipped seed schema (fails loudly if the seed is malformed). */
async function loadSeedSchema(): Promise<TelemetrySchema> {
  const p = telemetrySchemaPathForGenre("3d-topdown-arena")!;
  const parsed = validateTelemetrySchema(JSON.parse(await fs.readFile(p, "utf8")));
  assert.equal(parsed.ok, true, parsed.refusals.join("; "));
  return parsed.schema!;
}

async function readJsonl(name: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(path.join(FX, name), "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A summary that SATISFIES the prescriptive contract (runId + iso-8601 producedAt +
 * required map/persona/outcome/bankedValue/lostValue) — used to isolate EVENT-stream
 * behaviour from summary refusals. `runId` matches the stamped per-event binding.
 */
const RUN_ID = "gr-run-20260701_101205";
const COMPLIANT_SUMMARY = {
  runId: RUN_ID,
  producedAt: "2026-07-01T10:13:01.669Z",
  map: "arena",
  persona: "balanced",
  outcome: "extracted",
  runDurationMs: 55600,
  bankedValue: 135,
  lostValue: 0,
};

/** Stamp the run-binding field the real emitter does not yet emit (the migration step). */
function withBinding(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.map((e) => ({ ...e, runId: RUN_ID }));
}

// ---------- event streams are REPRESENTABLE ----------

test("groundtruth: a real contiguous event slice validates CLEAN once run-binding is stamped", async () => {
  const schema = await loadSeedSchema();
  const slice = await readJsonl("extraction-real-events-slice.jsonl");
  assert.ok(slice.length >= 80, "slice fixture should be a real multi-event stream");
  const r = validateTelemetryRun(COMPLIANT_SUMMARY, withBinding(slice), schema);
  assert.equal(r.ok, true, r.refusals.join("\n"));
});

test("groundtruth: every one of the 17 real event types is in the closed set and typechecks", async () => {
  const schema = await loadSeedSchema();
  const onePerType = await readJsonl("extraction-real-events-onePerType.jsonl");
  const expected = [
    "player_pos", "enemy_pos", "shot_fired", "shot_hit", "damage", "enemy_spawn",
    "enemy_death", "loot_start", "loot_complete", "loot_cancel", "pressure_start",
    "death", "extract_hold_start", "extract_hold_cancel", "extract_complete",
    "bot_state", "bot_target",
  ];
  assert.deepEqual(onePerType.map((e) => e.type).sort(), [...expected].sort());
  // Each verbatim real line, validated as a single-event stream (no ordering to trip),
  // with binding stamped, must pass — proving its type + payload are representable.
  for (const ev of onePerType) {
    const r = validateTelemetryRun(COMPLIANT_SUMMARY, withBinding([ev]), schema);
    assert.equal(r.ok, true, `real ${String(ev.type)} did not validate: ${r.refusals.join("; ")}`);
  }
});

test("groundtruth: the merged player_pos payload (stash/heat/hold/proximity) typechecks", async () => {
  const schema = await loadSeedSchema();
  const onePerType = await readJsonl("extraction-real-events-onePerType.jsonl");
  const playerPos = onePerType.find((e) => e.type === "player_pos")!;
  // The real emitter folds greed-loop state into the SAME row.
  for (const k of ["stash", "heat", "holdKind", "holdProgress", "nearestEnemyDist"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(playerPos, k), `player_pos carries ${k}`);
  }
  assert.equal(typeof playerPos.holdKind, "string");
  assert.equal(typeof playerPos.stash, "number");
  // XZ-planar: no y.
  assert.ok(!Object.prototype.hasOwnProperty.call(playerPos, "y"), "player_pos has no y (XZ-planar)");
  const r = validateTelemetryRun(COMPLIANT_SUMMARY, withBinding([playerPos]), schema);
  assert.equal(r.ok, true, r.refusals.join("; "));
});

// ---------- unit + ordering ----------

test("groundtruth: t is SECONDS (fractional values) and a real slice is globally monotonic", async () => {
  const schema = await loadSeedSchema();
  const slice = await readJsonl("extraction-real-events-slice.jsonl");
  // Seconds, not ms: at least one timestamp is a non-integer second value.
  assert.ok(
    slice.some((e) => typeof e.t === "number" && !Number.isInteger(e.t)),
    "expected fractional-second timestamps",
  );
  // In-order real slice passes global monotonicity (already covered by the clean-parse
  // test, asserted here explicitly against a REORDERED copy that must REFUSE).
  const reordered = withBinding([...slice]);
  // Force a backwards step: move a late high-t event before an early one.
  const lastHiT = reordered[reordered.length - 1];
  const shuffled = [lastHiT, ...reordered.slice(0, -1)];
  const r = validateTelemetryRun(COMPLIANT_SUMMARY, shuffled, schema);
  assert.equal(r.ok, false);
  assert.ok(
    r.refusals.some((x) => /non-monotonic `t`.*monotonicity: global/.test(x)),
    `expected a global non-monotonic refusal, got: ${r.refusals.join("; ")}`,
  );
});

// ---------- honesty gates STAY (migration items, not schema weakenings) ----------

test("groundtruth: a real (un-migrated) events file is REFUSED for missing run-binding", async () => {
  const schema = await loadSeedSchema();
  const slice = await readJsonl("extraction-real-events-slice.jsonl");
  // Real events carry NO runId — validate them AS-IS (verbatim, no stamping).
  const r = validateTelemetryRun(COMPLIANT_SUMMARY, slice, schema);
  assert.equal(r.ok, false);
  // The ONLY event-stream failure is the run-binding gate: streams are representable
  // (no unknown-type, no payload-type refusals), they just aren't bound yet.
  assert.ok(
    r.refusals.some((x) => /binding field `runId` is MISSING on \d+ event\(s\)/.test(x)),
    `expected a binding-missing refusal, got: ${r.refusals.join("; ")}`,
  );
  assert.ok(!r.refusals.some((x) => /unknown event type/.test(x)), "no unknown-type refusal");
  assert.ok(!r.refusals.some((x) => /expected .*, got/.test(x)), "no payload-type refusal");
});

test("groundtruth: the real run SUMMARY shape (utc/eventsFile) is REFUSED for missing freshness", async () => {
  const schema = await loadSeedSchema();
  const realSummary = JSON.parse(
    await fs.readFile(path.join(FX, "extraction-real-summary.json"), "utf8"),
  ) as Record<string, unknown>;
  // Ground-truth: the real emitter already keeps banked vs lost DISTINCT (honesty rule
  // upstream-satisfied) — just under different names + no producedAt/runId binding.
  assert.ok(
    Object.prototype.hasOwnProperty.call(realSummary, "banked") &&
      Object.prototype.hasOwnProperty.call(realSummary, "lost"),
    "real summary keeps banked & lost distinct",
  );
  assert.ok(Object.prototype.hasOwnProperty.call(realSummary, "utc"), "real summary uses `utc`");
  assert.ok(!Object.prototype.hasOwnProperty.call(realSummary, "producedAt"), "real has no producedAt yet");
  const r = validateTelemetryRun(realSummary, [], schema);
  assert.equal(r.ok, false);
  // Freshness moat: producedAt AND the runId binding field are absent → refused (migration).
  assert.ok(
    r.refusals.some((x) => /freshness: summary field `producedAt` is absent/.test(x)),
    `expected producedAt freshness refusal, got: ${r.refusals.join("; ")}`,
  );
  assert.ok(
    r.refusals.some((x) => /freshness: summary field `runId` is absent/.test(x)),
    `expected runId freshness refusal, got: ${r.refusals.join("; ")}`,
  );
});

// ---------- seed ↔ report coupling (the tuning-report consumer) ----------

test("groundtruth: tuning-report lootTiers is produced from REAL loot_complete events through the SHIPPED seed", async () => {
  const schema = await loadSeedSchema();
  const slice = await readJsonl("extraction-real-events-slice.jsonl");
  const runs = [{ runId: RUN_ID, summary: COMPLIANT_SUMMARY as Record<string, unknown>, events: withBinding(slice) }];
  const agg = aggregateSet("runs", "/fixture", runs, 0, schema);
  // The headline greed-loop signal: the loot-tier breakdown must be NON-EMPTY, keyed by
  // the real tier vocabulary (low/mid/high), sourced from `loot_complete` (SECURED loot).
  // This binds the SHIPPED seed's event names to report.ts's aggregation — the coupling
  // that silently produced [] when the seed renamed loot_pickup away (review MED defect).
  assert.deepEqual(agg.lootTiers, [
    { tier: "high", count: 2 },
    { tier: "low", count: 1 },
    { tier: "mid", count: 1 },
  ]);
  // No double-count: the slice has FIVE loot_start (one later cancelled, one retried) but
  // only FOUR loot_complete — the tier totals must track SECURED pickups only.
  const lootStart = agg.events.find((e) => e.type === "loot_start")!;
  const lootComplete = agg.events.find((e) => e.type === "loot_complete")!;
  assert.equal(lootStart.count, 5);
  assert.equal(lootComplete.count, 4);
  assert.equal(agg.lootTiers.reduce((n, t) => n + t.count, 0), lootComplete.count);
});
