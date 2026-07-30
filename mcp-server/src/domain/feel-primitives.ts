/**
 * Genre-neutral feel-measurement primitives.
 *
 * These are shared by the genre-neutral pipeline core — the Genre Contract validator
 * (`genre-contract/validator.ts`), the hint-card validator, the generic feel-capture setup
 * (`feel-capture/setup.ts`), and the feel-provenance gate — so the core never has to import a
 * specific genre pack to reach them. (Phase 1a of genre-pack decoupling: break the core→pack
 * import edge. The platformer pack re-exports these from its original modules for back-compat.)
 *
 * `MEASURABLE_METRICS` is the implemented trajectory/probe metric VOCABULARY (the metric ids that
 * have a real measurement calculator today). Concrete recipes that PRODUCE these metrics live in
 * genre packs; Phase 1b/registry will formalize pack ownership. The id list is the global
 * vocabulary the contract validator binds `measurable-now` against — it is core-owned, never a
 * per-pack-extensible set.
 */

/**
 * Units a feel metric may be expressed in. A metric using any other unit is refused
 * (`UNSUPPORTED_UNIT` / `BAND_UNIT` / `GATE_BAND_UNIT`). Kept deliberately small so a typo can't
 * masquerade as a real unit.
 *
 * - `u`      world units (distance / height)
 * - `u/s`    world units per second (speed)
 * - `u/s^2`  world units per second squared (acceleration / deceleration)
 * - `s`      seconds (windows: coyote / buffer / dash timing)
 * - `ms`     milliseconds (response / settle / hit-stop timing)
 * - `px`     native pixels (screen-shake amplitude)
 * - `x`      dimensionless multiplier (e.g. fall-gravity multiplier)
 */
export const SUPPORTED_PROFILE_UNITS = [
  "u",
  "u/s",
  "u/s^2",
  "s",
  "ms",
  "px",
  "x",
] as const;

export type ProfileUnit = (typeof SUPPORTED_PROFILE_UNITS)[number];

export const SUPPORTED_PROFILE_UNIT_SET: ReadonlySet<string> = new Set(
  SUPPORTED_PROFILE_UNITS,
);

/** The feel metrics the trajectory/probe harness can attempt to measure (implemented calculators). */
export const MEASURABLE_METRICS = [
  "runSpeed",
  "runAcceleration",
  "runDeceleration",
  "jumpApex",
  "timeToApex",
  "shortHopApex",
  "fallGravityMultiplier",
  // F5 responsiveness: input→first-motion latency. Measured on a horizontal hold
  // (moveRight) — horizontal onset isn't confounded by gravity the way a vertical
  // jump onset is. The capture settles (phase0, no keys) then holds moveRight
  // (phase1); the phase0→phase1 boundary is the recorded input onset.
  "inputLatency",
  "coyoteTime",
  "jumpBuffer",
] as const;
// NOTE (deferred): `maxFallSpeed` is the fourth member of the accel/decel/fall
// metric-class but is NOT measurable from a flat-ground jump (the terminal cap is
// never engaged) — it needs a dedicated tall-drop capture and is out of scope here.
export type MeasurableMetric = (typeof MEASURABLE_METRICS)[number];

