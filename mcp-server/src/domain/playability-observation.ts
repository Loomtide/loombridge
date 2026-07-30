/**
 * THE PLAYABILITY DERIVATIONS (evidence arc E2 / stage 3; ledger L97, L98, L106, L122).
 *
 * `playability.json` was the moat's worst file: seven of its eight graded fields
 * were literals the assembler typed (`completable: true`, `completionMethod:
 * "played"`, `hazardKills: true`, ...), and the 14 KB `_provenance.evidence` block
 * that recorded the real drive was never parsed by any gate. An eight-line
 * hand-typed file produced the identical `playability=pass`, and the gate's ONE
 * honesty control (`completionMethod`) ran on the honor system (L97/L98).
 *
 * This module is the replacement, and it is deliberately PURE: every headline
 * field is a function of a CONTINUOUS position-and-state buffer recorded inside
 * the game's own Update loop (`observe.start` / `observe.drain`, the
 * InputObserverRuntimePump precedent) plus values the BRIDGE read from the scene
 * at window open. The observer recipe runs these functions to write the file, and
 * the gate runs the SAME functions over the buffer retained in that file and
 * refuses any headline they do not reproduce. Neither side can type a verdict.
 *
 * WHY CONTINUITY, NOT AN OP LOG. The first plan said "completionMethod = played
 * when the window contains no scene.set_transform". There is no op log: the bridge
 * keeps no per-session journal, and the agent drives from its OWN connection, so a
 * CLI-side record of the ops IT sent would prove nothing about what the agent sent
 * (review H5). What a teleport cannot hide is the PLAYER MOVING FURTHER IN ONE
 * FRAME THAN THE GAME'S OWN DECLARED SPEEDS ALLOW. So the control is kinematic:
 * per-sample displacement against a bound derived from the contract's feel targets,
 * with every violation recorded and classified. A teleport is a physical event in
 * the position trace, whatever op caused it, including one the agent issued over a
 * connection this CLI cannot see.
 *
 * WHY SAMPLING IS IN THE GAME LOOP. Polling the state over the bridge (a
 * get_snapshot every N ms) is disqualified (review H6): a round trip is tens of ms,
 * so a single-frame teleport lands entirely between two polls and the continuity
 * proof has nothing to see. The recorder samples EVERY Update inside the game, and
 * a second client drains the buffer afterwards.
 */

// ── the recorded window ─────────────────────────────────────────────────────

/**
 * The drained buffers, exactly as `observe.drain` echoes them: PARALLEL ARRAYS,
 * one entry per sampled Update. Arrays rather than objects because a minutes-long
 * window at 60Hz is tens of thousands of samples and the evidence file retains
 * every one of them (the continuity proof needs the whole trace: a decimated
 * buffer cannot see a single-frame hop).
 */
export interface ObservationBuffers {
  /** Milliseconds since the recorder started, per sample. */
  tMs: number[];
  /** `Time.frameCount` per sample. */
  frame: number[];
  /** Fixed-tick count (`Time.fixedTime / fixedDeltaTime`) per sample. */
  fixedTick: number[];
  x: number[];
  y: number[];
  z?: number[];
  /** The win field per sample. `null` = declared but unreadable, which refuses. */
  win: (boolean | null)[];
  score?: (number | null)[];
  lives?: (number | null)[];
}

/** A point the window is measured against (spawn, respawn, goal), read at open. */
export interface ObservedPoint {
  x: number;
  y: number;
  z?: number;
}

/** The closed set of win rules this module knows how to CHECK against a buffer. */
export type WinRuleKind = "all-collectibles" | "reach-goal";

/**
 * Everything the derivation needs that did not come out of the buffers, all of it
 * read by the BRIDGE at window open (never typed by an agent, never read back out
 * of the evidence file by the producer).
 */
