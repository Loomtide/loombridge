/**
 * Pure trajectory → feel-metric derivation (S5c).
 *
 * Re-derives feel metrics from a raw per-frame position trajectory, deliberately
 * matching the C# `MotionMetrics.Compute` formulas (Editor/Core/MotionMetrics.cs)
 * so a live aggregate and this offline re-derivation agree to the bit:
 *   jumpApex     = peakY - startY                  (height gained above start, u)
 *   timeToApex   = (tMs at peakY) - startTMs        (ms; first sample reaching the max)
 *   runSpeed     = |endX - startX| / durationSec    (avg horizontal speed, u/s)
 *   shortHopApex = peakY - startY                   (same as jumpApex, on a cut-hop trajectory)
 *
 * F5 adds three metrics that were BANDED in the profiles but never measured (the
 * "metric-class" gap from the F1 feel-swap friction log) — all derivable from
 * samples F1 already captured, all honest-or-omit:
 *   runAcceleration       = |slope of the rest→steady speed ramp|  (u/s², least-squares)
 *   runDeceleration       = |slope of the steady→rest speed ramp|  (u/s², least-squares)
 *   fallGravityMultiplier = |descentAccel| / |ascentAccel|         (fall/rise asymmetry, ×)
 *   inputLatency          = (first post-onset moved sample tMs) − inputOnsetMs (ms)
 *
 * inputLatency is the one metric that needs more than the samples: it needs the
 * input ONSET time (the phase0→phase1 boundary), carried as a provenance field
 * because flat re-zeroed samples lose it. Still honest-or-omit + re-derivable.
 *
 * These are the metrics the `feel-rederive` gate re-computes to close the S4b
 * self-grade hole ("a source proves it CLAIMS N samples, not that the value was
 * behaviorally derived"). coyote/jumpBuffer are NOT trajectory-derivable from a
 * single arc — they come from input-timing bisection (`interpretBisection`).
 *
 * NOTE (deferred, NOT implemented here): `maxFallSpeed` (the terminal-velocity cap)
 * is the fourth member of this metric-class but is OUT OF SCOPE — a flat-ground jump
 * never engages the terminal cap, so it needs a dedicated tall-drop capture.
 *
 * All functions are pure and editor-free, fully unit-testable from synthetic
 * trajectories.
 */

import type { FeelTrajectorySample } from "./gates/feel.js";

/** The feel metrics re-derivable from a single position trajectory. */
export const REDERIVABLE_METRICS = [
  "jumpApex",
  "timeToApex",
  "runSpeed",
  "shortHopApex",
  "runAcceleration",
  "runDeceleration",
  "fallGravityMultiplier",
  "projectileSpeed",
  // 3D measurement substrate v2: aimTurnRateDegPerSec re-derives from the rotation
  // (eulerAngles) carried on each sample — purely from the trajectory, like the others.
  "aimTurnRateDegPerSec",
  // F5: inputLatency re-derives from samples + the recorded input ONSET (the
  // phase0→phase1 boundary, in the same timeline as the samples). Unlike the
  // others it needs that onset — a tampered latency can still be rejected by
  // re-deriving (samples + onset → latency), so it opts into §0 re-derivation.
  "inputLatency",
  // 3C controller/camera: lookInputToYawLatencyMs is the rotation analog of
  // inputLatency. It re-derives from sampled yaw (ry) + a recorded look-input onset.
  // Promoted with committed live evidence: demos/evidence-bundles/3d-shooter-3c-controller-camera.
  "lookInputToYawLatencyMs",
] as const;
export type RederivableMetric = (typeof REDERIVABLE_METRICS)[number];

export const REDERIVABLE_METRIC_SET: ReadonlySet<string> = new Set(REDERIVABLE_METRICS);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a trajectory for re-derivation: at least TWO finite {tMs,x,y} samples
 * with STRICTLY INCREASING tMs. The strictness is the raw-evidence contract — a
 * single sample, duplicate timestamps, or non-monotonic (non-causal) time would
 * let `deriveRunSpeed` divide by a non-positive duration or `deriveTimeToApex`
 * read from a scrambled order, weakening the re-derivation guarantee. An invalid
 * trajectory is treated as "no usable samples" by the gate (a refusal).
 */
export function isValidTrajectory(samples: unknown): samples is FeelTrajectorySample[] {
  if (!Array.isArray(samples) || samples.length < 2) return false;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] as FeelTrajectorySample;
    if (typeof s !== "object" || s === null) return false;
    if (!isFiniteNumber(s.tMs) || !isFiniteNumber(s.x) || !isFiniteNumber(s.y)) return false;
    if (i > 0 && !(s.tMs > (samples[i - 1] as FeelTrajectorySample).tMs)) return false; // strictly increasing
  }
  return true;
}

/** Peak Y above the start position (jumpApex / shortHopApex), in world units. */
export function deriveJumpApex(samples: FeelTrajectorySample[]): number {
  const startY = samples[0].y;
  let peakY = startY;
  // Strict `>` so the FIRST sample reaching the max is the apex (matches C#).
  for (const s of samples) if (s.y > peakY) peakY = s.y;
  return peakY - startY;
}

/** Milliseconds from the first sample to the first sample reaching peak Y. */
export function deriveTimeToApex(samples: FeelTrajectorySample[]): number {
  const startT = samples[0].tMs;
  let peakY = samples[0].y;
  let peakT = startT;
  for (const s of samples) {
    if (s.y > peakY) {
      peakY = s.y;
      peakT = s.tMs;
    }
  }
  return peakT - startT;
}

/** Average horizontal speed over the sampled window, u/s. */
export function deriveRunSpeed(samples: FeelTrajectorySample[]): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const durationSec = (last.tMs - first.tMs) / 1000;
  if (durationSec <= 0) return 0;
  return Math.abs(last.x - first.x) / durationSec;
}

const PROJECTILE_MOVING_EPSILON_U_PER_S = 0.01;
const PROJECTILE_MIN_MOVING_INTERVALS = 2;

/**
 * Projectile speed (u/s): median per-interval speed while the projectile is visibly moving.
 *
 * Dimension-agnostic: the per-interval step is the full Euclidean distance over {x,y,z}. When a
 * sample carries no z (legacy 2D capture) z is treated as 0, so a 2D trajectory yields exactly the
 * same value as before — but a true 3D shot (e.g. a +Z projectile whose x/y never change) is now
 * measured correctly instead of reading ~0. The z term is what the 3D measurement substrate adds.
 *
 * Shooter captures often include a pre-fire stationary prefix because the same window injects
 * the fire input and samples the projectile transform. Averaging over the whole window would
 * under-read the projectile; accepting a single moved interval would let a spawn/teleport snap
 * masquerade as speed. The metric therefore requires at least two moving intervals and reports
 * the median moving interval speed, which is stable for constant-speed projectiles and rejects
 * isolated spikes.
 */
export function deriveProjectileSpeed(samples: FeelTrajectorySample[]): number | null {
  const speeds: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dtSec = (curr.tMs - prev.tMs) / 1000;
    if (dtSec <= 0) continue;
    const dz = (curr.z ?? 0) - (prev.z ?? 0);
    const speed = Math.hypot(curr.x - prev.x, curr.y - prev.y, dz) / dtSec;
    if (speed > PROJECTILE_MOVING_EPSILON_U_PER_S) speeds.push(speed);
  }
  if (speeds.length < PROJECTILE_MIN_MOVING_INTERVALS) return null;
  speeds.sort((a, b) => a - b);
  const mid = Math.floor(speeds.length / 2);
  return speeds.length % 2 === 1 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2;
}

// ── aim turn rate (3D measurement substrate v2 — rotation/aim sampling) ───────
//
// The rotation analog of `deriveProjectileSpeed`: the median per-interval ANGULAR
// speed (deg/s) of the measured object's aim axis while it is visibly turning. The
// evidence is the rotation (`transform.eulerAngles`) the bridge now samples on every
// trajectory sample (`rx`=pitch, `ry`=yaw, `rz`=roll). `aimTurnRateDegPerSec`
// measures yaw by default (the horizontal aim sweep) but is axis-selectable.
//
// This is the FIRST rotation-dependent 3D metric to leave the `needs-new-bridge-
// capability` gap ledger, and it is deliberately the LEAST-new-semantics rotation
// metric: a turn RATE needs no input-onset provenance (unlike a look-responsiveness
// latency) and no recoil/ADS state model — just the sampled angle over time.

/** Aim axes selectable for a rotation metric (yaw is the default horizontal aim). */
export type AimAxis = "yaw" | "pitch" | "roll";

/** Pick the euler component (degrees) for an aim axis from a sample. */
function aimAngleDeg(sample: FeelTrajectorySample, axis: AimAxis): number | undefined {
  if (axis === "pitch") return sample.rx;
  if (axis === "roll") return sample.rz;
  return sample.ry; // yaw (about Y) — the default horizontal aim
}

/**
 * Shortest signed angular difference `a→b` in degrees, in (−180, 180]. This is the
 * wrap-aware delta (Mathf.DeltaAngle), so a yaw sweep that crosses the 360°→0°
 * seam reads as a small step, never a fabricated ~360°/s spike. A turn rate computed
 * from naive `b − a` would be wildly wrong at the wrap; this keeps it honest.
 */
