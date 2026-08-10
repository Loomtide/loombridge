import { catalogRecordToRegistryEntry } from "./catalog.js";
import { trustTierForEntry } from "./trust.js";
import type { AssetCatalogRecord, AssetFile } from "./types.js";

export interface PublicCatalogValidationIssue {
  code:
    | "MISSING_PUBLIC_URL"
    | "PRIVATE_URL"
    | "MISSING_CHECKSUM"
    | "MISSING_SIZE"
    | "MISSING_TECHNICAL"
    | "MISSING_PROFILE_FIELD"
    | "TRUST_POLICY_INCONSISTENT";
  path: string;
  message: string;
}

export interface PublicCatalogValidationResult {
  status: "accepted" | "rejected";
  issues: PublicCatalogValidationIssue[];
}

/**
 * Hosts that indicate a PRIVATE mirror / non-public source. A public seed record's
 * resolvable file url must never point at one of these — an external developer cannot
 * fetch it without private credentials (github raw/api) or it is unroutable (loopback).
 */
const PRIVATE_HOSTNAMES = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "codeload.github.com",
  "localhost",
  "ip6-localhost",
]);

const sha256Pattern = /^[a-f0-9]{64}$/;

/**
 * SPDX ids that are commercial-use-compatible AND attribution-free, so they may back a
 * `trusted-default` record. Anything else (CC-BY*, unknown, proprietary) cannot claim
 * trusted-default. Kept deliberately tight (CC0 only) for the first public seed.
 */
