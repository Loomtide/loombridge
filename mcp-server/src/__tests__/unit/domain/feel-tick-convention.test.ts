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
  ANCHOR_SOURCE_GROUNDED,
  ANCHOR_SOURCE_Y_DESCENT,
  BRIDGE_INJECTION_LATENCY_TICKS,
  BRIDGE_SAMPLE_TICK_OFFSET,
  deriveSweepMetric,
  deriveTickThresholdWindow,
  firstDescentSampleIndex,
  groundedAnchorSampleIndex,
  landingSampleIndexAfter,
  observeSweepTrial,
  type FieldTimelineEcho,
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
  /** The controller's own ground flag, sampled on the trajectory's tick clock. */
  grounded: { tMs: number; value: boolean }[];
}

/**
 * THE PROBE-VS-COLLIDER OVERHANG (E6 session three), in ticks.
 *
 * A controller's ground probe is typically narrower than the player's collider, so it
 * reads FALSE (and the coyote timer starts) while the collider still rests on the ledge
 * and the body has not begun to fall. The trajectory therefore stays flat for a few
 * more ticks, and a sweep that anchors on the first visible descent is late by exactly
 * that many. On TideRunner the gap is two ticks and it moved a real 0.1000s coyote
 * window to a measured 0.0667s. The amount is a property of the RIG, so the fixture
 * declares it and the derivation must not have it baked in anywhere.
 */
const PROBE_OVERHANG_TICKS = 2;

/**
 * A coyote trial. The player walks right, crosses `LEDGE_X` (which is when the ground
 * PROBE detaches and the controller's coyote timer starts), and a jump key is pressed
 * at a phase whose FIRST SAMPLE index is `pressSampleIndex`.
 *
 * Three harness facts are modelled explicitly and are the only link to the convention:
 *   - the key is consumed at step `pressSampleIndex + 1` (one tick of injection latency);
 *   - `samples[i]` is the state after step `i-1` (so `samples[0]` is the initial state);
 *   - for `overhangTicks` steps after the probe detaches the body is still supported by
 *     the ledge, so y does not move and the descent is LATER than the ungrounding.
 * The DECLARED coyote window is the ground truth the derivation has to find, and the
 * controller measures it from the PROBE, exactly as a real one does.
 */
function simulateCoyoteTrial(
  declaredCoyoteSeconds: number,
  pressSampleIndex: number,
  totalSteps: number,
  overhangTicks = 0,
): SimResult {
  const windowTicks = declaredCoyoteSeconds / DT;
  const pressStep = pressSampleIndex + 1;
  let x = 0;
  let y = GROUND_Y;
  let vy = 0;
  let grounded = true;
  let launched = false;
  let ungroundStep: number | null = null;
  const samples: TickSample[] = [{ tMs: 0, x, y }];
  const groundedTimeline = [{ tMs: 0, value: grounded }];

  for (let step = 0; step < totalSteps; step += 1) {
    // input, consumed at the top of the step
    if (step === pressStep) {
      const airborneFor = ungroundStep === null ? Infinity : step - ungroundStep;
      if (grounded || airborneFor <= windowTicks) {
        vy = JUMP_SPEED;
        grounded = false;
        launched = true;
      }
    }
    // integrate
    x += WALK_SPEED * DT;
    if (grounded && x > LEDGE_X) {
      grounded = false;
      ungroundStep = step;
    }
    // The overhang: the probe has let go, the collider has not.
    const supported =
      !launched && ungroundStep !== null && step - ungroundStep < overhangTicks;
    if (!grounded && !supported) {
      vy += GRAVITY * DT;
      y += vy * DT;
      // Past the ledge the floor is the lower ground, so walking off really falls.
      const floor = x > LEDGE_X ? LOWER_GROUND_Y : GROUND_Y;
      if (y <= floor) {
        y = floor;
        vy = 0;
        grounded = true;
        launched = false;
      }
    }
    samples.push({ tMs: (step + 1) * DT * 1000, x, y });
    groundedTimeline.push({ tMs: (step + 1) * DT * 1000, value: grounded });
  }
  return { samples, grounded: groundedTimeline };
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
  const groundedTimeline = [{ tMs: 0, value: grounded }];

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
    groundedTimeline.push({ tMs: (step + 1) * DT * 1000, value: grounded });
  }
  return { samples, grounded: groundedTimeline };
}

/**
 * Wrap a simulated trajectory in the echo shape the bridge returns: an ordered phase
 * breakdown whose sampleCounts place the press phase, plus `samples[]` and (when the
 * seam declared a ground flag) the `fieldTimeline` entry for it. The derivation reads
 * the press index out of THESE, exactly as it does live.
 */
