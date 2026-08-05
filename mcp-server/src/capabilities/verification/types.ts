/**
 * Acceptance contract types — the machine-checkable spec every verification gate
 * checks against. Game-agnostic: a game supplies one `AcceptanceContract` instance
 * (e.g. `tiderunner.acceptance.json`) authored from its design mock + feel doc.
 * The contract's fields feed the verification gates in `./gates/`, which grade a
 * captured build against these targets and tolerances.
 */

import type { HarnessSection } from "../../domain/harness-seam.js";

export type { HarnessSection, FeelSeam } from "../../domain/harness-seam.js";

export const ACCEPTANCE_SCHEMA_VERSION = "1" as const;

/** A tolerance band on a numeric target. One of `percent` or `abs` is expected. */
export interface ToleranceBand {
  /** Symmetric percentage band, e.g. 5 means ±5%. */
  percent?: number;
  /** Symmetric absolute band in the target's unit, e.g. 0.1 means ±0.1u. */
  abs?: number;
}

/** A named numeric target with a unit and a tolerance band (e.g. jump apex). */
export interface NumericTarget {
  /** The expected value. */
  target: number;
  /** Unit string, e.g. "u" (world units), "ms", "u/s", "s". */
  unit: string;
  /** Tolerance band; if omitted the gate uses an exact comparison. */
  band?: ToleranceBand;
  /** Provenance / human note. */
  note?: string;
}

/** A required font for a role plus the resolved family name to match against. */
export interface FontRequirement {
  /** The expected font family/asset name, e.g. "Press Start 2P". */
  family: string;
  /** Optional human note (e.g. monospace fallback). */
  note?: string;
}

export interface FontsSection {
  /** Global/default UI font when a role has no override. */
  global?: FontRequirement;
  /** Per-role font requirements keyed by HUD role id (e.g. "score", "timer"). */
  byRole?: Record<string, FontRequirement>;
  /**
   * Font families explicitly disallowed for this game. This is useful for
   * non-Tiderunner proof contracts where a generic readable font is acceptable,
   * but copied Tiderunner taste (e.g. its exact HUD face) must fail.
   */
  forbidden?: FontRequirement[];
}

/** Palette entry: a hex color mapped to one or more semantic role names. */
export interface PaletteEntry {
  /** Hex color, lowercase, with leading '#', e.g. "#ffd166". */
  hex: string;
  /** Role names this color fills, e.g. ["score"], ["juice","hearts"]. */
  roles: string[];
  /** Optional human-readable color name, e.g. "gold", "magenta". */
  name?: string;
}

export interface PaletteSection {
  entries: PaletteEntry[];
}

/** Anchor region for a HUD element (which screen edge/corner it pins to). */
export type HudAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface HudElement {
  /** Stable id, e.g. "score", "lives", "timer". */
  id: string;
  /** Human role/description. */
  role: string;
  /** Screen anchor region. */
  anchor: HudAnchor;
  /** Inset from the anchored edge in CSS/native px, if specified. */
  insetPx?: number;
  /** Role key into `palette` for this element's primary text color. */
  colorRole?: string;
  /** Font family this element must use (overrides `fonts.global`). */
  font?: string;
  /** Display format hint, e.g. "×NN / total", "mm:ss:ff". */
  format?: string;
  /** Whether the gate must find this element present. Defaults true. */
  required?: boolean;
  /** Optional human note (e.g. "hidden in story mode"). */
  note?: string;
}

export interface HudSection {
  elements: HudElement[];
}

/** A 3D world position. */
export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

