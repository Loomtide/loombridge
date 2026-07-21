import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateGenreContract,
  assertValidGenreContract,
  IMPLEMENTED_CALCULATOR_IDS,
} from "../loomtide/genre-contract/validator.js";
import type { GenreContract } from "../loomtide/genre-contract/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", ".."); // dist/__tests__ -> mcp-server
const EXAMPLES = path.join(PKG_ROOT, "src", "loomtide", "genre-contract", "examples");

/** A minimal, valid twitch contract used as the base for mutation-based negative tests. */
function validBase(): GenreContract {
  return {
    schemaVersion: "0.1.0",
    genreId: "test-shooter",
    confidence: "experimental",
    targetPlatform: { device: "pc", inputScheme: "kb-mouse" },
    networkModel: { mode: "single-player" },
    coreLoop: { description: "move, aim, shoot", genreClass: "twitch" },
    artDirection: { style: "neon" },
    verticalSliceBudget: { coreVerticalContent: { weapon: 1 }, deferred: ["roster"] },
    feedbackChains: [{ verb: "fire", input: "LMB", response: "spawn", feedback: "muzzle + SFX" }],
    tunables: [{ id: "fireIntervalMs", unit: "ms" }],
    measurabilityMap: [
      { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical" },
    ],
    referenceAnchor: {},
    sliceDag: {
      coreVertical: [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gates: ["manifest"] }],
      deferredMeta: [],
    },
    refusalConditions: [],
    humanOracleChecks: [],
  };
}

function codes(input: unknown): string[] {
  return validateGenreContract(input).issues.map((i) => i.code);
}

/* ------------------------------------------------------------------ positive */

test("the minimal valid base contract validates", () => {
  const res = validateGenreContract(validBase());
  assert.deepEqual(res.issues, []);
  assert.equal(res.valid, true);
});

test("the shipped 2d-shooter example fixture validates", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "2d-shooter.contract.json"), "utf8"));
  const res = validateGenreContract(fixture);
  assert.deepEqual(res.issues, [], `unexpected issues: ${JSON.stringify(res.issues)}`);
});

test("assertValidGenreContract returns the typed contract when valid, throws otherwise", () => {
  const c = assertValidGenreContract(validBase());
  assert.equal(c.genreId, "test-shooter");
  assert.throws(() => assertValidGenreContract({ schemaVersion: "0.1.0" }), /invalid genre contract/);
});

test("IMPLEMENTED_CALCULATOR_IDS includes real calculators but NOT uncalculated banded ids", () => {
  // trajectory + sync + bisection + probe — every metric with a real measurement path today
  for (const id of [
    "timeToApex", "inputLatency", "shortHopApex", // trajectory
    "projectileSpeed", // shooter trajectory
    "inputToSfxLatency", "dashToGhostMs", "groundContactToDustMs", "inputToAnimStateLatency", "fireIntervalMs", "fireInputToSpawnLatency", // sync
    "coyoteTime", "jumpBuffer", // bisection
    "dashDistance", // probe
  ]) {
    assert.ok(IMPLEMENTED_CALCULATOR_IDS.has(id), `expected ${id} to be an implemented calculator`);
  }
  // these are in KNOWN_PROFILE_METRICS but have no calculator — must NOT be bindable as measurable-now
  assert.ok(!IMPLEMENTED_CALCULATOR_IDS.has("maxFallSpeed"));
  assert.ok(!IMPLEMENTED_CALCULATOR_IDS.has("hitStopMs"));
  assert.ok(!IMPLEMENTED_CALCULATOR_IDS.has("dashTime"));
});

test("dashDistance is measurable-now (probe) — not wrongly refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "dashDistance", tag: "measurable-now", calculator: "dashDistance", bucket: "coreVertical" },
  ];
  assert.deepEqual(validateGenreContract(c).issues, []);
});

/* ------------------------------------------------------------------ structural refusals */

test("non-object input is refused", () => {
  assert.deepEqual(codes(null), ["NOT_OBJECT"]);
  assert.deepEqual(codes("nope"), ["NOT_OBJECT"]);
});

test("wrong schemaVersion / missing genreId / bad confidence are refused", () => {
  const c = validBase() as unknown as Record<string, unknown>;
  c.schemaVersion = "9.9.9";
  c.genreId = "";
  c.confidence = "prod-green";
  const got = codes(c);
  assert.ok(got.includes("SCHEMA_VERSION"));
  assert.ok(got.includes("GENRE_ID"));
  assert.ok(got.includes("CONFIDENCE"));
});

