/**
 * 2D Kids Mini-Game verification contract (S6a — Visual/Mini-Game Contract).
 *
 * A *mini-game contract* is a product-owned, per-game description of the
 * machine-checkable facts a kids mini-game release must satisfy: required
 * objects visible, UI inside the safe area, tap targets large enough for the
 * declared age band, a happy-path flow that reaches a reward, and clean frames.
 * It is the S6 counterpart to the S5 platformer *profile*: where a profile grades
 * one feel family against bands, this contract grades one mini-game against a
 * named set of deterministic visual/UI/interaction checks (S6 plan §Deliverables 1).
 *
 * Design rule (anti-false-green, mirroring CLAUDE.md "Verification / supervisor
 * invariants" — an absent binding is a REFUSAL, never a skipped check):
 *   - a contract that declares NO deterministic checks is refused (`NO_DETERMINISTIC_CHECKS`);
 *   - a contract with NO states or NO required-in-frame objects is refused
 *     (`MISSING_STATES` / `MISSING_REQUIRED_OBJECTS`) — there is nothing to verify;
 *   - a tap target below the ergonomic floor for the declared age band is refused
 *     (`IMPOSSIBLE_TAP_TARGET`) — an unreachable bar would always "pass" or always fail;
 *   - every gate/check name is from a CLOSED vocabulary, so a typo can't silently
 *     disable a check (`UNSUPPORTED_CHECK`).
 *
 * S6a is the CONTRACT only — no capture, no baseline regression, no `--game all`.
 * The deterministic-vs-advisory split this file encodes is what later S6 slices
 * wire to gates (deterministic decide CI; advisory/VLM is "needs human review").
 */

export const MINIGAME_CONTRACT_SCHEMA_VERSION = "1" as const;

/** The only contract type S6 supports. Anything else is refused (`UNSUPPORTED_TYPE`). */
export const MINIGAME_CONTRACT_TYPE = "2d-kids-minigame" as const;

/**
 * Mini-game id pattern: lowercase kebab, must start with a letter. Aliases the
 * shared `WORKSPACE_ID_PATTERN` so a contract id and an external-workspace id are
 * validated identically across the mini-game and feel flows.
 */
export { WORKSPACE_ID_PATTERN as MINIGAME_ID_PATTERN } from "../../../domain/workspace-paths.js";

/**
 * State-id pattern: filename-safe and, crucially, `@`-FREE. A state id is used as the
 * `<state>.png` / `<state>.ui-rects.json` capture stem and is the LOGICAL half of a
 * `<state>@<device>` key, so an `@` (or a path separator / dot) in it would corrupt the
 * capture filenames and `splitStateDevice`'s last-`@` split. Lowercase alnum + `-`/`_`
 * (underscores are kept because existing state kinds/ids use them, e.g. `success_reward`).
 * Mirrors the device-id pattern's "filename-safe slug" intent. (Low-1 fix.)
 */
export const STATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A Unity scene path: under `Assets/`, ending in `.unity`, no traversal or
 * backslashes. A path outside this shape is refused (`INVALID_SCENE_PATH`).
 *
 * The `(?!.*\.\.)` lookahead forbids a `..` ANYWHERE in the path (path-safety:
 * the contract later drives scene loading/capture, so `Assets/../Game.unity`
 * must not slip through), and `[^\\]` forbids backslashes. `isScenePath` adds an
 * explicit per-segment guard as defense-in-depth.
 */
export const SCENE_PATH_PATTERN = /^Assets\/(?!.*\.\.)[^\\]*[^\\/]\.unity$/;

/**
 * True iff `value` is a safe Unity scene path. Belt-and-suspenders over
 * `SCENE_PATH_PATTERN`: rejects backslashes and any `.`/`..` path segment
 * explicitly (so a relative-traversal path can never reach scene loading), then
 * applies the shape pattern.
 */
