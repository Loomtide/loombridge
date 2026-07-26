/**
 * Starter mini-game contract scaffold (S7b — `loombridge minigame init`).
 *
 * Produces a VALID, ready-to-edit `MinigameContract` for a given id so a partner
 * never starts from a blank page. The values are descriptive placeholders (a single
 * scene, four named screens, a handful of required objects, the common deterministic
 * checks) the developer edits to match their game. It is deliberately conservative:
 *
 *   - it enables only checks that need no extra wiring (NOT `background-fit`, which
 *     requires `containers`);
 *   - `ageBand` defaults to `5-7` and `tapTargets.minSizeDp` to 96 (above that band's
 *     64dp floor — and most younger floors), so the scaffold validates as-is;
 *   - the happy path spans all four screens and reaches `success_reward`.
 *
 * `minigame init` validates the result before emitting it, so a scaffold that fails
 * validation is a bug in THIS file, never a partner error.
 */

import { AGE_BANDS, type MinigameContract } from "./profiles/types.js";

/** A human title from a kebab id: `count-the-fruits` → `Count The Fruits`. */
function titleFromId(id: string): string {
  return id
    .split("-")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Defaults the scaffold uses when a field isn't supplied (the S7b `init` baseline). */
const DEFAULT_AGE_BAND = "5-7";
const DEFAULT_VISUAL_PROFILE = "phone-portrait";
const DEFAULT_MIN_TAP_TARGET_DP = 96;

/**
 * Optional overrides the guided `minigame setup` flow threads into the scaffold so a
 * first-time user lands on a contract already pointed at their scene / age band /
 * device shape. Each is optional; omitted fields fall back to the S7b `init` defaults.
 */
export interface ScaffoldOverrides {
  /** Unity scene path (`Assets/.../X.unity`) the game lives in. */
  scene?: string;
  /** Age band id (key of AGE_BANDS) — drives the tap-target floor. */
  ageBand?: string;
  /** Visual profile id (key of VISUAL_PROFILES) — the device aspect/orientation. */
  visualProfile?: string;
  /**
   * The win/reward is gated by gameplay OUTCOME (correct answers, RNG, skill) that an
   * automated READ-ONLY replay can't reproduce. When true, the post-win states
   * (`success_reward`, `home_back`) are marked `outcomeGated` so the whole pipeline
   * treats them as NOT-ASSERTED by design — capture skips them, finalize doesn't
   * require their roles, and verify reports them as outcome-gated (never a failure).
   */
  gatedOutcome?: boolean;
}

/** State ids gated when the win is outcome-dependent (post-win, unreachable read-only). */
const GATED_OUTCOME_STATES: ReadonlySet<string> = new Set(["success_reward", "home_back"]);

/** `{ outcomeGated: true }` for a post-win state when the win is outcome-gated, else `{}`. */
function gate(stateId: string, gatedOutcome?: boolean): { outcomeGated?: true } {
  return gatedOutcome && GATED_OUTCOME_STATES.has(stateId) ? { outcomeGated: true } : {};
}

/**
 * Build a valid starter contract for `id`. The scene + locators reference `id` so
 * the placeholders are self-describing; the developer repoints them at their real
 * scene and object paths. `overrides` (used by `minigame setup`) pre-fill the
 * scene / age band / visual profile; the result still validates for every age band
 * because the tap-target minimum is raised to that band's ergonomic floor.
 */
export function buildScaffoldContract(id: string, overrides: ScaffoldOverrides = {}): MinigameContract {
  const scene = overrides.scene ?? `Assets/Scenes/${id}.unity`;
  const ageBand = overrides.ageBand ?? DEFAULT_AGE_BAND;
  const visualProfile = overrides.visualProfile ?? DEFAULT_VISUAL_PROFILE;
  // Keep the scaffold valid for younger bands: a 2-4 game's floor (100dp) is above
  // the default 96dp, so lift the declared minimum to max(default, band floor).
  const bandFloor = AGE_BANDS[ageBand]?.minTapTargetDp ?? 0;
  const minSizeDp = Math.max(DEFAULT_MIN_TAP_TARGET_DP, bandFloor);
  // The locator scene-name prefix is just a readable hint; the partner replaces it.
  const loc = (objectPath: string): string => `${id}:/Canvas/${objectPath}`;

  return {
    schemaVersion: "1",
    id,
    type: "2d-kids-minigame",
    title: titleFromId(id),
    description: "TODO: one-line description of the mini-game (edit me).",
    scenes: [scene],
    ageBand,
    visualProfile,
    requiredInFrame: [
      { id: "startButton", locator: loc("StartScreen/StartButton"), description: "TODO: the button that starts a round." },
      { id: "playArea", locator: loc("PlayArea"), description: "TODO: the main interactive area while playing." },
      { id: "scoreDisplay", locator: loc("HUD/ScoreDisplay"), description: "TODO: the score/progress shown on the reward screen." },
      { id: "homeButton", locator: loc("HUD/HomeButton"), description: "TODO: back-to-home navigation." },
    ],
    states: [
      { id: "start", kind: "start", scene, requiredInFrame: ["startButton", "homeButton"], description: "TODO: title/idle before the first round." },
      { id: "active", kind: "active", scene, requiredInFrame: ["playArea", "homeButton"], description: "TODO: the core loop is running." },
      { id: "success_reward", kind: "success_reward", scene, requiredInFrame: ["scoreDisplay", "homeButton"], description: "TODO: the win/reward screen.", ...gate("success_reward", overrides.gatedOutcome) },
      { id: "home_back", kind: "home_back", scene, requiredInFrame: ["homeButton"], description: "TODO: home/back navigation reached.", ...gate("home_back", overrides.gatedOutcome) },
    ],
    uiSafeAreas: {
      maxOverflowFraction: 0,
      insets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
    },
    tapTargets: {
      minSizeDp,
    },
    interactionFlow: {
      happyPath: ["start", "active", "success_reward", "home_back"],
    },
    artifactThresholds: {
      maxBorderFraction: 0.02,
      maxUniformBorderFraction: 0.02,
      minContentCoverage: 0.9,
    },
    checks: {
      deterministic: ["required-in-frame", "safe-area", "safe-area-sweep", "tap-target-size", "console-clean", "interaction-flow"],
    },
  };
}