const TRUSTED_DEFAULT_SPDX_ALLOWLIST = new Set(["CC0-1.0"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  // 127.0.0.0/8 loopback, 10/8, 172.16/12, 192.168/16, 169.254/16 link-local, 0.0.0.0
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Normalize a URL hostname before private-host / IP matching:
 *  - strip a single bracketed IPv6 wrapper (`[::1]` -> `::1`)
 *  - lowercase
 *  - strip ONE trailing FQDN dot (`raw.githubusercontent.com.` -> `raw.githubusercontent.com`)
 * This closes the trailing-dot FQDN bypass — the URL parser preserves the dot, so an
 * exact-match Set would otherwise let `github.com.` / `localhost.` slip through.
 */
function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

function isPrivateHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (PRIVATE_HOSTNAMES.has(host)) {
    return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return isPrivateIpv4(host);
}

/**
 * A public, resolvable url: parseable, http(s), and NOT a private/mirror/loopback host.
 * github raw/blob/api urls and any private-mirror-looking host are rejected.
 */
function isPublicResolvableUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return !isPrivateHost(parsed.hostname);
}

/**
 * True when a candidate url parses to a (normalized) private/mirror host. Used for the
 * githubRawUrl/githubBlobUrl fields so a github / private host in those fields rejects a
 * public record regardless of repo. A non-url string (no parseable host) is treated as
 * NOT a private host here — the mirror-path regex still guards repo-embedding strings.
 */
function hostIsPrivate(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return isPrivateHost(parsed.hostname);
}

/**
 * A path/url that LOOKS like a private mirror reference even if it parses as a url, e.g. an
 * http(s) url on a PUBLIC host whose path embeds the non-public registry repo.
 *
 * Matches the repo slug alone, deliberately, and not `<org>/<repo>`. The previous pattern was
 * `Loombridge/LoomtideAssetRegistry`, and the owning org is `Loomtide`: the org segment was
 * misspelled, so this branch could never fire on the path it exists to catch. It looked green
 * only because every case the tests exercised was on `raw.githubusercontent.com`, which
 * `hostIsPrivate` rejects first. Matching the slug alone fixes the typo and stops the check
 * depending on which org happens to own the mirror.
 */
function looksLikePrivateMirrorPath(value: string): boolean {
  return /LoomtideAssetRegistry/i.test(value);
}

function publicFileUrl(file: AssetFile): string | undefined {
  // githubRawUrl / githubBlobUrl are private-mirror refs and never count as a public url.
  return [file.url].find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function push(
  issues: PublicCatalogValidationIssue[],
  code: PublicCatalogValidationIssue["code"],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

/**
 * Validation gate for PUBLIC seed records. REJECTS (never silently skips) when any bound
 * field is absent or policy-inconsistent. A missing bound field is a REJECT — the threat
 * model is a hand-authored/edited public record that smuggles in a private url, drops a
 * checksum, or claims trusted-default without a CC0 license + verified review.
 *
 * The trust-consistency check reuses the hardened `trustTierForEntry` (single source of
 * truth) so the locally re-derived tier — never the asserted one — is what is enforced.
 */
export function validatePublicCatalogRecord(
  record: AssetCatalogRecord,
  path = "record",
): PublicCatalogValidationResult {
  const issues: PublicCatalogValidationIssue[] = [];

  // --- Required profile fields ------------------------------------------------------
  if (typeof record.genre !== "string" || record.genre.trim().length === 0) {
    push(issues, "MISSING_PROFILE_FIELD", `${path}.genre`, "genre is required for a public record.");
  }
  if (typeof record.primitive !== "string" || record.primitive.trim().length === 0) {
    push(issues, "MISSING_PROFILE_FIELD", `${path}.primitive`, "primitive is required for a public record.");
  }
  if (typeof record.kind !== "string" || record.kind.trim().length === 0) {
    push(issues, "MISSING_PROFILE_FIELD", `${path}.kind`, "kind is required for a public record.");
  }
  if (!Array.isArray(record.tags) || record.tags.length === 0) {
    push(issues, "MISSING_PROFILE_FIELD", `${path}.tags`, "at least one tag is required for a public record.");
  }
  if (!record.unity || typeof record.unity.path !== "string" || record.unity.path.trim().length === 0) {
    push(issues, "MISSING_PROFILE_FIELD", `${path}.unity.path`, "unity.path is required for a public record.");
  }

  // --- Public, resolvable file urls + byte pinning ----------------------------------
  const files = Array.isArray(record.files) ? record.files : [];
  if (files.length === 0) {
    // A missing/empty files array is a REJECT — and we must bail out BEFORE the trust
    // section calls catalogRecordToRegistryEntry(record) (which does record.files.map),
    // otherwise an absent files array throws a TypeError instead of rejecting.
    push(issues, "MISSING_PUBLIC_URL", `${path}.files`, "public record must declare at least one file with a public url.");
    return {
      status: "rejected",
      issues: issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)),
    };
  }

  let hasAnyPublicUrl = false;
  files.forEach((file, index) => {
    const filePath = `${path}.files[${index}]`;
    const url = publicFileUrl(file);

    if (!url) {
      push(issues, "MISSING_PUBLIC_URL", `${filePath}.url`, "file is missing a public files[].url.");
    } else if (!isPublicResolvableUrl(url) || looksLikePrivateMirrorPath(url)) {
      push(issues, "PRIVATE_URL", `${filePath}.url`, `file url '${url}' is private/non-public and is not externally resolvable.`);
    } else {
      hasAnyPublicUrl = true;
    }

    // githubRawUrl/githubBlobUrl must not carry ANY github/private host (regardless of repo)
    // — these are private-mirror refs and an external developer cannot fetch them. We apply
    // the same normalized private-host check used for files[].url, so a foreign-repo
    // raw.githubusercontent.com / github.com / api.github.com / codeload.github.com / private
    // host in these fields rejects even when it does not match the mirror-repo regex.
    for (const [key, value] of [
      ["githubRawUrl", file.githubRawUrl],
      ["githubBlobUrl", file.githubBlobUrl],
    ] as const) {
      if (typeof value === "string" && value.length > 0 && hostIsPrivate(value)) {
        push(issues, "PRIVATE_URL", `${filePath}.${key}`, `file ${key} '${value}' references a private/non-public host.`);
      }
    }

    // localPath (and any of the above) must not embed the private-mirror registry repo path.
    for (const [key, value] of [
      ["githubRawUrl", file.githubRawUrl],
      ["githubBlobUrl", file.githubBlobUrl],
      ["localPath", file.localPath],
    ] as const) {
      if (typeof value === "string" && looksLikePrivateMirrorPath(value)) {
        push(issues, "PRIVATE_URL", `${filePath}.${key}`, `file ${key} '${value}' references a private mirror path.`);
      }
    }

    const checksumValue = file.checksum?.value ?? file.sha256;
    if (!checksumValue || !sha256Pattern.test(checksumValue)) {
      push(issues, "MISSING_CHECKSUM", `${filePath}.checksum.value`, "file is missing a valid sha256 checksum.value.");
    }

    if (typeof file.sizeBytes !== "number" || !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
      push(issues, "MISSING_SIZE", `${filePath}.sizeBytes`, "file is missing a positive sizeBytes.");
    }
  });

  if (files.length > 0 && !hasAnyPublicUrl) {
    push(issues, "MISSING_PUBLIC_URL", `${path}.files`, "no file declares a public, externally resolvable url.");
  }

  // --- Technical metadata for images ------------------------------------------------
  const isImage = record.kind === "sprite" || record.kind === undefined;
  if (isImage) {
    const technical = isObject(record.technical) ? record.technical : undefined;
    const width = technical?.width;
    const height = technical?.height;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      push(issues, "MISSING_TECHNICAL", `${path}.technical.width`, "image record is missing technical.width.");
    }
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
      push(issues, "MISSING_TECHNICAL", `${path}.technical.height`, "image record is missing technical.height.");
    }
  }

  // --- Trust / review / license consistency -----------------------------------------
  // Re-derive the tier locally (single source of truth) — never trust the asserted tier.
  const derivedTier = trustTierForEntry(catalogRecordToRegistryEntry(record));
  const assertedTier = record.trustTier ?? record.policyStatus;

  if (assertedTier === "trusted-default") {
    if (record.review?.status !== "verified") {
      push(
        issues,
        "TRUST_POLICY_INCONSISTENT",
        `${path}.review.status`,
        "trustTier 'trusted-default' requires review.status 'verified'.",
      );
    }
    if (record.license?.requiresAttribution === true) {
      push(
        issues,
        "TRUST_POLICY_INCONSISTENT",
        `${path}.license.requiresAttribution`,
        "an attribution-required license cannot be trusted-default; it must map to attribution-required.",
      );
    }
    if (!record.license || !TRUSTED_DEFAULT_SPDX_ALLOWLIST.has(record.license.spdx)) {
      push(
        issues,
        "TRUST_POLICY_INCONSISTENT",
        `${path}.license.spdx`,
        `license '${record.license?.spdx ?? "(none)"}' is not a commercial-use-compatible CC0 license and cannot be trusted-default.`,
      );
    }
    // The locally re-derived tier must agree the record is trusted-default; if license/review
    // would force a more restrictive tier, the asserted trusted-default is inconsistent.
    if (derivedTier !== "trusted-default") {
      push(
        issues,
        "TRUST_POLICY_INCONSISTENT",
        `${path}.trustTier`,
        `asserted trustTier 'trusted-default' but locally re-derived tier is '${derivedTier}'.`,
      );
    }
  }

  // An attribution-required license must be mapped to the attribution-required tier
  // (never silently dropped to trusted-default or left unmapped).
  if (record.license?.requiresAttribution === true && assertedTier !== "attribution-required") {
    push(
      issues,
      "TRUST_POLICY_INCONSISTENT",
      `${path}.trustTier`,
      "license.requiresAttribution=true must map to trustTier 'attribution-required'.",
    );
  }

  return {
    status: issues.length === 0 ? "accepted" : "rejected",
    issues: issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)),
  };
}
