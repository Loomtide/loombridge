import {
  assertValidAssetManifest,
  type AssetManifest,
  type ManifestAsset,
  type ManifestRegistrySelection,
} from "./asset-manifest.js";
import {
  resolveAssetGenreProfile,
  type RoleSelectionRule,
} from "./asset-genre-profile.js";
import { assetKindOf } from "./registry.js";
import { reviewStatusForEntry, trustTierForEntry } from "./trust.js";
import type { AssetProfile, AssetRegistryEntry, AssetRegistryPack, AssetReviewStatus, AssetTrustTier } from "./types.js";

export interface RegistrySelectionCandidate {
  id: string;
  packId: string;
  packName: string;
  role: string;
  assetId: string;
  primitive: string;
  kind: string;
  label: string;
  priority: number;
  placeholder: boolean;
  unityPath: string;
  tags: string[];
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
  acquisitionLane?: string;
  trustTier: AssetTrustTier;
  reviewStatus: AssetReviewStatus;
  policyStatus: AssetTrustTier;
}

export interface RegistrySelectionSlot {
  assetId: string;
  role: string;
  label: string;
  primitivePreferences: string[];
  requiredTags: string[];
  selectedId: string | null;
  candidates: RegistrySelectionCandidate[];
}

export interface RegistrySelectionIssue {
  code: "NO_REGISTRY_SOURCE" | "NO_PRIMITIVE_MAPPING" | "NO_CANDIDATES";
  assetId: string;
  role: string;
  message: string;
}

export interface RegistrySelectionPlan {
  mode: AssetManifest["mode"];
  pack: {
    id: string;
    name: string;
    description?: string;
  };
  slots: RegistrySelectionSlot[];
  issues: RegistrySelectionIssue[];
}

export interface AssetPickerSlot {
  slot: string;
  label: string;
  selectedId?: string;
  options: Array<{
    id: string;
    label: string;
    imagePath?: string;
    badges: string[];
  }>;
}

export interface ApplyRegistrySelectionsArgs {
  manifest: AssetManifest;
  registry: AssetRegistryPack;
  profile: AssetProfile;
  selections: Record<string, string>;
  approvedAt: string;
  preferredLicense?: string;
}

export interface RegistryHeroShotAsset {
  assetId: string;
  role: string;
  registryAssetId: string;
  path: string;
  license: string;
  sourceTitle: string;
  provenance: Record<string, unknown>;
}

/** The per-role registry-selection rules for a manifest's asset genre. */
function roleSelectionRulesFor(manifest: AssetManifest): Record<string, RoleSelectionRule> {
  return resolveAssetGenreProfile(manifest.genre).roleSelectionRules;
}

function priorityOf(entry: AssetRegistryEntry): number {
  return entry.priority ?? 0;
}

function allowedLicenses(profile: AssetProfile): string[] {
  return profile.validation.licensePolicy?.allowedSpdx ?? profile.validation.allowedLicenses;
}

function hasAllTags(entry: AssetRegistryEntry, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const entryTags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => entryTags.has(tag.toLowerCase()));
}

