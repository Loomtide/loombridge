/**
 * Platformer feel profiles (S5a — Profile Contract).
 *
 * A *profile* is a product-owned, named set of MEASURABLE feel target bands for a
 * family of 2D platformer feels (`precision` / `classic` / `momentum`). It is the
 * verify-first counterpart to a game's `AcceptanceContract.feel` section: where a
 * contract pins one game's exact feel, a profile says "for THIS kind of platformer,
 * a healthy `jumpApex` sits in THIS band". `loomtide verify` selects a profile and
 * reports measured-vs-band per metric (plan §S5a, §S5d).
 *
 * Design rule (anti-false-green): a profile must define a TOLERANCE BAND on every
 * metric — never an exact target. Feel is measured behaviorally and never lands on
 * an exact value, so an exact (band-less) target would only ever FAIL or be a vibe
 * with no honest pass window. The validator REFUSES a band-less metric. This mirrors
 * the §3a "refuse a missing binding field" discipline in CLAUDE.md: an absent band is
 * a refusal, not a silently-accepted prose vibe.
 *
 * Each metric target reuses the verification `NumericTarget` / `ToleranceBand` shape
 * so the existing feel gate's `bandWindow`/`withinBand` consume a profile target
 * unchanged.
 */

import type { NumericTarget, ToleranceBand } from "../../../verification/types.js";

export const PLATFORMER_PROFILE_SCHEMA_VERSION = "1" as const;

/**
 * Profile metric units. The canonical definition now lives in the genre-neutral `feel-primitives`
 * module (Phase 1a decoupling); re-exported here for back-compat with the platformer pack's consumers.
 */
import {
  SUPPORTED_PROFILE_UNITS,
  SUPPORTED_PROFILE_UNIT_SET,
  type ProfileUnit,
} from "../../feel-primitives.js";

export { SUPPORTED_PROFILE_UNITS, SUPPORTED_PROFILE_UNIT_SET, type ProfileUnit };

/** Family a metric belongs to (used for grouping in the developer report). */
export type ProfileMetricFamily =
  | "run"
  | "jump"
  | "fall"
  | "dash"
  | "forgiveness"
  | "camera"
  | "feedback"
  | "weapon"
  // F5: how MOTION BEGINS (Layer-1 kinematics), not just where it ends — e.g. the
  // input→first-motion latency. Distinct from the endpoint families above.
  | "responsiveness"
  // L3b: CROSS-MODAL SYNC — the latency between an input/event edge and a second
  // modality firing (a sound cue, a particle spawn). The first feel layer ABOVE
  // kinematics. Measure-only (no shipped profile bands it).
  | "sync";

/** A known, measurable platformer feel metric and the unit it is expressed in. */
export interface ProfileMetricSpec {
  /** Stable metric id (the key used in a profile's `metrics` map). */
  id: string;
  /** The single canonical unit this metric is measured in. */
  unit: ProfileUnit;
  family: ProfileMetricFamily;
  /** Short human label for the report. */
  label: string;
  /**
   * One-sentence vocabulary-level "why it matters". This is the metric's intrinsic
   * description (independent of any profile's band) — surfaced when the metric is
   * REPORTED but not banded by the selected profile (F5 "also measured"). A profile
   * target's own `whyItMatters` (band-specific copy) takes precedence when banded.
   */
  whyItMatters?: string;
}

/**
 * The closed vocabulary of metric ids a profile may target. A profile metric whose
 * id is not in this map is refused (`UNKNOWN_METRIC`) — profiles cannot invent
 * unmeasurable vibes. Each metric pins ONE canonical unit, so a metric expressed in
 * a supported-but-wrong unit (e.g. `runSpeed` in `ms`) is refused (`WRONG_UNIT`).
 *
 * Aligned with `FeelSection` (`mcp-server/src/verification/types.ts`) + the
 * measurable primitive families in the S5 plan (§Deliverables 2).
 */
