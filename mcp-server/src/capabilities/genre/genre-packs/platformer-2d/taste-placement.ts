/**
 * Archetype placement for TASTE metrics (the grammar/taste split's descriptive
 * half). Where the selected profile's grading answers "does this game hit the
 * chosen archetype's targets", placement answers the question a mismatch raises:
 * "then which archetype does this tuning actually resemble?"
 *
 * Pure and synchronous: profiles are passed in (callers use `loadAllProfiles()`).
 * Placement is DESCRIPTIVE ONLY. It never touches `status`, `summary`, or exit
 * codes; enforcement stays in `evaluateProfile` behind `--enforce-taste`.
 *
 * Honesty rules (house invariants):
 *  - A metric is only compared against profiles that BAND it (maxFallSpeed exists
 *    only on momentum; the asymmetry is stamped per entry, never papered over).
 *  - A §0-rejected value earns NO placement: a tampered number can describe
 *    nothing. It lands in `excluded` with the distrust reason.
 *  - Taste metrics the selected profile bands but that were not measured land in
 *    `notMeasured`: stamped, never silently skipped.
 */

import { bandWindow } from "../../../verification/gates/feel.js";
import {
  KNOWN_PROFILE_METRICS,
  type PlatformerFeelProfile,
  type ProfileMetricTarget,
} from "./types.js";

/** Distance of a measured value from ONE profile's target for a metric. */
export interface TasteProfileDistance {
  profileId: string;
  target: number;
  bandLabel: string;
  inBand: boolean;
  /**
   * |measured - target| / band half-width. 0 is dead center; 1 sits exactly on
   * the band edge; >1 is outside. Unit-safe (normalized per profile band).
   */
  normalizedDistance: number;
}

export interface TastePlacementEntry {
  id: string;
  label: string;
  unit: string;
  measured: number;
  /** Profile id with the minimum normalizedDistance (ties break toward the selected profile, then order of `all`). */
  nearest: string;
  /** One row per shipped profile that BANDS this metric. */
  distances: TasteProfileDistance[];
  /** Human line, e.g. "runSpeed 13.2u/s: nearest momentum (14u/s ±20%)". */
  detail: string;
}

export interface TastePlacementBlock {
  /**
   * `computed` when at least one taste metric earned a placement;
   * `no_taste_measured` when the selected profile bands taste metrics but none
   * were measured (or all were rejected); `no_taste_banded` when the selected
   * profile bands no taste metric at all.
   */
  status: "computed" | "no_taste_measured" | "no_taste_banded";
  entries: TastePlacementEntry[];
  /** Taste ids the SELECTED profile bands that have no measurement (no silent skip). */
  notMeasured: string[];
  /** Measured taste values excluded from placement, with the distrust reason. */
  excluded: Array<{ id: string; reason: string }>;
  /** Argmin over profiles of mean normalizedDistance across placed entries. Absent when no entries. */
  overallNearest?: string;
  detail: string;
}

function isTasteId(id: string): boolean {
  return KNOWN_PROFILE_METRICS[id]?.gating === "taste";
}

function distanceFor(measured: number, target: ProfileMetricTarget): {
  inBand: boolean;
  normalizedDistance: number;
} {
  const { lo, hi } = bandWindow(target);
  const halfWidth = (hi - lo) / 2;
  const delta = Math.abs(measured - target.target);
  if (halfWidth === 0) {
    // An exact (band-less) target cannot occur on a validated profile (bands are
    // required), but a hand-built profile in tests could: refuse to fake a ratio.
    return { inBand: delta === 0, normalizedDistance: delta === 0 ? 0 : Number.POSITIVE_INFINITY };
  }
  return { inBand: delta <= halfWidth + 1e-9, normalizedDistance: delta / halfWidth };
}

