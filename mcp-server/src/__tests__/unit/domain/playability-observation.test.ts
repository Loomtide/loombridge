/**
 * THE PLAYABILITY DERIVATIONS against SYNTHETIC RECORDINGS (evidence arc stage 3).
 *
 * Every fixture below is a hand-built play window whose truth is known, so each
 * assertion is a recovery rather than a restatement: a clean run must derive
 * "played", a run with one 3-unit single-frame hop must derive "assisted", a hop
 * that lands back at spawn must be classified as the game's own respawn, and a
 * window that cannot support a verdict at all (win already true, win never fired,
 * a wrapped ring) must REFUSE rather than produce a headline.
 *
 * These are the functions BOTH the producer and the gate run, so a fixture that
 * passes here is a headline the gate will reproduce from the same buffers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DASH_MIN_SECONDS,
  FALL_SPEED_FACTOR,
  KINEMATIC_MARGIN,
  derivePlayability,
  deriveContinuity,
  deriveKinematicBound,
  type ObservationBuffers,
  type ObservationContext,
} from "../../../domain/playability-observation.js";

// ── the contract under test ─────────────────────────────────────────────────

const CONTRACT = {
  feel: {
    runSpeed: { target: 7 },
    jumpApex: { target: 2.2 },
    timeToApex: { target: 0.28 },
    dashDistance: { target: 2.8 },
  },
  win: { rule: "all-fruit" },
};

const DT_MS = 1000 / 60;

interface BuildOptions {
  samples?: number;
  /** Horizontal units travelled per frame during ordinary play. */
  stepU?: number;
  /** Sample index where the win field flips false to true. */
  winAt?: number | null;
  /** Sample indices where the score increments. */
  scoreAt?: number[];
  /** Sample indices where lives decrement. */
  loseLifeAt?: number[];
  startingLives?: number;
  /** A single-frame position jump: { at, dx, dy } applied cumulatively from `at`. */
  hop?: { at: number; dx: number; dy?: number };
  /** A single-frame jump back to an absolute point (the respawn shape). */
  teleportTo?: { at: number; x: number; y: number };
  winAtOpen?: boolean;
}

/** A synthetic recording: ordinary running, with whatever anomaly the test wants. */
function buildBuffers(options: BuildOptions = {}): ObservationBuffers {
  const count = options.samples ?? 200;
  const step = options.stepU ?? 0.1; // 6 u/s at 60Hz, inside the bound
  const winAt = options.winAt === undefined ? 150 : options.winAt;
  const scoreAt = new Set(options.scoreAt ?? [40, 80, 120]);
  const loseAt = new Set(options.loseLifeAt ?? [60]);

  const buffers: ObservationBuffers = {
    tMs: [],
    frame: [],
    fixedTick: [],
    x: [],
    y: [],
    win: [],
    score: [],
    lives: [],
  };

  let x = 0;
  let score = 0;
  let lives = options.startingLives ?? 3;
  let win = options.winAtOpen === true;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) x += step;
    if (options.hop && i === options.hop.at) x += options.hop.dx;
    let y = 1;
    if (options.teleportTo && i === options.teleportTo.at) {
      x = options.teleportTo.x;
      y = options.teleportTo.y;
    }
    if (scoreAt.has(i)) score += 1;
    if (loseAt.has(i)) lives -= 1;
    if (winAt !== null && i === winAt) win = true;

    buffers.tMs.push(Math.round(i * DT_MS * 1000) / 1000);
    buffers.frame.push(1000 + i);
    buffers.fixedTick.push(i);
    buffers.x.push(Math.round(x * 1e6) / 1e6);
    buffers.y.push(y);
    buffers.win.push(win);
    (buffers.score as number[]).push(score);
    (buffers.lives as number[]).push(lives);
  }
  return buffers;
}

function contextFor(overrides: Partial<ObservationContext> = {}): ObservationContext {
  const bound = deriveKinematicBound(CONTRACT);
  assert.ok(bound.ok, "the fixture contract must yield a kinematic bound");
  return {
    winRule: "all-collectibles",
    contractWinRule: "all-fruit",
    collectibleTotal: 3,
    spawn: { x: 0, y: 1 },
    droppedSamples: 0,
    bound: bound.bound,
    ...overrides,
  };
}

/** A frozen post-win probe: the player does not move. */
function frozenSamples(): { tMs: number; x: number; y: number }[] {
  return Array.from({ length: 30 }, (_, i) => ({ tMs: i * DT_MS, x: 20, y: 1 }));
}

