/**
 * Platformer feel profile validator (S5a).
 *
 * Hand-written, mirroring `verification/validator.ts` style: a non-throwing
 * `validatePlatformerProfile` returning `{ valid, issues[] }`, plus a throwing
 * `assertValidPlatformerProfile` for load-time use.
 *
 * The rules are the anti-false-green moat for the profile contract (CLAUDE.md
 * "Verification / supervisor invariants" — an absent binding is a REFUSAL):
 *
 *   NO_METRICS        a profile with no measurable metrics                (vibe-only)
 *   MISSING_BAND      a metric with a target but no tolerance band        (exact = false-green)
 *   AMBIGUOUS_BAND    a band defining BOTH percent and abs                (window depends on helper precedence)
 *   UNKNOWN_METRIC    a metric id outside KNOWN_PROFILE_METRICS           (unmeasurable invention)
 *   UNSUPPORTED_UNIT  a unit outside SUPPORTED_PROFILE_UNITS              (typo masquerading as a unit)
 *   WRONG_UNIT        a supported unit that is wrong for that metric      (e.g. runSpeed in "ms")
 *   INVALID_PROFILE_ID an id that does not match PROFILE_ID_PATTERN       (malformed id)
 *
 * F2 build-block rules (a `build` block is optional; if present it must solve):
 *   BUILD_SOLVE_MISSING_BAND  build block on a profile missing a solve band
 *                             (jumpApex/timeToApex/runSpeed — can't derive params)
 *   BUILD_PARAM_UNVERIFIABLE  a stored jumpCutMultiplier with no shortHopApex band
 *                             (the stored param has no check to trace to)
 *
 * F3 mechanism-block rules (a `mechanisms` block is optional; if present):
 *   UNKNOWN_MECHANISM        an id outside KNOWN_MECHANISMS (a mechanism with no probe)
 *   CONTRADICTORY_MECHANISM  an id in BOTH requires and forbids (present AND absent)
 */

