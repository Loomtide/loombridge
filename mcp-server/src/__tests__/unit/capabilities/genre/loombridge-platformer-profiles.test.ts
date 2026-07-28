import assert from "node:assert/strict";
import test from "node:test";

import {
  validatePlatformerProfile,
  assertValidPlatformerProfile,
} from "../../../../capabilities/genre/genre-packs/platformer-2d/validator.js";
import {
  loadAllProfiles,
  loadProfile,
  SHIPPED_PROFILE_IDS,
} from "../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js";
import {
  KNOWN_PROFILE_METRICS,
  PLATFORMER_PROFILE_SCHEMA_VERSION,
  SUPPORTED_PROFILE_UNIT_SET,
  type PlatformerFeelProfile,
} from "../../../../capabilities/genre/genre-packs/platformer-2d/types.js";
import { withinBand, bandWindow } from "../../../../capabilities/verification/gates/feel.js";

// A minimal valid profile we can clone and corrupt for the negative tests.
function baseProfile(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "precision",
    title: "Precision Platformer",
    summary: "Tight and responsive.",
    metrics: {
      jumpApex: { target: 3, unit: "u", band: { percent: 12 } },
    },
  };
}

// ── shipped profiles are valid ───────────────────────────────────────────────

test("all three shipped profiles load and validate", async () => {
  const profiles = await loadAllProfiles();
  assert.deepEqual(
    profiles.map((p) => p.id),
    ["precision", "classic", "momentum"],
  );
  for (const p of profiles) {
    const result = validatePlatformerProfile(p);
    assert.equal(result.valid, true, `${p.id}: ${JSON.stringify(result.issues, null, 2)}`);
  }
});

test("each shipped profile carries a build block; momentum has no jumpCutMultiplier", async () => {
  const profiles = await loadAllProfiles();
  for (const p of profiles) {
    assert.ok(p.build, `${p.id} must carry a build block`);
    assert.equal(p.build!.fixedTimestep, 0.0166667, `${p.id} fixedTimestep`);
  }
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  assert.equal(byId.precision.build!.stored.jumpCutMultiplier, 0.08);
  assert.equal(byId.classic.build!.stored.jumpCutMultiplier, 0.3);
  // momentum omits shortHopApex, so it MUST NOT carry jumpCutMultiplier.
  assert.equal(byId.momentum.build!.stored.jumpCutMultiplier, undefined);
});

test("shipped ids match the loader manifest", () => {
  assert.deepEqual([...SHIPPED_PROFILE_IDS], ["precision", "classic", "momentum"]);
});

test("each shipped profile defines measurable metrics with known ids, canonical units, and bands", async () => {
  const profiles = await loadAllProfiles();
  for (const p of profiles) {
    assert.equal(p.schemaVersion, PLATFORMER_PROFILE_SCHEMA_VERSION);
    const ids = Object.keys(p.metrics);
    assert.ok(ids.length > 0, `${p.id} must declare at least one metric`);
    for (const [id, m] of Object.entries(p.metrics)) {
      const spec = KNOWN_PROFILE_METRICS[id];
      assert.ok(spec, `${p.id}.${id} must be a known metric`);
      assert.equal(m.unit, spec.unit, `${p.id}.${id} must use canonical unit ${spec.unit}`);
      assert.ok(SUPPORTED_PROFILE_UNIT_SET.has(m.unit));
      assert.ok(m.band && (m.band.percent !== undefined || m.band.abs !== undefined),
        `${p.id}.${id} must define a band`);
    }
  }
});

test("every metric banded by a shipped profile is classified grammar or taste (never unclassified, never measure-only)", async () => {
  const profiles = await loadAllProfiles();
  for (const p of profiles) {
    for (const id of Object.keys(p.metrics)) {
      const spec = KNOWN_PROFILE_METRICS[id];
      assert.ok(spec, `${p.id}.${id} must be a known metric`);
      assert.ok(
        spec.gating === "grammar" || spec.gating === "taste",
        `${p.id}.${id} gating must be grammar or taste (got '${spec.gating}')`,
      );
    }
    // Non-vacuous: each shipped profile must band at least one of EACH class,
    // or the split silently degenerates to all-gating / all-descriptive.
    const classes = new Set(Object.keys(p.metrics).map((id) => KNOWN_PROFILE_METRICS[id]?.gating));
    assert.ok(classes.has("grammar"), `${p.id} bands no grammar metric`);
    assert.ok(classes.has("taste"), `${p.id} bands no taste metric`);
  }
});

