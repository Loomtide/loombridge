/**
 * Feel measurements file: the genre-neutral on-disk shape (extracted from the
 * platformer-2d pack for the feel-snapshot flow; the pack re-exports it with its
 * own narrower `mechanismEvidence` typing).
 *
 * A measurements file carries the behaviorally-measured feel values a grader
 * (profile bands, or a frozen snapshot baseline) compares against. Values are
 * OPTIONAL by design: absent metrics are reported honestly as "not measured",
 * never invented and never green.
 *
 * Two on-disk shapes are accepted so the existing flat `feel.json` (the shape
 * the feel gate already consumes) and a `{ metrics: {...} }` file both drop in:
 *
 *   { "metrics": { "runSpeed": 9.1, "jumpApex": 3.0 }, "provenance": {...} }
 *   { "runSpeed": 9.1, "jumpApex": 3.0, "provenance": {...} }   // flat feel.json
 *
 * Only finite-number values are taken as metrics; non-numeric keys (e.g.
 * `provenance`) are ignored. Metric ids are OPAQUE STRINGS here: this module
 * lives in core (genre-core LITMUS scope), so it never judges the vocabulary.
 */

import fs from "node:fs/promises";

import type { FeelProvenance } from "../verification/gates/feel.js";
import type { FeelCaptureCoverageEntry } from "./types.js";

export interface FeelMeasurementsFile {
  /** Measured value per (opaque) metric id. */
  metrics: Record<string, number>;
  /** Optional measurement evidence (§0 re-derivation reads `sources`). */
  provenance?: FeelProvenance;
  /**
   * Optional captured behavioral evidence for a pack's mechanism gate. Core
   * carries it as an opaque record (the vocabulary belongs to the pack); the
   * pack's interpreters validate each capture.
   */
  mechanismEvidence?: Record<string, unknown>;
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
export function parseMeasurements(input: unknown): FeelMeasurementsFile {
  if (!isRecord(input)) {
    throw new Error("measurements file must be a JSON object.");
  }
  const provenance =
    isRecord(input.provenance) ? (input.provenance as FeelProvenance) : undefined;
  // Mechanism evidence is passed through as-shaped; the pack's gate interpreters
  // validate each capture (an unusable one becomes `unprobed`, never a presence).
  const mechanismEvidence = isRecord(input.mechanismEvidence)
    ? input.mechanismEvidence
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
export async function loadMeasurements(filePath: string): Promise<FeelMeasurementsFile> {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseMeasurements(JSON.parse(raw));
}
