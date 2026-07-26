/**
 * Asset Manifest contract — `.loombridge/ASSET_MANIFEST.json`.
 *
 * This is the product-owned visual provenance contract between the approved
 * hero shot and slice builds. It is deliberately deterministic and offline:
 * no registry lookup, no Unity, no network. Future plan/build slices consume
 * this contract; this module only validates and reads/writes it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ASSET_GENRE,
  DEFAULT_SLICE_ASSET_BINDINGS,
  REQUIRED_ASSET_ROLES,
  draftSourceForRole,
  knownAssetGenres,
  resolveAssetGenreProfile,
  type RequiredAssetRole,
} from "../../asset-layer/asset-genre-profile.js";
import { isSafeCapturePath } from "../../domain/capture-paths.js";
import { defaultGenreId } from "../genre/genre-registry.js";
import type { LoombridgePaths } from "../../domain/state.js";
import { packageRoot } from "../../shared/pkg-root.js";

// Re-export the platformer role list + slice bindings (now owned by the
// asset-genre-profile module) so existing importers and tests are unchanged.
export { DEFAULT_SLICE_ASSET_BINDINGS, REQUIRED_ASSET_ROLES, type RequiredAssetRole };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ASSET_MANIFEST_SCHEMA_PATH = path.join(
  packageRoot(import.meta.url),
  "src",
  "domain",
  "schemas",
  "asset-manifest.schema.json",
);

export const ASSET_MANIFEST_VERSION = 1;

export type AssetManifestMode = "registry" | "generated" | "hybrid";
export type AssetManifestStatus = "draft" | "approved";
export type AssetSourceKind = "registry-pack" | "generated-set" | "manual-import";
export type AssetSourceType = "registry" | "generated" | "manual";
export type AssetStatus = "approved" | "needed" | "placeholder";

export const ASSET_MANIFEST_MODES = new Set<AssetManifestMode>([
  "registry",
  "generated",
  "hybrid",
]);

export const ASSET_STATUSES = new Set<AssetStatus>(["approved", "needed", "placeholder"]);
export const ASSET_SOURCE_TYPES = new Set<AssetSourceType>(["registry", "generated", "manual"]);
export const ASSET_SOURCE_KINDS = new Set<AssetSourceKind>([
  "registry-pack",
  "generated-set",
  "manual-import",
]);

export interface HeroShotRef {
  path: string;
  sha256: string;
}

export interface AssetSourceRef {
  id: string;
  kind: AssetSourceKind;
  registry?: string;
  license?: string;
  approved: boolean;
}

export interface HeroRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ManifestAsset {
  id: string;
  role: string;
  source: AssetSourceType;
  sourceId?: string;
  status: AssetStatus;
  heroRegion?: HeroRegion;
  requiredOutputs: string[];
  resolvedPaths?: string[];
  styleLock?: string;
  registrySelection?: ManifestRegistrySelection;
  generatedExport?: ManifestGeneratedExport;
  /**
   * Gray-box / feel-only (RCL-D02): an explicit per-role declaration that the
   * engine PRIMITIVE is the intended FINAL deliverable for this role (not a
   * registry-missing gap, not a placeholder to swap before shipping). Such a
   * role passes the asset gate by design — its approved binding does NOT require
   * resolved file paths or registry/generated provenance, and the asset-source
   * fidelity gate marks it PASS. A role NOT marked `primitiveFinal` still
   * requires a real, path-bound asset exactly as before.
   */
  primitiveFinal?: boolean;
}

export interface ManifestRegistrySelection {
  registryAssetId: string;
  packId: string;
  primitive: string;
  license: {
    name: string;
    spdx: string;
    url: string;
    requiresAttribution: boolean;
  };
  source: {
    title: string;
    url: string;
    author: string;
    provenance: Record<string, unknown>;
  };
  provider: {
    name: string;
    url: string;
  };
  placeholder: boolean;
}

export interface ManifestGeneratedExport {
  generatedSetId: string;
  generator: string;
  sourceImageSha256: string;
  producedAt: string;
  license: string;
  provenance: {
    origin: "hero-shot-annotation" | "manual-export" | "procedural";
    annotationId?: string;
    prompt?: string;
    seed?: string | number;
    tool?: string;
    notes?: string;
    [key: string]: unknown;
  };
}