/** PixelPerfectCamera configuration the framing must ship. */
export interface PixelPerfectConfig {
  /** Pixels-per-unit of the source art the grid is sized against, e.g. 16. */
  assetsPPU: number;
  /** Reference resolution width, e.g. 256. */
  refResolutionX: number;
  /** Reference resolution height, e.g. 144. */
  refResolutionY: number;
  /**
   * Whether to render to a low-res offscreen RT then upscale. MUST be false for a
   * Screen Space-Camera HUD to stay crisp + be captured by the bridge screenshot
   * (upscaleRT=true rasterizes the HUD at native res then stretches it → blurry).
   * See game-polish-2d/references/hud-kit.md and the ui-conformance hudCrispness check.
   */
  upscaleRT: boolean;
  /** Snap rendering to the pixel grid (removes sub-pixel shimmer). Defaults true. */
  pixelSnapping?: boolean;
  note?: string;
}

/**
 * Concrete camera placement + projection the build must reproduce, so a clean-room
 * agent never opens the verified demo to recover these. Authored from the demo scene
 * (Main Camera + PixelPerfectCamera) — the only legit source today.
 */
export interface CameraFramingSection {
  /** Camera transform world position, e.g. {x:8,y:4.5,z:-10}. */
  worldPosition: WorldPosition;
  /** Orthographic half-height in world units, e.g. 4.5. */
  orthographicSize: number;
  /** Where the world origin sits relative to the frame, e.g. "bottom-left". */
  origin?: string;
  /** Solid background color (clear color), lowercase hex with '#', e.g. "#2a1f4d". */
  backgroundColorHex: string;
  /** PixelPerfectCamera settings. */
  pixelPerfect: PixelPerfectConfig;
  note?: string;
}

/** Allowed range [min, max] for a measured world quantity. */
export interface RangeBand {
  min: number;
  max: number;
}

/**
 * Perspective / high-angle camera framing band — the 3D top-down analogue of the
 * 2D `CameraFramingSection`. Where the 2D block pins an exact pixel grid + ortho
 * half-height, this one pins the visible GROUND EXTENT the camera may show, which
 * is the machine-checkable form of "the play space reads top-down and the
 * character isn't a speck". Consumed by the framing gate's perspective branch.
 *
 * MOTIVATING INCIDENT: The dogfood project's rig framed ~54m of world width vs the ~24-32m
 * spec; nothing caught it until a human eyeballed the tiny character. Declaring
 * `visibleGroundWidthM` turns that into a gate: the gate computes the extent from
 * the CAPTURED camera height/pitch/FOV/aspect and refuses when it is out of band
 * (or when a bound evidence field is missing — never a silent skip).
 */
export interface PerspectiveFramingSection {
  /** Descriptive projection intent, e.g. "orthographic-or-high-angle". Not enforced directly. */
  projection?: string;
  /** Allowed camera pitch-DOWN band, degrees (0 = horizon, 90 = straight down). */
  pitchDownDeg?: RangeBand;
  /** Orthographic half-height, if an orthographic rig is used (width = 2·size·aspect). */
  orthographicSize?: number;
  /** If a PERSPECTIVE rig is used instead of orthographic: the intended vertical FOV. */
  perspectiveFallback?: { fieldOfViewDeg: number; note?: string };
  /**
   * THE BAND: allowed visible ground-plane WIDTH the camera may show, in world
   * metres (measured at the centre of the frame). Declaring this arms the
   * perspective extent gate; a captured height/pitch/FOV that is missing when this
   * is declared is a REFUSAL, not a skipped check.
   */
  visibleGroundWidthM?: RangeBand;
  /** World-Y of the ground plane the camera height is measured above (default 0). */
  groundPlaneY?: number;
  /** Near clip plane distance. Descriptive; not gate-enforced. */
  nearClip?: number;
  /** Far clip plane distance. Descriptive; not gate-enforced. */
  farClip?: number;
  /** Solid background/clear color, hex. Descriptive; not gate-enforced here. */
  backgroundColorHex?: string;
  note?: string;
}

/**
 * Discriminator: is a `framing.camera` block the 2D pixel-perfect kind
 * (`CameraFramingSection`) or the 3D perspective/high-angle kind
 * (`PerspectiveFramingSection`)? The perspective block is identified by any of the
 * perspective-only fields; the 2D block never carries these.
 */
