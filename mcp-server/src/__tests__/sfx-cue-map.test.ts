/**
 * Cue event-map schema (genre-pack artifact) self-validation + the seed 3d-topdown-arena
 * cue map. Mirrors telemetry-schema.test.ts: the schema-of-schemas is refuse-shaped, and
 * the on-disk seed must parse clean.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  validateCueMapSchema,
  cueMapPathForGenre,
  cueEventTelemetryWarnings,
  crossCheckGenreCueEvents,
  requiredCueIds,
  noRepeatCues,
} from "../capabilities/sfx/cue-map.js";
import { validateTelemetrySchema } from "../capabilities/telemetry/schema.js";

/** A minimal VALID cue map (one frequent cue with a compliant variant policy). */
function baseCueMap(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "test.cue-map",
    cues: [
      {
        id: "fire",
        event: "weapon.fire",
        required: true,
        frequency: "frequent",
        priority: "gameplay",
        mixerBus: "SFX",
        layerRoles: ["transient", "body"],
        spatial: { mode: "2d" },
        variantPolicy: { count: 3, noImmediateRepeat: true },
      },
    ],
  };
}

function firstRefusalMatching(raw: unknown, re: RegExp): void {
  const r = validateCueMapSchema(raw);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => re.test(x)), `expected a refusal matching ${re}, got: ${JSON.stringify(r.refusals)}`);
}

test("a minimal well-formed cue map validates", () => {
  const r = validateCueMapSchema(baseCueMap());
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.ok(r.schema);
  assert.equal(r.schema!.cues.length, 1);
});

test("root that is not an object is refused", () => {
  firstRefusalMatching("nope", /root is not an object/);
});

test("missing schemaVersion + id are refused", () => {
  const m = baseCueMap();
  delete m.schemaVersion;
  delete m.id;
  const r = validateCueMapSchema(m);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /schemaVersion/.test(x)));
  assert.ok(r.refusals.some((x) => /`id`/.test(x)));
});

test("empty cues array is refused", () => {
  const m = baseCueMap();
  m.cues = [];
  firstRefusalMatching(m, /`cues` must be a non-empty array/);
});

test("a duplicate cue id is refused", () => {
  const m = baseCueMap();
  (m.cues as unknown[]).push({ ...(m.cues as Record<string, unknown>[])[0] });
  firstRefusalMatching(m, /declared more than once/);
});

test("a cue with no event binding is refused", () => {
  const m = baseCueMap();
  delete (m.cues as Record<string, unknown>[])[0].event;
  firstRefusalMatching(m, /`event` must be a non-empty string/);
});

test("invalid frequency / priority / mixerBus enums are refused", () => {
  const c = baseCueMap();
  (c.cues as Record<string, unknown>[])[0].frequency = "sometimes";
  firstRefusalMatching(c, /`frequency` must be one of/);
  const p = baseCueMap();
  (p.cues as Record<string, unknown>[])[0].priority = "urgent";
  firstRefusalMatching(p, /`priority` must be one of/);
  const b = baseCueMap();
  (b.cues as Record<string, unknown>[])[0].mixerBus = "Bus9";
  firstRefusalMatching(b, /`mixerBus` must be one of/);
});

test("invalid + duplicate layer roles are refused", () => {
  const bad = baseCueMap();
  (bad.cues as Record<string, unknown>[])[0].layerRoles = ["transient", "wobble"];
  firstRefusalMatching(bad, /is not one of/);
  const dup = baseCueMap();
  (dup.cues as Record<string, unknown>[])[0].layerRoles = ["body", "body"];
  firstRefusalMatching(dup, /is duplicated/);
  const empty = baseCueMap();
  (empty.cues as Record<string, unknown>[])[0].layerRoles = [];
  firstRefusalMatching(empty, /`layerRoles` must be a non-empty array/);
});

test("invalid spatial mode + rolloff are refused", () => {
  const m = baseCueMap();
  (m.cues as Record<string, unknown>[])[0].spatial = { mode: "4d" };
  firstRefusalMatching(m, /`spatial.mode` must be one of/);
  const r = baseCueMap();
  (r.cues as Record<string, unknown>[])[0].spatial = { mode: "3d", rolloff: "quadratic" };
  firstRefusalMatching(r, /`spatial.rolloff` must be one of/);
});