export interface SliceAssetBinding {
  sliceId: string;
  assetIds: string[];
}

export interface AssetReplacementPolicy {
  allowUnapprovedRegistryFallback: boolean;
  allowPlaceholders: boolean;
  requiresUserApprovalForSourceChange: boolean;
}

export interface AssetManifest {
  version: typeof ASSET_MANIFEST_VERSION;
  /**
   * OPTIONAL asset genre id (e.g. "3d-shooter"). Selects which required roles,
   * slice bindings, and registry role-rules apply. ABSENT ⇒ the platformer
   * default — so every pre-existing manifest is unchanged.
   */
  genre?: string;
  mode: AssetManifestMode;
  status: AssetManifestStatus;
  approvedAt?: string | null;
  heroShot: HeroShotRef;
  assetSources: AssetSourceRef[];
  assets: ManifestAsset[];
  sliceBindings: SliceAssetBinding[];
  replacementPolicy: AssetReplacementPolicy;
}

export interface CreateDraftAssetManifestArgs {
  mode: AssetManifestMode;
  heroShot: HeroShotRef;
  registry?: string;
  /** Asset genre id; selects the role/slice/selection profile. Omitted ⇒ platformer. */
  genre?: string;
}

export interface AssetManifestValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface AssetManifestValidationResult {
  valid: boolean;
  issues: AssetManifestValidationIssue[];
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function push(
  issues: AssetManifestValidationIssue[],
  code: string,
  message: string,
  issuePath: string,
): void {
  issues.push({ code, message, path: issuePath });
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      push(issues, "UNKNOWN_FIELD", `${issuePath}: unknown field '${key}'.`, issuePath);
    }
  }
}

function validateSafePath(
  value: unknown,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  if (!isNonEmptyString(value)) {
    push(issues, "MISSING_FIELD", `${issuePath} must be a non-empty string.`, issuePath);
  } else if (!isSafeCapturePath(value)) {
    push(issues, "UNSAFE_PATH", `${issuePath} '${value}' is not a safe relative path.`, issuePath);
  }
}

function validateHeroShot(value: unknown, issues: AssetManifestValidationIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "MISSING_FIELD", "heroShot must be an object.", "heroShot");
    return;
  }
  validateKnownKeys(value, new Set(["path", "sha256"]), issues, "heroShot");
  validateSafePath(value.path, issues, "heroShot.path");
  if (!isNonEmptyString(value.sha256) || !SHA256_RE.test(value.sha256)) {
    push(issues, "INVALID_HASH", "heroShot.sha256 must be a lowercase sha256 hex digest.", "heroShot.sha256");
  }
}

function validateSources(
  value: unknown,
  issues: AssetManifestValidationIssue[],
): { ids: Set<string>; registryApproved: Set<string> } {
  const ids = new Set<string>();
  const registryApproved = new Set<string>();
  if (!Array.isArray(value)) {
    push(issues, "MISSING_FIELD", "assetSources must be an array.", "assetSources");
    return { ids, registryApproved };
  }
  value.forEach((source, i) => {
    const p = `assetSources[${i}]`;
    if (!isRecord(source)) {
      push(issues, "INVALID_FIELD", `${p} must be an object.`, p);
      return;
    }
    validateKnownKeys(source, new Set(["id", "kind", "registry", "license", "approved"]), issues, p);
    if (!isNonEmptyString(source.id)) {
      push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
    } else if (!SAFE_ID_RE.test(source.id)) {
      push(issues, "INVALID_ID", `${p}.id '${source.id}' must match ${SAFE_ID_RE}.`, `${p}.id`);
    } else if (ids.has(source.id)) {
      push(issues, "DUPLICATE_ID", `${p}.id '${source.id}' is duplicated.`, `${p}.id`);
    } else {
      ids.add(source.id);
    }
    if (!isNonEmptyString(source.kind) || !ASSET_SOURCE_KINDS.has(source.kind as AssetSourceKind)) {
      push(issues, "INVALID_SOURCE_KIND", `${p}.kind must be registry-pack|generated-set|manual-import.`, `${p}.kind`);
    }
    if (source.kind === "registry-pack" && !isNonEmptyString(source.registry)) {
      push(issues, "MISSING_FIELD", `${p}.registry is required for registry-pack.`, `${p}.registry`);
    }
    if (source.registry !== undefined && !isNonEmptyString(source.registry)) {
      push(issues, "INVALID_FIELD", `${p}.registry must be a non-empty string.`, `${p}.registry`);
    }
    if (source.license !== undefined && !isNonEmptyString(source.license)) {
      push(issues, "INVALID_FIELD", `${p}.license must be a non-empty string.`, `${p}.license`);
    }
    if (typeof source.approved !== "boolean") {
      push(issues, "MISSING_FIELD", `${p}.approved must be boolean.`, `${p}.approved`);
    } else if (source.kind === "registry-pack" && source.approved && isNonEmptyString(source.id)) {
      registryApproved.add(source.id);
    }
  });
  return { ids, registryApproved };
}

