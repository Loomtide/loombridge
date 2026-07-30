/**
 * KNOWN-TRUTH RECOVERY for the tick-indexing convention (ledger L76, review H9).
 *
 * The thing under test is the derivation in `domain/feel-primitives.ts` that turns a
 * threshold sweep's raw op echoes into a coyote/jumpBuffer window. The door-one run
 * computed that number in a scratch assembler with an agent-chosen `+2`, and the
 * choice was worth more than the measurement: `+0` gave 0.0667 (out of band), `+1`
 * gave 0.0833, `+2` gave 0.1000, dead on target. Nothing could audit it.
 *
 * WHY THIS TEST IS NOT AN ASSERTION ABOUT THE CONVENTION. A test that checked
 * `elapsed === press − reference + 2` would prove only that someone typed 2 in two
 * places; it would pass just as happily if the convention were wrong. So the fixture
 * is a scripted CONTROLLER SIMULATION with a DECLARED window, run at two different
 * declared values, emitting the same echo shape the bridge emits (per-phase
 * sampleCounts plus a one-sample-per-tick trajectory). The derivation, which sees
 * only those echoes, must recover both declared values.
 *
 *   - a constant answer cannot satisfy two different truths;
 *   - a one-tick bias in EITHER direction misses both by a whole tick, and the
 *     recovery tolerance is three quarters of a tick, so the LITMUS below fires.
 *
 * The simulation models the two mechanisms the convention is built from, stated in
 * physical terms rather than as index arithmetic: sample `i` shows the state AFTER
 * step `i-1`, and an injected key is consumed ONE step after the sample index its
 * phase begins at. Those are properties of the harness, and the live door-one run
 * corroborates them (the `+2` that recovered a declared 0.10s from real trials).
 * E6 re-validates on the real editor.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_SAMPLE_TICK_OFFSET,
  deriveSweepMetric,
  firstDescentSampleIndex,
  landingSampleIndexAfter,
  observeSweepTrial,
  type SweepMetric,
  type SweepTrialEcho,
  type TickSample,
} from "../../../domain/feel-primitives.js";

const DT = 1 / 60;
const GRAVITY = -30; // u/s²
const JUMP_SPEED = 12; // u/s
const WALK_SPEED = 7; // u/s
const GROUND_Y = 0;
/** The platform's right edge: past it there is a 5u drop to the ground below. */
const LEDGE_X = 2;
const LOWER_GROUND_Y = -5;

// ── the scripted controller ─────────────────────────────────────────────────

interface SimResult {
  samples: TickSample[];
}

/**
 * A coyote trial. The player walks right, crosses `LEDGE_X` (which is when it really
 * leaves the ground), and a jump key is pressed at a phase whose FIRST SAMPLE index
 * is `pressSampleIndex`.
 *
 * Two harness facts are modelled explicitly and are the only link to the convention:
 *   - the key is consumed at step `pressSampleIndex + 1` (one tick of injection latency);
 *   - `samples[i]` is the state after step `i-1` (so `samples[0]` is the initial state).
 * The DECLARED coyote window is the ground truth the derivation has to find.
 */
function simulateCoyoteTrial(
  declaredCoyoteSeconds: number,
  pressSampleIndex: number,
  totalSteps: number,
): SimResult {
  const windowTicks = declaredCoyoteSeconds / DT;
  const pressStep = pressSampleIndex + 1;
  let x = 0;
  let y = GROUND_Y;
  let vy = 0;
  let grounded = true;
  let ungroundStep: number | null = null;
  const samples: TickSample[] = [{ tMs: 0, x, y }];

  for (let step = 0; step < totalSteps; step += 1) {
    // input, consumed at the top of the step
    if (step === pressStep) {
      const airborneFor = ungroundStep === null ? Infinity : step - ungroundStep;
      if (grounded || airborneFor <= windowTicks) {
        vy = JUMP_SPEED;
        grounded = false;
      }
    }
    // integrate
    x += WALK_SPEED * DT;
    if (grounded && x > LEDGE_X) {
      grounded = false;
      ungroundStep = step;
    }
    if (!grounded) {
      vy += GRAVITY * DT;
      y += vy * DT;
      // Past the ledge the floor is the lower ground, so walking off really falls.
      const floor = x > LEDGE_X ? LOWER_GROUND_Y : GROUND_Y;
      if (y <= floor) {
        y = floor;
        vy = 0;
        grounded = true;
      }
    }
    samples.push({ tMs: (step + 1) * DT * 1000, x, y });
  }
  return { samples };
}

