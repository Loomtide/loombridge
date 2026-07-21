/**
 * F2 — the build-side resolver (`resolveStartingParams`).
 *
 * The single definition of "starting params for this feel," replacing the
 * hand-maintained adjective→params table in `feel-presets.md`. It is the build-side
 * counterpart to the verify-side bands: deterministic math, no engine, fully
 * unit-testable.
 *
 * hybrid param model (plan §Design): everything analytically solvable is DERIVED
 * from the profile's band targets via the `feel-presets.md` §2 analytic formulas;
 * only the un-solvable remainder is read from the profile's `build.stored` block.
 *
 *   v0 (jumpSpeed) = 2 · jumpApex.target / (timeToApex.target/1000)
 *   gravityScale   = v0 / ((timeToApex.target/1000) · 9.81)
 *   moveSpeed      = runSpeed.target
 *   jumpCutMultiplier = build.stored.jumpCutMultiplier   (stored — not solvable)
 *   fixedTimestep     = build.fixedTimestep              (stored)
 *
 * Refuse-don't-skip: a profile with no `build` block, or missing a solve band, is a
 * REFUSAL (throw), never a silent default — the validator enforces the same rules at
 * load time, this guards a caller that solves a hand-built profile.
 */

import type { PlatformerFeelProfile } from "./types.js";

/** Unity 2D default gravity (m/s^2) the solve assumes. */
const UNITY_GRAVITY = 9.81;

/** The starting params a profile resolves to for the build side. */
export interface StartingParams {
  /** PlayerController horizontal speed (u/s) = runSpeed.target. */
  moveSpeed: number;
  /** Initial vertical velocity v0 (u/s), derived. */
  jumpSpeed: number;
  /** Rigidbody2D gravityScale, derived. */
  gravityScale: number;
  /** Jump-cut multiplier on early release (stored); absent if not stored. */
  jumpCutMultiplier?: number;
  /** The physics timestep the solve assumes (stored). */
  fixedTimestep: number;
}

function bandTarget(profile: PlatformerFeelProfile, metricId: string): number {
  const m = profile.metrics?.[metricId];
  if (!m || typeof m.target !== "number" || !Number.isFinite(m.target) || m.target <= 0) {
    throw new Error(
      `resolveStartingParams(${profile.id}): cannot derive — required solve band '${metricId}' is absent, non-numeric, or not a positive target (a zero/negative target would yield a non-finite/negative param).`,
    );
  }
  return m.target;
}

/**
 * Resolve the build-side starting params for a profile.
 *
 * @throws if the profile has no `build` block, or is missing a solve band — a
 * profile that cannot be solved is a refusal, not a defaulted guess.
 */
export function resolveStartingParams(profile: PlatformerFeelProfile): StartingParams {
  if (!profile.build) {
    throw new Error(
      `resolveStartingParams(${profile?.id ?? "<unknown>"}): profile has no 'build' block to resolve starting params from.`,
    );
  }

  const jumpApex = bandTarget(profile, "jumpApex"); // u
  const timeToApexMs = bandTarget(profile, "timeToApex"); // ms
  const runSpeed = bandTarget(profile, "runSpeed"); // u/s

  const timeToApexSec = timeToApexMs / 1000;
  const jumpSpeed = (2 * jumpApex) / timeToApexSec;
  const gravityScale = jumpSpeed / (timeToApexSec * UNITY_GRAVITY);

  return {
    moveSpeed: runSpeed,
    jumpSpeed,
    gravityScale,
    jumpCutMultiplier: profile.build.stored?.jumpCutMultiplier,
    fixedTimestep: profile.build.fixedTimestep,
  };
}