function validateHeroRegion(
  value: unknown,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_FIELD", `${issuePath} must be an object.`, issuePath);
    return;
  }
  validateKnownKeys(value, new Set(["x", "y", "w", "h"]), issues, issuePath);
  for (const key of ["x", "y", "w", "h"] as const) {
    if (!isFiniteNumber(value[key]) || value[key] < 0) {
      push(issues, "INVALID_FIELD", `${issuePath}.${key} must be a non-negative number.`, `${issuePath}.${key}`);
    }
  }
  if (isFiniteNumber(value.w) && value.w <= 0) {
    push(issues, "INVALID_FIELD", `${issuePath}.w must be > 0.`, `${issuePath}.w`);
  }
  if (isFiniteNumber(value.h) && value.h <= 0) {
    push(issues, "INVALID_FIELD", `${issuePath}.h must be > 0.`, `${issuePath}.h`);
  }
}

function validateProvenanceObject(
  value: unknown,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  if (!isRecord(value)) {
    push(issues, "MISSING_FIELD", `${issuePath} must be an object.`, issuePath);
    return;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!isNonEmptyString(key)) {
      push(issues, "INVALID_FIELD", `${issuePath} contains an empty provenance key.`, issuePath);
    }
    if (
      typeof fieldValue !== "string" &&
      typeof fieldValue !== "number" &&
      typeof fieldValue !== "boolean" &&
      fieldValue !== null
    ) {
      push(issues, "INVALID_FIELD", `${issuePath}.${key} must be a scalar provenance value.`, `${issuePath}.${key}`);
    }
  }
}

function validateRegistrySelection(
  value: unknown,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_FIELD", `${issuePath} must be an object.`, issuePath);
    return;
  }
  validateKnownKeys(
    value,
    new Set(["registryAssetId", "packId", "primitive", "license", "source", "provider", "placeholder"]),
    issues,
    issuePath,
  );
  for (const key of ["registryAssetId", "packId", "primitive"] as const) {
    if (!isNonEmptyString(value[key])) {
      push(issues, "MISSING_FIELD", `${issuePath}.${key} must be a non-empty string.`, `${issuePath}.${key}`);
    }
  }
  if (!isRecord(value.license)) {
    push(issues, "MISSING_FIELD", `${issuePath}.license must be an object.`, `${issuePath}.license`);
  } else {
    validateKnownKeys(value.license, new Set(["name", "spdx", "url", "requiresAttribution"]), issues, `${issuePath}.license`);
    for (const key of ["name", "spdx", "url"] as const) {
      if (!isNonEmptyString(value.license[key])) {
        push(issues, "MISSING_FIELD", `${issuePath}.license.${key} must be a non-empty string.`, `${issuePath}.license.${key}`);
      }
    }
    if (typeof value.license.requiresAttribution !== "boolean") {
      push(issues, "MISSING_FIELD", `${issuePath}.license.requiresAttribution must be boolean.`, `${issuePath}.license.requiresAttribution`);
    }
  }
  if (!isRecord(value.source)) {
    push(issues, "MISSING_FIELD", `${issuePath}.source must be an object.`, `${issuePath}.source`);
  } else {
    validateKnownKeys(value.source, new Set(["title", "url", "author", "provenance"]), issues, `${issuePath}.source`);
    for (const key of ["title", "url", "author"] as const) {
      if (!isNonEmptyString(value.source[key])) {
        push(issues, "MISSING_FIELD", `${issuePath}.source.${key} must be a non-empty string.`, `${issuePath}.source.${key}`);
      }
    }
    validateProvenanceObject(value.source.provenance, issues, `${issuePath}.source.provenance`);
  }
  if (!isRecord(value.provider)) {
    push(issues, "MISSING_FIELD", `${issuePath}.provider must be an object.`, `${issuePath}.provider`);
  } else {
    validateKnownKeys(value.provider, new Set(["name", "url"]), issues, `${issuePath}.provider`);
    for (const key of ["name", "url"] as const) {
      if (!isNonEmptyString(value.provider[key])) {
        push(issues, "MISSING_FIELD", `${issuePath}.provider.${key} must be a non-empty string.`, `${issuePath}.provider.${key}`);
      }
    }
  }
  if (typeof value.placeholder !== "boolean") {
    push(issues, "MISSING_FIELD", `${issuePath}.placeholder must be boolean.`, `${issuePath}.placeholder`);
  }
}

