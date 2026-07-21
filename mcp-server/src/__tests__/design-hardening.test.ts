/**
 * Design-doc hardening (RCL tranche-2) — tests for the anti-drift thesis validation, the pure scale
 * sanity checker, and the design-doc coverage report.
 *
 * BACKWARD-COMPAT is the hard invariant: `validateGenreContract` must accept every legacy contract
 * (no productThesis / scaleModel) with a byte-identical result — the optional sections refuse ONLY
 * when present-but-malformed, and their ABSENCE is a WARN from the advisory layer, never a refusal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateGenreContract } from "../loomtide/genre-contract/validator.js";
import type { GenreContract, ProductThesis } from "../loomtide/genre-contract/types.js";
import { EVIDENCE_CLASSES } from "../verification/gates/evidence-classes.js";
import {
  checkScaleSanity,
  buildDesignDocCoverageReport,
  aggregateDesignHardening,
  collectDesignHardeningWarnings,
  formatDesignHardeningAdvisory,
  MAX_PLAUSIBLE_CROSSINGS_PER_RUN,
  MIN_PLAUSIBLE_CROSSINGS_PER_RUN,
} from "../loomtide/genre-contract/design-hardening.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(PKG_ROOT, "src", "loomtide", "genre-contract", "examples");

/** A minimal valid twitch contract — mirrors the base in loomtide-genre-contract.test.ts. */
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

const goodThesis: ProductThesis = {
  statement: "a casual mobile greed run",
  notThisGame: ["mobile Tarkov extraction sim"],
  deferredFeatures: ["ammo", "attachments", "inventory grid"],
  feelDamagingAdditions: ["long raids", "reload friction"],
};

function codes(input: unknown): string[] {
  return validateGenreContract(input).issues.map((i) => i.code);
}

/* ================================================================== backward compat (byte-identical) */

test("legacy contract (no productThesis/scaleModel) validates unchanged — byte-identical result", () => {
  const res = validateGenreContract(validBase());
  // The result object gained NO new keys; absence of the optional sections adds NO issues.
  assert.deepEqual(res, { valid: true, issues: [] });
});

test("the shipped 2d-shooter example (a legacy contract) still validates with zero issues", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "2d-shooter.contract.json"), "utf8"));
  const before = JSON.stringify(validateGenreContract(fixture));
  const after = JSON.stringify(validateGenreContract(fixture)); // deterministic
  assert.equal(before, after);
  assert.equal(before, JSON.stringify({ valid: true, issues: [] }));
});

test("a valid productThesis + scaleModel keeps the contract valid (present-and-well-formed)", () => {
  const c = { ...validBase(), productThesis: goodThesis, scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 100 } };
  assert.deepEqual(validateGenreContract(c), { valid: true, issues: [] });
});

test("empty anti-drift arrays are allowed (a thesis may legitimately defer nothing)", () => {
  const c = { ...validBase(), productThesis: { statement: "x", notThisGame: [], deferredFeatures: [], feelDamagingAdditions: [] } };
  assert.deepEqual(validateGenreContract(c), { valid: true, issues: [] });
});

/* ================================================================== present-but-malformed refusals */

test("malformed productThesis is refused (present-but-malformed)", () => {
  assert.ok(codes({ ...validBase(), productThesis: 42 }).includes("PRODUCT_THESIS"));
  assert.ok(codes({ ...validBase(), productThesis: { ...goodThesis, statement: "" } }).includes("PRODUCT_THESIS_STATEMENT"));
  assert.ok(codes({ ...validBase(), productThesis: { ...goodThesis, notThisGame: "no" } }).includes("PRODUCT_THESIS_LIST"));
  assert.ok(codes({ ...validBase(), productThesis: { ...goodThesis, deferredFeatures: ["ok", "  "] } }).includes("PRODUCT_THESIS_LIST_ENTRY"));
});

test("malformed scaleModel is refused (present-but-malformed)", () => {
  assert.ok(codes({ ...validBase(), scaleModel: "no" }).includes("SCALE_MODEL"));
  assert.ok(codes({ ...validBase(), scaleModel: { playerSpeedMps: -5, targetRunSeconds: 120 } }).includes("SCALE_MODEL_REQUIRED"));
  assert.ok(codes({ ...validBase(), scaleModel: { playerSpeedMps: 5 } }).includes("SCALE_MODEL_REQUIRED")); // missing targetRunSeconds
  assert.ok(codes({ ...validBase(), scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 0 } }).includes("SCALE_MODEL_OPTIONAL"));
});