test("NEGATIVE + LITMUS: banding a measure-only (sync) metric refuses with BANDED_MEASURE_ONLY", () => {
  const bad = baseProfile();
  (bad.metrics as Record<string, unknown>).inputToSfxLatency = {
    target: 50,
    unit: "ms",
    band: { abs: 20 },
  };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "BANDED_MEASURE_ONLY" && i.path === "metrics.inputToSfxLatency"),
    JSON.stringify(result.issues),
  );
  // LITMUS: the SAME profile without that band validates — the refusal is driven
  // by the band on the measure-only metric, not an artifact of the fixture.
  const good = baseProfile();
  const goodResult = validatePlatformerProfile(good);
  assert.equal(goodResult.valid, true, JSON.stringify(goodResult.issues));
});

test("the three profiles meaningfully differ (no copy-paste of one feel)", async () => {
  const [precision, classic, momentum] = await loadAllProfiles();
  // Classic jumps higher and hangs longer than precision; momentum runs fastest.
  assert.ok((classic.metrics.jumpApex.target) > (precision.metrics.jumpApex.target));
  assert.ok((classic.metrics.timeToApex.target) > (precision.metrics.timeToApex.target));
  assert.ok((momentum.metrics.runSpeed.target) > (classic.metrics.runSpeed.target));
});

test("loadProfile rejects an unknown id", async () => {
  await assert.rejects(() => loadProfile("nonexistent"), /Unknown platformer profile/);
});

test("a valid hand-built profile passes assertValidPlatformerProfile", () => {
  const p = assertValidPlatformerProfile(baseProfile());
  assert.equal(p.id, "precision");
});

// ── profile targets are consumable by the existing feel band helpers ─────────

test("profile metric targets work with the feel gate's withinBand/bandWindow", async () => {
  const precision = await loadProfile("precision");
  const target = precision.metrics.jumpApex; // 3u ±12% -> [2.64, 3.36]
  const w = bandWindow(target);
  assert.ok(Math.abs(w.lo - 2.64) < 1e-9);
  assert.ok(Math.abs(w.hi - 3.36) < 1e-9);
  assert.equal(withinBand(3.0, target), true);
  assert.equal(withinBand(2.5, target), false);
});

// ── negative / false-green tests ─────────────────────────────────────────────

test("NEGATIVE: a profile with no measurable metrics is refused", () => {
  const bad = baseProfile();
  bad.metrics = {};
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "NO_METRICS"), JSON.stringify(result.issues));
});

test("NEGATIVE: a metric missing its tolerance band is refused", () => {
  const bad = baseProfile();
  bad.metrics = { jumpApex: { target: 3, unit: "u" } }; // no band
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "MISSING_BAND" && i.path === "metrics.jumpApex.band"),
    JSON.stringify(result.issues));
});

test("NEGATIVE: a band defining BOTH percent and abs is refused (ambiguous window)", () => {
  const bad = baseProfile();
  bad.metrics = { jumpApex: { target: 3, unit: "u", band: { percent: 12, abs: 0.3 } } };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "AMBIGUOUS_BAND" && i.path === "metrics.jumpApex.band"),
    JSON.stringify(result.issues));
});

test("NEGATIVE: an empty band object (no percent/abs) is refused", () => {
  const bad = baseProfile();
  bad.metrics = { jumpApex: { target: 3, unit: "u", band: {} } };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "MISSING_BAND"));
});

test("NEGATIVE: an unknown metric id is refused", () => {
  const bad = baseProfile();
  bad.metrics = { wallSlideVibes: { target: 1, unit: "u", band: { percent: 10 } } };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "UNKNOWN_METRIC"), JSON.stringify(result.issues));
});