export interface ObservationContext {
  /** Closed-set win rule the harness declares, so the check is mechanical. */
  winRule: WinRuleKind;
  /** The contract's own free-text `win.rule`, echoed only when the check passes. */
  contractWinRule: string;
  /** Collectible objects the bridge counted in the scene at open. */
  collectibleTotal: number;
  /** Player position at open (the recorder's first sample). */
  spawn: ObservedPoint;
  /** Declared respawn point read at open, when the harness names one. */
  respawn?: ObservedPoint;
  /** Goal position read at open, required by the `reach-goal` rule. */
  goal?: ObservedPoint;
  /** Radius that counts as "reached" for `reach-goal`, in world units. */
  goalRadiusU?: number;
  /** Ring wrap accounting from the recorder itself. */
  droppedSamples: number;
  /** Max per-sample displacement the contract's own feel targets allow. */
  bound: KinematicBound;
}

// ── the kinematic bound ─────────────────────────────────────────────────────

/**
 * Safety factor over the fastest motion the contract declares. The targets are
 * what the game is GRADED against, not a measured ceiling: a controller can
 * legitimately overshoot its target, a dash can stack on a run, and a fall
 * accelerates past both. 1.5 is wide enough that ordinary play never trips the
 * check and narrow enough that a teleport (whole screens in one frame) always
 * does. The bound is a TELEPORT DETECTOR, not a feel measurement: `feel.json` is
 * where speeds are graded.
 */
export const KINEMATIC_MARGIN = 1.5;

/**
 * Shortest dash a contract could plausibly declare, in seconds. `dashDistance` is
 * a DISTANCE with no duration beside it in the contract, so the bound assumes the
 * dash could be spent this fast, which maximises the implied speed and therefore
 * WIDENS the allowance. Choosing a longer dash would tighten the bound and risk
 * flagging a real dash as a teleport.
 */
export const DASH_MIN_SECONDS = 0.1;

/**
 * A fall accelerates past the launch speed. Terminal fall speed is not in the
 * contract, so the bound allows twice the derived jump launch speed: enough for a
 * long fall under ordinary gravity, still far below a teleport.
 */
export const FALL_SPEED_FACTOR = 2;

/** Float noise floor on a position comparison, in world units. */
export const POSITION_EPSILON_U = 0.02;

/** How close a super-kinematic landing must be to spawn/respawn to be a respawn. */
export const RESPAWN_TOLERANCE_U = 0.5;

/** Default "reached the goal" radius, in world units. */
export const DEFAULT_GOAL_RADIUS_U = 1.5;

/** Displacement below which the post-win probes call the player frozen, in units. */
export const FROZEN_EPSILON_U = 0.05;

export interface KinematicBound {
  /** Max speed the contract's targets allow, world units per second. */
  maxSpeedUPerSec: number;
  /** Every term that fed the max, so the file shows the derivation. */
  terms: { term: string; speedUPerSec: number; from: string }[];
  margin: number;
}

export type KinematicBoundResolution =
  | { ok: true; bound: KinematicBound }
  | { ok: false; refusal: string };

function feelEntry(contract: unknown, metric: string): Record<string, unknown> | undefined {
  if (typeof contract !== "object" || contract === null) return undefined;
  const feel = (contract as Record<string, unknown>).feel;
  if (typeof feel !== "object" || feel === null) return undefined;
  const entry = (feel as Record<string, unknown>)[metric];
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
}

function targetOf(contract: unknown, metric: string): number | undefined {
  const entry = feelEntry(contract, metric);
  const target = entry?.target;
  return typeof target === "number" && Number.isFinite(target) && target > 0 ? target : undefined;
}

/**
 * A time target in SECONDS, honouring the contract's own `unit`.
 *
 * `timeToApex` is written both ways in the wild (TideRunner declares
 * `target: 325, unit: "ms"`), and reading 325 as seconds would deflate the jump
 * term by three orders of magnitude. An ABSENT unit is read as seconds, which is
 * the conservative direction: a millisecond value read as seconds yields a tiny
 * launch speed, so the bound only ever gets TIGHTER (more motion flagged), never
 * wide enough to wave a teleport through.
 */
