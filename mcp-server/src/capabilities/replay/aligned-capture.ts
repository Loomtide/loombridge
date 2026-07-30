/**
 * Capture-aligned replay: the shared vocabulary of the aligned settle.
 *
 * ONE module owns the numbers and sentences the aligned mode is defined by, because they
 * are read from four places that must not disagree: the CLI flag parser, the baseline
 * manifest reader, the live driver, and the drift report. A range or a conversion spelled
 * independently in two of those is how a stamped anchor and a live run come to mean
 * different things.
 *
 * WHAT ALIGNMENT IS. A wall-clock settle (sleep N ms, then screenshot) lets the game
 * free-run for however many frames the editor happens to tick in that window, so the GAME
 * TIME at the capture varies run to run. Aligned mode replaces the pair with one bridge op
 * (`replay.settle_and_capture`) that advances a fixed number of frames at a pinned game-time
 * step and captures on the last of them.
 *
 * WHAT IT IS NOT. It aligns the SETTLE only. It does not align the driver's action round
 * trips or its anchor polling, and it cannot touch seed-driven (unseeded `Random`,
 * autoRandomSeed particles) or realtime-driven (`realtimeSinceStartup`, `DateTime`,
 * `Stopwatch`) nondeterminism. That residual is stated wherever a reader could otherwise
 * over-read a result, which is why {@link ALIGNED_RESIDUAL_SENTENCE} lives here too.
 */

/** The fps an aligned replay pins to when `--aligned` is given with no explicit rate. */
export const DEFAULT_ALIGNED_CAPTURE_FPS = 60;

/**
 * The accepted capture-rate range, [10, 120].
 *
 * Below 10 a single settle frame is over 100ms of game time, so the "exact frame" the
 * capture lands on is a coarse bucket and the alignment buys little. Above 120 the editor
 * has to deliver more ticks than a backgrounded editor reliably can inside the settle's wall
 * budget, so the deadline (a harness fault) starts firing on healthy games. Integers only:
 * `Time.captureDeltaTime = 1/fps` is a step the whole run is stated in, and a fractional rate
 * makes the frame count of a settle unreproducible from the report.
 */
export const MIN_ALIGNED_CAPTURE_FPS = 10;
export const MAX_ALIGNED_CAPTURE_FPS = 120;

/**
 * Range/type refusal for an aligned capture fps, shared by the flag parser and the manifest
 * reader (the pattern `replaySpeedRefusal` set). NON-COERCING: `"60"`, `true` and `null` are
 * refused as wrong types rather than run through `Number()`, because a value that happens to
 * parse is still one nobody validated. `undefined` is the only absence, and absence means
 * the legacy wall-clock discipline.
 */
export function alignedCaptureFpsRefusal(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `'alignedCaptureFps' must be a finite number (got ${JSON.stringify(value) ?? typeof value})`;
  }
  if (!Number.isInteger(value)) {
    return `'alignedCaptureFps' must be an integer (got ${value}); the settle's frame count has to be reproducible from the report`;
  }
  if (value < MIN_ALIGNED_CAPTURE_FPS || value > MAX_ALIGNED_CAPTURE_FPS) {
    return (
      `'alignedCaptureFps' is ${value}, outside [${MIN_ALIGNED_CAPTURE_FPS}, ${MAX_ALIGNED_CAPTURE_FPS}]: ` +
      "below the floor one settle frame is a coarse bucket of game time, above the ceiling the editor " +
      "cannot reliably deliver the ticks inside the settle's wall budget"
    );
  }
  return null;
}

/**
 * The frame count an aligned settle advances for a trace settle of `settleMs`.
 *
 * ORDER MATTERS, and this is the whole reason the conversion is a named function: it runs
 * AFTER `scaleTraceSettles` has applied `--speed` and its floor, never before and never
 * both. Scaling frames as well as milliseconds would divide the settle twice, and a replay
 * at 4x would capture at a quarter of the intended settle while the report claimed the
 * trace's own.
 *
 * A missing or zero settle still yields ONE frame: the capture happens INSIDE the tick loop,
 * so there has to be a frame to capture on, and one pinned frame is the smallest honest
 * settle rather than a special no-settle path.
 */
export function alignedSettleFrames(settleMs: number | undefined, fps: number): number {
  if (settleMs === undefined || !Number.isFinite(settleMs) || settleMs <= 0) return 1;
  return Math.max(1, Math.round((settleMs * fps) / 1000));
}