/* ================================================================== scale checker math (calibration) */

test("dogfood collapse: 40m @ 5 m/s vs a 90-150s run → arena-too-small (hand-computed)", () => {
  const low = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 90, arenaWidthM: 40 });
  assert.equal(low.computed.timeToCrossWidthSec, 8); // 40 / 5
  assert.equal(low.computed.crossingsPerRun, 11.25); // 90 / 8
  assert.ok(low.computed.crossingsPerRun! > MAX_PLAUSIBLE_CROSSINGS_PER_RUN);
  assert.deepEqual(low.warnings.map((w) => w.code), ["SCALE_ARENA_TOO_SMALL"]);
  assert.equal(low.ok, false);

  const high = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 150, arenaWidthM: 40 });
  assert.equal(high.computed.crossingsPerRun, 18.75); // 150 / 8
  assert.ok(high.warnings.some((w) => w.code === "SCALE_ARENA_TOO_SMALL"));
});

test("corrected scale: 100m @ 5 m/s vs a 120s run → in-band, no arena warning", () => {
  const r = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 100 });
  assert.equal(r.computed.timeToCrossWidthSec, 20); // 100 / 5
  assert.equal(r.computed.crossingsPerRun, 6); // 120 / 20
  assert.ok(r.computed.crossingsPerRun! <= MAX_PLAUSIBLE_CROSSINGS_PER_RUN);
  assert.ok(r.computed.crossingsPerRun! >= MIN_PLAUSIBLE_CROSSINGS_PER_RUN);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.ok, true);
});

test("over-large arena: 400m @ 5 m/s vs a 60s run → arena-too-large", () => {
  const r = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 60, arenaWidthM: 400 });
  assert.equal(r.computed.timeToCrossWidthSec, 80); // 400 / 5
  assert.equal(r.computed.crossingsPerRun, 0.75); // 60 / 80
  assert.deepEqual(r.warnings.map((w) => w.code), ["SCALE_ARENA_TOO_LARGE"]);
});

test("camera showing the whole arena → SCALE_CAMERA_SHOWS_WHOLE_ARENA", () => {
  const wide = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 40, cameraVisibleWidthM: 54 });
  assert.equal(wide.computed.cameraCoverageFraction, 1.35); // 54 / 40
  assert.ok(wide.warnings.some((w) => w.code === "SCALE_CAMERA_SHOWS_WHOLE_ARENA"));

  const local = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 100, cameraVisibleWidthM: 28 });
  assert.equal(local.computed.cameraCoverageFraction, 0.28); // 28 / 100
  assert.ok(!local.warnings.some((w) => w.code === "SCALE_CAMERA_SHOWS_WHOLE_ARENA"));
});

test("first-loot timing checks (after-run / late / ok)", () => {
  const after = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, firstLootSeconds: 130 });
  assert.ok(after.warnings.some((w) => w.code === "SCALE_FIRST_LOOT_AFTER_RUN"));

  const late = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, firstLootSeconds: 80 });
  assert.ok(late.warnings.some((w) => w.code === "SCALE_FIRST_LOOT_LATE"));

  const ok = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, firstLootSeconds: 20 });
  assert.ok(!ok.warnings.some((w) => w.code.startsWith("SCALE_FIRST_LOOT")));
});

test("insufficient inputs are honest limits, never a crash", () => {
  const noSpeed = checkScaleSanity({ playerSpeedMps: 0, targetRunSeconds: 120 });
  assert.equal(noSpeed.ok, false);
  assert.equal(noSpeed.warnings.length, 0);
  assert.ok(noSpeed.limits.length > 0);

  const noArena = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120 });
  assert.equal(noArena.computed.crossingsPerRun, undefined);
  assert.ok(noArena.limits.some((l) => /arena-crossing check skipped/.test(l)));
});

/* ================================================================== coverage report */

test("fully-present contract → all coverage items present, zero warnings", () => {
  const c: GenreContract = {
    ...validBase(),
    productThesis: goodThesis,
    measurabilityMap: [
      { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", gateBand: { min: 0, max: 50, unit: "ms" }, bucket: "coreVertical" },
    ],
    humanOracleChecks: [{ check: "does aiming feel good?", appliesTo: "aiming-feel" }],
  };
  // sanity: still a valid contract
  assert.deepEqual(validateGenreContract(c), { valid: true, issues: [] });

  const report = buildDesignDocCoverageReport(c);
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i.status]));
  assert.deepEqual(byId, {
    "product-thesis": "present",
    "input-contract": "present",
    "feedback-sound": "present",
    "acceptance-protocol": "present",
    "verification-evidence": "present",
  });
  assert.equal(report.warnings.length, 0);
});