/** A moving post-win probe: the player still responds to input. */
function movingSamples(): { tMs: number; x: number; y: number }[] {
  return Array.from({ length: 30 }, (_, i) => ({ tMs: i * DT_MS, x: 20 + i * 0.1, y: 1 }));
}

/** A restart window: the win field is back to false and the score reset. */
function restartBuffers(): ObservationBuffers {
  return {
    tMs: [0, 16.667, 33.333],
    frame: [2000, 2001, 2002],
    fixedTick: [0, 1, 2],
    x: [0, 0, 0],
    y: [1, 1, 1],
    win: [true, false, false],
    score: [3, 0, 0],
    lives: [1, 3, 3],
  };
}

function probesFor(overrides: Record<string, unknown> = {}): Parameters<typeof derivePlayability>[2] {
  return {
    freezeSamples: frozenSamples(),
    inputLockSamples: frozenSamples(),
    restartBuffers: restartBuffers(),
    ...overrides,
  };
}

// ── the bound ───────────────────────────────────────────────────────────────

test("deriveKinematicBound: the bound is the FASTEST contract term times the margin, with every term recorded", () => {
  const resolution = deriveKinematicBound(CONTRACT);
  assert.ok(resolution.ok);
  const bound = resolution.bound;
  const launch = (2 * 2.2) / 0.28;
  const expected = launch * FALL_SPEED_FACTOR * KINEMATIC_MARGIN;
  assert.ok(Math.abs(bound.maxSpeedUPerSec - expected) < 1e-9, `expected ${expected}, got ${bound.maxSpeedUPerSec}`);
  assert.deepEqual(
    bound.terms.map((term) => term.term).sort(),
    ["dash", "fall", "jump-launch", "run"],
  );
  const dash = bound.terms.find((term) => term.term === "dash");
  assert.ok(dash && Math.abs(dash.speedUPerSec - 2.8 / DASH_MIN_SECONDS) < 1e-9);
});

test("deriveKinematicBound: timeToApex declared in MILLISECONDS is converted, not read as seconds", () => {
  // TideRunner's own contract writes `timeToApex: { target: 325, unit: "ms" }`.
  // Read as seconds it would deflate the jump term a thousandfold.
  const inMs = deriveKinematicBound({
    feel: { jumpApex: { target: 2.2 }, timeToApex: { target: 325, unit: "ms" } },
  });
  const inSeconds = deriveKinematicBound({
    feel: { jumpApex: { target: 2.2 }, timeToApex: { target: 0.325, unit: "s" } },
  });
  assert.ok(inMs.ok && inSeconds.ok);
  assert.ok(Math.abs(inMs.bound.maxSpeedUPerSec - inSeconds.bound.maxSpeedUPerSec) < 1e-9);

  // An ABSENT unit reads as seconds, which is the conservative direction: the
  // bound gets tighter, never wide enough to wave a teleport through.
  const noUnit = deriveKinematicBound({ feel: { jumpApex: { target: 2.2 }, timeToApex: { target: 325 } } });
  assert.ok(noUnit.ok);
  assert.ok(noUnit.bound.maxSpeedUPerSec < inMs.bound.maxSpeedUPerSec);
});

test("deriveKinematicBound: a contract with no usable feel target REFUSES (absent binding is never a default)", () => {
  const resolution = deriveKinematicBound({ feel: { runSpeed: { band: 1 } }, win: { rule: "x" } });
  assert.equal(resolution.ok, false);
  assert.match(resolution.ok ? "" : resolution.refusal, /no usable `feel` target/);
  assert.match(resolution.ok ? "" : resolution.refusal, /would certify any motion as played/);
});

// ── continuity ──────────────────────────────────────────────────────────────

test("deriveContinuity: an ordinary run produces no super-kinematic event", () => {
  const result = deriveContinuity(buildBuffers(), contextFor());
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.refusals, []);
  assert.ok(result.maxDisplacementU < 0.2);
});

