/**
 * Profile measurements input (S5b).
 *
 * A measurements file carries the behaviorally-measured feel values that
 * `loombridge verify --profile` compares against a profile's bands. It is the
 * input the S5c harness will produce; for S5b it is OPTIONAL — absent values are
 * reported honestly as "not measured", never invented and never green.
 *
 * Two on-disk shapes are accepted so the existing `feel.json` (the flat
 * `FeelMeasurements` shape the feel gate already consumes) and a hand-authored or
 * S5c-emitted `{ metrics: {...} }` file both drop in:
 *
 *   { "metrics": { "runSpeed": 9.1, "jumpApex": 3.0 }, "provenance": {...} }
 *   { "runSpeed": 9.1, "jumpApex": 3.0, "provenance": {...} }   // flat feel.json
 *
 * Only finite-number values are taken as metrics; non-numeric keys (e.g.
 * `provenance`) are ignored. Unknown metric ids are kept here but only profile
 * metrics are compared downstream — this loader does not judge the vocabulary.
 */

import fs from "node:fs/promises";

import type { FeelProvenance } from "../../../verification/gates/feel.js";
import type { FeelCaptureCoverageEntry } from "../../feel-capture/types.js";
import type { MechanismEvidence } from "./mechanisms.js";

export interface ProfileMeasurements {
  /** Measured value per metric id. */
  metrics: Record<string, number>;
  /** Optional measurement evidence (surfaced in the report; not enforced in S5b). */
  provenance?: FeelProvenance;
  /**
   * F3 — optional captured behavioral evidence for the `mechanisms` gate (per-
   * mechanism trajectories / bisection trials). Carried alongside `metrics` so the
   * SAME measurements file the live harness emits drives both the band grade and the
   * mechanism-presence check. Absent → the gate refuses any claimed mechanism (it is
   * NOT skipped). Passed through untyped-but-shaped; the gate's interpreters validate
   * each capture (an unusable one is `unprobed`, never a fabricated presence).
   */
  mechanismEvidence?: MechanismEvidence;
  /** Generic capture-attempt coverage: measured / blocked / unsupported reasons. */
  captureCoverage?: FeelCaptureCoverageEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reserved top-level keys that are never metrics in the flat shape. */
const RESERVED_KEYS = new Set(["provenance", "metrics", "mechanismEvidence", "captureCoverage"]);

/** Pull every finite-number-valued key out of a record into a metrics map. */
function numericKeys(
  source: Record<string, unknown>,
  exclude: ReadonlySet<string> = new Set(),
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (exclude.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Parse a measurements document. Accepts the nested `{ metrics }` shape or a flat
 * `feel.json` shape. Throws only on non-object input or unreadable/invalid JSON.
 */
export function parseMeasurements(input: unknown): ProfileMeasurements {
  if (!isRecord(input)) {
    throw new Error("measurements file must be a JSON object.");
  }
  const provenance =
    isRecord(input.provenance) ? (input.provenance as FeelProvenance) : undefined;
  // F3 mechanism evidence is passed through as-shaped; the gate interpreters
  // validate each capture (an unusable one becomes `unprobed`, never a presence).
  const mechanismEvidence = isRecord(input.mechanismEvidence)
    ? (input.mechanismEvidence as MechanismEvidence)
    : undefined;
  const captureCoverage = Array.isArray(input.captureCoverage)
    ? (input.captureCoverage as FeelCaptureCoverageEntry[])
    : undefined;

  if (input.metrics !== undefined) {
    // Nested shape: `metrics` must be an object if present — a non-object is a
    // malformed file, not a cue to fall back to the flat shape.
    if (!isRecord(input.metrics)) {
      throw new Error("measurements.metrics must be an object when present.");
    }
    return { metrics: numericKeys(input.metrics), provenance, mechanismEvidence, captureCoverage };
  }
  // Flat feel.json shape: top-level finite-number keys are metrics, minus the
  // reserved keys (so a stray `provenance`/`metrics` number is never a metric).
  return { metrics: numericKeys(input, RESERVED_KEYS), provenance, mechanismEvidence, captureCoverage };
}

/** Read + parse a measurements file from disk. */
export async function loadMeasurements(filePath: string): Promise<ProfileMeasurements> {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseMeasurements(JSON.parse(raw));
}