test("unknown genreClass is refused", () => {
  const c = validBase();
  (c.coreLoop as unknown as Record<string, unknown>).genreClass = "puzzle";
  assert.ok(codes(c).includes("GENRE_CLASS"));
});

test("multiplayer without netcode is refused", () => {
  const c = validBase();
  c.networkModel = { mode: "pvp" } as GenreContract["networkModel"];
  assert.ok(codes(c).includes("NETWORK_NETCODE"));
});

test("empty coreVerticalContent budget is refused", () => {
  const c = validBase();
  c.verticalSliceBudget = { coreVerticalContent: {}, deferred: [] };
  assert.ok(codes(c).includes("BUDGET_CONTENT"));
});

test("non-positive or non-integer coreVerticalContent counts are refused", () => {
  const c = validBase() as unknown as Record<string, unknown>;
  c.verticalSliceBudget = { coreVerticalContent: { weapon: "1", enemy: 0, arena: 1.5 }, deferred: [] };
  const got = codes(c);
  assert.equal(got.filter((code) => code === "BUDGET_COUNT").length, 3);
});

/* ------------------------------------------------------------------ measurability (the moat) */

test("measurable-now without a calculator is refused", () => {
  const c = validBase();
  c.measurabilityMap = [{ target: "x", tag: "measurable-now", bucket: "coreVertical" }];
  assert.ok(codes(c).includes("MEASURABLE_NOW_NO_CALC"));
});

test("measurable-now bound to an UNIMPLEMENTED calculator is refused (no false-green)", () => {
  const c = validBase();
  // hitStopMs is in the banded vocabulary but has no calculator
  c.measurabilityMap = [{ target: "hitStopMs", tag: "measurable-now", calculator: "hitStopMs", bucket: "coreVertical" }];
  assert.ok(codes(c).includes("MEASURABLE_NOW_UNIMPLEMENTED"));
});

test("a judgment-only target that HAS an implemented calculator is refused (no dodging)", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical" },
    { target: "timeToApex", tag: "judgment-only", bucket: "coreVertical" },
  ];
  c.humanOracleChecks = [{ check: "feels?", appliesTo: "timeToApex" }];
  assert.ok(codes(c).includes("JUDGMENT_ONLY_HAS_CALC"));
});

test("a measurability row without a bucket is refused", () => {
  const c = validBase();
  c.measurabilityMap = [{ target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency" } as never];
  assert.ok(codes(c).includes("MEASURABILITY_BUCKET"));
});

test("a band without evidenceKind is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: { max: 50, unit: "ms" } },
  ];
  assert.ok(codes(c).includes("BAND_NO_EVIDENCE"));
});

test("an empty band is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: {}, evidenceKind: "pack-default" },
  ];
  assert.ok(codes(c).includes("BAND_EMPTY"));
});

test("an inverted or non-finite numeric band is refused", () => {
  const inverted = validBase();
  inverted.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: { min: 60, max: 50, unit: "ms" }, evidenceKind: "pack-default" },
  ];
  assert.ok(codes(inverted).includes("BAND_RANGE"));

  const nonFinite = validBase();
  nonFinite.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: { min: Number.NaN, unit: "ms" }, evidenceKind: "pack-default" },
  ];
  assert.ok(codes(nonFinite).includes("BAND_MIN"));
});