function roleLabel(role: string): string {
  return role
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function candidateLabel(entry: AssetRegistryEntry): string {
  return entry.source.title || entry.id;
}

function isTrustedDefault(candidate: RegistrySelectionCandidate): boolean {
  return candidate.policyStatus === "trusted-default" && candidate.reviewStatus === "verified";
}

function compareCandidateEntries(
  a: AssetRegistryEntry,
  b: AssetRegistryEntry,
  primitives: string[],
  preferredLicense?: string,
): number {
  const aPrimitiveScore = primitives.indexOf(a.primitive);
  const bPrimitiveScore = primitives.indexOf(b.primitive);
  if (aPrimitiveScore !== bPrimitiveScore) return aPrimitiveScore - bPrimitiveScore;

  const aLicenseScore = preferredLicense && a.license.spdx === preferredLicense ? 1 : 0;
  const bLicenseScore = preferredLicense && b.license.spdx === preferredLicense ? 1 : 0;
  if (aLicenseScore !== bLicenseScore) return bLicenseScore - aLicenseScore;

  if (priorityOf(a) !== priorityOf(b)) return priorityOf(b) - priorityOf(a);

  return a.id.localeCompare(b.id);
}

function toCandidate(
  entry: AssetRegistryEntry,
  registry: AssetRegistryPack,
  manifestAsset: ManifestAsset,
): RegistrySelectionCandidate {
  return {
    id: entry.id,
    packId: registry.packId,
    packName: registry.name,
    role: manifestAsset.role,
    assetId: manifestAsset.id,
    primitive: entry.primitive,
    kind: assetKindOf(entry),
    label: candidateLabel(entry),
    priority: priorityOf(entry),
    placeholder: entry.placeholder === true,
    unityPath: entry.unity.path,
    tags: [...entry.tags].sort((a, b) => a.localeCompare(b)),
    license: {
      name: entry.license.name,
      spdx: entry.license.spdx,
      url: entry.license.url,
      requiresAttribution: entry.license.requiresAttribution,
    },
    source: {
      title: entry.source.title,
      url: entry.source.url,
      author: entry.source.author,
      provenance: { ...entry.source.provenance },
    },
    provider: {
      name: entry.provider.name,
      url: entry.provider.url,
    },
    acquisitionLane: entry.acquisitionLane ?? entry.provider.acquisitionLane,
    trustTier: trustTierForEntry(entry),
    reviewStatus: reviewStatusForEntry(entry),
    policyStatus: trustTierForEntry(entry),
  };
}

function registryAssets(manifest: AssetManifest): ManifestAsset[] {
  return manifest.assets.filter((asset) => asset.source === "registry");
}

function findCandidatesForAsset(
  manifestAsset: ManifestAsset,
  registry: AssetRegistryPack,
  profile: AssetProfile,
  rule: RoleSelectionRule | undefined,
  preferredLicense?: string,
): RegistrySelectionCandidate[] | RegistrySelectionIssue {
  if (!rule) {
    return {
      code: "NO_PRIMITIVE_MAPPING",
      assetId: manifestAsset.id,
      role: manifestAsset.role,
      message: `No registry primitive mapping is declared for asset role '${manifestAsset.role}'.`,
    };
  }

  const profilePrimitives = new Set(Object.keys(profile.primitives));
  const licenseAllowList = allowedLicenses(profile);
  const requiredTags = rule.requiredTags ?? [];
  const candidates = registry.entries
    .filter((entry) => entry.genre === profile.genre || entry.genre === "game-asset")
    .filter((entry) => rule.primitives.includes(entry.primitive))
    .filter((entry) => profilePrimitives.has(entry.primitive))
    .filter((entry) => licenseAllowList.includes(entry.license.spdx))
    .filter((entry) => hasAllTags(entry, requiredTags))
    .sort((a, b) => compareCandidateEntries(a, b, rule.primitives, preferredLicense))
    .map((entry) => toCandidate(entry, registry, manifestAsset));

  if (candidates.length === 0) {
    return {
      code: "NO_CANDIDATES",
      assetId: manifestAsset.id,
      role: manifestAsset.role,
      message: `No registry candidates are available for role '${manifestAsset.role}'.`,
    };
  }

  return candidates;
}

export function buildRegistrySelectionPlan(
  manifest: AssetManifest,
  registry: AssetRegistryPack,
  profile: AssetProfile,
  options: { preferredLicense?: string } = {},
): RegistrySelectionPlan {
  const slots: RegistrySelectionSlot[] = [];
  const issues: RegistrySelectionIssue[] = [];
  const registrySource = manifest.assetSources.find((source) => source.kind === "registry-pack");
  const roleRules = roleSelectionRulesFor(manifest);

  for (const asset of registryAssets(manifest)) {
    const rule = roleRules[asset.role];
    if (!registrySource) {
      issues.push({
        code: "NO_REGISTRY_SOURCE",
        assetId: asset.id,
        role: asset.role,
        message: `Asset '${asset.id}' requests registry source but manifest has no registry-pack assetSource.`,
      });
      continue;
    }

    const result = findCandidatesForAsset(asset, registry, profile, rule, options.preferredLicense);
    if (!Array.isArray(result)) {
      issues.push(result);
      continue;
    }

    slots.push({
      assetId: asset.id,
      role: asset.role,
      label: roleLabel(asset.role),
      primitivePreferences: rule?.primitives ?? [],
      requiredTags: rule?.requiredTags ?? [],
      selectedId: asset.registrySelection?.registryAssetId ?? result.find(isTrustedDefault)?.id ?? null,
      candidates: result,
    });
  }

  return {
    mode: manifest.mode,
    pack: {
      id: registry.packId,
      name: registry.name,
      ...(registry.description ? { description: registry.description } : {}),
    },
    slots,
    issues,
  };
}

export function buildAssetPickerSlotsFromRegistrySelectionPlan(plan: RegistrySelectionPlan): AssetPickerSlot[] {
  return plan.slots.map((slot) => ({
    slot: slot.assetId,
    label: slot.label,
    ...(slot.selectedId ? { selectedId: slot.selectedId } : {}),
    options: slot.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      imagePath: candidate.unityPath,
      badges: [
        candidate.license.spdx,
        candidate.primitive,
        candidate.reviewStatus === "verified" ? "VERIFIED" : undefined,
        candidate.policyStatus === "attribution-required" ? "ATTRIBUTION" : undefined,
        candidate.policyStatus === "unverified-discovery" ? "NEEDS REVIEW" : undefined,
        ...(candidate.placeholder ? ["PLACEHOLDER"] : []),
      ].filter((value): value is string => Boolean(value)),
    })),
  }));
}