/**
 * A jump-buffer trial. The player leaps at step 0, and a second jump is pressed
 * mid-air at a phase whose first sample index is `pressSampleIndex`. A press within
 * the DECLARED buffer window is latched and consumed on the landing step.
 */
function simulateBufferTrial(
  declaredBufferSeconds: number,
  pressSampleIndex: number,
  totalSteps: number,
): SimResult {
  const windowTicks = declaredBufferSeconds / DT;
  const pressStep = pressSampleIndex + 1;
  let x = 0;
  let y = GROUND_Y;
  let vy = JUMP_SPEED;
  let grounded = false;
  let pressedAtStep: number | null = null;
  const samples: TickSample[] = [{ tMs: 0, x, y }];

  for (let step = 0; step < totalSteps; step += 1) {
    if (step === pressStep) pressedAtStep = step;
    if (!grounded) {
      vy += GRAVITY * DT;
      y += vy * DT;
      if (y <= GROUND_Y) {
        // landing step: consume a latched press that is inside the buffer window
        y = GROUND_Y;
        vy = 0;
        grounded = true;
        if (pressedAtStep !== null && step - pressedAtStep <= windowTicks) {
          vy = JUMP_SPEED;
          grounded = false;
          y += vy * DT;
        }
      }
    }
    samples.push({ tMs: (step + 1) * DT * 1000, x, y });
  }
  return { samples };
}

/**
 * Wrap a simulated trajectory in the echo shape the bridge returns: an ordered phase
 * breakdown whose sampleCounts place the press phase, plus `samples[]`. The
 * derivation reads the press index out of THESE, exactly as it does live.
 */
function trialEcho(samples: TickSample[], pressSampleIndex: number, index: number): SweepTrialEcho {
  const tail = samples.length - pressSampleIndex - 2;
  return {
    index,
    pressPhaseIndex: 1,
    phases: [
      { index: 0, sampleCount: pressSampleIndex, keys: [] },
      { index: 1, sampleCount: 2, keys: ["Space"], requestedFixedTicks: 2, actualFixedTicks: 2 },
      { index: 2, sampleCount: Math.max(tail, 0), keys: [] },
    ],
    samples,
  };
}

/** A whole sweep for one declared window: offsets 1..maxOffset around the reference. */
function sweepTrials(
  metric: SweepMetric,
  declaredSeconds: number,
  maxOffset: number,
): SweepTrialEcho[] {
  const trials: SweepTrialEcho[] = [];
  // Locate the reference event once (the same calibration pass the recipe runs).
  const calibration =
    metric === "coyoteTime"
      ? simulateCoyoteTrial(declaredSeconds, 10_000, 90)
      : simulateBufferTrial(declaredSeconds, 10_000, 90);
  const reference = referenceIndexOf(metric, calibration.samples);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    const pressSampleIndex =
      metric === "coyoteTime"
        ? reference + offset - BRIDGE_SAMPLE_TICK_OFFSET
        : reference - offset - BRIDGE_SAMPLE_TICK_OFFSET;
    const sim =
      metric === "coyoteTime"
        ? simulateCoyoteTrial(declaredSeconds, pressSampleIndex, 90)
        : simulateBufferTrial(declaredSeconds, pressSampleIndex, 90);
    trials.push(trialEcho(sim.samples, pressSampleIndex, offset));
  }
  return trials;
}

/**
 * Find the reference sample index with the SAME helpers the live recipe's
 * calibration pass uses, so the fixture cannot drift from the thing it validates.
 */
