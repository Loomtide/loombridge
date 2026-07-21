/**
 * Genre Contract validator — the enforcement moat for the plan-time elicitation front-end.
 *
 * Mirrors the hand-rolled, closed-set refusal discipline of `slices.ts` and the platformer-profile
 * validator: collect `{ code, message, path }` issues, then either return them (non-throwing) or throw
 * a single joined error. The whole point is that a contract cannot LIE — every measurable/gate/unit
 * claim binds to a closed set that reflects what Loomtide can actually do today.
 *
 * Refusal rules (an absent bound field is a refusal, never a silently-skipped check):
 *  R1  structural — required fields present + typed; enums in their closed sets; schemaVersion matches.
 *  R2  gates — every slice gate id must be in SUPPORTED_GATE_IDS.
 *  R3  gates/gaps invariant — every slice declares at least one of gates/gaps (both allowed).
 *  R4  DAG — dependsOn ids resolve within the contract; no cycles.
 *  R5  measurable-now binding — calculator present AND in IMPLEMENTED_CALCULATOR_IDS (NOT the banded
 *      vocabulary). A judgment-only target that HAS an implemented calculator is refused (no dodging).
 *  R6  band provenance — a band requires an evidenceKind; an `agent-guess` band on a coreVertical
 *      target requires an out-of-band operator sign-off (artifact + 64-hex sha256), not a self-flag.
 *  R7  units — tunable/band units, when present, must be in SUPPORTED_PROFILE_UNIT_SET.
 *  R8  vertical-first — no coreVertical slice may carry a meta `kind` (forbidden set or the contract's
 *      own deferred list); coreVerticalContent must be declared.
 *  R9  genre-class completeness — keyed by the closed genreClass enum: twitch/hybrid must commit to at
 *      least one measurable feel target; every judgment-only target needs a matching humanOracleCheck.
 */

import { SUPPORTED_GATE_IDS } from "../../verification/run-gates.js";
import { REDERIVABLE_METRICS } from "../../verification/feel-derive.js";
import { EVIDENCE_CLASS_SET, EVIDENCE_CLASSES } from "../../verification/gates/evidence-classes.js";
import { MEASURABLE_METRICS, SUPPORTED_PROFILE_UNIT_SET } from "../feel-primitives.js";
import { isSafeCapturePath } from "../capture-paths.js";
import {
  GENRE_CONTRACT_SCHEMA_VERSION,
  GENRE_CLASS_SET,
  MEASURABILITY_TAG_SET,
  EVIDENCE_KIND_SET,
  CONTRACT_CONFIDENCE_SET,
  type GenreClass,
  type GenreContract,
  type GenreContractIssue,
  type GenreContractValidationResult,
} from "./types.js";

/**
 * The set of feel metrics with an ACTUALLY-IMPLEMENTED calculator today. A `measurable-now` claim
 * binds to this set. Deliberately NOT `KNOWN_PROFILE_METRIC_IDS` (the banded vocabulary), which
 * contains ids with no calculator (maxFallSpeed, hitStopMs, dashTime, …) — binding to that would
 * re-open the false-green. Each entry is an implemented `derive*` sync calculator in
 * feel-derive.ts. (Decoupling will replace this assembly with a single-sourced export.)
 */
const IMPLEMENTED_SYNC_METRICS = [
  "inputToSfxLatency",
  "dashToGhostMs",
  "groundContactToDustMs",
  "inputToAnimStateLatency",
  "fireIntervalMs",
  "fireInputToSpawnLatency",
  "ttkMs",
] as const;
/** Probe-measured metrics (runtime.probe path, e.g. forceDash + measure ΔX) — measurable today. */
const IMPLEMENTED_PROBE_METRICS = ["dashDistance"] as const;
/**
 * Shooter combat-feedback ("juice") calculators: `hitstopMs` (impact-freeze window duration, from a
 * sampled hit-stop signal series) and `screenShakeMag` (peak camera displacement, from the sampled
 * camera transform trajectory). Each entry is an implemented `derive*` calculator in feel-derive.ts
 * (deriveHitstopMs / deriveScreenShakeMag). NOTE: lowercase `hitstopMs` is the shooter calculator id —
 * distinct from the platformer banded-vocabulary id `hitStopMs`, which still has NO calculator.
 */
const IMPLEMENTED_IMPACT_METRICS = ["hitstopMs", "screenShakeMag"] as const;
/**
 * Hitscan weapon calculator: `hitscanImpactLatencyMs` (fire input onset → raycast hit edge, proven to
 * causally drive damage via the fire→hit→damage ordering). Implemented as `deriveHitscanImpactLatencyMs`
 * in feel-derive.ts. Distinct from the projectile loop (`fireInputToSpawnLatency`/`ttkMs`): the raycast
 * resolves instantaneously on the fire frame, so this is the hitscan-specific impact-latency metric.
 */
