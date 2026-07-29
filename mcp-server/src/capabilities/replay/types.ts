/**
 * Replay Verification — trace + report types (Phase A, slice A1).
 *
 * These are the serializable shapes for an **action trace** (the uGUI,
 * EventSystem-driven flavor
 * "Trace Flavors") and the report a replay run emits. They are pure data: the
 * deterministic engine (`engine.ts`) consumes a `ReplayTrace` + a `ReplayDriver`
 * and produces a `ReplayReport`, with no coupling to the live Unity bridge.
 *
 * Condition-anchor and assertion field names deliberately mirror the
 * `runtime.assert_condition` op input (`op-registry.ts`) so the live driver
 * (slice A3) maps them 1:1.
 */

/** Entity locator identifying a GameObject (mirrors the bridge locator shape). */
export interface Locator {
  scene?: string;
  path: string;
  globalObjectId?: string;
  instanceId?: string;
}

/** Comparators supported by condition anchors and assertions (== assert_condition). */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "approx"
  | "contains";

/** A runtime condition over a component property — shared by anchors + assertions. */
export interface ConditionSpec {
  locator: Locator;
  /** Optional component type name when asserting a component property. */
  component?: string;
  /** Runtime property path (or component property path when `component` is set). */
  property_path: string;
  operator: ConditionOperator;
  /** Expected value; JSON shape preserved (do not pre-stringify). */
  expected: unknown;
  /** Tolerance for operator=approx (default 0.001). */
  tolerance?: number;
}

