import type { FeelMeasurementStimulus, FeelTrajectorySample } from "../../verification/gates/feel.js";
import type { FeelCaptureRuntimeGuardResult } from "./runtime-guard.js";

export type FeelCaptureCoverageStatus =
  | "planned"
  | "measured"
  | "attempted-blocked"
  | "unsupported"
  | "not-measured";

export interface FeelCaptureLocator {
  scene?: string;
  path: string;
  globalObjectId?: string;
  instanceId?: string;
}

export interface FeelCaptureCoverageEntry {
  metric: string;
  status: FeelCaptureCoverageStatus;
  reason?: string;
  interactionId?: string;
  source?: string;
}

export interface FeelCaptureSignal {
  id: string;
  locator: FeelCaptureLocator;
  type_name: string;
  property_path?: string;
  method_name?: string;
  args?: unknown[];
  /**
   * When true, the live runner may re-resolve the locator until it appears. This
   * is for transient VFX/signals and must be visible in provenance; it never turns
   * absent evidence into a pass.
   */
  reResolveUntilFound?: boolean;
}

export type FeelSemanticProbeMetric = "coyoteTime" | "jumpBuffer";

export type FeelSemanticAnchorKind =
  | "ground-lost"
  | "grounded-ready"
  | "jump-input"
  | "pre-jump-buffered-input";

export interface FeelSemanticAnchor {
  id: string;
  kind: FeelSemanticAnchorKind;
  /** Phase boundary in every trial where this semantic event is expected to occur. */
  phaseIndex: number;
}

export interface FeelSemanticProbeDriver {
  locator: FeelCaptureLocator;
  type_name: string;
  property_path: string;
  value: number | boolean;
}

export interface FeelSemanticProbePhase {
  durationMs: number;
  drivers?: FeelSemanticProbeDriver[];
}

export interface FeelSemanticProbeTrial {
  /** Coyote delay after ground-lost, or jump-buffer lead time before grounded-ready. */
  delayMs: number;
  phases: FeelSemanticProbePhase[];
}

export interface FeelSemanticJumpEvidenceSpec {
  kind: "trajectory-rise";
  /** Anchor that starts the post-event jump observation window. */
  afterAnchorId: string;
  /** Minimum positive Y rise, in world units, required to classify the trial as jumped. */
  minRise?: number;
}

/**
 * Generic "wait until the measured subject is at rest" precondition for a single
 * interaction. It uses ONLY observable subject motion (the sampled trajectory of the
 * measure locator) — never a game-specific grounded flag or input backend — so it
 * generalizes across jump-bearing keyboard and pointer/uGUI games whose probe begins
 * while the subject is still falling.
 *
 * The runner observes the subject (no input injected) and accepts rest only when the
 * trailing window's per-sample displacement stays under `restThreshold` for at least
 * `minStableSamples` samples and `minStableMs` milliseconds within `timeoutMs`. Absent
 * or empty observation evidence is a REFUSAL (the dependent interaction is
 * `attempted-blocked`), never a silent pass.
 */
export interface FeelCaptureSettleSpec {
  kind: "settle-until-rest";
  /** Subject whose sampled trajectory proves rest. Should match the interaction's measure. */
  measure: FeelCaptureLocator;
  /** Bounded total budget for settling, in ms. Conservative default applied by the runner. */
  timeoutMs?: number;
  /** Length of each observation probe window, in ms. */
  pollMs?: number;
  /** Minimum consecutive low-displacement samples that count as rested. */
  minStableSamples?: number;
  /** Minimum trailing low-displacement duration that counts as rested. */
  minStableMs?: number;
  /** Max per-sample displacement (world units) that still counts as resting. */
  restThreshold?: number;
}