function trialEcho(
  sim: SimResult,
  pressSampleIndex: number,
  index: number,
  withGroundedTimeline = false,
): SweepTrialEcho {
  const tail = sim.samples.length - pressSampleIndex - 2;
  const timeline: FieldTimelineEcho = { id: "grounded", samples: sim.grounded };
  return {
    index,
    pressPhaseIndex: 1,
    phases: [
      { index: 0, sampleCount: pressSampleIndex, keys: [] },
      { index: 1, sampleCount: 2, keys: ["Space"], requestedFixedTicks: 2, actualFixedTicks: 2 },
      { index: 2, sampleCount: Math.max(tail, 0), keys: [] },
    ],
    samples: sim.samples,
    ...(withGroundedTimeline ? { groundedTimeline: timeline } : {}),
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
    trials.push(trialEcho(sim, pressSampleIndex, offset));
  }
  return trials;
}

/**
 * A coyote sweep on a rig whose ground PROBE leads the visible descent by
 * `PROBE_OVERHANG_TICKS`, planned the way the producer plans it when the seam declares
 * `fields.grounded`: the calibration's anchor is the ungrounding STEP read off the
 * flag, and only the injection latency is charged to the press.
 *
 * Every trial retains its own grounded timeline, so the same trials can be derived
 * BOTH ways: that is what pins how much the field is worth.
 */
function groundedSweepTrials(declaredSeconds: number, maxOffset: number): SweepTrialEcho[] {
  const calibration = simulateCoyoteTrial(declaredSeconds, 10_000, 120, PROBE_OVERHANG_TICKS);
  const descent = firstDescentSampleIndex(calibration.samples);
  assert.ok(descent !== null, "the calibration never left the ground");
  const anchor = groundedAnchorSampleIndex(
    { id: "grounded", samples: calibration.grounded },
    calibration.samples.length,
    descent!,
  );
  assert.ok("index" in anchor, "the calibration's ground flag never went true→false");
  const reference = (anchor as { index: number }).index;
  // The anchor IS the ungrounding step, so the descent must be strictly later by the
  // overhang: if it were not, this fixture would not be testing anything.
  assert.equal(descent! - reference, PROBE_OVERHANG_TICKS + 1, "the fixture's overhang is not what it claims");

  const trials: SweepTrialEcho[] = [];
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    const pressSampleIndex = reference + offset - BRIDGE_INJECTION_LATENCY_TICKS;
    const sim = simulateCoyoteTrial(declaredSeconds, pressSampleIndex, 120, PROBE_OVERHANG_TICKS);
    trials.push(trialEcho(sim, pressSampleIndex, offset, true));
  }
  return trials;
}