test("deriveContinuity: per-step dt, so a frame HITCH is not a teleport", () => {
  // One 200ms frame in which a 6 u/s player legitimately covers 1.2u: far past a
  // nominal 1/60 allowance, exactly what a per-step bound must absorb.
  const buffers = buildBuffers({ samples: 10 });
  buffers.tMs[5] = buffers.tMs[4] + 200;
  for (let i = 6; i < buffers.tMs.length; i += 1) buffers.tMs[i] = buffers.tMs[i - 1] + DT_MS;
  buffers.x[5] = buffers.x[4] + 1.2;
  for (let i = 6; i < buffers.x.length; i += 1) buffers.x[i] = buffers.x[i - 1] + 0.1;
  const result = deriveContinuity(buffers, contextFor());
  assert.deepEqual(result.events, [], "a long frame allows proportionally more travel");
});

test("deriveContinuity: a non-monotonic clock REFUSES instead of measuring a negative step", () => {
  const buffers = buildBuffers({ samples: 10 });
  buffers.tMs[4] = buffers.tMs[3];
  const result = deriveContinuity(buffers, contextFor());
  assert.equal(result.refusals.length, 1);
  assert.match(result.refusals[0], /not strictly after/);
});

// ── FLAGSHIP 1: the 3-unit single-frame hop ─────────────────────────────────

test("FLAGSHIP: one 3u single-frame hop mid-window derives completionMethod 'assisted'", () => {
  const clean = derivePlayability(buildBuffers(), contextFor(), probesFor());
  assert.deepEqual(clean.refusals, []);
  assert.equal(clean.headline.completionMethod, "played", "positive control: the same window without the hop is played");

  const hopped = derivePlayability(buildBuffers({ hop: { at: 80, dx: 3 } }), contextFor(), probesFor());
  assert.deepEqual(hopped.refusals, []);
  assert.equal(hopped.headline.completionMethod, "assisted");
  assert.equal(hopped.headline.completable, true, "the win still fired: the completion is assisted, not absent");

  const events = hopped.observation.continuity.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].classification, "unexplained");
  assert.equal(events[0].sampleIndex, 80);
  assert.ok(events[0].displacementU > 3, "the recorded displacement includes the hop");
  assert.ok(events[0].allowedU < 1, "the bound allows well under a unit per frame at 60Hz");
  assert.match(events[0].reason, /did not end at the spawn or declared respawn point/);
});

test("a respawn-shaped teleport (landing at the spawn point) stays 'played' and is classified as a respawn", () => {
  const buffers = buildBuffers({ teleportTo: { at: 80, x: 0, y: 1 } });
  const derivation = derivePlayability(buffers, contextFor(), probesFor());
  assert.deepEqual(derivation.refusals, []);
  assert.equal(derivation.headline.completionMethod, "played");
  const events = derivation.observation.continuity.events;
  assert.equal(events.length, 1, "the step is still RECORDED, never filtered out");
  assert.equal(events[0].classification, "respawn");
  assert.match(events[0].reason, /spawn point/);
});

test("a teleport to a DECLARED respawn point that is not the spawn is a respawn too (ledger L125)", () => {
  const buffers = buildBuffers({ teleportTo: { at: 80, x: 6.4, y: 1.5 } });
  const withoutDeclaration = derivePlayability(buffers, contextFor(), probesFor());
  assert.equal(withoutDeclaration.headline.completionMethod, "assisted", "positive control: undeclared, so unexplained");

  const withDeclaration = derivePlayability(
    buffers,
    contextFor({ respawn: { x: 6.4, y: 1.5 } }),
    probesFor(),
  );
  assert.equal(withDeclaration.headline.completionMethod, "played");
  assert.equal(withDeclaration.observation.continuity.events[0].classification, "respawn");
});

test("a super-kinematic step AFTER the win does not make the completion assisted (it is still recorded)", () => {
  const buffers = buildBuffers({ hop: { at: 180, dx: 5 }, winAt: 150 });
  const derivation = derivePlayability(buffers, contextFor(), probesFor());
  assert.equal(derivation.headline.completionMethod, "played");
  assert.equal(derivation.observation.continuity.events.length, 1);
});

// ── FLAGSHIP 2: win already true at open ────────────────────────────────────

test("FLAGSHIP: a window whose win field is already true at open REFUSES", () => {
  const derivation = derivePlayability(
    buildBuffers({ winAtOpen: true, winAt: null }),
    contextFor(),
    probesFor(),
  );
  assert.ok(derivation.refusals.some((r) => /ALREADY TRUE when the observation window opened/.test(r)));
  assert.equal(derivation.observation.winAtOpen, true);
});

