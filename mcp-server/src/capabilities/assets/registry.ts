import fs from "node:fs/promises";
import { selectAssetsFromCatalog, type CatalogSource } from "./catalog-source.js";
import type {
  AssetCatalogQueryOptions,
  AssetKind,
  AssetProfile,
  AssetPolicyValidationIssue,
  AssetRegistryEntry,
  AssetRegistryPack,
  AssetSelectionOptions,
} from "./types.js";

const knownKinds = new Set<AssetKind>(["sprite", "audio", "material", "model"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

export function assetKindOf(entry: AssetRegistryEntry): AssetKind {
  return entry.kind ?? "sprite";
}

function priorityOf(entry: AssetRegistryEntry): number {
  return entry.priority ?? 0;
}

function hasAllTags(entry: AssetRegistryEntry, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }

  const entryTags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => entryTags.has(tag.toLowerCase()));
}

function sortCandidates(a: AssetRegistryEntry, b: AssetRegistryEntry, preferredLicense?: string): number {
  const aLicenseScore = preferredLicense && a.license.spdx === preferredLicense ? 1 : 0;
  const bLicenseScore = preferredLicense && b.license.spdx === preferredLicense ? 1 : 0;
  if (aLicenseScore !== bLicenseScore) {
    return bLicenseScore - aLicenseScore;
  }

  if (priorityOf(a) !== priorityOf(b)) {
    return priorityOf(b) - priorityOf(a);
  }

  return a.id.localeCompare(b.id);
}

export async function loadRegistryPack(filePath: string): Promise<AssetRegistryPack> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as AssetRegistryPack;
}

export async function loadAssetProfile(filePath: string): Promise<AssetProfile> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as AssetProfile;
}