export function isPerspectiveFramingSection(
  camera: CameraFramingSection | PerspectiveFramingSection | undefined,
): camera is PerspectiveFramingSection {
  if (!camera) return false;
  const c = camera as PerspectiveFramingSection;
  return (
    c.pitchDownDeg !== undefined ||
    c.perspectiveFallback !== undefined ||
    c.visibleGroundWidthM !== undefined
  );
}

/** Camera framing target: aspect + where the player sits horizontally. */
export interface FramingSection {
  /** Aspect ratio width:height, e.g. {w:16,h:9}. */
  aspect: { w: number; h: number };
  /** Native resolution in px, e.g. {w:256,h:144}. */
  nativeResolution?: { w: number; h: number };
  /** Pixel scale factor, e.g. 5. */
  pixelScale?: number;
  /**
   * Concrete camera placement/projection/background. Either the 2D pixel-perfect
   * `CameraFramingSection` (ortho half-height + pixel grid) or the 3D
   * `PerspectiveFramingSection` (visible ground-extent band). The framing gate
   * discriminates via `isPerspectiveFramingSection`.
   */
  camera?: CameraFramingSection | PerspectiveFramingSection;
  /**
   * Camera behavior. "static" = one-screen fixed camera (no follow), "follow" =
   * camera tracks the player. When "static", the framing gate treats the
   * `playerAnchor` check as informational (pass + note) rather than a warn,
   * because a literal per-frame anchor only applies to a following camera.
   */
  cameraMode?: "static" | "follow";
  /** Player horizontal anchor as a fraction of viewport width [0..1]. */
  playerAnchor: {
    /** Target center-X fraction, e.g. 0.40. */
    centerXFraction: number;
    /** Tolerance on the fraction, e.g. 0.05. */
    tolerance: number;
    note?: string;
  };
  /** Whether the camera pans vertically. */
  verticalPan?: boolean;
  note?: string;
}

/**
 * Project physics settings the feel targets depend on. Pinned so the dash-distance
 * target is hittable: at the default 50 Hz, dashTime 0.15s = 7.5 steps and the dash
 * quantizes to 2.625/3.0u; at 60 Hz it is exactly 9 steps → 2.8125u.
 */
export interface PhysicsSection {
  /** Fixed timestep in seconds, e.g. 0.0166667 (60 Hz). */
  fixedTimestep: number;
  note?: string;
}

/** Named feel targets — value + band, consumed by the feel gate / FeelHarness. */
export interface FeelSection {
  /** Run speed (u/s). */
  runSpeed?: NumericTarget;
  /** Jump apex height (u). */
  jumpApex?: NumericTarget;
  /** Time to apex (ms). */
  timeToApex?: NumericTarget;
  /** Short-hop apex (u) with jump-cut applied. */
  shortHopApex?: NumericTarget;
  /** Dash distance (u). */
  dashDistance?: NumericTarget;
  /** Dash duration (s). */
  dashTime?: NumericTarget;
  /** Dash cooldown (s). */
  dashCooldown?: NumericTarget;
  /** Coyote time window (s). */
  coyoteTime?: NumericTarget;
  /** Jump-buffer window (s). */
  jumpBuffer?: NumericTarget;
  /** Catch-all for any additional named feel targets. */
  extra?: Record<string, NumericTarget>;
}

/** Dash afterimage / trail spec. */
export interface DashTrailSpec {
  /** Number of ghost copies behind the player. */
  ghosts: number;
  /** Opacity percentages per ghost (front→back), e.g. [52,32,18]. */
  opacities: number[];
  /** Spacing between ghosts in native px. */
  spacingPx?: number;
  /** How long each ghost is held in ms. */
  holdMs?: number;
  /** Tint/blend hint, e.g. "cyan / screen". */
  tint?: string;
  note?: string;
}