function validateGeneratedExport(
  value: unknown,
  issues: AssetManifestValidationIssue[],
  issuePath: string,
): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_FIELD", `${issuePath} must be an object.`, issuePath);
    return;
  }
  validateKnownKeys(
    value,
    new Set(["generatedSetId", "generator", "sourceImageSha256", "producedAt", "license", "provenance"]),
    issues,
    issuePath,
  );
  for (const key of ["generatedSetId", "generator", "license"] as const) {
    if (!isNonEmptyString(value[key])) {
      push(issues, "MISSING_FIELD", `${issuePath}.${key} must be a non-empty string.`, `${issuePath}.${key}`);
    }
  }
  if (!isNonEmptyString(value.sourceImageSha256) || !SHA256_RE.test(value.sourceImageSha256)) {
    push(issues, "INVALID_HASH", `${issuePath}.sourceImageSha256 must be a lowercase sha256 hex digest.`, `${issuePath}.sourceImageSha256`);
  }
  if (!isNonEmptyString(value.producedAt) || !ISO_DATE_RE.test(value.producedAt)) {
    push(issues, "INVALID_FIELD", `${issuePath}.producedAt must be an ISO timestamp.`, `${issuePath}.producedAt`);
  }
  if (!isRecord(value.provenance)) {
    push(issues, "MISSING_FIELD", `${issuePath}.provenance must be an object.`, `${issuePath}.provenance`);
  } else {
    if (
      value.provenance.origin !== "hero-shot-annotation" &&
      value.provenance.origin !== "manual-export" &&
      value.provenance.origin !== "procedural"
    ) {
      push(
        issues,
        "INVALID_FIELD",
        `${issuePath}.provenance.origin must be hero-shot-annotation|manual-export|procedural.`,
        `${issuePath}.provenance.origin`,
      );
    }
    validateProvenanceObject(value.provenance, issues, `${issuePath}.provenance`);
  }
}