export function shortestAngleDeltaDeg(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Angular speed (deg/s) below which an interval is treated as "not turning" (noise floor). */
const AIM_TURN_MOVING_EPSILON_DEG_PER_S = 0.5;
/** Minimum count of moving intervals required (rejects a single snap masquerading as a turn). */
const AIM_TURN_MIN_MOVING_INTERVALS = 2;

/**
 * Aim turn rate (deg/s): the median per-interval angular speed of the chosen aim axis
 * (yaw by default) while the object is visibly turning. Dimension/wrap-aware — each
 * interval uses the shortest signed angle delta, so a sweep across the 0/360 seam is
 * measured correctly. Mirrors `deriveProjectileSpeed`: a stationary prefix (the pre-turn
 * settle the same capture window holds before the turn begins) is ignored, and a single
 * moved interval (a snap/teleport) is rejected by requiring ≥2 moving intervals.
 *
 * Fail-closed (returns null → the assembler omits it, never a fabricated value):
 *   - fewer than two samples / non-monotonic time   → null (no usable trajectory)
 *   - ANY sample lacks the rotation evidence for the axis (a position-only capture, or a
 *     missing euler component) → null (the rotation signal is LOAD-BEARING: stripping it
 *     makes the metric un-derivable, exactly as stripping z does for projectileSpeed)
 *   - fewer than two moving intervals (no turn / a lone snap) → null (no sustained turn)
 */
export function deriveAimTurnRateDegPerSec(
  samples: FeelTrajectorySample[],
  axis: AimAxis = "yaw",
): number | null {
  if (!isValidTrajectory(samples)) return null;
  // Rotation evidence must be present on EVERY sample — a single absent angle means the
  // capture is position-only for this axis and we refuse rather than treat it as 0.
  for (const s of samples) {
    if (!isFiniteNumber(aimAngleDeg(s, axis))) return null;
  }
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtSec = (samples[i].tMs - samples[i - 1].tMs) / 1000;
    if (dtSec <= 0) continue;
    const prev = aimAngleDeg(samples[i - 1], axis) as number;
    const curr = aimAngleDeg(samples[i], axis) as number;
    const rate = Math.abs(shortestAngleDeltaDeg(prev, curr)) / dtSec;
    if (rate > AIM_TURN_MOVING_EPSILON_DEG_PER_S) rates.push(rate);
  }
  if (rates.length < AIM_TURN_MIN_MOVING_INTERVALS) return null;
  rates.sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 === 1 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/**
 * Look input → yaw response latency (ms): the first post-input sample whose yaw changes
 * from the at-input baseline, minus the input onset. This is the rotation analog of
 * `deriveInputLatency`: it needs both sampled rotation evidence and explicit input-onset
 * provenance. It refuses:
 *   - missing/out-of-window input onset;
 *   - missing rotation evidence on any sample;
 *   - already-moving/pre-armed yaw before input onset;
 *   - no yaw response after input onset.
 *
 * This measures responsiveness, not turn speed. `deriveAimTurnRateDegPerSec` measures
 * sustained angular rate; this binds the first rotation edge to real input timing.
 */
export function deriveLookInputToYawLatencyMs(
  samples: FeelTrajectorySample[],
  inputOnsetMs: number | undefined,
): number | null {
  if (!isValidTrajectory(samples) || !isFiniteNumber(inputOnsetMs)) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  // Onset must fall STRICTLY after the first sample and within the window: there must be a real
  // pre-onset baseline window to (a) anchor the at-input yaw and (b) prove the yaw was QUIET before
  // input. An onset at/before the first sample leaves no pre-onset interval, so the "already-moving"
  // guard below is vacuous and an already-turning capture would report a fake-responsive latency —
  // refuse (honest-or-omit). The generator binds onset to the first sample of the first KEYED phase,
  // so this refuses any capture that lacks a settle/quiet phase before the look input.
  if (inputOnsetMs <= first.tMs || inputOnsetMs > last.tMs) return null;
  for (const s of samples) {
    if (!isFiniteNumber(s.ry)) return null;
  }

  // A yaw move counts as real only above this floor. It is far above the RuntimeFieldSampler's
  // float32 yaw quantization (observed ~5e-7° of noise on a held sample) and far below the smallest
  // intentional look step (a 120°/s look advances ~2° per 60fps frame), so it neither trips on sensor
  // noise (a false low latency) nor swallows a real first-frame response.
  const YAW_MOVE_EPSILON_DEG = 0.05;

  let baselineYaw = samples[0].ry as number;
  let hasPreOnsetMotion = false;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (curr.tMs <= inputOnsetMs) {
      if (Math.abs(shortestAngleDeltaDeg(prev.ry as number, curr.ry as number)) > YAW_MOVE_EPSILON_DEG) {
        hasPreOnsetMotion = true;
      }
      baselineYaw = curr.ry as number;
    } else {
      break;
    }
  }
  if (hasPreOnsetMotion) return null;

  for (const s of samples) {
    if (s.tMs <= inputOnsetMs) continue;
    if (Math.abs(shortestAngleDeltaDeg(baselineYaw, s.ry as number)) > YAW_MOVE_EPSILON_DEG) {
      return s.tMs - inputOnsetMs;
    }
  }
  return null;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

function normalizeVec3(v: Vec3Like | undefined | null): Vec3Like | null {
  if (!v || !isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.z)) return null;
  const mag = Math.hypot(v.x, v.y, v.z);
  if (!(mag > 1e-6)) return null;
  return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

/**
 * Shot/aim angular error (degrees): 0 means the shot direction matches aim-forward.
 * This is the core 3C weapon/camera check: after rotating the camera/player, the shot
 * must follow the aimed forward vector, not a fixed world axis. Malformed or zero
 * vectors refuse (`null`) rather than producing a fabricated alignment value.
 */
export function deriveShotAimAlignmentDeg(
  aimForward: Vec3Like | undefined | null,
  shotDirection: Vec3Like | undefined | null,
): number | null {
  const aim = normalizeVec3(aimForward);
  const shot = normalizeVec3(shotDirection);
  if (!aim || !shot) return null;
  const dot = Math.max(-1, Math.min(1, aim.x * shot.x + aim.y * shot.y + aim.z * shot.z));
  return Math.acos(dot) * 180 / Math.PI;
}

/** A registered short hop rises clearly above the ground; an apex at/near 0 means the
 *  tap never registered a jump (a sub-registration-threshold stimulus). Reporting 0 as a
 *  verified shortHopApex is a false value, so refuse (omit) below this floor. The smallest
 *  real hop on a live controller is ~1.2u; 0 is a literal no-leave-the-ground. (honest-or-omit) */
const SHORT_HOP_MIN_REGISTERED_RISE_U = 0.05;

/**
 * shortHopApex shares the apex-height derivation (on a cut-hop trajectory) BUT refuses
 * when the captured hop did not register: a canonical short-hop tap that realizes below
 * the jump-registration threshold leaves the player on the ground (apex 0). Reporting
 * that 0 as a "verified" value is a false measurement, so we omit it (return null) below
 * `SHORT_HOP_MIN_REGISTERED_RISE_U`. `deriveJumpApex` deliberately does NOT gain this
 * floor — a full jump's apex is a different (banded) metric.
 */
export function deriveShortHopApex(samples: FeelTrajectorySample[]): number | null {
  const apex = deriveJumpApex(samples);
  if (!(apex > SHORT_HOP_MIN_REGISTERED_RISE_U)) return null; // stimulus did not register a hop → omit
  return apex;
}

// ── run accel / decel (F5) ───────────────────────────────────────────────────
//
// A run capture for accel/decel is one held-move phase (rest → steady speed)
// followed by a release/settle phase (steady → rest). From positions we derive
// per-tick horizontal SPEED |Δx|/Δt (centered between two samples). The signal
// has three regimes: a rising ramp, a flat plateau (steady), a falling ramp.
//
// ALGORITHM (ramp slope by least-squares, the same shape for accel and decel):
// steadySpeed = MAX per-tick speed (the plateau). The ACCEL ramp is the set of
// ticks BEFORE the plateau is first reached (rising from rest); the DECEL ramp is
// the set of ticks AFTER the plateau is last held (falling to rest). We fit a
// least-squares line speed-vs-time over that ramp segment and report |slope| in
// u/s². The slope of the speed ramp IS the acceleration — for a MoveTowards-style
// controller (the common case) the ramp is linear at the configured rate, so the
// least-squares slope recovers that rate exactly while averaging over the whole
// ramp (more robust than a single-tick finite difference, which over-reads on
// noise). We choose slope-fit over "steadySpeed / rampTime" because a threshold-
// based ramp time systematically clips both ends of the rise and biases the rate.
//
// Partial-first-injection-tick discipline (the steadyX trim convention): the
// FIRST moved tick under-reads ~6% because the key engages partway through the
// physics step, so it is NOT a true steady sample. We never let it define the
// steady speed (steadySpeed is the MAX over the window, i.e. the plateau), and the
// least-squares fit over the whole ramp dilutes any single under-reading tick.

/** Per-interval horizontal speed (|Δx|/Δt, u/s) between consecutive samples. */
function tickSpeeds(samples: FeelTrajectorySample[]): { speed: number; tSec: number }[] {
  const out: { speed: number; tSec: number }[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtMs = samples[i].tMs - samples[i - 1].tMs;
    if (dtMs <= 0) continue; // isValidTrajectory already forbids this; defensive
    const speed = Math.abs(samples[i].x - samples[i - 1].x) / (dtMs / 1000);
    out.push({ speed, tSec: (samples[i].tMs + samples[i - 1].tMs) / 2 / 1000 });
  }
  return out;
}

/** Fraction of steady speed that marks the edge of the plateau. */
const STEADY_THRESHOLD = 0.95;

/**
 * Fraction of the steady speed marking the "rest floor" — speeds at or below this
 * are treated as rest/settled, not a genuine in-ramp intermediate. The partial
 * injection tick reads ~6–35% of steady (live: 2.2/7 ≈ 31%, release 4.78/7 ≈ 68%),
 * so the floor must stay BELOW the partial tick to count it as one intermediate
 * (we want the artifact to expose exactly ONE intermediate, then fail the ≥2 gate).
 */
const REST_FLOOR_FRACTION = 0.05;

/** Minimum count of GENUINE intermediate ramp ticks required to resolve a ramp. */
const MIN_INTERMEDIATE_RAMP_TICKS = 2;

/**
 * Count of "genuine intermediate" ticks in a ramp segment: ticks whose speed sits
 * STRICTLY above the rest floor AND STRICTLY below the steady band — i.e. truly
 * mid-climb (or mid-descent), neither rest nor already-at-plateau.
 *
 * This is the partial-injection-tick discriminator. On a REAL capture the first
 * moved tick is a PARTIAL injection tick (the key engages partway through the
 * physics step), so an instant-velocity controller produces a speed sequence like
 * [partial, plateau, plateau, …] on engage and [… plateau, partial, 0] on release.
 * That partial tick is a SINGLE point between rest and plateau, so a 2-point fit
 * (partial + first plateau tick) fabricates a non-zero "ramp slope" even though the
 * controller has no ramp at all. A GENUINE ground-accel ramp climbs through SEVERAL
 * intermediate ticks; the partial-then-plateau artifact has exactly ONE. Requiring
 * ≥2 genuine intermediates cleanly separates them: the artifact omits (return null),
 * a real multi-tick ramp measures. The least-squares `rampSlope`/`plateauSpeed` and
 * the overshoot behavior are unchanged — this is a pre-condition on resolvability.
 */
function intermediateRampTickCount(
  ramp: { speed: number; tSec: number }[],
  steady: number,
): number {
  const restFloor = steady * REST_FLOOR_FRACTION;
  const plateauBand = steady * STEADY_THRESHOLD;
  let count = 0;
  for (const t of ramp) {
    if (t.speed > restFloor && t.speed < plateauBand) count += 1;
  }
  return count;
}

/** Least-squares slope of speed-vs-time (u/s²) over a ramp segment, or null. */
function rampSlope(ticks: { speed: number; tSec: number }[]): number | null {
  const n = ticks.length;
  if (n < 2) return null;
  const meanT = ticks.reduce((a, p) => a + p.tSec, 0) / n;
  const meanS = ticks.reduce((a, p) => a + p.speed, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of ticks) {
    num += (p.tSec - meanT) * (p.speed - meanS);
    den += (p.tSec - meanT) ** 2;
  }
  if (!(den > 0)) return null;
  return num / den;
}

/**
 * Robust sustained ("plateau") speed: the MEDIAN of the moving-fast ticks (those
 * above half the peak). Using the peak directly lets a single overshoot transient
 * — a controller that briefly exceeds its sustained speed before settling — become
 * the reference, which then misclassifies the entire cruise as a ramp (a 1-tick
 * 9.5 overshoot above a 9.0 cruise pushes the cruise below 0.95·peak). The median
 * is dominated by the sustained cruise and rejects the transient; for a flat
 * plateau the median equals the cruise speed, so clean captures are unchanged.
 */
function plateauSpeed(ticks: { speed: number; tSec: number }[]): number {
  const peak = Math.max(...ticks.map((t) => t.speed));
  if (!(peak > 0)) return 0;
  const fast = ticks
    .map((t) => t.speed)
    .filter((s) => s > peak * 0.5)
    .sort((a, b) => a - b);
  if (fast.length === 0) return 0;
  const mid = Math.floor(fast.length / 2);
  return fast.length % 2 === 1 ? fast[mid] : (fast[mid - 1] + fast[mid]) / 2;
}

/**
 * Run acceleration (u/s²): |slope| of the per-tick speed ramp from rest up to the
 * steady plateau. Returns null (→ omit) when there is no resolvable rising ramp
 * (no motion, or already at steady from the first tick → fewer than 2 ramp ticks).
 */
export function deriveRunAcceleration(samples: FeelTrajectorySample[]): number | null {
  const ticks = tickSpeeds(samples);
  if (ticks.length < 2) return null;
  const steady = plateauSpeed(ticks); // sustained cruise, overshoot-robust (NOT the peak)
  if (!(steady > 0)) return null; // never moved

  // First plateau tick = first interval at/above the steady band. The rising ramp
  // is every tick up to and INCLUDING it (so the fit spans rest → steady).
  let firstSteady = ticks.findIndex((t) => t.speed >= steady * STEADY_THRESHOLD);
  if (firstSteady < 0) return null;
  const ramp = ticks.slice(0, firstSteady + 1);
  // A resolvable rise must have ≥2 genuine intermediate (mid-climb) ticks. An
  // instant-velocity controller's "ramp" is a single PARTIAL injection tick before
  // the plateau (exactly ONE intermediate) — that is not a ramp, it's the snap-on
  // artifact, so OMIT rather than fabricate a slope from a 2-point partial+plateau.
  if (intermediateRampTickCount(ramp, steady) < MIN_INTERMEDIATE_RAMP_TICKS) return null;
  const slope = rampSlope(ramp);
  if (slope === null || !(Math.abs(slope) > 0)) return null; // no measurable rise
  return Math.abs(slope);
}

/**
 * Run deceleration (u/s²): |slope| of the per-tick speed ramp from the steady
 * plateau back down to rest after key release. Returns null (→ omit) when the
 * capture has no settle phase (speed never falls back below the plateau).
 */
export function deriveRunDeceleration(samples: FeelTrajectorySample[]): number | null {
  const ticks = tickSpeeds(samples);
  if (ticks.length < 2) return null;
  const steady = plateauSpeed(ticks); // sustained cruise, overshoot-robust (NOT the peak)
  if (!(steady > 0)) return null;

  // Last plateau tick = last interval at/above the steady band. The falling ramp
  // is every tick from it (INCLUSIVE) to the end (so the fit spans steady → rest).
  let lastSteady = -1;
  for (let i = 0; i < ticks.length; i += 1) {
    if (ticks[i].speed >= steady * STEADY_THRESHOLD) lastSteady = i;
  }
  if (lastSteady < 0) return null;
  const ramp = ticks.slice(lastSteady);
  if (ramp.length < 2) return null; // no settle phase captured (omit, don't invent)
  // Symmetric to accel: a resolvable release ramp must have ≥2 genuine intermediate
  // (mid-descent) ticks. An instant STOP is a single PARTIAL injection tick on
  // release between the plateau and rest (exactly ONE intermediate) — the snap-off
  // artifact, not a ramp — so OMIT rather than fabricate a settle slope.
  if (intermediateRampTickCount(ramp, steady) < MIN_INTERMEDIATE_RAMP_TICKS) return null;
  const slope = rampSlope(ramp);
  if (slope === null || !(Math.abs(slope) > 0)) return null;
  return Math.abs(slope);
}

// ── 3D move speed / accel-to-90 (Epic 3 — dogfood finding RCL-G06) ────────────
//
// The 3D-shooter pack had NO movement-speed metric: the 2D substrate has `runSpeed`
// (avg |Δx|/Δt — horizontal-ONLY) and the top-down switchyard contract declares
// accelTo90/decelToStop BANDS, but neither is wired into the 3D pack. This slice
// closes that gap with a dimension-agnostic PLANAR move-speed pair.
//
// PLANAR = the XZ ground plane (`hypot(Δx, Δz)`), the natural move plane for a
// top-down / third-person character: Y is the up axis (jump/fall/step bob) and is
// deliberately EXCLUDED so a hop never inflates the reported ground speed. This is
// exactly the case the Z-blind `measure_motion` bug (RCL-T02, now fixed) used to
// break: a top-down character running FORWARD moves in +Z, so the old horizontal-X
// `runSpeed` read ~0. The bridge now samples a true `{x,y,z}` trajectory, so the
// planar speed is recoverable — and a z-stripped capture of pure +Z motion REFUSES
// rather than fabricating a ~0 (z is load-bearing, the same discipline as
// `deriveProjectileSpeed`). A 2D capture with no z reads z as 0, so 2D is unchanged.
//
// Both are pure, honest-or-omit, re-derivable from a raw trajectory. MEASURE-ONLY
// (a report row / measured value, never a banded gate value unless a GenreContract
// promotes them) — like the hold-channel pair (RCL-G01), so they are NOT registered
// in REDERIVABLE_METRICS / `deriveMetric` (no live source binds them yet).

/** Per-interval PLANAR (XZ ground-plane) speed `hypot(Δx,Δz)/Δt` (u/s), with the
 *  interval's END time and START time (ms) so an accel ramp can be anchored. */
function planarTickSpeeds(
  samples: FeelTrajectorySample[],
): { speed: number; tSec: number; startMs: number; endMs: number }[] {
  const out: { speed: number; tSec: number; startMs: number; endMs: number }[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtMs = samples[i].tMs - samples[i - 1].tMs;
    if (dtMs <= 0) continue; // isValidTrajectory already forbids this; defensive
    const dx = samples[i].x - samples[i - 1].x;
    const dz = (samples[i].z ?? 0) - (samples[i - 1].z ?? 0);
    const speed = Math.hypot(dx, dz) / (dtMs / 1000);
    out.push({
      speed,
      tSec: samples[i].tMs / 1000, // interval-END time (when the speed is realized)
      startMs: samples[i - 1].tMs,
      endMs: samples[i].tMs,
    });
  }
  return out;
}

/** Planar speed (u/s) below which an interval is treated as "not moving" (noise floor). */
const MOVE_MOVING_EPSILON_U_PER_S = 0.01;
/** Minimum count of moving intervals required (rejects a single teleport/snap as motion). */
const MOVE_MIN_MOVING_INTERVALS = 2;

/**
 * Steady-state PLANAR move speed (u/s): the sustained ground-plane speed of a moving
 * character, measured over the STEADY window (the cruise plateau), `hypot(Δx,Δz)/Δt`.
 * Dimension-agnostic — works for top-down +Z motion (the Z-blind case), +X motion, or
 * any XZ diagonal, and a 2D capture (no z) is unchanged (z defaults to 0).
 *
 * Honest-or-omit (returns null → the assembler omits it, never a fabricated 0):
 *   - fewer than two finite, time-ordered samples (malformed/empty/idle) → null
 *   - fewer than two MOVING intervals (no sustained motion / a lone snap)  → null
 *   - no resolvable plateau (never moved)                                  → null
 *
 * Uses `plateauSpeed` (the overshoot-robust median of the fast cruise ticks) so a
 * rest→cruise ramp prefix does not bias the steady value down — it reads the cruise,
 * not the whole-window average. For a constant-speed track plateau == that speed.
 */
export function deriveMoveSpeed(samples: FeelTrajectorySample[]): number | null {
  if (!isValidTrajectory(samples)) return null;
  const ticks = planarTickSpeeds(samples);
  const movingCount = ticks.reduce((n, t) => (t.speed > MOVE_MOVING_EPSILON_U_PER_S ? n + 1 : n), 0);
  if (movingCount < MOVE_MIN_MOVING_INTERVALS) return null; // no sustained motion / a lone snap
  const steady = plateauSpeed(ticks); // sustained cruise, overshoot-robust (NOT the peak)
  if (!(steady > 0)) return null; // never moved
  return steady;
}

/**
 * Acceleration responsiveness — `accelTo90` (ms): the time from MOVEMENT START to the
 * moment the character first reaches 90% of its steady-state planar move speed. Built
 * on the same planar (`hypot(Δx,Δz)`) tick speeds as `deriveMoveSpeed`, so it shares
 * the dimension-agnostic / Z-aware behavior (top-down +Z ramps measure correctly).
 *
 * MOVEMENT START is anchored at the START time of the first interval that leaves rest
 * (the rest→motion boundary); the 90% time is the END time of the first interval at or
 * above 0.9·steady. The duration is their difference.
 *
 * Honest-or-omit (returns null → omit, never a fabricated value):
 *   - malformed/empty trajectory, or never moved (no plateau)        → null
 *   - never reaches 90% of steady within the window                  → null
 *   - NO GENUINE RAMP: fewer than two intermediate (above-rest,
 *     sub-plateau) ticks between movement start and the 90% point    → null
 *
 * The genuine-ramp guard mirrors `deriveRunAcceleration`: an INSTANT controller snaps
 * straight to cruise (movement start IS already ≥90%, zero intermediates) and the
 * single PARTIAL-injection tick before the plateau is exactly ONE intermediate — both
 * are NOT an acceleration ramp, so we omit rather than fabricate a 1–2 frame "accel".
 */
export function deriveAccelTo90(samples: FeelTrajectorySample[]): number | null {
  if (!isValidTrajectory(samples)) return null;
  const ticks = planarTickSpeeds(samples);
  if (ticks.length < 2) return null;
  const steady = plateauSpeed(ticks); // sustained cruise, overshoot-robust (NOT the peak)
  if (!(steady > 0)) return null; // never moved
  const restFloor = steady * REST_FLOOR_FRACTION;

  const startIdx = ticks.findIndex((t) => t.speed > restFloor);
  if (startIdx < 0) return null; // never left rest
  const ninetyIdx = ticks.findIndex((t) => t.speed >= steady * 0.9);
  if (ninetyIdx < 0) return null; // never reached 90% of steady in-window

  // A resolvable accel ramp must have ≥2 genuine intermediate (above-rest, sub-plateau)
  // ticks between movement start and the 90% point — else it's an instant snap or the
  // single partial-injection artifact, not a real ramp. OMIT rather than fabricate.
  const ramp = ticks.slice(startIdx, ninetyIdx + 1);
  if (intermediateRampTickCount(ramp, steady) < MIN_INTERMEDIATE_RAMP_TICKS) return null;

  const accelMs = ticks[ninetyIdx].endMs - ticks[startIdx].startMs;
  if (!(accelMs > 0)) return null;
  return accelMs;
}

// ── wall-slide tangent-preservation proof (movement-feel gate, dogfood learnings §2) ────
//
// dogfood finding: the controller FROZE when diagonal input pushed the player into a
// wall. The fix combined a zero-friction player collider material + a collide-and-slide
// projection that removes ONLY the into-wall velocity component, and the VERIFICATION
// measured tangential movement WHILE PINNED against the wall. The durable rule (plan §2
// "Wall-Slide Is A Feel Gate, Not A Bugfix Detail", backlog High #2): a movement
// controller must NOT pass just because walls block the player — it must PROVE that
// diagonal-into-obstacle input preserves the intended TANGENT motion.
//
// `deriveWallSlideTangentRatio` measures that directly from a position trajectory
// captured while a KNOWN diagonal input drives the character against a wall of KNOWN
// normal, over a declared PINNED window. It is dimension-agnostic on the ground plane
// (XZ, like `deriveMoveSpeed` — `y` is up and ignored; a missing `z` defaults to 0), and
// refuse-shaped: it never fudges a value when the sample is not a valid wall-slide test.
//
// GEOMETRY (all vectors are ground-plane {x,z}):
//   n  = unit wall OUTWARD normal — points from the wall surface toward the open space
//        where the character stands (the direction the wall pushes back).
//   i  = the input DRIVE vector — direction the player pushes, magnitude = intended move
//        speed (u/s). "Into the wall" means i has a component OPPOSITE n: dot(i,n) < 0.
//   tangent component of the input   =  i − (i·n)·n            (input minus its normal part)
//   expectedTangentialSpeed          = |i − (i·n)·n|           (u/s; what a perfect slide keeps)
//   t̂ (unit tangent)                 = normalize(i − (i·n)·n)
//   measuredTangentialSpeed          = (Δposition over the window · t̂) / windowDurationSec
//   tangentRatio                     = measuredTangentialSpeed / expectedTangentialSpeed
// So tangentRatio ≈ 1.0 is a PERFECT projected slide (the collide-and-slide fix), ≈ 0 is
// the FROZEN controller (the dogfood bug), and a full-speed "arcade" redirect can exceed
// 1.0 (it keeps the whole input magnitude along the wall, not just the tangential part —
// the projected-vs-arcade design choice the pack band exposes).
//
// PINNING is proven from the SAME trajectory: with the character pressed against the wall
// its coordinate ALONG the normal (`position·n`) stays ~constant. If that coordinate
// drifts beyond `WALL_SLIDE_PIN_EPSILON_U` across the window the character was NOT pinned
// (it slid off, bounced, or the wall was not there) → the sample is invalid → REFUSE,
// never a fudged ratio. A frozen controller is still "pinned" (drift ≈ 0) and reads a
// clean 0 ratio — exactly the honest bug signal.
//
// Z IS LOAD-BEARING (the RCL-T02 Z-blindness family): the unit normal n and the unit
// tangent t̂ are orthogonal, so TOGETHER they span the whole XZ ground plane — z is always
// needed by at least one of the two measurement axes (the pin axis or the tangent axis).
// Therefore:
//   - if ANY sample carries z, EVERY sample must carry a FINITE z (a 3D capture samples z
//     on every tick; a heterogeneous/NaN z would score as 0 and fabricate displacement or
//     drift) → else REFUSE (mirrors deriveScreenShakeMag's homogeneity guard);
//   - a trajectory with NO z at all (a planar-x-only capture) can NEVER measure a wall
//     slide — whichever of n/t̂ has a z component would read a fabricated 0 (a z-tangent
//     slide reads FROZEN; a z-normal wall reads falsely PINNED) → REFUSE.
//
// AVERAGE-SPEED SEMANTICS + STALL DETECTION: `tangentRatio` is a WINDOW-AVERAGE — net
// tangential displacement over the window divided by its duration. A controller that
// freezes for most of the window and then SNAPS to the endpoint averages the same ratio
// as a smooth slide, so the headline ratio alone cannot see intermittent freezes. The
// per-step `tangentialStallFraction` carries that evidence alongside: the time-weighted
// fraction of the window spent in inter-sample steps with ~zero tangential progress
// (below `WALL_SLIDE_STALL_EPSILON_FRACTION` of the expected tangential speed) WHILE the
// input drives. A stall is a MEASUREMENT, not a refusal — a 1.0 ratio with a 0.8 stall
// fraction is visibly suspect and the band/consumer judges it.
//
// MEASURE-ONLY (a report row / measured value, never a banded gate value unless a
// GenreContract promotes it), and re-derivable from a raw sampled trajectory — so it is
// NOT registered in REDERIVABLE_METRICS / `deriveMetric` (no live source binds it yet;
// LIVE Unity capture is DEFERRED like the hold-channel / move-speed substrate).

/** A ground-plane 2-vector {x,z} (the up axis `y` is irrelevant to a vertical wall). */
export interface PlanarVec {
  x: number;
  z: number;
}

/** Optional collider-material evidence a wall-slide capture MAY carry (the doc's fix). */
export interface ColliderMaterialEvidence {
  /** Unity `PhysicMaterial.dynamicFriction` on the player collider. */
  dynamicFriction: number;
  /** Unity `PhysicMaterial.staticFriction` on the player collider. */
  staticFriction: number;
}

/** The full wall-slide capture the calculator consumes. */
export interface WallSlideCapture {
  /** Position trajectory captured WHILE the diagonal input drives into the wall. */
  samples: FeelTrajectorySample[];
  /** Unit (or any non-zero) wall OUTWARD normal on the ground plane — see geometry above. */
  wallNormal: PlanarVec | undefined | null;
  /** The input DRIVE vector on the ground plane: direction the player pushes, magnitude = intended u/s. */
  inputVector: PlanarVec | undefined | null;
  /** The PINNED measurement window [startMs,endMs] (same timeline as `samples[].tMs`). */
  window: { startMs: number; endMs: number } | undefined | null;
  /**
   * OPTIONAL collider-material evidence. Material introspection is optional evidence, so its
   * ABSENCE is a stated LIMIT (not a refusal); when PRESENT, non-zero friction is FLAGGED as a
   * finding (the dogfood fix used a zero-friction player collider material).
   */
  colliderMaterial?: ColliderMaterialEvidence | null;
}

/** The collider-material sub-report: present (with a friction finding or null) OR an absent-evidence limit. */
export type ColliderMaterialReport =
  | { present: true; dynamicFriction: number; staticFriction: number; frictionFinding: string | null }
  | { present: false; limit: string };

/** Outcome of the wall-slide proof: a measured tangent ratio + material report, OR an honest refusal. */
export type WallSlideResult =
  | {
      ok: true;
      /** measuredTangentialSpeed / expectedTangentialSpeed (1.0 ≈ perfect projected slide, 0 = frozen). */
      tangentRatio: number;
      /** Average tangential speed the character achieved along the wall over the window (u/s). */
      measuredTangentialSpeedUPerS: number;
      /** The tangential component of the input drive the slide is expected to preserve (u/s). */
      expectedTangentialSpeedUPerS: number;
      /**
       * Time-weighted fraction of the window spent in inter-sample steps with ~ZERO tangential
       * progress while the input drives (0 = smooth slide, 1 = fully frozen). The freeze-then-snap
       * detector: `tangentRatio` is a window AVERAGE (net displacement / duration), so a controller
       * frozen 80% of the window that snaps to the endpoint still averages ≈1.0 — this field carries
       * that stall evidence alongside (a MEASUREMENT, not a refusal; the band/consumer judges it).
       */
      tangentialStallFraction: number;
      /** Observed range of `position·n` across the window — proof the character stayed pinned (u). */
      pinnedDriftU: number;
      /** Collider-material finding (present → friction audit; absent → stated limit). */
      colliderMaterial: ColliderMaterialReport;
    }
  | { ok: false; reason: string };

/** Minimum count of samples that must fall INSIDE the pinned window to measure a slide. */
const WALL_SLIDE_MIN_PINNED_SAMPLES = 4;
/** Minimum EFFECTIVE duration (ms) the in-window samples must span — a shorter pin is too brief to grade. */
const WALL_SLIDE_MIN_WINDOW_MS = 100;
/**
 * An inter-sample step is a tangential STALL when its tangential speed is below this fraction of the
 * expected tangential speed (~zero progress while the input drives). Feeds `tangentialStallFraction`.
 */
const WALL_SLIDE_STALL_EPSILON_FRACTION = 0.05;
/**
 * Max range of the character's normal-coordinate (`position·n`) across the window, in world units,
 * for it to count as PINNED. Small penetration-correction jitter is tolerated; a larger drift means
 * the character left the wall (not a valid wall-slide test) → refuse.
 */
const WALL_SLIDE_PIN_EPSILON_U = 0.15;
/**
 * Minimum |cos| by which the (unit) input must point INTO the wall (`inputDir·n < −this`). Below it
 * the input is not meaningfully driving into the wall, so there is nothing to slide against → refuse.
 */
const WALL_SLIDE_INTO_WALL_MIN_COS = 0.05;
/**
 * Minimum tangential FRACTION of the input (`sqrt(1 − (inputDir·n)²)`). Below it the input is head-on
 * into the wall (no meaningful tangential component to preserve) → refuse (not a glancing/diagonal test).
 */
const WALL_SLIDE_MIN_TANGENT_FRACTION = 0.05;

const planarDot = (a: PlanarVec, b: PlanarVec): number => a.x * b.x + a.z * b.z;
const planarLen = (a: PlanarVec): number => Math.hypot(a.x, a.z);
const isPlanarVec = (v: unknown): v is PlanarVec =>
  typeof v === "object" && v !== null && isFiniteNumber((v as PlanarVec).x) && isFiniteNumber((v as PlanarVec).z);

/** The character's ground-plane position at a sample as a {x,z} planar vector (z defaults to 0). */
const planarPos = (s: FeelTrajectorySample): PlanarVec => ({ x: s.x, z: s.z ?? 0 });

/** Build the collider-material sub-report (present-with-finding, or an absent-evidence limit). */
function colliderMaterialReport(material: ColliderMaterialEvidence | null | undefined): ColliderMaterialReport {
  if (!material || !isFiniteNumber(material.dynamicFriction) || !isFiniteNumber(material.staticFriction)) {
    return {
      present: false,
      limit: "collider material not captured — friction audit unavailable (optional evidence, not a refusal)",
    };
  }
  const { dynamicFriction, staticFriction } = material;
  const nonZero = dynamicFriction > 0 || staticFriction > 0;
  return {
    present: true,
    dynamicFriction,
    staticFriction,
    frictionFinding: nonZero
      ? `player collider material has NON-ZERO friction (dynamic ${dynamicFriction}, static ${staticFriction}) — ` +
        "the dogfood wall-slide fix used a ZERO-friction player material so the wall never grabs the character"
      : null,
  };
}

/**
 * Wall-slide proof — `wallSlideTangentRatio`: the fraction of the input's tangential speed the
 * character actually achieves while pinned against a wall (1.0 ≈ a perfect projected slide, 0 = the
 * FROZEN dogfood controller). See the section header for the full geometry.
 *
 * Refuse-don't-skip (never a fudged ratio when the sample is not a valid wall-slide test):
 *   - missing/degenerate wall normal (zero length)                         → refuse
 *   - missing/degenerate input vector (zero length)                        → refuse
 *   - the input is NOT driving into the wall (dot(inputDir,n) ≥ −ε)        → refuse (not an into-wall test)
 *   - the input is head-on (no tangential component to preserve)           → refuse (not a glancing test)
 *   - malformed / non-monotonic trajectory                                 → refuse
 *   - HETEROGENEOUS z (some samples carry z, any is absent/non-finite)     → refuse (z would score as 0
 *     and fabricate displacement/drift — the RCL-T02 Z-blindness family)
 *   - NO z anywhere (planar-x-only capture)                                → refuse (n ⊥ t̂ span the XZ
 *     plane, so one measurement axis is always z-dependent — unmeasurable)
 *   - too few samples inside the window / effective span < 100ms           → refuse (window too short)
 *   - the character was NOT actually pinned (normal-coord drift > epsilon)  → refuse (invalid sample)
 * Returns `{ ok:true, tangentRatio, tangentialStallFraction, … }` (with the collider-material report)
 * only for a clean, pinned, into-wall diagonal capture. `tangentRatio` is a window AVERAGE; the
 * per-step `tangentialStallFraction` carries the freeze-then-snap evidence alongside. MEASURE-ONLY.
 */
export function deriveWallSlideTangentRatio(capture: WallSlideCapture): WallSlideResult {
  // Wall normal + input vector must be present, finite, and non-degenerate.
  if (!isPlanarVec(capture.wallNormal) || planarLen(capture.wallNormal) < 1e-9) {
    return { ok: false, reason: "no usable wall normal (missing or zero-length {x,z})" };
  }
  if (!isPlanarVec(capture.inputVector) || planarLen(capture.inputVector) < 1e-9) {
    return { ok: false, reason: "no usable input vector (missing or zero-length {x,z})" };
  }
  const nLen = planarLen(capture.wallNormal);
  const n: PlanarVec = { x: capture.wallNormal.x / nLen, z: capture.wallNormal.z / nLen }; // unit normal
  const iRaw = capture.inputVector; // magnitude = intended move speed (u/s)
  const iLen = planarLen(iRaw);
  const iDotN = planarDot(iRaw, n);
  const intoWallCos = iDotN / iLen; // cos angle between input dir and the OUTWARD normal (negative = into wall)

  // The input must actually drive INTO the wall (a component opposite the outward normal).
  if (!(intoWallCos < -WALL_SLIDE_INTO_WALL_MIN_COS)) {
    return {
      ok: false,
      reason: `the input is not driving into the wall (inputDir·n = ${intoWallCos.toFixed(3)} ≥ −${WALL_SLIDE_INTO_WALL_MIN_COS}) — not a wall-slide test`,
    };
  }
  // The tangential (along-wall) component the slide is supposed to preserve: i − (i·n)·n.
  const tangentVec: PlanarVec = { x: iRaw.x - iDotN * n.x, z: iRaw.z - iDotN * n.z };
  const expectedTangentialSpeed = planarLen(tangentVec);
  const tangentFraction = expectedTangentialSpeed / iLen;
  if (tangentFraction < WALL_SLIDE_MIN_TANGENT_FRACTION || !(expectedTangentialSpeed > 0)) {
    return {
      ok: false,
      reason: `the input is head-on into the wall (tangential fraction ${tangentFraction.toFixed(3)} < ${WALL_SLIDE_MIN_TANGENT_FRACTION}) — no tangent motion to preserve`,
    };
  }
  const tHat: PlanarVec = { x: tangentVec.x / expectedTangentialSpeed, z: tangentVec.z / expectedTangentialSpeed };

  // Trajectory + window validity.
  if (!isValidTrajectory(capture.samples)) {
    return { ok: false, reason: "malformed trajectory (need ≥2 finite, strictly time-ordered samples)" };
  }
  // Z homogeneity, fail-closed (the RCL-T02 Z-blindness family; mirrors deriveScreenShakeMag):
  // if ANY sample carries z, EVERY sample must carry a FINITE z — a heterogeneous or NaN z would
  // score as 0 via `s.z ?? 0` and fabricate tangential displacement or pin drift.
  const has3D = capture.samples.some((s) => s.z !== undefined);
  if (has3D && !capture.samples.every((s) => isFiniteNumber(s.z))) {
    return {
      ok: false,
      reason: "heterogeneous z on the trajectory (some samples carry z, others absent/non-finite) — an absent z would score as 0 and fabricate displacement",
    };
  }
  // Z is LOAD-BEARING: n and t̂ are orthogonal so together they span the XZ plane — at least one of
  // the pin axis / tangent axis always has a z component. A planar-x-only capture (no z anywhere)
  // would read a fabricated 0 on that axis (a z-tangent slide reads FROZEN; a z-normal wall reads
  // falsely PINNED) → refuse, never measure.
  if (!has3D) {
    return {
      ok: false,
      reason: "the trajectory carries no z (planar-x-only capture) — the wall-slide geometry needs the full XZ ground plane (the pin and tangent axes span it), so the measurement is impossible",
    };
  }
  const win = capture.window;
  if (!win || !isFiniteNumber(win.startMs) || !isFiniteNumber(win.endMs) || !(win.endMs > win.startMs)) {
    return { ok: false, reason: "no valid pinned window (need finite startMs < endMs)" };
  }
  const windowed = capture.samples.filter((s) => s.tMs >= win.startMs && s.tMs <= win.endMs);
  if (windowed.length < WALL_SLIDE_MIN_PINNED_SAMPLES) {
    return {
      ok: false,
      reason: `window too short — ${windowed.length} sample(s) inside [${win.startMs},${win.endMs}]ms, need ≥${WALL_SLIDE_MIN_PINNED_SAMPLES}`,
    };
  }
  // The in-window samples must SPAN a minimum duration — 4 samples bunched in a few ms is not a
  // gradeable pin (D4). Measured on the effective span, not the declared window bounds.
  const spanMs = windowed[windowed.length - 1].tMs - windowed[0].tMs;
  if (spanMs < WALL_SLIDE_MIN_WINDOW_MS) {
    return {
      ok: false,
      reason: `window too short — in-window samples span ${spanMs.toFixed(1)}ms, need ≥${WALL_SLIDE_MIN_WINDOW_MS}ms`,
    };
  }

  // PINNING: the character's normal-coordinate (position·n) must stay ~constant across the window.
  let minNormalCoord = Infinity;
  let maxNormalCoord = -Infinity;
  for (const s of windowed) {
    const nc = planarDot(planarPos(s), n);
    if (nc < minNormalCoord) minNormalCoord = nc;
    if (nc > maxNormalCoord) maxNormalCoord = nc;
  }
  const pinnedDriftU = maxNormalCoord - minNormalCoord;
  if (pinnedDriftU > WALL_SLIDE_PIN_EPSILON_U) {
    return {
      ok: false,
      reason: `the character was not pinned to the wall (normal-coord drift ${pinnedDriftU.toFixed(3)}u > ${WALL_SLIDE_PIN_EPSILON_U}u) — invalid wall-slide sample`,
    };
  }

  // MEASURED tangential speed: net displacement over the window projected onto the unit tangent.
  // WINDOW-AVERAGE semantics: net displacement / duration — intermittent freezes inside the window
  // do NOT lower a ratio that ends at the same endpoint; `tangentialStallFraction` below carries them.
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const durSec = spanMs / 1000; // > 0, guaranteed by the min-window guard above
  const disp: PlanarVec = { x: last.x - first.x, z: (last.z ?? 0) - (first.z ?? 0) };
  const measuredTangentialSpeed = planarDot(disp, tHat) / durSec; // signed: negative = slid the wrong way
  const tangentRatio = measuredTangentialSpeed / expectedTangentialSpeed;

  // STALL DETECTION (freeze-then-snap, D2): per inter-sample step, the tangential speed
  // (Δpos·t̂)/Δt. A step below WALL_SLIDE_STALL_EPSILON_FRACTION of the EXPECTED tangential speed
  // made ~zero progress while the input drives — a stall. Time-weighted so uneven sampling is
  // honest: stallFraction = stalled time / total in-window span. A MEASUREMENT, never a refusal.
  let stalledMs = 0;
  for (let k = 1; k < windowed.length; k += 1) {
    const dtMs = windowed[k].tMs - windowed[k - 1].tMs; // > 0 (strictly increasing tMs)
    const step: PlanarVec = {
      x: windowed[k].x - windowed[k - 1].x,
      z: (windowed[k].z ?? 0) - (windowed[k - 1].z ?? 0),
    };
    const stepTangentialSpeed = planarDot(step, tHat) / (dtMs / 1000);
    if (stepTangentialSpeed < WALL_SLIDE_STALL_EPSILON_FRACTION * expectedTangentialSpeed) {
      stalledMs += dtMs;
    }
  }
  const tangentialStallFraction = stalledMs / spanMs;

  return {
    ok: true,
    tangentRatio,
    measuredTangentialSpeedUPerS: measuredTangentialSpeed,
    expectedTangentialSpeedUPerS: expectedTangentialSpeed,
    tangentialStallFraction,
    pinnedDriftU,
    colliderMaterial: colliderMaterialReport(capture.colliderMaterial),
  };
}

// ── camera follow damping (3D top-down / twin-stick camera-feel metric) ───────
//
// dogfood findings RCL-F01/RCL-F02. The 3d-shooter pack hard-codes an over-shoulder
// THIRD-PERSON rig; the empty 3D-top-down / twin-stick quadrant has its own camera
// FEEL dial the dogfood spec named — "camera half-life 0.10–0.18s, look-ahead 2–4m" —
// that no calculator could measure. Given the player's `{x,y,z}` trajectory AND the
// camera's `{x,y,z}` trajectory captured over the SAME window (paired, time-aligned),
// this measures how a follow camera CHASES the player:
//
//   - halfLifeMs — the catch-up HALF-LIFE: after the player moves, how long the camera
//     takes to close HALF the remaining gap to its settled pose. A small half-life is a
//     tight/snappy camera; a large one is loose/floaty. An exponentially-damped follow
//     (Lerp / SmoothDamp toward a target) leaves a residual gap g(t)=g0·exp(−t/τ), so the
//     half-life is CONSTANT (= τ·ln2) and recoverable by a log-linear fit of the gap decay.
//   - lookAheadOffset — the steady-state LEAD: at rest the camera sits ahead of the player
//     ALONG the movement vector by this many world units (the "look-ahead bias toward the
//     aim/movement vector" the `3d-topdown-arena` framing declares). Measured as the mean
//     signed projection of (camera − player) onto the net movement direction in the settled
//     window.
//
// Dimension-agnostic: the gap and the movement direction use the full Euclidean `{x,y,z}`
// step (a missing z reads as 0), so a top-down rig whose follow lives in the XZ ground plane
// — and a constant overhead camera Y — measure correctly, and a legacy 2D capture is unchanged.
//
// Honest-or-omit (REFUSE — never fabricate a damping value when the camera does not follow):
//   - either trajectory malformed, or the two captures are not time-aligned → refuse
//   - the player never moves (no follow stimulus)                           → refuse
//   - the camera never moves (a fixed/static rig, not a follow camera)      → refuse
//   - the player returns home with no net direction (no look-ahead axis)    → refuse
//   - the gap never decays (the camera diverges / a degraded capture)       → refuse
// An INSTANT-snap camera (zero damping: the gap collapses within one frame, leaving no decay
// tail to fit) is NOT a refusal — it is the HONEST measurement `halfLifeMs = 0` (a camera that
// rigidly tracks the player), with `evidence.instant = true`.

const CAMERA_FOLLOW_EPSILON_U = 1e-3;

/** Euclidean distance between two samples over the full `{x,y,z}` (missing z = 0). */
function followDist3(a: FeelTrajectorySample, b: FeelTrajectorySample): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

export interface CameraFollowDampingResult {
  /** True iff a damping value was honestly measured (incl. instant-snap halfLife 0). */
  measured: boolean;
  /** Refusal reason when `measured` is false; absent on success. */
  reason?: string;
  /** Catch-up half-life in ms (0 = instant/no damping); null when refused. */
  halfLifeMs: number | null;
  /** Steady-state lead toward the movement vector, world units (signed); null when refused. */
  lookAheadOffset: number | null;
  /** Evidence supporting a successful measurement. */
  evidence?: {
    decaySampleCount: number;
    gapPeak: number;
    gapFinal: number;
    movementUnit: { x: number; y: number; z: number };
    instant: boolean;
  };
}

function refuseFollowDamping(reason: string): CameraFollowDampingResult {
  return { measured: false, reason, halfLifeMs: null, lookAheadOffset: null };
}

/**
 * Steady-state look-ahead (world units): the mean signed projection of (camera − player)
 * onto the net movement direction, over the SETTLED window (gap within 10% of its peak's
 * residual — i.e. the camera has converged). Positive = the camera LEADS the player along
 * the movement vector. Falls back to the final sample when no settled window resolves.
 */
function computeFollowLookAhead(
  player: FeelTrajectorySample[],
  camera: FeelTrajectorySample[],
  gap: number[],
  gapPeak: number,
  movementUnit: { x: number; y: number; z: number },
): number {
  const settleFloor = gapPeak * 0.1;
  const idxs: number[] = [];
  for (let i = 0; i < gap.length; i += 1) if (gap[i] <= settleFloor) idxs.push(i);
  const use = idxs.length > 0 ? idxs : [gap.length - 1];
  let sum = 0;
  for (const i of use) {
    const dx = camera[i].x - player[i].x;
    const dy = camera[i].y - player[i].y;
    const dz = (camera[i].z ?? 0) - (player[i].z ?? 0);
    sum += dx * movementUnit.x + dy * movementUnit.y + dz * movementUnit.z;
  }
  return sum / use.length;
}

/**
 * Camera follow damping (RCL-F01/F02): catch-up half-life (ms) + steady look-ahead (u) of a
 * follow camera, from a paired player/camera `{x,y,z}` capture. Honest-or-omit (refuses rather
 * than fabricate; an instant-snap camera reports `halfLifeMs = 0`, not a refusal). See header.
 */
export function deriveCameraFollowDamping(
  player: FeelTrajectorySample[],
  camera: FeelTrajectorySample[],
): CameraFollowDampingResult {
  if (!isValidTrajectory(player) || !isValidTrajectory(camera)) {
    return refuseFollowDamping("malformed-trajectory");
  }
  if (player.length !== camera.length) {
    return refuseFollowDamping("misaligned-capture");
  }
  for (let i = 0; i < player.length; i += 1) {
    if (Math.abs(player[i].tMs - camera[i].tMs) > 1e-6) {
      return refuseFollowDamping("misaligned-capture");
    }
  }

  // The player must provide a follow stimulus (it has to move at all).
  let playerMaxFromStart = 0;
  for (const s of player) playerMaxFromStart = Math.max(playerMaxFromStart, followDist3(s, player[0]));
  if (playerMaxFromStart < CAMERA_FOLLOW_EPSILON_U) return refuseFollowDamping("no-player-motion");

  // The camera must be a follow rig (it has to move) — a fixed/static camera is refused.
  let cameraMaxFromStart = 0;
  for (const s of camera) cameraMaxFromStart = Math.max(cameraMaxFromStart, followDist3(s, camera[0]));
  if (cameraMaxFromStart < CAMERA_FOLLOW_EPSILON_U) return refuseFollowDamping("camera-static");

  // Net movement direction (player first → last). The look-ahead is projected onto this, so a
  // player that returns home (no net displacement) has no axis to lead along → refuse.
  const pFirst = player[0];
  const pLast = player[player.length - 1];
  const mx = pLast.x - pFirst.x;
  const my = pLast.y - pFirst.y;
  const mz = (pLast.z ?? 0) - (pFirst.z ?? 0);
  const mMag = Math.hypot(mx, my, mz);
  if (mMag < CAMERA_FOLLOW_EPSILON_U) return refuseFollowDamping("no-net-movement-direction");
  const movementUnit = { x: mx / mMag, y: my / mMag, z: mz / mMag };

  // Residual gap to the SETTLED camera pose (the exponential follow decays this to ~0).
  const camFinal = camera[camera.length - 1];
  const gap = camera.map((s) => followDist3(s, camFinal));
  const gapPeak = Math.max(...gap);
  if (gapPeak < CAMERA_FOLLOW_EPSILON_U) return refuseFollowDamping("camera-static");

  // Decay BEGINS at the LAST index still at the peak (the moment the camera starts to close
  // the gap); anything earlier is the pre-stimulus plateau and would flatten the fit.
  const peakFloor = gapPeak * (1 - 1e-6);
  let decayStart = 0;
  for (let i = 0; i < gap.length; i += 1) if (gap[i] >= peakFloor) decayStart = i;

  // Log-linear fit over the decaying tail (gap above a small relative+absolute floor).
  const floor = Math.max(gapPeak * 1e-3, CAMERA_FOLLOW_EPSILON_U);
  const ts: number[] = [];
  const lnGap: number[] = [];
  for (let i = decayStart; i < gap.length; i += 1) {
    if (gap[i] > floor) {
      ts.push(camera[i].tMs);
      lnGap.push(Math.log(gap[i]));
    }
  }

  const gapFinal = gap[gap.length - 1];
  const lookAheadOffset = computeFollowLookAhead(player, camera, gap, gapPeak, movementUnit);

  // Instant snap (zero damping): the gap collapsed within ~one frame, leaving no decay tail to
  // fit, but the camera DID move and settle → honest `halfLifeMs = 0`, not a refusal.
  if (ts.length < 2) {
    if (gapFinal <= floor) {
      return {
        measured: true,
        halfLifeMs: 0,
        lookAheadOffset,
        evidence: { decaySampleCount: ts.length, gapPeak, gapFinal, movementUnit, instant: true },
      };
    }
    return refuseFollowDamping("no-resolvable-decay");
  }

  // gap(t) = g0·exp(slope·t); slope < 0 for a real catch-up. Half-life = ln2 / |slope|.
  const slope = leastSquaresSlope(ts, lnGap);
  if (slope === null || !(slope < 0)) return refuseFollowDamping("no-catch-up");
  const halfLifeMs = Math.LN2 / -slope;

  return {
    measured: true,
    halfLifeMs,
    lookAheadOffset,
    evidence: { decaySampleCount: ts.length, gapPeak, gapFinal, movementUnit, instant: false },
  };
}

// ── fall-gravity multiplier (F5) ─────────────────────────────────────────────
//
// The "floaty rise, fast fall" asymmetry: the ratio of DESCENT vertical
// acceleration to ASCENT vertical acceleration on a jump arc. From per-tick
// vertical SPEED dy/dt we take the ascent acceleration (slope of dy/dt while
// rising, before apex) and descent acceleration (slope while falling, after
// apex); the multiplier is |descentAccel| / |ascentAccel|. For a symmetric arc
// this is ~1.0; a heavier fall reads > 1.
//
// CRITICAL (inconclusive → omit): this REQUIRES samples through and PAST the apex
// to ground contact. If the window has no real descent (truncated before/at apex)
// or never returns near the start Y (cut short mid-fall), we CANNOT honestly
// measure the descent leg and return null so the assembler omits it — we never
// fabricate a number from a half-arc. Mirrors the bisection "didn't bracket → omit".

export function deriveFallGravityMultiplier(samples: FeelTrajectorySample[]): number | null {
  // Apex = index of the max Y (first reaching it).
  let apexIdx = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].y > samples[apexIdx].y) apexIdx = i;
  }
  // Need a real ascent (samples before apex) AND a real descent (after apex).
  // An apex at the first or last sample means a truncated/half arc → inconclusive.
  if (apexIdx <= 0 || apexIdx >= samples.length - 1) return null;

  const startY = samples[0].y;
  const apexY = samples[apexIdx].y;
  const endY = samples[samples.length - 1].y;
  const rise = apexY - startY;
  if (!(rise > 0)) return null; // no measurable jump

  // The descent must come back DOWN past the apex toward the launch level — if it
  // barely dipped (cut short mid-fall, never near start-Y) we can't trust the
  // descent slope. Require the fall to recover most of the rise.
  const descended = apexY - endY;
  if (!(descended >= rise * 0.5)) return null; // window ended before a real fall → omit

  // Per-tick vertical velocity (dy/dt), centered between samples, split at apex.
  // We reuse rampSlope (least-squares slope vs time) over each leg — the slope of
  // vertical velocity IS the vertical acceleration on that leg.
  const ascent: { speed: number; tSec: number }[] = [];
  const descent: { speed: number; tSec: number }[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtSec = (samples[i].tMs - samples[i - 1].tMs) / 1000;
    if (dtSec <= 0) continue;
    const vy = (samples[i].y - samples[i - 1].y) / dtSec;
    const tSec = (samples[i].tMs + samples[i - 1].tMs) / 2 / 1000;
    // Interval i straddles samples i-1..i; assign to the leg it lies within.
    if (i <= apexIdx) ascent.push({ speed: vy, tSec });
    else descent.push({ speed: vy, tSec });
  }
  if (ascent.length < 2 || descent.length < 2) return null;

  const ascentAccel = rampSlope(ascent); // negative (slowing the rise)
  const descentAccel = rampSlope(descent); // negative (speeding the fall)
  if (ascentAccel === null || descentAccel === null) return null;
  if (!(Math.abs(ascentAccel) > 0)) return null; // degenerate ascent slope
  return Math.abs(descentAccel) / Math.abs(ascentAccel);
}