/**
 * How close to a whole number of physics steps still counts as "whole", RELATIVE to the
 * count itself.
 *
 * It has to be relative, and 1e-6 (an absolute epsilon) was the bug: a project whose
 * `fixedDeltaTime` was typed by hand as `0.0166667` puts 60 fps at 0.999998 steps per frame,
 * which is 2e-6 away from 1 and therefore "uneven", and no multiple of it lands on a whole
 * number inside 120 frames either. The note then printed "physics steps 1.000 times per
 * frame ... which never lands on a whole frame", contradicting itself in one sentence. A
 * 0.1% relative window reads the hand-typed value as the whole step it plainly is, while
 * still catching the real case this exists for (60 fps against a 0.02 step is 0.833 steps
 * per frame: 17% off, three orders of magnitude outside the window).
 */
const WHOLE_STEP_RELATIVE_TOLERANCE = 1e-3;

/** Is `value` a whole number within {@link WHOLE_STEP_RELATIVE_TOLERANCE} of itself? */
function isWholeStepCount(value: number): boolean {
  const nearest = Math.round(value);
  if (nearest < 1) return false;
  return Math.abs(value - nearest) <= WHOLE_STEP_RELATIVE_TOLERANCE * nearest;
}

/**
 * The settle floor AS THE GAME ACTUALLY EXPERIENCES IT under an aligned clock, in ms.
 *
 * A wall-clock floor is a millisecond count the driver sleeps for. An aligned floor is a
 * FRAME COUNT, so the game time it buys is quantized to 1/fps and only equals the stated
 * floor when the floor divides evenly by the frame: 250ms at 60 fps is exactly 15 frames
 * (250ms), but at 30 fps it rounds to 8 frames, which is 266.7ms of game time. Printing the
 * wall-clock constant in an aligned run would state a number the run never used, and the
 * frame count is the reproducible fact.
 */
export function alignedFloorMs(floorMs: number, fps: number): number {
  return (alignedSettleFrames(floorMs, fps) / fps) * 1000;
}

/**
 * ADVISORY, NEVER A REFUSAL. Returns the physics-cadence note when a pinned 1/fps step does
 * not sit on a whole number of physics steps, and null when it does.
 *
 * Why advisory: an uneven cadence does not make the run wrong, it makes it different from a
 * recording taken at the editor's own rate, and only a feel-sensitive trace will notice.
 * Refusing would block a replay over a trade-off the operator is entitled to make; silence
 * would let a changed cadence read as pixel drift. So it says exactly what the cadence is
 * and leaves the judgement with the reader.
 *
 * The caller passes the project's REAL `Time.fixedDeltaTime` (the bridge returns it with
 * every aligned capture), never an assumed 0.02: an advisory computed against a default the
 * project does not use is worse than no advisory.
 */
export function physicsCadenceNote(fps: number, fixedDeltaTime: number): string | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  if (!Number.isFinite(fixedDeltaTime) || fixedDeltaTime <= 0) return null;
  const frameSec = 1 / fps;
  const stepsPerFrame = frameSec / fixedDeltaTime;
  if (isWholeStepCount(stepsPerFrame)) {
    return null;
  }
  // Express the cadence as the smallest whole "N steps every M frames" that lands on an
  // integer, so the note is a fact a reader can check rather than a rounded rate.
  for (let frames = 1; frames <= MAX_ALIGNED_CAPTURE_FPS; frames++) {
    const steps = (frames * frameSec) / fixedDeltaTime;
    if (isWholeStepCount(steps)) {
      return (
        `physics steps ${Math.round(steps)} times every ${frames} frame(s) at ${fps} fps ` +
        `(fixedDeltaTime ${fixedDeltaTime}); feel-sensitive traces may differ from the recording`
      );
    }
  }
  return (
    `physics steps ${stepsPerFrame.toFixed(3)} times per frame at ${fps} fps ` +
    `(fixedDeltaTime ${fixedDeltaTime}), which never lands on a whole frame; ` +
    "feel-sensitive traces may differ from the recording"
  );
}

/**
 * THE HONEST RESIDUAL, in one sentence, printed wherever an aligned run still drifts.
 *
 * It exists to stop the strongest available over-reading: "we aligned the clock and it still
 * drifts, therefore the game is nondeterministic". Two windows in every replay are still
 * unaligned (the action round trips and the 150ms anchor polling), so a persisting drift is
 * CONSISTENT WITH seed- or realtime-binding without being evidence of it.
 */
export const ALIGNED_RESIDUAL_SENTENCE =
  "aligned replay still drifts: this mode aligns the capture SETTLE only, so the action " +
  "round trips and the anchor polling between segments are still wall-clock windows. The " +
  "drift is consistent with those windows, or with the game animating from realtime " +
  "(realtimeSinceStartup/DateTime) or unseeded randomness, and is NOT proof of either; " +
  "masks or a tolerance are the remaining levers.";