/**
 * Compute the placement block for a report.
 *
 * `selected` decides which taste ids are graded this run (its banded taste set);
 * `all` (the shipped profiles, selected included) supplies the comparison targets.
 * `measuredMetrics` is the post-coverage-refusal metrics map (a value stripped for
 * a harness gap must not earn a placement either). `excluded` maps metric id to
 * the §0 distrust reason.
 */
export function computeTastePlacement(
  selected: PlatformerFeelProfile,
  all: readonly PlatformerFeelProfile[],
  measuredMetrics: Record<string, number>,
  excluded: ReadonlyMap<string, string>,
): TastePlacementBlock {
  const selectedTasteIds = Object.keys(selected.metrics).filter(isTasteId);
  if (selectedTasteIds.length === 0) {
    return {
      status: "no_taste_banded",
      entries: [],
      notMeasured: [],
      excluded: [],
      detail: `Profile '${selected.id}' bands no taste metric; nothing to place.`,
    };
  }

  const entries: TastePlacementEntry[] = [];
  const notMeasured: string[] = [];
  const excludedOut: Array<{ id: string; reason: string }> = [];

  for (const id of selectedTasteIds) {
    const measured = measuredMetrics[id];
    if (measured === undefined) {
      notMeasured.push(id);
      continue;
    }
    const distrustReason = excluded.get(id);
    if (distrustReason !== undefined) {
      excludedOut.push({ id, reason: distrustReason });
      continue;
    }

    const spec = KNOWN_PROFILE_METRICS[id];
    const distances: TasteProfileDistance[] = [];
    for (const profile of all) {
      const target = profile.metrics[id] as ProfileMetricTarget | undefined;
      if (!target) continue;
      const { inBand, normalizedDistance } = distanceFor(measured, target);
      distances.push({
        profileId: profile.id,
        target: target.target,
        bandLabel: bandWindow(target).label,
        inBand,
        normalizedDistance,
      });
    }
    if (distances.length === 0) continue;

    let nearest = distances[0];
    for (const d of distances) {
      if (
        d.normalizedDistance < nearest.normalizedDistance ||
        (d.normalizedDistance === nearest.normalizedDistance && d.profileId === selected.id)
      ) {
        nearest = d;
      }
    }
    const unit = spec?.unit ?? "";
    entries.push({
      id,
      label: spec?.label ?? id,
      unit,
      measured,
      nearest: nearest.profileId,
      distances,
      detail: `${id} ${measured}${unit}: nearest ${nearest.profileId} (${nearest.target}${unit} ${nearest.bandLabel})`,
    });
  }

  if (entries.length === 0) {
    return {
      status: "no_taste_measured",
      entries,
      notMeasured,
      excluded: excludedOut,
      detail: `Profile '${selected.id}' bands ${selectedTasteIds.length} taste metric(s) but none earned a placement (unmeasured or rejected).`,
    };
  }

  // Overall nearest: argmin over profiles of the MEAN normalized distance across
  // the entries where that profile bands the metric. Ties break toward the
  // selected profile, then the order of `all`.
  const perProfile = new Map<string, { sum: number; count: number }>();
  for (const entry of entries) {
    for (const d of entry.distances) {
      const acc = perProfile.get(d.profileId) ?? { sum: 0, count: 0 };
      acc.sum += d.normalizedDistance;
      acc.count += 1;
      perProfile.set(d.profileId, acc);
    }
  }
  let overallNearest: string | undefined;
  let bestMean = Number.POSITIVE_INFINITY;
  for (const profile of all) {
    const acc = perProfile.get(profile.id);
    if (!acc || acc.count === 0) continue;
    const mean = acc.sum / acc.count;
    if (mean < bestMean || (mean === bestMean && profile.id === selected.id)) {
      bestMean = mean;
      overallNearest = profile.id;
    }
  }

  return {
    status: "computed",
    entries,
    notMeasured,
    excluded: excludedOut,
    overallNearest,
    detail: `Taste placement across ${entries.length} metric(s): overall nearest '${overallNearest}'.`,
  };
}