// ── input latency (F5) ───────────────────────────────────────────────────────
//
// "How motion BEGINS": the time from pressing the measured key to the first
// detectable motion. The capture is two phases — phase0 settles with no keys, then
// phase1 holds the key; the input ONSET is the phase0→phase1 boundary, recorded as
// a provenance field (`inputOnsetMs`) in the SAME timeline as the samples (samples
// are flat-rezeroed to capture start, so the boundary is lost without that field —
// this is the honesty crux: latency cannot be derived from samples alone).
//
// ALGORITHM: latency = (tMs of the first sample AFTER onset whose position has
// moved beyond EPSILON from the at-onset position) − onsetMs. We anchor "rest" to
// the last sample at/before onset (the settled position), not samples[0], so a
// pre-onset drift can't be mistaken for the input response.
//
// HONEST-OR-OMIT (returns null → assembler omits, never a fabricated 0):
//   - onsetMs absent / non-finite                  → null (no provenance for onset)
//   - onsetMs outside the sampled window           → null (can't bracket the press)
//   - no sample strictly after onset               → null (window ended at the press)
//   - no post-onset sample exceeds EPSILON         → null (no motion detected; never
//                                                     a fabricated instant 0)

/**
 * Position-change epsilon (world units) marking "first detectable motion" after the
 * input onset. Chosen well above floating-point/quantization noise on a settled
 * body yet far below a single physics tick of real movement (e.g. a 9 u/s run
 * advances ~0.15u in one 60Hz tick — ~30× this epsilon), so the FIRST genuinely
 * moved sample is detected without false-triggering on jitter.
 */