test("dogfood-class contract → the exact §1 false-starts flagged (absent/partial)", () => {
  const c: GenreContract = {
    ...validBase(),
    targetPlatform: { device: "mobile", inputScheme: "kb-mouse" }, // mobile target, keyboard-only validation
    feedbackChains: [{ verb: "fire", input: "tap", response: "spawn", feedback: "muzzle flash only" }], // no sound
    sliceDag: {
      coreVertical: [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gaps: ["not-yet-measurable"] }], // gaps-only
      deferredMeta: [],
    },
    // no productThesis, no gateBand, no humanOracleChecks
  };
  assert.equal(validateGenreContract(c).valid, true); // valid contract, just under-hardened

  const report = buildDesignDocCoverageReport(c);
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i.status]));
  assert.deepEqual(byId, {
    "product-thesis": "absent",
    "input-contract": "partial", // the exact dogfood contradiction
    "feedback-sound": "partial", // feedback declared but no audio cue
    "acceptance-protocol": "absent",
    "verification-evidence": "partial", // gaps-only, no gates
  });
  const warnCodes = report.warnings.map((w) => w.code).sort();
  assert.deepEqual(warnCodes, [
    "COVERAGE_ACCEPTANCE_PROTOCOL_ABSENT",
    "COVERAGE_FEEDBACK_SOUND_PARTIAL",
    "COVERAGE_INPUT_CONTRACT_PARTIAL",
    "COVERAGE_PRODUCT_THESIS_ABSENT",
    "COVERAGE_VERIFICATION_EVIDENCE_PARTIAL",
  ]);
  // the input-contract rationale must name the mobile+keyboard contradiction
  const input = report.items.find((i) => i.id === "input-contract")!;
  assert.match(input.rationale, /mobile.*keyboard|keyboard.*mobile|validated keyboard-only/i);
});

test("a genuinely touch mobile contract does NOT trip the input contradiction", () => {
  const c: GenreContract = { ...validBase(), targetPlatform: { device: "mobile", inputScheme: "touch" } };
  const report = buildDesignDocCoverageReport(c);
  assert.equal(report.items.find((i) => i.id === "input-contract")!.status, "present");
});

/* ================================================================== aggregate advisory */

test("collectDesignHardeningWarnings: absent scaleModel → SCALE_MODEL_ABSENT advisory", () => {
  const warnings = collectDesignHardeningWarnings(validBase());
  assert.ok(warnings.some((w) => w.code === "SCALE_MODEL_ABSENT"));
});

test("collectDesignHardeningWarnings: present-but-collapsing scaleModel → scale warning included", () => {
  const c = { ...validBase(), scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 40 } };
  const warnings = collectDesignHardeningWarnings(c);
  assert.ok(warnings.some((w) => w.code === "SCALE_ARENA_TOO_SMALL"));
  assert.ok(!warnings.some((w) => w.code === "SCALE_MODEL_ABSENT"));
});

test("formatDesignHardeningAdvisory: fully-hardened contract (both axes declared) prints the no-advisories line", () => {
  const c: GenreContract = {
    ...validBase(),
    productThesis: goodThesis,
    scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 100, arenaHeightM: 100, cameraVisibleWidthM: 28, firstLootSeconds: 20 },
    measurabilityMap: [
      { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", gateBand: { min: 0, max: 50, unit: "ms" }, bucket: "coreVertical" },
    ],
    humanOracleChecks: [{ check: "does aiming feel good?", appliesTo: "aiming-feel" }],
  };
  const lines = formatDesignHardeningAdvisory(c);
  assert.ok(lines.some((l) => /no advisories/.test(l)));
  assert.ok(!lines.some((l) => /LIMIT|unverified/.test(l)));
});

/* ================================================================== D1 — limits propagate to the advisory */

