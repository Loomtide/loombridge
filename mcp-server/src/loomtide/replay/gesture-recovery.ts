/**
 * Closed-loop adaptive gesture replay (a core replay capability).
 *
 * A "continuous" gesture — a stir, a scrub, a charge-up drag — is recorded as an ACCUMULATED travel
 * scalar (`travelPx`), not a path. On replay the bridge synthesizes an oscillating scrub and rescales
 * `travelPx` by device height; on an extreme aspect (a stir recorded at 16:9 replayed on 20:9) that
 * open-loop reproduction can under-deliver the travel the game's gesture detector needs, so the game
 * never advances and the run STALLS on that screen.
 *
 * The fix closes the loop on the game's OWN state signal. The recorder already gates each gesture with
 * a `wait-for-condition` (the phase enum reaching the next value). So instead of trusting a single
 * blind reproduction, we drive the gate and — if it doesn't pass — RE-DRIVE the preceding continuous
 * gesture with ESCALATING travel until the phase advances or a bounded budget is spent. This is
 * self-correcting for ANY gesture-driven game on ANY aspect, independent of the open-loop fidelity.
 *
 * It is a strict superset of the old behavior: with no continuous gesture to retry (a tap-advance
 * game, or a gate that isn't preceded by a scrub), it is exactly one dispatch. A gate that genuinely
 * can't be satisfied still fails after the budget — honest, never a fabricated pass.
 */

import type { Action } from "./types.js";
import type { DispatchResult, ReplayDriver } from "./driver.js";

/** A continuous scrub gesture whose EFFECT is travel-accumulation (a stir/scrub), re-drivable with more travel. */
export type ContinuousGesture = Extract<Action, { do: "drag" }> & { travelPx: number };

/** True for a drag carrying a positive `travelPx` — the only gestures worth re-driving (a position
 *  drop or a plain A→B drag has no travel to escalate, so re-driving it changes nothing). */
export function isContinuousGesture(action: Action | undefined | null): action is ContinuousGesture {
  return !!action && action.do === "drag" && typeof action.travelPx === "number" && action.travelPx > 0;
}

/**
 * Whether an action lets a pending continuous gesture stay re-drivable by a LATER gate. Only the
 * waits do (the recorder inserts `wait-for-visible`/`wait-for-condition` between a gesture and the
 * gate it advances). Any DISCRETE INPUT in between (a tap, a key, a position drag) means the gate is
 * advanced by THAT input, not the earlier scrub — so the caller must clear `lastGesture`, or a gate
 * whose real advancing input is a tap could be falsely "recovered" by re-driving a stale, unrelated
 * gesture (masking a broken tap transition + driving the wrong screen). Default-deny: only the two
 * waits preserve; everything else (incl. an unknown future input kind) clears.
 */
export function preservesPendingGesture(action: Action): boolean {
  return action.do === "wait" || action.do === "wait-for-visible" || action.do === "wait-for-condition";
}

export interface GestureRecoveryOptions {
  /** Max re-drive attempts after the first failed gate (default 4). */
  maxAttempts?: number;
  /** Multiply `travelPx` by this each attempt so a stuck gesture escalates its scrub (default 1.5). */
  travelEscalation?: number;
  /**
   * Hard cap on escalated travel as a multiple of the RECORDED travel (default 2.5×). This bounds the
   * recovery to CORRECTING the imperfect height-only rescale on a different aspect — NOT brute-forcing
   * a game past a gate a faithful gesture genuinely can't reach (which would launder a real "this
   * aspect stalls" regression into green; the device-aspect/notReached moat is meant to catch that).
   * Beyond the cap the gate is left to fail honestly → an honest can't-verify on that aspect.
   */
  maxTravelMultiple?: number;
  /** Per-retry gate re-check timeout (ms). Kept short so a stuck run doesn't wait the full gate
   *  timeout on every attempt — the first dispatch already gave the game its full settle budget. */
  recheckTimeoutMs?: number;
  /** Optional progress callback (attempt index, escalated travelPx) for logging/tests. */
  onRetry?: (attempt: number, travelPx: number) => void;
}

const DEFAULTS = { maxAttempts: 4, travelEscalation: 1.5, maxTravelMultiple: 2.5, recheckTimeoutMs: 1500 };

/**
 * Dispatch a `wait-for-condition` phase gate with adaptive gesture recovery. Returns the final gate
 * result. If the gate fails AND `lastGesture` is a continuous gesture, re-drive that gesture with
 * escalating travel and re-check, up to the budget. Pure orchestration over the injected `driver` —
 * unit-testable with a fake driver.
 */
export async function dispatchConditionWithGestureRecovery(
  driver: Pick<ReplayDriver, "dispatch">,
  conditionAction: Extract<Action, { do: "wait-for-condition" }>,
  lastGesture: Action | undefined | null,
  options: GestureRecoveryOptions = {},
): Promise<DispatchResult> {
  const first = await driver.dispatch(conditionAction);
  // Exempt a BLOCKED gate (a missing capability / harness fault, not a stall) — re-driving a gesture
  // can't fix it, and recovery must never turn a harness gap into a swallowed result. And only a
  // continuous gesture is re-drivable.
  if (first.ok || first.blocked || !isContinuousGesture(lastGesture)) return first;

  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const escalation = options.travelEscalation ?? DEFAULTS.travelEscalation;
  const recheckTimeoutMs = options.recheckTimeoutMs ?? DEFAULTS.recheckTimeoutMs;
  const maxTravel = lastGesture.travelPx * (options.maxTravelMultiple ?? DEFAULTS.maxTravelMultiple);

  let travelPx = lastGesture.travelPx;
  let last = first;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    travelPx = Math.min(travelPx * escalation, maxTravel); // bounded — never brute-force past the cap
    options.onRetry?.(attempt, travelPx);
    // Re-drive the SAME gesture with more scrub. Its precondition still holds (the gate it advances
    // toward hasn't passed, so the game is still in the gesture's phase). A drag dispatch that reports
    // not-actuated is NOT fatal here — we always re-check the gate, since the scrub may still have
    // nudged the game's accumulator even if no discrete handler "fired".
    await driver.dispatch({ ...lastGesture, travelPx });
    last = await driver.dispatch({ ...conditionAction, timeoutMs: recheckTimeoutMs });
    if (last.ok) return last;
    if (travelPx >= maxTravel) break; // hit the travel cap — a further attempt adds no scrub; fail honestly
  }
  return last;
}
