/**
 * feel.json assembler (S5c).
 *
 * Turns captured measurement evidence (raw trajectories + bisection trials, from
 * the live S5c-b harness) into the S5b-loader-compatible measurements file:
 * `{ metrics, provenance }`. Every value is DERIVED here from the raw evidence —
 * never copied from a controller param — and trajectory sources carry their
 * `samples` + `derivation:"trajectory"` so `feel-rederive` (and `verify --profile`
 * §0) can re-compute and reject a tampered value.
 *
 * Metrics whose evidence is absent or inconclusive (e.g. a bisection that didn't
 * bracket a boundary) are OMITTED — S5b then reports them honestly as "not
 * measured", never invented.
 *
 * This module is pure (no fs, no bridge); the live capture that produces its
 * inputs is S5c-b.
 */

import {
  deriveDashToGhostLatency,
  deriveFireIntervalMs,
  deriveGroundContactToDustLatency,
  deriveInputToAnimStateLatency,
  deriveInputToSfxLatency,
  deriveInputToSpawnLatency,
  deriveTimeToKill,
  deriveMetric,
  interpretBisection,
  isValidTrajectory,
  REDERIVABLE_METRIC_SET,
  type BisectionTrial,
  type SyncSeries,
} from "../../../verification/feel-derive.js";
import type {
  FeelMeasurementSource,
  FeelMeasurementStimulus,
  FeelTrajectorySample,
} from "../../../verification/gates/feel.js";
import type { ProfileMeasurements } from "./measurements.js";

/** Shared provenance fields every capture must carry (timestep/timing evidence). */
interface CaptureProvenanceBase {
  captureFps: number;
  measuredAt: string;
  projectFixedTimestepBeforeMeasurement: number;
  measurementFixedTimestep: number;
}

/** A trajectory capture: raw samples that re-derive one or more trajectory metrics. */
export interface TrajectoryCapture extends CaptureProvenanceBase {
  kind: "trajectory";
  /**
   * "runtime.measure_motion" (observe-only), "runtime.capture_input_motion"
   * (same sampler, injects declared keys in-loop), or "runtime.probe".
   */
  source: "runtime.measure_motion" | "runtime.capture_input_motion" | "runtime.probe";
  /** Which trajectory-derivable metrics to read from these samples. */
  metrics: string[];
  samples: FeelTrajectorySample[];
  /**
   * F5: the input stimulus that produced a stimulus-sensitive metric in `metrics`
   * (currently only `shortHopApex` — the tap duration jointly determines the hop
   * height). Required for a capture that measures shortHopApex; the assembler copies
   * it onto the emitted source so the verifier can confirm the canonical tap. Absent
   * here for a non-stimulus-sensitive capture (jumpApex/runSpeed/timeToApex).
   */
  stimulus?: FeelMeasurementStimulus;
  /**
   * F5: the input ONSET time (ms, same timeline as `samples[].tMs`) for an
   * `inputLatency` capture — the phase0(settle)→phase1(hold) boundary where the
   * measured key is first pressed. Required to derive `inputLatency`; the assembler
   * passes it to the derivation and carries it onto the emitted source so §0
   * re-derivation can recompute the latency. Absent for non-latency captures.
   */
  inputOnsetMs?: number;
}

/** A bisection capture: input-timing trials for coyoteTime / jumpBuffer. */
export interface BisectionCapture extends CaptureProvenanceBase {
  kind: "bisection";
  metric: "coyoteTime" | "jumpBuffer";
  trials: BisectionTrial[];
}

