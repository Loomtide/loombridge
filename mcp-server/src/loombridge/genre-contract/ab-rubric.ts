/**
 * "Beats vanilla" A/B rubric + independent-grader harness.
 *
 * Companion to AB-RUBRIC.md. The milestone success test ("beats vanilla") is: the genre-contract
 * elicitation FRONT-END (side A) must beat a vanilla Claude/Codex baseline on the SAME brief
 * (side B), scored by an INDEPENDENT grader (≥2 reviewers, no access to the authoring transcript),
 * across ≥3 briefs spanning genre-classes, by a defined margin on the JUDGMENT criteria.
 *
 * This module is the deterministic spine of that test. It does TWO things and refuses to do a third:
 *   1. STRUCTURAL scoring (`scoreStructural`) — runs the FROZEN `validateGenreContract` plus a few
 *      structural-presence checks and emits a per-criterion 0/1/2. Structural criteria are expected
 *      to be 2/2 — they prove "the schema did its job," NOT quality, so they are NOT the A/B signal.
 *   2. VERDICT (`computeAbVerdict`) — given the structural scores for BOTH sides AND the JUDGMENT
 *      scores supplied by external independent reviewers, computes win/no-win against the bar.
 *
 * It deliberately does NOT call an LLM. The judgment scores are INPUTS. And — mirroring the moat's
 * refuse-on-absent-binding discipline (see CLAUDE.md "verification invariants") — it REFUSES to
 * certify a win unless a real independence attestation is present (`independent === true` AND
 * `reviewerCount >= 2`). Absent independence is a refusal, never a silently-passed check.
 */

import { validateGenreContract } from "./validator.js";
import type { GenreClass, GenreContractIssue } from "./types.js";

/* ------------------------------------------------------------------ criteria model */

export type CriterionKind = "structural" | "judgment";

export interface RubricCriterion {
  /** stable id, used as the key in score maps. */
  id: string;
  /** human label for the rubric / report. */
  label: string;
  /** structural = machine-scored (expected 2/2, NOT quality); judgment = the real A/B signal. */
  kind: CriterionKind;
  /**
   * base weight applied when summing the JUDGMENT score (structural criteria carry weight 0 toward
   * the A/B signal by construction — they are reported but never tip the verdict).
   */
  weight: number;
  /** one-line description of what 2/2 means. */
  rubric: string;
}

/**
 * The 10 criteria. The first five are STRUCTURAL (the validator / structural-presence checks own
 * them, expected 2/2); the last five are JUDGMENT (the independent reviewers own them — the real
 * "beats vanilla" signal).
 */
export const AB_RUBRIC_CRITERIA: readonly RubricCriterion[] = [
  // ---- STRUCTURAL (machine-scored; expected 2/2; weight 0 toward the A/B signal) ----
  {
    id: "schema-valid",
    label: "Schema-valid contract",
    kind: "structural",
    weight: 0,
    rubric: "validateGenreContract returns valid:true (all 12 fields present + closed-set bound).",
  },
  {
    id: "tunables-named",
    label: "Tunables named",
    kind: "structural",
    weight: 0,
    rubric: "≥1 named runtime-tunable feel parameter (no magic constants), each with an id.",
  },
  {
    id: "measurability-map-bound",
    label: "Measurability map bound",
    kind: "structural",
    weight: 0,
    rubric:
      "non-empty measurabilityMap; every measurable-now row binds to an IMPLEMENTED calculator; no judgment-only dodge.",
  },
  {
    id: "vertical-split",
    label: "coreVertical / deferredMeta split",
    kind: "structural",
    weight: 0,
    rubric: "vertical-first: budget declares core content; no meta kind smuggled into coreVertical.",
  },
  {
    id: "refusals-present",
    label: "Refusal conditions present",
    kind: "structural",
    weight: 0,
    rubric: "≥1 refusalCondition AND every judgment-only target carries a matching humanOracleCheck.",
  },

  // ---- JUDGMENT (independent reviewers; the real A/B signal) ----
  {
    id: "right-sub-genre",
    label: "Right sub-genre & core loop",
    kind: "judgment",
    weight: 1,
    rubric: "sub-genre / perspective / genreClass match the brief's actual genre; loop is the real moment-to-moment.",
  },
  {
    id: "sensible-bands",
    label: "Sensible, reference-anchored bands",
    kind: "judgment",
    weight: 1,
    rubric: "feel bands are plausible for the genre and anchored to references/exemplars, not arbitrary guesses.",
  },
  {
    id: "real-asset-set",
    label: "Real asset set",
    kind: "judgment",
    weight: 1,
    rubric: "assetRoles / art direction cover what the genre actually needs (not a generic placeholder set).",
  },
  {
    id: "honest-measurability",
    label: "Honest measurability tagging",
    kind: "judgment",
    weight: 1,
    rubric: "tags reflect what Loombridge can truly measure today; backlog is scoped honestly, not faked green.",
  },
  {
    id: "oracle-coverage",
    label: "Correct genreClass + oracle coverage",
    kind: "judgment",
    weight: 1,
    rubric: "genreClass is right and judgment-only aspects get meaningful human-oracle checks (load-bearing for systems).",
  },
];