export const KNOWN_PROFILE_METRICS: Record<string, ProfileMetricSpec> = {
  // ── run ──
  runSpeed: { id: "runSpeed", unit: "u/s", family: "run", label: "Run speed" },
  runAcceleration: {
    id: "runAcceleration",
    unit: "u/s^2",
    family: "run",
    label: "Run acceleration",
  },
  runDeceleration: {
    id: "runDeceleration",
    unit: "u/s^2",
    family: "run",
    label: "Run deceleration",
  },
  // ── jump ──
  jumpApex: { id: "jumpApex", unit: "u", family: "jump", label: "Jump apex height" },
  timeToApex: { id: "timeToApex", unit: "ms", family: "jump", label: "Time to apex" },
  shortHopApex: {
    id: "shortHopApex",
    unit: "u",
    family: "jump",
    label: "Short-hop apex height",
  },
  // ── fall ──
  fallGravityMultiplier: {
    id: "fallGravityMultiplier",
    unit: "x",
    family: "fall",
    label: "Fall-gravity multiplier",
  },
  maxFallSpeed: { id: "maxFallSpeed", unit: "u/s", family: "fall", label: "Max fall speed" },
  // ── dash ──
  dashDistance: { id: "dashDistance", unit: "u", family: "dash", label: "Dash distance" },
  dashTime: { id: "dashTime", unit: "s", family: "dash", label: "Dash duration" },
  dashCooldown: { id: "dashCooldown", unit: "s", family: "dash", label: "Dash cooldown" },
  // ── forgiveness ──
  coyoteTime: {
    id: "coyoteTime",
    unit: "s",
    family: "forgiveness",
    label: "Coyote time",
  },
  jumpBuffer: {
    id: "jumpBuffer",
    unit: "s",
    family: "forgiveness",
    label: "Jump buffer",
  },
  // ── camera ──
  cameraLookahead: {
    id: "cameraLookahead",
    unit: "u",
    family: "camera",
    label: "Camera look-ahead",
  },
  cameraSettleTime: {
    id: "cameraSettleTime",
    unit: "ms",
    family: "camera",
    label: "Camera settle time",
  },
  // ── feedback (action-platformer juice) ──
  hitStopMs: { id: "hitStopMs", unit: "ms", family: "feedback", label: "Hit-stop" },
  screenShakePx: {
    id: "screenShakePx",
    unit: "px",
    family: "feedback",
    label: "Screen-shake amplitude",
  },
  knockbackImpulse: {
    id: "knockbackImpulse",
    unit: "u/s",
    family: "feedback",
    label: "Knockback impulse",
  },
  // ── responsiveness (F5: how motion BEGINS) ──
  inputLatency: {
    id: "inputLatency",
    unit: "ms",
    family: "responsiveness",
    label: "Input latency",
    whyItMatters:
      "Time from pressing a movement key to the first detectable motion. Low latency is what 'tight' feels like; high latency reads as mushy or laggy even when every endpoint metric (speed/apex) is correct.",
  },
  // ── sync (L3b: cross-modal latency — measure-only, never banded) ──
  inputToSfxLatency: {
    id: "inputToSfxLatency",
    unit: "ms",
    family: "sync",
    label: "Input → SFX latency",
    whyItMatters:
      "Time from the input onset to the matching sound cue firing. A sound that lags the action by even ~100ms reads as disconnected ('the jump and its whoosh don't belong together'); tight cross-modal sync is a large part of why a game feels 'juicy' rather than silent-then-noise. Measure-only — surfaced informationally, never banded.",
  },
  dashToGhostMs: {
    id: "dashToGhostMs",
    unit: "ms",
    family: "sync",
    label: "Dash → ghost-trail latency",
    whyItMatters:
      "Time from the dash starting to the afterimage/ghost trail appearing. The trail is the visual confirmation that the dash 'fired'; if it lags the dash it reads as a disconnected smear rather than a crisp burst of speed. Tight dash→ghost sync is what makes a dash feel snappy and powerful. Measure-only — surfaced informationally, never banded.",
  },
  groundContactToDustMs: {
    id: "groundContactToDustMs",
    unit: "ms",
    family: "sync",
    label: "Ground-contact → landing-dust latency",
    whyItMatters:
      "Time from the player touching down after a fall to the landing dust appearing. The dust is the visual confirmation of the impact; if it lags the touchdown the landing reads mushy/disconnected rather than a solid, weighty thump. Measure-only — surfaced informationally, never banded.",
  },
  inputToAnimStateLatency: {
    id: "inputToAnimStateLatency",
    unit: "ms",
    family: "sync",
    label: "Input → animation-state latency",
    whyItMatters:
      "Time from the input to the matching animation state starting (e.g. jump press → the 'jump' animation). Animation that lags the input reads as the character reacting late / mushy rather than crisply responding. Measure-only — surfaced informationally, never banded.",
  },
  fireIntervalMs: {
    id: "fireIntervalMs",
    unit: "ms",
    family: "sync",
    label: "Fire interval",
    whyItMatters:
      "Mean time between observed fire/shot events. This is the cadence spine of weapon feel: too slow reads sluggish, too fast reads noisy or uncontrollable. Measure-only until a shooter profile bands it.",
  },
  fireInputToSpawnLatency: {
    id: "fireInputToSpawnLatency",
    unit: "ms",
    family: "sync",
    label: "Fire input → projectile-spawn latency",
    whyItMatters:
      "Time from the fire input onset to the projectile becoming observable through an explicit spawn signal. This is the weapon-response edge: high latency makes shots feel delayed even if cadence and projectile speed are correct. Measure-only until a shooter profile bands it.",
  },
  projectileSpeed: {
    id: "projectileSpeed",
    unit: "u/s",
    family: "weapon",
    label: "Projectile speed",
    whyItMatters:
      "Median moving speed of the fired projectile. This is the travel-time spine of shooter feel: slow shots feel floaty and dodgeable, while fast shots feel crisp and hitscan-adjacent. Measure-only until a shooter profile bands it.",
  },
  ttkMs: {
    id: "ttkMs",
    unit: "ms",
    family: "sync",
    label: "Time to kill (reference enemy)",
    whyItMatters:
      "Time from the first hit landing on the reference enemy to its death. This is the combat-pacing spine: too low and encounters feel trivial/twitchless, too high and they feel spongy and unsatisfying. Measured first-hit→death so it is independent of the player's aim time. Measure-only until a shooter profile bands it.",
  },
};