export type FeelCaptureInteraction =
    | {
        id: string;
        kind: "keyboard";
        measure: FeelCaptureLocator;
        settle?: FeelCaptureSettleSpec;
        phases: { keys?: string[]; durationMs?: number; fixedTicks?: number }[];
        sampledFields?: FeelCaptureSignal[];
      }
  | {
      id: string;
      kind: "ugui-tap";
      measure: FeelCaptureLocator;
      target: FeelCaptureLocator;
      settleMs?: number;
      captureMs?: number;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "ugui-multitap";
      measure: FeelCaptureLocator;
      target: FeelCaptureLocator;
      taps: { atMs: number }[];
      captureMs?: number;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "ugui-hold-drag";
      measure: FeelCaptureLocator;
      target: FeelCaptureLocator;
      dragTo: { dx: number; dy: number };
      settleMs?: number;
      captureMs?: number;
      releaseMs?: number;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "ugui-hold";
      measure: FeelCaptureLocator;
      target: FeelCaptureLocator;
      holdFixedTicks: number;
      settle?: FeelCaptureSettleSpec;
      settleMs?: number;
      captureMs?: number;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "world-pointer";
      measure: FeelCaptureLocator;
      x: number;
      y: number;
      captureMs?: number;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "trace-replay";
      traceId: string;
      state?: string;
      sampledFields?: FeelCaptureSignal[];
    }
  | {
      id: string;
      kind: "semantic-probe";
      metric: FeelSemanticProbeMetric;
      measure: FeelCaptureLocator;
      anchors: FeelSemanticAnchor[];
      trials: FeelSemanticProbeTrial[];
      jumpEvidence: FeelSemanticJumpEvidenceSpec;
      captureFps?: number;
    }
  | {
      id: string;
      kind: "unsupported";
      reason: string;
    };

export interface FeelMetricRecipe {
  metric: string;
  interactionId?: string;
  derivation:
    | "trajectory"
    | "phase-delta"
    | "bisection"
    | "reported"
    | "sync"
    | "trace"
    | "unsupported";
  deriveAs?: string;
  /** For phase-delta derivations, the captured input phase to measure. */
  phaseIndex?: number;
  /** For phase-delta derivations, which transform axis delta to use. Defaults to x. */
  axis?: "x" | "y";
  /** For phase-delta derivations, keys that must be held in the selected phase. */
  requiredKeys?: string[];
  /** For sync derivations, the fieldTimeline id to use as the target series. */
  seriesId?: string;
  /** For series-to-series sync derivations such as dash-to-ghost. */
  referenceSeriesId?: string;
  /** For categorical state sync, the value that counts as entering the target state. */
  targetValue?: number | boolean;
  /** Machine-checkable convention for stimulus-sensitive metrics such as shortHopApex. */
  stimulus?: FeelMeasurementStimulus;
  reason?: string;
}

export interface FeelCaptureSubject {
  id: string;
  locator: FeelCaptureLocator;
  role?: string;
}

export type FeelCapturePrecondition =
  | {
      kind: "scene-set-active";
      locator: FeelCaptureLocator;
      active: boolean;
      /**
       * Restore the object's pre-capture activeSelf after Play Mode stops. Defaults
       * true so setup can temporarily enable inactive mobile controls without
       * leaving the developer's scene changed.
       */
      restore?: boolean;
    };

export interface FeelCaptureContract {
  schemaVersion: "1";
  game?: string;
  subjects: FeelCaptureSubject[];
  preconditions?: FeelCapturePrecondition[];
  interactions: FeelCaptureInteraction[];
  metrics: FeelMetricRecipe[];
  signals?: FeelCaptureSignal[];
  coverage?: FeelCaptureCoverageEntry[];
}

export interface FeelCaptureRawResult {
  interactionId: string;
  kind: FeelCaptureInteraction["kind"];
  source: string;
  status: "measured" | "attempted-blocked" | "unsupported";
  reason?: string;
  data?: Record<string, unknown>;
  samples?: FeelTrajectorySample[];
  inputOnsetMs?: number;
}

export interface FeelCaptureRunResult {
  measurements: {
    metrics: Record<string, number>;
    provenance: {
      note: string;
      runtimeGuard?: FeelCaptureRuntimeGuardResult;
      sources: Record<string, unknown>[];
    };
    captureCoverage: FeelCaptureCoverageEntry[];
  };
  raw: FeelCaptureRawResult[];
}