export const STRUCTURAL_CRITERIA: readonly RubricCriterion[] = AB_RUBRIC_CRITERIA.filter(
  (c) => c.kind === "structural",
);
export const JUDGMENT_CRITERIA: readonly RubricCriterion[] = AB_RUBRIC_CRITERIA.filter(
  (c) => c.kind === "judgment",
);

/** A single criterion score, 0/1/2. */
export type Score = 0 | 1 | 2;
export const MAX_SCORE: Score = 2;

/* ------------------------------------------------------------------ genre-class weighting */

/**
 * Genre-class-aware weighting of the JUDGMENT criteria. A `systems` genre legitimately has fewer
 * MEASURABLE bands, so `sensible-bands` carries less weight there and the oracle-coverage criterion
 * carries more — a systems brief is not penalized for honestly being mostly judgment-only.
 * Weights MULTIPLY the per-criterion base weight; the achievable max is normalized per side so the
 * margin is comparable across classes.
 */
export type JudgmentWeighting = Record<string, number>;

const CLASS_JUDGMENT_WEIGHTS: Record<GenreClass, JudgmentWeighting> = {
  twitch: {
    "right-sub-genre": 1,
    "sensible-bands": 1.25,
    "real-asset-set": 1,
    "honest-measurability": 1.25,
    "oracle-coverage": 0.75,
  },
  hybrid: {
    "right-sub-genre": 1,
    "sensible-bands": 1,
    "real-asset-set": 1,
    "honest-measurability": 1,
    "oracle-coverage": 1,
  },
  systems: {
    "right-sub-genre": 1.25,
    "sensible-bands": 0.5,
    "real-asset-set": 1,
    "honest-measurability": 1,
    "oracle-coverage": 1.25,
  },
};

/** Resolve the per-criterion judgment weight for a genre class (defaults to the criterion base weight). */
export function judgmentWeightFor(genreClass: GenreClass, criterionId: string): number {
  const table = CLASS_JUDGMENT_WEIGHTS[genreClass];
  const base = JUDGMENT_CRITERIA.find((c) => c.id === criterionId)?.weight ?? 0;
  const mult = table?.[criterionId] ?? 1;
  return base * mult;
}

/* ------------------------------------------------------------------ structural scoring */

/** Per-criterion score plus a one-line note on why. */
export interface CriterionResult {
  id: string;
  kind: CriterionKind;
  score: Score;
  note: string;
}