export const KNOWN_PROFILE_METRIC_IDS: ReadonlySet<string> = new Set(
  Object.keys(KNOWN_PROFILE_METRICS),
);

/**
 * F3 — the closed vocabulary of MECHANISM ids a profile may `require`/`forbid`.
 *
 * A *mechanism* is a movement CAPABILITY (does the controller have a dash? a
 * variable-height jump?), not a metric VALUE. Bands check values; the F1 hole
 * (#166) was that omitting a *metric* is not a statement that the *mechanic* is
 * absent — a live air-dash passed `classic` because `classic` simply omitted dash
 * metrics. The `mechanisms` block lets a profile state presence/absence and the
 * gate verifies it BEHAVIORALLY (a captured-trajectory signature, never a
 * controller self-report — see `mechanisms.ts`).
 *
 * Each id here MUST have a defined behavioral probe (see `KNOWN_MECHANISMS` below
 * and `mechanisms.ts`). `wallSlide`/`wallJump` are deliberately OUT (no controller
 * support + need a wall fixture; deferred with `maxFallSpeed`). An entry outside
 * this set is refused (`UNKNOWN_MECHANISM`).
 */
export const KNOWN_MECHANISMS = [
  "airDash",
  "variableJump",
  "fallGravityAsymmetry",
  "coyote",
  "jumpBuffer",
] as const;

export type MechanismId = (typeof KNOWN_MECHANISMS)[number];

export const KNOWN_MECHANISM_SET: ReadonlySet<string> = new Set(KNOWN_MECHANISMS);