export const INPUT_LATENCY_EPSILON_U = 5e-3;

/**
 * Input latency (ms): time from the recorded input onset to the first detectable
 * motion. Honest-or-omit (returns null) when onset is absent/out-of-window or no
 * motion is detected after onset — never a fabricated 0. Pure; re-derivable from
 * samples + onset (so a tampered latency is rejected by §0 re-derivation).
 */
export function deriveInputLatency(
  samples: FeelTrajectorySample[],
  onsetMs: number | undefined,
): number | null {
  if (!isFiniteNumber(onsetMs)) return null; // no onset provenance → cannot measure
  const first = samples[0];
  const last = samples[samples.length - 1];
  // The onset must fall WITHIN the sampled window — otherwise we can't bracket the
  // press against the trajectory (an out-of-window onset is unverifiable, not 0).
  if (onsetMs < first.tMs || onsetMs > last.tMs) return null;

  // Anchor rest at the last sample AT or BEFORE onset (the settled position at the
  // press), so pre-onset drift isn't read as the input response.
  let restX = first.x;
  let restY = first.y;
  for (const s of samples) {
    if (s.tMs <= onsetMs) {
      restX = s.x;
      restY = s.y;
    } else break;
  }
  // First sample STRICTLY after onset that moved beyond epsilon from rest.
  for (const s of samples) {
    if (s.tMs <= onsetMs) continue;
    const moved = Math.hypot(s.x - restX, s.y - restY);
    if (moved > INPUT_LATENCY_EPSILON_U) return s.tMs - onsetMs;
  }
  return null; // no detectable motion after onset → omit, never a fabricated 0
}

/**
 * Re-derive one metric from a trajectory, or null if it isn't trajectory-derivable.
 * `onsetMs` is required only for the input-bound latency metrics (`inputLatency` and
 * `lookInputToYawLatencyMs`); the other metrics ignore it.
 */
export function deriveMetric(
  metric: string,
  samples: FeelTrajectorySample[],
  onsetMs?: number,
): number | null {
  switch (metric) {
    case "jumpApex":
      return deriveJumpApex(samples);
    case "shortHopApex":
      return deriveShortHopApex(samples);
    case "timeToApex":
      return deriveTimeToApex(samples);
    case "runSpeed":
      return deriveRunSpeed(samples);
    case "runAcceleration":
      return deriveRunAcceleration(samples);
    case "runDeceleration":
      return deriveRunDeceleration(samples);
    case "fallGravityMultiplier":
      return deriveFallGravityMultiplier(samples);
    case "projectileSpeed":
      return deriveProjectileSpeed(samples);
    case "aimTurnRateDegPerSec":
      return deriveAimTurnRateDegPerSec(samples);
    case "inputLatency":
      return deriveInputLatency(samples, onsetMs);
    case "lookInputToYawLatencyMs":
      return deriveLookInputToYawLatencyMs(samples, onsetMs);
    default:
      return null; // coyote/jumpBuffer/etc. — not trajectory-derivable
  }
}

// ── cross-modal sync edges (L3b) ─────────────────────────────────────────────
//
// L3b derives a SYNC metric — the latency between an input/event edge and a
// SECOND modality firing (a sound cue, a particle spawn) — from a `fieldTimeline`
// entry the L3a runtime-field sampler emits. Every sync metric is the same shape:
// the delta between two EVENT EDGES. The general primitive is `deriveEdgeLatency`
// (first rising edge of a series minus a reference edge); the v1 metric assembled
// from it is `inputToSfxLatency` (input onset → first SFX-cue edge).
//
// This mirrors `deriveInputLatency`'s honest-or-omit shape exactly: a sync metric
// is NEVER a fabricated 0 — when there is no rising edge, no reference, or the edge
// precedes the reference (a non-causal / inconclusive ordering), the derivation
// returns null and the assembler omits it.
//
// THE F1 INVARIANT (locked from the L3a review — non-negotiable): a `fieldTimeline`
// entry can carry `unresolved` (resolution failed) OR `readError` (a getter threw
// mid-capture, samples truncated). BOTH leave the series untrustworthy. L3b MUST
// REFUSE a metric whose series carries `unresolved != null || readError != null`
// (report it not-measured with the reason), never derive an edge from a degraded
// stream. A clean field has NEITHER. This is the §3a refuse-don't-skip rule applied
// to the sync layer — the same discipline as `isFreshGreen`'s missing-provenance
// refusal, here for a degraded sampled series.

/** One sample of a sampled runtime member on the position tick clock. */
export interface SyncSeriesSample {
  /** Milliseconds, same timeline as the position samples. */
  tMs: number;
  /** The scalar member value (bool → boolean, numeric/enum → number). */
  value: number | boolean;
}

/**
 * A `fieldTimeline` entry (the exact shape L3a's RuntimeFieldSampler emits):
 * `{ id, samples:[{tMs,value}], unresolved?, readError? }`. A CLEAN series carries
 * neither `unresolved` nor `readError`; either present means the stream is degraded
 * and a sync metric over it must REFUSE (the F1 invariant).
 */
export interface SyncSeries {
  id: string;
  samples: SyncSeriesSample[];
  /** Set iff field resolution failed — the series was never sampled (refuse). */
  unresolved?: string | null;
  /** Set iff a getter threw mid-capture — samples truncated/degraded (refuse). */
  readError?: string | null;
}

/** Outcome of a sync derivation: a measured latency OR an honest reason it was not. */
export type SyncDerivation =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: string };

/**
 * The F1 invariant guard: a `fieldTimeline` entry is trustworthy ONLY when it
 * carries NEITHER `unresolved` NOR `readError`. Returns the refusal reason (a
 * non-empty string) when the series is degraded, or null when it is clean.
 *
 * Refuse-don't-skip: an absent/degraded series is a REFUSAL with the reason, never
 * a silently-skipped check and never an edge derived from a truncated stream.
 */
export function syncSeriesRefusal(series: SyncSeries | undefined | null): string | null {
  if (!series || typeof series !== "object") {
    return "no sampled series (the fieldTimeline entry is absent)";
  }
  if (series.unresolved != null) {
    return `series '${series.id}' unresolved: ${series.unresolved}`;
  }
  if (series.readError != null) {
    return `series '${series.id}' degraded (readError): ${series.readError}`;
  }
  if (!Array.isArray(series.samples)) {
    return `series '${series.id}' has no samples array`;
  }
  return null;
}

/**
 * The `tMs` of the FIRST RISING EDGE in a series, or null if none.
 *
 * A rising edge is the first sample whose value indicates an event BEGAN, measured
 * against the FIRST sample's value (the at-capture-start baseline):
 *   - a bool baseline `false` → the first sample that is `true` (false→true).
 *   - a numeric baseline → the first sample STRICTLY ABOVE the baseline (an event
 *     fired / a counter incremented, e.g. SfxPlayer.PlayCount going 0→1).
 * A bool that is ALREADY `true` at the first sample has no rising edge in the window
 * (we can't see the transition — honest-or-omit → null); likewise a numeric that
 * never rises above its baseline. Mirrors `deriveInputLatency`'s "first sample that
 * crossed the threshold" shape, anchored to the baseline rather than a fixed epsilon.
 */
export function firstRisingEdge(series: SyncSeries): number | null {
  const samples = series.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const baseline = samples[0].value;
  if (typeof baseline === "boolean") {
    // A bool already true at baseline can't show a false→true transition here.
    if (baseline === true) return null;
    for (const s of samples) {
      if (s.value === true) return s.tMs;
    }
    return null;
  }
  if (typeof baseline === "number") {
    for (const s of samples) {
      if (typeof s.value === "number" && s.value > baseline) return s.tMs;
    }
    return null;
  }
  return null; // non-scalar baseline (shouldn't happen post-coercion) → no edge
}

/**
 * All observed event-edge times in a sampled series.
 *
 * For a numeric counter (the intended shooter-fire shape), every strict increase from the previous
 * numeric sample is an event edge. For a boolean signal, every false→true transition is an event edge.
 * A series already true at baseline does not invent an edge at t0; only observed transitions count.
 */
export function eventEdges(series: SyncSeries): number[] {
  const samples = series.samples;
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const edges: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1].value;
    const curr = samples[i].value;
    if (typeof prev === "number" && typeof curr === "number" && curr > prev) {
      edges.push(samples[i].tMs);
    } else if (prev === false && curr === true) {
      edges.push(samples[i].tMs);
    }
  }
  return edges;
}

/** Average interval between observed event edges, in ms, or null when fewer than two edges exist. */
export function deriveMeanEventInterval(series: SyncSeries): number | null {
  const edges = eventEdges(series);
  if (edges.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const delta = edges[i] - edges[i - 1];
    if (!(delta > 0)) return null;
    sum += delta;
  }
  return sum / (edges.length - 1);
}

/**
 * The tMs of the first TRANSITION INTO `targetValue` — the first sample that is the target AND is
 * preceded by a non-target sample. This is the first tick the series ENTERS that categorical state
 * (e.g. an animator entering its "jump" state, value===JUMP). Unlike firstRisingEdge (monotonic),
 * it models CATEGORICAL entry regardless of the prior state's ordinal (fall=3→jump=2 IS an entry
 * even though 2<3). `targetValue` is matched with STRICT equality, so it must be an exact discrete
 * state id (an int enum / state hash, or a bool) — do NOT bind a float field whose fractional drift
 * could never `===` the target.
 *
 * honest-or-omit: the state is never entered in-window → null; AND a series ALREADY in the target at
 * capture start (baseline === target, no observed transition) → null — never a fabricated entry. The
 * latter mirrors firstRisingEdge's "already-true → null" rule and avoids a spurious 0 latency when an
 * onset sits at t0 over a series that began in the target state. (For a bool target===true this
 * coincides with a false→true rising edge.) Re-entry (target→other→target) returns the re-entry tMs.
 */
export function firstStateEntryEdge(series: SyncSeries, targetValue: number | boolean): number | null {
  const samples = series.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  // Require a transition: a target sample preceded by a non-target one. i=0 (baseline) is never an
  // entry — a series that begins in the target shows no observed transition (honest-or-omit).
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].value === targetValue && samples[i - 1].value !== targetValue) {
      return samples[i].tMs;
    }
  }
  return null;
}

/**
 * Edge-over-onset latency (ms): `firstRisingEdge(series).tMs − referenceEdgeMs`.
 * The general sync primitive — the delta between a series' first event edge and a
 * reference edge (an input onset, another series' edge, …).
 *
 * Honest-or-omit (returns null → the assembler omits it, never a fabricated 0):
 *   - `referenceEdgeMs` absent / non-finite      → null (no reference to measure from)
 *   - no rising edge in the series               → null (the event never fired in-window)
 *   - the edge PRECEDES the reference (negative)  → null (non-causal / inconclusive
 *                                                    ordering — the cue can't precede
 *                                                    the input that triggered it)
 *
 * Does NOT itself enforce the F1 invariant (a degraded series) — the caller
 * (`deriveInputToSfxLatency`) refuses on `unresolved||readError` BEFORE calling this,
 * so a degraded series never even reaches edge derivation.
 */
export function deriveEdgeLatency(
  series: SyncSeries,
  referenceEdgeMs: number | undefined,
): number | null {
  if (!isFiniteNumber(referenceEdgeMs)) return null; // no reference → cannot measure
  const edgeMs = firstRisingEdge(series);
  if (edgeMs === null) return null; // event never fired in-window → omit, never a 0
  const latency = edgeMs - referenceEdgeMs;
  // A cue cannot precede the input that triggered it — a negative latency is a
  // non-causal / inconclusive ordering, not a real measurement. Omit (never clamp
  // to 0, which would fabricate a "perfect" sync from a broken ordering).
  if (latency < 0) return null;
  return latency;
}

/**
 * v1 sync metric — `inputToSfxLatency` (ms): the time from the recorded input ONSET
 * to the first rising edge of the SFX series (e.g. `SfxPlayer.PlayCount` going 0→1,
 * or `AudioSource.isPlaying` going false→true). The SFX series is a `fieldTimeline`
 * entry; `inputOnsetMs` is the SAME onset field F5's `inputLatency` uses (the
 * settle→press boundary, on the position clock).
 *
 * F1 invariant FIRST: refuse if the SFX series is degraded (`unresolved||readError`)
 * — never derive an edge from a truncated/unresolved stream. Then honest-or-omit via
 * `deriveEdgeLatency`. The return is a discriminated result so the assembler can
 * surface the refusal REASON (not-measured-because-X), distinct from a clean omit.
 *
 * MEASURE-ONLY: the value this produces is surfaced in the report's `alsoMeasured`
 * section (informational) and is NEVER banded — it cannot gate a verdict.
 */