test("a window where the win field never changes REFUSES (no completion observed)", () => {
  const derivation = derivePlayability(buildBuffers({ winAt: null }), contextFor(), probesFor());
  assert.ok(derivation.refusals.some((r) => /never changed state/.test(r)));
  assert.equal(derivation.headline.completable, false);
});

// ── the ring wrap ───────────────────────────────────────────────────────────

test("a WRAPPED ring REFUSES: the continuity proof needs the whole window", () => {
  const clean = derivePlayability(buildBuffers(), contextFor({ droppedSamples: 0 }), probesFor());
  assert.deepEqual(clean.refusals, [], "positive control: the same window with no drop is fine");

  const wrapped = derivePlayability(buildBuffers(), contextFor({ droppedSamples: 12 }), probesFor());
  assert.ok(wrapped.refusals.some((r) => /ring wrapped and dropped 12 sample\(s\)/.test(r)));
  assert.ok(wrapped.refusals.some((r) => /where a teleport would hide/.test(r)));
});

// ── the unreadable field ────────────────────────────────────────────────────

test("an unreadable win/score/lives sample REFUSES rather than reading as false or 0", () => {
  const buffers = buildBuffers();
  buffers.win[10] = null;
  const winRefusal = derivePlayability(buffers, contextFor(), probesFor());
  assert.ok(winRefusal.refusals.some((r) => /win field was unreadable at sample 10/.test(r)));

  const scoreBuffers = buildBuffers();
  (scoreBuffers.score as (number | null)[])[10] = null;
  const scoreRefusal = derivePlayability(scoreBuffers, contextFor(), probesFor());
  assert.ok(scoreRefusal.refusals.some((r) => /score field was unreadable at sample 10/.test(r)));

  const livesBuffers = buildBuffers();
  (livesBuffers.lives as (number | null)[])[10] = null;
  const livesRefusal = derivePlayability(livesBuffers, contextFor(), probesFor());
  assert.ok(livesRefusal.refusals.some((r) => /lives field was unreadable at sample 10/.test(r)));
});

// ── the score / collectible cross-check (H7) ────────────────────────────────

test("score increments are bound to the scene's collectible COUNT", () => {
  const ok = derivePlayability(buildBuffers(), contextFor({ collectibleTotal: 3 }), probesFor());
  assert.deepEqual(ok.refusals, []);
  assert.equal(ok.headline.collectibleIncrements, true);
  assert.equal(ok.observation.scoreIncrements.length, 3);
  assert.equal(ok.headline.winRuleObserved, "all-fruit");

  const inflated = derivePlayability(buildBuffers(), contextFor({ collectibleTotal: 2 }), probesFor());
  assert.ok(inflated.refusals.some((r) => /score moved more times than there are things to collect/.test(r)));
});

test("all-collectibles: a win before every collectible was taken does NOT report the contract's rule", () => {
  const derivation = derivePlayability(
    buildBuffers({ scoreAt: [40, 160], winAt: 150 }),
    contextFor({ collectibleTotal: 3 }),
    probesFor(),
  );
  assert.equal(derivation.headline.winRuleObserved, undefined, "the contract string is only echoed when the check passes");
  assert.equal(derivation.observation.winRuleCheck.satisfied, false);
  assert.match(derivation.observation.winRuleCheck.detail, /did not require collecting them all/);
});

test("reach-goal: the check is the player's DISTANCE to the goal object on the win sample", () => {
  const buffers = buildBuffers({ winAt: 150 });
  const goalX = buffers.x[150];
  const atGoal = derivePlayability(
    buffers,
    contextFor({ winRule: "reach-goal", goal: { x: goalX, y: 1 } }),
    probesFor(),
  );
  assert.equal(atGoal.headline.winRuleObserved, "all-fruit");
  assert.match(atGoal.observation.winRuleCheck.detail, /within the 1.5u reach radius/);

  const farFromGoal = derivePlayability(
    buffers,
    contextFor({ winRule: "reach-goal", goal: { x: goalX + 40, y: 1 } }),
    probesFor(),
  );
  assert.equal(farFromGoal.headline.winRuleObserved, undefined);
  assert.match(farFromGoal.observation.winRuleCheck.detail, /outside the 1.5u reach radius/);

  const noGoal = derivePlayability(buffers, contextFor({ winRule: "reach-goal" }), probesFor());
  assert.equal(noGoal.observation.winRuleCheck.satisfied, false);
  assert.match(noGoal.observation.winRuleCheck.detail, /named no goal object/);
});

