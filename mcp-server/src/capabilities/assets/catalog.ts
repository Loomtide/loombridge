import type {
  AssetAcquisitionLane,
  AssetCatalogRecord,
  AssetFile,
  AssetFileFormat,
  AssetKind,
  AssetRegistryEntry,
  AssetRegistryPack,
  AssetReview,
  AssetReviewStatus,
  AssetReviewVerifierKind,
  AssetTrustTier,
} from "./types.js";

export interface AssetCatalogValidationIssue {
  code:
    | "MISSING_FIELD"
    | "INVALID_ID"
    | "INVALID_REVIEW"
    | "INVALID_VERIFICATION"
    | "INVALID_TRUST_TIER"
    | "INVALID_ACQUISITION_LANE"
    | "INVALID_FILE"
    | "INVALID_CHECKSUM";
  path: string;
  message: string;
}

export interface AssetCatalogValidationResult {
  status: "accepted" | "rejected";
  issues: AssetCatalogValidationIssue[];
}

type UnknownRecord = Record<string, unknown>;

const catalogIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const reviewStatuses = new Set<AssetReviewStatus>(["unreviewed", "needs-review", "verified", "rejected"]);
const verifierKinds = new Set<AssetReviewVerifierKind>(["developer", "loombridge", "source-owner"]);
const acquisitionLanes = new Set<AssetAcquisitionLane>(["api", "mirror-index", "scraped-discovery"]);
const trustTiers = new Set<AssetTrustTier>(["trusted-default", "attribution-required", "unverified-discovery", "blocked"]);
const fileFormats = new Set<AssetFileFormat>(["png", "jpg", "jpeg", "wav", "ogg", "glb", "svg"]);
const knownKinds = new Set<AssetKind>(["sprite", "audio", "material", "model", "vector"]);

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pushIssue(
  issues: AssetCatalogValidationIssue[],
  code: AssetCatalogValidationIssue["code"],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = stringValue(value);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeFile(input: unknown, record: UnknownRecord): AssetFile | undefined {
  const file = isObject(input) ? input : {};
  const nestedFile = isObject(record.file) ? record.file : {};
  const localPath = firstString(file.localPath, record.localPath, nestedFile.localPath);
  const url = firstString(file.url, file.githubRawUrl, record.githubRawUrl, nestedFile.url, nestedFile.githubRawUrl);
  const githubRawUrl = firstString(file.githubRawUrl, record.githubRawUrl, nestedFile.githubRawUrl);
  const githubBlobUrl = firstString(file.githubBlobUrl, record.githubBlobUrl, nestedFile.githubBlobUrl);
  const sha256 = firstString(file.sha256, nestedFile.sha256);
  const checksum = isObject(file.checksum)
    ? file.checksum
    : sha256
      ? { algorithm: "sha256", value: sha256 }
      : undefined;
  const role = firstString(file.role, record.role, nestedFile.role) ?? "sprite";
  const format = firstString(file.format, record.format, nestedFile.format) ?? formatFromPath(localPath ?? url ?? "");
  if (!localPath && !url && !githubRawUrl) {
    return undefined;
  }

  return {
    role: role as AssetFile["role"],
    format: (format ?? "png") as AssetFileFormat,
    localPath,
    url,
    githubRawUrl,
    githubBlobUrl,
    sizeBytes: numberValue(file.sizeBytes) ?? numberValue(nestedFile.sizeBytes) ?? numberValue(record.sizeBytes),
    sha256,
    checksum: checksum as AssetFile["checksum"],
  };
}

function formatFromPath(pathOrUrl: string): AssetFileFormat | undefined {
  const extension = pathOrUrl.split("?")[0]?.split(".").pop()?.toLowerCase();
  return fileFormats.has(extension as AssetFileFormat) ? extension as AssetFileFormat : undefined;
}

function normalizeFiles(input: UnknownRecord): AssetFile[] {
  if (Array.isArray(input.files)) {
    return input.files.flatMap((file) => {
      const normalized = normalizeFile(file, input);
      return normalized ? [normalized] : [];
    });
  }

  const normalized = normalizeFile(undefined, input);
  return normalized ? [normalized] : [];
}

function normalizeReview(input: UnknownRecord): AssetReview {
  const review = isObject(input.review) ? input.review : {};
  return {
    status: (stringValue(review.status) ?? "unreviewed") as AssetReviewStatus,
    verifiedBy: stringValue(review.verifiedBy) as AssetReviewVerifierKind | undefined,
    verifiedAt: stringValue(review.verifiedAt),
    reviewer: stringValue(review.reviewer),
    notes: stringValue(review.notes),
    reason: stringValue(review.reason),
  };
}

function titleFromInput(input: UnknownRecord): string | undefined {
  return stringValue(input.title) ?? stringValue(input.sourceId) ?? stringValue(input.id);
}

function normalizeProvider(input: UnknownRecord): AssetCatalogRecord["provider"] {
  const provider = isObject(input.provider) ? input.provider : {};
  const providerId = stringValue(input.providerId);
  return {
    name: stringValue(provider.name) ?? providerId ?? "",
    // A BROWSE link recording where a compact record came from, and required non-empty by
    // `validateCatalogRecord`. It is deliberately a deep `/tree/main/catalog/` path, and the
    // endpoint guard allowlists only that exact prefix: a repo-root GitHub prefix used to be
    // allowlisted, which permitted the exact private-mirror DEFAULT the guard exists to prevent.
    url: stringValue(provider.url) ?? (providerId ? `https://github.com/Loomtide/LoomtideAssetRegistry/tree/main/catalog/providers/${providerId}.json` : ""),
    type: stringValue(provider.type) as AssetCatalogRecord["provider"]["type"],
    acquisitionLane: stringValue(provider.acquisitionLane) as AssetAcquisitionLane | undefined,
    termsNotes: stringValue(provider.termsNotes),
  };
}

function normalizeSource(input: UnknownRecord): AssetCatalogRecord["source"] {
  const source = isObject(input.source) ? input.source : {};
  const sourceId = stringValue(input.sourceId);
  const review = isObject(input.review) ? input.review : {};
  const verifiedAt = stringValue(review.verifiedAt) ?? "";
  const origin = sourceId ? `Loomtide/LoomtideAssetRegistry:${sourceId}` : "";
  const fixture = firstString(input.localPath, input.githubRawUrl, input.relativePath, input.id) ?? "";
  return {
    title: stringValue(source.title) ?? titleFromInput(input) ?? "",
    // As in `normalizeProvider`: a browse link, never an endpoint.
    url: stringValue(source.url) ?? (sourceId ? `https://github.com/Loomtide/LoomtideAssetRegistry/tree/main/catalog/sources/${sourceId}.json` : ""),
    downloadPage: stringValue(source.downloadPage),
    author: stringValue(source.author) ?? stringValue(input.providerId) ?? "",
    verified: typeof source.verified === "boolean" ? source.verified : stringValue(review.status) === "verified" ? true : undefined,
    provenance: isObject(source.provenance)
      ? source.provenance as AssetCatalogRecord["source"]["provenance"]
      : { verifiedAt, origin, fixture },
  };
}

function normalizeLicense(input: UnknownRecord): AssetCatalogRecord["license"] {
  const license = isObject(input.license) ? input.license : {};
  const spdx = stringValue(license.spdx) ?? "";
  return {
    name: stringValue(license.name) ?? (spdx === "CC0-1.0" ? "Creative Commons CC0 1.0 Universal" : spdx),
    spdx,
    url: stringValue(license.url) ?? (spdx === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : ""),
    requiresAttribution: license.requiresAttribution === true,
  };
}

function normalizeUnity(input: UnknownRecord): AssetCatalogRecord["unity"] {
  const unity = isObject(input.unity) ? input.unity : {};
  return {
    ...unity,
    path: stringValue(unity.path) ?? "",
    pixelsPerUnit: Number.isInteger(unity.pixelsPerUnit) ? unity.pixelsPerUnit as number : 100,
  } as AssetCatalogRecord["unity"];
}

function searchableText(input: UnknownRecord): string {
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return [
    input.id,
    input.title,
    input.category,
    input.relativePath,
    input.localPath,
    ...tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function inferPrimitive(input: UnknownRecord, kind: AssetKind | undefined): string {
  const explicit = stringValue(input.primitive);
  if (explicit && explicit !== "asset" && explicit !== "ui") {
    return explicit;
  }

  const text = searchableText(input);
  if (kind === "audio") {
    if (/\b(jump)\b/.test(text)) return "sfx_jump";
    if (/\b(dash|whoosh)\b/.test(text)) return "sfx_dash";
    if (/\b(collect|coin|pickup|gem)\b/.test(text)) return "sfx_collect";
    if (/\b(hit|hurt|damage|death)\b/.test(text)) return "sfx_hit";
    if (/\b(bounce|spring)\b/.test(text)) return "sfx_bounce";
    if (/\b(win|success|complete|victory)\b/.test(text)) return "sfx_win";
  }

  if (/\b(tile|tiles|tilemap|terrain|ground|platform)\b/.test(text)) return "tile";
  if (/\b(player|character|hero|adventurer)\b/.test(text)) return "player";
  if (/\b(enemy|enemies|monster|slime|spike|hazard|saw)\b/.test(text)) return "enemy";
  if (/\b(coin|coins|gem|gems|pickup|collectible|collectables|fruit)\b/.test(text)) return "collectible";
  if (/\b(parallax)\b/.test(text)) return "parallax_background";
  if (/\b(background|backdrop|sky|cloud|clouds|hills|mountain|mountains|forest)\b/.test(text)) return "background";
  if (/\b(particle|particles|vfx|effect|effects|explosion|smoke|spark)\b/.test(text)) return "vfx";
  if (/\b(ui|button|buttons|hud|icon|icons|cursor|panel|window)\b/.test(text)) return "decor";
  if (/\b(prop|props|decor|decoration|object|crate|box|barrel|sign)\b/.test(text)) return "decor";

  return explicit ?? "";
}

function normalizedTags(input: UnknownRecord): string[] {
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const text = searchableText(input);
  const inferred = new Set(tags);
  if (/\b(hazard|spike|spikes|saw|saws|enemy|enemies|monster|slime)\b/.test(text)) {
    inferred.add("hazard");
  }
  if (/\b(coin|coins|gem|gems|pickup|collectible|fruit)\b/.test(text)) {
    inferred.add("collectible");
  }
  if (/\b(button|buttons|hud|ui|icon|icons)\b/.test(text)) {
    inferred.add("ui");
  }
  return [...inferred];
}

function normalizePack(input: UnknownRecord): AssetCatalogRecord["pack"] {
  const pack = isObject(input.pack) ? input.pack : {};
  const packId = stringValue(pack.packId) ?? stringValue(input.packId);
  if (!packId) {
    return undefined;
  }
  return {
    packId,
    name: stringValue(pack.name),
    version: stringValue(pack.version),
    catalogPath: stringValue(pack.catalogPath),
  };
}

export function normalizeCatalogRecord(input: unknown): AssetCatalogRecord {
  if (!isObject(input)) {
    throw new Error("Catalog record must be an object.");
  }

  const kind = stringValue(input.kind) as AssetKind | undefined;
  const normalizedKind = knownKinds.has(kind as AssetKind) ? kind : undefined;
  const record: AssetCatalogRecord = {
    id: stringValue(input.id) ?? "",
    genre: stringValue(input.genre) ?? "game-asset",
    primitive: inferPrimitive(input, normalizedKind),
    kind: normalizedKind,
    priority: Number.isInteger(input.priority) ? input.priority as number : undefined,
    placeholder: typeof input.placeholder === "boolean" ? input.placeholder : undefined,
    source: normalizeSource(input),
    license: normalizeLicense(input),
    provider: normalizeProvider(input),
    files: normalizeFiles(input),
    technical: isObject(input.technical) ? input.technical as AssetCatalogRecord["technical"] : {},
    tags: normalizedTags(input),
    unity: normalizeUnity(input),
    review: normalizeReview(input),
    acquisitionLane: stringValue(input.acquisitionLane) as AssetAcquisitionLane | undefined,
    trustTier: stringValue(input.trustTier) as AssetTrustTier | undefined,
    policyStatus: stringValue(input.policyStatus) as AssetTrustTier | undefined,
    category: stringValue(input.category),
    pack: normalizePack(input),
  };

  return record;
}

function validateReview(review: AssetReview, path: string, issues: AssetCatalogValidationIssue[]): void {
  if (!reviewStatuses.has(review.status)) {
    pushIssue(issues, "INVALID_REVIEW", `${path}.review.status`, "review.status must be unreviewed, needs-review, verified, or rejected.");
    return;
  }

  if (review.verifiedBy && !verifierKinds.has(review.verifiedBy)) {
    pushIssue(issues, "INVALID_REVIEW", `${path}.review.verifiedBy`, "review.verifiedBy must be developer, loombridge, or source-owner.");
  }

  if (review.status === "verified") {
    if (!review.verifiedBy || !review.verifiedAt || !review.reviewer) {
      pushIssue(
        issues,
        "INVALID_VERIFICATION",
        `${path}.review`,
        "Verified assets must include review.verifiedBy, review.verifiedAt, and review.reviewer.",
      );
    }
  }

  if (review.status === "rejected" && !review.reason && !review.notes) {
    pushIssue(issues, "INVALID_REVIEW", `${path}.review.reason`, "Rejected assets must include review.reason or review.notes.");
  }
}

function validateFile(file: AssetFile, path: string, issues: AssetCatalogValidationIssue[]): void {
  if (!file.localPath && !file.url && !file.githubRawUrl) {
    pushIssue(issues, "INVALID_FILE", path, "Asset file must include localPath, url, or githubRawUrl.");
  }

  if (!fileFormats.has(file.format)) {
    pushIssue(issues, "INVALID_FILE", `${path}.format`, "Asset file format must be png, jpg, jpeg, wav, ogg, glb, or svg.");
  }

  const checksumValue = file.checksum?.value ?? file.sha256;
  if (checksumValue && !sha256Pattern.test(checksumValue)) {
    pushIssue(issues, "INVALID_CHECKSUM", `${path}.checksum`, "Checksum must be a lowercase sha256 hex digest.");
  }

  if (file.checksum && file.checksum.algorithm !== "sha256") {
    pushIssue(issues, "INVALID_CHECKSUM", `${path}.checksum.algorithm`, "Only sha256 checksums are supported.");
  }
}

export function validateCatalogRecord(record: AssetCatalogRecord, path = "asset"): AssetCatalogValidationResult {
  const issues: AssetCatalogValidationIssue[] = [];

  if (!catalogIdPattern.test(record.id)) {
    pushIssue(issues, "INVALID_ID", `${path}.id`, "Catalog asset id must be lowercase and URL-safe.");
  }

  for (const field of ["genre", "primitive"] as const) {
    if (!stringValue(record[field])) {
      pushIssue(issues, "MISSING_FIELD", `${path}.${field}`, `${field} is required.`);
    }
  }

  if (record.kind && !knownKinds.has(record.kind)) {
    pushIssue(issues, "MISSING_FIELD", `${path}.kind`, "kind must be sprite, audio, material, model, or vector.");
  }

  if (!stringValue(record.source.title) || !stringValue(record.source.url) || !stringValue(record.source.author)) {
    pushIssue(issues, "MISSING_FIELD", `${path}.source`, "source.title, source.url, and source.author are required.");
  }

  if (!stringValue(record.license.name) || !stringValue(record.license.spdx) || !stringValue(record.license.url)) {
    pushIssue(issues, "MISSING_FIELD", `${path}.license`, "license.name, license.spdx, and license.url are required.");
  }

  if (!stringValue(record.provider.name) || !stringValue(record.provider.url)) {
    pushIssue(issues, "MISSING_FIELD", `${path}.provider`, "provider.name and provider.url are required.");
  }

  if (!Array.isArray(record.files) || record.files.length === 0) {
    pushIssue(issues, "INVALID_FILE", `${path}.files`, "Catalog records must declare at least one file.");
  } else {
    record.files.forEach((file, index) => validateFile(file, `${path}.files[${index}]`, issues));
  }

  if (!Array.isArray(record.tags) || record.tags.length === 0) {
    pushIssue(issues, "MISSING_FIELD", `${path}.tags`, "tags must include at least one searchable tag.");
  }

  if (record.acquisitionLane && !acquisitionLanes.has(record.acquisitionLane)) {
    pushIssue(issues, "INVALID_ACQUISITION_LANE", `${path}.acquisitionLane`, "Unsupported acquisition lane.");
  }

  if (record.provider.acquisitionLane && !acquisitionLanes.has(record.provider.acquisitionLane)) {
    pushIssue(issues, "INVALID_ACQUISITION_LANE", `${path}.provider.acquisitionLane`, "Unsupported provider acquisition lane.");
  }

  if (record.trustTier && !trustTiers.has(record.trustTier)) {
    pushIssue(issues, "INVALID_TRUST_TIER", `${path}.trustTier`, "Unsupported trust tier.");
  }

  if (record.policyStatus && !trustTiers.has(record.policyStatus)) {
    pushIssue(issues, "INVALID_TRUST_TIER", `${path}.policyStatus`, "Unsupported policy status.");
  }

  validateReview(record.review, path, issues);
  if (record.source.verified === true && record.review.status !== "verified") {
    pushIssue(
      issues,
      "INVALID_VERIFICATION",
      `${path}.source.verified`,
      "source.verified is legacy metadata and cannot contradict review.status.",
    );
  }
  if (record.review.status !== "verified" && (record.trustTier === "trusted-default" || record.policyStatus === "trusted-default")) {
    pushIssue(
      issues,
      "INVALID_TRUST_TIER",
      `${path}.trustTier`,
      "trusted-default requires review.status='verified'.",
    );
  }
  if (record.trustTier === "blocked" || record.policyStatus === "blocked") {
    pushIssue(
      issues,
      "INVALID_TRUST_TIER",
      `${path}.trustTier`,
      "blocked catalog records are not accepted for registry use.",
    );
  }

  return {
    status: issues.length === 0 ? "accepted" : "rejected",
    issues: issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)),
  };
}

export {
  validatePublicCatalogRecord,
  type PublicCatalogValidationIssue,
  type PublicCatalogValidationResult,
} from "./public-catalog-validation.js";

export function parseCatalogJsonl(input: string): AssetCatalogRecord[] {
  return input
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      try {
        return normalizeCatalogRecord(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid catalog JSONL at line ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function adaptRegistryPackToCatalog(
  pack: AssetRegistryPack,
  options: { reviewedAt?: string; reviewer?: string; verifiedBy?: AssetReviewVerifierKind } = {},
): AssetCatalogRecord[] {
  const verifiedAt = options.reviewedAt ?? new Date(0).toISOString();
  const reviewer = options.reviewer ?? pack.name;
  const verifiedBy = options.verifiedBy ?? "developer";

  return pack.entries.map((entry) => ({
    ...entry,
    review: entry.source.verified === true
      ? { status: "verified", verifiedBy, verifiedAt, reviewer }
      : { status: "needs-review", notes: "Adapted from legacy registry pack without source.verified=true." },
    acquisitionLane: entry.provider.acquisitionLane,
    trustTier: entry.source.verified === true
      ? entry.license.requiresAttribution ? "attribution-required" : "trusted-default"
      : "unverified-discovery",
    policyStatus: entry.source.verified === true
      ? entry.license.requiresAttribution ? "attribution-required" : "trusted-default"
      : "unverified-discovery",
    pack: {
      packId: pack.packId,
      name: pack.name,
    },
  }));
}

export function catalogRecordToRegistryEntry(record: AssetCatalogRecord): AssetRegistryEntry {
  const entry: AssetRegistryEntry = {
    id: record.id,
    genre: record.genre,
    primitive: record.primitive,
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.placeholder !== undefined ? { placeholder: record.placeholder } : {}),
    source: record.source,
    license: record.license,
    provider: record.provider,
    files: record.files.map((file) => {
      const normalizedFile: AssetFile = {
        role: file.role,
        format: file.format,
        ...(file.localPath ? { localPath: file.localPath } : {}),
        ...(file.url ?? file.githubRawUrl ? { url: file.url ?? file.githubRawUrl } : {}),
        ...(file.githubRawUrl ? { githubRawUrl: file.githubRawUrl } : {}),
        ...(file.githubBlobUrl ? { githubBlobUrl: file.githubBlobUrl } : {}),
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(file.checksum ?? file.sha256 ? { checksum: file.checksum ?? { algorithm: "sha256", value: file.sha256! } } : {}),
      };
      return normalizedFile;
    }),
    technical: record.technical,
    tags: record.tags,
    unity: record.unity,
    review: record.review,
    ...(record.acquisitionLane ? { acquisitionLane: record.acquisitionLane } : {}),
    ...(record.trustTier ? { trustTier: record.trustTier } : {}),
    ...(record.policyStatus ? { policyStatus: record.policyStatus } : {}),
  };
  return entry;
}