test("NEGATIVE: an unsupported unit is refused", () => {
  const bad = baseProfile();
  bad.metrics = { jumpApex: { target: 3, unit: "furlongs", band: { percent: 12 } } };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "UNSUPPORTED_UNIT"), JSON.stringify(result.issues));
});

test("NEGATIVE: a supported-but-wrong unit for the metric is refused", () => {
  const bad = baseProfile();
  bad.metrics = { runSpeed: { target: 9, unit: "ms", band: { percent: 15 } } }; // runSpeed is u/s
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "WRONG_UNIT"), JSON.stringify(result.issues));
});

test("NEGATIVE: a malformed profile id is refused", () => {
  for (const id of ["Precision", "1precision", "precision_x", "has space", ""]) {
    const bad = baseProfile();
    bad.id = id;
    const result = validatePlatformerProfile(bad);
    assert.equal(result.valid, false, `id '${id}' should be refused`);
    const code = id === "" ? "MISSING_FIELD" : "INVALID_PROFILE_ID";
    assert.ok(result.issues.some((i) => i.code === code), `${id}: ${JSON.stringify(result.issues)}`);
  }
});

test("NEGATIVE: wrong schemaVersion is refused", () => {
  const bad = baseProfile();
  bad.schemaVersion = "2";
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "INVALID_SCHEMA_VERSION"));
});

test("NEGATIVE: assertValidPlatformerProfile throws with a summarised message", () => {
  const bad = baseProfile();
  bad.metrics = {};
  assert.throws(() => assertValidPlatformerProfile(bad), /NO_METRICS/);
});

// ── F2: the `build` block (resolver inputs) ──────────────────────────────────

// A buildable profile: the three solve bands + shortHopApex so a stored
// jumpCutMultiplier is verifiable, plus a valid build block.
function buildableProfile(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "precision",
    title: "Precision Platformer",
    summary: "Tight and responsive.",
    metrics: {
      runSpeed: { target: 9, unit: "u/s", band: { percent: 15 } },
      jumpApex: { target: 3, unit: "u", band: { percent: 12 } },
      timeToApex: { target: 280, unit: "ms", band: { abs: 60 } },
      shortHopApex: { target: 1.1, unit: "u", band: { percent: 20 } },
    },
    build: {
      fixedTimestep: 0.0166667,
      stored: { jumpCutMultiplier: 0.08 },
    },
  };
}

test("a profile with a valid build block validates", () => {
  const result = validatePlatformerProfile(buildableProfile());
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("a profile with NO build block still validates (build is optional)", () => {
  const ok = buildableProfile();
  delete (ok as { build?: unknown }).build;
  const result = validatePlatformerProfile(ok);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("NEGATIVE: a build block on a profile missing a solve band is refused (BUILD_SOLVE_MISSING_BAND)", () => {
  for (const missing of ["jumpApex", "timeToApex", "runSpeed"]) {
    const bad = buildableProfile();
    delete (bad.metrics as Record<string, unknown>)[missing];
    const result = validatePlatformerProfile(bad);
    assert.equal(result.valid, false, `missing ${missing} should refuse`);
    assert.ok(
      result.issues.some((i) => i.code === "BUILD_SOLVE_MISSING_BAND"),
      `${missing}: ${JSON.stringify(result.issues)}`,
    );
  }
});

test("NEGATIVE: a stored jumpCutMultiplier without a shortHopApex band is refused (BUILD_PARAM_UNVERIFIABLE)", () => {
  // A momentum-like profile: solve bands present, no shortHopApex, but it stores
  // jumpCutMultiplier — the param has no check to trace to.
  const bad = buildableProfile();
  delete (bad.metrics as Record<string, unknown>).shortHopApex;
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "BUILD_PARAM_UNVERIFIABLE"),
    JSON.stringify(result.issues),
  );
});

test("NEGATIVE: a build block with a non-positive solve target is refused (review #1 — would derive Infinity)", () => {
  // timeToApex.target 0 → jumpSpeed = 2·apex/0 = Infinity; a negative apex → negative
  // params. The validator must refuse at load, not pass a degenerate profile through.
  for (const [metric, target] of [["timeToApex", 0], ["jumpApex", -3], ["runSpeed", 0]] as const) {
    const bad = buildableProfile();
    (bad.metrics as Record<string, { target: number }>)[metric].target = target;
    const result = validatePlatformerProfile(bad);
    assert.equal(result.valid, false, `${metric}=${target} should refuse`);
    assert.ok(
      result.issues.some((i) => i.code === "BUILD_SOLVE_MISSING_BAND"),
      `${metric}=${target}: ${JSON.stringify(result.issues)}`,
    );
  }
});

test("NEGATIVE: a build block with no `stored` is refused (review #4 — schema requires it)", () => {
  const bad = buildableProfile();
  delete (bad.build as { stored?: unknown }).stored;
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "INVALID_BUILD"),
    JSON.stringify(result.issues),
  );
});