function referenceIndexOf(metric: SweepMetric, samples: TickSample[]): number {
  const descent = firstDescentSampleIndex(samples);
  assert.ok(descent !== null, "the simulation never left the ground");
  if (metric === "coyoteTime") return descent!;
  const landing = landingSampleIndexAfter(samples, descent!);
  assert.ok(landing !== null, "the simulation never landed");
  return landing!;
}

/** Three quarters of a tick: passes an exact recovery, fails a one-tick bias. */
const RECOVERY_TOLERANCE = DT * 0.75;

// ── the recovery ────────────────────────────────────────────────────────────

for (const declared of [0.1, 0.15]) {
  test(`known-truth recovery: a declared ${declared}s coyote window is recovered from the sweep echoes`, () => {
    const trials = sweepTrials("coyoteTime", declared, 13);
    const derived = deriveSweepMetric("coyoteTime", trials, DT);
    assert.equal(derived.reason, undefined, `sweep refused: ${derived.reason}`);
    assert.ok(derived.windowSeconds !== null);
    assert.ok(
      Math.abs(derived.windowSeconds! - declared) <= RECOVERY_TOLERANCE,
      `recovered ${derived.windowSeconds} from a declared ${declared} (tolerance ${RECOVERY_TOLERANCE})`,
    );
  });

  test(`known-truth recovery: a declared ${declared}s jump buffer is recovered from the sweep echoes`, () => {
    const trials = sweepTrials("jumpBuffer", declared, 13);
    const derived = deriveSweepMetric("jumpBuffer", trials, DT);
    assert.equal(derived.reason, undefined, `sweep refused: ${derived.reason}`);
    assert.ok(derived.windowSeconds !== null);
    assert.ok(
      Math.abs(derived.windowSeconds! - declared) <= RECOVERY_TOLERANCE,
      `recovered ${derived.windowSeconds} from a declared ${declared} (tolerance ${RECOVERY_TOLERANCE})`,
    );
  });
}

test("the two declared windows recover to DIFFERENT values (a constant answer cannot pass this suite)", () => {
  const a = deriveSweepMetric("coyoteTime", sweepTrials("coyoteTime", 0.1, 13), DT).windowSeconds;
  const b = deriveSweepMetric("coyoteTime", sweepTrials("coyoteTime", 0.15, 13), DT).windowSeconds;
  assert.ok(a !== null && b !== null);
  assert.ok(Math.abs(a! - b!) > DT, `the derivation returned ${a} and ${b} for two different declared windows`);
});

// ── LITMUS: bias the derivation by one tick, both truths must fail ───────────

/**
 * The same derivation with the convention offset shifted by ±1 tick. It re-implements
 * only the ONE line under test (the index → tick conversion) and reuses the real
 * threshold selection, so a pass here would mean the recovery above is insensitive
 * to the thing it claims to validate.
 */
function biasedWindow(metric: SweepMetric, trials: SweepTrialEcho[], bias: number): number | null {
  const observations = trials.map((trial, index) => {
    const real = observeSweepTrial(metric, trial, index);
    if (real.elapsedTicks === null) return real;
    // coyote adds the offset, the buffer subtracts it: bias in the direction the
    // convention is applied for this metric.
    const shifted = metric === "coyoteTime" ? real.elapsedTicks + bias : real.elapsedTicks - bias;
    return { ...real, elapsedTicks: shifted };
  });
  const usable = observations.filter((o) => o.refusal === undefined && o.elapsedTicks !== null);
  const jumped = usable.filter((o) => o.jumped).map((o) => o.elapsedTicks!);
  if (jumped.length === 0) return null;
  return Math.max(...jumped) * DT;
}

for (const declared of [0.1, 0.15]) {
  for (const bias of [-1, 1]) {
    test(`LITMUS: a ${bias > 0 ? "+" : ""}${bias}-tick bias fails to recover the declared ${declared}s coyote window`, () => {
      const trials = sweepTrials("coyoteTime", declared, 13);
      const honest = deriveSweepMetric("coyoteTime", trials, DT).windowSeconds!;
      assert.ok(Math.abs(honest - declared) <= RECOVERY_TOLERANCE, "positive control: the honest derivation recovers it");
      const biased = biasedWindow("coyoteTime", trials, bias);
      assert.ok(biased !== null);
      assert.ok(
        Math.abs(biased! - declared) > RECOVERY_TOLERANCE,
        `a ${bias}-tick bias still recovered ${biased} from a declared ${declared}; the recovery test is not sensitive to the convention`,
      );
    });
  }
}

