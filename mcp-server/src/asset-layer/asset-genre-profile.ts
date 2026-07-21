/**
 * Asset GENRE profiles — the genre-parametric source of truth for which asset
 * ROLES a draft manifest must cover, how each role maps to registry primitives,
 * and which slices consume which assets.
 *
 * Before this module these were platformer-only globals hard-coded in
 * `asset-manifest.ts` (`REQUIRED_ASSET_ROLES`, `DEFAULT_SLICE_ASSET_BINDINGS`)
 * and `manifest-selection.ts` (`ROLE_SELECTION_RULES`), so a `--genre 3d-shooter`
 * plan still drafted platformer roles. The profile is now resolved from the
 * manifest's `genre` field (absent ⇒ the platformer default, so every existing
 * platformer manifest is byte/semantically unchanged).
 *
 * This is the *manifest role* profile (which roles/slices/selection rules). It is
 * distinct from — and complementary to — the *art validation* `AssetProfile`
 * (`asset-layer/profiles/<id>.json`: primitives, license policy, Unity folders).
 * They share the same genre id so the two line up (manifest `genre:"3d-shooter"`
 * ⇄ art profile `genre:"3d-shooter"`).
 *
 * NOTE: imports from `asset-manifest.ts` are TYPE-ONLY (erased at runtime), so
 * `asset-manifest.ts` can import this module's resolver without a runtime cycle.
 */

import type { AssetManifestMode, AssetSourceType } from "../loomtide/asset-manifest.js";

/** How a manifest role maps onto registry-pack primitives during selection. */
export interface RoleSelectionRule {
  /** Acceptable registry primitives for this role, in preference order. */
  primitives: string[];
  /** Tags every candidate must carry (e.g. platformer `hazard`). */
  requiredTags?: string[];
}

/** A genre's deterministic asset-manifest shape. */
export interface AssetGenreProfile {
  /** asset-genre id; matches the manifest `genre` field and the art profile `genre`. */
  id: string;
  /** The roles a draft manifest must cover (also enforced by the manifest validator). */
  requiredRoles: readonly string[];
  /** The slice → assetIds bindings a fresh draft seeds. */
  defaultSliceBindings: readonly { sliceId: string; assetIds: readonly string[] }[];
  /** Per-role registry-selection rules (which primitives/tags a role accepts). */
  roleSelectionRules: Record<string, RoleSelectionRule>;
  /**
   * Roles drafted as `generated` (rather than `registry`) in HYBRID mode — the
   * roles a genre expects to author from the hero shot rather than pull from a pack.
   */
  hybridGeneratedRoles: ReadonlySet<string>;
}

// ── platformer-2d (the default; byte-for-byte the historical globals) ─────────

const PLATFORMER_REQUIRED_ASSET_ROLES = [
  "player-character",
  "platform-tiles",
  "one-way-platform",
  "hazard",
  "collectible",
  "parallax-background",
  "foreground-prop",
  "hud-style",
  "button-style",
  "vfx-particle",
] as const;

const PLATFORMER_DEFAULT_SLICE_ASSET_BINDINGS = [
  { sliceId: "framing", assetIds: ["player_character", "parallax_background", "foreground_prop"] },
  { sliceId: "ground-tiling", assetIds: ["platform_tiles", "one_way_platform"] },
  { sliceId: "player-feel", assetIds: ["player_character"] },
  { sliceId: "parallax", assetIds: ["parallax_background", "foreground_prop"] },
  { sliceId: "collectibles", assetIds: ["collectible"] },
  { sliceId: "hazards", assetIds: ["hazard"] },
  { sliceId: "hud", assetIds: ["hud_style", "button_style"] },
  { sliceId: "juice", assetIds: ["vfx_particle"] },
  { sliceId: "end-state", assetIds: ["button_style", "hud_style"] },
] as const;

const PLATFORMER_ROLE_SELECTION_RULES: Record<string, RoleSelectionRule> = {
  "player-character": { primitives: ["player"] },
  "platform-tiles": { primitives: ["tile"] },
  "one-way-platform": { primitives: ["tile"] },
  "hazard": { primitives: ["enemy", "decor", "tile"], requiredTags: ["hazard"] },
  "collectible": { primitives: ["collectible"] },
  "parallax-background": { primitives: ["parallax_background", "background"] },
  "foreground-prop": { primitives: ["decor"] },
  "hud-style": { primitives: ["background", "decor", "tile"] },
  "button-style": { primitives: ["tile", "decor"] },
  "vfx-particle": { primitives: ["vfx"] },
};

const PLATFORMER_HYBRID_GENERATED_ROLES: ReadonlySet<string> = new Set([
  "parallax-background",
  "hud-style",
  "button-style",
  "vfx-particle",
]);

export const PLATFORMER_ASSET_GENRE_PROFILE: AssetGenreProfile = {
  id: "platformer-2d",
  requiredRoles: PLATFORMER_REQUIRED_ASSET_ROLES,
  defaultSliceBindings: PLATFORMER_DEFAULT_SLICE_ASSET_BINDINGS,
  roleSelectionRules: PLATFORMER_ROLE_SELECTION_RULES,
  hybridGeneratedRoles: PLATFORMER_HYBRID_GENERATED_ROLES,
};