function validateAssets(
  value: unknown,
  sourceIds: Set<string>,
  registryApprovedSourceIds: Set<string>,
  mode: AssetManifestMode | null,
  status: AssetManifestStatus | null,
  allowPlaceholders: boolean | null,
  requiredRoles: readonly string[],
  artDeferred: boolean,
  issues: AssetManifestValidationIssue[],
): { ids: Set<string>; sources: Set<AssetSourceType> } {
  const ids = new Set<string>();
  const roles = new Set<string>();
  const sources = new Set<AssetSourceType>();
  if (!Array.isArray(value)) {
    push(issues, "MISSING_FIELD", "assets must be an array.", "assets");
    return { ids, sources };
  }
  value.forEach((asset, i) => {
    const p = `assets[${i}]`;
    if (!isRecord(asset)) {
      push(issues, "INVALID_FIELD", `${p} must be an object.`, p);
      return;
    }
    validateKnownKeys(
      asset,
      new Set([
        "id",
        "role",
        "source",
        "sourceId",
        "status",
        "heroRegion",
        "requiredOutputs",
        "resolvedPaths",
        "styleLock",
        "registrySelection",
        "generatedExport",
        "primitiveFinal",
      ]),
      issues,
      p,
    );
    if (asset.primitiveFinal !== undefined && typeof asset.primitiveFinal !== "boolean") {
      push(issues, "INVALID_FIELD", `${p}.primitiveFinal must be a boolean.`, `${p}.primitiveFinal`);
    }
    // `primitiveFinal` only waives asset-source provenance when the on-disk
    // contract declares `art.mode:"deferred"` (gray-box). Under art:final it is
    // INERT — a self-declared `primitiveFinal` can NOT skip resolved-path /
    // registry / generated provenance, so a normal build cannot launder an
    // unprovenanced role past the asset gate. Fail-closed: `artDeferred` defaults
    // to false (strict) for every caller that does not pass the posture.
    const primitiveWaiver = asset.primitiveFinal === true && artDeferred;
    if (!isNonEmptyString(asset.id)) {
      push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
    } else if (!SAFE_ID_RE.test(asset.id)) {
      push(issues, "INVALID_ID", `${p}.id '${asset.id}' must match ${SAFE_ID_RE}.`, `${p}.id`);
    } else if (ids.has(asset.id)) {
      push(issues, "DUPLICATE_ID", `${p}.id '${asset.id}' is duplicated.`, `${p}.id`);
    } else {
      ids.add(asset.id);
    }
    if (!isNonEmptyString(asset.role)) {
      push(issues, "MISSING_FIELD", `${p}.role is required.`, `${p}.role`);
    } else {
      roles.add(asset.role);
    }
    if (!isNonEmptyString(asset.source) || !ASSET_SOURCE_TYPES.has(asset.source as AssetSourceType)) {
      push(issues, "INVALID_ASSET_SOURCE", `${p}.source must be generated|registry|manual.`, `${p}.source`);
    } else {
      sources.add(asset.source as AssetSourceType);
      if (mode === "registry" && asset.source !== "registry") {
        push(issues, "MODE_SOURCE_MISMATCH", `${p}.source must be registry in registry mode.`, `${p}.source`);
      }
      if (mode === "generated" && asset.source === "registry") {
        push(issues, "MODE_SOURCE_MISMATCH", `${p}.source cannot be registry in generated mode.`, `${p}.source`);
      }
    }
    if (!isNonEmptyString(asset.status) || !ASSET_STATUSES.has(asset.status as AssetStatus)) {
      push(issues, "INVALID_ASSET_STATUS", `${p}.status must be approved|needed|placeholder.`, `${p}.status`);
    } else {
      if (status === "approved" && asset.status === "needed") {
        push(issues, "UNAPPROVED_ASSET", `${p}.status cannot be needed in an approved manifest.`, `${p}.status`);
      }
      if (asset.status === "placeholder" && allowPlaceholders === false) {
        push(issues, "UNAPPROVED_PLACEHOLDER", `${p}.status placeholder is disallowed by replacementPolicy.`, `${p}.status`);
      }
    }
    if (asset.source === "registry") {
      if (!isNonEmptyString(asset.sourceId)) {
        push(issues, "MISSING_FIELD", `${p}.sourceId is required for registry assets.`, `${p}.sourceId`);
      } else if (!sourceIds.has(asset.sourceId)) {
        push(issues, "UNKNOWN_SOURCE_ID", `${p}.sourceId '${asset.sourceId}' is not declared in assetSources.`, `${p}.sourceId`);
      } else if (status === "approved" && !registryApprovedSourceIds.has(asset.sourceId)) {
        push(issues, "UNAPPROVED_SOURCE_CHANGE", `${p}.sourceId '${asset.sourceId}' is not an approved registry source.`, `${p}.sourceId`);
      }
    } else if (asset.sourceId !== undefined && (!isNonEmptyString(asset.sourceId) || !sourceIds.has(asset.sourceId))) {
      push(issues, "UNKNOWN_SOURCE_ID", `${p}.sourceId must reference a declared assetSource.`, `${p}.sourceId`);
    }
    if (!isNonEmptyStringArray(asset.requiredOutputs)) {
      push(issues, "MISSING_FIELD", `${p}.requiredOutputs must be a non-empty string array.`, `${p}.requiredOutputs`);
    }
    if (asset.heroRegion !== undefined) validateHeroRegion(asset.heroRegion, issues, `${p}.heroRegion`);
    if (asset.resolvedPaths !== undefined) {
      if (!Array.isArray(asset.resolvedPaths)) {
        push(issues, "INVALID_FIELD", `${p}.resolvedPaths must be an array.`, `${p}.resolvedPaths`);
      } else {
        asset.resolvedPaths.forEach((rp, j) => validateSafePath(rp, issues, `${p}.resolvedPaths[${j}]`));
      }
    }
    if (status === "approved" && asset.status === "approved" && !primitiveWaiver) {
      if (!Array.isArray(asset.resolvedPaths) || asset.resolvedPaths.length === 0) {
        push(issues, "MISSING_RESOLVED_PATH", `${p}.resolvedPaths is required for approved assets in an approved manifest.`, `${p}.resolvedPaths`);
      }
    }
    if (asset.styleLock !== undefined && !isNonEmptyString(asset.styleLock)) {
      push(issues, "INVALID_FIELD", `${p}.styleLock must be a non-empty string.`, `${p}.styleLock`);
    }
    if (asset.registrySelection !== undefined) {
      validateRegistrySelection(asset.registrySelection, issues, `${p}.registrySelection`);
      if (asset.source !== "registry") {
        push(issues, "INVALID_FIELD", `${p}.registrySelection is only allowed for registry assets.`, `${p}.registrySelection`);
      }
    } else if (status === "approved" && asset.source === "registry" && asset.status === "approved" && !primitiveWaiver) {
      push(issues, "MISSING_FIELD", `${p}.registrySelection is required for approved registry assets.`, `${p}.registrySelection`);
    }
    if (asset.generatedExport !== undefined) {
      validateGeneratedExport(asset.generatedExport, issues, `${p}.generatedExport`);
      if (asset.source !== "generated") {
        push(issues, "INVALID_FIELD", `${p}.generatedExport is only allowed for generated assets.`, `${p}.generatedExport`);
      }
    } else if (status === "approved" && asset.source === "generated" && asset.status === "approved" && !primitiveWaiver) {
      push(issues, "MISSING_FIELD", `${p}.generatedExport is required for approved generated assets.`, `${p}.generatedExport`);
    }
  });
  for (const role of requiredRoles) {
    if (!roles.has(role)) {
      push(issues, "MISSING_REQUIRED_ROLE", `assets must include role '${role}'.`, "assets");
    }
  }
  return { ids, sources };
}