function secondsTargetOf(contract: unknown, metric: string): number | undefined {
  const target = targetOf(contract, metric);
  if (target === undefined) return undefined;
  const unit = feelEntry(contract, metric)?.unit;
  return typeof unit === "string" && unit.trim().toLowerCase() === "ms" ? target / 1000 : target;
}

/**
 * The teleport bound, derived from the contract's OWN feel targets and nothing
 * else. Refuses when the contract declares no usable target: an absent binding is
 * a refusal, never a default that would silently certify any motion as legal.
 */
export function deriveKinematicBound(contract: unknown): KinematicBoundResolution {
  const terms: KinematicBound["terms"] = [];

  const runSpeed = targetOf(contract, "runSpeed");
  if (runSpeed !== undefined) {
    terms.push({ term: "run", speedUPerSec: runSpeed, from: "feel.runSpeed.target (u/s)" });
  }

  const dashDistance = targetOf(contract, "dashDistance");
  if (dashDistance !== undefined) {
    terms.push({
      term: "dash",
      speedUPerSec: dashDistance / DASH_MIN_SECONDS,
      from: `feel.dashDistance.target / DASH_MIN_SECONDS (${DASH_MIN_SECONDS}s, the shortest plausible dash: it maximises the implied speed and widens the allowance)`,
    });
  }

  const jumpApex = targetOf(contract, "jumpApex");
  const timeToApex = secondsTargetOf(contract, "timeToApex");
  if (jumpApex !== undefined && timeToApex !== undefined) {
    // Constant gravity: apex = v0 * t / 2, so v0 = 2 * apex / t.
    const launch = (2 * jumpApex) / timeToApex;
    terms.push({ term: "jump-launch", speedUPerSec: launch, from: "2 * feel.jumpApex.target / feel.timeToApex.target" });
    terms.push({
      term: "fall",
      speedUPerSec: launch * FALL_SPEED_FACTOR,
      from: `jump-launch * FALL_SPEED_FACTOR (${FALL_SPEED_FACTOR}: a fall accelerates past the launch speed and the contract declares no terminal velocity)`,
    });
  }

  if (terms.length === 0) {
    return {
      ok: false,
      refusal:
        "REFUSED: the acceptance contract declares no usable `feel` target (runSpeed, dashDistance, or jumpApex + timeToApex), " +
        "so there is no kinematic bound to test the recorded motion against. The continuity proof IS the anti-teleport control " +
        "(ledger L98), and a proof with no bound would certify any motion as played. Declare the feel targets, or capture this " +
        "slice's playability evidence on a contract that does.",
    };
  }

  const fastest = terms.reduce((best, term) => (term.speedUPerSec > best.speedUPerSec ? term : best), terms[0]);
  return {
    ok: true,
    bound: {
      maxSpeedUPerSec: fastest.speedUPerSec * KINEMATIC_MARGIN,
      terms,
      margin: KINEMATIC_MARGIN,
    },
  };
}

// ── continuity ──────────────────────────────────────────────────────────────

/** One super-kinematic step: the player moved further in a frame than the bound allows. */
export interface SuperKinematicEvent {
  /** Index of the sample the jump ENDED at (the sample after the discontinuity). */
  sampleIndex: number;
  frame: number;
  tMs: number;
  /** Displacement across the step, world units. */
  displacementU: number;
  /** What the bound allowed across this step's own dt. */
  allowedU: number;
  dtMs: number;
  from: ObservedPoint;
  to: ObservedPoint;
  /**
   * `respawn`  the step ENDED at the spawn point or the declared respawn point:
   *            the game's own death teleport (ledger L125: TideRunner's Hazard.cs
   *            teleports to a hardcoded respawn), so it is not evidence of an
   *            assisted completion;
   * `unexplained`  everything else, which forces completionMethod "assisted".
   */
  classification: "respawn" | "unexplained";
  /** Why it was classified that way, in the file, so the modeling choice is auditable. */
  reason: string;
}

