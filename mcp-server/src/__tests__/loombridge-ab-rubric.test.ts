import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AB_RUBRIC_CRITERIA,
  STRUCTURAL_CRITERIA,
  JUDGMENT_CRITERIA,
  scoreStructural,
  computeAbBriefVerdict,
  computeAbMilestoneVerdict,
  judgmentWeightFor,
  DEFAULT_AB_BAR,
  type AbBriefInput,
  type IndependenceAttestation,
  type JudgmentScores,
} from "../loombridge/genre-contract/ab-rubric.js";
import type { GenreContract } from "../loombridge/genre-contract/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", ".."); // dist/__tests__ -> mcp-server
const EXAMPLES = path.join(PKG_ROOT, "src", "loombridge", "genre-contract", "examples");

function shooterFixture(): unknown {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, "2d-shooter.contract.json"), "utf8"));
}

/** A minimal valid twitch contract (mirrors the validator test's validBase). */
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
    refusalConditions: [{ condition: "x", reason: "y" }],
    humanOracleChecks: [],
  };
}

const goodJudgment: JudgmentScores = {
  "right-sub-genre": 2,
  "sensible-bands": 2,
  "real-asset-set": 2,
  "honest-measurability": 2,
  "oracle-coverage": 2,
};
const weakJudgment: JudgmentScores = {
  "right-sub-genre": 1,
  "sensible-bands": 0,
  "real-asset-set": 1,
  "honest-measurability": 0,
  "oracle-coverage": 1,
};

const realIndependence: IndependenceAttestation = {
  independent: true,
  reviewerCount: 2,
  reviewerIds: ["r1", "r2"],
};

/* ------------------------------------------------------------------ criteria shape */

test("rubric has 10 criteria split 5 structural / 5 judgment", () => {
  assert.equal(AB_RUBRIC_CRITERIA.length, 10);
  assert.equal(STRUCTURAL_CRITERIA.length, 5);
  assert.equal(JUDGMENT_CRITERIA.length, 5);
  // structural criteria carry no weight toward the A/B signal.
  for (const c of STRUCTURAL_CRITERIA) assert.equal(c.weight, 0);
});

/* ------------------------------------------------------------------ structural scoring */

test("scoreStructural gives 2/2 on every structural criterion for the shipped 2d-shooter fixture", () => {
  const res = scoreStructural(shooterFixture());
  assert.deepEqual(res.issues, [], `unexpected validator issues: ${JSON.stringify(res.issues)}`);
  assert.equal(res.total, 10);
  assert.equal(res.maxTotal, 10);
  assert.equal(res.allClean, true);
  for (const c of res.criteria) {
    assert.equal(c.score, 2, `criterion ${c.id} expected 2/2, got ${c.score} (${c.note})`);
  }
  assert.equal(res.genreClass, "twitch");
});

test("scoreStructural gives 2/2 on the minimal valid base", () => {
  const res = scoreStructural(validBase());
  assert.equal(res.allClean, true);
  assert.equal(res.total, 10);
});

test("an invalid contract scores low structurally", () => {
  // break validity broadly: empty object.
  const res = scoreStructural({});
  assert.equal(res.allClean, false);
  assert.equal(res.criteria.find((c) => c.id === "schema-valid")!.score, 0);
  assert.ok(res.total < 10, "broken contract should not score a clean 10");
  assert.ok(res.issues.length > 0);
});

test("a contract missing tunables + measurabilityMap zeroes those structural criteria", () => {
  const c = validBase() as unknown as Record<string, unknown>;
  c.tunables = [];
  c.measurabilityMap = [];
  const res = scoreStructural(c);
  assert.equal(res.criteria.find((x) => x.id === "tunables-named")!.score, 0);
  assert.equal(res.criteria.find((x) => x.id === "measurability-map-bound")!.score, 0);
  assert.equal(res.criteria.find((x) => x.id === "schema-valid")!.score, 0);
});

/* ------------------------------------------------------------------ genre-class weighting */

test("systems weighting de-emphasizes bands and boosts oracle coverage vs twitch", () => {
  assert.ok(judgmentWeightFor("systems", "sensible-bands") < judgmentWeightFor("twitch", "sensible-bands"));
  assert.ok(judgmentWeightFor("systems", "oracle-coverage") > judgmentWeightFor("twitch", "oracle-coverage"));
});

/* ------------------------------------------------------------------ verdict: independence refusal */

function brief(
  briefId: string,
  feJudgment: JudgmentScores,
  vanJudgment: JudgmentScores,
  independence: IndependenceAttestation,
  genreClass?: GenreContract["coreLoop"]["genreClass"],
): AbBriefInput {
  return {
    briefId,
    genreClass,
    frontEnd: { label: "front-end", contract: validBase(), judgment: feJudgment },
    vanilla: { label: "vanilla", contract: validBase(), judgment: vanJudgment },
    independence,
  };
}