export interface StructuralScoreResult {
  /** the 5 structural per-criterion scores. */
  criteria: CriterionResult[];
  /** sum of the structural scores (max 10). */
  total: number;
  /** max achievable structural total (10). */
  maxTotal: number;
  /** every structural criterion scored 2/2. */
  allClean: boolean;
  /** validator issues, surfaced for the report. */
  issues: GenreContractIssue[];
  /** the contract's genreClass when it could be resolved (drives judgment weighting). */
  genreClass: GenreClass | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Issues whose path begins with one of the given prefixes (used to scope a structural criterion). */
function issuesUnder(issues: GenreContractIssue[], prefixes: string[]): GenreContractIssue[] {
  return issues.filter((i) => prefixes.some((p) => i.path === p || i.path.startsWith(p)));
}

/**
 * Deterministically score ONLY the structural criteria. Uses the FROZEN validator for validity +
 * structural-presence, then maps issue paths to the relevant criterion. A criterion with no issues
 * scores 2; a criterion with a partial signal (present-but-flawed) scores 1; a criterion whose core
 * binding is absent/invalid scores 0.
 */
export function scoreStructural(contract: unknown): StructuralScoreResult {
  const { valid, issues } = validateGenreContract(contract);
  const genreClass =
    isRecord(contract) && isRecord(contract.coreLoop) && typeof contract.coreLoop.genreClass === "string"
      ? (contract.coreLoop.genreClass as GenreClass)
      : null;

  const c = (contract ?? {}) as Record<string, unknown>;

  const results: CriterionResult[] = [];

  // 1. schema-valid — the whole-contract validity gate.
  results.push({
    id: "schema-valid",
    kind: "structural",
    score: valid ? 2 : 0,
    note: valid ? "validateGenreContract: valid" : `validator returned ${issues.length} issue(s)`,
  });

  // 2. tunables-named.
  {
    const tunables = c.tunables;
    const tunIssues = issuesUnder(issues, ["tunables"]);
    let score: Score = 0;
    let note = "tunables missing or not an array";
    if (Array.isArray(tunables) && tunables.length > 0) {
      if (tunIssues.length === 0) {
        score = 2;
        note = `${tunables.length} named tunable(s)`;
      } else {
        score = 1;
        note = `tunables present but ${tunIssues.length} issue(s) (e.g. bad unit)`;
      }
    }
    results.push({ id: "tunables-named", kind: "structural", score, note });
  }

  // 3. measurability-map-bound.
  {
    const map = c.measurabilityMap;
    const mapIssues = issuesUnder(issues, ["measurabilityMap"]);
    let score: Score = 0;
    let note = "measurabilityMap missing or empty";
    if (Array.isArray(map) && map.length > 0) {
      if (mapIssues.length === 0) {
        score = 2;
        note = `${map.length} bound measurability row(s)`;
      } else {
        score = 1;
        note = `map present but ${mapIssues.length} binding issue(s)`;
      }
    }
    results.push({ id: "measurability-map-bound", kind: "structural", score, note });
  }

  // 4. vertical-split — budget declares core content AND no vertical-first violation.
  {
    const budget = c.verticalSliceBudget;
    const splitIssues = issuesUnder(issues, [
      "verticalSliceBudget",
      "sliceDag",
    ]).filter((i) => i.code.startsWith("BUDGET") || i.code.startsWith("CORE_VERTICAL") || i.code === "SLICE_DAG");
    const hasCore =
      isRecord(budget) &&
      isRecord(budget.coreVerticalContent) &&
      Object.keys(budget.coreVerticalContent).length > 0 &&
      isRecord(c.sliceDag) &&
      Array.isArray((c.sliceDag as Record<string, unknown>).coreVertical) &&
      Array.isArray((c.sliceDag as Record<string, unknown>).deferredMeta);
    let score: Score = 0;
    let note = "no coreVertical content / deferredMeta split declared";
    if (hasCore) {
      if (splitIssues.length === 0) {
        score = 2;
        note = "vertical-first split clean";
      } else {
        score = 1;
        note = `split declared but ${splitIssues.length} issue(s)`;
      }
    }
    results.push({ id: "vertical-split", kind: "structural", score, note });
  }

  // 5. refusals-present — ≥1 refusalCondition AND no judgment-only-without-oracle issue.
  {
    const refusals = c.refusalConditions;
    const oracleGap = issues.some((i) => i.code === "JUDGMENT_ONLY_NO_ORACLE");
    const refusalIssues = issuesUnder(issues, ["refusalConditions", "humanOracleChecks"]);
    let score: Score = 0;
    let note = "no refusalConditions declared";
    if (Array.isArray(refusals) && refusals.length > 0) {
      if (refusalIssues.length === 0 && !oracleGap) {
        score = 2;
        note = `${refusals.length} refusal(s); judgment-only targets covered`;
      } else {
        score = 1;
        note = oracleGap
          ? "refusals present but a judgment-only target lacks an oracle check"
          : `refusals present but ${refusalIssues.length} issue(s)`;
      }
    }
    results.push({ id: "refusals-present", kind: "structural", score, note });
  }

  const total = results.reduce((s, r) => s + r.score, 0);
  const maxTotal = STRUCTURAL_CRITERIA.length * MAX_SCORE;
  return {
    criteria: results,
    total,
    maxTotal,
    allClean: results.every((r) => r.score === MAX_SCORE),
    issues,
    genreClass,
  };
}

/* ------------------------------------------------------------------ independence attestation */

/**
 * Recorded independence attestation, mirroring the `doneness` independent/reviewerCount≥2 rule.
 * A win cannot be certified unless `independent === true` AND `reviewerCount >= 2`.
 */
export interface IndependenceAttestation {
  /** reviewers had NO access to the authoring transcript and graded from a fresh context. */
  independent: boolean;
  /** number of independent reviewers (must be ≥2). */
  reviewerCount: number;
  /** optional reviewer ids / attestation artifact references for audit. */
  reviewerIds?: string[];
  /** optional recorded attestation note. */
  attestation?: string;
}

/* ------------------------------------------------------------------ judgment input + per-side */

/** Judgment scores supplied by external independent reviewers, keyed by criterion id (0/1/2). */
export type JudgmentScores = Record<string, Score>;

/** A single side (A = front-end, B = vanilla baseline) of one brief. */
export interface AbSide {
  /** "front-end" (the elicitation contract) or "vanilla" (the baseline contract). */
  label: string;
  /** the contract this side produced (scored structurally here). */
  contract: unknown;
  /** the independent reviewers' judgment scores for this side. */
  judgment: JudgmentScores;
}

/** One brief's A/B input. */
export interface AbBriefInput {
  briefId: string;
  /** genre-class of the brief — drives judgment weighting; falls back to the contract's class. */
  genreClass?: GenreClass;
  frontEnd: AbSide;
  vanilla: AbSide;
  independence: IndependenceAttestation;
}

/** The defined bar: front-end must beat vanilla by ≥ `marginPct` of the achievable judgment max. */
export interface AbBar {
  /** required margin as a fraction of the achievable weighted judgment max (e.g. 0.2 = 20%). */
  marginPct: number;
}

export const DEFAULT_AB_BAR: AbBar = { marginPct: 0.2 };

/* ------------------------------------------------------------------ per-side judgment scoring */

export interface SideResult {
  label: string;
  structural: StructuralScoreResult;
  /** reviewer-supplied judgment after deterministic evidence caps are applied. */
  judgment: JudgmentScores;
  /** deterministic caps applied to reviewer judgment because the contract disproves the claim. */
  judgmentCaps: CriterionResult[];
  /** weighted judgment total for this side (genre-class-aware). */
  judgmentWeighted: number;
  /** max achievable weighted judgment total (same for both sides of a brief). */
  judgmentMax: number;
}

function hasIssue(issues: GenreContractIssue[], codes: readonly string[]): boolean {
  return issues.some((i) => codes.includes(i.code));
}

function capScore(raw: Score, max: Score): Score {
  return raw > max ? max : raw;
}

/**
 * Independent reviewers own the subjective scores, but a contract cannot receive full credit for a
 * judgment criterion that its validator issues already disprove. These caps keep the A/B harness
 * from rewarding confident-looking prose for unsupported calculators, unsigned guess bands, or
 * missing oracle coverage. They do not judge asset quality or sub-genre fit; those remain reviewer
 * calls.
 */
function applyJudgmentCaps(
  judgment: JudgmentScores,
  structural: StructuralScoreResult,
): { capped: JudgmentScores; caps: CriterionResult[] } {
  const capped: JudgmentScores = { ...judgment };
  const caps: CriterionResult[] = [];
  const issues = structural.issues;

  const cap = (id: string, max: Score, note: string) => {
    const raw = capped[id];
    const s: Score = raw === 0 || raw === 1 || raw === 2 ? raw : 0;
    const next = capScore(s, max);
    capped[id] = next;
    if (next < s) {
      caps.push({ id, kind: "judgment", score: next, note });
    }
  };

  if (
    hasIssue(issues, [
      "BAND_UNIT",
      "BAND_EMPTY",
      "BAND_RANGE",
      "AGENT_GUESS_NO_SIGNOFF",
    ])
  ) {
    cap("sensible-bands", 1, "validator rejected band evidence/unit/signoff; max 1/2");
  }

  if (
    hasIssue(issues, [
      "MEASURABLE_NOW_UNIMPLEMENTED",
      "MEASURABLE_NOW_NO_CALC",
      "JUDGMENT_ONLY_HAS_CALC",
      "AGENT_GUESS_NO_SIGNOFF",
    ])
  ) {
    cap("honest-measurability", 1, "validator rejected measurability binding; max 1/2");
  }

  if (hasIssue(issues, ["JUDGMENT_ONLY_NO_ORACLE", "ORACLE_CHECK", "REFUSAL_CONDITION"])) {
    cap("oracle-coverage", 1, "validator found missing/refused oracle coverage; max 1/2");
  }

  return { capped, caps };
}

function scoreJudgmentWeighted(
  judgment: JudgmentScores,
  genreClass: GenreClass,
): { weighted: number; max: number } {
  let weighted = 0;
  let max = 0;
  for (const crit of JUDGMENT_CRITERIA) {
    const w = judgmentWeightFor(genreClass, crit.id);
    max += w * MAX_SCORE;
    const raw = judgment[crit.id];
    const s: number = raw === 0 || raw === 1 || raw === 2 ? raw : 0;
    weighted += w * s;
  }
  return { weighted, max };
}

/* ------------------------------------------------------------------ verdict */

export interface AbBriefVerdict {
  briefId: string;
  genreClass: GenreClass;
  frontEnd: SideResult;
  vanilla: SideResult;
  /** absolute weighted-judgment margin (frontEnd − vanilla). */
  margin: number;
  /** margin as a fraction of the achievable judgment max. */
  marginPct: number;
  /** required margin fraction from the bar. */
  requiredMarginPct: number;
  /** this brief, on its own, cleared the bar. */
  beatsVanilla: boolean;
  /**
   * the verdict CERTIFIES a win for this brief. Always false when independence is absent, regardless
   * of margin — refuse-on-absent-binding discipline.
   */
  certifiedWin: boolean;
  /** refusal reasons (independence missing, etc.); non-empty ⇒ certifiedWin is false. */
  refusals: string[];
}

/**
 * Compute a single brief's verdict. REFUSES to certify a win when independence is absent
 * (`independent !== true || reviewerCount < 2`) — mirroring the moat's refuse-on-absent-binding rule.
 */
export function computeAbBriefVerdict(brief: AbBriefInput, bar: AbBar = DEFAULT_AB_BAR): AbBriefVerdict {
  const feStructural = scoreStructural(brief.frontEnd.contract);
  const vanStructural = scoreStructural(brief.vanilla.contract);

  // genreClass: explicit on the brief, else the front-end contract's, else vanilla's, else twitch.
  const genreClass: GenreClass =
    brief.genreClass ?? feStructural.genreClass ?? vanStructural.genreClass ?? "twitch";

  const feJudgment = applyJudgmentCaps(brief.frontEnd.judgment, feStructural);
  const vanJudgment = applyJudgmentCaps(brief.vanilla.judgment, vanStructural);

  const fe = scoreJudgmentWeighted(feJudgment.capped, genreClass);
  const van = scoreJudgmentWeighted(vanJudgment.capped, genreClass);

  const frontEnd: SideResult = {
    label: brief.frontEnd.label,
    structural: feStructural,
    judgment: feJudgment.capped,
    judgmentCaps: feJudgment.caps,
    judgmentWeighted: fe.weighted,
    judgmentMax: fe.max,
  };
  const vanilla: SideResult = {
    label: brief.vanilla.label,
    structural: vanStructural,
    judgment: vanJudgment.capped,
    judgmentCaps: vanJudgment.caps,
    judgmentWeighted: van.weighted,
    judgmentMax: van.max,
  };

  const margin = fe.weighted - van.weighted;
  const marginPct = fe.max > 0 ? margin / fe.max : 0;
  const beatsVanilla = marginPct >= bar.marginPct;

  // REFUSE certification unless independence is genuinely present.
  const refusals: string[] = [];
  const ind = brief.independence;
  if (!ind || ind.independent !== true) {
    refusals.push("independence absent: attestation.independent must be true (no authoring-transcript access)");
  }
  if (!ind || typeof ind.reviewerCount !== "number" || ind.reviewerCount < 2) {
    refusals.push("insufficient reviewers: reviewerCount must be >= 2");
  }

  const certifiedWin = refusals.length === 0 && beatsVanilla;

  return {
    briefId: brief.briefId,
    genreClass,
    frontEnd,
    vanilla,
    margin,
    marginPct,
    requiredMarginPct: bar.marginPct,
    beatsVanilla,
    certifiedWin,
    refusals,
  };
}

/* ------------------------------------------------------------------ milestone-level verdict */

export interface AbMilestoneVerdict {
  briefs: AbBriefVerdict[];
  /** distinct genre-classes covered by the briefs. */
  genreClassesCovered: GenreClass[];
  /** ≥3 briefs spanning ≥2 distinct genre-classes (the success-test breadth requirement). */
  breadthMet: boolean;
  /** every brief certified a win (independence present + bar cleared on every brief). */
  beatsVanilla: boolean;
  /** refusal reasons aggregated across briefs + breadth. */
  refusals: string[];
}

/**
 * Compute the milestone verdict over ≥3 briefs. "Beats vanilla" is certified ONLY when:
 *   - breadth is met (≥3 briefs spanning ≥2 distinct genre-classes), AND
 *   - EVERY brief certifies a win (independence present on every brief + bar cleared on every brief).
 * A single brief lacking independence or missing the bar sinks the milestone — never a partial pass.
 */
export function computeAbMilestoneVerdict(
  briefs: AbBriefInput[],
  bar: AbBar = DEFAULT_AB_BAR,
): AbMilestoneVerdict {
  const verdicts = briefs.map((b) => computeAbBriefVerdict(b, bar));
  const classes = Array.from(new Set(verdicts.map((v) => v.genreClass)));

  const refusals: string[] = [];
  const breadthMet = verdicts.length >= 3 && classes.length >= 2;
  if (verdicts.length < 3) {
    refusals.push(`breadth: ${verdicts.length} brief(s); need >=3 spanning genre-classes`);
  }
  if (classes.length < 2) {
    refusals.push(`breadth: ${classes.length} genre-class(es) covered; need >=2 distinct`);
  }
  for (const v of verdicts) {
    for (const r of v.refusals) refusals.push(`brief "${v.briefId}": ${r}`);
    if (v.refusals.length === 0 && !v.beatsVanilla) {
      refusals.push(`brief "${v.briefId}": did not clear the bar (margin ${(v.marginPct * 100).toFixed(1)}% < ${(bar.marginPct * 100).toFixed(0)}%)`);
    }
  }

  const beatsVanilla = breadthMet && verdicts.every((v) => v.certifiedWin);

  return {
    briefs: verdicts,
    genreClassesCovered: classes,
    breadthMet,
    beatsVanilla,
    refusals,
  };
}