/**
 * Canonical short-hop stimulus (F5, friction-log finding #4).
 *
 * `shortHopApex` is jointly determined by `jumpCutMultiplier` and HOW LONG the
 * jump key is held before the `jumpCut` release. The recipe was silent on that
 * tap, so the metric varied ~2× with the operator's hold (F1: a 70ms tap read
 * 1.466u OUT of band, a 35ms tap read 0.944u IN band, same params) — the operator
 * could pick the tap that passed. This pins the stimulus so a short hop means ONE
 * thing and a verifier can check which tap produced a reading.
 *
 * The canonical short hop is "jump held for exactly `SHORT_HOP_CANONICAL_TAP_TICKS`
 * FIXED physics ticks, then `jumpCut`". It is expressed in TICKS, not milliseconds,
 * because the tap's effect is tick-quantized: a tap measured in ms is ambiguous
 * across timesteps (35ms is ~2 ticks at 60Hz but ~3.5 at 100Hz), whereas "2 ticks"
 * is the same minimal hop on any project.
 *
 * Why exactly 6 (the live-realized minimum, not the analytic minimum): under REAL
 * in-loop input injection the press does not take effect on the nominal tick — the
 * injection pipeline adds ~1 tick of latency, so a 2–3 tick tap is realized BELOW the
 * jump-registration threshold and produces NO hop at all (apex 0 — the player never
 * leaves the ground). The realized hop height then climbs with the hold and SATURATES
 * by ~6 ticks. Live diag on tiderunner: 2t→0, 3t→0, 4t→1.272, 6t→1.405, 10t→1.405.
 * So the analytic "2-tick minimum" silently emits a spurious 0 as a "verified" value.
 *
 * 6 ticks is the SHORTEST canonical tap whose realized hop is both (a) reliably
 * REGISTERED (well clear of the no-jump floor) and (b) REPRODUCIBLE — it sits on the
 * saturation plateau, so it is insensitive to the per-run injection-timing noise that
 * makes 4t (mid-ramp) brittle. A larger N is also saturated but makes the "short" hop
 * needlessly tall; 6 ticks is the operator-independent choice that a verifier can pin.
 *
 * COLD-START caveat (live, 2026-06-14): the session's FIRST injected tap runs ~1 tick
 * colder than steady-state, so a cold 6-tick realizes ~5 effective ticks (1.27u) vs the
 * warm 6-tick plateau (1.41u). This is a FIXED first-injection latency, NOT a function of
 * hold length — bumping to 8t does NOT fix it (cold-8t still reads 1.27u and adds variance:
 * live 8t spread 0.68 with a 1.96u spike). The robust fix is a WARM-UP, not a longer tap:
 * the canonical short hop should not be a session's first injected stimulus. Follow-up:
 * prepend a throwaway warm-up tap (or order shortHop after another injected capture). The
 * non-registration refusal (`deriveShortHopApex`) is unaffected — a cold 1.27u is still a
 * real registered hop, far above the no-jump floor.
 */
export const SHORT_HOP_CANONICAL_TAP_TICKS = 6;

/**
 * Tolerance (in ticks) on a recorded short-hop tap vs. the canonical value. The tap
 * effect is integer-tick-quantized, so the canonical tap is matched EXACTLY: a tap
 * recorded as a non-integer tick count, or any integer ≠ the canonical, is off-canon.
 */
export const SHORT_HOP_TAP_TICK_TOLERANCE = 0;

// ─────────────────────────────────────────────────────────────────────────────
// The threshold-sweep derivation: coyoteTime / jumpBuffer from raw op echoes.
//
// LEDGER L76 (the reason this exists). The door-one run computed
// `elapsedTicks = t.J - t.Tg + 2` inside a scratch assembler, with the convention
// explained in a code comment and the derivation nowhere near a gate. That single
// agent-chosen `+2` moved `coyoteTime` across the pass boundary: with `+0` the same
// raw trials read 0.0667 (fails the ±0.02s band), with `+1` 0.0833, with `+2`
// 0.1000, dead on target. The convention was worth more than the measurement.
//
// LEDGER L77. The trial table itself was hand-retyped from console output and half
// its rows had no raw file on disk at all.
//
// So the convention moves HERE, as a pure derivation over the op's OWN echoes, and
// both the producer and the gate call the same function. Nothing is retyped: a
// trial is the bridge's phase breakdown plus its sample trajectory, and every
// number below is read out of them.
//
// H9 (review): this module's test is KNOWN-TRUTH RECOVERY, never a convention
// assertion. A test asserting `+2 === +2` proves only that someone typed 2 twice.
// The test drives a scripted controller simulation with a DECLARED window at two
// different values and requires the derivation to recover both; a constant answer
// cannot satisfy both, and a one-tick bias in either direction fails both.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal position sample this module reads. Structurally compatible with the
 * verification layer's `FeelTrajectorySample` (which carries optional z/rotation)
 * and with the bridge's echoed `samples[]`; declared locally because `domain/`
 * must not import `capabilities/`.
 */
export interface TickSample {
  tMs: number;
  x: number;
  y: number;
}