function pushIssue(
  issues: AssetPolicyValidationIssue[],
  code: AssetPolicyValidationIssue["code"],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function allowedLicenses(profile: AssetProfile): string[] {
  return profile.validation.licensePolicy?.allowedSpdx ?? profile.validation.allowedLicenses;
}

function deniedLicenses(profile: AssetProfile): string[] {
  return profile.validation.licensePolicy?.deniedSpdx ?? [];
}

function requiredProvenanceFields(profile: AssetProfile): string[] {
  return profile.validation.sourcePolicy?.minimumProvenanceFields ?? profile.validation.requiredProvenanceFields;
}

function isBlank(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length === 0 : value === undefined || value === null;
}

function validateChecksumDeclarations(
  entry: AssetRegistryEntry,
  entryPath: string,
  profile: AssetProfile,
  issues: AssetPolicyValidationIssue[],
): void {
  entry.files.forEach((file, fileIndex) => {
    const checksumPath = `${entryPath}.files[${fileIndex}].checksum`;
    if (profile.validation.checksumPolicy?.requireSha256 && !file.checksum) {
      pushIssue(issues, "INVALID_CHECKSUM_DECLARATION", checksumPath, "Profile requires a sha256 checksum.");
      return;
    }

    if (!file.checksum) {
      return;
    }

    if (file.checksum.algorithm !== "sha256" || !sha256Pattern.test(file.checksum.value)) {
      pushIssue(issues, "INVALID_CHECKSUM_DECLARATION", checksumPath, "Checksum must be a lowercase sha256 hex digest.");
    }
  });
}

export function validateRegistryPolicy(
  registry: AssetRegistryPack,
  profile: AssetProfile,
): AssetPolicyValidationIssue[] {
  const issues: AssetPolicyValidationIssue[] = [];
  const seenIds = new Map<string, number>();
  const licenseAllowList = allowedLicenses(profile);
  const licenseDenyList = deniedLicenses(profile);
  const profileKinds = new Set(profile.validation.allowedKinds ?? ["sprite"]);

  registry.entries.forEach((entry, index) => {
    const entryPath = `entries[${index}]`;
    const previousIndex = seenIds.get(entry.id);
    if (previousIndex !== undefined) {
      pushIssue(issues, "DUPLICATE_ID", `${entryPath}.id`, `Asset id '${entry.id}' duplicates entries[${previousIndex}].id.`);
    } else {
      seenIds.set(entry.id, index);
    }

    if (!entry.source?.title || !entry.source.url || !entry.source.author) {
      pushIssue(issues, "MISSING_SOURCE", `${entryPath}.source`, "Asset source title, url, and author are required.");
    }

    if (!entry.source?.provenance) {
      pushIssue(issues, "MISSING_PROVENANCE", `${entryPath}.source.provenance`, "Asset provenance metadata is required.");
    } else {
      for (const field of requiredProvenanceFields(profile)) {
        if (isBlank(entry.source.provenance[field])) {
          pushIssue(issues, "MISSING_PROVENANCE", `${entryPath}.source.provenance.${field}`, `Required provenance field '${field}' is missing.`);
        }
      }
    }

    if (profile.validation.sourcePolicy?.requireVerified && entry.source?.verified !== true) {
      pushIssue(issues, "SOURCE_UNVERIFIED", `${entryPath}.source.verified`, "Profile requires source.verified=true.");
    }

    if (!entry.license?.spdx || !entry.license.name || !entry.license.url) {
      pushIssue(issues, "MISSING_LICENSE", `${entryPath}.license`, "License name, SPDX id, and url are required.");
    } else {
      if (licenseDenyList.includes(entry.license.spdx)) {
        pushIssue(issues, "DENIED_LICENSE", `${entryPath}.license.spdx`, `License '${entry.license.spdx}' is denied by profile policy.`);
      }
      if (!licenseAllowList.includes(entry.license.spdx)) {
        pushIssue(issues, "DISALLOWED_LICENSE", `${entryPath}.license.spdx`, `License '${entry.license.spdx}' is not allowed by profile policy.`);
      }
    }

    if (!entry.provider?.name || !entry.provider.url) {
      pushIssue(issues, "MISSING_PROVIDER", `${entryPath}.provider`, "Provider name and url are required.");
    }

    const kind = assetKindOf(entry);
    const isKnownKind = knownKinds.has(kind);
    if (!isKnownKind || !profileKinds.has(kind)) {
      pushIssue(issues, "UNKNOWN_KIND", `${entryPath}.kind`, `Kind '${kind}' is not supported by this profile.`);
    }

    const primitive = profile.primitives[entry.primitive];
    if (!primitive) {
      pushIssue(issues, "UNKNOWN_PRIMITIVE", `${entryPath}.primitive`, `Primitive '${entry.primitive}' is not declared by profile '${profile.id}'.`);
    } else if (isKnownKind) {
      const primitiveKinds = primitive.supportedKinds ?? ["sprite"];
      if (!primitiveKinds.includes(kind)) {
        pushIssue(
          issues,
          "UNSUPPORTED_PRIMITIVE_KIND",
          `${entryPath}.primitive`,
          `Primitive '${entry.primitive}' does not support kind '${kind}'.`,
        );
      }
    }

    validateChecksumDeclarations(entry, entryPath, profile, issues);
  });

  return issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

export function selectAssets(registry: AssetRegistryPack, options: AssetSelectionOptions): AssetRegistryEntry[] {
  const requestedPrimitives = options.primitives && options.primitives.length > 0
    ? options.primitives
    : Array.from(new Set(registry.entries
      .filter((entry) => entry.genre === options.genre || entry.genre === "game-asset")
      .map((entry) => entry.primitive)));

  return requestedPrimitives.flatMap((primitive) => {
    const candidates = registry.entries
      .filter((entry) => entry.genre === options.genre || entry.genre === "game-asset")
      .filter((entry) => entry.primitive === primitive)
      .filter((entry) => hasAllTags(entry, options.tags))
      .sort((a, b) => sortCandidates(a, b, options.preferredLicense));

    return candidates[0] ? [candidates[0]] : [];
  });
}

export async function selectCatalogAssets(
  source: CatalogSource,
  options: Required<Pick<AssetCatalogQueryOptions, "genre">> & AssetCatalogQueryOptions,
): Promise<AssetRegistryEntry[]> {
  return selectAssetsFromCatalog(source, options);
}