export interface ContinuityResult {
  events: SuperKinematicEvent[];
  /** Largest single-step displacement in the window, world units. */
  maxDisplacementU: number;
  /** The step that produced `maxDisplacementU`, for the report. */
  maxDisplacementSampleIndex: number;
  /** Refusals that make the trace unusable (non-monotonic time, too few samples). */
  refusals: string[];
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function near(point: ObservedPoint, x: number, y: number, tolerance: number): boolean {
  return distance(point.x, point.y, x, y) <= tolerance;
}

/**
 * Walk the position trace and flag every step that exceeds the bound over ITS OWN
 * dt. Per-step dt (not a nominal 1/60) matters: an editor hitch produces a 200ms
 * frame in which a running player legitimately covers 200ms of ground, and a
 * nominal-dt bound would call that a teleport.
 *
 * THE RESPAWN MODELING CHOICE, stated plainly because it is the one place this
 * derivation can be wrong in the game's favour: a super-kinematic step that LANDS
 * at the spawn point (or at a respawn point the harness declares and the bridge
 * read from the scene at open) is classified `respawn` and does not make the
 * completion assisted. A game whose death teleport lands somewhere else, and a
 * checkpoint system, will be classified `unexplained`: conservative by design. An
 * agent could in principle teleport a player to the spawn point to reset a failed
 * leg; that would be recorded as a respawn event, which is why EVERY event is kept
 * in the evidence with its classification rather than being filtered out.
 */
export function deriveContinuity(
  buffers: ObservationBuffers,
  context: Pick<ObservationContext, "bound" | "spawn" | "respawn">,
): ContinuityResult {
  const refusals: string[] = [];
  const events: SuperKinematicEvent[] = [];
  const count = buffers.tMs.length;
  if (count < 2) {
    refusals.push(
      `the recorded window holds ${count} sample(s): a continuity proof needs at least 2 so a step can be measured.`,
    );
    return { events, maxDisplacementU: 0, maxDisplacementSampleIndex: -1, refusals };
  }

  let maxDisplacementU = 0;
  let maxDisplacementSampleIndex = -1;
  for (let i = 1; i < count; i += 1) {
    const dtMs = buffers.tMs[i] - buffers.tMs[i - 1];
    if (!(dtMs > 0)) {
      refusals.push(
        `sample ${i} is not strictly after sample ${i - 1} (dt ${dtMs}ms): the recorded clock is not monotonic, so no per-step bound can be applied.`,
      );
      return { events, maxDisplacementU, maxDisplacementSampleIndex, refusals };
    }
    const displacementU = distance(buffers.x[i - 1], buffers.y[i - 1], buffers.x[i], buffers.y[i]);
    if (displacementU > maxDisplacementU) {
      maxDisplacementU = displacementU;
      maxDisplacementSampleIndex = i;
    }
    const allowedU = (context.bound.maxSpeedUPerSec * dtMs) / 1000 + POSITION_EPSILON_U;
    if (displacementU <= allowedU) continue;

    const to = { x: buffers.x[i], y: buffers.y[i] };
    const atSpawn = near(context.spawn, to.x, to.y, RESPAWN_TOLERANCE_U);
    const atRespawn = context.respawn !== undefined && near(context.respawn, to.x, to.y, RESPAWN_TOLERANCE_U);
    events.push({
      sampleIndex: i,
      frame: buffers.frame[i],
      tMs: buffers.tMs[i],
      displacementU,
      allowedU,
      dtMs,
      from: { x: buffers.x[i - 1], y: buffers.y[i - 1] },
      to,
      classification: atSpawn || atRespawn ? "respawn" : "unexplained",
      reason:
        atSpawn || atRespawn
          ? `the step ended within ${RESPAWN_TOLERANCE_U}u of the ${atRespawn ? "declared respawn point" : "spawn point"} read from the scene at window open: the game's own death teleport.`
          : `the step covered ${displacementU.toFixed(3)}u in ${dtMs.toFixed(1)}ms, against ${allowedU.toFixed(3)}u allowed by the contract's own feel targets, and did not end at the spawn or declared respawn point.`,
    });
  }

  return { events, maxDisplacementU, maxDisplacementSampleIndex, refusals };
}

// ── the state transitions ───────────────────────────────────────────────────

export interface WinTransition {
  /** Index of the first sample where the win field reads true. */
  sampleIndex: number;
  frame: number;
  tMs: number;
}

export interface ScoreIncrement {
  sampleIndex: number;
  frame: number;
  tMs: number;
  from: number;
  to: number;
}

export interface LoseObservation {
  /** True when some sample recorded zero lives. */
  livesReachedZero: boolean;
  sampleIndex: number | null;
  /**
   * The control (H7): the win field must NOT be true on a sample where lives are
   * zero. A game whose win flag fires on death is not a game.
   */
  winTrueWhileDead: boolean;
}

// ── the headline ────────────────────────────────────────────────────────────

export interface PostWinProbeInput {
  /** Trajectory of the post-win FREEZE probe (no input driven). */
  freezeSamples?: { tMs: number; x: number; y: number }[];
  /** Trajectory of the post-win INPUT-LOCK probe (movement key held). */
  inputLockSamples?: { tMs: number; x: number; y: number }[];
  /** The second recorder window, drained after the restart key was tapped. */
  restartBuffers?: ObservationBuffers;
}

export interface PlayabilityHeadline {
  completable: boolean;
  completionMethod: "played" | "assisted";
  winRuleObserved?: string;
  hazardKills?: boolean;
  collectibleIncrements?: boolean;
  postWinInputLocked?: boolean;
  postWinPlayerFrozen?: boolean;
  restartWorks?: boolean;
}

export interface PlayabilityDerivation {
  /**
   * Hard refusals. A non-empty list means the window cannot support ANY headline:
   * the producer refuses to write the file and the gate refuses to grade it.
   */
  refusals: string[];
  headline: PlayabilityHeadline;
  observation: {
    sampleCount: number;
    droppedSamples: number;
    durationMs: number;
    /** Sample rate re-derived from the retained buffer, never a declared constant. */
    effectiveSampleRateHz: number | null;
    win: WinTransition | null;
    winAtOpen: boolean | null;
    continuity: ContinuityResult;
    scoreIncrements: ScoreIncrement[];
    lose: LoseObservation;
    /** How `winRuleObserved` was decided, in the file so the check is auditable. */
    winRuleCheck: { rule: WinRuleKind; satisfied: boolean; detail: string };
    probes: {
      freeze: { measured: boolean; maxDisplacementU: number | null };
      inputLock: { measured: boolean; maxDisplacementU: number | null };
      restart: { measured: boolean; winCleared: boolean | null; scoreReset: boolean | null };
    };
  };
}

function maxDisplacement(samples: { x: number; y: number }[] | undefined): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  let worst = 0;
  for (const sample of samples) {
    const d = distance(samples[0].x, samples[0].y, sample.x, sample.y);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * THE derivation. Both the producer (writing `playability.json`) and the gate
 * (grading it) call exactly this, over exactly the buffers the file retains, so a
 * headline the buffers do not produce cannot exist in a green run.
 */
export function derivePlayability(
  buffers: ObservationBuffers,
  context: ObservationContext,
  probes: PostWinProbeInput = {},
): PlayabilityDerivation {
  const refusals: string[] = [];
  const count = buffers.tMs.length;

  // ── window integrity ──────────────────────────────────────────────────────
  if (context.droppedSamples > 0) {
    refusals.push(
      `the recorder's ring wrapped and dropped ${context.droppedSamples} sample(s): the continuity proof needs the WHOLE window, ` +
        "because the one frame it cannot see is exactly where a teleport would hide. Re-run the observation with a larger ring or a shorter drive.",
    );
  }
  if (count < 2) {
    refusals.push(`the drained buffer holds ${count} sample(s): nothing can be derived from it.`);
  }
  for (const key of ["frame", "fixedTick", "x", "y", "win"] as const) {
    const column = buffers[key];
    if (!Array.isArray(column) || column.length !== count) {
      refusals.push(
        `buffer column "${key}" holds ${Array.isArray(column) ? column.length : "no"} entr(ies) against ${count} timestamps: the parallel buffers are not aligned, so no sample can be read.`,
      );
    }
  }

  // A NON-FINITE position is a refusal, never a skipped step. The recorder writes
  // NaN when the player object is gone (a repeated position would read as "standing
  // still"), and NaN fails every comparison silently: `NaN > allowed` is false, so a
  // trace full of NaN would sail through the continuity walk with zero events. That
  // is the falsy-skip shape CLAUDE.md forbids, wearing a float's clothes.
  for (const axis of ["x", "y"] as const) {
    const bad = buffers[axis].findIndex((value) => !Number.isFinite(value));
    if (bad >= 0) {
      refusals.push(
        `the player's ${axis} position is not a finite number at sample ${bad}: the recorder could not read the player there ` +
          "(destroyed or unresolvable), so the continuity proof has a blind step and cannot certify this window.",
      );
    }
  }

  const nullWin = buffers.win.findIndex((value) => value === null || value === undefined);
  if (nullWin >= 0) {
    refusals.push(
      `the win field was unreadable at sample ${nullWin} (the recorder recorded null rather than inventing a value): an absent binding is a refusal, never a skip.`,
    );
  }

  // ── the win transition (H7: false at open, and it must CHANGE) ────────────
  const winAtOpen = count > 0 ? (buffers.win[0] ?? null) : null;
  if (winAtOpen === true) {
    refusals.push(
      "the win field was ALREADY TRUE when the observation window opened, so nothing this window recorded can show the level being completed: " +
        "the flag may have been set before the recorder started, or the game was never reset. Re-enter play and re-open the window.",
    );
  }
  let win: WinTransition | null = null;
  for (let i = 1; i < count; i += 1) {
    if (buffers.win[i] === true && buffers.win[i - 1] === false) {
      win = { sampleIndex: i, frame: buffers.frame[i], tMs: buffers.tMs[i] };
      break;
    }
  }
  if (win === null) {
    refusals.push(
      "the win field never changed state inside the observation window: no completion was observed. " +
        "A window with no transition cannot certify `completable`, whatever else it recorded.",
    );
  }

  // ── continuity ────────────────────────────────────────────────────────────
  const continuity = deriveContinuity(buffers, context);
  refusals.push(...continuity.refusals);
  const decidingEvents = continuity.events.filter(
    (event) => win === null || event.sampleIndex <= win.sampleIndex,
  );
  const unexplained = decidingEvents.filter((event) => event.classification === "unexplained");
  const completionMethod: PlayabilityHeadline["completionMethod"] =
    unexplained.length > 0 ? "assisted" : "played";

  // ── score / lives ─────────────────────────────────────────────────────────
  const scoreIncrements: ScoreIncrement[] = [];
  let collectibleIncrements: boolean | undefined;
  if (Array.isArray(buffers.score)) {
    const score = buffers.score;
    const nullScore = score.findIndex((value) => value === null || value === undefined);
    if (nullScore >= 0) {
      refusals.push(
        `the score field was unreadable at sample ${nullScore}: the harness declares it, so an unreadable read is a refusal, never a zero.`,
      );
    } else {
      for (let i = 1; i < count; i += 1) {
        const from = score[i - 1] as number;
        const to = score[i] as number;
        if (to > from) {
          scoreIncrements.push({ sampleIndex: i, frame: buffers.frame[i], tMs: buffers.tMs[i], from, to });
        }
      }
      collectibleIncrements = scoreIncrements.length > 0;
      // The cross-check (H7): score increments are bound to the collectible COUNT
      // the bridge read from the scene at open. More increments than collectibles
      // means the score moved for a reason the scene does not explain.
      if (context.collectibleTotal > 0 && scoreIncrements.length > context.collectibleTotal) {
        refusals.push(
          `the window recorded ${scoreIncrements.length} score increment(s) against ${context.collectibleTotal} collectible object(s) counted in the scene at open: ` +
            "the score moved more times than there are things to collect, so the increments are not bound to collection.",
        );
      }
    }
  }

  let hazardKills: boolean | undefined;
  const lose: LoseObservation = { livesReachedZero: false, sampleIndex: null, winTrueWhileDead: false };
  if (Array.isArray(buffers.lives)) {
    const lives = buffers.lives;
    const nullLives = lives.findIndex((value) => value === null || value === undefined);
    if (nullLives >= 0) {
      refusals.push(
        `the lives field was unreadable at sample ${nullLives}: the harness declares it, so an unreadable read is a refusal, never a zero.`,
      );
    } else {
      hazardKills = false;
      for (let i = 1; i < count; i += 1) {
        if ((lives[i] as number) < (lives[i - 1] as number)) hazardKills = true;
      }
      for (let i = 0; i < count; i += 1) {
        if ((lives[i] as number) > 0) continue;
        if (!lose.livesReachedZero) {
          lose.livesReachedZero = true;
          lose.sampleIndex = i;
        }
        if (buffers.win[i] === true) lose.winTrueWhileDead = true;
      }
      if (lose.winTrueWhileDead) {
        refusals.push(
          "the win field read TRUE on a sample where lives were zero: the game reports a win on a loss, which no completion evidence can certify.",
        );
      }
    }
  }

  // ── the win rule, checked against the buffers rather than declared ────────
  const winRuleCheck = checkWinRule(buffers, context, win, scoreIncrements);
  const winRuleObserved = winRuleCheck.satisfied ? context.contractWinRule : undefined;

  // ── the post-win probes ───────────────────────────────────────────────────
  const freezeDisplacement = maxDisplacement(probes.freezeSamples);
  const lockDisplacement = maxDisplacement(probes.inputLockSamples);
  const restart = deriveRestart(probes.restartBuffers, buffers);

  const durationMs = count >= 2 ? buffers.tMs[count - 1] - buffers.tMs[0] : 0;
  const effectiveSampleRateHz = count >= 2 && durationMs > 0 ? ((count - 1) / durationMs) * 1000 : null;

  return {
    refusals,
    headline: {
      completable: win !== null,
      completionMethod,
      ...(winRuleObserved === undefined ? {} : { winRuleObserved }),
      ...(hazardKills === undefined ? {} : { hazardKills }),
      ...(collectibleIncrements === undefined ? {} : { collectibleIncrements }),
      ...(freezeDisplacement === null ? {} : { postWinPlayerFrozen: freezeDisplacement <= FROZEN_EPSILON_U }),
      ...(lockDisplacement === null ? {} : { postWinInputLocked: lockDisplacement <= FROZEN_EPSILON_U }),
      ...(restart.measured ? { restartWorks: restart.winCleared === true && restart.scoreReset !== false } : {}),
    },
    observation: {
      sampleCount: count,
      droppedSamples: context.droppedSamples,
      durationMs,
      effectiveSampleRateHz,
      win,
      winAtOpen,
      continuity,
      scoreIncrements,
      lose,
      winRuleCheck,
      probes: {
        freeze: { measured: freezeDisplacement !== null, maxDisplacementU: freezeDisplacement },
        inputLock: { measured: lockDisplacement !== null, maxDisplacementU: lockDisplacement },
        restart: {
          measured: restart.measured,
          winCleared: restart.winCleared,
          scoreReset: restart.scoreReset,
        },
      },
    },
  };
}

/**
 * The win rule, as a CHECK rather than a declaration. `harness.playability.winRule`
 * names one of a closed set whose semantics this function knows; the contract's
 * free-text `win.rule` is echoed into `winRuleObserved` ONLY when the check passes
 * against the recorded window. So the string the gate compares is still the
 * contract's, but it can only appear when the buffers back it.
 */
function checkWinRule(
  buffers: ObservationBuffers,
  context: ObservationContext,
  win: WinTransition | null,
  scoreIncrements: ScoreIncrement[],
): PlayabilityDerivation["observation"]["winRuleCheck"] {
  if (win === null) {
    return { rule: context.winRule, satisfied: false, detail: "no win transition was observed, so no win rule could be checked." };
  }
  if (context.winRule === "all-collectibles") {
    if (context.collectibleTotal <= 0) {
      return {
        rule: context.winRule,
        satisfied: false,
        detail:
          "the harness declares the all-collectibles rule but the bridge counted 0 matching collectible objects in the scene at open: " +
          "the declared collectible query matches nothing, so the rule cannot be checked (fix the query, do not relax the rule).",
      };
    }
    const before = scoreIncrements.filter((entry) => entry.sampleIndex <= win.sampleIndex).length;
    const satisfied = before >= context.collectibleTotal;
    return {
      rule: context.winRule,
      satisfied,
      detail: satisfied
        ? `${before} score increment(s) were recorded at or before the win sample, against ${context.collectibleTotal} collectible object(s) counted in the scene at open.`
        : `only ${before} score increment(s) were recorded before the win fired, against ${context.collectibleTotal} collectible object(s) in the scene: the win did not require collecting them all.`,
    };
  }
  // reach-goal
  if (!context.goal) {
    return {
      rule: context.winRule,
      satisfied: false,
      detail:
        "the harness declares the reach-goal rule but named no goal object for the bridge to read at open, so there is no position to check the win against.",
    };
  }
  const radius = context.goalRadiusU ?? DEFAULT_GOAL_RADIUS_U;
  const dx = buffers.x[win.sampleIndex];
  const dy = buffers.y[win.sampleIndex];
  const separation = distance(context.goal.x, context.goal.y, dx, dy);
  const satisfied = separation <= radius;
  return {
    rule: context.winRule,
    satisfied,
    detail: satisfied
      ? `the player was ${separation.toFixed(3)}u from the goal object (read from the scene at open) on the sample the win fired, within the ${radius}u reach radius.`
      : `the player was ${separation.toFixed(3)}u from the goal object on the sample the win fired, outside the ${radius}u reach radius: the win did not fire from reaching the goal.`,
  };
}

/** The restart probe: a SECOND recorded window, drained after the restart key was tapped. */
function deriveRestart(
  restartBuffers: ObservationBuffers | undefined,
  playBuffers: ObservationBuffers,
): { measured: boolean; winCleared: boolean | null; scoreReset: boolean | null } {
  if (!restartBuffers || restartBuffers.tMs.length < 2) {
    return { measured: false, winCleared: null, scoreReset: null };
  }
  const last = restartBuffers.tMs.length - 1;
  const winCleared = restartBuffers.win[last] === false;
  let scoreReset: boolean | null = null;
  if (Array.isArray(restartBuffers.score) && Array.isArray(playBuffers.score) && playBuffers.score.length > 0) {
    const finalScore = restartBuffers.score[last];
    const openingScore = playBuffers.score[0];
    if (typeof finalScore === "number" && typeof openingScore === "number") {
      scoreReset = finalScore <= openingScore;
    }
  }
  return { measured: true, winCleared, scoreReset };
}