/** Landing dust burst spec. */
export interface LandingDustSpec {
  /** Number of particles emitted. */
  particles: number;
  /** Horizontal spread in native px (± value). */
  spreadXPx?: number;
  /** Fade duration in ms. */
  fadeMs?: number;
  note?: string;
}

/** Fruit-collect pop spec. */
export interface FruitPopSpec {
  /** Frame count of the collected burst (e.g. 6 for Collected.png). */
  frames?: number;
  /** Scale keyframes, e.g. [1.0, 1.4, 0]. */
  scaleKeyframes?: number[];
  /** Number of radial sparkles. */
  sparkles?: number;
  /** SFX cue name, e.g. "coin_05.wav". */
  sfx?: string;
  note?: string;
}

/** Hit-stop (damage freeze) spec. */
export interface HitStopSpec {
  /** Freeze duration in ms. */
  ms: number;
  /** Equivalent frame count, if specified. */
  frames?: number;
  /** Whether the player flashes white for one frame. */
  playerFlashWhite?: boolean;
  note?: string;
}

/** Screen-shake (trauma) spec. */
export interface ScreenShakeSpec {
  /** Amplitude in native px. */
  amplitudePx: number;
  /** Decay duration in ms. */
  decayMs?: number;
  /** When shake fires. "hit-only" means NOT on landing. */
  trigger: "hit-only" | "hit-and-land" | "land-only" | string;
  note?: string;
}

/** A single parallax layer. */
export interface ParallaxLayer {
  /** Layer name, e.g. "Sky", "Hills", "Foreground". */
  name: string;
  /** Scroll factor relative to camera, e.g. 0.3. */
  factor: number;
  /**
   * Whether this layer is a FULL-SCREEN backdrop that must always cover the
   * camera frame (even after parallax drift). The coverage gate asserts every
   * layer flagged `true` still covers the frame post-drift, catching a parallax
   * seam that exposes the camera background.
   */
  coversFrame?: boolean;
  /**
   * Whether this backdrop must extend to/below the viewport FLOOR so its bottom
   * edge is never exposed in-frame — a BOTTOM-ONLY requirement (no top/horizontal
   * coverage implied, unlike `coversFrame`). Use for a silhouette/backdrop that
   * doesn't reach the top of the screen but whose cropped bottom edge would show
   * a band of camera background in the pit if it stops above the floor. The
   * coverage gate asserts `layer.minY <= frame.minY` at every sample for any
   * layer flagged `true` that isn't already fully covered via `coversFrame`.
   */
  coversBottom?: boolean;
  note?: string;
}

export interface ParallaxSpec {
  layers: ParallaxLayer[];
  /**
   * Max allowed per-step center excursion (u) for a `coversFrame` layer's
   * trajectory in the coverage gate's CONTINUITY check; a larger jump between
   * consecutive samples is a teleport/snap → FAIL. If omitted the gate defaults
   * to `frameWidth * 0.1` (frameWidth = cameraFrame.maxX - cameraFrame.minX).
   */
  continuityThresholdU?: number;
  note?: string;
}

/** A single procedural SFX cue the build must wire (jump/dash/collect/hit/bounce/win). */
export interface AudioCue {
  /** Stable cue id, e.g. "jump", "dash", "collect", "hit", "bounce", "win". */
  id: string;
  /** Source clip path relative to the project, e.g. "Assets/Audio/jump.wav". */
  clip: string;
  /** Human description of what fires the cue, e.g. "PlayerController jump launch". */
  trigger?: string;
  /** Whether the cue must be present/firing. Defaults true. */
  required?: boolean;
  note?: string;
}

/**
 * Procedural retro-SFX layer (parallel to `juice` — it's audible polish, not visual).
 * The clips are GENERATED procedurally (numpy → 16-bit PCM .wav), never sourced
 * externally — same provenance story as the PIL-generated sky/hills. A drop-in
 * `SfxPlayer` singleton plays them; its `playerComponent` is what the manifest gate
 * confirms is present in-scene, and its `PlayCount` is what a runtime assertion checks
 * after a collect/jump (see game-polish-2d/references/audio.md).
 */
