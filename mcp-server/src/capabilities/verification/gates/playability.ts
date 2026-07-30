/**
 * Playability gate (§3.3).
 *
 * TWO EVIDENCE ORIGINS, GRADED DIFFERENTLY (evidence arc stage 3; ledger L97/L98).
 *
 * 1. PRODUCED (`_provenance.writer: "loombridge-capture"`, `recipe: "playability"`):
 *    the observer recorded the play session frame by frame and derived every
 *    headline field from that recording. This gate does NOT take those fields on
 *    trust: it re-runs `derivePlayability` (the same pure derivation the producer
 *    ran, in `domain/playability-observation.ts`) over the buffers retained in the
 *    file, and REFUSES any headline the buffers do not reproduce. It also re-derives
 *    the kinematic bound from the CONTRACT rather than reading the one in the file,
 *    so a file cannot widen its own teleport allowance. Only this origin can pass.
 *
 * 2. AGENT-ASSEMBLED (no producer marker): the pre-stage-3 shape, where seven of the
 *    eight graded fields were literals the assembler typed and `completionMethod`,
 *    the gate's own anti-teleport control, ran on the honor system. It is still
 *    graded, so an existing project keeps a useful report, but it is CAPPED AT WARN
 *    and can never pass: the cap is a warn check whose detail says exactly why (the
 *    honest interim of review H10). Removing that check is the LITMUS: the same file
 *    then passes, which is the hole this gate exists to close.
 *
 * WHAT THE CHECKS MEAN (unchanged):
 *  - completable: the level can be finished. A completion whose recording contains
 *    an unexplained super-kinematic step is `completionMethod: "assisted"` and
 *    WARNs, exactly as the legacy self-declared "teleported" did: the win logic
 *    fired but traversal was not demonstrated.
 *  - winRule: the observed win rule == `win.rule`. For produced evidence
 *    `winRuleObserved` only carries the contract's string when the recorded window
 *    satisfied the declared closed-set rule.
 *  - hazardKills / collectibleIncrements: a lives decrement and a score increment
 *    observed in the recording.
 *  - modal end state: input locked, player frozen, restart works, all three measured
 *    by CLI-driven post-win probes for produced evidence.
 */

import type { AcceptanceContract } from "../types.js";
import {
  derivePlayability,
  deriveKinematicBound,
  type ObservationBuffers,
  type ObservedPoint,
  type PlayabilityDerivation,
  type WinRuleKind,
} from "../../../domain/playability-observation.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** The measured playability results the observer writes (or an agent assembles). */
export interface PlayabilityResults {
  /** Did the player reach the goal and trigger a win? */
  completable?: boolean;
  /**
   * HOW completion was proven. `played`: the recorded position trace never exceeded
   * the contract's own kinematic bound except at the game's own respawn.
   * `assisted`: it did, so traversal was not demonstrated (the produced spelling of
   * the legacy self-declared `teleported`, which is still accepted from
   * agent-assembled files). Both non-`played` values WARN rather than pass.
   */
  completionMethod?: "played" | "teleported" | "assisted";
  /** Which rule was observed to fire the win field (e.g. "reach-flag", "all-fruit"). */
  winRuleObserved?: string;
  /** Did a hazard contact decrement `lives`? */
  hazardKills?: boolean;
  /** Did collecting a pickup increment `score`? */
  collectibleIncrements?: boolean;
  /** After the win/lose overlay appears, does gameplay input stop affecting play? */
  postWinInputLocked?: boolean;
  /** After the win/lose overlay appears, is the player effectively frozen? */
  postWinPlayerFrozen?: boolean;
  /** Does the declared restart affordance return the game to a playable state? */
  restartWorks?: boolean;
  /** The producer's provenance block, carrying the recording the headline came from. */
  _provenance?: unknown;
}

export const GATE_NAME = "playability";