/** A UI action dispatched through the EventSystem (backend-agnostic). */
export type Action =
  | { do: "tap"; locator: Locator }
  /**
   * A press → move → release drag. By default replay RELEASES at `to`'s rect
   * center (a distinct drop target the EventSystem can raycast).
   *
   * Two optional fields carry CUSTOM-gesture fidelity from the demonstration:
   * - `travelPx` — make the bridge OSCILLATE the drag to accumulate this much
   *   accumulated screen-px travel before releasing (a scrub / stir whose effect
   *   comes from distance moved, not the endpoint).
   * - `releaseNorm` — when present, replay RELEASES at this NORMALIZED screen point
   *   (x,y each in [0,1], denormalized to the live viewport at dispatch) INSTEAD of
   *   at `to`'s rect center — for a gesture whose DROP TARGET isn't a raycast element
   *   (only the release POINT identifies it, e.g. dropping onto empty canvas). Absent
   *   ⇒ release at `to`, byte-identical to a normal drag.
   */
  | {
      do: "drag";
      from: Locator;
      to: Locator;
      travelPx?: number;
      /**
       * Screen height (px) at RECORD time, paired with `travelPx`. `travelPx` is absolute
       * screen px, but the game scales screen-travel by the canvas factor (∝ screen
       * height), so the same px under-shoots on a taller device. Replay rescales
       * `travelPx × deviceHeight / travelRefHeight` so a multi-aspect re-drive reproduces
       * the same on-canvas travel. Absent ⇒ travelPx dispatched raw (legacy/base-only).
       */
      travelRefHeight?: number;
      releaseNorm?: { x: number; y: number };
    }
  /**
   * A tap on a NON-uGUI (world-space) target — a sprite/collider the game handles
   * via its own raycast + the Input System pointer, not the EventSystem. Recorded
   * faithfully, but not yet drivable: replay marks it `blocked` (needs simulated-
   * pointer input traces). Kept distinct from `tap` so it's never confused with a
   * uGUI actuation.
   */
  | { do: "world-tap"; locator: Locator }
  /**
   * Tap a key (press → release) via the SIMULATED Input System keyboard — a
   * discrete gameplay input (jump, confirm, fire). `key` is a Unity KeyCode name
   * (`"Space"`, `"LeftArrow"`, `"D"`), matching the `input.key_tap` op. Drives a
   * game reading the Input System (`Keyboard.current` / an InputAction), NOT legacy
   * `Input.GetKey`. Replay marks it `blocked` if the Input System is unavailable
   * (a legacy-only project) — never a silent pass.
   */
  | { do: "key-tap"; key: string }
  /**
   * Hold a key down for `durationMs`, then release — the gameplay MOVEMENT
   * primitive (hold `D` to walk right while physics runs). The hold is a real
   * wall-clock delay so the game's Update/FixedUpdate actually advance under the
   * held key. Same backend + blocked semantics as `key-tap`; `durationMs` is
   * clamped at parse time so a trace can't make replay hang.
   */
  | { do: "key-hold"; key: string; durationMs: number }
  /**
   * Press a key WITHOUT releasing it (the low-level edge a keyboard RECORDER emits).
   * Paired with a later `key-up`, with `wait`s between, this reproduces a human's
   * timed gameplay — including CONCURRENT keys (hold `D` while tapping `Space` =
   * key-down D · … · key-down Space · … · key-up Space · … · key-up D). Same
   * simulated-Input-System backend + `blocked` semantics as `key-tap`/`key-hold`.
   * A key left down is released when the input session closes (driver teardown).
   */
  | { do: "key-down"; key: string }
  /** Release a key pressed by an earlier `key-down` (the recorder's matching edge). */
  | { do: "key-up"; key: string }
  /**
   * A pure wall-clock delay (no input) — the gap a recorder grafts BETWEEN key
   * edges so replay reproduces the human's timing (a held key stays held across it,
   * so the game's Update/FixedUpdate advance). `durationMs` is clamped at parse time.
   */
  | { do: "wait"; durationMs: number }
  | {
      do: "wait-for-visible";
      locator: Locator;
      timeoutMs?: number;
      /**
       * A timing FLOOR (ms): once the target is visible, don't proceed until at
       * least this long has elapsed since the wait began. Lets a recorder graft a
       * human's observed inter-tap pacing onto the deterministic visibility wait —
       * so replay isn't unrealistically fast — without a fragile wall-clock replay.
       */
      minDelayMs?: number;
    }
  /**
   * Block until a runtime CONDITION over a component property holds (via
   * `runtime.wait_for_condition`) BEFORE the next action runs — the precondition
   * GATE the recorder grafts so a gesture fires only once the game can actually
   * CONSUME it. A target often becomes VISIBLE (so `wait-for-visible` passes)
   * before the game's `phase`/state flips to make the input consumable; firing on
   * visibility alone races that flip and the input is dropped. This gate samples a
   * declared STATE SIGNAL (e.g. `ChefGameManager.phase == "Pour"`) and holds until
   * it matches, so replay never out-runs the game. Field names mirror `ConditionSpec`
   * (and `runtime.wait_for_condition`) so the driver maps them 1:1.
   */
  | {
      do: "wait-for-condition";
      locator: Locator;
      component?: string;
      property_path: string;
      operator: ConditionOperator;
      expected: unknown;
      tolerance?: number;
      timeoutMs?: number;
    };

/** A gate a segment must reach before it is considered complete. */
export type Anchor =
  | { id: string; kind: "ui-visible"; locator: Locator; timeoutMs?: number }
  | ({ id: string; kind: "condition"; timeoutMs?: number } & ConditionSpec);

/** A screenshot to capture, optionally tied to an anchor (else at segment end). */
export interface Capture {
  id: string;
  /** Capture once this anchor in the same segment is reached; else at segment end. */
  atAnchor?: string;
  /**
   * Hold this long (ms) after the segment's actions before taking the screenshot, so
   * the resulting screen SETTLES (spawn/fall/transition animations) — the capture
   * reflects the settled state, not a mid-animation frame. A recorder sets it from
   * the human's observed dwell on this screen.
   */
  settleMs?: number;
}