function validateSliceBindings(
  value: unknown,
  assetIds: Set<string>,
  issues: AssetManifestValidationIssue[],
): void {
  const sliceIds = new Set<string>();
  if (!Array.isArray(value)) {
    push(issues, "MISSING_FIELD", "sliceBindings must be an array.", "sliceBindings");
    return;
  }
  value.forEach((binding, i) => {
    const p = `sliceBindings[${i}]`;
    if (!isRecord(binding)) {
      push(issues, "INVALID_FIELD", `${p} must be an object.`, p);
      return;
    }
    validateKnownKeys(binding, new Set(["sliceId", "assetIds"]), issues, p);
    if (!isNonEmptyString(binding.sliceId)) {
      push(issues, "MISSING_FIELD", `${p}.sliceId is required.`, `${p}.sliceId`);
    } else if (!SAFE_ID_RE.test(binding.sliceId)) {
      push(issues, "INVALID_ID", `${p}.sliceId '${binding.sliceId}' must match ${SAFE_ID_RE}.`, `${p}.sliceId`);
    } else if (sliceIds.has(binding.sliceId)) {
      push(issues, "DUPLICATE_ID", `${p}.sliceId '${binding.sliceId}' is duplicated.`, `${p}.sliceId`);
    } else {
      sliceIds.add(binding.sliceId);
    }
    if (!isNonEmptyStringArray(binding.assetIds)) {
      push(issues, "MISSING_FIELD", `${p}.assetIds must be a non-empty string array.`, `${p}.assetIds`);
    } else {
      for (const assetId of binding.assetIds) {
        if (!assetIds.has(assetId)) {
          push(issues, "UNKNOWN_ASSET_ID", `${p}.assetIds references unknown asset id '${assetId}'.`, `${p}.assetIds`);
        }
      }
    }
  });
}