export function deriveInputToSfxLatency(
  sfxSeries: SyncSeries | undefined | null,
  inputOnsetMs: number | undefined,
): SyncDerivation {
  const refusal = syncSeriesRefusal(sfxSeries);
  if (refusal !== null) return { ok: false, reason: refusal };
  if (!isFiniteNumber(inputOnsetMs)) {
    return { ok: false, reason: "no input onset recorded (cannot measure latency)" };
  }
  const latency = deriveEdgeLatency(sfxSeries as SyncSeries, inputOnsetMs);
  if (latency === null) {
    const edge = firstRisingEdge(sfxSeries as SyncSeries);
    if (edge === null) {
      return { ok: false, reason: "no SFX cue fired after capture start (no rising edge in the series)" };
    }
    return { ok: false, reason: "SFX cue edge precedes the input onset (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: latency };
}

/**
 * Shooter v1 sync metric — `fireInputToSpawnLatency` (ms): the time from the recorded
 * fire input ONSET to the first projectile-spawn edge. The spawn signal is intentionally
 * explicit: a sampled monotonic counter such as `Weapon.ProjectileSpawnCount`, or a
 * projectile-visible boolean such as `Projectile.enabled` going false→true.
 *
 * This does not discover arbitrary runtime-spawned objects. It measures a caller-bound
 * fieldTimeline signal using the same honest-or-omit discipline as input→SFX: degraded
 * series, missing onset, no spawn edge, or non-causal ordering are refused with reasons.
 */
export function deriveInputToSpawnLatency(
  spawnSeries: SyncSeries | undefined | null,
  inputOnsetMs: number | undefined,
): SyncDerivation {
  const refusal = syncSeriesRefusal(spawnSeries);
  if (refusal !== null) return { ok: false, reason: `spawn series — ${refusal}` };
  if (!isFiniteNumber(inputOnsetMs)) {
    return { ok: false, reason: "no input onset recorded (cannot measure fireInputToSpawnLatency)" };
  }
  const latency = deriveEdgeLatency(spawnSeries as SyncSeries, inputOnsetMs);
  if (latency === null) {
    const edge = firstRisingEdge(spawnSeries as SyncSeries);
    if (edge === null) {
      return { ok: false, reason: "no projectile spawn edge observed in the spawn series" };
    }
    return { ok: false, reason: "projectile spawn edge precedes the input onset (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: latency };
}

/**
 * Shooter v1 sync metric — `ttkMs` (time-to-kill, ms): the time from the FIRST-HIT edge on
 * the reference enemy to its DEATH edge. Both are caller-bound `fieldTimeline` series and both
 * are RISING signals so the existing edge primitives apply directly:
 *   - first-hit / damage edge: a monotonic `Enemy.HitCount` / `Enemy.DamageTakenCount` going 0→1
 *     (or a `Enemy.IsHit` boolean false→true) — the reference edge.
 *   - death edge: a `Enemy.IsDead` boolean false→true, or a `Enemy.DeathCount` counter 0→1 — the
 *     target edge. (Bind a rising death SIGNAL, not a falling HP series: a depleting `Health`
 *     field decreases to zero and would need a threshold-cross primitive; the explicit death
 *     signal keeps this on the same honest rising-edge path as the other sync metrics.)
 *
 * This is the SERIES→SERIES form (like `dashToGhostMs`): the reference edge is another captured
 * series' edge, not an input onset. It measures the enemy's kill duration GIVEN that hits land —
 * deliberately independent of the player's aim time.
 *
 * F1 invariant FIRST on BOTH series: refuse if EITHER the damage series OR the death series is
 * degraded (`unresolved||readError`) — never derive an edge from a truncated/unresolved stream.
 * Then the first-hit edge must exist (the enemy was never hit → refuse), and honest-or-omit via
 * `deriveEdgeLatency` (no death edge → refuse; death edge BEFORE the first-hit edge → refuse,
 * never a clamped 0). MEASURE-ONLY: surfaced in `alsoMeasured`, never banded.
 */
export function deriveTimeToKill(
  damageSeries: SyncSeries | undefined | null,
  deathSeries: SyncSeries | undefined | null,
): SyncDerivation {
  const damageRefusal = syncSeriesRefusal(damageSeries);
  if (damageRefusal !== null) return { ok: false, reason: `damage series — ${damageRefusal}` };
  const deathRefusal = syncSeriesRefusal(deathSeries);
  if (deathRefusal !== null) return { ok: false, reason: `death series — ${deathRefusal}` };
  const firstHitMs = firstRisingEdge(damageSeries as SyncSeries);
  if (firstHitMs === null) {
    return { ok: false, reason: "the reference enemy was never hit in-window (no first-hit edge in the damage series)" };
  }
  const ttk = deriveEdgeLatency(deathSeries as SyncSeries, firstHitMs);
  if (ttk === null) {
    const death = firstRisingEdge(deathSeries as SyncSeries);
    if (death === null) {
      return { ok: false, reason: "the reference enemy never died in-window (no death edge in the death series)" };
    }
    return { ok: false, reason: "the death edge precedes the first-hit edge (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: ttk };
}

/**
 * Hitscan v1 sync metric — `hitscanImpactLatencyMs` (ms): the time from the recorded fire input
 * ONSET to the first RAYCAST HIT edge, proven to causally drive damage. A hitscan weapon resolves
 * its hit by an INSTANTANEOUS raycast on the fire frame (no projectile travel), so this latency is
 * ~one capture frame — the measurable signature that distinguishes hitscan from the projectile loop
 * (whose impact arrives only after flight time).
 *
 * Enforces the full fire → raycast-hit → damage ordering (mirrors `deriveTimeToKill`'s causal-ordering
 * discipline) and REFUSES on any absent or out-of-order edge — never a fabricated value:
 *   - degraded fire OR raycast-hit OR damage series (`unresolved||readError`)  → refuse (F1 invariant)
 *   - no fire input onset                                                     → refuse
 *   - no fire edge — the weapon never fired (so "fire" is BOUND, not assumed)  → refuse
 *   - no raycast hit edge (a miss / blocked LOS — the raycast found nothing)  → refuse (never a 0)
 *   - raycast hit edge precedes the fire onset OR the fire edge (non-causal)  → refuse
 *   - no damage edge (the raycast hit registered no damage)                   → refuse
 *   - damage edge precedes the raycast hit edge — i.e. damage WITHOUT a hit   → refuse (the key
 *     review-risk guard: an injected/independent damage the raycast did not cause cannot green)
 * The `fireSeries` (a monotonic `FireCount` counter) makes the FIRE leg load-bearing: the latency is
 * still measured from the recorded input ONSET, but the gate also proves a fire actually occurred and
 * the raycast hit followed it — so a raycast-hit series with `onset=0` and no fire can never green.
 * MEASURE-ONLY: surfaced as evidence, never banded.
 */
export function deriveHitscanImpactLatencyMs(
  fireSeries: SyncSeries | undefined | null,
  raycastHitSeries: SyncSeries | undefined | null,
  damageSeries: SyncSeries | undefined | null,
  inputOnsetMs: number | undefined,
): SyncDerivation {
  const fireRefusal = syncSeriesRefusal(fireSeries);
  if (fireRefusal !== null) return { ok: false, reason: `fire series — ${fireRefusal}` };
  const hitRefusal = syncSeriesRefusal(raycastHitSeries);
  if (hitRefusal !== null) return { ok: false, reason: `raycast-hit series — ${hitRefusal}` };
  const dmgRefusal = syncSeriesRefusal(damageSeries);
  if (dmgRefusal !== null) return { ok: false, reason: `damage series — ${dmgRefusal}` };
  if (!isFiniteNumber(inputOnsetMs)) {
    return { ok: false, reason: "no fire input onset recorded (cannot measure hitscanImpactLatencyMs)" };
  }
  // FIRE leg (bound, not assumed): a fire must actually have occurred.
  const fireEdgeMs = firstRisingEdge(fireSeries as SyncSeries);
  if (fireEdgeMs === null) {
    return { ok: false, reason: "the weapon never fired in-window (no FireCount rising edge)" };
  }
  const latency = deriveEdgeLatency(raycastHitSeries as SyncSeries, inputOnsetMs);
  if (latency === null) {
    const edge = firstRisingEdge(raycastHitSeries as SyncSeries);
    if (edge === null) {
      return { ok: false, reason: "no raycast hit edge (the shot missed / hit nothing — no RaycastHitCount rise)" };
    }
    return { ok: false, reason: "the raycast hit edge precedes the fire onset (non-causal ordering — inconclusive)" };
  }
  const hitEdgeMs = firstRisingEdge(raycastHitSeries as SyncSeries) as number;
  // The raycast hit cannot precede the fire that produced it.
  if (hitEdgeMs < fireEdgeMs) {
    return { ok: false, reason: "the raycast hit edge precedes the fire edge (non-causal — the hit did not follow a fire)" };
  }
  // The raycast hit must CAUSE damage: the damage edge must land at/after the raycast hit edge.
  const damageEdgeMs = firstRisingEdge(damageSeries as SyncSeries);
  if (damageEdgeMs === null) {
    return { ok: false, reason: "the raycast hit registered no damage (no damage edge — hit-without-damage)" };
  }
  if (damageEdgeMs < hitEdgeMs) {
    return { ok: false, reason: "the damage edge precedes the raycast hit edge (damage WITHOUT a hit — non-causal, refused)" };
  }
  return { ok: true, latencyMs: latency };
}

/**
 * AI v1 sync metric — `enemyReactionLatencyMs` (ms): the time from an enemy's PERCEPTION edge (it first
 * acquires the player) to its first REACTION edge (it starts aiming/firing). Both are caller-bound
 * `fieldTimeline` series and both are RISING signals, so the existing edge primitives apply directly:
 *   - perception edge: a `TargetAcquiredCount` counter going 0→1, or a `CanSeePlayer` boolean false→true.
 *   - reaction edge:   a `StartedAimingCount` / `StartedFiringCount` counter going 0→1.
 *
 * This measures REACTION TIME GIVEN PERCEPTION — it is deliberately gated on a real perception edge, so
 * a scripted reaction that fires WITHOUT first perceiving the player cannot be measured as "AI reaction"
 * (the perception edge must exist AND precede the reaction). The honesty of the perception edge itself is
 * the fixture's responsibility (a true line-of-sight check, not a timer); this calculator refuses unless
 * the recorded perception edge is present and the reaction follows it.
 *
 * F1 invariant FIRST on BOTH series: refuse if EITHER is degraded (`unresolved||readError`). Then the
 * perception edge must exist (the enemy never perceived the player — e.g. no line of sight → refuse),
 * and honest-or-omit via `deriveEdgeLatency` (no reaction edge → refuse; reaction edge BEFORE the
 * perception edge — a PRE-ARMED reaction → refuse, never a clamped 0). MEASURE-ONLY.
 */
export function deriveEnemyReactionLatencyMs(
  perceptionSeries: SyncSeries | undefined | null,
  reactionSeries: SyncSeries | undefined | null,
): SyncDerivation {
  const perceptionRefusal = syncSeriesRefusal(perceptionSeries);
  if (perceptionRefusal !== null) return { ok: false, reason: `perception series — ${perceptionRefusal}` };
  const reactionRefusal = syncSeriesRefusal(reactionSeries);
  if (reactionRefusal !== null) return { ok: false, reason: `reaction series — ${reactionRefusal}` };
  const perceptionMs = firstRisingEdge(perceptionSeries as SyncSeries);
  if (perceptionMs === null) {
    return { ok: false, reason: "the enemy never perceived the player in-window (no perception edge — e.g. no line of sight)" };
  }
  const latency = deriveEdgeLatency(reactionSeries as SyncSeries, perceptionMs);
  if (latency === null) {
    const reaction = firstRisingEdge(reactionSeries as SyncSeries);
    if (reaction === null) {
      return { ok: false, reason: "the enemy never reacted in-window (no reaction edge after perception)" };
    }
    return { ok: false, reason: "the reaction edge precedes the perception edge (pre-armed reaction — non-causal, refused)" };
  }
  return { ok: true, latencyMs: latency };
}

// ── cover proof (line-of-sight + damage prevention) ───────────────────────────
//
// Cover proven GEOMETRICALLY and CAUSALLY, not as a tactical planner: an obstacle blocks line of
// sight AND prevents damage for an OTHERWISE-VALID shot (covered), and removing it restores line of
// sight AND damage under the SAME weapon conditions (exposed). The honesty crux is distinguishing a
// shot BLOCKED BY COVER from a shot that simply MISSED — the covered case must show every fired shot
// was blocked by the cover collider (BlockedShotCount == IncomingShotCount), not merely that no damage
// landed. `deriveCoverBlocksDamage` REFUSES on a missed shot, damage through cover, false cover
// (exposure dealt no damage), a missing LOS probe, or no shot fired.

/** The four caller-bound `fieldTimeline` series a cover capture provides (covered OR exposed). */
export interface CoverCaptureSeries {
  /** Shots fired at the target on a valid line (monotonic counter, rises per fire). */
  incomingShots: SyncSeries | undefined | null;
  /** Shots whose LOS-raycast struck the cover collider (monotonic counter) — a BLOCK, not a miss. */
  blockedShots: SyncSeries | undefined | null;
  /** Whether the shooter currently has line of sight to the target (bool). */
  lineOfSight: SyncSeries | undefined | null;
  /** Damage the target took (monotonic counter, rises per connecting shot). */
  damage: SyncSeries | undefined | null;
}

/** Outcome of the cover proof: proven (cover blocks LOS+damage, exposure restores both) OR a reason it is not. */
export type CoverProofResult = { ok: true } | { ok: false; reason: string };

/** Last sample value of a monotonic counter series (0 if empty). */
function finalCounterValue(series: SyncSeries): number {
  const ss = series.samples;
  if (!Array.isArray(ss) || ss.length === 0) return 0;
  const v = ss[ss.length - 1].value;
  return typeof v === "number" ? v : 0;
}

/** True iff any sample of a bool series is `true`. */
function isEverTrueSeries(series: SyncSeries): boolean {
  return Array.isArray(series.samples) && series.samples.some((s) => s.value === true);
}

/** F1 invariant over all four series of a capture; returns the refusal reason or null when clean. */
function coverSeriesRefusal(label: string, c: CoverCaptureSeries): string | null {
  const checks: Array<[string, SyncSeries | undefined | null]> = [
    ["incomingShots", c.incomingShots],
    ["blockedShots", c.blockedShots],
    ["lineOfSight", c.lineOfSight],
    ["damage", c.damage],
  ];
  for (const [name, series] of checks) {
    const refusal = syncSeriesRefusal(series);
    if (refusal !== null) return `${label} ${name} series — ${refusal}`;
  }
  return null;
}

/**
 * Cover proof — `coverBlocksDamage`: proven iff cover blocks BOTH line of sight AND damage for an
 * otherwise-valid shot, and removing the cover restores BOTH under the same weapon conditions.
 *
 * F1 invariant FIRST on all eight series. Then, refuse-don't-skip on each condition:
 *   COVERED (cover in place):
 *     - no shot fired                                   → refuse (nothing was tested)
 *     - line of sight was ever clear                    → refuse (cover did not block LOS)
 *     - not every shot was blocked by the cover collider→ refuse (a MISS is not a cover block)
 *     - damage was dealt                                → refuse (damage through cover)
 *   EXPOSED (cover removed):
 *     - no shot fired                                   → refuse
 *     - line of sight never became clear                → refuse (cover not actually removed)
 *     - any shot was still blocked                      → refuse (cover not removed)
 *     - no damage was dealt                             → refuse (FALSE COVER — the block was not cover)
 * Returns { ok: true } only when all hold (coverBlocksDamage = true). MEASURE-ONLY (a report row,
 * never a banded value).
 */
export function deriveCoverBlocksDamage(
  covered: CoverCaptureSeries,
  exposed: CoverCaptureSeries,
): CoverProofResult {
  const coveredRefusal = coverSeriesRefusal("covered", covered);
  if (coveredRefusal !== null) return { ok: false, reason: coveredRefusal };
  const exposedRefusal = coverSeriesRefusal("exposed", exposed);
  if (exposedRefusal !== null) return { ok: false, reason: exposedRefusal };

  // COVERED — the cover must block LOS, block every (valid) shot, and prevent all damage.
  const coveredShots = finalCounterValue(covered.incomingShots as SyncSeries);
  if (firstRisingEdge(covered.incomingShots as SyncSeries) === null) {
    return { ok: false, reason: "no shot was fired in the covered case (nothing was tested)" };
  }
  if (isEverTrueSeries(covered.lineOfSight as SyncSeries)) {
    return { ok: false, reason: "the covered case had line of sight (the cover did not block LOS)" };
  }
  const coveredBlocked = finalCounterValue(covered.blockedShots as SyncSeries);
  if (coveredBlocked !== coveredShots) {
    return {
      ok: false,
      reason: `not every covered shot was blocked by the cover (${coveredBlocked} of ${coveredShots}) — a miss is not a cover block`,
    };
  }
  // The covered target must show ZERO damage in absolute terms — not merely "no rise from baseline".
  // A non-zero baseline (e.g. an unreset target) is a degraded/ambiguous capture and refuses (fail-closed),
  // and this keeps the gate consistent with the artifact's "0 damage" claim.
  if (finalCounterValue(covered.damage as SyncSeries) !== 0) {
    return { ok: false, reason: "the covered target took damage (DamageTakenCount != 0) — damage through cover" };
  }

  // EXPOSED — removing the cover must restore LOS, leave shots unblocked, and let damage land.
  if (firstRisingEdge(exposed.incomingShots as SyncSeries) === null) {
    return { ok: false, reason: "no shot was fired in the exposed case (nothing was tested)" };
  }
  if (!isEverTrueSeries(exposed.lineOfSight as SyncSeries)) {
    return { ok: false, reason: "the exposed case never had line of sight (the cover was not actually removed)" };
  }
  if (finalCounterValue(exposed.blockedShots as SyncSeries) > 0) {
    return { ok: false, reason: "an exposed shot was still blocked (the cover was not removed)" };
  }
  if (firstRisingEdge(exposed.damage as SyncSeries) === null) {
    return { ok: false, reason: "false cover: the exposed shots dealt no damage — the covered block was not cover" };
  }

  return { ok: true };
}

// ── wave / objective proof (spawn N -> kill all -> objective-complete edge) ────
//
// The smallest wave/objective loop proven as a deterministic SEQUENCE, not pacing quality: a wave
// spawns N enemies, every one is killed (AliveCount returns to 0 after being positive, KillCount
// reaches N == SpawnCount), and only THEN does ObjectiveComplete rise. The honesty crux is that the
// completion edge is KILL-GATED, not a timer: `deriveWaveObjectiveComplete` REFUSES if the objective
// completed before kill-all, if enemies remain alive, if fewer than N were killed, or if no wave
// spawned. ObjectiveComplete rising on a timer (before AliveCount returns to 0) cannot green.

/** The four caller-bound `fieldTimeline` series a wave capture provides. */
export interface WaveCaptureSeries {
  /** Cumulative enemies spawned this wave (monotonic counter, rises on spawn). */
  spawnCount: SyncSeries | undefined | null;
  /** Enemies currently alive (rises to N on spawn, falls to 0 as they are killed). */
  aliveCount: SyncSeries | undefined | null;
  /** Cumulative enemies killed (monotonic counter, rises per kill). */
  killCount: SyncSeries | undefined | null;
  /** Objective completion (bool false->true, or a 0->1 counter). */
  objectiveComplete: SyncSeries | undefined | null;
}

/** Coerce a sync sample value to a number (bool → 0/1). */
function sampleNumber(value: number | boolean): number {
  return typeof value === "number" ? value : value === true ? 1 : 0;
}

/**
 * The `tMs` of the TRUE wave-clear: the first sample where the kill count has reached the full spawn
 * count (`KillCount >= spawnN`) AND no enemies are alive (`AliveCount === 0`) at the same tick. This is
 * the moment the whole wave is cleared — NOT merely the first intermediate dip to 0 (which a staggered /
 * multi-batch wave can hit before all N are dead). Returns null if that moment is never observed.
 */
function firstWaveClearMs(killCount: SyncSeries, aliveCount: SyncSeries, spawnN: number): number | null {
  const aliveByT = new Map<number, number>();
  for (const s of aliveCount.samples) aliveByT.set(s.tMs, sampleNumber(s.value));
  for (const s of killCount.samples) {
    if (sampleNumber(s.value) >= spawnN && aliveByT.get(s.tMs) === 0) {
      return s.tMs;
    }
  }
  return null;
}

/**
 * Wave/objective proof — `waveObjectiveComplete`: proven iff a wave of N enemies spawned, ALL N were
 * killed (AliveCount returned to 0 after being positive AND KillCount reached SpawnCount == N > 0), and
 * ObjectiveComplete rose AT/AFTER kill-all (never before).
 *
 * F1 invariant FIRST on all four series. Then refuse-don't-skip:
 *   - no wave spawned (SpawnCount stays 0)                          → refuse
 *   - no live enemies observed (AliveCount never rises above 0)      → refuse
 *   - fewer than N killed (KillCount != SpawnCount)                 → refuse (not all targets killed)
 *   - enemies remain alive (AliveCount never returned to 0)         → refuse
 *   - objective never completed (no ObjectiveComplete edge)         → refuse
 *   - objective completed BEFORE kill-all (timer, not kill-gated)   → refuse (the key review-risk guard)
 * Returns { ok: true } only when all hold. MEASURE-ONLY (a report row, never banded).
 */
export function deriveWaveObjectiveComplete(wave: WaveCaptureSeries): CoverProofResult {
  const checks: Array<[string, SyncSeries | undefined | null]> = [
    ["spawnCount", wave.spawnCount],
    ["aliveCount", wave.aliveCount],
    ["killCount", wave.killCount],
    ["objectiveComplete", wave.objectiveComplete],
  ];
  for (const [name, series] of checks) {
    const refusal = syncSeriesRefusal(series);
    if (refusal !== null) return { ok: false, reason: `${name} series — ${refusal}` };
  }

  const spawnN = finalCounterValue(wave.spawnCount as SyncSeries);
  if (spawnN <= 0 || firstRisingEdge(wave.spawnCount as SyncSeries) === null) {
    return { ok: false, reason: "no wave spawned (SpawnCount never rose) — nothing to complete" };
  }
  if (firstRisingEdge(wave.aliveCount as SyncSeries) === null) {
    return { ok: false, reason: "no live enemies were observed (AliveCount never rose) — spawn was not proven live" };
  }
  const killN = finalCounterValue(wave.killCount as SyncSeries);
  if (killN !== spawnN) {
    return { ok: false, reason: `not all spawned enemies were killed (KillCount ${killN} != SpawnCount ${spawnN})` };
  }
  if (finalCounterValue(wave.aliveCount as SyncSeries) !== 0) {
    return { ok: false, reason: "enemies remain alive at the end (AliveCount != 0) — the wave is not cleared" };
  }
  // Anchor kill-all to the TRUE wave-clear (KillCount == N AND AliveCount == 0), not the first
  // intermediate dip to 0 — so a staggered/multi-batch wave cannot complete before every enemy is dead.
  const killAllMs = firstWaveClearMs(wave.killCount as SyncSeries, wave.aliveCount as SyncSeries, spawnN);
  if (killAllMs === null) {
    return { ok: false, reason: "the wave was never cleared (KillCount never reached SpawnCount with AliveCount 0)" };
  }
  const completeMs = firstRisingEdge(wave.objectiveComplete as SyncSeries);
  if (completeMs === null) {
    return { ok: false, reason: "the objective never completed (no ObjectiveComplete edge)" };
  }
  if (completeMs < killAllMs) {
    return {
      ok: false,
      reason: `the objective completed (${completeMs}ms) BEFORE kill-all (${killAllMs}ms) — timer-driven, not kill-gated`,
    };
  }
  return { ok: true };
}

// ── hold-channel proof (hold-to-loot / hold-to-extract timing + interrupt-on-damage) ──
//
// The DEFINING extraction-shooter mechanic, and a fully general one: a CHANNELED action the
// player must HOLD to completion — hold-to-loot, hold-to-extract, hold-to-revive, a charged
// shot/ability. Two honest-or-refuse proofs over caller-bound `fieldTimeline` series, both
// dimension-agnostic (they count edges/levels on sampled scalar fields, so 2D vs 3D is moot):
//
//   holdChannelDurationMs   = the time from the input-DOWN edge to the COMPLETE edge (progress
//                             reaches the declared target while the input stays held). It REFUSES
//                             a released-early / interrupted / never-completing channel — never a
//                             fabricated duration off a partial fill (the honesty crux: a hold
//                             that only fills partway has a peak, but that peak is NOT completion).
//   holdInterruptOnDamage   = whether progress CANCELS/RESETS after a damage edge while the channel
//                             is active (the channel is interruptible — the extraction-tension knob).
//                             Reports the MEASURED boolean WITH the progress-before vs progress-after
//                             evidence; refuses when nothing was tested (no damage edge / no active
//                             channel / degraded series), never a fabricated outcome.
//
// Like the cover/wave proofs these are MEASURE-ONLY (a report row / measured value, never a banded
// gate value unless a GenreContract promotes them) and re-derivable from a raw sampled transcript.

/** The two caller-bound `fieldTimeline` series a hold-channel capture provides. */
export interface HoldChannelSeries {
  /** Whether the channel input is currently held (bool false→true on press, true→false on release). */
  inputHeld: SyncSeries | undefined | null;
  /** Channel progress — a numeric series rising baseline→target while held (0..1 normalized, or 0..N). */
  progress: SyncSeries | undefined | null;
}

/** The peak numeric progress value AT OR BEFORE `tMs` (null if no numeric sample in range). */
function maxProgressAtOrBefore(series: SyncSeries, tMs: number): number | null {
  let peak: number | null = null;
  for (const s of series.samples) {
    if (s.tMs <= tMs && typeof s.value === "number") {
      peak = peak === null ? s.value : Math.max(peak, s.value);
    }
  }
  return peak;
}

/**
 * The CONTEMPORANEOUS numeric value at `tMs` — the value of the LATEST sample whose `tMs` is at or
 * before `tMs` (null if none). Unlike the peak/min reducers this reads the value AT the edge, so a
 * stale earlier high-water mark cannot masquerade as the value present when the edge fired. (Assumes
 * time-ordered samples, like every other calculator in this module.)
 */
function valueAtOrBefore(series: SyncSeries, tMs: number): number | null {
  let val: number | null = null;
  for (const s of series.samples) {
    if (s.tMs <= tMs && typeof s.value === "number") val = s.value; // latest ≤ tMs wins
  }
  return val;
}

/**
 * Encoding-agnostic "is this input held?" — true for a bool `true` OR a numeric value strictly above
 * zero (a held-duration counter / analog amount). The JS gotcha this guards: `0 === false` is FALSE,
 * so a `=== false` release check is silently bypassed for a NUMERIC inputHeld, fabricating a sustained
 * hold. `firstRisingEdge` is already numeric-aware; this is the OTHER encoding-dependent check.
 */
function isHeldValue(value: number | boolean): boolean {
  return value === true || (typeof value === "number" && value > 0);
}

/**
 * Hold-channel metric — `holdChannelDurationMs` (ms): the duration of a channeled hold-to-complete
 * action, from the input-DOWN edge to the moment progress first reaches the declared `targetProgress`
 * while the input is held CONTINUOUSLY. The signals are two caller-bound `fieldTimeline` series: a
 * boolean `inputHeld` (false→true on press) and a numeric `progress` that rises baseline→target.
 *
 * `targetProgress` is the EXPLICIT completion threshold the contract declares (e.g. 1.0 for a 0..1
 * fill, or N for a 0..N counter). It is required and load-bearing: completion is "progress reached the
 * declared target", NOT "progress reached its own peak" — otherwise a hold released partway would
 * fabricate a completion at its partial peak. This mirrors the cover/wave proofs' refuse-don't-skip
 * discipline.
 *
 * F1 invariant FIRST on both series. Then honest-or-refuse (never a fabricated duration):
 *   - no valid positive targetProgress                                   → refuse
 *   - the channel input was never held (no inputHeld rising edge)        → refuse (nothing channeled)
 *   - progress was already ≥ target at input-down                        → refuse (no channel to measure)
 *   - progress never reached the target                                  → refuse (released early / interrupted)
 *   - the target was reached BEFORE input-down (non-causal ordering)     → refuse
 *   - the input was released before completion                           → refuse (no sustained hold)
 *   - progress dropped mid-channel (non-monotonic — a reset/interrupt)   → refuse (use holdInterruptOnDamage)
 * Returns `{ ok: true, latencyMs: durationMs }` only when a clean, sustained, monotonic channel
 * completed. MEASURE-ONLY.
 */
export function deriveHoldChannelDuration(
  channel: HoldChannelSeries,
  targetProgress: number,
): SyncDerivation {
  const inputRefusal = syncSeriesRefusal(channel.inputHeld);
  if (inputRefusal !== null) return { ok: false, reason: `inputHeld series — ${inputRefusal}` };
  const progressRefusal = syncSeriesRefusal(channel.progress);
  if (progressRefusal !== null) return { ok: false, reason: `progress series — ${progressRefusal}` };
  if (!isFiniteNumber(targetProgress) || targetProgress <= 0) {
    return { ok: false, reason: "no valid completion target (targetProgress must be a positive finite number)" };
  }
  const inputHeld = channel.inputHeld as SyncSeries;
  const progress = channel.progress as SyncSeries;
  if (progress.samples.length === 0) {
    return { ok: false, reason: "progress series has no samples" };
  }
  // INPUT-DOWN edge: the channel must be actively held (bound, not assumed).
  const inputDownMs = firstRisingEdge(inputHeld);
  if (inputDownMs === null) {
    return { ok: false, reason: "the channel input was never held (no inputHeld rising edge) — nothing was channeled" };
  }
  // Progress must actually RISE during the hold (not already complete at the press).
  const progressAtDown = maxProgressAtOrBefore(progress, inputDownMs) ?? 0;
  if (progressAtDown >= targetProgress) {
    return { ok: false, reason: "progress was already at/above the target at input-down — no channel to measure" };
  }
  // COMPLETE edge: the first sample whose progress reaches the declared target.
  let completeMs: number | null = null;
  for (const s of progress.samples) {
    if (typeof s.value === "number" && s.value >= targetProgress) {
      completeMs = s.tMs;
      break;
    }
  }
  if (completeMs === null) {
    return { ok: false, reason: "the channel never completed (progress never reached the target) — released early / interrupted" };
  }
  // The completion must FOLLOW the input-down (a fill that preceded the hold is non-causal).
  if (completeMs < inputDownMs) {
    return { ok: false, reason: "progress reached the target BEFORE input-down (non-causal — the fill did not follow the hold)" };
  }
  // The input must be held CONTINUOUSLY from down to complete — a release before completion means the
  // channel did not complete under a sustained hold (ambiguous duration), so refuse. Held-ness is
  // tested ENCODING-AGNOSTICALLY (isHeldValue): a numeric inputHeld releasing to 0 reads false here,
  // where a `=== false` check would miss it (0 !== false) and fabricate a duration.
  for (const s of inputHeld.samples) {
    if (s.tMs > inputDownMs && s.tMs <= completeMs && !isHeldValue(s.value)) {
      return { ok: false, reason: "the input was released before completion — the channel did not complete under a sustained hold" };
    }
  }
  // Progress must rise MONOTONICALLY (non-decreasing) across the measured window. A mid-channel dip is
  // an interrupt/reset, not a clean fill — that case belongs to deriveHoldInterruptOnDamage, not here.
  let prev = -Infinity;
  for (const s of progress.samples) {
    if (s.tMs >= inputDownMs && s.tMs <= completeMs && typeof s.value === "number") {
      if (s.value < prev) {
        return { ok: false, reason: "progress dropped mid-channel (non-monotonic) — the channel reset before completing" };
      }
      prev = s.value;
    }
  }
  return { ok: true, latencyMs: completeMs - inputDownMs };
}

/**
 * Outcome of the interrupt-on-damage proof: a MEASURED `interrupted` boolean WITH the progress-before
 * vs progress-after evidence (`ok: true`), OR an honest reason nothing could be measured (`ok: false`).
 * Unlike a pure pass/fail proof, `interrupted: false` is a VALID measurement (a channel that survived
 * the damage), not a refusal — so the boolean rides alongside `ok: true`.
 */
export type HoldInterruptResult =
  | {
      ok: true;
      /** True iff progress reset meaningfully toward baseline in the bounded post-damage window. */
      interrupted: boolean;
      /** Contemporaneous progress at the damage edge (the value the damage acted on). */
      progressBeforeDamage: number;
      /** Lowest progress in the post-damage window before recovery (~baseline on a true reset). */
      progressAfterDamage: number;
      /** The tMs of the damage edge the outcome is measured against. */
      damageMs: number;
    }
  | { ok: false; reason: string };

/**
 * A post-damage trough must fall AT LEAST this fraction of the way from the pre-damage value toward
 * the progress baseline to count as a reset. Chosen well above sampling jitter (a sub-percent wobble
 * on a surviving channel reads `interrupted: false`) yet far below a real cancel (which drops most of
 * the way to baseline), so a meaningful reset is required — never a fabricated interrupt off noise.
 */
export const HOLD_INTERRUPT_RESET_FRACTION = 0.5;

/**
 * Hold-channel metric — `holdInterruptOnDamage` (boolean): does taking damage while channeling CANCEL
 * the channel? Both signals are caller-bound `fieldTimeline` series: the numeric `progress` (rising
 * while held) and a `damage` event (a 0→1 counter or false→true bool — the moment the player took a hit).
 *
 * The honesty crux is NOT charging an unrelated drop to the damage edge:
 *   - `progressBeforeDamage` is the CONTEMPORANEOUS value at the damage edge (the latest sample ≤
 *     damageMs), NOT a stale global peak — so an already-ended channel cannot be scored as active.
 *   - the reset is measured only in a BOUNDED WINDOW from the damage edge to the next RECOVERY /
 *     COMPLETION (the first sample that returns to ≥ the pre-damage value). A drop AFTER that — the
 *     normal "loot banked → progress bar tears down to 0" teardown of a channel that COMPLETED — is
 *     outside the window and never counted as an interrupt.
 *   - the trough must fall ≥ HOLD_INTERRUPT_RESET_FRACTION toward baseline to count (no jitter flags).
 *
 * F1 invariant FIRST on both series. Then refuse (ok: false) only when nothing could be tested — never
 * a fabricated outcome:
 *   - no damage event fired (no damage rising edge)                          → refuse (untested)
 *   - no progress sample at/before the damage edge                           → refuse (no pre value)
 *   - the contemporaneous value at the damage edge is at baseline (≤ start)  → refuse (no active channel)
 *   - no progress sample after the damage edge                               → refuse (cannot observe)
 * Otherwise returns `ok: true` with the MEASURED `interrupted` boolean and the before/after evidence:
 *   - progress reset toward baseline before recovering   → interrupted: true
 *   - progress continued/completed (recovered to ≥ before, or only jittered) → interrupted: false
 * MEASURE-ONLY: a report row carrying its own evidence, never a banded value here.
 */
export function deriveHoldInterruptOnDamage(
  progressSeries: SyncSeries | undefined | null,
  damageSeries: SyncSeries | undefined | null,
): HoldInterruptResult {
  const progressRefusal = syncSeriesRefusal(progressSeries);
  if (progressRefusal !== null) return { ok: false, reason: `progress series — ${progressRefusal}` };
  const damageRefusal = syncSeriesRefusal(damageSeries);
  if (damageRefusal !== null) return { ok: false, reason: `damage series — ${damageRefusal}` };
  const progress = progressSeries as SyncSeries;
  const damage = damageSeries as SyncSeries;
  if (progress.samples.length === 0) {
    return { ok: false, reason: "progress series has no samples" };
  }
  // A damage event must have fired — otherwise interruptibility was never exercised.
  const damageMs = firstRisingEdge(damage);
  if (damageMs === null) {
    return { ok: false, reason: "no damage event fired (no damage rising edge) — interruptibility was not tested" };
  }
  // The pre-damage value is the CONTEMPORANEOUS reading at the damage edge — not the global peak.
  const before = valueAtOrBefore(progress, damageMs);
  if (before === null) {
    return { ok: false, reason: "no progress sample at/before the damage edge (cannot read the pre-damage value)" };
  }
  // The channel must be ACTIVE AT the damage edge: the contemporaneous value must be strictly above the
  // progress baseline. A stale channel that already rose and fell back (or never rose by the edge) is
  // NOT interruptible — there is nothing in flight for the damage to cancel.
  const baselineVal = typeof progress.samples[0].value === "number" ? progress.samples[0].value : 0;
  if (!(before > baselineVal)) {
    return { ok: false, reason: "no active channel at the damage edge (progress is at baseline when damage landed) — nothing to interrupt" };
  }
  // Bounded window: scan from the damage edge to the first RECOVERY/COMPLETION (progress returns to ≥
  // the pre-damage value). The trough is the lowest progress inside that window. A later teardown after
  // the channel completed/recovered is outside the window and never charged to the damage.
  let trough: number | null = null;
  let firstPost: number | null = null;
  for (const s of progress.samples) {
    if (s.tMs <= damageMs || typeof s.value !== "number") continue;
    if (firstPost === null) firstPost = s.value;
    if (s.value >= before) break; // recovery/completion — the window closes here
    trough = trough === null ? s.value : Math.min(trough, s.value);
  }
  if (firstPost === null) {
    return { ok: false, reason: "no progress sample after the damage edge (cannot observe a reset)" };
  }
  // A meaningful reset: the trough fell ≥ HOLD_INTERRUPT_RESET_FRACTION of the way toward baseline.
  const resetThreshold = before - HOLD_INTERRUPT_RESET_FRACTION * (before - baselineVal);
  const interrupted = trough !== null && trough <= resetThreshold;
  return {
    ok: true,
    interrupted,
    progressBeforeDamage: before,
    progressAfterDamage: trough !== null ? trough : firstPost,
    damageMs,
  };
}

// ── extraction win/loss proofs (reach-zone → dwell/bank, lose-on-death) ───────────────
//
// The OTHER half of the extraction-shooter core loop (dogfood findings RCL-G02 + RCL-G07),
// the INVERSE of the wave/objective proof: a wave is spawn-N → kill-all → clear, whereas an
// extraction is reach-a-zone → DWELL there (hold a channel to completion) → BANK the loot, and
// the loss rule is the carried stash is wiped if the player dies before banking. Two honest-or-
// refuse proofs over caller-bound `fieldTimeline` series, both dimension-agnostic (they count
// edges/levels on sampled scalar fields, so 2D vs 3D is moot):
//
//   zoneObjectiveComplete = the win path proven as a CAUSAL SEQUENCE, not a timer: the player
//                           ENTERED the extraction zone (inZone rising edge), the dwell/hold
//                           reached the declared target while inZone STAYED true (no leaving the
//                           zone mid-extraction), and only THEN did banked flip/increment. It
//                           REFUSES never-entered, left-zone-before-complete (an interrupted
//                           extraction), hold-never-completed, never-banked, and non-causal
//                           ordering (banked before the dwell finished / dwell before entry).
//   stashLossOnDeath      = whether the carried stash is wiped on death — on the playerDead rising
//                           edge the stash drops to baseline. Mirrors the hold-interrupt's
//                           contemporaneous-value + meaningful-drop discipline: the pre-death value
//                           is read AT the death edge (not a stale peak), and the drop is measured
//                           in a bounded post-death window (a later re-loot after respawn is never
//                           charged to this death). Reports the MEASURED boolean WITH evidence;
//                           refuses when nothing could be tested.
//
// Like the cover/wave/hold-channel proofs these are MEASURE-ONLY (a report row / measured outcome,
// never a banded gate value unless a GenreContract promotes them) and re-derivable from a raw
// sampled transcript.

/** The three caller-bound `fieldTimeline` series a zone-extraction capture provides. */
export interface ZoneObjectiveSeries {
  /** Whether the player is currently inside the extraction zone (bool false→true on entry). */
  inZone: SyncSeries | undefined | null;
  /** Dwell/hold progress — a numeric series rising baseline→target while in the zone (0..1 or 0..N). */
  holdProgress: SyncSeries | undefined | null;
  /** Loot banked — a bool false→true OR a 0→N counter that flips/increments on a successful extract. */
  banked: SyncSeries | undefined | null;
}

/**
 * Outcome of the zone-extraction proof: the measured win sequence WITH evidence (`ok: true`), OR an
 * honest reason it could not be proven (`ok: false`). Unlike a bare boolean it carries the three edge
 * times so the report can show the causal chain (entered → hold completed → banked).
 */
export type ZoneObjectiveResult =
  | {
      ok: true;
      /** The tMs the player first entered the zone (inZone rising edge). */
      enteredMs: number;
      /** The tMs the dwell/hold first reached the declared target while in the zone. */
      holdCompleteMs: number;
      /** The tMs the loot was banked (banked rising edge), at/after hold completion. */
      bankedMs: number;
      /** The dwell duration (holdCompleteMs − enteredMs), ms. */
      dwellMs: number;
    }
  | { ok: false; reason: string };

/**
 * Zone-extraction proof — `zoneObjectiveComplete`: proven iff the player ENTERED the extraction zone,
 * the dwell/hold reached the declared `holdTarget` while inZone stayed CONTINUOUSLY true, and banked
 * flipped/incremented AT/AFTER the dwell completed (never before).
 *
 * `holdTarget` is the EXPLICIT dwell-completion threshold the contract declares (e.g. 1.0 for a 0..1
 * fill, or N for a 0..N counter). It is required and load-bearing: completion is "progress reached the
 * declared target", NOT "progress reached its own peak" — otherwise a partial dwell would fabricate a
 * completion at its partial peak (mirrors deriveHoldChannelDuration).
 *
 * F1 invariant FIRST on all three series. Then refuse-don't-skip (never a fabricated outcome):
 *   - no valid positive holdTarget                                    → refuse
 *   - the player never entered the zone (no inZone rising edge)       → refuse (nothing extracted)
 *   - progress was already ≥ target at entry                         → refuse (no dwell to measure)
 *   - the dwell never completed (progress never reached the target)  → refuse (interrupted / too short)
 *   - the dwell completed BEFORE entry (non-causal ordering)         → refuse
 *   - the player LEFT the zone before the dwell completed            → refuse (INTERRUPTED extraction)
 *   - the loot was never banked (no banked rising edge)              → refuse (extraction not finished)
 *   - banked rose BEFORE the dwell completed (non-causal)            → refuse (banked without dwelling)
 * Returns `{ ok: true, ... }` with the entry/complete/bank edge times only when all hold. MEASURE-ONLY.
 */
export function deriveZoneObjectiveComplete(
  zone: ZoneObjectiveSeries,
  holdTarget: number,
): ZoneObjectiveResult {
  const checks: Array<[string, SyncSeries | undefined | null]> = [
    ["inZone", zone.inZone],
    ["holdProgress", zone.holdProgress],
    ["banked", zone.banked],
  ];
  for (const [name, series] of checks) {
    const refusal = syncSeriesRefusal(series);
    if (refusal !== null) return { ok: false, reason: `${name} series — ${refusal}` };
  }
  if (!isFiniteNumber(holdTarget) || holdTarget <= 0) {
    return { ok: false, reason: "no valid completion target (holdTarget must be a positive finite number)" };
  }
  const inZone = zone.inZone as SyncSeries;
  const progress = zone.holdProgress as SyncSeries;
  const banked = zone.banked as SyncSeries;
  if (progress.samples.length === 0) {
    return { ok: false, reason: "holdProgress series has no samples" };
  }

  // ENTRY edge: the player must actually enter the zone (bound, not assumed).
  const enteredMs = firstRisingEdge(inZone);
  if (enteredMs === null) {
    return { ok: false, reason: "the player never entered the extraction zone (no inZone rising edge) — nothing was extracted" };
  }
  // Progress must rise DURING the dwell (not already complete at entry).
  const progressAtEntry = maxProgressAtOrBefore(progress, enteredMs) ?? 0;
  if (progressAtEntry >= holdTarget) {
    return { ok: false, reason: "dwell progress was already at/above the target at zone entry — no dwell to measure" };
  }
  // COMPLETE edge: the first sample whose dwell progress reaches the declared target.
  let holdCompleteMs: number | null = null;
  for (const s of progress.samples) {
    if (typeof s.value === "number" && s.value >= holdTarget) {
      holdCompleteMs = s.tMs;
      break;
    }
  }
  if (holdCompleteMs === null) {
    return { ok: false, reason: "the dwell never completed (progress never reached the target) — interrupted / too short an extraction" };
  }
  // The completion must FOLLOW entry (a fill that preceded the entry is non-causal).
  if (holdCompleteMs < enteredMs) {
    return { ok: false, reason: "the dwell completed BEFORE zone entry (non-causal — the fill did not follow the entry)" };
  }
  // The player must stay in the zone CONTINUOUSLY from entry to completion — leaving the zone mid-dwell
  // is an INTERRUPTED extraction, not a completed one. Tested ENCODING-AGNOSTICALLY (isHeldValue): a
  // numeric inZone returning to 0 reads false here where a `=== false` check would miss it (0 !== false).
  for (const s of inZone.samples) {
    if (s.tMs > enteredMs && s.tMs <= holdCompleteMs && !isHeldValue(s.value)) {
      return { ok: false, reason: "the player left the zone before the dwell completed — interrupted extraction" };
    }
  }
  // BANK edge: the loot must actually be banked, and AT/AFTER the dwell completed (never before — a bank
  // that preceded completion would mean the loot was secured without finishing the dwell, non-causal).
  const bankedMs = firstRisingEdge(banked);
  if (bankedMs === null) {
    return { ok: false, reason: "the loot was never banked (no banked rising edge) — the extraction did not finish" };
  }
  if (bankedMs < holdCompleteMs) {
    return {
      ok: false,
      reason: `the loot was banked (${bankedMs}ms) BEFORE the dwell completed (${holdCompleteMs}ms) — non-causal (banked without dwelling)`,
    };
  }
  return { ok: true, enteredMs, holdCompleteMs, bankedMs, dwellMs: holdCompleteMs - enteredMs };
}

/**
 * Outcome of the lose-on-death proof: a MEASURED `lostOnDeath` boolean WITH the stash-before vs
 * stash-after evidence (`ok: true`), OR an honest reason nothing could be measured (`ok: false`).
 * Like the interrupt proof, `lostOnDeath: false` is a VALID measurement (the rule was NOT applied —
 * a BUG the rule forbids, surfaced honestly), not a refusal — so the boolean rides alongside `ok: true`.
 */
export type StashLossResult =
  | {
      ok: true;
      /** True iff the stash dropped to baseline in the bounded post-death window (the loot was wiped). */
      lostOnDeath: boolean;
      /** Contemporaneous stash AT the death edge (the loot the player was carrying when they died). */
      stashBeforeDeath: number;
      /** Lowest stash in the post-death window before any re-loot (~baseline iff the rule applied). */
      stashAfterDeath: number;
      /** The tMs of the death edge the outcome is measured against. */
      deathMs: number;
    }
  | { ok: false; reason: string };

/**
 * Stash-loss metric — `stashLossOnDeath` (boolean): does dying WIPE the carried stash? Both signals
 * are caller-bound `fieldTimeline` series: a numeric `stash` (rises as loot is picked up, drops on a
 * wipe) and a `playerDead` event (false→true bool, or a 0→1 death counter).
 *
 * The honesty crux (mirrors deriveHoldInterruptOnDamage) is NOT charging an unrelated change to the
 * death edge:
 *   - `stashBeforeDeath` is the CONTEMPORANEOUS value AT the death edge (the latest sample ≤ deathMs),
 *     NOT a stale global peak — so a stash that already emptied earlier cannot be scored as carried.
 *   - the drop is measured only in a BOUNDED WINDOW from the death edge to the first RE-LOOT (the first
 *     post-death sample that returns to ≥ the pre-death value, e.g. picking loot back up after respawn).
 *     A rise after that is outside the window and never counted.
 *   - "lose everything" means the stash returned to its baseline (the at-capture-start value); a partial
 *     dip that does not reach baseline is NOT a full wipe (lostOnDeath: false).
 *
 * F1 invariant FIRST on both series. Then refuse (ok: false) only when nothing could be tested — never
 * a fabricated outcome:
 *   - no death event fired (no playerDead rising edge)                       → refuse (untested)
 *   - no stash sample at/before the death edge                              → refuse (no pre value)
 *   - the contemporaneous stash at death is at baseline (≤ start)           → refuse (no loot was carried)
 *   - no stash sample after the death edge                                  → refuse (cannot observe)
 * Otherwise returns `ok: true` with the MEASURED `lostOnDeath` boolean and the before/after evidence:
 *   - the stash dropped to baseline after death           → lostOnDeath: true  (rule applied)
 *   - the stash survived the death (unchanged / partial)  → lostOnDeath: false (the rule was NOT applied)
 * MEASURE-ONLY: a report row carrying its own evidence, never a banded value here.
 */
export function deriveStashLossOnDeath(
  stashSeries: SyncSeries | undefined | null,
  deathSeries: SyncSeries | undefined | null,
): StashLossResult {
  const stashRefusal = syncSeriesRefusal(stashSeries);
  if (stashRefusal !== null) return { ok: false, reason: `stash series — ${stashRefusal}` };
  const deathRefusal = syncSeriesRefusal(deathSeries);
  if (deathRefusal !== null) return { ok: false, reason: `playerDead series — ${deathRefusal}` };
  const stash = stashSeries as SyncSeries;
  const death = deathSeries as SyncSeries;
  if (stash.samples.length === 0) {
    return { ok: false, reason: "stash series has no samples" };
  }
  // A death must have fired — otherwise the lose-on-death rule was never exercised.
  const deathMs = firstRisingEdge(death);
  if (deathMs === null) {
    return { ok: false, reason: "no death event fired (no playerDead rising edge) — lose-on-death was not tested" };
  }
  // The pre-death stash is the CONTEMPORANEOUS reading AT the death edge — not a stale global peak.
  const before = valueAtOrBefore(stash, deathMs);
  if (before === null) {
    return { ok: false, reason: "no stash sample at/before the death edge (cannot read the pre-death stash)" };
  }
  // The player must have been CARRYING loot at death: the contemporaneous stash must be strictly above
  // the stash baseline. An already-empty stash (or one that never rose by the death edge) has nothing to
  // lose, so the rule was not exercised — refuse rather than fabricate a meaningless "lost: false".
  const baselineVal = typeof stash.samples[0].value === "number" ? stash.samples[0].value : 0;
  if (!(before > baselineVal)) {
    return { ok: false, reason: "the stash was at baseline when the player died (no loot was carried) — lose-on-death was not exercised" };
  }
  // Bounded window: scan from the death edge to the first RE-LOOT (stash returns to ≥ the pre-death
  // value, e.g. picking loot back up after respawn). The trough is the lowest stash inside that window;
  // a later rise after re-looting is outside the window and never charged to this death.
  let trough: number | null = null;
  let firstPost: number | null = null;
  for (const s of stash.samples) {
    if (s.tMs <= deathMs || typeof s.value !== "number") continue;
    if (firstPost === null) firstPost = s.value;
    if (s.value >= before) break; // re-loot / recovery — the window closes here
    trough = trough === null ? s.value : Math.min(trough, s.value);
  }
  if (firstPost === null) {
    return { ok: false, reason: "no stash sample after the death edge (cannot observe the loss)" };
  }
  // "Lose everything" = the stash returned to baseline. A small float tolerance guards counter jitter;
  // a partial dip that never reaches baseline is NOT a full wipe (lostOnDeath: false).
  const stashAfterDeath = trough !== null ? trough : firstPost;
  const lostOnDeath = trough !== null && trough <= baselineVal + 1e-9;
  return {
    ok: true,
    lostOnDeath,
    stashBeforeDeath: before,
    stashAfterDeath,
    deathMs,
  };
}

// ── extraction-pressure substrate (heat ramp + auto-aim acquisition + sprint profile) ──
//
// Three feel metrics for the EXTRACTION-PRESSURE knobs that make a raid tense (dogfood findings
// RCL-G03/G04/G05). They sit alongside the win/loss + hold-channel proofs above and share the same
// discipline: F1 refuse-don't-skip FIRST, shared edge primitives, honest-or-omit (a measured value
// must correspond to a REAL edge/window sequence, never fabricated), MEASURE-ONLY (a report row, not
// a banded gate value unless a GenreContract promotes them, and NOT registered in REDERIVABLE_METRICS).
//
//   threatRampSlope      = the difficulty curve: as run-time advances the spawn RATE must rise
//                          monotonically (inter-spawn intervals strictly shrink), and the grace
//                          window before the first spawn must be respected. REFUSES a flat rate, a
//                          non-monotonic rate, a grace violation, too few spawns, or a degraded series.
//   autoAimAcquisition   = did the auto-aim lock the RIGHT enemy for the declared priority rule
//                          (nearest / lowest-hp / highest-threat)? This proves the TARGETING decision,
//                          not merely that the shot followed the current aim. A WRONG lock is an honest
//                          MEASURED MISS (`correct: false`), NOT a refusal; refusal is reserved for
//                          "could not decide" (no candidates / no lock / an unresolved tie / degraded).
//   sprintProfile        = the traversal-pressure knob: the sprint speed MULTIPLIER (sprint/base), the
//                          sustained DURATION the boost holds, and the COOLDOWN lockout before the boost
//                          is available again. Read from the BOOST WINDOWS in the planar-speed series
//                          (the physical evidence) and gated on a real sprint-input edge. REFUSES no
//                          sprint engaged / no base speed / no observed boost / no second boost / degraded.

/**
 * Outcome of the heat-ramp proof: the measured ramp WITH its monotonicity evidence (`ok: true`), OR an
 * honest reason it could not be proven (`ok: false`). `slopePerSec` is the least-squares slope of the
 * instantaneous spawn rate (spawns/s) against run-time (s) — positive iff the rate genuinely climbs.
 */
export type ThreatRampResult =
  | {
      ok: true;
      /** Least-squares slope of instantaneous spawn rate (spawns/s) vs run-time (s) — > 0 for a ramp. */
      slopePerSec: number;
      /** The number of observed spawn edges the ramp was measured over. */
      spawnCount: number;
      /** Inter-spawn intervals (ms), STRICTLY DECREASING for a rising rate (the monotonicity evidence). */
      intervalsMs: number[];
      /** Instantaneous spawn rates (spawns/s = 1000/interval), STRICTLY INCREASING — rate vs run-time. */
      ratesPerSec: number[];
      /** Always true here — the result only returns ok when the rate rose monotonically. */
      monotonic: true;
      /** The grace window (ms) that was enforced (no spawn permitted before it). */
      graceMs: number;
    }
  | { ok: false; reason: string };

/** Least-squares slope of `ys` against `xs` (equal length ≥ 2, finite); null if undefined (no x-spread). */
function leastSquaresSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (!(den > 0)) return null; // no spread in x — slope is undefined
  return num / den;
}

/**
 * Heat-ramp metric — `threatRampSlope`: proven iff the spawn RATE rises MONOTONICALLY as run-time
 * advances (a difficulty curve) AND the grace window is respected (no spawn before `graceMs`). The
 * signal is a single caller-bound `fieldTimeline` series — a monotonic spawn-count counter (rises per
 * spawn) OR a spawn-event signal; `eventEdges` extracts the spawn times either way.
 *
 * A rising rate is proven from the INTER-SPAWN INTERVALS: a climbing rate means strictly SHRINKING
 * intervals (rate = 1000/interval). The reported `slopePerSec` is the least-squares slope of the
 * instantaneous rate vs run-time — surfaced as the curve's steepness, while the strict-monotonic guard
 * is what actually gates the proof (a positive endpoint slope over a non-monotonic middle is refused).
 *
 * F1 invariant FIRST. Then refuse-don't-skip (never a fabricated ramp):
 *   - degraded series (unresolved / readError)                       → refuse (F1)
 *   - no spawns observed                                             → refuse (nothing ramped)
 *   - a spawn fired before the grace window ended                   → refuse (grace violated)
 *   - fewer than 3 spawns (< 2 intervals — no rate CHANGE to fit)    → refuse (too few to establish a ramp)
 *   - a non-positive interval (non-causal / duplicate edge)         → refuse (degraded ordering)
 *   - all intervals equal (a constant cadence)                      → refuse (FLAT rate, no difficulty ramp)
 *   - intervals not strictly decreasing                             → refuse (NON-MONOTONIC rate)
 * Returns `{ ok: true, slopePerSec, ... }` with the intervals/rates evidence only when all hold. MEASURE-ONLY.
 */
export function deriveThreatRampSlope(
  spawnSeries: SyncSeries | undefined | null,
  graceMs = 0,
): ThreatRampResult {
  const refusal = syncSeriesRefusal(spawnSeries);
  if (refusal !== null) return { ok: false, reason: `spawn series — ${refusal}` };
  const series = spawnSeries as SyncSeries;
  if (!isFiniteNumber(graceMs) || graceMs < 0) {
    return { ok: false, reason: "invalid grace window (graceMs must be a finite, non-negative number)" };
  }

  const edges = eventEdges(series); // spawn times (counter increments / false→true transitions)
  if (edges.length === 0) {
    return { ok: false, reason: "no spawns were observed (the spawn series never rose) — nothing ramped" };
  }
  // GRACE: no spawn may fire before the grace window ends (a difficulty curve gives the player a beat).
  if (edges[0] < graceMs) {
    return {
      ok: false,
      reason: `a spawn fired at ${edges[0]}ms, before the grace window ended (${graceMs}ms) — grace violated`,
    };
  }
  if (edges.length < 3) {
    return {
      ok: false,
      reason: `only ${edges.length} spawn(s) observed — need ≥3 (≥2 intervals) to establish a rising rate`,
    };
  }

  const intervalsMs: number[] = [];
  for (let i = 1; i < edges.length; i += 1) {
    const dt = edges[i] - edges[i - 1];
    if (!(dt > 0)) {
      return { ok: false, reason: "a non-positive inter-spawn interval (duplicate / non-causal edge) — degraded ordering" };
    }
    intervalsMs.push(dt);
  }
  // FLAT: a constant cadence is not a difficulty ramp (distinct from non-monotonic so the reason is precise).
  const allEqual = intervalsMs.every((d) => Math.abs(d - intervalsMs[0]) <= 1e-9);
  if (allEqual) {
    return { ok: false, reason: "the spawn rate is flat (constant inter-spawn interval) — no difficulty ramp" };
  }
  // MONOTONIC: a rising rate ⇔ STRICTLY shrinking intervals; any interval ≥ its predecessor breaks the ramp.
  for (let i = 1; i < intervalsMs.length; i += 1) {
    if (!(intervalsMs[i] < intervalsMs[i - 1])) {
      return {
        ok: false,
        reason: `the spawn rate did not rise monotonically (interval ${intervalsMs[i]}ms ≥ the previous ${intervalsMs[i - 1]}ms)`,
      };
    }
  }

  // Rate point i is realized at the END of interval i (edges[i+1]); rate = spawns/s = 1000/intervalMs.
  const ratesPerSec = intervalsMs.map((d) => 1000 / d);
  const timesSec = edges.slice(1).map((t) => t / 1000);
  const slopePerSec = leastSquaresSlope(timesSec, ratesPerSec);
  if (slopePerSec === null) {
    return { ok: false, reason: "could not fit a ramp slope (no spread in spawn times)" };
  }
  return {
    ok: true,
    slopePerSec,
    spawnCount: edges.length,
    intervalsMs,
    ratesPerSec,
    monotonic: true,
    graceMs,
  };
}

/** A candidate enemy at the fire instant for the auto-aim acquisition proof. */
export interface AimCandidate {
  /** Stable identity used to compare against the locked target. */
  id: string;
  /** World position at the fire instant (the +Z/3D-aware distance source for the "nearest" rule). */
  position: { x: number; y: number; z: number };
  /** Current hit points (the "lowest-hp" rule source). */
  hp: number;
  /** Whether the candidate is alive at the fire instant — a dead enemy is never a valid auto-aim pick. */
  alive: boolean;
  /** A precomputed threat score; REQUIRED only for the "highest-threat" rule (refused if absent there). */
  threat?: number;
}

/** The declared auto-aim priority rule the locked target is asserted to satisfy. */
export type AimPriorityRule = "nearest" | "lowest-hp" | "highest-threat";

/**
 * Outcome of the auto-aim acquisition proof: the MEASURED correctness WITH the expected vs locked id
 * (`ok: true`), OR an honest reason the decision could not be evaluated (`ok: false`). A WRONG lock is
 * `ok: true, correct: false` — an honest measured MISS the rule forbids, surfaced (not a refusal). A
 * refusal is reserved for "could not decide": no candidates, no lock, an unresolved tie, or degraded data.
 */
export type AutoAimResult =
  | { ok: true; correct: boolean; expectedTargetId: string; lockedTargetId: string; rule: AimPriorityRule }
  | { ok: false; reason: string };

/** Euclidean 3D distance from `origin` to `p` (null if any component is non-finite). */
function distance3D(origin: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): number | null {
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return null;
  return Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
}

/**
 * Auto-aim acquisition proof — `autoAimAcquisition`: did the auto-aim lock the CORRECT enemy for the
 * declared priority `rule`? Given the alive candidates and their {position, hp, alive[, threat]} at the
 * fire instant, the actually-LOCKED target id, and the rule, it computes the rule's correct pick and
 * compares. This proves the TARGETING DECISION (the right enemy), not merely that the shot followed aim.
 *
 * The pick metric per rule (smaller-is-better for nearest/hp, larger-is-better for threat):
 *   - "nearest"       → minimum Euclidean distance from `origin` (REQUIRED for this rule).
 *   - "lowest-hp"     → minimum hp.
 *   - "highest-threat"→ maximum `threat` (REQUIRED on every alive candidate for this rule).
 *
 * Honest-or-refuse — refuse (ok: false) ONLY when the decision cannot be evaluated, never to hide a miss:
 *   - no candidates                                                  → refuse (nothing to acquire)
 *   - no alive candidate                                             → refuse (no valid target exists)
 *   - no locked target id                                           → refuse (auto-aim never locked)
 *   - "nearest" with no/invalid origin                              → refuse (cannot rank by distance)
 *   - a degraded metric (NaN position/hp, or a missing threat for the threat rule) → refuse
 *   - the best metric is TIED between ≥2 alive candidates           → refuse (ambiguous, unresolved tie)
 * Otherwise returns `ok: true` with `correct = (lockedTargetId === expectedTargetId)` — `correct: false`
 * is an honest MEASURED MISS (the auto-aim picked the wrong enemy), not a refusal. MEASURE-ONLY.
 */
export function deriveAutoAimAcquisition(
  candidates: AimCandidate[] | undefined | null,
  lockedTargetId: string | null | undefined,
  rule: AimPriorityRule,
  origin?: { x: number; y: number; z: number },
): AutoAimResult {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: "no candidate enemies at the fire instant — nothing to acquire" };
  }
  const alive = candidates.filter((c) => c && c.alive === true);
  if (alive.length === 0) {
    return { ok: false, reason: "no living candidate enemy — there is no valid auto-aim target" };
  }
  if (typeof lockedTargetId !== "string" || lockedTargetId.length === 0) {
    return { ok: false, reason: "the auto-aim never locked a target (no lockedTargetId) — nothing to evaluate" };
  }

  // Metric per rule (lower wins for distance/hp; we negate threat so "lowest metric wins" is uniform).
  const metrics: Array<{ id: string; metric: number }> = [];
  if (rule === "nearest") {
    if (!origin || !isFiniteNumber(origin.x) || !isFiniteNumber(origin.y) || !isFiniteNumber(origin.z)) {
      return { ok: false, reason: "the 'nearest' rule needs a finite shooter origin to rank by distance" };
    }
    for (const c of alive) {
      const d = distance3D(origin, c.position);
      if (d === null) return { ok: false, reason: `candidate '${c.id}' has a degraded position (NaN) — cannot rank by distance` };
      metrics.push({ id: c.id, metric: d });
    }
  } else if (rule === "lowest-hp") {
    for (const c of alive) {
      if (!isFiniteNumber(c.hp)) return { ok: false, reason: `candidate '${c.id}' has a degraded hp (NaN) — cannot rank by hp` };
      metrics.push({ id: c.id, metric: c.hp });
    }
  } else if (rule === "highest-threat") {
    for (const c of alive) {
      if (!isFiniteNumber(c.threat)) {
        return { ok: false, reason: `candidate '${c.id}' has no threat score — the 'highest-threat' rule cannot rank it` };
      }
      metrics.push({ id: c.id, metric: -(c.threat as number) }); // negate: highest threat = lowest metric
    }
  } else {
    return { ok: false, reason: `unknown priority rule '${rule as string}'` };
  }

  // Best = the minimum metric. A TIE for the best is an unresolved decision → refuse (do not guess).
  let best = metrics[0];
  for (const m of metrics) if (m.metric < best.metric) best = m;
  const tiedCount = metrics.filter((m) => Math.abs(m.metric - best.metric) <= 1e-9).length;
  if (tiedCount > 1) {
    return { ok: false, reason: `the '${rule}' best pick is tied between ${tiedCount} candidates — ambiguous, unresolved tie` };
  }

  return { ok: true, correct: lockedTargetId === best.id, expectedTargetId: best.id, lockedTargetId, rule };
}

/**
 * Outcome of the sprint-profile proof: the MEASURED multiplier/duration/cooldown read from the boost
 * windows in the planar-speed series (`ok: true`), OR an honest reason the profile could not be measured
 * (`ok: false`). Each value corresponds to a real observed window/edge — never a fabricated number.
 */
export type SprintProfileResult =
  | {
      ok: true;
      /** Sprint speed multiplier = peak sprint speed / base (pre-sprint moving) speed. */
      multiplier: number;
      /** The representative base (pre-sprint, moving) planar speed (u/s). */
      baseSpeed: number;
      /** The peak boosted planar speed during sprint (u/s). */
      sprintSpeed: number;
      /** Sustained duration the FIRST boost window held (ms) — the boosted span the multiplier lasted. */
      durationMs: number;
      /** Lockout (ms) from the first boost's end to the second boost's start — sprint becoming available again. */
      cooldownMs: number;
    }
  | { ok: false; reason: string };

/** Planar speed below which a sample is treated as "not moving" (the base-speed noise floor). */
const SPRINT_MOVING_EPSILON_U_PER_S = 1e-6;
/** Minimum fraction above base the peak speed must reach to count as a real sprint boost (5%). */
const SPRINT_MIN_BOOST_FRACTION = 1.05;

/** Median of a non-empty numeric array (sorted-copy midpoint / mean of the two middles). */
function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sprint-profile metric — `sprintProfile`: the sprint speed MULTIPLIER, the sustained DURATION the
 * boost holds, and the COOLDOWN lockout before the boost is available again. The signals are two
 * caller-bound `fieldTimeline` series: a numeric `planarSpeed` (the ground-plane speed) and a boolean
 * `sprintInput` (held while the player asks to sprint).
 *
 * The honesty crux: every value is read from the BOOST WINDOWS physically present in the speed series
 * (samples elevated past a threshold midway between base and peak), gated on a REAL sprint-input edge —
 * not from the input series alone (a held key with no speed change is no sprint). The cooldown needs a
 * SECOND boost to observe "available again", so a single burst refuses rather than fabricate a lockout.
 *
 * F1 invariant FIRST on both series. Then honest-or-refuse:
 *   - degraded series (unresolved / readError)                       → refuse (F1)
 *   - the sprint input was never held (no sprintInput rising edge)    → refuse (no sprint engaged)
 *   - no moving speed before sprint onset                            → refuse (no base speed to divide by)
 *   - the peak sprint speed did not exceed base by the margin        → refuse (no boost observed)
 *   - fewer than two boost windows (cannot see the lockout)          → refuse (no second sprint to time cooldown)
 * Returns `{ ok: true, multiplier, durationMs, cooldownMs, ... }` only when all hold. MEASURE-ONLY.
 */
export function deriveSprintProfile(
  speedSeries: SyncSeries | undefined | null,
  sprintInputSeries: SyncSeries | undefined | null,
): SprintProfileResult {
  const speedRefusal = syncSeriesRefusal(speedSeries);
  if (speedRefusal !== null) return { ok: false, reason: `planarSpeed series — ${speedRefusal}` };
  const inputRefusal = syncSeriesRefusal(sprintInputSeries);
  if (inputRefusal !== null) return { ok: false, reason: `sprintInput series — ${inputRefusal}` };
  const speed = speedSeries as SyncSeries;
  const sprintInput = sprintInputSeries as SyncSeries;
  if (speed.samples.length === 0) {
    return { ok: false, reason: "planarSpeed series has no samples" };
  }

  // The sprint must have actually been engaged (a real input edge), or there is nothing to profile.
  const onsetMs = firstRisingEdge(sprintInput);
  if (onsetMs === null) {
    return { ok: false, reason: "the sprint input was never held (no sprintInput rising edge) — no sprint engaged" };
  }

  // BASE speed = the representative MOVING speed BEFORE the sprint onset (median of pre-onset moving samples).
  const preMoving = speed.samples
    .filter((s) => s.tMs < onsetMs && typeof s.value === "number" && (s.value as number) > SPRINT_MOVING_EPSILON_U_PER_S)
    .map((s) => s.value as number);
  if (preMoving.length === 0) {
    return { ok: false, reason: "no moving speed before sprint onset — there is no base speed to measure the multiplier against" };
  }
  const baseSpeed = medianOf(preMoving);
  if (!(baseSpeed > 0)) {
    return { ok: false, reason: "the base speed is not positive — cannot measure a sprint multiplier" };
  }

  // PEAK sprint speed = the maximum speed at/after onset; must clear base by the margin to be a real boost.
  const sprintSamples = speed.samples.filter((s) => s.tMs >= onsetMs && typeof s.value === "number") as Array<{
    tMs: number;
    value: number;
  }>;
  let sprintSpeed = -Infinity;
  for (const s of sprintSamples) if (s.value > sprintSpeed) sprintSpeed = s.value;
  if (!(sprintSpeed > baseSpeed * SPRINT_MIN_BOOST_FRACTION)) {
    return { ok: false, reason: "the sprint did not meaningfully increase speed (peak ≤ base + margin) — no boost observed" };
  }

  // BOOST WINDOWS = contiguous runs of at/after-onset samples elevated past the midpoint threshold.
  const boostThreshold = (baseSpeed + sprintSpeed) / 2;
  const windows: Array<{ startMs: number; endMs: number }> = [];
  let cur: { startMs: number; endMs: number } | null = null;
  for (const s of sprintSamples) {
    if (s.value >= boostThreshold) {
      if (cur === null) cur = { startMs: s.tMs, endMs: s.tMs };
      else cur.endMs = s.tMs;
    } else if (cur !== null) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur !== null) windows.push(cur);

  if (windows.length < 2) {
    return {
      ok: false,
      reason: `only ${windows.length} sprint boost window(s) observed — need a SECOND sprint to time the cooldown lockout`,
    };
  }
  const first = windows[0];
  const second = windows[1];
  const durationMs = first.endMs - first.startMs;
  const cooldownMs = second.startMs - first.endMs;
  if (!(cooldownMs > 0)) {
    return { ok: false, reason: "the second boost did not follow the first (non-positive cooldown) — degraded window ordering" };
  }
  return { ok: true, multiplier: sprintSpeed / baseSpeed, baseSpeed, sprintSpeed, durationMs, cooldownMs };
}

// ── shooter polish calculators (hit-stop window + screen-shake magnitude) ─────
//
// Two combat-feedback "juice" metrics, both honest-or-refuse on RAW sampled evidence
// (never human judgment, never a fabricated number):
//
//   hitstopMs       = duration of the impact freeze/pause/slowdown WINDOW after a hit,
//                     measured as the first rising edge -> the following falling edge of a
//                     deterministic hit-stop signal (a bool window, or a numeric counter/
//                     remaining-time series that is >baseline while the window is open).
//   screenShakeMag  = the peak camera displacement from rest after impact, derived directly
//                     from the camera's sampled transform trajectory (the hardest-to-fake
//                     evidence: it proves the camera physically moved, not a self-reported
//                     amplitude field).
//
// Both REFUSE rather than green when the evidence is absent/degraded: a hit-stop series with
// no window (no rising edge) or one that never closes (no falling edge) is refused; a camera
// trajectory that never displaced beyond a tiny floor is refused (no shake observed → never a
// fabricated 0). MEASURE-ONLY, like the other shooter calculators: surfaced as evidence, the
// pack-default band is advisory and not gate-enforced here.

/** Is `value` in the ACTIVE state relative to the series baseline (mirrors firstRisingEdge). */
function isActiveAgainstBaseline(value: number | boolean, baseline: number | boolean): boolean {
  if (typeof baseline === "boolean") return value === true; // bool window: active === true
  if (typeof baseline === "number") return typeof value === "number" && value > baseline; // counter/remaining > baseline
  return false;
}

/**
 * Shooter polish metric — `hitstopMs` (ms): the duration of the impact hit-stop WINDOW, from the
 * first rising edge of the hit-stop signal (the window opens on a registered hit) to the first
 * following falling edge (the window closes). The signal is a caller-bound `fieldTimeline` series:
 * a boolean `HitStopActive` (false→true→false) or a numeric remaining-time/counter series that is
 * strictly above its baseline while the window is open.
 *
 * F1 invariant FIRST: a degraded series (`unresolved||readError`) is refused. Then honest-or-refuse:
 *   - no rising edge            → no hit-stop window opened in-window → refuse (never a fabricated 0)
 *   - a rise with no later fall → the window never closed in the capture → refuse (inconclusive,
 *                                 not an open-ended/clamped duration)
 * Measures the FIRST window only (deterministic): repeated identical windows from later hits do not
 * change the first measured duration. MEASURE-ONLY.
 */
export function deriveHitstopMs(hitStopSeries: SyncSeries | undefined | null): SyncDerivation {
  const refusal = syncSeriesRefusal(hitStopSeries);
  if (refusal !== null) return { ok: false, reason: `hit-stop series — ${refusal}` };
  const series = hitStopSeries as SyncSeries;
  if (series.samples.length === 0) {
    return { ok: false, reason: "hit-stop series has no samples" };
  }
  const baseline = series.samples[0].value;
  const riseMs = firstRisingEdge(series);
  if (riseMs === null) {
    return { ok: false, reason: "no hit-stop window opened in-window (no rising edge in the hit-stop series)" };
  }
  // The first sample AFTER the rise that returns to the inactive (baseline) state closes the window.
  let started = false;
  for (const s of series.samples) {
    if (!started) {
      if (s.tMs === riseMs) started = true;
      continue;
    }
    if (!isActiveAgainstBaseline(s.value, baseline)) {
      return { ok: true, latencyMs: s.tMs - riseMs };
    }
  }
  return { ok: false, reason: "hit-stop window did not close in-window (no falling edge after the rising edge)" };
}

/**
 * Peak camera displacement (world units) marking "shake observed". Chosen well above
 * floating-point/quantization noise on a static camera yet far below a real shake of any visible
 * amplitude, so a camera that never moved reads as "no shake" (refuse) rather than a fabricated 0.
 */
export const SCREEN_SHAKE_MIN_REGISTERED_U = 5e-3;

/**
 * Shooter polish metric — `screenShakeMag` (world units): the PEAK displacement of the
 * sampled camera transform from its rest (first-sample) position. Derived directly from the camera's
 * position trajectory (the same `samples[]:{tMs,x,y,z?}` shape the trajectory feel metrics use), so it
 * measures that the camera actually moved rather than trusting a self-reported amplitude field.
 *
 * Dimension-agnostic: the displacement is the full Euclidean distance over {x,y,z}. A pure-2D capture
 * (no z on ANY sample) uses the planar `hypot(dx,dy)`, byte-identical to the pre-3D behavior — but a
 * true 3D camera punch whose x/y never change (e.g. a kick along the view/depth axis) is now measured
 * correctly instead of reading ~0. The z term is what the 3D measurement substrate adds; a 3D capture
 * with z STRIPPED collapses to its x/y projection (so a pure-z punch then refuses), which is the
 * load-bearing proof that z is required.
 *
 * Dimension consistency is fail-closed (the §3a refuse-don't-skip rule): a 3D capture carries z on
 * EVERY sample, so if ANY sample carries z they all must. A heterogeneous trajectory (some z present,
 * some absent) is degraded/ambiguous and REFUSES (`null`) rather than scoring an absent z as 0 against
 * a non-zero rest — which would FABRICATE displacement from a camera that never moved.
 *
 * IMPACT WINDOWING (`onsetMs`, for the shooter binding): a peak taken over the WHOLE trajectory could
 * misattribute UNRELATED pre-impact camera motion (e.g. a follow-cam panning before the shot) as
 * "screen shake on impact". When `onsetMs` (the impact edge) is supplied, this:
 *   1. REFUSES if the camera displaced beyond SCREEN_SHAKE_MIN_REGISTERED_U at any sample BEFORE the
 *      onset — the camera must be at rest before impact, or the measurement is ambiguous; and
 *   2. measures the peak only over samples AT/AFTER the onset.
 * So the returned magnitude is unambiguously the post-impact shake, anchored to the pre-impact rest
 * (the first sample, asserted still). Omit `onsetMs` for general (non-causal) camera-shake measurement.
 *
 * honest-or-omit (returns null → the assembler omits it, never a fabricated 0):
 *   - fewer than two valid samples / non-monotonic time → null (no usable trajectory)
 *   - `onsetMs` supplied but non-finite / outside the sampled window / no sample at/after it → null
 *   - `onsetMs` supplied and the camera displaced before the onset → null (pre-impact motion: ambiguous)
 *   - the camera never displaced beyond SCREEN_SHAKE_MIN_REGISTERED_U in-window → null (no shake observed)
 */
export function deriveScreenShakeMag(samples: FeelTrajectorySample[], onsetMs?: number): number | null {
  if (!isValidTrajectory(samples)) return null;
  // Dimension consistency, fail-closed: if ANY sample carries z, EVERY sample must carry a finite z
  // (a 3D capture samples z on every tick). A heterogeneous trajectory refuses rather than scoring an
  // absent z as 0 against a non-zero rest baseline (which would fabricate displacement). A pure-2D
  // capture (no z anywhere) keeps the exact planar hypot.
  const has3D = samples.some((s) => s.z !== undefined);
  if (has3D && !samples.every((s) => isFiniteNumber(s.z))) return null;
  const x0 = samples[0].x;
  const y0 = samples[0].y;
  const z0 = has3D ? (samples[0].z as number) : 0;
  const disp = (s: FeelTrajectorySample) =>
    has3D ? Math.hypot(s.x - x0, s.y - y0, (s.z as number) - z0) : Math.hypot(s.x - x0, s.y - y0);

  let startIdx = 0;
  if (onsetMs !== undefined) {
    if (!isFiniteNumber(onsetMs)) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (onsetMs < first.tMs || onsetMs > last.tMs) return null; // onset outside the sampled window
    // The camera must be AT REST before impact (relative to the rest anchor), else pre-impact motion
    // would be misattributed as shake — refuse rather than certify ambiguous motion.
    let firstAtOrAfter = -1;
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].tMs < onsetMs) {
        if (disp(samples[i]) > SCREEN_SHAKE_MIN_REGISTERED_U) return null; // pre-impact camera motion
      } else {
        firstAtOrAfter = i;
        break;
      }
    }
    if (firstAtOrAfter < 0) return null; // no sample at/after the onset
    startIdx = firstAtOrAfter;
  }

  let peak = 0;
  for (let i = startIdx; i < samples.length; i += 1) {
    const d = disp(samples[i]);
    if (d > peak) peak = d;
  }
  if (!(peak > SCREEN_SHAKE_MIN_REGISTERED_U)) return null; // camera never shook → omit, never a fabricated 0
  return peak;
}