// ── 3d-shooter (minimal vertical: the smallest role set that makes source-bound
//    registry approval meaningful) ────────────────────────────────────────────
//
// Roles cover the listed categories: player model, enemy model, arena/ground,
// cover prop, weapon + projectile, reticle/HUD, and impact VFX. Model roles
// accept a real source-bound `model` (glb) candidate AND an honest primitive/
// material FALLBACK (capsule/cube) recorded as `placeholder` — never false-green.

const THREE_D_SHOOTER_REQUIRED_ASSET_ROLES = [
  "player-model",
  "enemy-model",
  "arena",
  "cover-prop",
  "weapon-model",
  "projectile",
  "reticle",
  "impact-vfx",
] as const;

const THREE_D_SHOOTER_DEFAULT_SLICE_ASSET_BINDINGS = [
  { sliceId: "arena", assetIds: ["arena", "cover_prop"] },
  { sliceId: "controller-camera", assetIds: ["player_model"] },
  { sliceId: "weapon", assetIds: ["weapon_model", "projectile"] },
  { sliceId: "enemy-target", assetIds: ["enemy_model"] },
  { sliceId: "feedback", assetIds: ["impact_vfx"] },
  { sliceId: "hud", assetIds: ["reticle"] },
  { sliceId: "end-state", assetIds: ["reticle"] },
] as const;

const THREE_D_SHOOTER_ROLE_SELECTION_RULES: Record<string, RoleSelectionRule> = {
  "player-model": { primitives: ["player_model"] },
  "enemy-model": { primitives: ["enemy_model"] },
  "arena": { primitives: ["arena"] },
  "cover-prop": { primitives: ["cover_prop"] },
  "weapon-model": { primitives: ["weapon_model"] },
  "projectile": { primitives: ["projectile"] },
  "reticle": { primitives: ["reticle", "hud"] },
  "impact-vfx": { primitives: ["vfx"] },
};

// In hybrid mode the screen-space/effect roles are authored, not pulled from a pack.
const THREE_D_SHOOTER_HYBRID_GENERATED_ROLES: ReadonlySet<string> = new Set([
  "reticle",
  "impact-vfx",
]);

export const THREE_D_SHOOTER_ASSET_GENRE_PROFILE: AssetGenreProfile = {
  id: "3d-shooter",
  requiredRoles: THREE_D_SHOOTER_REQUIRED_ASSET_ROLES,
  defaultSliceBindings: THREE_D_SHOOTER_DEFAULT_SLICE_ASSET_BINDINGS,
  roleSelectionRules: THREE_D_SHOOTER_ROLE_SELECTION_RULES,
  hybridGeneratedRoles: THREE_D_SHOOTER_HYBRID_GENERATED_ROLES,
};

// ── registry + resolver ──────────────────────────────────────────────────────

/** The asset genre a manifest assumes when its `genre` field is absent. */
export const DEFAULT_ASSET_GENRE = "platformer-2d";

const REGISTRY: Record<string, AssetGenreProfile> = {
  "platformer-2d": PLATFORMER_ASSET_GENRE_PROFILE,
  "3d-shooter": THREE_D_SHOOTER_ASSET_GENRE_PROFILE,
};

/** The registered asset genres, in registration order. */
export function knownAssetGenres(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve the asset-genre profile for `genre`. An absent/empty genre falls back
 * to the platformer default for old manifests. A PRESENT but unregistered genre
 * is refused so new non-platformer plans cannot silently draft platformer roles.
 */
export function resolveAssetGenreProfile(genre?: string | null): AssetGenreProfile {
  if (typeof genre !== "string" || genre.trim().length === 0) {
    return PLATFORMER_ASSET_GENRE_PROFILE;
  }
  if (Object.prototype.hasOwnProperty.call(REGISTRY, genre)) {
    return REGISTRY[genre]!;
  }
  throw new Error(
    `No asset genre profile is registered for '${genre}'. Known asset genres: ${knownAssetGenres().join(", ")}`,
  );
}

/** Decide a draft asset's source type for a role under a manifest mode + genre profile. */
export function draftSourceForRole(
  mode: AssetManifestMode,
  role: string,
  profile: AssetGenreProfile,
): AssetSourceType {
  if (mode === "generated") return "generated";
  if (mode === "registry") return "registry";
  // hybrid: the genre's authored roles are generated; everything else is registry.
  return profile.hybridGeneratedRoles.has(role) ? "generated" : "registry";
}

// ── back-compat re-exports ───────────────────────────────────────────────────
// The platformer role list + slice bindings are still imported by name across the
// codebase + tests. They are the platformer profile's data, surfaced here as the
// canonical constants so there is a single source of truth.

export const REQUIRED_ASSET_ROLES = PLATFORMER_REQUIRED_ASSET_ROLES;
export type RequiredAssetRole = (typeof PLATFORMER_REQUIRED_ASSET_ROLES)[number];
export const DEFAULT_SLICE_ASSET_BINDINGS = PLATFORMER_DEFAULT_SLICE_ASSET_BINDINGS;