function validateReplacementPolicy(
  value: unknown,
  issues: AssetManifestValidationIssue[],
): AssetReplacementPolicy | null {
  if (!isRecord(value)) {
    push(issues, "MISSING_FIELD", "replacementPolicy must be an object.", "replacementPolicy");
    return null;
  }
  validateKnownKeys(
    value,
    new Set(["allowUnapprovedRegistryFallback", "allowPlaceholders", "requiresUserApprovalForSourceChange"]),
    issues,
    "replacementPolicy",
  );
  for (const key of ["allowUnapprovedRegistryFallback", "allowPlaceholders", "requiresUserApprovalForSourceChange"] as const) {
    if (typeof value[key] !== "boolean") {
      push(issues, "MISSING_FIELD", `replacementPolicy.${key} must be boolean.`, `replacementPolicy.${key}`);
    }
  }
  if (value.allowUnapprovedRegistryFallback !== false) {
    push(
      issues,
      "UNAPPROVED_POLICY",
      "replacementPolicy.allowUnapprovedRegistryFallback must be false.",
      "replacementPolicy.allowUnapprovedRegistryFallback",
    );
  }
  if (value.requiresUserApprovalForSourceChange !== true) {
    push(
      issues,
      "UNAPPROVED_POLICY",
      "replacementPolicy.requiresUserApprovalForSourceChange must be true.",
      "replacementPolicy.requiresUserApprovalForSourceChange",
    );
  }
  if (
    typeof value.allowUnapprovedRegistryFallback === "boolean" &&
    typeof value.allowPlaceholders === "boolean" &&
    typeof value.requiresUserApprovalForSourceChange === "boolean"
  ) {
    return value as unknown as AssetReplacementPolicy;
  }
  return null;
}

/** Options for `validateAssetManifest` / `assertValidAssetManifest`. */
export interface ValidateAssetManifestOptions {
  /**
   * Gray-box / feel-only posture (RCL-D02). FAIL-CLOSED default `false`: only
   * when the on-disk acceptance contract declares `art.mode:"deferred"` does a
   * `primitiveFinal` role waive its resolved-path / registry / generated
   * provenance requirements. Under art:final (the default), `primitiveFinal` is
   * INERT, so a normal build cannot self-declare it to skip the asset gate.
   */
  artDeferred?: boolean;
}

export function validateAssetManifest(
  input: unknown,
  options: ValidateAssetManifestOptions = {},
): AssetManifestValidationResult {
  const issues: AssetManifestValidationIssue[] = [];
  const artDeferred = options.artDeferred === true;

  if (!isRecord(input)) {
    push(issues, "INVALID_DOCUMENT", "Asset manifest must be an object.", "manifest");
    return { valid: false, issues };
  }

  validateKnownKeys(
    input,
    new Set(["version", "genre", "mode", "status", "approvedAt", "heroShot", "assetSources", "assets", "sliceBindings", "replacementPolicy"]),
    issues,
    "manifest",
  );

  if (input.version !== ASSET_MANIFEST_VERSION) {
    push(issues, "INVALID_VERSION", `version must be ${ASSET_MANIFEST_VERSION}.`, "version");
  }

  // An absent genre is the platformer default (back-compat). A PRESENT genre must
  // be a non-empty string naming a registered asset genre — REFUSE an unknown one
  // (refuse-don't-skip): the draft path only ever persists a registered profile id,
  // so an unrecognized persisted genre is tampering/typo, not a silent fallback.
  if (input.genre !== undefined && !isNonEmptyString(input.genre)) {
    push(issues, "INVALID_FIELD", "genre must be a non-empty string when present.", "genre");
  } else if (isNonEmptyString(input.genre) && !knownAssetGenres().includes(input.genre)) {
    push(issues, "UNKNOWN_GENRE", `genre '${input.genre}' is not a registered asset genre.`, "genre");
  }
  const genreProfile = isNonEmptyString(input.genre) && knownAssetGenres().includes(input.genre)
    ? resolveAssetGenreProfile(input.genre)
    : resolveAssetGenreProfile();

  const mode = isNonEmptyString(input.mode) && ASSET_MANIFEST_MODES.has(input.mode as AssetManifestMode)
    ? (input.mode as AssetManifestMode)
    : null;
  if (!mode) {
    push(issues, "INVALID_MODE", "mode must be registry|generated|hybrid.", "mode");
  }

  const status = input.status === "draft" || input.status === "approved"
    ? (input.status as AssetManifestStatus)
    : null;
  if (!status) {
    push(issues, "INVALID_STATUS", "status must be draft|approved.", "status");
  }
  if (status === "approved" && (!isNonEmptyString(input.approvedAt) || !ISO_DATE_RE.test(input.approvedAt))) {
    push(issues, "MISSING_APPROVAL", "approvedAt must be an ISO timestamp for approved manifests.", "approvedAt");
  }

  validateHeroShot(input.heroShot, issues);
  const policy = validateReplacementPolicy(input.replacementPolicy, issues);
  const { ids: sourceIds, registryApproved } = validateSources(input.assetSources, issues);
  const assetValidation = validateAssets(
    input.assets,
    sourceIds,
    registryApproved,
    mode,
    status,
    policy?.allowPlaceholders ?? null,
    genreProfile.requiredRoles,
    artDeferred,
    issues,
  );
  validateSliceBindings(input.sliceBindings, assetValidation.ids, issues);

  if (status === "approved" && mode === "registry" && registryApproved.size === 0) {
    push(issues, "MISSING_APPROVED_REGISTRY_SOURCE", "registry mode requires an approved registry-pack assetSource.", "assetSources");
  }
  if (status === "approved" && mode === "hybrid" && registryApproved.size === 0) {
    push(issues, "MISSING_APPROVED_REGISTRY_SOURCE", "hybrid mode requires at least one approved registry-pack assetSource.", "assetSources");
  }
  if (mode === "hybrid" && (!assetValidation.sources.has("registry") || ![...assetValidation.sources].some((source) => source !== "registry"))) {
    push(issues, "MODE_SOURCE_MISMATCH", "hybrid mode requires both registry and generated/manual assets.", "assets");
  }

  return { valid: issues.length === 0, issues };
}