/**
 * Causality bound for impact FEEDBACK ("juice"): a feedback edge (hit-stop window opening, camera-shake
 * onset) is IMMEDIATE iff it fires on the same captured frame as the reference hit edge, or within ONE
 * capture sample interval after it. A feedback edge that PRECEDES the hit (negative delta) or arrives
 * more than one frame late is NOT an immediate consequence of the hit — it is refused, so a delayed or
 * independently-triggered effect cannot be certified as impact feedback.
 *
 * `sampleIntervalMs` is the capture's sample period (1000 / captureFps). A small tolerance absorbs the
 * 2-decimal tMs rounding (consecutive samples differ by 16.66/16.67ms at 60fps).
 */
export const IMPACT_FEEDBACK_FRAME_TOLERANCE_MS = 0.5;
export function isImmediateImpactFeedback(
  feedbackEdgeMs: number | null,
  hitEdgeMs: number | null,
  sampleIntervalMs: number,
): boolean {
  if (!isFiniteNumber(feedbackEdgeMs) || !isFiniteNumber(hitEdgeMs) || !isFiniteNumber(sampleIntervalMs)) {
    return false;
  }
  const delta = feedbackEdgeMs - hitEdgeMs;
  return delta >= 0 && delta <= sampleIntervalMs + IMPACT_FEEDBACK_FRAME_TOLERANCE_MS;
}