/**
 * THE TICK-INDEXING CONVENTION (ledger L76), as a derivation with a stated model
 * rather than a magic number.
 *
 * A sweep trial gives two SAMPLE INDICES: the index of the sample at which the
 * recipe's press phase begins (`pressSampleIndex`, read out of the echoed phase
 * breakdown), and the index of the sample at which the reference event is first
 * VISIBLE in the trajectory (the ledge departure for coyote, the landing for
 * jumpBuffer). The controller's own window is in PHYSICS STEPS, so converting
 * sample indices to steps needs the two mechanisms that separate them:
 *
 *   (1) SAMPLING LAG (+1). Sample `i` reports the position AFTER physics step
 *       `i-1`. A state change first VISIBLE at sample index `i` was therefore
 *       produced by step `i-1`, so `referenceStep = referenceSampleIndex - 1`.
 *
 *   (2) INJECTION LATENCY (+1). A key pressed at the phase boundary of sample
 *       index `j` is not consumed by the controller on step `j`: the injection
 *       pipeline costs about one tick. This is the SAME latency the canonical
 *       short-hop constant above is built around, where a live 6-tick tap
 *       realizes as ~5 effective ticks on a cold first injection and a 2-3 tick
 *       tap never registers at all. So `pressStep = pressSampleIndex + 1`.
 *
 * For coyote the controller compares (pressStep − ungroundStep):
 *   elapsedTicks = (pressSampleIndex + 1) − (ungroundSampleIndex − 1)
 *                = pressSampleIndex − ungroundSampleIndex + 2.
 * For jumpBuffer the same two mechanisms appear with the reference AFTER the press:
 *   leadTicks    = (landingSampleIndex − 1) − (pressSampleIndex + 1)
 *                = landingSampleIndex − pressSampleIndex − 2.
 *
 * The offset is therefore ONE constant with one sign per direction, not a free
 * parameter, and the live door-one run corroborates it: `+2` was the value that
 * recovered a 0.10s declared window from real trials.
 *
 * NOTE. Both mechanisms are properties of the HARNESS (how the bridge samples and
 * how injected input lands), not of any game. If a future bridge change removes the
 * injection latency, this constant changes once, here, and the known-truth recovery
 * test fails until it does.
 */
export const BRIDGE_SAMPLE_TICK_OFFSET = 2;

/**
 * Vertical motion (world units) that counts as real movement when reading the
 * trajectory. A grounded player's sampled y is constant to the bit, so this only
 * has to clear float noise; it is deliberately far below one tick of gravity
 * (~0.008u at 60Hz under a 30 u/s² fall).
 */
export const SWEEP_MOTION_EPSILON_U = 1e-4;

/**
 * Rise (world units) above the press-time height that counts as "the jump
 * registered". A real jump clears a whole unit within a few ticks; this sits far
 * above sampling noise and far below any real hop.
 */
export const SWEEP_RISE_EPSILON_U = 0.05;

/**
 * How many ticks after the press a coyote jump may take to appear.
 *
 * BUFFER CONTAMINATION (why this is bounded rather than "anywhere later"). A press
 * that misses the coyote window can still be BUFFERED and fire on landing. Searching
 * the whole remaining trajectory would read that landing hop as "the coyote jump
 * registered" and push the measured coyote window out to the fall duration. The
 * search is therefore bounded to a few ticks after the press AND stops at the
 * landing sample, so the two windows can never be conflated.
 */
export const SWEEP_RISE_SEARCH_TICKS = 6;

/** One phase of the bridge's echoed per-phase breakdown (the fields this reads). */
export interface SweepPhaseEcho {
  index?: number;
  sampleCount?: number;
  keys?: string[];
  requestedFixedTicks?: number;
  actualFixedTicks?: number;
  fixedTickStart?: number;
  fixedTickEnd?: number;
}

/**
 * ONE SWEEP TRIAL, retained VERBATIM (ledger L77: the door-one trial table was a
 * literal array transcribed from console output, and three of its six rows had no
 * raw file on disk). `phases` and `samples` are the op's own echo; `pressPhaseIndex`
 * is the recipe's own declaration of WHICH phase presses the key, and is the only
 * field the producer contributes.
 */
export interface SweepTrialEcho {
  /** Trial ordinal within the sweep (report/debug only; never used in the math). */
  index?: number;
  /** Index into `phases` of the phase whose first tick presses the swept key. */
  pressPhaseIndex: number;
  /** `phases[]` exactly as the op echoed it. */
  phases: SweepPhaseEcho[];
  /** `samples[]` exactly as the op echoed it. */
  samples: TickSample[];
}