/**
 * A CROSS-MODAL SYNC capture: `fieldTimeline` series (sampled on the position clock by
 * the L3a runtime-field sampler) deriving a measure-only sync latency metric.
 *   - L3b `inputToSfxLatency`: input onset → first SFX-cue edge (e.g. SfxPlayer.PlayCount).
 *   - L3c `dashToGhostMs`: dash-start edge → ghost-spawn edge (series→series).
 *   - L3d `groundContactToDustMs`: ground-contact edge (DERIVED from the position
 *     trajectory — the fall arresting) → landing-dust spawn edge.
 *   - L3e `inputToAnimStateLatency`: input onset → animator ENTERING a target state
 *     (categorical state-entry edge, e.g. jump input → the "jump" animation state).
 *   - shooter v1 `fireIntervalMs`: mean interval between observed fire/shot counter edges.
 *   - shooter v1 `fireInputToSpawnLatency`: fire input onset → explicit projectile-spawn edge.
 *
 * Refuse-don't-skip (the F1 invariant): if a series is degraded (`unresolved||readError`)
 * the metric is OMITTED with the refusal reason — never derived from a truncated/unresolved
 * stream, never a fabricated 0. (Enforced inside the derive fns.)
 */
export type SyncCapture =
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** input ONSET → first SFX-cue edge. */
      metric: "inputToSfxLatency";
      /** The SFX fieldTimeline entry: `{ id, samples:[{tMs,value}], unresolved?, readError? }`. */
      sfxSeries: SyncSeries;
      /** The input onset (ms, same timeline as the series samples) — the reference edge. */
      inputOnsetMs?: number;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** L3c: dash-START edge → ghost-SPAWN edge (series→series). */
      metric: "dashToGhostMs";
      /** The dash-state fieldTimeline entry (e.g. PlayerController.IsDashing) — the reference edge. */
      dashingSeries: SyncSeries;
      /** The ghost-spawn fieldTimeline entry (e.g. DashGhost_0.SpriteRenderer.enabled) — the target edge. */
      ghostSeries: SyncSeries;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** L3d: ground-CONTACT edge (DERIVED from the trajectory) → landing-DUST spawn edge. */
      metric: "groundContactToDustMs";
      /** The position trajectory — the ground-contact (fall-arrest) reference edge is derived from it. */
      samples: FeelTrajectorySample[];
      /** The landing-dust fieldTimeline entry (e.g. PlayerController.LandingDustCount) — the target edge. */
      dustSeries: SyncSeries;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** L3e: input ONSET → animator ENTERING the target state (categorical state-entry edge). */
      metric: "inputToAnimStateLatency";
      /** The anim-state fieldTimeline entry (e.g. an Animator state hash / enum) — the target edge. */
      animStateSeries: SyncSeries;
      /** The input onset (ms, same timeline as the series samples) — the reference edge. */
      inputOnsetMs?: number;
      /** The animator state value that counts as "entered" (value === targetState). */
      targetState: number | boolean;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** Shooter v1: mean interval between observed fire/shot events. */
      metric: "fireIntervalMs";
      /** Fire/shot fieldTimeline entry, normally a monotonic integer counter such as Weapon.FireCount. */
      fireSeries: SyncSeries;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** Shooter v1: fire input ONSET → first explicit projectile-spawn edge. */
      metric: "fireInputToSpawnLatency";
      /** Spawn fieldTimeline entry, normally a monotonic ProjectileSpawnCount or visible/enabled boolean. */
      spawnSeries: SyncSeries;
      /** The fire input onset (ms, same timeline as the series samples) — the reference edge. */
      inputOnsetMs?: number;
    })
  | (CaptureProvenanceBase & {
      kind: "sync";
      /** Shooter v1: reference-enemy FIRST-HIT edge → DEATH edge (series→series). */
      metric: "ttkMs";
      /** Damage fieldTimeline entry (e.g. Enemy.HitCount 0→1 / Enemy.IsHit false→true) — the reference edge. */
      damageSeries: SyncSeries;
      /** Death fieldTimeline entry (e.g. Enemy.IsDead false→true / Enemy.DeathCount 0→1) — the target edge. */
      deathSeries: SyncSeries;
    });

export type MetricCapture = TrajectoryCapture | BisectionCapture | SyncCapture;

export interface AssembleResult {
  measurements: ProfileMeasurements;
  /** Metrics that had evidence but couldn't be derived (e.g. unbracketed bisection). */
  omitted: { metric: string; reason: string }[];
}