test("an enforced gateBand is shape/unit/range-validated and must be numeric", () => {
  const row = (gateBand: unknown) => ({
    target: "inputToSfxLatency",
    tag: "measurable-now" as const,
    calculator: "inputToSfxLatency",
    bucket: "coreVertical" as const,
    band: { max: 50, unit: "ms" },
    evidenceKind: "pack-default" as const,
    gateBand,
  });
  const withGate = (gateBand: unknown) => {
    const c = validBase();
    c.measurabilityMap = [row(gateBand) as never];
    return c;
  };
  // empty / qualitative-only gateBand enforces nothing → refused (not a silent no-op).
  assert.ok(codes(withGate({})).includes("GATE_BAND_NOT_NUMERIC"));
  assert.ok(codes(withGate({ qualitative: "snappy" })).includes("GATE_BAND_NOT_NUMERIC"));
  // string bounds are not finite numbers.
  assert.ok(codes(withGate({ min: "100", max: "200", unit: "ms" })).includes("GATE_BAND_MIN"));
  assert.ok(codes(withGate({ min: 100, max: "200", unit: "ms" })).includes("GATE_BAND_MAX"));
  // inverted range.
  assert.ok(codes(withGate({ min: 200, max: 100, unit: "ms" })).includes("GATE_BAND_RANGE"));
  // non-finite.
  assert.ok(codes(withGate({ min: Number.POSITIVE_INFINITY, unit: "ms" })).includes("GATE_BAND_MIN"));
  // unsupported unit.
  assert.ok(codes(withGate({ min: 100, max: 200, unit: "parsecs" })).includes("GATE_BAND_UNIT"));
  // a valid one-sided numeric gateBand is accepted (no gateBand issue codes).
  assert.ok(!codes(withGate({ min: 30, unit: "ms" })).some((code) => code.startsWith("GATE_BAND")));
});

test("an agent-guess band on a coreVertical target requires an out-of-band signoff", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: { max: 50, unit: "ms" }, evidenceKind: "agent-guess" },
  ];
  assert.ok(codes(c).includes("AGENT_GUESS_NO_SIGNOFF"));
});

test("an agent-guess band with a malformed signoff sha is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    {
      target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical",
      band: { max: 50, unit: "ms" }, evidenceKind: "agent-guess",
      signoff: { signoffArtifact: ".loomtide/signoff/x.txt", signoffSha256: "NOTAHASH" },
    },
  ];
  assert.ok(codes(c).includes("SIGNOFF_SHA"));
});

test("an unsupported band/tunable unit is refused", () => {
  const c = validBase();
  c.tunables = [{ id: "fireIntervalMs", unit: "furlongs" }];
  assert.ok(codes(c).includes("TUNABLE_UNIT"));
});

/* ------------------------------------------------------------------ slice DAG */

test("an unknown gate id is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gates: ["ui-conformnace"] }];
  assert.ok(codes(c).includes("SLICE_GATE_UNKNOWN"));
});

test("a slice with neither gates nor gaps is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: [], confidence: "experimental" }];
  assert.ok(codes(c).includes("SLICE_NO_PROOF"));
});

test("a slice with both gates and gaps is allowed", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gates: ["manifest"], gaps: ["x-calc"] }];
  assert.deepEqual(validateGenreContract(c).issues, []);
});

test("a slice missing confidence is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: [], gates: ["manifest"] } as never];
  assert.ok(codes(c).includes("SLICE_CONFIDENCE"));
});

test("a slice missing title is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "", dependsOn: [], confidence: "experimental", gates: ["manifest"] }];
  assert.ok(codes(c).includes("SLICE_TITLE"));
});

test("a slice missing dependsOn is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", confidence: "experimental", gates: ["manifest"] } as never];
  assert.ok(codes(c).includes("SLICE_DEPENDS_TYPE"));
});

test("an unresolved dependsOn is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: ["ghost"], confidence: "experimental", gates: ["manifest"] }];
  assert.ok(codes(c).includes("SLICE_DEP_UNRESOLVED"));
});

test("a dependency cycle is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [
    { id: "a", title: "A", dependsOn: ["b"], confidence: "experimental", gates: ["manifest"] },
    { id: "b", title: "B", dependsOn: ["a"], confidence: "experimental", gates: ["manifest"] },
  ];
  assert.ok(codes(c).includes("SLICE_CYCLE"));
});

test("a meta kind smuggled into a coreVertical slice is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gates: ["manifest"], kind: "progression" }];
  assert.ok(codes(c).includes("CORE_VERTICAL_META"));
});

test("a brief-defining upgradeChoice can be a minimal core slice without becoming meta progression", () => {
  const c = validBase();
  c.verticalSliceBudget = { coreVerticalContent: { weapon: 1, upgradeChoice: 1 }, deferred: ["weapon-upgrade-tree", "meta-currency"] };
  c.sliceDag.coreVertical = [
    { id: "weapon", title: "Weapon core", dependsOn: [], confidence: "experimental", gates: ["manifest"], kind: "weapon" },
    {
      id: "upgrade-choice",
      title: "Minimal between-level weapon upgrade choice",
      dependsOn: ["weapon"],
      confidence: "experimental",
      gates: ["manifest", "ui-conformance", "console-clean"],
      gaps: ["upgrade-choice-meaningfulness-oracle"],
      kind: "upgradeChoice",
    },
  ];
  c.sliceDag.deferredMeta = [
    { id: "weapon-upgrade-tree", title: "Full weapon upgrade tree", dependsOn: [], confidence: "experimental", kind: "unlocks", gaps: ["deferred-meta"] },
  ];
  assert.deepEqual(validateGenreContract(c).issues, []);
});