/** Which threshold a sweep measures. Both share the convention, with opposite signs. */
export type SweepMetric = "coyoteTime" | "jumpBuffer";

/** What one trial was observed to be, or why it could not be read. */
export interface SweepObservation {
  trialIndex: number;
  /** Sample index at which the press phase begins (from the echoed sampleCounts). */
  pressSampleIndex: number | null;
  /** Sample index at which the reference event first shows in the trajectory. */
  referenceSampleIndex: number | null;
  /** Ticks between the reference event and the press, in the controller's frame. */
  elapsedTicks: number | null;
  /** Whether the jump registered for this trial. */
  jumped: boolean | null;
  /** Why this trial is unusable, when it is. */
  refusal?: string;
}

export interface SweepDerivation {
  /** The measured window in seconds, or null when the trials cannot decide one. */
  windowSeconds: number | null;
  /** Why no window could be derived. */
  reason?: string;
  /** Largest still-registering elapsed/lead, in ticks (the reported boundary). */
  boundaryTicks?: number;
  /** Smallest failing elapsed/lead, in ticks (the other side of the bracket). */
  firstFailedTicks?: number;
  /** Per-trial observations, in trial order. Always present, refusals included. */
  observations: SweepObservation[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A trajectory usable for sweep observation: ≥2 samples with finite, ordered tMs. */
function usableTrajectory(samples: unknown): samples is TickSample[] {
  if (!Array.isArray(samples) || samples.length < 2) return false;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] as TickSample;
    if (typeof s !== "object" || s === null) return false;
    if (!isFiniteNumber(s.tMs) || !isFiniteNumber(s.x) || !isFiniteNumber(s.y)) return false;
    if (i > 0 && !(s.tMs > (samples[i - 1] as TickSample).tMs)) return false;
  }
  return true;
}

/**
 * The sample index at which `pressPhaseIndex` begins: the sum of the sampleCounts
 * the bridge echoed for every EARLIER phase. Mechanical over the echo: the point
 * is that the producer never types this number.
 */
export function pressSampleIndexFromPhases(
  phases: SweepPhaseEcho[],
  pressPhaseIndex: number,
): number | null {
  if (!Array.isArray(phases)) return null;
  if (!Number.isInteger(pressPhaseIndex) || pressPhaseIndex < 0 || pressPhaseIndex >= phases.length) {
    return null;
  }
  let index = 0;
  for (let i = 0; i < pressPhaseIndex; i += 1) {
    const count = phases[i]?.sampleCount;
    if (!isFiniteNumber(count) || count < 0 || !Number.isInteger(count)) return null;
    index += count;
  }
  return index;
}

/**
 * First sample index at which the trajectory is DESCENDING and keeps descending :
 * the ledge departure for a coyote trial, the apex→fall transition for a buffer
 * trial. Two consecutive descending steps are required so a single noisy sample
 * cannot be read as leaving the ground.
 */
export function firstDescentSampleIndex(samples: TickSample[], from = 1): number | null {
  for (let i = Math.max(1, from); i < samples.length - 1; i += 1) {
    const falling = samples[i].y < samples[i - 1].y - SWEEP_MOTION_EPSILON_U;
    const keepsFalling = samples[i + 1].y < samples[i].y - SWEEP_MOTION_EPSILON_U;
    if (falling && keepsFalling) return i;
  }
  return null;
}

/**
 * First sample index at/after `from` at which a descent stops: the landing. Read as
 * "the fall was arrested": the previous sample was still descending and this one is
 * not below it.
 */
export function landingSampleIndexAfter(samples: TickSample[], from: number): number | null {
  for (let i = Math.max(1, from + 1); i < samples.length; i += 1) {
    const wasFalling = samples[i - 1].y < samples[Math.max(0, i - 2)].y - SWEEP_MOTION_EPSILON_U;
    const stopped = samples[i].y >= samples[i - 1].y - SWEEP_MOTION_EPSILON_U;
    if (wasFalling && stopped) return i;
  }
  return null;
}

