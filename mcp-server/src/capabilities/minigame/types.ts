/**
 * Mini-game UI gate capture-input types (S6c-1).
 *
 * These describe the per-state capture a deterministic mini-game gate grades — the
 * output of the `unity_ui_get_screen_rects` op (S6b, #55) plus the per-state
 * `{ errorCount }` console summary. They are the S6 counterpart to the platformer
 * gates' op-output fixtures: a gate evaluator is a PURE function over one of these,
 * fully unit-testable from a captured `.ui-rects.json` with no live editor.
 *
 * Capture convention (must match the op exactly): the screen origin is BOTTOM-LEFT,
 * `screenRect` is in pixels, and `viewportRect` is normalized 0..1. An object that
 * was captured but is inactive/offscreen may omit `viewportRect`/`isFullyVisible`;
 * a gate that needs a normalized rect for such an object derives it from
 * `screenRect` + `viewport` (see `normalizedRect` in `evaluators.ts`).
 *
 * Anti-false-green (CLAUDE.md "Verification / supervisor invariants"): these are
 * INPUTS, not verdicts — the refuse-on-absent discipline lives in the evaluators
 * (an absent required object / state / console is a FAIL, never a skipped check).
 */

/** An axis-aligned rectangle. Used for both pixel `screenRect` and normalized `viewportRect`. */
export interface MinigameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One captured uGUI object, mirroring a `unity_ui_get_screen_rects` element.
 * Geometry/visibility fields beyond `screenRect` are optional because the op omits
 * them for inactive/offscreen objects — the evaluators treat a missing
 * `isFullyVisible` as "not fully visible" (refuse-on-absent), never as a pass.
 */
export interface MinigameCaptureObject {
  /** Stable id matching a contract `requiredInFrame`/`allowedOffscreen` object id. */
  id: string;
  /** Scene-hierarchy path of the RectTransform, e.g. "/HUD/StartScreen/StartButton". */
  path: string;
  /** uGUI role tag from the op: "image" | "text" | "container" | ... */
  role: string;
  active: boolean;
  isVisible: boolean;
  /** Why the object is not visible (e.g. "inactive"), or null when visible. */
  visibilityReason?: string | null;
  /** Pixel-space rect, origin bottom-left. Always present. */
  screenRect: MinigameRect;
  /** Normalized 0..1 rect. Omitted by the op for some inactive objects. */
  viewportRect?: MinigameRect;
  /** True iff the object is fully inside the frame (no clipping). */
  isFullyVisible?: boolean;
  /** True iff the frame clips part of the object. */
  isPartiallyClipped?: boolean;
  /** True iff the object lies entirely outside the frame. */
  isOffScreen?: boolean;
  /** Which frame edge clips the object ("left"|"right"|"top"|"bottom"), or null. */
  clipSide?: string | null;
  centerXFraction?: number;
  centerYFraction?: number;
  /** True iff the object receives raycasts (an interactive control). */
  raycastTarget?: boolean;
  /** True iff a Selectable on the object is interactable. */
  interactable?: boolean;
  /**
   * The live `Canvas.scaleFactor` of the canvas this object is on — the px→dp
   * density basis for `tap-target-size` (`dp = px / canvasScaleFactor`). Optional
   * because the S6b captures predate it; it is captured live in S6c-3. When ABSENT
   * the tap-target gate refuses (no density basis can be assumed), never passes.
   */
  canvasScaleFactor?: number;
  /** Text content (role "text"). */
  text?: string;
  fontSize?: number;
  spriteName?: string;
}

/** The captured game-view viewport for a state. */
export interface MinigameViewport {
  width: number;
  height: number;
  aspect: number;
}

/** The per-state console summary (`<state>.console.json`). */
export interface MinigameConsole {
  /** Number of Error/Exception console entries during the state's capture. */
  errorCount: number;
}

/**
 * One named state's capture — the `<state>.ui-rects.json` body plus its
 * `<state>.console.json`. `console` is optional so the runner can pass a capture
 * with a MISSING console file through to `console-clean`, which refuses it (an
 * absent console summary is a FAIL, not an assumed-clean pass).
 */
export interface MinigameCaptureState {
  /** The state id this capture is for (matches a contract state id). */
  state: string;
  viewport: MinigameViewport;
  objects: MinigameCaptureObject[];
  console?: MinigameConsole;
  /**
   * Set by capture when a state's required objects were SEEN during its window but NEVER all at the
   * same instant — i.e. the contract collapsed sequential SUB-screens into one state (StarChef `cook`:
   * Spray → Pour → Power, where spray and pour never co-exist on screen). `missing` are the ids visible
   * at some window frame but not in the captured representative frame.
   *
   * This is a DOWNGRADE-ONLY signal (moat-safe): a gate may demote a would-be game FAIL to can't-verify
   * (sequential sub-screens → split the state), but it must NEVER turn absent evidence into a pass — a
   * malicious capture claiming `sequential` can only make the verdict MORE conservative, never green.
   */
  sequential?: { missing: string[] };
}

/** A world-space 2D point. */
export interface WorldPoint {
  x: number;
  y: number;
}

/** A world-space axis-aligned bounding box (one background layer's union extent). */
export interface WorldAabb {
  min: WorldPoint;
  max: WorldPoint;
}

