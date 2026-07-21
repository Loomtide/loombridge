/**
 * F4 — feel ↔ level coupling: derive the geometric reach envelope from a PROFILE's
 * bands (the verify-first / swap path), then run the SAME reachability geometry the
 * build-mode gate runs.
 *
 * WHY: a swap changes the jump envelope (apex, horizontal reach), which changes what
 * is reachable on a FIXED level. The `reachability` gate already proves a collectible
 * is geometrically reachable from a feel budget — but in build mode that budget comes
 * from `acceptance.feel`; the verify-first profile path (the swap scenario) never ran
 * it. This module is the seam: `envelopeFromProfile` feeds a profile's bands through
 * the unchanged `feelEnvelope` math, and `evaluateProfileReachability` runs the
 * unchanged `evaluateReachabilityEnvelope` geometry. No new reachability math.
 *
 * REFUSE-DON'T-SKIP (mirrors F2's `BUILD_SOLVE_MISSING_BAND` / solve-params): the
 * envelope's solve inputs (`jumpApex`/`timeToApex`/`runSpeed`) MUST be banded on the
 * profile, else we cannot derive an honest envelope — that is a refusal (throw), never
 * a defaulted guess. `dashDistance` is OPTIONAL (a feel with no dash contributes 0 to
 * the horizontal reach, exactly as `acceptance.feel.dashDistance ?? 0` does in build
 * mode); the vertical margin defaults to the gate's 0.5.
 */

import {
  feelEnvelope,
  evaluateReachabilityEnvelope,
  type FeelEnvelope,
  type ReachabilityLayout,
} from "../../../verification/gates/reachability.js";
import type { GateReport } from "../../../verification/gates/types.js";
import type { PlatformerFeelProfile } from "./types.js";

/** The vertical slack (u) the build-mode gate applies when `acceptance.reachability` omits it. */
export const PROFILE_REACHABILITY_VERTICAL_MARGIN_U = 0.5;

/**
 * A positive, finite band target or a refusal. Mirrors `solve-params.ts#bandTarget`:
 * an absent / non-numeric / non-positive solve band is a refusal, not a default — a
 * zero/negative jumpApex or timeToApex would yield a degenerate (or inverted) envelope.
 */
function requiredBandTarget(profile: PlatformerFeelProfile, metricId: string): number {
  const m = profile.metrics?.[metricId];
  if (!m || typeof m.target !== "number" || !Number.isFinite(m.target) || m.target <= 0) {
    throw new Error(
      `envelopeFromProfile(${profile?.id ?? "<unknown>"}): cannot derive a reach envelope — required solve band '${metricId}' is absent, non-numeric, or not a positive target. The envelope's solve inputs (jumpApex/timeToApex/runSpeed) must be banded (refuse-don't-skip).`,
    );
  }
  return m.target;
}

/** An OPTIONAL band target: returns 0 when absent (a feel with no dash), else the positive target. */
function optionalBandTarget(profile: PlatformerFeelProfile, metricId: string): number {
  const m = profile.metrics?.[metricId];
  if (!m) return 0;
  if (typeof m.target !== "number" || !Number.isFinite(m.target) || m.target < 0) {
    throw new Error(
      `envelopeFromProfile(${profile.id}): band '${metricId}' is present but its target is non-numeric or negative — refuse rather than treat a malformed optional band as 0.`,
    );
  }
  return m.target;
}

/**
 * Derive the geometric reach envelope from a profile's bands (F4). The profile is the
 * swapped feel identity; the envelope it produces is what the level must be re-checked
 * against. Reuses the SAME `feelEnvelope` solver build mode uses — only the SOURCE of
 * the budget differs (profile bands vs `acceptance.feel`).
 *
 * @throws if the solve inputs (jumpApex/timeToApex/runSpeed) are not banded.
 */
export function envelopeFromProfile(profile: PlatformerFeelProfile): FeelEnvelope {
  const jumpApex = requiredBandTarget(profile, "jumpApex"); // u
  const timeToApexMs = requiredBandTarget(profile, "timeToApex"); // ms
  const runSpeed = requiredBandTarget(profile, "runSpeed"); // u/s
  const dashDist = optionalBandTarget(profile, "dashDistance"); // u (0 if no dash)
  return feelEnvelope({
    jumpApex,
    dashDist,
    runSpeed,
    timeToApexMs,
    vMargin: PROFILE_REACHABILITY_VERTICAL_MARGIN_U,
  });
}

/**
 * Run reachability for the profile-verify path: derive the profile's envelope and
 * check the level layout against it with the UNCHANGED gate geometry. Returns the
 * gate report (its `verdict` is `pass`/`fail`/`warn`); the caller folds a `fail` into
 * the overall profile status.
 *
 * @throws (via `envelopeFromProfile`) if the profile is missing a solve band.
 */
export function evaluateProfileReachability(
  profile: PlatformerFeelProfile,
  layout: ReachabilityLayout,
): GateReport {
  return evaluateReachabilityEnvelope(layout, envelopeFromProfile(profile));
}