function toRegistrySelection(candidate: RegistrySelectionCandidate): ManifestRegistrySelection {
  return {
    registryAssetId: candidate.id,
    packId: candidate.packId,
    primitive: candidate.primitive,
    license: { ...candidate.license },
    source: {
      title: candidate.source.title,
      url: candidate.source.url,
      author: candidate.source.author,
      provenance: { ...candidate.source.provenance },
    },
    provider: { ...candidate.provider },
    placeholder: candidate.placeholder,
  };
}

function commonLicense(candidates: RegistrySelectionCandidate[]): string | undefined {
  const licenses = new Set(candidates.map((candidate) => candidate.license.spdx));
  return licenses.size === 1 ? candidates[0]?.license.spdx : undefined;
}

export function applyRegistrySelectionsToManifest(args: ApplyRegistrySelectionsArgs): AssetManifest {
  if (!args.approvedAt) {
    throw new Error("approvedAt is required when approving registry asset selections.");
  }
  const plan = buildRegistrySelectionPlan(args.manifest, args.registry, args.profile, {
    preferredLicense: args.preferredLicense,
  });
  if (plan.issues.length > 0) {
    throw new Error(`Cannot apply registry selections: ${plan.issues.map((issue) => issue.message).join("; ")}`);
  }

  const candidatesByAsset = new Map(plan.slots.map((slot) => [slot.assetId, new Map(slot.candidates.map((candidate) => [candidate.id, candidate]))]));
  const selectedByAsset = new Map<string, RegistrySelectionCandidate>();
  for (const slot of plan.slots) {
    const selectedId = args.selections[slot.assetId];
    if (!selectedId) {
      throw new Error(`Missing registry selection for asset '${slot.assetId}'.`);
    }
    const candidate = candidatesByAsset.get(slot.assetId)?.get(selectedId);
    if (!candidate) {
      throw new Error(`Unknown registry selection '${selectedId}' for asset '${slot.assetId}'.`);
    }
    selectedByAsset.set(slot.assetId, candidate);
  }

  const selectedCandidates = [...selectedByAsset.values()];
  const existingRegistrySource = args.manifest.assetSources.find((source) => source.kind === "registry-pack");
  const registrySourceId = existingRegistrySource?.id ?? args.registry.packId.replaceAll(".", "_");
  const assetSources = args.manifest.assetSources
    .filter((source) => source.id !== registrySourceId)
    .concat({
      id: registrySourceId,
      kind: "registry-pack" as const,
      registry: args.registry.packId,
      ...(commonLicense(selectedCandidates) ? { license: commonLicense(selectedCandidates) } : {}),
      approved: true,
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const assets = args.manifest.assets.map((asset) => {
    const candidate = selectedByAsset.get(asset.id);
    if (!candidate) return asset;
    return {
      ...asset,
      source: "registry" as const,
      sourceId: registrySourceId,
      status: candidate.placeholder ? "placeholder" as const : "approved" as const,
      resolvedPaths: [candidate.unityPath],
      styleLock: asset.styleLock ?? `approved registry asset '${candidate.id}' for '${asset.role}'`,
      registrySelection: toRegistrySelection(candidate),
    };
  });
  const readyForApproval = assets.every((asset) => asset.status !== "needed");

  return assertValidAssetManifest({
    ...args.manifest,
    status: readyForApproval ? "approved" : "draft",
    approvedAt: readyForApproval ? args.approvedAt : args.manifest.approvedAt ?? null,
    assetSources,
    assets,
  });
}

export function buildRegistryHeroShotInputs(manifest: AssetManifest): RegistryHeroShotAsset[] {
  assertValidAssetManifest(manifest);
  if (manifest.mode !== "registry") {
    throw new Error(`Registry hero shot inputs require registry mode, got '${manifest.mode}'.`);
  }
  if (manifest.status !== "approved") {
    throw new Error("Registry hero shot inputs require an approved asset manifest.");
  }

  return resolveAssetGenreProfile(manifest.genre).requiredRoles.map((role) => {
    const asset = manifest.assets.find((candidate) => candidate.role === role);
    if (!asset || asset.source !== "registry" || asset.status !== "approved" || !asset.registrySelection || !asset.resolvedPaths?.[0]) {
      throw new Error(`Registry hero shot inputs require approved registry asset role '${role}'.`);
    }
    return {
      assetId: asset.id,
      role: asset.role,
      registryAssetId: asset.registrySelection.registryAssetId,
      path: asset.resolvedPaths[0],
      license: asset.registrySelection.license.spdx,
      sourceTitle: asset.registrySelection.source.title,
      provenance: { ...asset.registrySelection.source.provenance },
    };
  });
}