test("LITMUS: a +1-tick bias fails to recover BOTH declared jump-buffer windows", () => {
  for (const declared of [0.1, 0.15]) {
    const trials = sweepTrials("jumpBuffer", declared, 13);
    assert.ok(
      Math.abs(deriveSweepMetric("jumpBuffer", trials, DT).windowSeconds! - declared) <= RECOVERY_TOLERANCE,
      "positive control",
    );
    const biased = biasedWindow("jumpBuffer", trials, 1);
    assert.ok(
      biased !== null && Math.abs(biased - declared) > RECOVERY_TOLERANCE,
      `a one-tick bias still recovered ${biased} from a declared ${declared}`,
    );
  }
});

// ── refusals: the sweep never guesses ───────────────────────────────────────

test("a sweep where nothing failed refuses (the threshold is above the range tried)", () => {
  // Only the offsets INSIDE a 0.15s window, swept against a game whose real window
  // is 0.15s: every trial jumps, so no boundary is bracketed.
  const trials = sweepTrials("coyoteTime", 0.15, 13).slice(0, 5);
  const derived = deriveSweepMetric("coyoteTime", trials, DT);
  assert.equal(derived.windowSeconds, null);
  assert.match(derived.reason ?? "", /every trial registered a jump/);
});

test("a sweep with no retained trials refuses rather than returning a number", () => {
  const derived = deriveSweepMetric("coyoteTime", [], DT);
  assert.equal(derived.windowSeconds, null);
  assert.match(derived.reason ?? "", /no trials were retained/);
});

test("a non-monotonic sweep refuses: no single threshold explains the trials", () => {
  const trials = sweepTrials("coyoteTime", 0.1, 13);
  // Plant a failure EARLIER than a success by swapping two trials' trajectories.
  const swapped = [...trials];
  const early = swapped[1];
  const late = swapped[10];
  swapped[1] = { ...early, samples: late.samples };
  const derived = deriveSweepMetric("coyoteTime", swapped, DT);
  assert.equal(derived.windowSeconds, null);
  assert.match(derived.reason ?? "", /not monotonic/);
});

test("a trial whose phase echo carries no sampleCount is refused, not defaulted to index 0", () => {
  const trials = sweepTrials("coyoteTime", 0.1, 13);
  const broken: SweepTrialEcho = {
    ...trials[0],
    phases: [{ index: 0, keys: [] }, ...trials[0].phases.slice(1)],
  };
  const observation = observeSweepTrial("coyoteTime", broken, 0);
  assert.equal(observation.elapsedTicks, null);
  assert.match(observation.refusal ?? "", /press-phase sample index/);
});

test("a trial with no usable trajectory is refused", () => {
  const observation = observeSweepTrial(
    "coyoteTime",
    { pressPhaseIndex: 1, phases: [{ index: 0, sampleCount: 3 }, { index: 1, sampleCount: 2 }], samples: [] },
    0,
  );
  assert.equal(observation.elapsedTicks, null);
  assert.match(observation.refusal ?? "", /usable trajectory/);
});

test("a coyote trial that jumped BEFORE leaving the ground is refused, not measured", () => {
  // The degenerate case at the bottom of the sweep: the press is consumed while the
  // player is still on the platform, so the trajectory's first descent is the jump's
  // own apex, not a ledge departure. Reading it would report the whole hop as a
  // coyote window.
  const sim = simulateCoyoteTrial(0.1, 2, 90);
  const observation = observeSweepTrial("coyoteTime", trialEcho(sim.samples, 2, 0), 0);
  assert.equal(observation.elapsedTicks, null);
  assert.match(observation.refusal ?? "", /before leaving the ground/);
});