/** A named, ordered unit of a trace: actions → anchors → captures. */
export interface Segment {
  id: string;
  actions: Action[];
  anchors?: Anchor[];
  captures?: Capture[];
  /**
   * The Unity scene ACTIVE while this segment's actions were demonstrated (a runtime scene name, e.g.
   * `StarChef`). Recorded as evidence for multi-scene verification — the verifier reads it to infer the
   * scene graph + which screen belongs to which scene; REPLAY ignores it (dispatch stays path-only via
   * `stableLocator`, so adding scene evidence never weakens replay matching). Absent ⇒ single-scene
   * (the trace's `start.scene`), back-compatible.
   */
  scene?: string;
}

/** An end-state assertion (== a condition checked after all segments). */
export interface Assertion extends ConditionSpec {
  id: string;
  /**
   * GATE: only evaluate this assertion once the locator is VISIBLE — i.e. the game
   * actually REACHED the asserted screen. Without it, an end-state assertion reads
   * whatever is there, including a SCENE-DEFAULT value on a not-yet-shown element,
   * and can false-pass. If the element never becomes visible, the assertion FAILS
   * ("state not reached") rather than silently passing on the default.
   */
  reachedWhenVisible?: boolean;
}

/**
 * A signal that a reset hook actually took effect — a UI element that must be
 * visible once the game reached its clean start. Without it a hook is trusted on
 * the bare fact that a tap actuated / a field was written, which is NOT proof the
 * reset happened (no silent green: declare a `verify` to make the hook honest).
 */
export interface ResetVerify {
  locator: Locator;
  timeoutMs?: number;
}

/**
 * A game-specific reset step (tier-2): after the scene loads, drive this to reach
 * a clean start state that a plain scene load can't reach (PlayerPrefs/save state,
 * persistent singletons, a "new game" flow). Either tap a reset/new-game UI
 * element, or set a declared reset-trigger field the developer exposes — and
 * optionally `verify` that the reset reached a known state.
 */
export type ResetHook =
  | { do: "tap"; locator: Locator; verify?: ResetVerify }
  | { do: "set"; locator: Locator; component: string; property: string; value?: unknown; verify?: ResetVerify };

/**
 * How replay returns the build to a known start state:
 * - `scene-load` (tier-1) — a clean scene load fully determines the start state;
 * - `relaunch` (tier-3) — force the fullest runtime restart available;
 * - `{ hook }` (tier-2) — scene load + a declared reset hook.
 */
export type ResetSpec = "scene-load" | "relaunch" | { hook: ResetHook };

/** A complete action trace. */
export interface ReplayTrace {
  schemaVersion: "0.1";
  id: string;
  title?: string;
  intent?: string;
  start: { scene: string; reset: ResetSpec };
  /**
   * The driving backend, gate-checked by the engine:
   * - `ui-events` — uGUI taps/drags through the EventSystem (backend-agnostic);
   *   `world-tap` lives here too (simulated-pointer fallback).
   * - `input-system` — gameplay driven by the SIMULATED Input System keyboard
   *   (`key-tap`/`key-hold`); the driver verifies the Input System is available
   *   (`input.get_capabilities`) and blocked-degrades a legacy-only project.
   * uGUI taps still dispatch under either, so a menu→gameplay trace can mix them.
   */
  input: { backend: "ui-events" | "input-system" };
  segments: Segment[];
  assertions?: Assertion[];
  /**
   * DESCRIPTIVE metadata only. The machine-checked contract is carried entirely
   * by the segment anchors and end-state assertions (a negative-flow trace
   * encodes its expected failure state as anchors — e.g. "fail modal visible").
   * The engine does NOT invert its verdict on `expected`; richer
   * success/failure-outcome semantics are a deliberate future extension.
   */
  outcome: { expected: "success" | "failure" };
}

// ───────────────────────────── report ─────────────────────────────

export type ReplayStatus = "pass" | "fail" | "blocked";

/** Why a replay never produced a pass/fail verdict (it was undrivable). */
export type BlockedReason =
  | "unsupported-input-backend"
  | "reset-unavailable"
  /** A step needs a capability not yet built — e.g. a world-space (non-uGUI) tap. */
  | "world-input-unsupported"
  /** A keyboard action ran, but the Input System keyboard is unavailable (legacy-only project). */
  | "keyboard-input-unsupported";