/** The marker pair that identifies observer-produced evidence. */
const PRODUCER_WRITER = "loombridge-capture";
const PRODUCER_RECIPE = "playability";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pointOf(value: unknown): ObservedPoint | undefined {
  if (!isRecord(value)) return undefined;
  const x = num(value.x);
  const y = num(value.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

function boolCheck(
  id: string,
  observed: boolean | undefined,
  expectTrueDetail: string,
  failDetail: string,
): GateCheck {
  if (observed === undefined) {
    return {
      id,
      expected: "true",
      actual: "(not observed)",
      status: "warn",
      detail: `${failDetail} (not observed in this run).`,
    };
  }
  return {
    id,
    expected: "true",
    actual: String(observed),
    status: observed ? "pass" : "fail",
    detail: observed ? expectTrueDetail : failDetail,
  };
}

// ── the produced shape ──────────────────────────────────────────────────────

/** Is this file the observer's own output? Both markers, never one. */
export function isProducedPlayability(results: PlayabilityResults): boolean {
  const provenance = results._provenance;
  if (!isRecord(provenance)) return false;
  return provenance.writer === PRODUCER_WRITER && provenance.recipe === PRODUCER_RECIPE;
}

/** The buffers a produced file must retain, read defensively (absent is a refusal). */
function buffersOf(observation: Record<string, unknown>): ObservationBuffers | null {
  const buffers = observation.buffers;
  if (!isRecord(buffers)) return null;
  const numbers = (key: string): number[] =>
    Array.isArray(buffers[key]) ? (buffers[key] as unknown[]).map((v) => (typeof v === "number" ? v : Number.NaN)) : [];
  const nullable = (key: string): (number | null)[] | undefined =>
    Array.isArray(buffers[key])
      ? (buffers[key] as unknown[]).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
      : undefined;
  const flags = (key: string): (boolean | null)[] =>
    Array.isArray(buffers[key]) ? (buffers[key] as unknown[]).map((v) => (typeof v === "boolean" ? v : null)) : [];
  const tMs = numbers("tMs");
  if (tMs.length === 0) return null;
  const score = nullable("score");
  const lives = nullable("lives");
  return {
    tMs,
    frame: numbers("frame"),
    fixedTick: numbers("fixedTick"),
    x: numbers("x"),
    y: numbers("y"),
    win: flags("win"),
    ...(score === undefined ? {} : { score }),
    ...(lives === undefined ? {} : { lives }),
  };
}

function trajectoryOf(value: unknown): { tMs: number; x: number; y: number }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { tMs: number; x: number; y: number }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const tMs = num(entry.tMs);
    const x = num(entry.x);
    const y = num(entry.y);
    if (tMs === undefined || x === undefined || y === undefined) continue;
    out.push({ tMs, x, y });
  }
  return out;
}

function restartBuffersOf(probes: Record<string, unknown>): ObservationBuffers | undefined {
  const raw = probes.restartBuffers;
  if (!isRecord(raw)) return undefined;
  return buffersOf({ buffers: raw }) ?? undefined;
}

/** The harness-declared closed-set win rule, read from the CONTRACT, never the file. */
function contractWinRule(acceptance: AcceptanceContract): WinRuleKind | undefined {
  const harness = (acceptance as { harness?: { playability?: { winRule?: unknown } } }).harness;
  const rule = harness?.playability?.winRule;
  return rule === "all-collectibles" || rule === "reach-goal" ? rule : undefined;
}

function goalRadiusOf(acceptance: AcceptanceContract): number | undefined {
  const harness = (acceptance as { harness?: { playability?: { goalRadiusU?: unknown } } }).harness;
  return num(harness?.playability?.goalRadiusU);
}

interface RederiveOutcome {
  checks: GateCheck[];
  /** The re-derived headline, when the re-derivation ran at all. */
  derivation: PlayabilityDerivation | null;
}

/**
 * Re-derive the whole headline from the file's own recording and refuse anything it
 * does not reproduce.
 *
 * THE BOUND COMES FROM THE CONTRACT, NOT THE FILE. A produced file records the
 * kinematic bound it used, and this gate checks that record against its own
 * re-derivation, but it GRADES with the bound it derived itself: otherwise a file
 * could widen its own teleport allowance and launder an assisted completion into a
 * played one. Same reasoning for the win rule and the contract's `win.rule` string.
 */