test("a FREQUENT cue with no variantPolicy is refused (learning #2)", () => {
  const m = baseCueMap();
  delete (m.cues as Record<string, unknown>[])[0].variantPolicy;
  firstRefusalMatching(m, /frequency `frequent` requires a variantPolicy/);
});

test("a frequent cue's variantPolicy must have count>=2 and noImmediateRepeat", () => {
  const noRepeat = baseCueMap();
  (noRepeat.cues as Record<string, unknown>[])[0].variantPolicy = { count: 3, noImmediateRepeat: false };
  firstRefusalMatching(noRepeat, /count >= 2 and noImmediateRepeat:true/);
});

test("noImmediateRepeat:true with count 1 is refused (a single variant cannot avoid a repeat)", () => {
  // Use an occasional cue so the frequent-cue invariant does not fire first.
  const m = baseCueMap();
  const cue = (m.cues as Record<string, unknown>[])[0];
  cue.frequency = "occasional";
  cue.variantPolicy = { count: 1, noImmediateRepeat: true };
  firstRefusalMatching(m, /noImmediateRepeat requires count >= 2/);
});

test("a CRITICAL cue that is not required is refused", () => {
  const m = baseCueMap();
  const cue = (m.cues as Record<string, unknown>[])[0];
  cue.priority = "critical";
  cue.required = false;
  firstRefusalMatching(m, /priority `critical` requires `required: true`/);
});

test("payloadMapping validation: bad kind, empty buckets, tier-missing-value, threshold-missing-upTo, jitter min>max", () => {
  const badKind = baseCueMap();
  (badKind.cues as Record<string, unknown>[])[0].payloadMapping = { sourceField: "tier", kind: "curve", buckets: [{ variantTag: "x", value: "a" }] };
  firstRefusalMatching(badKind, /payloadMapping.kind must be one of/);

  const emptyBuckets = baseCueMap();
  (emptyBuckets.cues as Record<string, unknown>[])[0].payloadMapping = { sourceField: "tier", kind: "tier", buckets: [] };
  firstRefusalMatching(emptyBuckets, /payloadMapping.buckets must be a non-empty array/);

  const tierNoValue = baseCueMap();
  (tierNoValue.cues as Record<string, unknown>[])[0].payloadMapping = { sourceField: "tier", kind: "tier", buckets: [{ variantTag: "x" }] };
  firstRefusalMatching(tierNoValue, /requires a non-empty string `value`/);

  const thresholdNoUpTo = baseCueMap();
  (thresholdNoUpTo.cues as Record<string, unknown>[])[0].payloadMapping = { sourceField: "v", kind: "threshold", buckets: [{ variantTag: "x" }] };
  firstRefusalMatching(thresholdNoUpTo, /requires numeric `upTo`/);

  const badJitter = baseCueMap();
  (badJitter.cues as Record<string, unknown>[])[0].variantPolicy = { count: 3, noImmediateRepeat: true, pitchJitter: { min: 0.5, max: 0.1 } };
  firstRefusalMatching(badJitter, /pitchJitter.min .* > max/);
});

test("refusals are returned deterministically sorted", () => {
  const m = baseCueMap();
  delete m.schemaVersion;
  delete m.id;
  const r = validateCueMapSchema(m);
  assert.deepEqual(r.refusals, [...r.refusals].sort());
});

test("requiredCueIds + noRepeatCues helpers reflect the declared cues", () => {
  const m = baseCueMap();
  (m.cues as unknown[]).push({
    id: "danger",
    event: "danger.escalated",
    required: false,
    frequency: "occasional",
    priority: "cosmetic",
    mixerBus: "Music",
    layerRoles: ["sweetener"],
    spatial: { mode: "2d" },
  });
  const r = validateCueMapSchema(m);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.deepEqual(requiredCueIds(r.schema!), ["fire"]);
  assert.deepEqual(noRepeatCues(r.schema!).map((c) => c.id), ["fire"]);
});