/** The reset strategy actually used (see design "Reset Contract"). */
export type ResetTier = "scene-load" | "hook" | "relaunch";

export type DivergenceKind =
  | "anchor-missed"
  | "action-failed"
  | "assertion-failed"
  | "console-error";

/** The first place the replay diverged from the trace's expectations. */
export interface FirstDivergence {
  segment: string | null;
  /** Index of the action/anchor within the segment, when applicable. */
  step?: number;
  kind: DivergenceKind;
  expected: string;
  actual: string;
}

/**
 * `unreadable` is the HARNESS tier, deliberately distinct from `drift`: a PNG that
 * cannot be decoded (truncated write, zero-byte capture, a corrupted baseline) says
 * nothing about the game, and reporting it as drift is exactly the
 * "harness fault presented as a game defect" failure this repo refuses.
 */
export type VisualCaptureStatus = "match" | "drift" | "no-baseline" | "unreadable";

export interface CaptureResult {
  id: string;
  artifact?: string;
  sha256?: string;
  /** Approved baseline PNG path, when one exists (set by the verb, not the engine). */
  baseline?: string;
  /** Fraction of perceptually-differing pixels vs the baseline, in [0,1]. */
  diffFraction?: number;
  /** Visual regression verdict vs the baseline (set post-replay by the verb). */
  visualStatus?: VisualCaptureStatus;
  /**
   * A3: the tolerance that DECIDED `visualStatus` for this capture. Stamped only where a
   * comparison actually happened, so a reader can tell "matched at the default" from
   * "matched only because a human approved 2%" without going to the manifest.
   */
  toleranceUsed?: number;
}

export interface SegmentResult {
  id: string;
  /** `blocked`: a step needed a missing capability (e.g. world-space tap) — not a regression. */
  status: "pass" | "fail" | "blocked" | "not_reached";
  anchorsReached: string[];
  captures: CaptureResult[];
}

export interface AssertionResult {
  id: string;
  status: "pass" | "fail" | "not_reached";
}

export interface ConsoleResult {
  status: "pass" | "fail";
  errorCount: number;
  errors: string[];
}

/** The report a replay run emits for one trace. */
export interface ReplayReport {
  traceId: string;
  status: ReplayStatus;
  /** The reset strategy used, or null if replay never reset (blocked early). */
  resetTier: ResetTier | null;
  blockedReason?: BlockedReason;
  /**
   * Free-text detail for a blocked run: WHICH underlying step failed and why. The enum
   * alone ("reset-unavailable") tells a user nothing they can act on.
   */
  blockedDetail?: string;
  firstDivergence?: FirstDivergence;
  /** True if any captured screenshot drifted from its approved baseline. */
  visualDrift?: boolean;
  /**
   * True if any capture's visual comparison could not be made because a PNG (actual
   * or baseline) was unreadable: a CAPTURE GAP, not drift. Read by `replayExitCode`
   * to tier the run at 2 (harness) instead of 1 (game). Optional and absent by
   * default, so a report written before this field existed still parses.
   */
  visualHarnessFault?: boolean;
  /**
   * A3: the pixel tolerance this RUN graded at, resolved from the approved baseline
   * manifest (absent field = the 0.5% default). Recorded per run as well as per capture
   * so the report answers "what were the terms?" even for a run in which nothing drifted.
   * Absent when no baseline existed to grade against.
   */
  toleranceUsed?: number;
  /**
   * The pacing this run replayed at (1 = the demonstration's own pacing). Stamped on
   * every run; a baseline approved from this report inherits it, and a later replay at
   * a different pacing refuses the pixel comparison rather than grading phase skew.
   */
  replaySpeed?: number;
  segments: SegmentResult[];
  assertions: AssertionResult[];
  console: ConsoleResult;
}

/** A `ReplayReport` plus the run timestamps the runner/CLI stamps on write. */
export interface ReplayRunArtifact extends ReplayReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