import {
  KNOWN_MECHANISM_SET,
  KNOWN_MECHANISMS,
  KNOWN_PROFILE_METRICS,
  PLATFORMER_PROFILE_SCHEMA_VERSION,
  PROFILE_ID_PATTERN,
  SUPPORTED_PROFILE_UNIT_SET,
  type PlatformerFeelProfile,
  type ProfileValidationIssue,
  type ProfileValidationResult,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function push(
  issues: ProfileValidationIssue[],
  code: string,
  message: string,
  path: string,
): void {
  issues.push({ code, message, path });
}

function validateMetricTarget(
  metricId: string,
  value: unknown,
  issues: ProfileValidationIssue[],
): void {
  const path = `metrics.${metricId}`;

  // Unknown metric id — profiles cannot invent unmeasurable vibes.
  const spec = KNOWN_PROFILE_METRICS[metricId];
  if (!spec) {
    push(
      issues,
      "UNKNOWN_METRIC",
      `${path}: '${metricId}' is not a known platformer metric.`,
      path,
    );
    // Keep validating the shape so we surface unit/band problems too, but we
    // can't enforce the canonical unit without a spec.
  }

  if (!isRecord(value)) {
    push(issues, "INVALID_TARGET", `${path} must be an object.`, path);
    return;
  }

  if (!isNumber(value.target)) {
    push(issues, "MISSING_FIELD", `${path}.target must be a number.`, `${path}.target`);
  }

  // Unit: must be a supported unit, AND the canonical unit for this metric.
  if (!isString(value.unit)) {
    push(issues, "MISSING_FIELD", `${path}.unit must be a string.`, `${path}.unit`);
  } else if (!SUPPORTED_PROFILE_UNIT_SET.has(value.unit)) {
    push(
      issues,
      "UNSUPPORTED_UNIT",
      `${path}.unit '${value.unit}' is not a supported profile unit.`,
      `${path}.unit`,
    );
  } else if (spec && value.unit !== spec.unit) {
    push(
      issues,
      "WRONG_UNIT",
      `${path}.unit must be '${spec.unit}' for '${metricId}' (got '${value.unit}').`,
      `${path}.unit`,
    );
  }

  // Band: REQUIRED for a profile (no exact targets — see types.ts note).
  if (value.band === undefined) {
    push(
      issues,
      "MISSING_BAND",
      `${path}.band is required — a profile metric must define a tolerance band, not an exact target.`,
      `${path}.band`,
    );
  } else if (!isRecord(value.band)) {
    push(issues, "INVALID_BAND", `${path}.band must be an object.`, `${path}.band`);
  } else {
    const hasPercent = value.band.percent !== undefined;
    const hasAbs = value.band.abs !== undefined;
    if (!hasPercent && !hasAbs) {
      push(
        issues,
        "MISSING_BAND",
        `${path}.band must define 'percent' or 'abs'.`,
        `${path}.band`,
      );
    } else if (hasPercent && hasAbs) {
      // Exactly one of percent/abs — otherwise the accepted window depends on the
      // comparison helper's precedence (bandWindow prefers abs), not the contract.
      push(
        issues,
        "AMBIGUOUS_BAND",
        `${path}.band must define exactly one of 'percent' or 'abs', not both.`,
        `${path}.band`,
      );
    }
    if (hasPercent && !(isNumber(value.band.percent) && (value.band.percent as number) > 0)) {
      push(issues, "INVALID_BAND", `${path}.band.percent must be a positive number.`, `${path}.band.percent`);
    }
    if (hasAbs && !(isNumber(value.band.abs) && (value.band.abs as number) > 0)) {
      push(issues, "INVALID_BAND", `${path}.band.abs must be a positive number.`, `${path}.band.abs`);
    }
  }
}

/** Metric ids the build-side solve reads to derive the starting params. */
const SOLVE_INPUT_METRICS = ["jumpApex", "timeToApex", "runSpeed"] as const;

/**
 * Validate the optional F2 `build` block. Refuse-don't-skip: if a `build` block is
 * present, the solve inputs must be banded and any stored param must trace to a
 * banded metric. `metrics` is the (already-shape-checked) profile metrics map.
 */
function validateBuildBlock(
  build: unknown,
  metrics: Record<string, unknown> | undefined,
  issues: ProfileValidationIssue[],
): void {
  if (build === undefined) return; // build is optional.

  if (!isRecord(build)) {
    push(issues, "INVALID_BUILD", "build must be an object.", "build");
    return;
  }

  // fixedTimestep is required + positive (the solve assumes it).
  if (!(isNumber(build.fixedTimestep) && (build.fixedTimestep as number) > 0)) {
    push(
      issues,
      "INVALID_BUILD",
      "build.fixedTimestep must be a positive number.",
      "build.fixedTimestep",
    );
  }

  const banded = (id: string): boolean =>
    isRecord(metrics) && isRecord(metrics[id]);

  // Solve inputs must be banded AND have a positive, finite target — the resolver
  // computes jumpSpeed = 2·jumpApex/(timeToApex/1000) etc., so a zero/negative/
  // non-finite target would derive an Infinity/negative param. Refuse at load,
  // don't let a degenerate profile produce garbage build params.
  for (const id of SOLVE_INPUT_METRICS) {
    if (!banded(id)) {
      push(
        issues,
        "BUILD_SOLVE_MISSING_BAND",
        `build is present but the solve input '${id}' is not banded on this profile — the resolver cannot derive starting params without it.`,
        `metrics.${id}`,
      );
      continue;
    }
    const target = (metrics as Record<string, Record<string, unknown>>)[id].target;
    if (!(isNumber(target) && (target as number) > 0)) {
      push(
        issues,
        "BUILD_SOLVE_MISSING_BAND",
        `build is present but the solve input '${id}' has a non-positive/non-finite target — the resolver would derive a non-finite or negative starting param.`,
        `metrics.${id}.target`,
      );
    }
  }

  // stored is REQUIRED when build is present (schema requires it; use {} when there
  // are no stored params, as momentum does). Absent stored is a malformed build.
  if (build.stored === undefined) {
    push(
      issues,
      "INVALID_BUILD",
      "build.stored is required — use an empty object {} when the profile has no stored params.",
      "build.stored",
    );
  } else if (build.stored !== undefined) {
    if (!isRecord(build.stored)) {
      push(issues, "INVALID_BUILD", "build.stored must be an object.", "build.stored");
    } else {
      const jumpCut = build.stored.jumpCutMultiplier;
      if (jumpCut !== undefined) {
        if (!isNumber(jumpCut)) {
          push(
            issues,
            "INVALID_BUILD",
            "build.stored.jumpCutMultiplier must be a number.",
            "build.stored.jumpCutMultiplier",
          );
        }
        // jumpCutMultiplier governs shortHopApex; storing it requires the band.
        if (!banded("shortHopApex")) {
          push(
            issues,
            "BUILD_PARAM_UNVERIFIABLE",
            "build.stored.jumpCutMultiplier is stored but the profile does not band 'shortHopApex' — the param has no check to trace to.",
            "build.stored.jumpCutMultiplier",
          );
        }
      }
    }
  }
}

/**
 * Validate the optional F3 `mechanisms` block. Refuse-don't-skip: if present, both
 * lists must be string arrays drawn from the closed `KNOWN_MECHANISMS` vocabulary
 * (UNKNOWN_MECHANISM), and an id cannot be in both lists (CONTRADICTORY_MECHANISM).
 * An empty block (requires: [], forbids: []) is valid — it makes no claim.
 */
function validateMechanismsBlock(
  mechanisms: unknown,
  issues: ProfileValidationIssue[],
): void {
  if (mechanisms === undefined) return; // mechanisms is optional.

  if (!isRecord(mechanisms)) {
    push(issues, "INVALID_MECHANISMS", "mechanisms must be an object.", "mechanisms");
    return;
  }

  const checkList = (key: "requires" | "forbids"): string[] => {
    const raw = (mechanisms as Record<string, unknown>)[key];
    if (raw === undefined) {
      push(
        issues,
        "INVALID_MECHANISMS",
        `mechanisms.${key} is required — use an empty array [] to claim nothing.`,
        `mechanisms.${key}`,
      );
      return [];
    }
    if (!Array.isArray(raw)) {
      push(issues, "INVALID_MECHANISMS", `mechanisms.${key} must be an array.`, `mechanisms.${key}`);
      return [];
    }
    const ids: string[] = [];
    raw.forEach((entry, i) => {
      const path = `mechanisms.${key}[${i}]`;
      if (typeof entry !== "string" || entry.trim().length === 0) {
        push(issues, "INVALID_MECHANISMS", `${path} must be a non-empty string.`, path);
        return;
      }
      if (!KNOWN_MECHANISM_SET.has(entry)) {
        push(
          issues,
          "UNKNOWN_MECHANISM",
          `${path}: '${entry}' is not a known mechanism. Known: ${KNOWN_MECHANISMS.join(", ")}.`,
          path,
        );
        return;
      }
      ids.push(entry);
    });
    return ids;
  };

  const requires = checkList("requires");
  const forbids = checkList("forbids");

  // An id asserted as BOTH present and absent is self-contradictory. Only check
  // the vocabulary-valid ids so an UNKNOWN_MECHANISM isn't double-reported.
  const forbidSet = new Set(forbids);
  for (const id of requires) {
    if (forbidSet.has(id)) {
      push(
        issues,
        "CONTRADICTORY_MECHANISM",
        `mechanisms: '${id}' is in both requires and forbids — a mechanism cannot be required AND forbidden.`,
        "mechanisms",
      );
    }
  }
}

export function validatePlatformerProfile(input: unknown): ProfileValidationResult {
  const issues: ProfileValidationIssue[] = [];

  if (!isRecord(input)) {
    push(issues, "INVALID_DOCUMENT", "Profile must be an object.", "profile");
    return { valid: false, issues };
  }

  if (input.schemaVersion !== PLATFORMER_PROFILE_SCHEMA_VERSION) {
    push(
      issues,
      "INVALID_SCHEMA_VERSION",
      `schemaVersion must be '${PLATFORMER_PROFILE_SCHEMA_VERSION}'.`,
      "schemaVersion",
    );
  }

  // id — must be present AND well-formed (malformed id is a refusal).
  if (!isString(input.id)) {
    push(issues, "MISSING_FIELD", "id is required.", "id");
  } else if (!PROFILE_ID_PATTERN.test(input.id)) {
    push(
      issues,
      "INVALID_PROFILE_ID",
      `id '${input.id}' must match ${PROFILE_ID_PATTERN} (lowercase kebab, starts with a letter).`,
      "id",
    );
  }

  if (!isString(input.title)) {
    push(issues, "MISSING_FIELD", "title is required.", "title");
  }
  if (!isString(input.summary)) {
    push(issues, "MISSING_FIELD", "summary is required.", "summary");
  }
  if (input.exemplars !== undefined) {
    if (!Array.isArray(input.exemplars) || !input.exemplars.every((e) => isString(e))) {
      push(issues, "INVALID_FIELD", "exemplars must be an array of strings.", "exemplars");
    }
  }

  // metrics — must be a non-empty object of measurable target bands.
  if (!isRecord(input.metrics)) {
    push(issues, "NO_METRICS", "metrics must be an object.", "metrics");
  } else {
    const ids = Object.keys(input.metrics);
    if (ids.length === 0) {
      push(
        issues,
        "NO_METRICS",
        "metrics must define at least one measurable target band.",
        "metrics",
      );
    }
    for (const id of ids) {
      validateMetricTarget(id, input.metrics[id], issues);
    }
  }

  // F2 — optional build block (refuse-don't-skip if present).
  validateBuildBlock(
    input.build,
    isRecord(input.metrics) ? input.metrics : undefined,
    issues,
  );

  // F3 — optional mechanisms block (refuse-don't-skip if present).
  validateMechanismsBlock(input.mechanisms, issues);

  return { valid: issues.length === 0, issues };
}

/** Throwing variant for load-time use — summarises every issue. */
export function assertValidPlatformerProfile(input: unknown): PlatformerFeelProfile {
  const result = validatePlatformerProfile(input);
  if (!result.valid) {
    const summary = result.issues
      .map((i) => `  - [${i.code}] ${i.path}: ${i.message}`)
      .join("\n");
    throw new Error(`Platformer profile validation failed:\n${summary}`);
  }
  return input as PlatformerFeelProfile;
}