test("a build block storing NO jumpCutMultiplier needs no shortHopApex band", () => {
  // momentum's intended shape: build block, no shortHopApex, no stored jumpCut.
  const ok = buildableProfile();
  delete (ok.metrics as Record<string, unknown>).shortHopApex;
  ok.build = { fixedTimestep: 0.0166667, stored: {} };
  const result = validatePlatformerProfile(ok);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("NEGATIVE: a build block missing fixedTimestep is refused", () => {
  const bad = buildableProfile();
  bad.build = { stored: { jumpCutMultiplier: 0.08 } };
  const result = validatePlatformerProfile(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path.startsWith("build")), JSON.stringify(result.issues));
});

// ── F3: mechanisms block validation ──────────────────────────────────────────

test("a valid mechanisms block (requires/forbids from the vocabulary) validates", () => {
  const p = baseProfile();
  p.mechanisms = { requires: ["airDash", "variableJump"], forbids: ["coyote"] };
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("an empty mechanisms block (claims nothing) validates", () => {
  const p = baseProfile();
  p.mechanisms = { requires: [], forbids: [] };
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("a profile with NO mechanisms block still validates (the block is optional)", () => {
  const result = validatePlatformerProfile(baseProfile());
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("NEGATIVE: an entry outside the vocabulary is refused (UNKNOWN_MECHANISM)", () => {
  const p = baseProfile();
  p.mechanisms = { requires: ["wallJump"], forbids: [] };
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "UNKNOWN_MECHANISM"),
    JSON.stringify(result.issues),
  );
});

test("NEGATIVE: an id in BOTH requires and forbids is refused (CONTRADICTORY_MECHANISM)", () => {
  const p = baseProfile();
  p.mechanisms = { requires: ["airDash"], forbids: ["airDash"] };
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "CONTRADICTORY_MECHANISM"),
    JSON.stringify(result.issues),
  );
});

test("NEGATIVE: a mechanisms block missing a list is refused (INVALID_MECHANISMS)", () => {
  const p = baseProfile();
  p.mechanisms = { requires: ["airDash"] }; // forbids missing
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.code === "INVALID_MECHANISMS"),
    JSON.stringify(result.issues),
  );
});

test("NEGATIVE: a non-array list is refused (INVALID_MECHANISMS)", () => {
  const p = baseProfile();
  p.mechanisms = { requires: "airDash", forbids: [] };
  const result = validatePlatformerProfile(p);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "INVALID_MECHANISMS"), JSON.stringify(result.issues));
});

test("the three shipped profiles carry the expected mechanism manifests", async () => {
  const profiles = await loadAllProfiles();
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  assert.deepEqual(byId.precision.mechanisms, {
    requires: ["airDash", "variableJump"],
    forbids: [],
  });
  assert.deepEqual(byId.classic.mechanisms, {
    requires: ["variableJump"],
    forbids: ["airDash"],
  });
  assert.deepEqual(byId.momentum.mechanisms, { requires: [], forbids: [] });
});