export interface AudioSection {
  /**
   * Scene component/object that owns SFX playback (a pooled AudioSource singleton).
   * The manifest gate asserts a GameObject with this name is present; the runtime
   * assertion reads `<component>.PlayCount`. Defaults to "SfxPlayer".
   */
  playerComponent?: string;
  /** The expected SFX cues (jump/dash/collect/hit/bounce/win). */
  cues: AudioCue[];
  note?: string;
}

/** The juice section aggregates the polish-cue specs from mock annotations D–H + J. */
export interface JuiceSection {
  dashTrail?: DashTrailSpec;
  landingDust?: LandingDustSpec;
  fruitPop?: FruitPopSpec;
  hitStop?: HitStopSpec;
  screenShake?: ScreenShakeSpec;
  parallax?: ParallaxSpec;
}

/** Manifest matching strategy for `scene.verify_manifest`. */
export type ManifestMatching = "exact" | "prefix" | "regex";

/** A required scene element for the manifest gate (§3.1 input contract). */
export interface ManifestElement {
  /** Exact name to match. Provide this OR `nameRegex`. */
  name?: string;
  /** Regex pattern to match a name. Provide this OR `name`. */
  nameRegex?: string;
  /** Expected Unity type. */
  type: "GameObject" | "Sprite" | "Prefab";
  /** Optional primitive classification (e.g. "player", "tile"). */
  primitive?: string;
  /** Minimum count expected in scene. Defaults 1. */
  minCount?: number;
  /** Whether absence is a failure (true) or a warning (false). Defaults true. */
  required?: boolean;
}

export interface ManifestSection {
  /** How names resolve against scene objects. */
  matching: ManifestMatching;
  /** Case sensitivity for name matching. Defaults true. */
  caseSensitive?: boolean;
  /** Required scene elements. */
  elements: ManifestElement[];
  /** Treat unexpected objects as a warning (default) or failure. */
  extrasAreFailure?: boolean;
}

/**
 * Tuning for the reachability gate's geometric envelope. All fields optional;
 * the gate derives sane fallbacks from the `feel` budget when omitted.
 */
export interface ReachabilitySection {
  /** Vertical slack (u) added above jump/launch apex when reaching up. Default 0.5. */
  verticalMarginU?: number;
  /**
   * Horizontal reach (u) past a platform edge. Defaults to the feel-derived
   * `dashDistance + runSpeed * airtime` when omitted.
   */
  horizontalMarginU?: number;
  note?: string;
}

/**
 * Tuning for the placement gate's grounded-item float/sink check. All fields
 * optional; the gate defaults to a 0.1u tolerance when omitted.
 */
export interface PlacementSection {
  /**
   * Default float/sink slack (u) between a grounded item's visible bottom Y and
   * its surface top Y, when the item itself omits `toleranceU`. Default 0.1.
   */
  groundedToleranceU?: number;
}

export type RenderViewportMode = "full" | "letterbox" | "any";

/** Screenshot-level render checks for live Game-view frames. */
export interface RenderSection {
  /**
   * "full" (default) means the Game-view screenshot must be filled with the game
   * content; "letterbox" allows intentional bars; "any" disables border policy.
   */
  viewportMode?: RenderViewportMode;
  /** Max allowed edge border fraction for full-viewport demos. Default 0.02. */
  maxBorderFraction?: number;
  /** Optional aspect hint for capture tooling. */
  expectedAspect?: { w: number; h: number };
  /** Hard threshold for long seam/line artifacts. Default 0.85. */
  maxArtifactLineFraction?: number;
  /** Warn threshold for stable-region diff between named states. Default 0.08. */
  maxStableRegionChangeFraction?: number;
  note?: string;
}