function rederiveProduced(results: PlayabilityResults, acceptance: AcceptanceContract): RederiveOutcome {
  const checks: GateCheck[] = [];
  const provenance = results._provenance as Record<string, unknown>;
  const observation = isRecord(provenance.observation) ? provenance.observation : null;

  if (observation === null) {
    checks.push({
      id: "playability.produced.observation",
      expected: "_provenance.observation with the recorded window",
      actual: "(absent)",
      status: "fail",
      detail:
        "This file claims the playability OBSERVER wrote it but carries no `_provenance.observation`, so there is no recording to re-derive its headline from. " +
        "An absent binding is a refusal, never a skip: the produced marker cannot be claimed by a file with no window behind it.",
    });
    return { checks, derivation: null };
  }

  const buffers = buffersOf(observation);
  if (buffers === null) {
    checks.push({
      id: "playability.produced.buffers",
      expected: "_provenance.observation.buffers (the per-Update recording)",
      actual: "(absent or empty)",
      status: "fail",
      detail:
        "The observation block retains no sample buffers, so every headline field in this file is unverifiable. " +
        "The buffers ARE the evidence (ledger L122: the strongest evidence the door-one run produced was the play trace, and no gate read a byte of it).",
    });
    return { checks, derivation: null };
  }

  const boundResolution = deriveKinematicBound(acceptance);
  if (!boundResolution.ok) {
    checks.push({
      id: "playability.produced.bound",
      expected: "a kinematic bound derivable from the contract's feel targets",
      actual: "(no usable feel target)",
      status: "fail",
      detail: boundResolution.refusal,
    });
    return { checks, derivation: null };
  }
  const bound = boundResolution.bound;

  const recordedBound = isRecord(observation.context) && isRecord(observation.context.bound)
    ? num((observation.context.bound as Record<string, unknown>).maxSpeedUPerSec)
    : undefined;
  const boundMatches =
    recordedBound !== undefined && Math.abs(recordedBound - bound.maxSpeedUPerSec) <= 1e-6;
  checks.push({
    id: "playability.produced.bound",
    expected: `${bound.maxSpeedUPerSec.toFixed(4)} u/s (re-derived from this contract's feel targets)`,
    actual: recordedBound === undefined ? "(absent)" : recordedBound.toFixed(4),
    status: boundMatches ? "pass" : "fail",
    detail: boundMatches
      ? `The recording was graded against the same teleport bound this contract yields: ${bound.terms.map((t) => `${t.term} ${t.speedUPerSec.toFixed(2)}u/s`).join(", ")}, times the ${bound.margin}x margin.`
      : `The bound recorded in this file (${recordedBound === undefined ? "absent" : recordedBound.toFixed(4)} u/s) is not the bound this contract yields (${bound.maxSpeedUPerSec.toFixed(4)} u/s). ` +
        "A file that carries its own teleport allowance could launder an assisted completion into a played one, so the mismatch is refused. The gate grades with the contract's bound regardless.",
  });

  const winRule = contractWinRule(acceptance);
  if (winRule === undefined) {
    checks.push({
      id: "playability.produced.winRule",
      expected: "harness.playability.winRule (all-collectibles | reach-goal)",
      actual: "(absent)",
      status: "fail",
      detail:
        "The contract declares no `harness.playability.winRule`, so the win rule cannot be re-checked against the recording. " +
        "The rule names the mechanical CHECK the observer runs; without it the win transition is unbound.",
    });
    return { checks, derivation: null };
  }

  const open = isRecord(observation.open) ? observation.open : {};
  const accounting = isRecord(observation.accounting) ? observation.accounting : {};
  const probes = isRecord(observation.probes) ? observation.probes : {};
  const goal = pointOf(open.goal);
  const respawn = pointOf(open.respawn);
  const radius = goalRadiusOf(acceptance);

  const derivation = derivePlayability(
    buffers,
    {
      winRule,
      contractWinRule: typeof acceptance.win?.rule === "string" ? acceptance.win.rule : "",
      collectibleTotal: num(open.collectibleTotal) ?? 0,
      spawn: pointOf(open.spawn) ?? { x: 0, y: 0 },
      ...(respawn ? { respawn } : {}),
      ...(goal ? { goal } : {}),
      ...(radius === undefined ? {} : { goalRadiusU: radius }),
      droppedSamples: num(accounting.droppedSamples) ?? 0,
      bound,
    },
    {
      ...(trajectoryOf(probes.freezeSamples) ? { freezeSamples: trajectoryOf(probes.freezeSamples) } : {}),
      ...(trajectoryOf(probes.inputLockSamples) ? { inputLockSamples: trajectoryOf(probes.inputLockSamples) } : {}),
      ...(restartBuffersOf(probes) ? { restartBuffers: restartBuffersOf(probes) } : {}),
    },
  );

  // A refusal from the derivation is a refusal from the gate: the same sentence the
  // producer would have refused with, arriving one step later because someone wrote
  // the file anyway.
  for (const [index, refusal] of derivation.refusals.entries()) {
    checks.push({
      id: `playability.produced.window[${index}]`,
      expected: "a recorded window that supports a verdict",
      actual: "(refused)",
      status: "fail",
      detail: refusal,
    });
  }

  // The LAUNDERING DETECTOR: every headline field, re-derived.
  const rederived = derivation.headline as unknown as Record<string, unknown>;
  const reported = results as unknown as Record<string, unknown>;
  const fields = [
    "completable",
    "completionMethod",
    "winRuleObserved",
    "hazardKills",
    "collectibleIncrements",
    "postWinInputLocked",
    "postWinPlayerFrozen",
    "restartWorks",
  ] as const;
  const mismatched: string[] = [];
  for (const field of fields) {
    const expected = rederived[field];
    const actual = reported[field];
    if (expected === undefined && actual === undefined) continue;
    if (expected === actual) continue;
    mismatched.push(`${field}: file says ${JSON.stringify(actual)}, the recording yields ${JSON.stringify(expected)}`);
  }
  checks.push({
    id: "playability.produced.rederive",
    expected: "every headline field re-derives from the retained recording",
    actual: mismatched.length === 0 ? "all fields match" : `${mismatched.length} mismatch(es)`,
    status: mismatched.length === 0 ? "pass" : "fail",
    detail:
      mismatched.length === 0
        ? `All ${fields.length} headline fields were re-derived from the file's own ${buffers.tMs.length}-sample recording and match.`
        : `The headline does not match what the recording produces: ${mismatched.join("; ")}. A typed field that the evidence does not yield is exactly the self-grade this gate exists to catch (ledger L97).`,
  });

  // Super-kinematic events, named individually so the report says WHERE.
  //
  // WHY WARN AND NOT FAIL. An unexplained step means the completion was ASSISTED,
  // which is the same class of finding the legacy self-declared "teleported" carried:
  // the win logic fired, traversal was not demonstrated. A warn already denies the
  // pass (`worstStatus`), and reserving `fail` for tampering keeps the report's
  // severities meaning one thing each: a file that CLAIMS "played" over these same
  // events fails on the re-derivation check above, which is the dishonesty.
  const unexplained = derivation.observation.continuity.events.filter((event) => event.classification === "unexplained");
  checks.push({
    id: "playability.produced.continuity",
    expected: "no unexplained super-kinematic step before the win",
    actual: `${unexplained.length} unexplained, ${derivation.observation.continuity.events.length} total super-kinematic step(s)`,
    status: unexplained.length === 0 ? "pass" : "warn",
    detail:
      unexplained.length === 0
        ? `Max single-frame displacement ${derivation.observation.continuity.maxDisplacementU.toFixed(3)}u against a ${bound.maxSpeedUPerSec.toFixed(2)} u/s bound: the recorded motion is what this game's own declared speeds allow.`
        : `The recording contains ${unexplained.length} step(s) the game's own declared speeds cannot explain, e.g. ${unexplained
            .slice(0, 3)
            .map((event) => `frame ${event.frame}: ${event.displacementU.toFixed(2)}u in ${event.dtMs.toFixed(1)}ms (allowed ${event.allowedU.toFixed(2)}u)`)
            .join("; ")}. That is a teleport in the position trace, whatever op caused it.`,
  });

  return { checks, derivation };
}

