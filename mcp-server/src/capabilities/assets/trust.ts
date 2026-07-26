import type { AssetRegistryEntry, AssetReviewStatus, AssetTrustTier } from "./types.js";

export function reviewStatusForEntry(entry: AssetRegistryEntry): AssetReviewStatus {
  if (entry.review?.status) {
    return entry.review.status;
  }
  if (entry.trustTier || entry.policyStatus || entry.acquisitionLane || entry.provider?.acquisitionLane) {
    return "needs-review";
  }
  return entry.source?.verified === true ? "verified" : "needs-review";
}

// Restriction rank: a HIGHER rank is MORE restrictive.
const TRUST_TIER_RANK: Record<AssetTrustTier, number> = {
  "trusted-default": 0,
  "attribution-required": 1,
  "unverified-discovery": 2,
  "blocked": 3,
};

function moreRestrictive(a: AssetTrustTier, b: AssetTrustTier): AssetTrustTier {
  return TRUST_TIER_RANK[a] >= TRUST_TIER_RANK[b] ? a : b;
}

export function trustTierForEntry(entry: AssetRegistryEntry): AssetTrustTier {
  // Local re-derivation: the catalog's asserted trustTier may only make the tier more
  // restrictive; it can never elevate an entry to trusted-default.
  // Derive the MAX tier we will grant from first principles — asserted trustTier may never upgrade this.
  const reviewStatus = reviewStatusForEntry(entry);
  const derived: AssetTrustTier =
    entry.license?.requiresAttribution ? "attribution-required"
    : reviewStatus === "verified" && entry.license?.spdx === "CC0-1.0" ? "trusted-default"
    : "unverified-discovery";
  const explicit = entry.trustTier ?? entry.policyStatus;
  if (!explicit) return derived;
  // Pick the MORE restrictive of derived vs explicit (take the higher rank).
  return moreRestrictive(derived, explicit);
}