/**
 * A profile's mechanism identity (F3). Both lists draw from `KNOWN_MECHANISMS`.
 * An id in BOTH `requires` and `forbids` is a contradiction (`CONTRADICTORY_MECHANISM`).
 * An empty block (`requires: [], forbids: []`) is valid — it asserts nothing
 * (momentum's mechanism identity isn't settled, so it claims neither).
 */
export interface ProfileMechanisms {
  /** Mechanisms whose behavioral signature MUST be present. */
  requires: string[];
  /** Mechanisms whose behavioral signature MUST be absent. */
  forbids: string[];
}

/** Profile id pattern: lowercase kebab, must start with a letter. */
export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * One metric target in a profile. Reuses `NumericTarget` but REQUIRES a `band`
 * (profiles never assert exact feel — see module note). `whyItMatters` / `suggestion`
 * are report copy consumed by S5d, not by the deterministic comparison.
 */
export interface ProfileMetricTarget extends NumericTarget {
  /** REQUIRED for profiles: the pass window. A band-less metric is refused. */
  band: ToleranceBand;
  /** One-sentence "why it matters" for the developer report. */
  whyItMatters?: string;
  /** Concrete parameter advice when a measurement falls outside the band. */
  suggestion?: string;
}

/**
 * F2 — the `build` block. The verify bands say what a healthy feel MEASURES; the
 * `build` block holds ONLY what the build side cannot analytically derive from a
 * band (`resolveStartingParams` derives jumpSpeed/gravityScale/moveSpeed from the
 * band targets; everything in `stored` is the un-solvable remainder).
 *
 * Refusal discipline (mirrors `MISSING_BAND`): when `build` is present, the solve
 * inputs (`jumpApex`/`timeToApex`/`runSpeed`) MUST be banded
 * (`BUILD_SOLVE_MISSING_BAND`), and a stored `jumpCutMultiplier` MUST trace to a
 * `shortHopApex` band so it stays verifiable (`BUILD_PARAM_UNVERIFIABLE`).
 */
export interface ProfileBuildStored {
  /**
   * The jump-cut multiplier applied on early button release — NOT analytically
   * solvable from a band (friction #1). A profile may store it ONLY if it bands
   * `shortHopApex` (so the param is verifiable); else the validator refuses.
   */
  jumpCutMultiplier?: number;
}

export interface ProfileBuild {
  /** The physics timestep the solve + discretization correction assume. */
  fixedTimestep: number;
  /** Un-solvable starting params (today: jumpCutMultiplier). */
  stored: ProfileBuildStored;
}

/** A product-owned 2D platformer feel profile. */
export interface PlatformerFeelProfile {
  schemaVersion: typeof PLATFORMER_PROFILE_SCHEMA_VERSION;
  /** Stable profile id (matches `PROFILE_ID_PATTERN`), e.g. "precision". */
  id: string;
  /** Human title, e.g. "Precision Platformer". */
  title: string;
  /** One-line intent. */
  summary: string;
  /** Optional example games that exemplify this feel (prose, not enforced). */
  exemplars?: string[];
  /**
   * Measurable target bands keyed by a `KNOWN_PROFILE_METRICS` id. MUST be non-empty
   * — a profile with no measurable metrics is refused (`NO_METRICS`).
   */
  metrics: Record<string, ProfileMetricTarget>;
  /**
   * F2 — optional build-side identity: the starting params the band targets can't
   * derive. Absent on a verify-only profile. When present it must satisfy the
   * `BUILD_*` refusal rules (see `ProfileBuild`).
   */
  build?: ProfileBuild;
  /**
   * F3 — optional mechanism identity: which movement CAPABILITIES this feel
   * requires/forbids (verified behaviorally by the `mechanisms` gate). Absent on a
   * profile that makes no mechanism claim. When present, every id must be in
   * `KNOWN_MECHANISMS` and `requires ∩ forbids = ∅` (else the validator refuses).
   */
  mechanisms?: ProfileMechanisms;
}

export interface ProfileValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface ProfileValidationResult {
  valid: boolean;
  issues: ProfileValidationIssue[];
}