export function evaluatePlayability(
  results: PlayabilityResults,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];
  const produced = isProducedPlayability(results);

  if (produced) {
    // Re-derivation FIRST: it is what makes the fields below mean anything.
    checks.push(...rederiveProduced(results, acceptance).checks);
  } else {
    /**
     * THE CAP (review H10). Without a producer behind it, every field below is a
     * literal someone typed: the door-one run's eight-line hand-written file
     * produced the identical pass, and `completionMethod`, the anti-teleport
     * control, was one of those literals (L97/L98). The checks still run, so the
     * report stays useful, but a warn check caps the gate's verdict at warn and it
     * can never pass. Deleting this check is the LITMUS: the same file then passes.
     */
    checks.push({
      id: "playability.evidenceOrigin",
      expected: 'produced by the playability observer (_provenance.writer "loombridge-capture", recipe "playability")',
      actual: "agent-assembled (no producer marker)",
      status: "warn",
      detail:
        "This playability.json was not written by the playability observer, so nothing binds its fields to a recorded play session: " +
        "an eight-line hand-typed file produces the identical field set, including `completionMethod`, which is this gate's own anti-teleport control (ledger L97/L98). " +
        "The checks below are reported for information and the gate is CAPPED AT WARN: it cannot pass. " +
        "Run `loombridge capture --slice <id>` to record the completion (it prints a DRIVE NOW line and derives every field from what it recorded).",
    });
  }

  // ---- completable (completion-method aware) ----
  if (results.completable === false) {
    // A failed completion is a hard FAIL regardless of method.
    checks.push({
      id: "playability.completable",
      expected: "true",
      actual: "false",
      status: "fail",
      detail: "Level NOT completable: player could not reach the goal / win never fired.",
    });
  } else if (results.completable === undefined) {
    checks.push({
      id: "playability.completable",
      expected: "true",
      actual: "(not observed)",
      status: "warn",
      detail: "Level NOT completable: player could not reach the goal / win never fired. (not observed in this run).",
    });
  } else if (results.completionMethod === "teleported" || results.completionMethod === "assisted") {
    // Completion NOT proven by unassisted movement: the win logic fired but
    // traversal was not demonstrated, so this only WARNs. `teleported` is the
    // legacy self-declared spelling; `assisted` is the observer's, derived from a
    // super-kinematic step in the recorded position trace.
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: `true (proven by ${results.completionMethod === "assisted" ? "an ASSISTED run" : "teleport"})`,
      status: "warn",
      detail:
        results.completionMethod === "assisted"
          ? "The recorded completion contains a step the game's own declared speeds cannot explain and that did not land at the spawn or declared respawn point, so the player was ASSISTED at least once: this does not prove the level is traversable. Geometric reachability is verified separately by the reachability gate."
          : "Level completion was proven by TELEPORTING the player onto each goal/collectible, NOT by movement: this does not prove the level is traversable (an unreachable collectible would still pass). Geometric reachability is verified separately by the reachability gate.",
    });
  } else if (results.completionMethod === "played") {
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: "true (proven by movement)",
      status: "pass",
      detail: produced
        ? "Level is completable: the recorded position trace reaches the win with no step beyond what this game's own declared speeds allow."
        : "Level is completable: player reached the goal and won by moving.",
    });
  } else {
    // completable true but completionMethod not recorded -> WARN to capture it.
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: "true (method not recorded)",
      status: "warn",
      detail:
        "Level reported completable, but completion method not recorded; capture it (\"played\" vs \"teleported\") so a teleport-only proof cannot mask an unreachable goal.",
    });
  }

  // ---- win rule conformance ----
  const expectedRule = acceptance.win.rule;
  if (results.winRuleObserved === undefined) {
    checks.push({
      id: "playability.winRule",
      expected: expectedRule,
      actual: "(not observed)",
      status: "warn",
      detail: `Win rule not observed; expected "${expectedRule}".`,
    });
  } else {
    const ok = results.winRuleObserved === expectedRule;
    checks.push({
      id: "playability.winRule",
      expected: expectedRule,
      actual: results.winRuleObserved,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Win fired by the intended rule "${expectedRule}".`
        : `Win fired by "${results.winRuleObserved}", expected "${expectedRule}". ${
            acceptance.win.buildRule
              ? `(buildRule note: ${acceptance.win.buildRule})`
              : ""
          }`.trim(),
    });
  }

  checks.push(
    boolCheck(
      "playability.hazardKills",
      results.hazardKills,
      "Hazard contact decremented lives (kills + respawn).",
      "Hazard did NOT decrement lives.",
    ),
  );

  checks.push(
    boolCheck(
      "playability.collectibleIncrements",
      results.collectibleIncrements,
      "Collecting a pickup incremented score.",
      "Collecting a pickup did NOT increment score.",
    ),
  );

  const endStateMode = acceptance.win.endStateMode ?? "modal";
  checks.push({
    id: "playability.endStateMode",
    expected: endStateMode,
    actual: endStateMode,
    status: "pass",
    detail:
      endStateMode === "modal"
        ? "Contract expects a modal end state: gameplay stops behind the win/lose overlay."
        : "Contract explicitly allows continuous simulation under the end-state overlay.",
  });

  if (endStateMode === "modal") {
    checks.push(
      boolCheck(
        "playability.postWinInputLocked",
        results.postWinInputLocked,
        "Post-win gameplay input is locked while the end-state overlay is shown.",
        "Post-win gameplay input still affects play behind the overlay.",
      ),
    );
    checks.push(
      boolCheck(
        "playability.postWinPlayerFrozen",
        results.postWinPlayerFrozen,
        "Post-win player motion is frozen while the end-state overlay is shown.",
        "The player can still move / fall / collide behind the win overlay.",
      ),
    );
    checks.push(
      boolCheck(
        "playability.restartWorks",
        results.restartWorks,
        acceptance.win.restartAction
          ? `Restart affordance (${acceptance.win.restartAction}) returns to a playable state.`
          : "Restart affordance returns to a playable state.",
        "Restart affordance did NOT return to a playable state.",
      ),
    );
  }

  return makeGateReport(GATE_NAME, checks);
}