/**
 * Did a jump register in the bounded window after `fromIndex`? See
 * `SWEEP_RISE_SEARCH_TICKS` for why the window is bounded rather than open-ended.
 */
export function roseWithin(
  samples: TickSample[],
  fromIndex: number,
  stopIndex: number | null,
  searchTicks = SWEEP_RISE_SEARCH_TICKS,
): boolean {
  if (fromIndex < 0 || fromIndex >= samples.length) return false;
  const baseline = samples[fromIndex].y;
  const hardStop = stopIndex === null ? samples.length - 1 : Math.min(stopIndex, samples.length - 1);
  const last = Math.min(fromIndex + searchTicks, hardStop);
  for (let i = fromIndex + 1; i <= last; i += 1) {
    if (samples[i].y > baseline + SWEEP_RISE_EPSILON_U) return true;
  }
  return false;
}

/**
 * Read ONE trial: press index from the phase echo, reference event from the
 * trajectory, elapsed ticks via `BRIDGE_SAMPLE_TICK_OFFSET`, and whether the jump
 * registered. Refuse-don't-guess: any piece that cannot be read makes the trial
 * unusable (and the sweep then says so), never a default.
 */
export function observeSweepTrial(
  metric: SweepMetric,
  trial: SweepTrialEcho,
  trialIndex: number,
): SweepObservation {
  const base: SweepObservation = {
    trialIndex,
    pressSampleIndex: null,
    referenceSampleIndex: null,
    elapsedTicks: null,
    jumped: null,
  };
  const pressIndex = pressSampleIndexFromPhases(trial?.phases ?? [], trial?.pressPhaseIndex ?? -1);
  if (pressIndex === null) {
    return { ...base, refusal: "the echoed phase breakdown does not resolve a press-phase sample index (absent or non-integer sampleCount before the press phase)." };
  }
  if (!usableTrajectory(trial?.samples)) {
    return { ...base, pressSampleIndex: pressIndex, refusal: "the echoed samples[] are not a usable trajectory (need ≥2 finite, strictly time-ordered samples)." };
  }
  const samples = trial.samples;
  if (pressIndex >= samples.length) {
    return { ...base, pressSampleIndex: pressIndex, refusal: `the press phase starts at sample ${pressIndex} but the capture only returned ${samples.length} samples.` };
  }

  const descent = firstDescentSampleIndex(samples);
  if (descent === null) {
    return {
      ...base,
      pressSampleIndex: pressIndex,
      refusal:
        metric === "coyoteTime"
          ? "the trajectory never leaves the ground (no sustained descent), so there is no ledge departure to measure from."
          : "the trajectory never falls, so there is no landing to measure to.",
    };
  }

  if (metric === "coyoteTime") {
    // THE DEGENERATE TRIAL. If the press is consumed while the player is still on
    // the platform, the trajectory's first descent is the resulting hop's own apex,
    // not a ledge departure, and reading it would report the whole hop as a coyote
    // window. A rise before the first descent is exactly that case: refuse it.
    const startY = samples[0].y;
    for (let i = 1; i <= descent; i += 1) {
      if (samples[i].y > startY + SWEEP_RISE_EPSILON_U) {
        return {
          ...base,
          pressSampleIndex: pressIndex,
          referenceSampleIndex: descent,
          refusal: "the trial rose before leaving the ground: the press was consumed while still grounded, so this is an ordinary jump, not a coyote jump.",
        };
      }
    }
    const landing = landingSampleIndexAfter(samples, descent);
    const elapsedTicks = pressIndex - descent + BRIDGE_SAMPLE_TICK_OFFSET;
    return {
      trialIndex,
      pressSampleIndex: pressIndex,
      referenceSampleIndex: descent,
      elapsedTicks,
      jumped: roseWithin(samples, pressIndex, landing),
    };
  }

  const landing = landingSampleIndexAfter(samples, descent);
  if (landing === null) {
    return { ...base, pressSampleIndex: pressIndex, refusal: "the trajectory never lands (the fall is not arrested inside the capture window), so a buffer lead cannot be measured." };
  }
  if (landing <= pressIndex) {
    return {
      ...base,
      pressSampleIndex: pressIndex,
      referenceSampleIndex: landing,
      refusal: `the press (sample ${pressIndex}) is at or after the landing (sample ${landing}); a jump-buffer trial must press BEFORE landing.`,
    };
  }
  return {
    trialIndex,
    pressSampleIndex: pressIndex,
    referenceSampleIndex: landing,
    elapsedTicks: landing - pressIndex - BRIDGE_SAMPLE_TICK_OFFSET,
    // The buffered jump fires ON landing, so the rise is searched from the landing
    // sample, not the press sample.
    jumped: roseWithin(samples, landing, null),
  };
}

