/**
 * Replay Verification — the driver seam (Phase A, slice A1).
 *
 * `ReplayDriver` is the boundary between the deterministic replay engine
 * (`engine.ts`) and whatever actually drives the game. The engine owns all
 * orchestration/decision logic; the driver only performs single, side-effecting
 * steps and reports their outcome. This keeps the engine pure and unit-testable
 * against a `FakeDriver`, while the live `UnityDriver` (slice A3) is a thin
 * adapter whose methods map 1:1 onto existing bridge ops:
 *
 *   reset           → editor.play + scene.open_scene
 *   dispatch        → ui.dispatch_pointer
 *   waitForAnchor   → ui.get_screen_rects (ui-visible) | runtime.wait_for_condition
 *   capture         → editor.screenshot { outputPath }
 *   evaluateAssertion → runtime.assert_condition
 *   readConsole     → editor.console_logs
 */

import type {
  Action,
  Anchor,
  Assertion,
  BlockedReason,
  ResetSpec,
  ResetTier,
} from "./types.js";

export interface CapabilityResult {
  supported: boolean;
  /** Present (and `unsupported-input-backend`) when `supported` is false. */
  reason?: BlockedReason;
}

export interface ResetResult {
  ok: boolean;
  /** The tier actually used when `ok`; omitted on failure. */
  tier?: ResetTier;
  /** Present (and `reset-unavailable`) when `ok` is false. */
  reason?: BlockedReason;
  /**
   * WHICH step of the reset cycle failed, and why. The bare enum reason says only that a
   * reset did not happen; diagnosing a real case (the driver was talking to a different
   * editor, so opening the scene failed) meant reading the source and hand-driving the
   * five ops. Carry the underlying error so the report can say it.
   */
  detail?: string;
}

export interface DispatchResult {
  ok: boolean;
  /** Human-readable observation, used as the divergence `actual` on failure. */
  detail?: string;
  /**
   * The action could not be driven because a CAPABILITY is missing (not a
   * regression) — e.g. a world-space tap that needs simulated-pointer input. The
   * engine marks the step `blocked` (never a silent pass) and continues the run
   * rather than failing the trace.
   */
  blocked?: boolean;
  /**
   * WHICH capability was missing, when the driver knows better than the engine's
   * action-shaped guess. The engine derives a reason from the ACTION (a world-tap that
   * blocks is `world-input-unsupported`), which is right for a missing backend and wrong for
   * a Game View that lost focus: the capability exists, the machine was not in a state to
   * use it. A driver that observed the real cause names it here and the engine prefers it.
   */
  blockedReason?: BlockedReason;
  /**
   * Verbatim actuation evidence from a uGUI `ui.dispatch_pointer` (tap/drag) — the
   * fields the interaction-flow gate's `flow.json` records (`actuated`/`handlerTarget`/
   * `raycastHit`/`handlersFired`). Populated only for EventSystem dispatches; absent
   * for world-tap/key/wait. The engine ignores it; `minigame capture` records it so a
   * flow gate's evidence is the REAL dispatch result, never a fabricated value.
   */
  raw?: {
    actuated?: boolean;
    /** The element whose handler fired, as a `Scene:/Path` locator (may be an ancestor of the tapped leaf). */
    handlerTarget?: string;
    /** Whether the screen-point raycast hit a UI graphic (a boolean, NOT a target path). */
    raycastHit?: boolean;
    handlersFired?: string[];
  };
}

export interface AnchorResult {
  reached: boolean;
  /** Observed state, used as the divergence `actual` when not reached. */
  actual?: string;
}

export interface CaptureOutcome {
  artifact?: string;
  sha256?: string;
  /**
   * The capture step failed in the HARNESS: no frame, or no frame worth grading. Set by the
   * aligned settle when the editor missed the settle's wall-clock budget (the bridge returns
   * an error rather than a frame at an unknown game time). The engine records it on the
   * capture so the run is tiered as a harness fault instead of quietly reporting one fewer
   * comparison.
   */
  harnessFault?: string;
  /** Frames the aligned settle advanced before the capture (aligned mode only). */
  framesElapsed?: number;
}

export interface AssertionOutcome {
  pass: boolean;
  /** Observed value, used as the divergence `actual` on failure. */
  actual?: string;
}

export interface ConsoleOutcome {
  errorCount: number;
  errors: string[];
}

/** The single-step contract the engine drives. All methods are async. */
export interface ReplayDriver {
  /** Gate the trace's input backend before any driving (the precondition). */
  capabilityCheck(backend: string): Promise<CapabilityResult>;
  /** Return the build to a known start state. */
  reset(start: { scene: string; reset: ResetSpec }): Promise<ResetResult>;
  /** Perform one UI action. */
  dispatch(action: Action): Promise<DispatchResult>;
  /** Wait (within the anchor's timeout) until the anchor is observed. */
  waitForAnchor(anchor: Anchor): Promise<AnchorResult>;
  /** Capture a screenshot artifact identified by `id`, after an optional settle. */
  capture(id: string, settleMs?: number): Promise<CaptureOutcome>;
  /** Evaluate one end-state assertion. */
  evaluateAssertion(assertion: Assertion): Promise<AssertionOutcome>;
  /** Read console error health. */
  readConsole(): Promise<ConsoleOutcome>;
  /**
   * Release any driver-owned resources after a run (whether it passed, failed, or
   * threw) — e.g. close an input session opened to drive keyboard actions. Optional
   * (most drivers hold nothing); the engine always calls it in a `finally` and
   * swallows its errors, so teardown can never flip or mask a verdict.
   */
  teardown?(): Promise<void>;
}
