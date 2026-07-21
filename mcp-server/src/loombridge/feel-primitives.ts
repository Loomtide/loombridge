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