/**
 * Select the threshold from the observed trials.
 *
 * THE REPORTED VALUE IS THE LARGEST STILL-REGISTERING DELAY, not the midpoint of
 * the bracket. With tick-quantized trials the achievable resolution is one tick and
 * the true window is somewhere in `[boundaryTicks, firstFailedTicks)`; a midpoint
 * adds a systematic half-tick overshoot, which against a ±0.02s coyote band at 60Hz
 * (1.2 ticks wide) is material. "The latest press that still jumped" is also the
 * definition an operator can state out loud. The estimate is therefore a lower
 * bound, exact when the real window is a whole number of ticks and never off by
 * as much as one tick. `firstFailedTicks` is reported alongside so the whole
 * bracket stays visible in the evidence.
 *
 * Refusals (never a guess): no usable trial; nothing jumped; nothing failed; a
 * NON-MONOTONIC sweep (some failing trial is earlier than some jumping one), which
 * means the trials do not describe a single threshold at all.
 */
export function deriveTickThresholdWindow(
  observations: SweepObservation[],
  fixedTimestepSeconds: number,
): Omit<SweepDerivation, "observations"> {
  if (!isFiniteNumber(fixedTimestepSeconds) || fixedTimestepSeconds <= 0) {
    return { windowSeconds: null, reason: "no usable fixed timestep: the window cannot be converted from ticks to seconds." };
  }
  const usable = observations.filter(
    (o) => o.refusal === undefined && isFiniteNumber(o.elapsedTicks) && typeof o.jumped === "boolean",
  );
  if (usable.length === 0) {
    return { windowSeconds: null, reason: "no usable trial: every trial was refused, so no threshold can be derived." };
  }
  const jumped = usable.filter((o) => o.jumped).map((o) => o.elapsedTicks!);
  const failed = usable.filter((o) => !o.jumped).map((o) => o.elapsedTicks!);
  if (jumped.length === 0) {
    return { windowSeconds: null, reason: `no trial registered a jump: the threshold is below the smallest tick offset tried (${Math.min(...failed)}).` };
  }
  if (failed.length === 0) {
    return { windowSeconds: null, reason: `every trial registered a jump: the threshold is above the largest tick offset tried (${Math.max(...jumped)}).` };
  }
  const boundaryTicks = Math.max(...jumped);
  const firstFailedTicks = Math.min(...failed);
  if (firstFailedTicks <= boundaryTicks) {
    return {
      windowSeconds: null,
      reason:
        `the sweep is not monotonic: a trial FAILED at ${firstFailedTicks} tick(s) while another JUMPED at ${boundaryTicks} tick(s). ` +
        "A single threshold cannot explain these trials, so no window is derived (re-run the sweep).",
      boundaryTicks,
      firstFailedTicks,
    };
  }
  return {
    windowSeconds: boundaryTicks * fixedTimestepSeconds,
    boundaryTicks,
    firstFailedTicks,
  };
}

/**
 * THE ONE FUNCTION. Both the producer (writing the value) and the gate
 * (re-deriving it from the retained trials) call this, so the headline number in
 * `feel.json` is bound to the trials in the same file: a hand-edited headline no
 * longer survives (the M12(3) sweep binding).
 */
export function deriveSweepMetric(
  metric: SweepMetric,
  trials: SweepTrialEcho[],
  fixedTimestepSeconds: number,
): SweepDerivation {
  const list = Array.isArray(trials) ? trials : [];
  if (list.length === 0) {
    return { windowSeconds: null, reason: "no trials were retained, so nothing can be re-derived.", observations: [] };
  }
  const observations = list.map((trial, index) => observeSweepTrial(metric, trial, trial?.index ?? index));
  return { ...deriveTickThresholdWindow(observations, fixedTimestepSeconds), observations };
}