/**
 * Render-order signal for one SpriteRenderer-backed background layer.
 *
 * v1 intentionally resolves only the common 2D case: one sorting layer, ordered by
 * SpriteRenderer.sortingOrder, with z as a tiebreak. Cross-sorting-layer ordering
 * requires Unity's TagManager sorting-layer index and is refused by the seam gate
 * when detected rather than guessed.
 */
export interface BackgroundLayerOrder {
  sortingOrder: number;
  z: number;
  sortingLayerId?: number;
  sortingLayerName?: string;
}

/** One background layer's world AABB, tagged with its scene locator. */
export interface BackgroundLayer extends WorldAabb {
  /** The declared layer locator this AABB belongs to (for the report). */
  locator: string;
  /** Render order needed by `background-seam`; optional for old coverage-only packs. */
  order?: BackgroundLayerOrder;
}

/**
 * The rendering camera's world geometry, read ONCE at capture time (device-invariant —
 * world geometry doesn't change with the Game-View aspect; only the camera's world VIEW
 * RECT does, derived per-aspect from `orthoSize` × aspect by the evaluator).
 */
export interface BackgroundCamera {
  /** True iff the camera is orthographic. Perspective backgrounds are out of scope. */
  orthographic: boolean;
  /** The camera's orthographic size (world half-height). */
  orthoSize: number;
  /** The camera's world position (x,y). */
  position: WorldPoint;
}

/**
 * `background.json` — the ONE scene-level, device-INVARIANT geometry pack the
 * `background-coverage` gate grades. World geometry is the same at every aspect; the
 * evaluator derives the per-aspect camera view rect (`halfW = orthoSize × aspect`) and
 * tests that every layer AABB union covers it.
 */
export interface BackgroundData {
  camera: BackgroundCamera;
  layers: BackgroundLayer[];
}

// ── background-coverage DISCOVERY (advisory suggest-and-confirm) ──────────────────────

/**
 * One orthographic camera discovered while walking the scene hierarchy — a candidate
 * gameplay camera for the `background-coverage` binding. The chosen camera (if any) plus
 * all candidates are surfaced so a later phase can ask the dev to disambiguate when there
 * is more than one.
 */
export interface DiscoveredCamera {
  /** Full scene locator string (`<scene>:/<path>`). */
  locator: string;
  /** The camera object's name (used to prefer "Main Camera" when several are orthographic). */
  name: string;
  /** True iff orthographic (discovery only chooses orthographic cameras). */
  orthographic: boolean;
  /** The camera's orthographic size (world half-height). */
  orthoSize: number;
  /** The camera's world position (x,y). */
  position: WorldPoint;
}

/**
 * One SpriteRenderer-bearing object discovered in the scene, scored as a background-layer
 * candidate: its world AABB, its single-layer coverage fraction at the WIDEST device aspect,
 * and whether it is a full-width band (spans the view rect edge-to-edge horizontally).
 */
export interface DiscoveredLayer {
  /** Full scene locator string (`<scene>:/<path>`). */
  locator: string;
  /** The sprite object's name. */
  name: string;
  /** World AABB (union of the object's renderers). */
  aabb: WorldAabb;
  /** Single-layer coverage fraction of the camera view at the widest device aspect, in [0,1]. */
  widestFraction: number;
  /** True iff the AABB spans the full view-rect width at the widest aspect (a coverage band). */
  fullWidthBand: boolean;
  /** Render order needed by the `background-seam` gate. */
  order?: BackgroundLayerOrder;
}

/** Union-coverage of the RECOMMENDED layer set at one device aspect (the proof a later phase prints). */
export interface BackgroundCoverageByDevice {
  deviceId: string;
  label: string;
  /** Union coverage fraction of the recommended layers at this device's aspect, in [0,1]. */
  fraction: number;
  /** Frame sides with at least one uncovered sample (`[]` when fully covered). */
  gapEdges: string[];
}

/**
 * The structured recommendation produced by `discoverBackgroundCandidates` — ADVISORY data a
 * later phase turns into a "suggest-and-confirm" CLI flow for the `background-coverage`
 * binding. Never throws on an odd scene: a missing/ambiguous camera yields an empty
 * `recommended`/`coverageByDevice` plus a clear `warnings[]` entry.
 */
export interface BackgroundCandidates {
  /** The chosen gameplay camera (undefined if 0 orthographic cameras, or >1 and ambiguous). */
  camera?: DiscoveredCamera;
  /** All orthographic cameras found (for disambiguation messaging). */
  cameras: DiscoveredCamera[];
  /** Recommended coverage layers, in scene order. */
  recommended: DiscoveredLayer[];
  /** Layers excluded as decorative, each with a short reason. */
  excluded: { locator: string; name: string; reason: string }[];
  /**
   * EVERY discovered sprite with usable world bounds (recommended + excluded alike),
   * as `{locator, aabb}`. The geometry source for an EXPLICIT `--background-layers`
   * override: an excluded sprite carries no AABB in `excluded`, so an explicit bind of a
   * non-recommended sprite resolves its geometry by locator from here. `[]` when no
   * camera/sprite was found.
   */
  allLayers: { locator: string; aabb: WorldAabb; order?: BackgroundLayerOrder }[];
  /** Union coverage of `recommended` at each resolved device (empty when no camera was chosen). */
  coverageByDevice: BackgroundCoverageByDevice[];
  /** Advisory warnings (e.g. "no orthographic camera found", "2 orthographic cameras — pass --background-camera"). */
  warnings: string[];
}