/** The same trials with the ground flag stripped: what the sweep sees without the seam field. */
function withoutGroundedTimeline(trials: SweepTrialEcho[]): SweepTrialEcho[] {
  return trials.map((trial) => {
    const { groundedTimeline: _dropped, ...rest } = trial;
    return rest;
  });
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

// ── the GROUNDED anchor: the same recovery, on a rig with an overhang ───────

/**
 * WHY THIS PAIR IS THE WHOLE POINT (E6 session three). The rig below is the live
 * TideRunner shape: the ground probe detaches two ticks before the body starts to
 * fall. Anchored on the controller's own flag the derivation must recover the DECLARED
 * window exactly, at two different declared values. Anchored on the visible descent it
 * must under-read by exactly the overhang, from the SAME trials. The second half is
 * not a bug being tolerated: it is the price of the missing seam field, pinned so it
 * cannot drift and so the evidence's "declare fields.grounded" sentence is earned.
 */
for (const declared of [0.1, 0.15]) {
  test(`known-truth recovery: a declared ${declared}s coyote window is recovered EXACTLY when the trials carry the controller's grounded flag`, () => {
    const trials = groundedSweepTrials(declared, 13);
    const derived = deriveSweepMetric("coyoteTime", trials, DT);
    assert.equal(derived.reason, undefined, `sweep refused: ${derived.reason}`);
    assert.ok(derived.windowSeconds !== null);
    assert.ok(
      Math.abs(derived.windowSeconds! - declared) <= RECOVERY_TOLERANCE,
      `recovered ${derived.windowSeconds} from a declared ${declared}`,
    );
    for (const observation of derived.observations) {
      if (observation.refusal !== undefined) continue;
      assert.equal(observation.anchorSource, ANCHOR_SOURCE_GROUNDED);
    }
  });

  test(`the SAME trials without the grounded flag under-read the declared ${declared}s window by exactly the ${PROBE_OVERHANG_TICKS}-tick overhang`, () => {
    const trials = groundedSweepTrials(declared, 13);
    const exact = deriveSweepMetric("coyoteTime", trials, DT).windowSeconds!;
    const blind = deriveSweepMetric("coyoteTime", withoutGroundedTimeline(trials), DT);
    assert.ok(blind.windowSeconds !== null, `the descent-anchored sweep refused: ${blind.reason}`);
    assert.ok(
      Math.abs(exact - blind.windowSeconds! - PROBE_OVERHANG_TICKS * DT) < 1e-9,
      `exact ${exact} vs descent-anchored ${blind.windowSeconds} (expected a ${PROBE_OVERHANG_TICKS}-tick gap)`,
    );
    // …and it says which anchor it used, so the file cannot claim the exact one.
    for (const observation of blind.observations) {
      assert.equal(observation.anchorSource, ANCHOR_SOURCE_Y_DESCENT);
    }
  });
}

test("a sweep that mixes the two anchors is REFUSED: their tick counts are not in the same frame", () => {
  const trials = groundedSweepTrials(0.1, 13);
  const mixed = [...trials];
  mixed[4] = withoutGroundedTimeline([mixed[4]])[0];
  const derived = deriveSweepMetric("coyoteTime", mixed, DT);
  assert.equal(derived.windowSeconds, null);
  assert.match(derived.reason ?? "", /mixes coyote anchors/);
});

/**
 * LITMUS for the ANCHOR itself: re-derive with the transition read one sample off (the
 * classic error at this site is anchoring on the first FALSE reading instead of the
 * last TRUE one). Both declared truths must fail, or the recovery above is insensitive
 * to the thing it claims to validate.
 */
function anchorBiasedWindow(trials: SweepTrialEcho[], bias: number): number | null {
  const observations = trials.map((trial, index) => {
    const real = observeSweepTrial("coyoteTime", trial, index);
    if (real.elapsedTicks === null) return real;
    // Anchoring `bias` samples later shifts every elapsed count down by `bias`.
    return { ...real, elapsedTicks: real.elapsedTicks - bias };
  });
  return deriveTickThresholdWindow(observations, DT).windowSeconds;
}

for (const declared of [0.1, 0.15]) {
  for (const bias of [-1, 1]) {
    test(`LITMUS: reading the grounded transition ${bias > 0 ? "one sample late" : "one sample early"} fails to recover the declared ${declared}s window`, () => {
      const trials = groundedSweepTrials(declared, 13);
      const honest = deriveSweepMetric("coyoteTime", trials, DT).windowSeconds!;
      assert.ok(Math.abs(honest - declared) <= RECOVERY_TOLERANCE, "positive control: the honest anchor recovers it");
      const biased = anchorBiasedWindow(trials, bias);
      assert.ok(biased !== null);
      assert.ok(
        Math.abs(biased! - declared) > RECOVERY_TOLERANCE,
        `an off-by-one anchor still recovered ${biased} from a declared ${declared}`,
      );
    });
  }
}

// ── the grounded anchor REFUSES rather than guesses ─────────────────────────

test("groundedAnchorSampleIndex refuses an unresolved, mis-typed, or misaligned timeline, and names which", () => {
  const sim = simulateCoyoteTrial(0.1, 10_000, 90, PROBE_OVERHANG_TICKS);
  const n = sim.samples.length;
  const ok = groundedAnchorSampleIndex({ id: "grounded", samples: sim.grounded }, n, n - 1);
  assert.ok("index" in ok, "positive control: a well-formed timeline resolves an anchor");

  const unresolved = groundedAnchorSampleIndex({ id: "grounded", samples: [], unresolved: "no such member" }, n, n - 1);
  assert.ok("refusal" in unresolved && unresolved.kind === "unreadable");
  assert.match((unresolved as { refusal: string }).refusal, /could not resolve/);

  const short = groundedAnchorSampleIndex({ id: "grounded", samples: sim.grounded.slice(0, 5) }, n, n - 1);
  assert.ok("refusal" in short && short.kind === "unreadable");
  assert.match((short as { refusal: string }).refusal, /one reading per sample/);

  const notBool = groundedAnchorSampleIndex(
    { id: "grounded", samples: sim.grounded.map((s) => ({ tMs: s.tMs, value: "yes" })) },
    n,
    n - 1,
  );
  assert.ok("refusal" in notBool && notBool.kind === "unreadable");
  assert.match((notBool as { refusal: string }).refusal, /not a boolean/);

  // Never left the ground by the controller's own reckoning: a DIFFERENT refusal,
  // because the caller answers it by walking further rather than by fixing wiring.
  const alwaysTrue = groundedAnchorSampleIndex(
    { id: "grounded", samples: sim.grounded.map((s) => ({ tMs: s.tMs, value: true })) },
    n,
    n - 1,
  );
  assert.ok("refusal" in alwaysTrue && alwaysTrue.kind === "no-transition");

  // A missing timeline is never silently re-anchored on the descent.
  const absent = groundedAnchorSampleIndex(undefined, n, n - 1);
  assert.ok("refusal" in absent && absent.kind === "unreadable");
});

test("a grounded-anchored trial whose press lands while the controller is still grounded is refused, not measured", () => {
  // Press at sample 2: the walk has not reached the ledge, so the flag is still true.
  const sim = simulateCoyoteTrial(0.1, 2, 90, PROBE_OVERHANG_TICKS);
  const observation = observeSweepTrial("coyoteTime", trialEcho(sim, 2, 0, true), 0);
  assert.equal(observation.elapsedTicks, null);
  assert.match(observation.refusal ?? "", /still reported itself grounded|never went true→false/);
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
  const observation = observeSweepTrial("coyoteTime", trialEcho(sim, 2, 0), 0);
  assert.equal(observation.elapsedTicks, null);
  assert.match(observation.refusal ?? "", /before leaving the ground/);
});