/**
 * L3c sync metric — `dashToGhostMs` (ms): the time from the dash-START edge
 * (`PlayerController.IsDashing` going false→true) to the first dash-afterimage
 * ghost-SPAWN edge (e.g. `DashGhost_0`'s `SpriteRenderer.enabled` going false→true).
 * Both are `fieldTimeline` series — this is the SERIES→SERIES form of the sync
 * primitive (the reference edge is another captured series' edge, not an input onset).
 *
 * F1 invariant FIRST on BOTH series: refuse if EITHER the dash series OR the ghost
 * series is degraded (`unresolved||readError`) — never derive an edge from a
 * truncated/unresolved stream (even if the other series has a perfectly good edge).
 * Then the dash-start edge must exist (no dash → refuse), and honest-or-omit via
 * `deriveEdgeLatency` (no ghost edge → omit; ghost edge BEFORE the dash edge → omit,
 * never a clamped 0). Returns a discriminated result so the assembler can surface the
 * refusal REASON, distinct from a clean omit.
 *
 * Signal-AGNOSTIC: the caller supplies whatever two series the game exposes (tiderunner
 * uses IsDashing + DashGhost_0.enabled), exactly as `inputToSfxLatency` takes a
 * caller-provided SFX series. MEASURE-ONLY: surfaced in `alsoMeasured`, never banded.
 */