export function isScenePath(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (value.includes("\\")) return false;
  if (value.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return SCENE_PATH_PATTERN.test(value);
}

/**
 * A scene object locator. Loombridge uses `SceneName:/Path/To/Object[index]` (or a
 * bare `/Path/To/Object`). Kept deliberately loose — a non-empty string that names
 * a hierarchy path (contains `/`, no backslash, no `..`). An empty/garbage locator
 * is refused so a failed check can always point at a concrete object.
 */
export function isObjectLocator(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

/**
 * Age bands a kids mini-game may target, each pinning the ERGONOMIC tap-target
 * floor (in dp) for that age. Younger hands need bigger targets. A contract whose
 * `tapTargets.minSizeDp` is below the band floor is refused (`IMPOSSIBLE_TAP_TARGET`):
 * the declared minimum could never satisfy the age the game claims to serve.
 *
 * Floors are product-owned (above the ~48dp adult minimum; younger = larger).
 */
export interface AgeBandSpec {
  id: string;
  label: string;
  /** Minimum acceptable tap-target edge length, in dp, for this age. */
  minTapTargetDp: number;
  description: string;
}

export const AGE_BANDS: Record<string, AgeBandSpec> = {
  "2-4": {
    id: "2-4",
    label: "Toddler (2–4)",
    minTapTargetDp: 100,
    description: "Large, forgiving targets; gross motor control only.",
  },
  "3-5": {
    id: "3-5",
    label: "Preschool (3–5)",
    minTapTargetDp: 80,
    description: "Big targets, simple single-tap interactions.",
  },
  "5-7": {
    id: "5-7",
    label: "Early elementary (5–7)",
    minTapTargetDp: 64,
    description: "Developing fine motor control; still oversized vs adult UI.",
  },
  "8-12": {
    id: "8-12",
    label: "Tween (8–12)",
    minTapTargetDp: 48,
    description: "Near-adult dexterity; standard minimum tap target.",
  },
};

export const AGE_BAND_IDS: ReadonlySet<string> = new Set(Object.keys(AGE_BANDS));

/**
 * Named visual profiles: the device aspect/orientation a mini-game is authored
 * for. Drives the safe-area and no-black-bars checks (which aspect the frame must
 * fill). An unknown profile is refused (`UNKNOWN_VISUAL_PROFILE`).
 */
export interface VisualProfileSpec {
  id: string;
  label: string;
  /** Target aspect ratio as width / height. */
  aspectRatio: number;
  orientation: "portrait" | "landscape";
  /**
   * The default DEVICE SET — a narrow→base→wide bracket of real resolutions the
   * profile is verified across. The first entry is the BASE device and matches
   * the profile's `aspectRatio`. A contract may override this set; absent an
   * override, this bracket is used. (Phase 2: schema only — capture/grading wire
   * up in later phases.)
   */
  devices: DeviceSpec[];
}

/**
 * One concrete device resolution in a profile's (or contract's) device set.
 * `id` is filename-safe (used later as `<state>@<id>.png`). Aspect is DERIVED
 * from `width / height`, never stored.
 */
export interface DeviceSpec {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const VISUAL_PROFILES: Record<string, VisualProfileSpec> = {
  "phone-portrait": {
    id: "phone-portrait",
    label: "Phone portrait (9:16)",
    aspectRatio: 9 / 16,
    orientation: "portrait",
    devices: [
      { id: "portrait-9x16", label: "9:16", width: 720, height: 1280 },
      { id: "portrait-iphone", label: "iPhone (9:19.5)", width: 1179, height: 2556 },
      { id: "portrait-android-tall", label: "Tall Android (9:20)", width: 1080, height: 2400 },
    ],
  },
  "phone-landscape": {
    id: "phone-landscape",
    label: "Phone landscape (16:9)",
    aspectRatio: 16 / 9,
    orientation: "landscape",
    devices: [
      { id: "landscape-16x9", label: "16:9", width: 1280, height: 720 },
      { id: "landscape-iphone", label: "iPhone (19.5:9)", width: 2556, height: 1179 },
      { id: "landscape-android-tall", label: "Tall Android (20:9)", width: 2400, height: 1080 },
    ],
  },
  "tablet-portrait": {
    id: "tablet-portrait",
    label: "Tablet portrait (3:4)",
    aspectRatio: 3 / 4,
    orientation: "portrait",
    devices: [
      { id: "tablet-p-3x4", label: "iPad (3:4)", width: 1536, height: 2048 },
      { id: "tablet-p-10x16", label: "10:16", width: 1200, height: 1920 },
      { id: "tablet-p-9x16", label: "9:16", width: 1080, height: 1920 },
    ],
  },
  "tablet-landscape": {
    id: "tablet-landscape",
    label: "Tablet landscape (4:3)",
    aspectRatio: 4 / 3,
    orientation: "landscape",
    devices: [
      { id: "tablet-l-4x3", label: "iPad (4:3)", width: 2048, height: 1536 },
      { id: "tablet-l-16x10", label: "16:10", width: 1920, height: 1200 },
      { id: "tablet-l-16x9", label: "16:9", width: 1920, height: 1080 },
    ],
  },
};

export const VISUAL_PROFILE_IDS: ReadonlySet<string> = new Set(
  Object.keys(VISUAL_PROFILES),
);

/**
 * The device set to verify a contract across: the contract's own `devices`
 * override when present & non-empty, else the visual profile's default bracket.
 * Returns `[]` for an unknown profile (shouldn't happen post-validation).
 */
export function resolveDevices(contract: MinigameContract): DeviceSpec[] {
  if (Array.isArray(contract.devices) && contract.devices.length > 0) {
    return contract.devices;
  }
  const profile = VISUAL_PROFILES[contract.visualProfile];
  return profile ? profile.devices : [];
}

/**
 * The kinds of named state a mini-game capture covers (S6 plan §Deliverables 2).
 * A state whose `kind` is outside this set is refused (`UNKNOWN_STATE_KIND`).
 *
 * - `start`           the idle/title state before interaction
 * - `active`          mid-interaction (the core loop is running)
 * - `success_reward`  the win/reward state
 * - `failure_timeout` an optional lose/timeout state
 * - `home_back`       the home/back navigation target
 */
export const STATE_KINDS = [
  "start",
  "active",
  "success_reward",
  "failure_timeout",
  "home_back",
] as const;

export type StateKind = (typeof STATE_KINDS)[number];

export const STATE_KIND_SET: ReadonlySet<string> = new Set(STATE_KINDS);

/**
 * State kinds that can LEGITIMATELY be outcome-gated — reached only by a game OUTCOME a
 * read-only verifier can't drive (a win, a loss/timeout, or the post-outcome return). The
 * deterministic screens `start`/`active` are DELIBERATELY excluded: they're always reachable,
 * so they must never be suggested for gating (gating them would silently un-verify the game —
 * the anti-gaming invariant). Tooling that *suggests* gating must intersect with this set.
 */
export const OUTCOME_GATEABLE_KINDS: ReadonlySet<string> = new Set<StateKind>([
  "success_reward",
  "failure_timeout",
  "home_back",
]);

/**
 * Deterministic checks — these DECIDE CI pass/fail (S6 plan §Product Position:
 * "Deterministic gates should decide CI pass/fail"). A contract must enable at
 * least one (`NO_DETERMINISTIC_CHECKS`); an unknown name is refused
 * (`UNSUPPORTED_CHECK`). Each maps to a deterministic gate wired in later S6 slices.
 *
 * - `safe-area`         required UI sits inside the declared safe area
 * - `required-in-frame` every `requiredInFrame` object is visible in its states
 * - `tap-target-size`   interactive controls meet the age-band tap-target floor
 * - `text-clipping`     text/controls are not clipped by the frame or a container
 * - `control-overlap`   required controls do not overlap each other
 * - `background-fit`    a background image's rendered fill envelops its content rect
 * - `background-coverage` the world-space background sprites cover the camera's view at
 *                       EVERY device aspect (GEOMETRY, not pixels — catches a sky sprite
 *                       narrower than the camera's world half-width on a wide phone)
 * - `background-seam`  front background layer cut edges do not show inside the frame
 *                       (depth-aware bottom/left/right bleed check)
 * - `no-black-bars`     no unintended letterbox / exposed camera clear color
 * - `render-frame`      frame border/coverage facts (reuses the S-hardening gate)
 * - `console-clean`     no console errors/exceptions during capture
 * - `interaction-flow`  the declared happy path reaches success/reward + home/back
 * - `input-response`    tapping a play-area control produces a declared observable change
 *                       (RNG-invariant liveness — proves the game RESPONDS, not that you WON)
 */
export const MINIGAME_DETERMINISTIC_CHECKS = [
  "safe-area",
  "safe-area-sweep",
  "required-in-frame",
  "tap-target-size",
  "text-clipping",
  "control-overlap",
  "background-fit",
  "background-coverage",
  "background-seam",
  "no-black-bars",
  "render-frame",
  "console-clean",
  "interaction-flow",
  "input-response",
] as const;

export type MinigameDeterministicCheck = (typeof MINIGAME_DETERMINISTIC_CHECKS)[number];

export const MINIGAME_DETERMINISTIC_CHECK_SET: ReadonlySet<string> = new Set(
  MINIGAME_DETERMINISTIC_CHECKS,
);

/**
 * Advisory checks — these NEVER hard-fail CI by default (S6 plan §Product
 * Position: "VLM review is advisory or 'needs human review' unless the project
 * explicitly opts into a blocking semantic review"). An unknown advisory name is
 * still refused (`UNSUPPORTED_CHECK`) so a typo doesn't read as an enabled review.
 */
export const MINIGAME_ADVISORY_CHECKS = [
  "vlm-readability",
  "vlm-age-appropriateness",
  "vlm-visual-polish",
  "vlm-state-plausibility",
] as const;

export type MinigameAdvisoryCheck = (typeof MINIGAME_ADVISORY_CHECKS)[number];

export const MINIGAME_ADVISORY_CHECK_SET: ReadonlySet<string> = new Set(
  MINIGAME_ADVISORY_CHECKS,
);

/**
 * Known artifact-threshold keys (the tolerances for the frame/visual checks). A
 * threshold outside this set is refused (`UNKNOWN_THRESHOLD`) so a typo can't
 * silently widen a gate; each value is a fraction in [0, 1] (`INVALID_THRESHOLD`).
 */
export const ARTIFACT_THRESHOLD_KEYS = [
  "maxBorderFraction",
  "maxUniformBorderFraction",
  "minContentCoverage",
  "maxArtifactSeverity",
  // S6e baseline regression tolerances (both fractions in [0,1]):
  /** Max fraction of perceptually-differing pixels vs the approved baseline before a state regresses. */
  "maxBaselineDiffFraction",
  /** Max normalized edge drift of a non-masked object's rect vs the baseline before a state regresses. */
  "maxRectDriftFraction",
] as const;

export type ArtifactThresholdKey = (typeof ARTIFACT_THRESHOLD_KEYS)[number];

export const ARTIFACT_THRESHOLD_KEY_SET: ReadonlySet<string> = new Set(
  ARTIFACT_THRESHOLD_KEYS,
);

// ── contract shape ───────────────────────────────────────────────────────────

/** A named scene object the verifier must be able to point a check at. */
export interface MinigameObjectRef {
  /** Stable handle used by states/reports (e.g. "letterTile"). */
  id: string;
  /** Unity scene-object locator (e.g. "GameScene:/Canvas/LetterTile"). */
  locator: string;
  description?: string;
}

/**
 * Declared input-liveness for a state's `input-response` check. Tapping `tap` must cause at
 * least one `observe` object to CHANGE observably. See `MinigameState.inputResponse`.
 */
export interface MinigameInputResponse {
  /** Declared object id of the play-area control to tap (a `requiredInFrame` id). */
  tap: string;
  /** Declared object id(s) that must observably change (text/visibility) after the tap. */
  observe: string[];
  /** The relation to assert. v1: only "changed" (text differs or visibility/active flips). */
  expect?: "changed";
}

export interface MinigameReachedCondition {
  /** Contract locator string (e.g. "GameScene:/Canvas/GameManager"). */
  locator: string;
  /** Optional component type name when checking a component property. */
  component?: string;
  /** Runtime property path (or component property path when `component` is set). */
  property_path: string;
  operator: "equals" | "not_equals" | "greater_than" | "less_than" | "approx" | "contains";
  /** Expected value; JSON shape preserved. */
  expected: unknown;
  /** Tolerance for operator=approx. */
  tolerance?: number;
  /** State-reached wait budget in milliseconds. */
  timeoutMs?: number;
}

/** One named capture state (S6 plan §Deliverables 2). */
export interface MinigameState {
  /** Unique state id (e.g. "start", "round-1-active"). */
  id: string;
  /** The role this state plays in the verification flow. */
  kind: StateKind;
  /** Optional scene this state is captured in; if set it must be a declared scene. */
  scene?: string;
  /** Optional `requiredInFrame` object ids that must be visible in THIS state. */
  requiredInFrame?: string[];
  description?: string;
  /**
   * Liveness for the `input-response` check (typically on the `active` state): when you
   * tap `tap`, at least one object in `observe` must observably CHANGE (its text differs,
   * its visibility/active flips, or it appears/disappears) — proof the game RESPONDS to
   * gameplay input. Pick a response that is OUTCOME-INDEPENDENT (true for a right OR wrong
   * answer — e.g. a feedback indicator appears, the question changes) so the check stays
   * RNG-invariant on a re-randomizing game. `tap` + every `observe` must be ids declared in
   * the top-level object list (`requiredInFrame`); they need NOT be visible at the start of
   * the state (a feedback element that only APPEARS on tap is a valid `observe`). Optional —
   * undeclared ⇒ not applicable, but enabling the `input-response` check without a
   * declaration (or vice-versa) is refused, so the liveness is never silently skipped.
   */
  inputResponse?: MinigameInputResponse;
  /**
   * Optional capture-time state-reached signal. When declared, `minigame capture`
   * waits for this condition before screenshotting the state. If the condition is
   * not reached within its bounded timeout, the state produces NO artifacts and is
   * reported as not captured / harness-incomplete, never as a game UI failure.
   */
  reached?: MinigameReachedCondition;
  /**
   * The state is reached ONLY by a game OUTCOME a read-only verifier can't drive —
   * e.g. a win/reward screen gated by answering correctly on a game that re-randomizes
   * each round. Loombridge is read-only (no RNG seed, no game-code change), so it does NOT
   * assert such a state's UI/reachability: capture skips it, finalize doesn't require its
   * roles, and verify reports it as NOT-VERIFIABLE (outcome-gated) — a distinct status
   * that is neither pass nor fail and never blocks the exit code. The verifiable envelope
   * (the deterministically-reachable states) is still graded fully.
   */
  outcomeGated?: boolean;
}

/** Safe-area tolerance for required UI. */
export interface MinigameSafeAreas {
  /** How far a required UI element may exceed the safe area, as a fraction [0,1]. 0 = strict. */
  maxOverflowFraction: number;
  /** Optional per-edge inset (fraction of frame, [0, 0.5)) defining the safe rect. */
  insets?: { top?: number; bottom?: number; left?: number; right?: number };
}

/** Minimum interactive-control size, graded against the age band floor. */
export interface MinigameTapTargets {
  /** Declared minimum tap-target edge length in dp. Must be ≥ the age band floor. */
  minSizeDp: number;
}

/** The declared happy-path flow across states. */
export interface MinigameInteractionFlow {
  /** Ordered state ids the happy path visits; must reference declared states and reach a reward. */
  happyPath: string[];
}

/** Tolerances for the frame/visual artifact checks (keys from ARTIFACT_THRESHOLD_KEYS). */
export type MinigameArtifactThresholds = Partial<Record<ArtifactThresholdKey, number>>;

/**
 * A background-image → content containment binding for the `background-fit` gate.
 *
 * Intent: a background card/panel (`background`) must be scaled (e.g. 9-sliced) so
 * its rendered fill ENVELOPS the content it sits behind — not render as a small
 * sprite that leaves the content on the bare frame. The gate measures this at the
 * PIXEL level (the background sprite's `bgColor` fill must cover ≥ `minBgFillFraction`
 * of the background object's layout rect), because the RectTransform alone can't
 * see an under-scaled sprite: the content can sit inside the rect while the fill
 * covers only a fraction of it.
 */
export interface MinigameContainerBinding {
  /** Declared object id of the background card/panel (its rect bounds the measured region). */
  background: string;
  /**
   * Declared object ids the background should envelop. If any is visible in a
   * state, the background must be present, visible, and pixel-graded — visible
   * content with an absent/hidden background FAILS (content on the bare frame).
   */
  content?: string[];
  /** Hex `#RRGGBB` of the background's fill colour. Default white (`#FFFFFF`). */
  bgColor?: string;
  /** Min fraction of the background rect its fill must cover. Default 0.6. */
  minBgFillFraction?: number;
}

/** Which checks run, split by enforcement tier. */
export interface MinigameChecks {
  /** CI-deciding checks (from MINIGAME_DETERMINISTIC_CHECKS). MUST be non-empty. */
  deterministic: string[];
  /** Advisory/VLM checks (from MINIGAME_ADVISORY_CHECKS). Optional; never hard-fails by default. */
  advisory?: string[];
}

/**
 * An optional approved baseline reference (S6e baseline regression). When `ref` is
 * set and an approved bundle exists there, `verify --minigame` compares the current
 * captures against it (perceptual PNG + rect drift), and any drift beyond
 * `artifactThresholds.maxBaselineDiffFraction`/`maxRectDriftFraction` is a baseline
 * regression (its own tier). Approve the bundle with `loombridge minigame baseline approve`.
 */
export interface MinigameBaseline {
  /** Directory path of the approved baseline bundle (relative to root, or absolute). */
  ref: string;
  capturedAt?: string;
  /** Object ids whose region is masked from baseline diffing (dynamic content). */
  masks?: string[];
}

/** A product-owned 2D kids mini-game verification contract. */
export interface MinigameContract {
  schemaVersion: typeof MINIGAME_CONTRACT_SCHEMA_VERSION;
  id: string;
  type: typeof MINIGAME_CONTRACT_TYPE;
  title?: string;
  description?: string;
  /** Unity scenes this mini-game lives in (≥1). */
  scenes: string[];
  /** Target age band id (key of AGE_BANDS). */
  ageBand: string;
  /** Target visual profile id (key of VISUAL_PROFILES). */
  visualProfile: string;
  /**
   * OPTIONAL device-set override. When present & non-empty, replaces the visual
   * profile's default bracket of resolutions to verify across (see
   * `resolveDevices`). Absent = use the profile default. Purely additive;
   * `visualProfile`/`aspectRatio` remain authoritative for the base aspect.
   */
  devices?: DeviceSpec[];
  /** Named capture states (≥1; ids unique). */
  states: MinigameState[];
  /** Objects that must be visible (≥1; ids unique). */
  requiredInFrame: MinigameObjectRef[];
  /** Objects explicitly allowed offscreen (must not also be requiredInFrame). */
  allowedOffscreen?: MinigameObjectRef[];
  uiSafeAreas: MinigameSafeAreas;
  /**
   * Object ids OR scene paths the `safe-area-sweep` check is allowed to leave outside the safe
   * area (beyond the automatic full-frame-backdrop exemption). Use sparingly — the rule is "only
   * backgrounds may bleed past the safe area"; this is for the rare intentional edge element.
   * A matched element that WOULD fail is surfaced as a "waived" note (never silently green).
   */
  safeAreaExempt?: string[];
  /**
   * uGUI DECORATIVE BACKGROUND subtrees/patterns the `safe-area-sweep` check exempts (sky / hill /
   * cloud / sparkle Images that, like a world-space background, may sit outside the safe area).
   * Each entry matches an element by exact path, ANCESTOR path (`/Canvas/Background` exempts every
   * descendant), or trailing-`*` prefix glob (`/Canvas/Sparkle*`). Matched decoration is skipped
   * SILENTLY (it is correctly-classified background, not a waived real finding). The dev declares
   * this; the verifier never guesses — a decorative image and a real score chip look identical.
   */
  safeAreaBackground?: string[];
  tapTargets: MinigameTapTargets;
  interactionFlow: MinigameInteractionFlow;
  artifactThresholds: MinigameArtifactThresholds;
  /** Background→content containment bindings (required iff `background-fit` is enabled). */
  containers?: MinigameContainerBinding[];
  /**
   * World-space background-layer object locators for the `background-coverage` /
   * `background-seam` gates —
   * the sky/hill/ground sprites that must cover the camera's view at EVERY device aspect.
   * Required (non-empty) iff `background-coverage` or `background-seam` is enabled
   * (mirrors how `background-fit` requires `containers`). Each is a non-empty scene locator
   * (e.g. "CountTheFruits:/Background/Sky").
   */
  backgroundLayers?: string[];
  /**
   * The rendering camera locator for the `background-coverage` / `background-seam` gates (e.g. "CountTheFruits:/Main Camera").
   * Required iff `background-coverage` or `background-seam` is enabled. Capture reads its world
   * position + orthographic size to build the per-aspect view rect the layers must cover.
   */
  backgroundCamera?: string;
  /** Which deterministic/advisory checks run. */
  checks: MinigameChecks;
  baseline?: MinigameBaseline;
  /**
   * OPTIONAL declared state-signal — the game phase field capture can phase-align gestures
   * against (a multi-screen/gesture game needs this so `trace record` gates each
   * gesture on the game's current phase). The `locator` is a BARE hierarchy path with NO
   * scene prefix and NO `:` — the CLI's `--state-signal` parses exactly
   * `<path>:<Component>:<property>` on `:`, so a `:` in the locator would corrupt the split.
   * Threaded into the printed `record` command by `minigame next`; never auto-detected this phase.
   */
  stateSignal?: { locator: string; component?: string; property: string };
}

export interface MinigameValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface MinigameValidationResult {
  valid: boolean;
  issues: MinigameValidationIssue[];
}