/** Round to 4 dp for clean output; the re-derive tolerance (1e-3) absorbs it. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * ShortHop retry/coalesce (post-#198 reliability). The canonical short-hop tap is
 * deterministic when it registers (live: ~1.40, ± 0.001 within a session) but occasionally (~8% live)
 * fails to register a jump at ALL — a stochastic injection-phase miss — so
 * `deriveShortHopApex` refuses it (null). #198 already makes a miss SAFE (it omits,
 * never a wrong value); this makes it RELIABLE: when the driver supplies several
 * canonical-tap attempts, keep the MEDIAN *registering* attempt and DISCARD the misses,
 * so a one-off miss no longer omits the metric — without ever blending a miss (0) into
 * the value. Refuse only if EVERY attempt missed (keep one attempt so the main loop
 * omits it with the honest reason). Scoped to dedicated shortHop captures (those whose
 * derivable metrics are exactly {shortHopApex}); all other captures pass through
 * untouched and in order.
 */
function coalesceShortHopRetries(captures: MetricCapture[]): MetricCapture[] {
  const isShortHopAttempt = (c: MetricCapture): c is TrajectoryCapture =>
    c.kind === "trajectory" &&
    c.metrics.filter((m) => REDERIVABLE_METRIC_SET.has(m)).every((m) => m === "shortHopApex") &&
    c.metrics.includes("shortHopApex");
  if (captures.filter(isShortHopAttempt).length <= 1) return captures; // nothing to coalesce

  // Registering = a valid trajectory whose shortHopApex re-derives non-null.
  const scored = captures
    .filter(isShortHopAttempt)
    .map((c) => ({ c, apex: isValidTrajectory(c.samples) ? deriveMetric("shortHopApex", c.samples) : null }));
  const registering = scored.filter((s): s is { c: TrajectoryCapture; apex: number } => s.apex !== null);
  registering.sort((a, b) => a.apex - b.apex);
  const chosen: TrajectoryCapture = registering.length
    ? registering[Math.floor((registering.length - 1) / 2)].c // lower-median registering attempt
    : scored[0].c; // every attempt missed → keep one so the main loop omits it honestly

  // Rebuild in original order: the first shortHop slot becomes `chosen`; drop the rest.
  const result: MetricCapture[] = [];
  let placed = false;
  for (const c of captures) {
    if (isShortHopAttempt(c)) {
      if (!placed) {
        result.push(chosen);
        placed = true;
      }
    } else {
      result.push(c);
    }
  }
  return result;
}

/**
 * Assemble a measurements file from raw captures. Pure. The output round-trips
 * through S5b `loadMeasurements` and passes feel / feel-provenance / feel-rederive
 * / physics-timestep (given matching acceptance physics).
 */