export function createDraftAssetManifest(args: CreateDraftAssetManifestArgs): AssetManifest {
  const genreProfile = resolveAssetGenreProfile(args.genre);
  const registrySourceId = "registry_selection_needed";
  const generatedSourceId = "generated_set_needed";
  const needsRegistry = args.mode === "registry" || args.mode === "hybrid";
  const needsGenerated = args.mode === "generated" || args.mode === "hybrid";
  const assetSources: AssetSourceRef[] = [
    ...(needsRegistry
      ? [{
          id: registrySourceId,
          kind: "registry-pack" as const,
          // The default registry pack is the default genre's pack (asset registries are genre-keyed);
          // sourced from the registry so this carries no genre literal.
          registry: args.registry ?? defaultGenreId(),
          approved: false,
        }]
      : []),
    ...(needsGenerated
      ? [{
          id: generatedSourceId,
          kind: "generated-set" as const,
          approved: false,
        }]
      : []),
  ];

  return {
    version: ASSET_MANIFEST_VERSION,
    // Only persist a genre for a non-default profile so platformer drafts stay byte-identical.
    ...(genreProfile.id !== DEFAULT_ASSET_GENRE ? { genre: genreProfile.id } : {}),
    mode: args.mode,
    status: "draft",
    approvedAt: null,
    heroShot: args.heroShot,
    assetSources,
    assets: genreProfile.requiredRoles.map((role) => {
      const source = draftSourceForRole(args.mode, role, genreProfile);
      return {
        id: role.replaceAll("-", "_"),
        role,
        source,
        sourceId: source === "registry" ? registrySourceId : generatedSourceId,
        status: "needed" as const,
        requiredOutputs: ["main"],
        styleLock: `must match approved hero shot role '${role}'`,
      };
    }),
    sliceBindings: genreProfile.defaultSliceBindings.map((binding) => ({
      sliceId: binding.sliceId,
      assetIds: [...binding.assetIds],
    })),
    replacementPolicy: {
      allowUnapprovedRegistryFallback: false,
      allowPlaceholders: true,
      requiresUserApprovalForSourceChange: true,
    },
  };
}

export function assertValidAssetManifest(
  input: unknown,
  options: ValidateAssetManifestOptions = {},
): AssetManifest {
  const result = validateAssetManifest(input, options);
  if (!result.valid) {
    const summary = result.issues
      .map((issue) => `  - [${issue.code}] ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Asset manifest validation failed:\n${summary}`);
  }
  return input as AssetManifest;
}

export async function readAssetManifest(paths: LoombridgePaths): Promise<AssetManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.assetManifest, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return assertValidAssetManifest(JSON.parse(raw));
}

export async function writeAssetManifest(paths: LoombridgePaths, manifest: AssetManifest): Promise<void> {
  assertValidAssetManifest(manifest);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.assetManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}