/** Platformer-specific tile construction tolerances. */
export interface PlatformerSection {
  /** Allowed fractional drift from whole tile counts. Default 0.01. */
  tileIntegerTolerance?: number;
  /** Allowed collider-vs-visible-surface Y mismatch. Defaults to placement tolerance. */
  colliderSurfaceToleranceU?: number;
  /** Edge columns sampled by the tile-render gate when capture omits edgeCols. Default 2. */
  tileRenderEdgeCols?: number;
  /** Max renderers allowed for one platform span before tile-render fails. Default 2. */
  tileRenderMaxRenderers?: number;
  /** Seam tolerance factor over interior adjacent-column luma delta. Default 4. */
  tileRenderSeamToleranceFactor?: number;
  /** Absolute texture-offset tolerance for TargetFollow parallax response. Default 0.015. */
  parallaxMotionAbsTolerance?: number;
  /** Relative tolerance for TargetFollow parallax response. Default 0.15. */
  parallaxMotionRelTolerance?: number;
  /** Idle texture-offset drift tolerance. Default 0.001. */
  parallaxMotionIdleTolerance?: number;
  note?: string;
}

/**
 * The closed set of semantic prop roles, as VALUES so the contract validator can
 * check a declared `props.purposes[].purpose` against the same list the type
 * enforces at compile time (the union below is derived from this array, so the
 * two cannot drift).
 */
export const PROP_PURPOSE_ROLES = [
  "route_platform",
  "blocker",
  "hazard",
  "launcher",
  "collectible",
  "collectible_support",
  "goal",
  "cover",
  "enemy",
  "decor",
  "pickup",
] as const;

export type PropPurposeRole = (typeof PROP_PURPOSE_ROLES)[number];

export interface PropPurposeSpec {
  name?: string;
  nameRegex?: string;
  purpose: PropPurposeRole;
  required?: boolean;
  evidenceRequired?: boolean;
  note?: string;
}

/**
 * Tuning for the prop-purpose gate (catches purposeless / player-clipping props).
 * All fields optional; the gate defaults `interactableScripts` to the common 2D
 * gameplay roles and `checkPlayerOverlap` to true (the player-overlap rule runs
 * unless explicitly disabled with `checkPlayerOverlap: false`).
 */
export interface PropsSection {
  /**
   * Prop names that are KNOWN-good decoration with no gameplay role — they pass
   * the purpose check even with no collider/script. Leave empty so an unannotated
   * purposeless prop fails. Also exempts the prop from the GROUNDING check.
   */
  intentionalDecor?: string[];
  /**
   * Prop names that are DELIBERATELY ungrounded (a floating collectible, a cloud)
   * — they're exempt from the GROUNDING check (prop bottom must rest on a ground)
   * but still subject to PURPOSE + PLAYER-OVERLAP. `intentionalDecor` names are
   * exempt too, so this is only needed for a floating prop that still has a
   * gameplay role. Leave empty so an unannotated floating prop fails grounding.
   */
  intentionalFloating?: string[];
  /**
   * Whether to assert no prop's bounds intersect the player's bounds at spawn.
   * Defaults true; set false to disable the player-overlap rule.
   */
  checkPlayerOverlap?: boolean;
  /**
   * Script class names that make a prop FUNCTIONAL. A prop with a collider OR one
   * of these scripts has a gameplay purpose. Defaults to
   * `["Collectible","Hazard","Trampoline","LevelGoal"]` when omitted.
   */
  interactableScripts?: string[];
  /**
   * Semantic gameplay-purpose declarations for non-ground props. When present,
   * solid non-decor props are checked against these roles, and route/launcher/
   * blocker props need route evidence so a collider-only crate cannot pass.
   */
  purposes?: PropPurposeSpec[];
}

export type WinEndStateMode = "modal" | "continuous";