export function deriveDashToGhostLatency(
  dashingSeries: SyncSeries | undefined | null,
  ghostSeries: SyncSeries | undefined | null,
): SyncDerivation {
  const dashRefusal = syncSeriesRefusal(dashingSeries);
  if (dashRefusal !== null) return { ok: false, reason: `dash series — ${dashRefusal}` };
  const ghostRefusal = syncSeriesRefusal(ghostSeries);
  if (ghostRefusal !== null) return { ok: false, reason: `ghost series — ${ghostRefusal}` };
  const dashEdgeMs = firstRisingEdge(dashingSeries as SyncSeries);
  if (dashEdgeMs === null) {
    return { ok: false, reason: "dash never started (no rising edge in the IsDashing series)" };
  }
  const latency = deriveEdgeLatency(ghostSeries as SyncSeries, dashEdgeMs);
  if (latency === null) {
    const edge = firstRisingEdge(ghostSeries as SyncSeries);
    if (edge === null) {
      return { ok: false, reason: "no dash-ghost spawned after the dash started (no rising edge in the ghost series)" };
    }
    return { ok: false, reason: "ghost-spawn edge precedes the dash start (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: latency };
}

// ── ground-contact → landing-dust sync (L3d) ─────────────────────────────────
//
// L3d's sync metric `groundContactToDustMs` is the time from GROUND CONTACT (the
// player landing after a fall) to the LANDING-DUST spawning. Unlike `inputToSfxLatency`
// (input-onset → series edge) and `dashToGhostMs` (series → series), its FROM-edge is
// NOT a captured fieldTimeline series — it is DERIVED FROM THE POSITION TRAJECTORY (a
// landing IS the vertical fall arresting). The TO-edge is the usual dust-spawn series
// (a persistent counter the game exposes, e.g. PlayerController.LandingDustCount 0→1).
//
// THE GROUND-CONTACT EDGE (the novel piece, honest-or-omit). From per-interval vertical
// speed vy = Δy/Δt we find the moment a real DESCENT arrests:
//   1. compute vy[i] over each positive-dt interval; negative vy = falling.
//   2. a real DESCENT must exist: the most-negative vy ≤ -GROUND_CONTACT_MIN_FALL_SPEED
//      (a too-gentle drift is not a real fall → no landing → null).
//   3. CONTACT = the first interval AFTER the peak-descent index where the fall has
//      ARRESTED (vy ≥ -GROUND_CONTACT_LAND_EPS — the player stopped falling → landed).
//      We require it AFTER the peak-descent index precisely so a JUMP'S APEX (where vy
//      momentarily ≈ 0 between the rise and the fall) is NEVER mistaken for a landing —
//      at the apex the steepest descent hasn't happened yet. The arrest is the genuine
//      touchdown that follows the fastest fall.
//   4. if the descent never arrests (still falling at the last sample) → null (the fall
//      did not complete in the window — inconclusive, never a fabricated edge).
//
// MEASURE-ONLY, exactly like the other two sync metrics: surfaced in `alsoMeasured`,
// never banded.

/** Vertical speed (u/s) clearly indicating a real fall — below this is gentle drift, not a fall. */
const GROUND_CONTACT_MIN_FALL_SPEED = 1.0;
/** Vertical speed (u/s) at/above which a fall is considered ARRESTED (≈ stopped → landed). */
const GROUND_CONTACT_LAND_EPS = 0.5;

/**
 * The `tMs` of the first GROUND CONTACT in a position trajectory (the moment a real
 * fall arrests), or null when there is no completed fall→land in the window.
 *
 * Honest-or-omit throughout — never fabricates an edge. See the section comment above
 * for why the arrest must come AFTER the peak-descent index (so a jump's apex, where
 * vy≈0, is not misread as a landing) and why a too-gentle fall is not a real landing.
 */
export function deriveGroundContactEdge(samples: FeelTrajectorySample[]): number | null {
  if (!Array.isArray(samples) || samples.length < 3) return null;

  // Per-interval vertical speed vy[i] = Δy / Δt (u/s), keyed to the EARLIER sample of the
  // interval. An interval whose vy has arrested (≈0) means the player was already at rest
  // at its earlier sample — that earlier sample's tMs is the touchdown (the moment the
  // fall stopped), so a contact reported here lands exactly on the sample where the body
  // first came to rest at the ground (200ms in the canonical fall→land arc).
  const vy: { speed: number; tMs: number }[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dtSec = (samples[i].tMs - samples[i - 1].tMs) / 1000;
    if (dtSec <= 0) continue; // skip non-positive dt (defensive)
    vy.push({ speed: (samples[i].y - samples[i - 1].y) / dtSec, tMs: samples[i - 1].tMs });
  }
  if (vy.length < 2) return null;

  // A real DESCENT must exist: the steepest (most-negative) vy must clear the fall floor.
  let peakDescentIdx = -1;
  let peakDescent = 0; // most-negative vy seen
  for (let i = 0; i < vy.length; i += 1) {
    if (vy[i].speed < peakDescent) {
      peakDescent = vy[i].speed;
      peakDescentIdx = i;
    }
  }
  if (peakDescentIdx < 0 || peakDescent > -GROUND_CONTACT_MIN_FALL_SPEED) return null; // no real fall in window

  // CONTACT = first interval AFTER the peak-descent index where the fall has arrested.
  // This is the FIRST touchdown of the window (where the landing dust fires), NOT the
  // final settle — on a bouncy / intermediate-ledge arc the first ground contact wins,
  // which is the intended semantics for a ground-contact→dust sync (dust fires on first touch).
  for (let i = peakDescentIdx + 1; i < vy.length; i += 1) {
    if (vy[i].speed >= -GROUND_CONTACT_LAND_EPS) return vy[i].tMs;
  }
  return null; // still falling at the last sample → fall not completed in window
}

/**
 * L3d sync metric — `groundContactToDustMs` (ms): the time from GROUND CONTACT (the
 * fall arresting, derived from the position trajectory) to the first LANDING-DUST
 * spawn edge (e.g. PlayerController.LandingDustCount going 0→1, a `fieldTimeline`
 * series). The TRAJECTORY supplies the reference edge; the DUST series the target edge.
 *
 * F1 invariant FIRST on the dust series: refuse if it is degraded (`unresolved||readError`)
 * — never derive an edge from a truncated/unresolved stream, even if it carries a valid
 * edge. Then the ground-contact edge must exist (no completed fall→land → refuse), and
 * honest-or-omit via `deriveEdgeLatency` (no dust edge → refuse; dust edge BEFORE contact
 * → refuse, never a clamped 0). Returns a discriminated result so the assembler can
 * surface the refusal REASON, distinct from a clean omit. A same-tick landing-dust
 * (latency 0) is a VALID measurement (`{ok:true, latencyMs:0}`), never a refusal.
 *
 * MEASURE-ONLY: surfaced in `alsoMeasured`, never banded.
 */
export function deriveGroundContactToDustLatency(
  samples: FeelTrajectorySample[],
  dustSeries: SyncSeries | undefined | null,
): SyncDerivation {
  const refusal = syncSeriesRefusal(dustSeries);
  if (refusal !== null) return { ok: false, reason: `dust series — ${refusal}` };
  const contactMs = deriveGroundContactEdge(samples);
  if (contactMs === null) {
    return { ok: false, reason: "no ground contact in window (no completed fall→land in the trajectory)" };
  }
  const latency = deriveEdgeLatency(dustSeries as SyncSeries, contactMs);
  if (latency === null) {
    const edge = firstRisingEdge(dustSeries as SyncSeries);
    if (edge === null) {
      return { ok: false, reason: "no landing dust spawned after ground contact (no rising edge in the dust series)" };
    }
    return { ok: false, reason: "dust-spawn edge precedes ground contact (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: latency };
}

// ── input → animation-state sync (L3e) ───────────────────────────────────────
//
// L3e's sync metric `inputToAnimStateLatency` is the time from an input ONSET to the
// ANIMATOR ENTERING a target state (e.g. a jump input → the "jump" animation state
// starting). It mirrors `inputToSfxLatency` almost exactly (input-onset reference,
// F1-first, honest-or-omit, measure-only) — the one difference is the TO-edge: an
// animator state is CATEGORICAL (entered when value===targetState), so it uses
// `firstStateEntryEdge` rather than `firstRisingEdge`. A fall(3)→jump(2) transition is
// a genuine ENTRY into jump even though 2<3, which a monotonic rising edge would miss.
//
// MEASURE-ONLY, exactly like the other sync metrics: surfaced in `alsoMeasured`,
// never banded.

/**
 * L3e sync metric — `inputToAnimStateLatency` (ms): the time from the recorded input
 * ONSET to the animator first ENTERING the `targetState` (its value === targetState).
 * The anim-state series is a `fieldTimeline` entry (e.g. Animator state hash / an enum);
 * `inputOnsetMs` is the SAME onset field F5's `inputLatency` / `inputToSfxLatency` use.
 *
 * F1 invariant FIRST: refuse if the anim-state series is degraded (`unresolved||readError`)
 * — never derive an entry from a truncated/unresolved stream, even if it contains a valid
 * entry. Then honest-or-omit: missing onset → refuse; the state never entered in-window →
 * refuse; an entry that PRECEDES the onset → refuse (non-causal / inconclusive). A real
 * same-tick entry (latency 0) is a VALID measurement (`{ok:true, latencyMs:0}`), never a
 * refusal and never clamped. Returns a discriminated result so the assembler can surface
 * the refusal REASON, distinct from a clean omit.
 *
 * MEASURE-ONLY: surfaced in `alsoMeasured`, never banded.
 */
export function deriveInputToAnimStateLatency(
  animStateSeries: SyncSeries | undefined | null,
  inputOnsetMs: number | undefined,
  targetState: number | boolean,
): SyncDerivation {
  const refusal = syncSeriesRefusal(animStateSeries);
  if (refusal !== null) return { ok: false, reason: refusal };
  if (!isFiniteNumber(inputOnsetMs)) {
    return { ok: false, reason: "no input onset recorded (cannot measure latency)" };
  }
  const entryMs = firstStateEntryEdge(animStateSeries as SyncSeries, targetState);
  if (entryMs === null) {
    return { ok: false, reason: "animator never entered the target state in-window (no state-entry edge)" };
  }
  const latency = entryMs - inputOnsetMs;
  if (latency < 0) {
    return { ok: false, reason: "anim-state entry precedes the input onset (non-causal ordering — inconclusive)" };
  }
  return { ok: true, latencyMs: latency };
}

/**
 * Shooter v1 event-cadence metric — `fireIntervalMs`: the mean time between observed fire/shot
 * events in a clean event counter series. Intended series shape: a sampled integer counter such as
 * Weapon.FireCount or ProjectileSpawnCount. Boolean pulse streams also work when they visibly return
 * false between shots.
 *
 * F1 invariant FIRST: degraded series are refused. Honest-or-omit: fewer than two observed fire
 * edges means there is no interval to measure, so the metric is omitted rather than reported as 0.
 */
export function deriveFireIntervalMs(
  fireSeries: SyncSeries | undefined | null,
): SyncDerivation {
  const refusal = syncSeriesRefusal(fireSeries);
  if (refusal !== null) return { ok: false, reason: `fire series — ${refusal}` };
  const interval = deriveMeanEventInterval(fireSeries as SyncSeries);
  if (interval === null) {
    return { ok: false, reason: "need at least two observed fire events to measure fireIntervalMs" };
  }
  return { ok: true, latencyMs: interval };
}

// ── input-timing bisection (coyote / jumpBuffer boundary) ────────────────────

export interface BisectionTrial {
  /** Input delay tried, in milliseconds. */
  delayMs: number;
  /** Whether the controller still jumped at this delay. */
  jumped: boolean;
}

export interface BisectionResult {
  /** Boundary window in seconds (midpoint of the last jumped / first failed), or null. */
  windowSeconds: number | null;
  /** Why a boundary could not be established, when windowSeconds is null. */
  reason?: string;
}

/**
 * Interpret a set of input-timing bisection trials into a boundary window.
 *
 * For coyoteTime, `delayMs` is the delay after leaving the ground before pressing
 * jump; for jumpBuffer, the lead time before landing. The boundary is where the
 * jump transitions from succeeding to failing. Returns the midpoint between the
 * largest jumped delay and the smallest failed delay (seconds). Honest: returns
 * null + reason when the trials don't bracket a transition (never invents).
 */
export function interpretBisection(trials: BisectionTrial[]): BisectionResult {
  const valid = trials.filter((t) => isFiniteNumber(t.delayMs) && typeof t.jumped === "boolean");
  if (valid.length === 0) return { windowSeconds: null, reason: "no valid trials" };

  const jumped = valid.filter((t) => t.jumped).map((t) => t.delayMs);
  const failed = valid.filter((t) => !t.jumped).map((t) => t.delayMs);

  if (jumped.length === 0) {
    return { windowSeconds: null, reason: "no trial jumped — boundary is below the smallest delay tried" };
  }
  if (failed.length === 0) {
    return { windowSeconds: null, reason: "every trial jumped — boundary is above the largest delay tried" };
  }

  const maxJumped = Math.max(...jumped);
  const minFailed = Math.min(...failed);
  if (minFailed <= maxJumped) {
    return {
      windowSeconds: null,
      reason: `non-monotonic trials: a failed delay (${minFailed}ms) is ≤ a jumped delay (${maxJumped}ms)`,
    };
  }
  return { windowSeconds: (maxJumped + minFailed) / 2 / 1000 };
}