test("partial scaleModel (speed+run only): advisory renders the unverified-limits section, NOT the all-clear", () => {
  // Otherwise fully-hardened contract: the ONLY gaps are the scale checker's missing optional inputs.
  const c: GenreContract = {
    ...validBase(),
    productThesis: goodThesis,
    scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120 }, // no arenaWidthM/HeightM/camera
    measurabilityMap: [
      { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", gateBand: { min: 0, max: 50, unit: "ms" }, bucket: "coreVertical" },
    ],
    humanOracleChecks: [{ check: "does aiming feel good?", appliesTo: "aiming-feel" }],
  };
  const agg = aggregateDesignHardening(c);
  assert.equal(agg.warnings.length, 0); // nothing WARN-worthy…
  assert.ok(agg.limits.length > 0); // …but sub-checks could not run
  assert.ok(agg.limits.some((l) => /arena-crossing check skipped/.test(l)));

  const lines = formatDesignHardeningAdvisory(c);
  assert.ok(lines.some((l) => /unverified \(missing inputs/.test(l)), "must render the limits section header");
  assert.ok(lines.some((l) => /LIMIT scale: arena-crossing check skipped/.test(l)), "must render the skipped check");
  assert.ok(!lines.some((l) => /no advisories/.test(l)), "must NOT print the all-clear when limits are non-empty");
});

test("collapsing scaleModel: aggregate carries BOTH the scale warning and the disclosed limits", () => {
  const c = { ...validBase(), scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 40 } };
  const agg = aggregateDesignHardening(c);
  assert.ok(agg.warnings.some((w) => w.code === "SCALE_ARENA_TOO_SMALL"));
  assert.ok(agg.limits.some((l) => /arenaHeightM not declared/.test(l)));
  assert.ok(agg.limits.some((l) => /camera-coverage check skipped/.test(l)));
});

/* ================================================================== D2 — both-axis crossing check */

test("both-axis arena: 80m wide × 40m high @ 5 m/s vs 120s — only the height axis is out of band", () => {
  const r = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 80, arenaHeightM: 40 });
  // width: 80/5 = 16s → 120/16 = 7.5 crossings (in band ≤ 8)
  assert.equal(r.computed.timeToCrossWidthSec, 16);
  assert.equal(r.computed.crossingsPerRun, 7.5);
  // height: 40/5 = 8s → 120/8 = 15 crossings (> 8 → flagged)
  assert.equal(r.computed.timeToCrossHeightSec, 8);
  assert.equal(r.computed.crossingsPerRunHeight, 15);
  const tooSmall = r.warnings.filter((w) => w.code === "SCALE_ARENA_TOO_SMALL");
  assert.equal(tooSmall.length, 1, "exactly ONE axis flagged");
  assert.match(tooSmall[0]!.message, /height/);
  assert.ok(!tooSmall[0]!.message.includes("arena width"), "width axis is in band, must not be flagged");
  // both axes declared → no height-absent limit
  assert.ok(!r.limits.some((l) => /arenaHeightM not declared/.test(l)));
});

test("height absent on a width-declared arena: width-only check + a disclosed limit, never a silent skip", () => {
  const r = checkScaleSanity({ playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 100 });
  assert.equal(r.computed.crossingsPerRun, 6);
  assert.equal(r.computed.crossingsPerRunHeight, undefined);
  assert.ok(r.limits.some((l) => /arenaHeightM not declared.*width axis only/.test(l)));
});

/* ================================================================== D4 — expanded non-touch tokens */

test("arrow-keys / d-pad / stylus schemes on a mobile target also trip the input contradiction", () => {
  for (const scheme of ["arrows", "arrow-keys", "dpad", "d-pad", "stylus"]) {
    const c: GenreContract = { ...validBase(), targetPlatform: { device: "mobile", inputScheme: scheme } };
    const item = buildDesignDocCoverageReport(c).items.find((i) => i.id === "input-contract")!;
    assert.equal(item.status, "partial", `scheme "${scheme}" should be flagged as the mobile contradiction`);
  }
  // and the heuristic limit is disclosed in the rationale
  const c: GenreContract = { ...validBase(), targetPlatform: { device: "mobile", inputScheme: "touch" } };
  const item = buildDesignDocCoverageReport(c).items.find((i) => i.id === "input-contract")!;
  assert.match(item.rationale, /token-list heuristic/i);
});

/* ================================================================== §6 requiredEvidenceClasses (RCL) */

test("legacy contract (no requiredEvidenceClasses) validates byte-identically — no new issues", () => {
  // Absence is a no-op: same result as the base, and the field is genuinely absent.
  assert.deepEqual(validateGenreContract(validBase()), { valid: true, issues: [] });
  assert.equal("requiredEvidenceClasses" in validBase(), false);
});

