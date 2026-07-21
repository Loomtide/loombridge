/**
 * Telemetry schema (the genre-pack artifact) self-validation + the seed 3d-topdown-arena
 * pack schema loads clean. Guards the "schema of schemas" so a malformed pack telemetry.json
 * cannot silently degrade run validation into a no-op.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  validateTelemetrySchema,
  telemetrySchemaPathForGenre,
} from "../loombridge/telemetry/schema.js";

const GOOD = {
  schemaVersion: "1",
  id: "test.telemetry.v1",
  honestyRules: [{ id: "r1", rule: "a rule" }],
  runSummary: {
    requiredFreshnessFields: ["runId", "producedAt"],
    fields: [
      { name: "runId", type: "string", required: true, binding: "events-file" },
      { name: "producedAt", type: "string", required: true },
      { name: "score", type: "number", aggregate: "mean", segmentable: false },
    ],
  },
  eventStream: {
    timestampField: "t",
    events: [{ type: "sample", payload: [{ name: "t", type: "number", required: true }] }],
  },
};

test("validateTelemetrySchema: accepts a well-formed schema", () => {
  const r = validateTelemetrySchema(GOOD);
  assert.equal(r.ok, true, r.refusals.join("; "));
  assert.ok(r.schema);
  assert.equal(r.schema!.runSummary.fields.length, 3);
});

test("validateTelemetrySchema: refuses a non-object root", () => {
  const r = validateTelemetrySchema(null);
  assert.equal(r.ok, false);
  assert.match(r.refusals[0]!, /root is not an object/);
});

test("validateTelemetrySchema: refuses an invalid field type", () => {
  const bad = structuredClone(GOOD);
  (bad.runSummary.fields[2] as { type: string }).type = "float";
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /invalid type/.test(x)));
});

test("validateTelemetrySchema: refuses a freshness field not declared as a summary field", () => {
  const bad = structuredClone(GOOD);
  bad.runSummary.requiredFreshnessFields = ["runId", "producedAt", "ghost"];
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /freshness field `ghost` is not a declared/.test(x)));
});

test("validateTelemetrySchema: refuses a duplicate event type", () => {
  const bad = structuredClone(GOOD);
  bad.eventStream.events.push({ type: "sample", payload: [] });
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /declared more than once/.test(x)));
});

test("validateTelemetrySchema: refuses an unknown field format (D4)", () => {
  const bad = structuredClone(GOOD);
  (bad.runSummary.fields[1] as { format?: string }).format = "rfc-2822";
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /invalid format `rfc-2822`/.test(x)));
});

test("validateTelemetrySchema: accepts iso-8601 format and defaults monotonicity to global", () => {
  const good = structuredClone(GOOD);
  (good.runSummary.fields[1] as { format?: string }).format = "iso-8601";
  const r = validateTelemetrySchema(good);
  assert.equal(r.ok, true, r.refusals.join("; "));
  assert.equal(r.schema!.runSummary.fields[1]!.format, "iso-8601");
  assert.equal(r.schema!.eventStream.monotonicity, "global");
});

test("validateTelemetrySchema: refuses an invalid monotonicity value (D10)", () => {
  const bad = structuredClone(GOOD) as Record<string, unknown>;
  (bad.eventStream as Record<string, unknown>).monotonicity = "per-run";
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`eventStream.monotonicity` must be "global" or "per-entity"/.test(x)));
});

test("validateTelemetrySchema: per-entity monotonicity REQUIRES entityField (D10)", () => {
  const bad = structuredClone(GOOD) as Record<string, unknown>;
  (bad.eventStream as Record<string, unknown>).monotonicity = "per-entity";
  const r = validateTelemetrySchema(bad);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /per-entity monotonicity requires a non-empty `eventStream.entityField`/.test(x)));

  const good = structuredClone(GOOD) as Record<string, unknown>;
  (good.eventStream as Record<string, unknown>).monotonicity = "per-entity";
  (good.eventStream as Record<string, unknown>).entityField = "enemyId";
  const r2 = validateTelemetrySchema(good);
  assert.equal(r2.ok, true, r2.refusals.join("; "));
  assert.equal(r2.schema!.eventStream.monotonicity, "per-entity");
  assert.equal(r2.schema!.eventStream.entityField, "enemyId");
});

test("validateTelemetrySchema: refusals are deterministically sorted", () => {
  const bad = structuredClone(GOOD);
  (bad as { id?: string }).id = "";
  (bad as { schemaVersion?: string }).schemaVersion = "";
  const r1 = validateTelemetrySchema(bad);
  const r2 = validateTelemetrySchema(bad);
  assert.deepEqual(r1.refusals, r2.refusals);
  assert.deepEqual(r1.refusals, [...r1.refusals].sort());
});

test("seed 3d-topdown-arena telemetry.json is a valid schema artifact", async () => {
  const p = telemetrySchemaPathForGenre("3d-topdown-arena");
  assert.ok(p, "resolver returned a path");
  const raw = JSON.parse(await fs.readFile(p!, "utf8"));
  const r = validateTelemetrySchema(raw);
  assert.equal(r.ok, true, r.refusals.join("; "));
  // GROUND-TRUTHED event set: the real dogfood-project TelemetryLogger types (T3-T),
  // not the pre-real `*_position_sample`/`loot_pickup` model. Every listed type must
  // be present in the closed set.
  const evTypes = r.schema!.eventStream.events.map((e) => e.type);
  for (const t of [
    "player_pos", "enemy_pos", "shot_fired", "shot_hit", "damage",
    "enemy_spawn", "enemy_death", "loot_start", "loot_complete", "loot_cancel",
    "pressure_start", "death", "extract_hold_start", "extract_hold_cancel",
    "extract_complete", "bot_state", "bot_target",
  ]) {
    assert.ok(evTypes.includes(t), `missing event ${t}`);
  }
  // The pre-real modeled type names are GONE (ground-truthed away).
  for (const gone of ["player_position_sample", "enemy_position_sample", "loot_pickup", "nearest_enemy_distance_sample"]) {
    assert.ok(!evTypes.includes(gone), `stale modeled event ${gone} should be removed`);
  }
  // Merged-payload reality: `player_pos` folds the greed-loop state inline.
  const playerPos = r.schema!.eventStream.events.find((e) => e.type === "player_pos")!;
  const playerFields = playerPos.payload.map((p) => p.name);
  for (const merged of ["stash", "heat", "holdKind", "holdProgress", "nearestEnemyDist"]) {
    assert.ok(playerFields.includes(merged), `player_pos missing merged field ${merged}`);
  }
  // Top-down XZ-planar: the real emitter has NO y height field.
  assert.ok(!playerFields.includes("y"), "player_pos must not carry a y field (XZ-planar)");
  // Naming-honesty: no summary field, event type, or payload field is named "seen".
  const names = [
    ...r.schema!.runSummary.fields.map((f) => f.name),
    ...evTypes,
    ...r.schema!.eventStream.events.flatMap((e) => e.payload.map((p) => p.name)),
  ];
  assert.ok(!names.some((n) => /seen/i.test(n)), "no field/event named 'seen'");
  // Proximity fields are honestly named for DISTANCE, never visibility.
  assert.ok(playerFields.includes("nearestEnemyDist"), "proximity field honestly named");
  // Banked vs lost stay distinct required SUMMARY fields (prescriptive contract, unchanged).
  const fieldNames = r.schema!.runSummary.fields.map((f) => f.name);
  assert.ok(fieldNames.includes("bankedValue") && fieldNames.includes("lostValue"));
  // Freshness discipline: producedAt is format-validated ISO-8601 (D4).
  const producedAt = r.schema!.runSummary.fields.find((f) => f.name === "producedAt")!;
  assert.equal(producedAt.format, "iso-8601");
  // Ground-truthed ordering: the real stream is ONE globally time-sorted sequence
  // (verified across all 259 captures), so `global` — not the pre-real per-entity/enemyId lanes.
  assert.equal(r.schema!.eventStream.monotonicity, "global");
  assert.equal(r.schema!.eventStream.timestampUnit, "s");
  assert.equal(r.schema!.eventStream.entityField, undefined);
});

test("telemetrySchemaPathForGenre: refuses a path-escaping genre id", () => {
  assert.equal(telemetrySchemaPathForGenre("../evil"), null);
  assert.equal(telemetrySchemaPathForGenre("a/b"), null);
});