const IMPLEMENTED_HITSCAN_METRICS = ["hitscanImpactLatencyMs"] as const;
/**
 * Enemy AI perception/reaction calculator: `enemyReactionLatencyMs` (perception edge → first reaction
 * edge, gated on a real perception edge that precedes the reaction). Implemented as
 * `deriveEnemyReactionLatencyMs` in feel-derive.ts. NARROW: perception/reaction latency only — not a
 * behavior tree, tactical movement, accuracy model, or broad combat AI (those remain explicit gaps).
 */
const IMPLEMENTED_AI_METRICS = ["enemyReactionLatencyMs"] as const;
/**
 * Cover proof calculator: `coverBlocksDamage` (a boolean LOS/damage-prevention proof from a covered +
 * exposed capture pair). Implemented as `deriveCoverBlocksDamage` in feel-derive.ts. NARROW: cover as
 * geometric line-of-sight + damage prevention only — NOT a tactical planner, cover-point generation,
 * navmesh safe areas, peeking, or AI cover selection (those remain explicit gaps).
 */
const IMPLEMENTED_COVER_METRICS = ["coverBlocksDamage"] as const;
/**
 * Wave/objective proof calculator: `waveObjectiveComplete` (a boolean spawn-N → kill-all →
 * objective-complete sequence proof). Implemented as `deriveWaveObjectiveComplete` in feel-derive.ts.
 * NARROW: a single deterministic wave/objective edge only — NOT multi-wave pacing, a spawn director,
 * difficulty curves, boss waves, or mission design (those remain explicit gaps).
 */
const IMPLEMENTED_WAVE_METRICS = ["waveObjectiveComplete"] as const;
/**
 * 3C controller/camera calculators: `lookInputToYawLatencyMs` (look-input onset → first sampled
 * /Player yaw response) + `shotAimAlignmentDeg` (angle between AimForward and the fired shot
 * direction). Implemented as `deriveLookInputToYawLatencyMs` / `deriveShotAimAlignmentDeg` in
 * feel-derive.ts. Promoted with committed live evidence (demo-bundles/3d-shooter-3c-controller-camera:
 * raw capture + generator re-derive through the production calculators). NARROW: look responsiveness +
 * shot/aim alignment only — recoil, ADS, and aim fairness remain explicit gaps.
 */
const IMPLEMENTED_CONTROL_METRICS = ["lookInputToYawLatencyMs", "shotAimAlignmentDeg"] as const;
/**
 * Movement wall-slide calculator: `wallSlideTangentRatio` (the fraction of the input's tangential
 * speed a character preserves while pinned against a wall — 1.0 ≈ a perfect collide-and-slide, 0 =
 * the FROZEN dogfood controller). Implemented as `deriveWallSlideTangentRatio` in feel-derive.ts
 * (dogfood learnings §2 "Wall-Slide Is A Feel Gate, Not A Bugfix Detail", backlog High #2). NARROW: diagonal-
 * into-obstacle tangent preservation + an optional collider-friction audit only — NOT a full
 * character-controller physics model, ledge/step handling, or slope behaviour (those remain gaps).
 */
const IMPLEMENTED_MOVEMENT_METRICS = ["wallSlideTangentRatio"] as const;
export const IMPLEMENTED_CALCULATOR_IDS: ReadonlySet<string> = new Set<string>([
  ...REDERIVABLE_METRICS, // trajectory/rotation re-derivable metrics
  ...MEASURABLE_METRICS, // adds coyoteTime / jumpBuffer (bisection)
  ...IMPLEMENTED_SYNC_METRICS, // 4 cross-modal latency calculators
  ...IMPLEMENTED_PROBE_METRICS, // dashDistance (probe)
  ...IMPLEMENTED_IMPACT_METRICS, // hitstopMs / screenShakeMag (shooter polish)
  ...IMPLEMENTED_HITSCAN_METRICS, // hitscanImpactLatencyMs (hitscan weapon)
  ...IMPLEMENTED_AI_METRICS, // enemyReactionLatencyMs (AI perception/reaction)
  ...IMPLEMENTED_COVER_METRICS, // coverBlocksDamage (cover LOS/damage proof)
  ...IMPLEMENTED_WAVE_METRICS, // waveObjectiveComplete (wave/objective sequence)
  ...IMPLEMENTED_CONTROL_METRICS, // 3C controller/camera: look latency + shot/aim alignment
  ...IMPLEMENTED_MOVEMENT_METRICS, // wallSlideTangentRatio (wall-slide tangent preservation)
]);