test("seed 3d-topdown-arena cue-map.json is a valid cue-map artifact", async () => {
  const p = cueMapPathForGenre("3d-topdown-arena");
  assert.ok(p, "path resolves for a valid genre id");
  const raw = JSON.parse(await fs.readFile(p!, "utf8"));
  const r = validateCueMapSchema(raw);
  assert.equal(r.ok, true, `seed cue map must validate: ${JSON.stringify(r.refusals)}`);
  const req = requiredCueIds(r.schema!);
  // the required extraction-shooter taxonomy from the learnings doc
  for (const cue of [
    "fire",
    "hit",
    "hurt",
    "loot_open",
    "loot_reward",
    "extract_start",
    "extract_complete",
    "enemy_death",
    "player_death",
  ]) {
    assert.ok(req.includes(cue), `required cue \`${cue}\` present in seed`);
  }
  // optional cues are present but NOT required
  for (const opt of ["danger_escalation", "stash", "low_health", "zone_warning"]) {
    assert.ok(r.schema!.cues.some((c) => c.id === opt), `optional cue \`${opt}\` declared`);
    assert.ok(!req.includes(opt), `optional cue \`${opt}\` is not required`);
  }
});

test("cueMapPathForGenre refuses a path-escaping genre id", () => {
  assert.equal(cueMapPathForGenre("../evil"), null);
  assert.equal(cueMapPathForGenre("a/b"), null);
  assert.ok(cueMapPathForGenre("3d-topdown-arena"));
});

// ── D5: advisory cue-event ↔ telemetry cross-check ───────────────────────────

test("cueEventTelemetryWarnings: warns ONLY on cue events outside the telemetry closed set (advisory)", () => {
  const cue = validateCueMapSchema({
    schemaVersion: "1",
    id: "x",
    cues: [
      { id: "reward", event: "loot_pickup", required: true, frequency: "occasional", priority: "gameplay", mixerBus: "SFX", layerRoles: ["reward"], spatial: { mode: "2d" } },
      { id: "fire", event: "weapon.fire", required: true, frequency: "rare", priority: "gameplay", mixerBus: "SFX", layerRoles: ["body"], spatial: { mode: "2d" } },
    ],
  });
  const telemetry = validateTelemetrySchema({
    schemaVersion: "1",
    id: "t",
    runSummary: { requiredFreshnessFields: [], fields: [] },
    eventStream: { timestampField: "t", events: [{ type: "loot_pickup", payload: [] }] },
  });
  assert.ok(cue.ok && telemetry.ok);
  const warnings = cueEventTelemetryWarnings(cue.schema!, telemetry.schema!);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cue `fire`: event `weapon.fire` matches no telemetry event type/);
  assert.match(warnings[0], /advisory/);
});

test("crossCheckGenreCueEvents: seed pack — telemetry-backed events do NOT warn; game-side-only events warn (advisory)", async () => {
  const warnings = await crossCheckGenreCueEvents("3d-topdown-arena");
  // Aligned events (loot_complete / extract_hold_start / extract_complete) are clean
  // (ground-truthed to the real dogfood-project telemetry type names, T3-T).
  for (const backed of ["loot_reward", "extract_start", "extract_complete"]) {
    assert.equal(
      warnings.some((w) => w.includes(`\`${backed}\``)),
      false,
      `telemetry-backed cue \`${backed}\` must not warn`,
    );
  }
  // Cues bound to game-side events the telemetry schema does not sample DO warn —
  // honestly advisory (the telemetry pack has no combat events today).
  for (const unbacked of ["fire", "hit", "hurt", "enemy_death", "player_death"]) {
    assert.ok(
      warnings.some((w) => w.includes(`\`${unbacked}\``)),
      `game-side-only cue \`${unbacked}\` warns (advisory)`,
    );
  }
});

test("crossCheckGenreCueEvents: [] when either artifact is not resolvable (cross-check applies only when both exist)", async () => {
  assert.deepEqual(await crossCheckGenreCueEvents("no-such-genre"), []);
  assert.deepEqual(await crossCheckGenreCueEvents("../evil"), []);
});
