/**
 * Manifest / presence gate (§3.1).
 *
 * INPUT: the `scene.verify_manifest` op output —
 *   `{ missing: [...], placeholders: [...], extras: [...], all_ok: bool }`.
 *   (The op itself does the name/regex matching against the scene using
 *   `acceptance.manifest`; this gate evaluates its verdict.)
 * ACCEPTANCE: the `manifest` section (only `extrasAreFailure` is consulted here;
 *   the matching rules are applied inside the op).
 *
 * CHECKS:
 *  - missing: no required element missing -> FAIL if any.
 *  - placeholders: no placeholder sprites -> FAIL if any.
 *  - extras: unexpected objects -> WARN by default, FAIL if
 *    `manifest.extrasAreFailure` is true.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** One manifest finding entry. May be a bare string or an object with a name. */
export type ManifestEntry = string | { name?: string; reason?: string; [k: string]: unknown };

/** The `scene.verify_manifest` op output shape. */
export interface VerifyManifestResult {
  missing?: ManifestEntry[];
  placeholders?: ManifestEntry[];
  extras?: ManifestEntry[];
  all_ok?: boolean;
}

export const GATE_NAME = "manifest";

function describe(entries: ManifestEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "none";
  return entries
    .map((e) => (typeof e === "string" ? e : (e.name ?? JSON.stringify(e))))
    .join(", ");
}

export function evaluateManifest(
  result: VerifyManifestResult,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];
  const missing = result.missing ?? [];
  const placeholders = result.placeholders ?? [];
  const extras = result.extras ?? [];

  // ---- missing required ----
  checks.push({
    id: "manifest.missing",
    expected: "no missing required elements",
    actual: `${missing.length} missing`,
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? "All required manifest elements present."
        : `Missing required: ${describe(missing)}.`,
  });

  // ---- placeholders ----
  checks.push({
    id: "manifest.placeholders",
    expected: "no placeholder assets",
    actual: `${placeholders.length} placeholder(s)`,
    status: placeholders.length === 0 ? "pass" : "fail",
    detail:
      placeholders.length === 0
        ? "No placeholder assets in the scene."
        : `Placeholder assets present: ${describe(placeholders)}.`,
  });

  // ---- extras (warn by default) ----
  const extrasFail = acceptance.manifest.extrasAreFailure === true;
  checks.push({
    id: "manifest.extras",
    expected: extrasFail ? "no unexpected objects" : "unexpected objects allowed (warn)",
    actual: `${extras.length} extra(s)`,
    status: extras.length === 0 ? "pass" : extrasFail ? "fail" : "warn",
    detail:
      extras.length === 0
        ? "No unexpected objects."
        : `Unexpected objects: ${describe(extras)}${extrasFail ? " (extrasAreFailure)." : " (warn)."}`,
  });

  return makeGateReport(GATE_NAME, checks);
}