/* ------------------------------------------------------------------ genre-class completeness */

test("a twitch contract that is all judgment-only is refused (must commit to measurable feel)", () => {
  const c = validBase();
  c.measurabilityMap = [{ target: "aiming", tag: "judgment-only", bucket: "coreVertical" }];
  c.humanOracleChecks = [{ check: "good?", appliesTo: "aiming" }];
  assert.ok(codes(c).includes("COMPLETENESS_MEASURABLE"));
});

test("a judgment-only target without a humanOracleCheck is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical" },
    { target: "aiming", tag: "judgment-only", bucket: "coreVertical" },
  ];
  c.humanOracleChecks = [];
  assert.ok(codes(c).includes("JUDGMENT_ONLY_NO_ORACLE"));
});

test("a systems contract may be mostly judgment-only if oracle-covered", () => {
  const c = validBase();
  (c.coreLoop as unknown as Record<string, unknown>).genreClass = "systems";
  c.feedbackChains = [];
  c.measurabilityMap = [{ target: "macro-tension", tag: "judgment-only", bucket: "coreVertical" }];
  c.humanOracleChecks = [{ check: "is the macro loop tense?", appliesTo: "macro-tension" }];
  assert.deepEqual(validateGenreContract(c).issues, []);
});

test("malformed refusalConditions are refused", () => {
  const c = validBase() as unknown as Record<string, unknown>;
  c.refusalConditions = [{ condition: "x" }, { reason: "y" }];
  const got = codes(c);
  assert.equal(got.filter((code) => code === "REFUSAL_CONDITION").length, 2);
});

/* ------------------------------------------------------------------ adversarial-review regressions */

test("an agent-guess band cannot dodge the signoff by self-labeling bucket deferredMeta", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical" },
    { target: "fireIntervalMs", tag: "needs-new-calculator", bucket: "deferredMeta", band: { max: 50, unit: "ms" }, evidenceKind: "agent-guess" },
  ];
  // sign-off is required regardless of the self-declared bucket
  assert.ok(codes(c).includes("AGENT_GUESS_NO_SIGNOFF"));
});

test("coreVertical content-kind count exceeding the budget is refused", () => {
  const c = validBase();
  c.verticalSliceBudget = { coreVerticalContent: { weapon: 1 }, deferred: ["roster"] };
  c.sliceDag.coreVertical = [
    { id: "w1", title: "Weapon 1", dependsOn: [], confidence: "experimental", gates: ["manifest"], kind: "weapon" },
    { id: "w2", title: "Weapon 2", dependsOn: [], confidence: "experimental", gates: ["manifest"], kind: "weapon" },
  ];
  assert.ok(codes(c).includes("BUDGET_EXCEEDED"));
});

test("a duplicate slice id is refused", () => {
  const c = validBase();
  c.sliceDag.coreVertical = [
    { id: "a", title: "A", dependsOn: [], confidence: "experimental", gates: ["manifest"] },
    { id: "a", title: "A2", dependsOn: [], confidence: "experimental", gates: ["manifest"] },
  ];
  assert.ok(codes(c).includes("SLICE_DUP_ID"));
});

test("an unsupported band-level unit is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical", band: { max: 50, unit: "furlongs" }, evidenceKind: "pack-default" },
  ];
  assert.ok(codes(c).includes("BAND_UNIT"));
});

test("an unsafe signoff artifact path is refused", () => {
  const c = validBase();
  c.measurabilityMap = [
    {
      target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical",
      band: { max: 50, unit: "ms" }, evidenceKind: "agent-guess",
      signoff: { signoffArtifact: "/etc/passwd", signoffSha256: "a".repeat(64) },
    },
  ];
  assert.ok(codes(c).includes("SIGNOFF_ARTIFACT"));
});