/** Meta slice kinds that may never appear in a coreVertical slice (vertical-first). */
const FORBIDDEN_CORE_VERTICAL_KINDS: ReadonlySet<string> = new Set([
  "roster",
  "progression",
  "economy",
  "matchmaking",
  "shop",
  "unlocks",
  "campaign",
]);

interface CompletenessProfile {
  minFeedbackChains: number;
  /** twitch/hybrid must commit to at least one non-judgment measurable feel target. */
  requireMeasurableFeel: boolean;
}
const COMPLETENESS_PROFILES: Record<GenreClass, CompletenessProfile> = {
  twitch: { minFeedbackChains: 1, requireMeasurableFeel: true },
  systems: { minFeedbackChains: 0, requireMeasurableFeel: false },
  hybrid: { minFeedbackChains: 1, requireMeasurableFeel: true },
};

const SHA256_RE = /^[a-f0-9]{64}$/;

/* ------------------------------------------------------------------ small guards */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/* ------------------------------------------------------------------ validation */

export function validateGenreContract(input: unknown): GenreContractValidationResult {
  const issues: GenreContractIssue[] = [];
  const push = (code: string, message: string, path: string) => issues.push({ code, message, path });

  if (!isRecord(input)) {
    push("NOT_OBJECT", "contract must be a JSON object", "");
    return { valid: false, issues };
  }

  // R1 — top-level structural + enums
  if (input.schemaVersion !== GENRE_CONTRACT_SCHEMA_VERSION) {
    push(
      "SCHEMA_VERSION",
      `schemaVersion must be "${GENRE_CONTRACT_SCHEMA_VERSION}"`,
      "schemaVersion",
    );
  }
  if (!isNonEmptyString(input.genreId)) {
    push("GENRE_ID", "genreId must be a non-empty string", "genreId");
  }
  if (!isString(input.confidence) || !CONTRACT_CONFIDENCE_SET.has(input.confidence)) {
    push("CONFIDENCE", "confidence must be experimental | candidate | hardened", "confidence");
  }

  // Field 2 — coreLoop + genreClass (needed by completeness; resolve early)
  let genreClass: GenreClass | null = null;
  const coreLoop = input.coreLoop;
  if (!isRecord(coreLoop)) {
    push("CORE_LOOP", "coreLoop must be an object", "coreLoop");
  } else {
    if (!isNonEmptyString(coreLoop.description)) {
      push("CORE_LOOP_DESC", "coreLoop.description must be a non-empty string", "coreLoop.description");
    }
    if (!isString(coreLoop.genreClass) || !GENRE_CLASS_SET.has(coreLoop.genreClass)) {
      push("GENRE_CLASS", "coreLoop.genreClass must be twitch | systems | hybrid", "coreLoop.genreClass");
    } else {
      genreClass = coreLoop.genreClass as GenreClass;
    }
  }

  // Field 0 — targetPlatform (strings open by design)
  const tp = input.targetPlatform;
  if (!isRecord(tp) || !isNonEmptyString(tp.device) || !isNonEmptyString(tp.inputScheme)) {
    push("TARGET_PLATFORM", "targetPlatform requires device + inputScheme (non-empty strings)", "targetPlatform");
  }

  // Field 1 — networkModel
  const nm = input.networkModel;
  if (!isRecord(nm)) {
    push("NETWORK_MODEL", "networkModel must be an object", "networkModel");
  } else {
    if (nm.mode !== "single-player" && nm.mode !== "co-op" && nm.mode !== "pvp") {
      push("NETWORK_MODE", "networkModel.mode must be single-player | co-op | pvp", "networkModel.mode");
    } else if (nm.mode !== "single-player" && !isNonEmptyString(nm.netcode)) {
      push("NETWORK_NETCODE", "multiplayer requires networkModel.netcode (e.g. photon-fusion)", "networkModel.netcode");
    }
  }

  // Field 3 — artDirection
  const art = input.artDirection;
  if (!isRecord(art) || !isNonEmptyString(art.style)) {
    push("ART_DIRECTION", "artDirection requires a non-empty style", "artDirection");
  }

  // Field 4 — verticalSliceBudget (R8 backstop)
  const budget = input.verticalSliceBudget;
  let deferredKinds: ReadonlySet<string> = new Set();
  const budgetCounts: Record<string, number> = {};
  if (!isRecord(budget)) {
    push("BUDGET", "verticalSliceBudget must be an object", "verticalSliceBudget");
  } else {
    if (!isRecord(budget.coreVerticalContent) || Object.keys(budget.coreVerticalContent).length === 0) {
      push("BUDGET_CONTENT", "verticalSliceBudget.coreVerticalContent must declare ≥1 content count", "verticalSliceBudget.coreVerticalContent");
    } else {
      for (const [k, v] of Object.entries(budget.coreVerticalContent)) {
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          push("BUDGET_COUNT", "coreVerticalContent counts must be positive integers", `verticalSliceBudget.coreVerticalContent.${k}`);
        } else {
          budgetCounts[k] = v;
        }
      }
    }
    if (isStringArray(budget.deferred)) deferredKinds = new Set(budget.deferred);
  }

  // Field 5 — feedbackChains
  const chains = input.feedbackChains;
  const feedbackChainCount = Array.isArray(chains) ? chains.length : 0;
  if (!Array.isArray(chains)) {
    push("FEEDBACK_CHAINS", "feedbackChains must be an array", "feedbackChains");
  } else {
    chains.forEach((c, i) => {
      if (!isRecord(c) || !isNonEmptyString(c.verb) || !isNonEmptyString(c.input) || !isNonEmptyString(c.response) || !isNonEmptyString(c.feedback)) {
        push("FEEDBACK_CHAIN", "each feedbackChain needs verb/input/response/feedback", `feedbackChains[${i}]`);
      }
    });
  }

  // Field 6 — tunables (+ R7 units)
  const tunables = input.tunables;
  if (!Array.isArray(tunables)) {
    push("TUNABLES", "tunables must be an array", "tunables");
  } else {
    tunables.forEach((t, i) => {
      if (!isRecord(t) || !isNonEmptyString(t.id)) {
        push("TUNABLE", "each tunable needs an id", `tunables[${i}]`);
      } else if (t.unit !== undefined && (!isString(t.unit) || !SUPPORTED_PROFILE_UNIT_SET.has(t.unit))) {
        push("TUNABLE_UNIT", `tunable unit "${String(t.unit)}" is not a supported unit`, `tunables[${i}].unit`);
      }
    });
  }

  // Field 7 — measurabilityMap (R5/R6/R7) — the honesty crux
  const judgmentOnlyTargets = new Set<string>();
  let committedMeasurableFeel = false;
  const map = input.measurabilityMap;
  if (!Array.isArray(map) || map.length === 0) {
    push("MEASURABILITY_MAP", "measurabilityMap must be a non-empty array", "measurabilityMap");
  } else {
    map.forEach((m, i) => {
      const p = `measurabilityMap[${i}]`;
      if (!isRecord(m)) {
        push("MEASURABILITY_ROW", "row must be an object", p);
        return;
      }
      if (!isNonEmptyString(m.target)) push("MEASURABILITY_TARGET", "row.target must be a non-empty string", `${p}.target`);
      if (!isString(m.tag) || !MEASURABILITY_TAG_SET.has(m.tag)) {
        push("MEASURABILITY_TAG", "row.tag must be a known measurability tag", `${p}.tag`);
      }
      // bucket REQUIRED
      if (m.bucket !== "coreVertical" && m.bucket !== "deferredMeta") {
        push("MEASURABILITY_BUCKET", "row.bucket is required (coreVertical | deferredMeta)", `${p}.bucket`);
      }

      const tag = m.tag;
      const target = isString(m.target) ? m.target : "";

      // R5 — measurable-now binding
      if (tag === "measurable-now") {
        if (!isNonEmptyString(m.calculator)) {
          push("MEASURABLE_NOW_NO_CALC", "measurable-now requires a calculator id", `${p}.calculator`);
        } else if (!IMPLEMENTED_CALCULATOR_IDS.has(m.calculator)) {
          push(
            "MEASURABLE_NOW_UNIMPLEMENTED",
            `calculator "${m.calculator}" is not an implemented calculator — use needs-new-calculator`,
            `${p}.calculator`,
          );
        }
        committedMeasurableFeel = true;
      } else if (tag === "needs-new-calculator" || tag === "needs-new-bridge-capability") {
        committedMeasurableFeel = true;
      } else if (tag === "judgment-only") {
        if (target) judgmentOnlyTargets.add(target);
        // R5 demotion guard — an implemented-calculator metric may not dodge to judgment-only.
        if (target && IMPLEMENTED_CALCULATOR_IDS.has(target)) {
          push(
            "JUDGMENT_ONLY_HAS_CALC",
            `"${target}" has an implemented calculator; it cannot be judgment-only`,
            `${p}.tag`,
          );
        }
      }

      // R6/R7 — band provenance + units
      if (m.band !== undefined) {
        if (!isRecord(m.band)) {
          push("MEASURABILITY_BAND", "row.band must be an object", `${p}.band`);
        } else {
          const hasMin = m.band.min !== undefined;
          const hasMax = m.band.max !== undefined;
          const hasQualitative = isNonEmptyString(m.band.qualitative);
          if (hasMin && typeof m.band.min !== "number") {
            push("BAND_MIN", "band.min must be a finite number", `${p}.band.min`);
          }
          if (hasMax && typeof m.band.max !== "number") {
            push("BAND_MAX", "band.max must be a finite number", `${p}.band.max`);
          }
          if (typeof m.band.min === "number" && !Number.isFinite(m.band.min)) {
            push("BAND_MIN", "band.min must be a finite number", `${p}.band.min`);
          }
          if (typeof m.band.max === "number" && !Number.isFinite(m.band.max)) {
            push("BAND_MAX", "band.max must be a finite number", `${p}.band.max`);
          }
          if (typeof m.band.min === "number" && typeof m.band.max === "number" && m.band.min > m.band.max) {
            push("BAND_RANGE", "band.min must be <= band.max", `${p}.band`);
          }
          if (!hasMin && !hasMax && !hasQualitative) {
            push("BAND_EMPTY", "band must include min, max, or qualitative", `${p}.band`);
          }
          if (m.band.unit !== undefined && (!isString(m.band.unit) || !SUPPORTED_PROFILE_UNIT_SET.has(m.band.unit))) {
            push("BAND_UNIT", `band unit "${String(m.band.unit)}" is not a supported unit`, `${p}.band.unit`);
          }
        }
        if (!isString(m.evidenceKind) || !EVIDENCE_KIND_SET.has(m.evidenceKind)) {
          push("BAND_NO_EVIDENCE", "a band requires an evidenceKind", `${p}.evidenceKind`);
        } else if (m.evidenceKind === "agent-guess") {
          // R6 — an agent-guess band requires an out-of-band sign-off, NOT a self-authored flag.
          // Required regardless of the row's self-declared bucket: bucket is agent-set and would
          // otherwise let a `deferredMeta` label dodge the sign-off on a genuinely core target.
          const so = m.signoff;
          if (!isRecord(so)) {
            push("AGENT_GUESS_NO_SIGNOFF", "an agent-guess band on a coreVertical target requires an out-of-band signoff", `${p}.signoff`);
          } else {
            if (!isString(so.signoffSha256) || !SHA256_RE.test(so.signoffSha256)) {
              push("SIGNOFF_SHA", "signoff.signoffSha256 must be a lowercase sha256 hex digest", `${p}.signoff.signoffSha256`);
            }
            if (!isString(so.signoffArtifact) || !isSafeCapturePath(so.signoffArtifact)) {
              push("SIGNOFF_ARTIFACT", "signoff.signoffArtifact must be a safe root-relative path", `${p}.signoff.signoffArtifact`);
            }
          }
        }
      }

      // gateBand — the ENFORCED window (experimental-build-proof reads it and refuses an
      // out-of-band value). Same shape/unit/range rules as `band`, but STRICTER: a gateBand with
      // no numeric bound (empty / qualitative-only) is a contract error, not a silent no-op — an
      // enforced band must actually enforce something.
      if (m.gateBand !== undefined) {
        if (!isRecord(m.gateBand)) {
          push("GATE_BAND", "row.gateBand must be an object", `${p}.gateBand`);
        } else {
          const gb = m.gateBand;
          const numericMin = typeof gb.min === "number" && Number.isFinite(gb.min);
          const numericMax = typeof gb.max === "number" && Number.isFinite(gb.max);
          if (gb.min !== undefined && !numericMin) {
            push("GATE_BAND_MIN", "gateBand.min must be a finite number", `${p}.gateBand.min`);
          }
          if (gb.max !== undefined && !numericMax) {
            push("GATE_BAND_MAX", "gateBand.max must be a finite number", `${p}.gateBand.max`);
          }
          if (numericMin && numericMax && (gb.min as number) > (gb.max as number)) {
            push("GATE_BAND_RANGE", "gateBand.min must be <= gateBand.max", `${p}.gateBand`);
          }
          if (!numericMin && !numericMax) {
            push("GATE_BAND_NOT_NUMERIC", "an enforced gateBand must declare a numeric min or max (a qualitative-only/empty gateBand enforces nothing)", `${p}.gateBand`);
          }
          if (gb.unit !== undefined && (!isString(gb.unit) || !SUPPORTED_PROFILE_UNIT_SET.has(gb.unit))) {
            push("GATE_BAND_UNIT", `gateBand unit "${String(gb.unit)}" is not a supported unit`, `${p}.gateBand.unit`);
          }
        }
      }
    });
  }

  // Field 8 — referenceAnchor
  if (!isRecord(input.referenceAnchor)) {
    push("REFERENCE_ANCHOR", "referenceAnchor must be an object", "referenceAnchor");
  }

  // Field 9 — sliceDag (R2/R3/R4/R8)
  collectSliceDagIssues(input.sliceDag, deferredKinds, budgetCounts, push);

  // Field 11 — humanOracleChecks (collect coverage for R9)
  const oracleCovered = new Set<string>();
  const oracle = input.humanOracleChecks;
  if (!Array.isArray(oracle)) {
    push("ORACLE_CHECKS", "humanOracleChecks must be an array", "humanOracleChecks");
  } else {
    oracle.forEach((o, i) => {
      if (!isRecord(o) || !isNonEmptyString(o.check) || !isNonEmptyString(o.appliesTo)) {
        push("ORACLE_CHECK", "each humanOracleCheck needs check + appliesTo", `humanOracleChecks[${i}]`);
      } else {
        oracleCovered.add(o.appliesTo);
      }
    });
  }

  // Field 10 — refusalConditions
  if (!Array.isArray(input.refusalConditions)) {
    push("REFUSAL_CONDITIONS", "refusalConditions must be an array", "refusalConditions");
  } else {
    input.refusalConditions.forEach((r, i) => {
      if (!isRecord(r) || !isNonEmptyString(r.condition) || !isNonEmptyString(r.reason)) {
        push("REFUSAL_CONDITION", "each refusalCondition needs condition + reason", `refusalConditions[${i}]`);
      }
    });
  }

  // OPTIONAL design-doc hardening sections (RCL tranche-2) — present-only refusal.
  // Legacy contracts OMIT both, so these push NOTHING and the result stays byte-identical. When a
  // section IS present it must be well-formed (present-but-malformed IS refused); its mere ABSENCE is
  // never refused here — the plan/adopt advisory layer WARNs on absence (design-hardening.ts).
  validateOptionalProductThesis(input.productThesis, push);
  validateOptionalScaleModel(input.scaleModel, push);
  validateOptionalRequiredEvidenceClasses(input.requiredEvidenceClasses, push);

  // R9 — genre-class completeness
  if (genreClass) {
    const profile = COMPLETENESS_PROFILES[genreClass];
    if (feedbackChainCount < profile.minFeedbackChains) {
      push(
        "COMPLETENESS_FEEDBACK",
        `genreClass "${genreClass}" requires at least ${profile.minFeedbackChains} feedbackChain(s)`,
        "feedbackChains",
      );
    }
    if (profile.requireMeasurableFeel && !committedMeasurableFeel) {
      push(
        "COMPLETENESS_MEASURABLE",
        `genreClass "${genreClass}" must commit to at least one measurable feel target (not all judgment-only/engine-unsupported)`,
        "measurabilityMap",
      );
    }
    // every judgment-only target needs a matching humanOracleCheck (all classes)
    for (const t of judgmentOnlyTargets) {
      if (!oracleCovered.has(t)) {
        push(
          "JUDGMENT_ONLY_NO_ORACLE",
          `judgment-only target "${t}" has no humanOracleCheck (appliesTo)`,
          "humanOracleChecks",
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/** R2/R3/R4/R8 — slice DAG: gates closed-set, gates/gaps invariant, dependency resolution + cycles, vertical-first. */
function collectSliceDagIssues(
  dag: unknown,
  deferredKinds: ReadonlySet<string>,
  budgetCounts: Record<string, number>,
  push: (code: string, message: string, path: string) => void,
): void {
  if (!isRecord(dag) || !Array.isArray(dag.coreVertical) || !Array.isArray(dag.deferredMeta)) {
    push("SLICE_DAG", "sliceDag must have coreVertical[] and deferredMeta[]", "sliceDag");
    return;
  }
  const all: Array<{ node: Record<string, unknown>; bucket: "coreVertical" | "deferredMeta"; path: string }> = [];
  (dag.coreVertical as unknown[]).forEach((n, i) => {
    if (isRecord(n)) all.push({ node: n, bucket: "coreVertical", path: `sliceDag.coreVertical[${i}]` });
    else push("SLICE_NODE", "slice must be an object", `sliceDag.coreVertical[${i}]`);
  });
  (dag.deferredMeta as unknown[]).forEach((n, i) => {
    if (isRecord(n)) all.push({ node: n, bucket: "deferredMeta", path: `sliceDag.deferredMeta[${i}]` });
    else push("SLICE_NODE", "slice must be an object", `sliceDag.deferredMeta[${i}]`);
  });

  const ids = new Set<string>();
  for (const { node, path } of all) {
    if (isNonEmptyString(node.id)) {
      if (ids.has(node.id)) push("SLICE_DUP_ID", `duplicate slice id "${node.id}"`, path);
      ids.add(node.id);
    } else {
      push("SLICE_ID", "slice.id must be a non-empty string", `${path}.id`);
    }
  }

  const coreKindCounts = new Map<string, number>();
  for (const { node, bucket, path } of all) {
    if (!isNonEmptyString(node.title)) {
      push("SLICE_TITLE", "slice.title must be a non-empty string", `${path}.title`);
    }
    // confidence REQUIRED
    if (!isString(node.confidence) || !CONTRACT_CONFIDENCE_SET.has(node.confidence)) {
      push("SLICE_CONFIDENCE", "slice.confidence is required (experimental | candidate | hardened)", `${path}.confidence`);
    }
    // R3 — gates/gaps "at least one, both allowed"
    const gates = isStringArray(node.gates) ? node.gates : [];
    const gaps = isStringArray(node.gaps) ? node.gaps : [];
    if (node.gates !== undefined && !isStringArray(node.gates)) push("SLICE_GATES_TYPE", "slice.gates must be a string[]", `${path}.gates`);
    if (node.gaps !== undefined && !isStringArray(node.gaps)) push("SLICE_GAPS_TYPE", "slice.gaps must be a string[]", `${path}.gaps`);
    if (gates.length === 0 && gaps.length === 0) {
      push("SLICE_NO_PROOF", "slice must declare at least one of gates/gaps", path);
    }
    // R2 — gate ids closed-set
    gates.forEach((g) => {
      if (!SUPPORTED_GATE_IDS.has(g)) {
        push("SLICE_GATE_UNKNOWN", `gate "${g}" is not a supported gate id`, `${path}.gates`);
      }
    });
    // R8 — vertical-first: no meta kind in coreVertical, and content-kind counts within budget.
    // Known v1 limitation: an absent `kind` or a renamed meta kind (not in the deny-list and not a
    // budget key) cannot be detected here — closing that needs a designed kind taxonomy / allowlist
    // (tracked as a follow-up). The deny-list + deferred-kinds + per-kind budget cap below are the v1 teeth.
    if (bucket === "coreVertical" && isString(node.kind)) {
      if (FORBIDDEN_CORE_VERTICAL_KINDS.has(node.kind) || deferredKinds.has(node.kind)) {
        push("CORE_VERTICAL_META", `coreVertical slice may not carry meta kind "${node.kind}"`, `${path}.kind`);
      } else if (node.kind in budgetCounts) {
        coreKindCounts.set(node.kind, (coreKindCounts.get(node.kind) ?? 0) + 1);
      }
    }
    // R4 — dependsOn resolves
    if (!isStringArray(node.dependsOn)) {
      push("SLICE_DEPENDS_TYPE", "slice.dependsOn must be a string[]", `${path}.dependsOn`);
    } else {
      node.dependsOn.forEach((d) => {
        if (!ids.has(d)) push("SLICE_DEP_UNRESOLVED", `dependsOn "${d}" does not resolve to a slice id`, `${path}.dependsOn`);
      });
    }
  }

  // R8 (primary teeth) — coreVertical content-kind counts must not exceed the declared budget.
  // (We cap CONTENT by kind, not build-slice count: a 1-weapon vertical legitimately has many
  // build slices — arena/controller/weapon/enemy/feedback/hud/end-state — so slice count is NOT budgeted.)
  for (const [kind, count] of coreKindCounts) {
    const allowed = budgetCounts[kind];
    if (typeof allowed === "number" && count > allowed) {
      push(
        "BUDGET_EXCEEDED",
        `coreVertical has ${count} "${kind}" slices but the budget allows ${allowed}`,
        "sliceDag.coreVertical",
      );
    }
  }

  // R4 — cycle detection (DFS over the resolved id graph)
  const adj = new Map<string, string[]>();
  for (const { node } of all) {
    if (isNonEmptyString(node.id)) adj.set(node.id, isStringArray(node.dependsOn) ? node.dependsOn.filter((d) => ids.has(d)) : []);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);
  let cycle = false;
  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) cycle = true;
      else if (c === WHITE) visit(dep);
    }
    color.set(id, BLACK);
  };
  for (const id of adj.keys()) if (color.get(id) === WHITE) visit(id);
  if (cycle) push("SLICE_CYCLE", "sliceDag dependsOn graph has a cycle", "sliceDag");
}

/**
 * OPTIONAL `productThesis` (RCL §2 anti-drift) — PRESENT-ONLY refusal. Undefined/absent is a no-op
 * (the advisory layer WARNs on absence). Present ⇒ must be an object with a non-empty `statement` and
 * three arrays of non-empty strings (`notThisGame`/`deferredFeatures`/`feelDamagingAdditions`) — an
 * empty array is allowed (a thesis can legitimately defer nothing), but a non-array or a whitespace
 * entry is refused. This mirrors the "an absent bound field is a refusal, never a skip" discipline:
 * once the section EXISTS, every field it declares is bound.
 */
function validateOptionalProductThesis(
  thesis: unknown,
  push: (code: string, message: string, path: string) => void,
): void {
  if (thesis === undefined) return;
  if (!isRecord(thesis)) {
    push("PRODUCT_THESIS", "productThesis, when present, must be an object", "productThesis");
    return;
  }
  if (!isNonEmptyString(thesis.statement)) {
    push("PRODUCT_THESIS_STATEMENT", "productThesis.statement must be a non-empty string", "productThesis.statement");
  }
  for (const field of ["notThisGame", "deferredFeatures", "feelDamagingAdditions"] as const) {
    const v = thesis[field];
    if (!Array.isArray(v)) {
      push("PRODUCT_THESIS_LIST", `productThesis.${field} must be a string[]`, `productThesis.${field}`);
    } else if (!v.every((x) => isNonEmptyString(x))) {
      push("PRODUCT_THESIS_LIST_ENTRY", `productThesis.${field} entries must be non-empty strings`, `productThesis.${field}`);
    }
  }
}

/**
 * OPTIONAL `scaleModel` (RCL §5 scale-from-speed) — PRESENT-ONLY refusal. Undefined/absent is a no-op
 * (the advisory layer reports the honest "cannot run the scale check" limit). Present ⇒ the two
 * required inputs (`playerSpeedMps`, `targetRunSeconds`) must be positive finite numbers, and every
 * optional dimension, when present, must be a positive finite number. A present-but-malformed
 * scaleModel is refused so a garbage model can't silently disable the scale sanity check.
 */
function validateOptionalScaleModel(
  model: unknown,
  push: (code: string, message: string, path: string) => void,
): void {
  if (model === undefined) return;
  if (!isRecord(model)) {
    push("SCALE_MODEL", "scaleModel, when present, must be an object", "scaleModel");
    return;
  }
  const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  for (const field of ["playerSpeedMps", "targetRunSeconds"] as const) {
    if (!isPositive(model[field])) {
      push("SCALE_MODEL_REQUIRED", `scaleModel.${field} must be a positive finite number`, `scaleModel.${field}`);
    }
  }
  for (const field of ["arenaWidthM", "arenaHeightM", "cameraVisibleWidthM", "firstLootSeconds"] as const) {
    if (model[field] !== undefined && !isPositive(model[field])) {
      push("SCALE_MODEL_OPTIONAL", `scaleModel.${field}, when present, must be a positive finite number`, `scaleModel.${field}`);
    }
  }
}

/**
 * OPTIONAL `requiredEvidenceClasses` (RCL §6 anti-compression) — PRESENT-ONLY refusal. Undefined/absent
 * is a no-op (a legacy contract validates byte-identically and promotes to a byte-identical acceptance).
 * Present ⇒ must be an array whose every entry is a known evidence-class name from the fixed
 * `EVIDENCE_CLASSES` enum shared with the acceptance side (single source of truth) — a non-array, a
 * non-string entry, an unknown class name, or a case mismatch is refused, so a class that could never be
 * satisfied by the verdict's `evidenceClasses` block (and would make doneness refuse forever) can never
 * be smuggled in. Mirrors the acceptance validator's `verification.requiredEvidenceClasses` check.
 */
function validateOptionalRequiredEvidenceClasses(
  value: unknown,
  push: (code: string, message: string, path: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    push(
      "REQUIRED_EVIDENCE_CLASSES",
      "requiredEvidenceClasses, when present, must be an array of evidence-class names",
      "requiredEvidenceClasses",
    );
    return;
  }
  value.forEach((cls, i) => {
    if (typeof cls !== "string" || !EVIDENCE_CLASS_SET.has(cls)) {
      push(
        "REQUIRED_EVIDENCE_CLASS",
        `requiredEvidenceClasses[${i}] "${String(cls)}" is not a known evidence class (one of: ${EVIDENCE_CLASSES.join(", ")})`,
        `requiredEvidenceClasses[${i}]`,
      );
    }
  });
}

/** Throwing wrapper — mirrors assertValidSlicePlan. */
export function assertValidGenreContract(input: unknown): GenreContract {
  const { valid, issues } = validateGenreContract(input);
  if (!valid) {
    const summary = issues.map((i) => `${i.path || "<root>"}: ${i.message} [${i.code}]`).join("; ");
    throw new Error(`invalid genre contract: ${summary}`);
  }
  return input as GenreContract;
}