test("a valid requiredEvidenceClasses keeps the contract valid (present-and-well-formed)", () => {
  const c = { ...validBase(), requiredEvidenceClasses: ["console_clean", "scene_validation"] as const };
  assert.deepEqual(validateGenreContract(c), { valid: true, issues: [] });
  // an empty array is allowed (declares no required class) — still valid.
  assert.deepEqual(validateGenreContract({ ...validBase(), requiredEvidenceClasses: [] }), { valid: true, issues: [] });
});

test("malformed requiredEvidenceClasses is refused (present-but-malformed)", () => {
  assert.ok(codes({ ...validBase(), requiredEvidenceClasses: "console_clean" }).includes("REQUIRED_EVIDENCE_CLASSES"));
  assert.ok(codes({ ...validBase(), requiredEvidenceClasses: [42] }).includes("REQUIRED_EVIDENCE_CLASS"));
  // unknown class name → refusal
  assert.ok(codes({ ...validBase(), requiredEvidenceClasses: ["not_a_class"] }).includes("REQUIRED_EVIDENCE_CLASS"));
  // case mismatch is NOT a known class → refusal (the enum is case-exact)
  assert.ok(codes({ ...validBase(), requiredEvidenceClasses: ["Console_Clean"] }).includes("REQUIRED_EVIDENCE_CLASS"));
});

test("enum single-source: the genre-contract side accepts EXACTLY the classes the verification side defines", () => {
  // Every class in the shared EVIDENCE_CLASSES enum must be accepted…
  for (const cls of EVIDENCE_CLASSES) {
    assert.deepEqual(
      validateGenreContract({ ...validBase(), requiredEvidenceClasses: [cls] }),
      { valid: true, issues: [] },
      `evidence class "${cls}" must be accepted by the genre-contract validator`,
    );
  }
  // …and the whole set at once is accepted (no drift in either direction).
  assert.deepEqual(
    validateGenreContract({ ...validBase(), requiredEvidenceClasses: [...EVIDENCE_CLASSES] }),
    { valid: true, issues: [] },
  );
  // A name that is NOT in the enum is refused — the two sides can never silently diverge.
  assert.ok(codes({ ...validBase(), requiredEvidenceClasses: ["console_clean", "__drift__"] }).includes("REQUIRED_EVIDENCE_CLASS"));
});

test("coverage item (e): first-class when requiredEvidenceClasses declared, fallback proxy when absent", () => {
  // First-class: declared non-empty classes → present, first-class `where`, rationale names the classes.
  const firstClass: GenreContract = { ...validBase(), requiredEvidenceClasses: ["console_clean", "play_trace"] };
  const e1 = buildDesignDocCoverageReport(firstClass).items.find((i) => i.id === "verification-evidence")!;
  assert.equal(e1.status, "present");
  assert.equal(e1.where, "requiredEvidenceClasses (first-class)");
  assert.match(e1.rationale, /console_clean/);
  assert.match(e1.rationale, /play_trace/);
  // present ⇒ item (e) emits no advisory warning (other unrelated absents may still warn).
  assert.ok(!buildDesignDocCoverageReport(firstClass).warnings.some((w) => /VERIFICATION_EVIDENCE/.test(w.code)));

  // Fallback: no declaration → the gates/gaps proxy, and its `where` points authors at the new field.
  const fallback: GenreContract = {
    ...validBase(),
    sliceDag: {
      coreVertical: [{ id: "a", title: "A", dependsOn: [], confidence: "experimental", gaps: ["not-yet-measurable"] }],
      deferredMeta: [],
    },
  };
  const e2 = buildDesignDocCoverageReport(fallback).items.find((i) => i.id === "verification-evidence")!;
  assert.equal(e2.status, "partial"); // gaps-only, unchanged fallback semantics
  assert.match(e2.where, /PROXY .*requiredEvidenceClasses/);
  assert.match(e2.rationale, /verification\.requiredEvidenceClasses/);

  // An empty array is treated as "not declared" → fallback path (the base has a gated slice → present).
  const empty: GenreContract = { ...validBase(), requiredEvidenceClasses: [] };
  const e3 = buildDesignDocCoverageReport(empty).items.find((i) => i.id === "verification-evidence")!;
  assert.equal(e3.status, "present");
  assert.match(e3.where, /PROXY/);
});