/** Intended win rule and end-state behavior for the playability gate (§3.3). */
export interface WinSection {
  /** The intended/spec rule. */
  rule: "reach-flag" | "all-fruit" | "reach-flag-and-all-fruit" | string;
  /**
   * What happens after win/lose is reached. Defaults to "modal": gameplay input
   * is locked, the player is frozen, hazards/scoring stop mutating state, and
   * only explicit restart/continue UI is active. "continuous" is for games that
   * intentionally keep play/simulation running under a celebration/result layer.
   */
  endStateMode?: WinEndStateMode;
  /** Human-facing restart affordance, e.g. "R", "Enter", or a UI button label. */
  restartAction?: string;
  /**
   * What the *current build* actually does, if it differs from `rule`.
   * A non-null value flags a Phase-F reconcile (conform build vs. update spec).
   */
  buildRule?: string;
  note?: string;
}

export type VerificationGateMode = "required" | "not_applicable";

/**
 * Opt-in SFX verification (SFX dogfood backlog High #7). The four SFX gates
 * (`sfx-presence`, `sfx-runtime`, `inputToSfxLatency`, `sfx-fatigue`) are OPT-IN, not
 * default-on: no bridge capture-producer exists yet, so a contract that does not set
 * `enabled: true` gets ZERO SFX behavior (backward compat). When enabled, the gates
 * grade the SFX captures staged in the verify `--inputs` directory against the resolved
 * genre-pack cue map (also staged, as `sfx-cue-map.json`).
 */
export interface SfxVerificationSection {
  /** Opt-in switch. Absent/false ⇒ the SFX gates never run. */
  enabled: boolean;
  /**
   * Required cues the drive scenario is NOT expected to exercise (e.g. `player_death`
   * on a survival run). Declared here so `sfx-runtime` reports them `not_applicable`
   * WITH a note rather than silently skipping — the "scenario-exempt cues declared,
   * not silently skipped" rule.
   */
  scenarioExemptCues?: string[];
  /** Band for the `inputToSfxLatency` gate (ms) — usually the primary input-confirm cue. */
  inputToSfxLatencyMs?: NumericTarget;
  note?: string;
}

export interface VerificationSection {
  /**
   * Per-game gate applicability. Omitted gates default to "required" so existing
   * platformer contracts keep their current behavior.
   */
  gates?: Record<string, VerificationGateMode>;
  /** Opt-in SFX verification (backlog High #7). Absent ⇒ no SFX gates run. */
  sfx?: SfxVerificationSection;
  /**
   * Optional anti-compression gate (dogfood learnings §6 / High #7). Each named evidence
   * class (from the fixed `EVIDENCE_CLASSES` enum) MUST be `"present"` in the
   * verdict's `evidenceClasses` block or `loombridge doneness` REFUSES — so
   * "console clean" can never imply "playtest verified." Absent ⇒ no new gate
   * (backward compat); the verdict still always emits the `evidenceClasses` block.
   */
  requiredEvidenceClasses?: string[];
  note?: string;
}

export interface GateTuningSection {
  /** Generic per-gate tuning. Keys are gate ids, values are gate-owned options. */
  byGate?: Record<string, Record<string, unknown>>;
  note?: string;
}

/** Gray-box / feel-only art posture (RCL-D01). */
export type ArtMode = "deferred" | "final";

/**
 * The optional art posture of a build (RCL-D01).
 *
 * - `deferred` — a GRAY-BOX / feel-only build: art is intentionally not yet made
 *   (primitives ARE the current deliverable, "is the loop fun before art"). The
 *   hero-shot fidelity gate is marked NOT-APPLICABLE and `doneness` is satisfied
 *   by the feel-metric bands + structural assertions ALONE (which are STILL
 *   enforced rigorously via the Tier-1 verdict — a feel band out of range still
 *   fails). It is read from disk-truth; a verdict that claims `deferred` while
 *   the on-disk contract does not is REFUSED (no laundering).
 * - `final` — the DEFAULT (when the `art` section is absent): today's behaviour,
 *   hero-shot fidelity fully enforced. An explicit `final` is identical.
 */
export interface ArtSection {
  mode: ArtMode;
  note?: string;
}