export function assembleMeasurements(captures: MetricCapture[]): AssembleResult {
  const metrics: Record<string, number> = {};
  const sources: FeelMeasurementSource[] = [];
  const omitted: { metric: string; reason: string }[] = [];

  // Collapse multiple canonical shortHop attempts to the median registering one
  // (drop stochastic misses) before deriving — reliability without a wrong value.
  captures = coalesceShortHopRetries(captures);

  for (const capture of captures) {
    if (capture.kind === "trajectory") {
      // Refuse bad raw evidence rather than derive a garbage value from it.
      if (!isValidTrajectory(capture.samples)) {
        for (const metric of capture.metrics) {
          omitted.push({ metric, reason: "invalid trajectory — need ≥2 strictly time-ordered samples." });
        }
        continue;
      }
      const derivable = capture.metrics.filter((m) => REDERIVABLE_METRIC_SET.has(m));
      const measuredMetrics: string[] = [];
      for (const metric of derivable) {
        // inputLatency also needs the recorded input onset (same timeline as
        // samples); deriveMetric ignores the extra arg for every other metric.
        const value = deriveMetric(metric, capture.samples, capture.inputOnsetMs);
        if (value === null) {
          // Inconclusive (e.g. a jump truncated before apex → fallGravityMultiplier,
          // or a run with no ramp/settle → runAcceleration/runDeceleration). Refuse
          // to invent a value: omit it so it is reported honestly as "not measured".
          omitted.push({
            metric,
            reason: `derivation inconclusive — the ${capture.source} trajectory does not contain the window needed to measure ${metric}.`,
          });
          continue;
        }
        metrics[metric] = round4(value);
        measuredMetrics.push(metric);
      }
      if (measuredMetrics.length === 0) continue;
      sources.push({
        source: capture.source,
        derivation: "trajectory",
        samples: capture.samples,
        sampleCount: capture.samples.length,
        captureFps: capture.captureFps,
        measuredAt: capture.measuredAt,
        projectFixedTimestepBeforeMeasurement: capture.projectFixedTimestepBeforeMeasurement,
        measurementFixedTimestep: capture.measurementFixedTimestep,
        measuredMetrics,
        // F5: carry the stimulus through when a stimulus-sensitive metric was
        // measured, so the verifier can confirm the canonical tap. Only emitted
        // when the capture actually derived a stimulus-requiring metric.
        ...(capture.stimulus && measuredMetrics.includes(capture.stimulus.metric)
          ? { stimulus: capture.stimulus }
          : {}),
        // F5: carry the input onset through when inputLatency was actually measured,
        // so §0 re-derivation can recompute the latency from samples + onset.
        ...(capture.inputOnsetMs !== undefined && measuredMetrics.includes("inputLatency")
          ? { inputOnsetMs: capture.inputOnsetMs }
          : {}),
      });
    } else if (capture.kind === "sync") {
      // Cross-modal sync (L3b/L3c). Refuse-don't-skip (the F1 invariant) is enforced
      // inside each derive fn: a degraded series (unresolved||readError), a missing
      // reference, no rising edge, or an edge-before-reference all OMIT the metric with
      // the honest reason — never a fabricated 0. Measure-only: the value lands in
      // `metrics` and, being unbanded by every profile, surfaces in `alsoMeasured` (it
      // can never enter the graded list). We deliberately emit NO trajectory re-derivation
      // source for it (not a position-trajectory metric → §0 leaves it not_applicable).
      const result =
        capture.metric === "dashToGhostMs"
          ? deriveDashToGhostLatency(capture.dashingSeries, capture.ghostSeries)
          : capture.metric === "groundContactToDustMs"
            ? deriveGroundContactToDustLatency(capture.samples, capture.dustSeries)
            : capture.metric === "inputToAnimStateLatency"
              ? deriveInputToAnimStateLatency(capture.animStateSeries, capture.inputOnsetMs, capture.targetState)
              : capture.metric === "fireIntervalMs"
                ? deriveFireIntervalMs(capture.fireSeries)
                : capture.metric === "fireInputToSpawnLatency"
                  ? deriveInputToSpawnLatency(capture.spawnSeries, capture.inputOnsetMs)
                  : capture.metric === "ttkMs"
                    ? deriveTimeToKill(capture.damageSeries, capture.deathSeries)
                    : deriveInputToSfxLatency(capture.sfxSeries, capture.inputOnsetMs);
      if (!result.ok) {
        omitted.push({ metric: capture.metric, reason: result.reason });
        continue;
      }
      metrics[capture.metric] = round4(result.latencyMs);
    } else {
      const result = interpretBisection(capture.trials);
      if (result.windowSeconds === null) {
        omitted.push({ metric: capture.metric, reason: result.reason ?? "bisection inconclusive" });
        continue;
      }
      metrics[capture.metric] = round4(result.windowSeconds);
      sources.push({
        // Bisection is owned by runtime.probe in feel-provenance; it is NOT a
        // trajectory re-derivation, so no derivation:"trajectory" marker (and
        // feel-rederive leaves it not_applicable, by design).
        source: "runtime.probe",
        sampleCount: capture.trials.length,
        captureFps: capture.captureFps,
        measuredAt: capture.measuredAt,
        projectFixedTimestepBeforeMeasurement: capture.projectFixedTimestepBeforeMeasurement,
        measurementFixedTimestep: capture.measurementFixedTimestep,
        measuredMetrics: [capture.metric],
      });
    }
  }

  return { measurements: { metrics, provenance: { sources } }, omitted };
}
