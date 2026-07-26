/**
 * Measurement recipe + input-map contract (S5c).
 *
 * Measuring an EXISTING/arbitrary controller is black-box: there is no binding
 * auto-discovery, so the developer/agent DECLARES which key drives which action
 * (jump/left/right/dash/jumpCut). This module is the deterministic, offline part:
 * given an input map, it plans which metrics are measurable and which are honestly
 * "not measured" (with a reason — never silently skipped). The live driving that
 * consumes the plan is S5c-b.
 */

// MEASURABLE_METRICS, MeasurableMetric, and the canonical short-hop stimulus constants now live in
// the genre-neutral feel-primitives module (Phase 1a decoupling). Imported for this module's own use
// and re-exported below for back-compat with the platformer pack's existing consumers.
import {
  MEASURABLE_METRICS,
  type MeasurableMetric,
  SHORT_HOP_CANONICAL_TAP_TICKS,
  SHORT_HOP_TAP_TICK_TOLERANCE,
} from "../../../../domain/feel-primitives.js";

export {
  MEASURABLE_METRICS,
  type MeasurableMetric,
  SHORT_HOP_CANONICAL_TAP_TICKS,
  SHORT_HOP_TAP_TICK_TOLERANCE,
};

/** Declared key bindings for the controller under test. */
export interface InputMap {
  /** Key that triggers a jump (e.g. "Space"). */
  jump?: string;
  /** Key that moves left (e.g. "LeftArrow"). */
  moveLeft?: string;
  /** Key that moves right (e.g. "RightArrow"). */
  moveRight?: string;
  /** Key that triggers a dash (optional). */
  dash?: string;
  /** Key whose release cuts the jump short (variable-height); often == jump. */
  jumpCut?: string;
}

/**
 * How many times the driver should capture the canonical short hop. The 6-tick tap
 * registers a deterministic hop (~1.40, ± 0.001 within a session, live) but occasionally (~8% live) the
 * injection phase misaligns and the tap fails to register a jump at all (apex 0 → the
 * derivation refuses it). Capturing a few attempts and letting `assembleMeasurements`
 * keep the median REGISTERING attempt (discarding misses) makes the measurement reliable
 * (~99.9% within 3 attempts) with zero risk of a wrong value — a miss is never blended in,
 * and if EVERY attempt misses the metric still refuses honestly. This is guidance for the
 * capture driver; the pure assembler coalesces however many attempts it is given.
 */
export const SHORT_HOP_CAPTURE_ATTEMPTS = 3;

/** Convert a tap duration in milliseconds to fixed physics ticks at a given timestep. */
export function tapMsToTicks(tapMs: number, fixedTimestepSeconds: number): number {
  return tapMs / (fixedTimestepSeconds * 1000);
}

/** Which declared input keys each measurable metric requires. */
export const METRIC_INPUT_REQUIREMENTS: Record<MeasurableMetric, (keyof InputMap)[]> = {
  runSpeed: ["moveRight"],
  // accel/decel: hold moveRight to steady speed, then release and settle — same
  // run capture, derived from the rise/fall of per-tick horizontal speed.
  runAcceleration: ["moveRight"],
  runDeceleration: ["moveRight"],
  jumpApex: ["jump"],
  timeToApex: ["jump"],
  shortHopApex: ["jump", "jumpCut"],
  // fallGravityMultiplier: the rise/fall asymmetry of a full jump arc through apex
  // to ground contact — derived from the same jump capture as jumpApex/timeToApex.
  fallGravityMultiplier: ["jump"],
  // inputLatency: settle then hold moveRight; latency = onset→first horizontal motion.
  inputLatency: ["moveRight"],
  // coyote: walk off a ledge (moveRight) then jump late.
  coyoteTime: ["moveRight", "jump"],
  jumpBuffer: ["jump"],
};

/** How each metric is derived (drives the provenance source shape downstream). */
export const METRIC_DERIVATION: Record<MeasurableMetric, "trajectory" | "bisection"> = {
  runSpeed: "trajectory",
  runAcceleration: "trajectory",
  runDeceleration: "trajectory",
  jumpApex: "trajectory",
  timeToApex: "trajectory",
  shortHopApex: "trajectory",
  fallGravityMultiplier: "trajectory",
  inputLatency: "trajectory",
  coyoteTime: "bisection",
  jumpBuffer: "bisection",
};

export interface MetricPlan {
  metric: MeasurableMetric;
  /** "planned" = all required keys declared; "skipped" = a required key is missing. */
  status: "planned" | "skipped";
  requiredKeys: (keyof InputMap)[];
  derivation: "trajectory" | "bisection";
  /** Why the metric was skipped (the honest "not measured" reason). */
  reason?: string;
}

export interface MeasurementPlan {
  inputMap: InputMap;
  metrics: MetricPlan[];
}

function declaredKey(inputMap: InputMap, key: keyof InputMap): boolean {
  const value = inputMap[key];
  return typeof value === "string" && value.trim().length > 0;
}

export interface InputMapValidationResult {
  valid: boolean;
  issues: { code: string; message: string; path: string }[];
}

/** Validate the input map shape: any declared binding must be a non-empty string. */
export function validateInputMap(inputMap: unknown): InputMapValidationResult {
  const issues: InputMapValidationResult["issues"] = [];
  if (typeof inputMap !== "object" || inputMap === null || Array.isArray(inputMap)) {
    return { valid: false, issues: [{ code: "INVALID_DOCUMENT", message: "inputMap must be an object.", path: "inputMap" }] };
  }
  for (const [key, value] of Object.entries(inputMap)) {
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      issues.push({
        code: "INVALID_BINDING",
        message: `inputMap.${key} must be a non-empty key name when present.`,
        path: `inputMap.${key}`,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Plan which metrics are measurable given the declared input map. Each requested
 * metric is either `planned` (all required keys declared) or `skipped` with a
 * concrete reason naming the missing key(s) — never silently dropped.
 *
 * `requested` defaults to all `MEASURABLE_METRICS`. A requested metric with a
 * missing key becomes a `skipped` plan (the report surfaces the reason); this is
 * the honest "not measured" path, not a silent skip.
 */
export function planMeasurements(
  inputMap: InputMap,
  requested: readonly MeasurableMetric[] = MEASURABLE_METRICS,
): MeasurementPlan {
  const metrics: MetricPlan[] = requested.map((metric) => {
    const requiredKeys = METRIC_INPUT_REQUIREMENTS[metric];
    const missing = requiredKeys.filter((k) => !declaredKey(inputMap, k));
    const derivation = METRIC_DERIVATION[metric];
    if (missing.length === 0) {
      return { metric, status: "planned", requiredKeys, derivation };
    }
    return {
      metric,
      status: "skipped",
      requiredKeys,
      derivation,
      reason: `not measured — declare the input key(s) ${missing.join(", ")} to measure ${metric}.`,
    };
  });
  return { inputMap, metrics };
}