/** The full acceptance contract for one game. */
export interface AcceptanceContract {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  /** Game id, e.g. "tiderunner". */
  game: string;
  /**
   * The genre this contract WAS SEEDED FOR, stamped by `loombridge plan` (and by contract promotion)
   * so the artifact whose contents ARE the grading says which genre it grades.
   *
   * WHY IT EXISTS. `plan`'s genre-flip guard reads the genres the project already records from disk,
   * and it read SLICES.json, then FEEL_SPEC.json, then STATE. In the design phase: before any
   * roadmap exists: deleting FEEL_SPEC.json and STATE.md left it with nothing to compare, so a
   * platformer ACCEPTANCE.json (`win.rule: "all-fruit"`, no `verification` block) could be stamped
   * `graded` under a completely different STATE genre. Nothing bound the contract to a genre at all.
   *
   * OPTIONAL, and absent means NO CLAIM, never a default. A hand-authored or legacy contract simply
   * says nothing about its genre and the older evidence sources decide, exactly as before. What is
   * not allowed is a PRESENT value that disagrees with the roadmap: `doneness` refuses on that.
   */
  genre?: string;
  /** Provenance: which sources this contract was authored from. */
  source?: {
    mock?: string;
    feelDoc?: string;
    note?: string;
  };
  fonts: FontsSection;
  palette: PaletteSection;
  hud: HudSection;
  framing: FramingSection;
  /** Project physics settings the feel targets depend on (e.g. 60 Hz fixed timestep). */
  physics?: PhysicsSection;
  feel: FeelSection;
  juice: JuiceSection;
  /** Optional procedural retro-SFX layer (cues + the SfxPlayer that plays them). */
  audio?: AudioSection;
  manifest: ManifestSection;
  win: WinSection;
  /** Optional per-game gate applicability for non-platformer proofs. */
  verification?: VerificationSection;
  /** Optional gray-box / feel-only art posture (RCL-D01). Absent ⇒ `final`. */
  art?: ArtSection;
  /** Optional tuning for the reachability gate's geometric envelope. */
  reachability?: ReachabilitySection;
  /** Optional tuning for the placement gate's grounded-item float/sink check. */
  placement?: PlacementSection;
  /** Optional live screenshot/render-frame policy. */
  render?: RenderSection;
  /** Generic per-gate tuning used by promoted genre contracts. */
  gateTuning?: GateTuningSection;
  /** Optional 2D-platformer structural/tile policy. */
  platformer?: PlatformerSection;
  /** Optional tuning for the prop-purpose gate (purposeless / clipping props). */
  props?: PropsSection;
  /** Optional state-coverage capture pack (plan §3c). The build derives its
   *  per-run captureManifest from this; doneness (§3a) refuses to certify
   *  without every required capture present. */
  capturePack?: CapturePackSection;
  /**
   * Optional HARNESS wiring (review M14): how a measurement recipe REACHES this
   * game, never what the game must feel like. Deliberately a sibling of `feel`,
   * not a member of it: see `domain/harness-seam.ts`. Absent is legal; the feel
   * recipe refuses at run time and names the JSON to add.
   */
  harness?: HarnessSection;
}

/** One state the build must capture from (e.g. spawn / hazard / movement / win). */
export interface CapturePackState {
  /** Stable name, used as the verify subdir (e.g. "spawn"). */
  name: string;
  description?: string;
  /** Prose describing how the agent puts the game into this state (not enforced). */
  probe?: string;
  /**
   * Capture filenames the build must produce for this state. Conventionally
   * stored under `.loombridge/verify/<name>/`, but doneness checks the
   * captureManifest paths verbatim (resolved relative to `.loombridge/verify/`).
   */
  requiredCaptures: string[];
}

export interface CapturePackSection {
  states: CapturePackState[];
}

export interface AcceptanceValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface AcceptanceValidationResult {
  valid: boolean;
  issues: AcceptanceValidationIssue[];
}