test("verdict REFUSES a win when independence is absent (independent !== true)", () => {
  const v = computeAbBriefVerdict(
    brief("b", goodJudgment, weakJudgment, { independent: false, reviewerCount: 5 }),
  );
  assert.equal(v.beatsVanilla, true, "margin alone is met");
  assert.equal(v.certifiedWin, false, "but it must NOT certify without independence");
  assert.ok(v.refusals.some((r) => /independence absent/.test(r)));
});

test("verdict REFUSES a win when reviewerCount < 2", () => {
  const v = computeAbBriefVerdict(
    brief("b", goodJudgment, weakJudgment, { independent: true, reviewerCount: 1 }),
  );
  assert.equal(v.beatsVanilla, true);
  assert.equal(v.certifiedWin, false);
  assert.ok(v.refusals.some((r) => /reviewerCount must be >= 2/.test(r)));
});

/* ------------------------------------------------------------------ verdict: clean win */

test("a clean win: independence present + judgment margin met", () => {
  const v = computeAbBriefVerdict(brief("b", goodJudgment, weakJudgment, realIndependence));
  assert.equal(v.refusals.length, 0);
  assert.equal(v.beatsVanilla, true);
  assert.equal(v.certifiedWin, true);
  assert.ok(v.marginPct >= DEFAULT_AB_BAR.marginPct);
  // both sides are structurally clean (parity) — the signal is judgment only.
  assert.equal(v.frontEnd.structural.allClean, true);
  assert.equal(v.vanilla.structural.allClean, true);
});

test("no win when the margin is not met even with independence present", () => {
  // front-end and vanilla tie on judgment -> zero margin.
  const v = computeAbBriefVerdict(brief("b", goodJudgment, goodJudgment, realIndependence));
  assert.equal(v.beatsVanilla, false);
  assert.equal(v.certifiedWin, false);
});

test("judgment caps prevent invalid measurement claims from receiving full subjective credit", () => {
  const invalidVanilla = validBase() as unknown as Record<string, unknown>;
  invalidVanilla.measurabilityMap = [
    {
      target: "fireIntervalMs",
      tag: "measurable-now",
      calculator: "event-cadence",
      band: { min: 3, max: 12, unit: "shots/s" },
      evidenceKind: "agent-guess",
      bucket: "coreVertical",
    },
    {
      target: "combat-feel",
      tag: "judgment-only",
      bucket: "coreVertical",
    },
  ];
  invalidVanilla.humanOracleChecks = [];

  const v = computeAbBriefVerdict({
    briefId: "invalid-vanilla",
    genreClass: "twitch",
    frontEnd: { label: "front-end", contract: validBase(), judgment: weakJudgment },
    vanilla: { label: "vanilla", contract: invalidVanilla, judgment: goodJudgment },
    independence: realIndependence,
  });

  assert.equal(v.vanilla.judgment["sensible-bands"], 1);
  assert.equal(v.vanilla.judgment["honest-measurability"], 1);
  assert.equal(v.vanilla.judgment["oracle-coverage"], 1);
  assert.deepEqual(
    v.vanilla.judgmentCaps.map((c) => c.id),
    ["sensible-bands", "honest-measurability", "oracle-coverage"],
  );
});

/* ------------------------------------------------------------------ milestone verdict */

test("milestone beats vanilla across 3 briefs spanning genre-classes", () => {
  const briefs = [
    brief("twitch-1", goodJudgment, weakJudgment, realIndependence, "twitch"),
    brief("hybrid-1", goodJudgment, weakJudgment, realIndependence, "hybrid"),
    brief("systems-1", goodJudgment, weakJudgment, realIndependence, "systems"),
  ];
  const m = computeAbMilestoneVerdict(briefs);
  assert.equal(m.breadthMet, true);
  assert.equal(m.beatsVanilla, true);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.genreClassesCovered.length, 3);
});

test("milestone refuses with fewer than 3 briefs", () => {
  const m = computeAbMilestoneVerdict([
    brief("a", goodJudgment, weakJudgment, realIndependence, "twitch"),
    brief("b", goodJudgment, weakJudgment, realIndependence, "systems"),
  ]);
  assert.equal(m.breadthMet, false);
  assert.equal(m.beatsVanilla, false);
  assert.ok(m.refusals.some((r) => /need >=3/.test(r)));
});

test("milestone refuses when one brief lacks independence, even if others win", () => {
  const m = computeAbMilestoneVerdict([
    brief("ok-1", goodJudgment, weakJudgment, realIndependence, "twitch"),
    brief("ok-2", goodJudgment, weakJudgment, realIndependence, "hybrid"),
    brief("bad", goodJudgment, weakJudgment, { independent: false, reviewerCount: 4 }, "systems"),
  ]);
  assert.equal(m.beatsVanilla, false);
  assert.ok(m.refusals.some((r) => /brief "bad".*independence absent/.test(r)));
});