// ── hazard / lose ───────────────────────────────────────────────────────────

test("hazardKills is a lives DECREMENT in the recording, and the lose path is observed not declared", () => {
  const withHazard = derivePlayability(buildBuffers({ loseLifeAt: [60] }), contextFor(), probesFor());
  assert.equal(withHazard.headline.hazardKills, true);
  assert.equal(withHazard.observation.lose.livesReachedZero, false);

  const noHazard = derivePlayability(buildBuffers({ loseLifeAt: [] }), contextFor(), probesFor());
  assert.equal(noHazard.headline.hazardKills, false);
});

test("a win field reading TRUE while lives are zero REFUSES", () => {
  const buffers = buildBuffers({ loseLifeAt: [60, 61, 62], startingLives: 3, winAt: 150 });
  const derivation = derivePlayability(buffers, contextFor(), probesFor());
  assert.equal(derivation.observation.lose.livesReachedZero, true);
  assert.ok(derivation.refusals.some((r) => /win field read TRUE on a sample where lives were zero/.test(r)));
});

// ── the post-win probes ─────────────────────────────────────────────────────

test("the post-win probes are measured from their own traces, never declared", () => {
  const frozen = derivePlayability(buildBuffers(), contextFor(), probesFor());
  assert.equal(frozen.headline.postWinPlayerFrozen, true);
  assert.equal(frozen.headline.postWinInputLocked, true);
  assert.equal(frozen.headline.restartWorks, true);

  const leaky = derivePlayability(
    buildBuffers(),
    contextFor(),
    probesFor({ inputLockSamples: movingSamples() }),
  );
  assert.equal(leaky.headline.postWinInputLocked, false, "the player moved under held input behind the overlay");
  assert.equal(leaky.headline.postWinPlayerFrozen, true);

  const falling = derivePlayability(
    buildBuffers(),
    contextFor(),
    probesFor({ freezeSamples: movingSamples() }),
  );
  assert.equal(falling.headline.postWinPlayerFrozen, false);
});

test("an absent probe leaves its field ABSENT (never a fabricated true)", () => {
  const derivation = derivePlayability(buildBuffers(), contextFor(), { freezeSamples: frozenSamples() });
  assert.equal(derivation.headline.postWinPlayerFrozen, true);
  assert.equal(derivation.headline.postWinInputLocked, undefined);
  assert.equal(derivation.headline.restartWorks, undefined);
  assert.equal(derivation.observation.probes.restart.measured, false);
});

test("restartWorks is false when the second window still shows the win set", () => {
  const stuck = restartBuffers();
  stuck.win = [true, true, true];
  const derivation = derivePlayability(buildBuffers(), contextFor(), probesFor({ restartBuffers: stuck }));
  assert.equal(derivation.headline.restartWorks, false);
});

// ── accounting ──────────────────────────────────────────────────────────────

test("the effective sample rate is re-derived from the retained buffer, never declared", () => {
  const derivation = derivePlayability(buildBuffers({ samples: 61 }), contextFor(), probesFor());
  const rate = derivation.observation.effectiveSampleRateHz;
  assert.ok(rate !== null && Math.abs(rate - 60) < 0.01, `expected ~60Hz, got ${String(rate)}`);
  assert.equal(derivation.observation.sampleCount, 61);
});

test("a NON-FINITE player position REFUSES (NaN loses every comparison silently)", () => {
  // The recorder writes NaN when the player object is gone. NaN > allowed is FALSE,
  // so without an explicit refusal a trace full of NaN produces zero super-kinematic
  // events and reads as a clean played run: the falsy-skip shape in float clothing.
  const buffers = buildBuffers();
  buffers.x[42] = Number.NaN;
  const derivation = derivePlayability(buffers, contextFor(), probesFor());
  assert.ok(derivation.refusals.some((r) => /player's x position is not a finite number at sample 42/.test(r)));

  const clean = derivePlayability(buildBuffers(), contextFor(), probesFor());
  assert.deepEqual(clean.refusals, [], "positive control: the same window with finite positions is fine");
});

test("misaligned parallel buffers REFUSE (a short column cannot be read as a full window)", () => {
  const buffers = buildBuffers({ samples: 20 });
  buffers.win = buffers.win.slice(0, 10);
  const derivation = derivePlayability(buffers, contextFor(), probesFor());
  assert.ok(derivation.refusals.some((r) => /parallel buffers are not aligned/.test(r)));
});
