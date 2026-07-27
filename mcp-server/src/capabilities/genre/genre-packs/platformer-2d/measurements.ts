/**
 * Profile measurements input (S5b): the platformer-2d view over the
 * genre-neutral measurements module in core (`capabilities/feel/measurements`).
 *
 * The parsing and on-disk shapes live in core (the feel-snapshot flow reads the
 * same files without any pack vocabulary); this shim re-narrows
 * `mechanismEvidence` to the pack's `MechanismEvidence` so the F3 mechanism gate
 * keeps its typed view. Pack-imports-core is the allowed layering direction.
 */

import {
  loadMeasurements as loadMeasurementsCore,
  parseMeasurements as parseMeasurementsCore,
  type FeelMeasurementsFile,
} from "../../../feel/measurements.js";
import type { MechanismEvidence } from "./mechanisms.js";

export interface ProfileMeasurements extends Omit<FeelMeasurementsFile, "mechanismEvidence"> {
  /**
   * F3: optional captured behavioral evidence for the `mechanisms` gate. Absent
   * means the gate refuses any claimed mechanism (it is NOT skipped). The gate's
   * interpreters validate each capture (an unusable one is `unprobed`, never a
   * fabricated presence).
   */
  mechanismEvidence?: MechanismEvidence;
}

/** Parse a measurements document (nested `{ metrics }` or flat feel.json shape). */
export function parseMeasurements(input: unknown): ProfileMeasurements {
  return parseMeasurementsCore(input) as ProfileMeasurements;
}

/** Read + parse a measurements file from disk. */
export async function loadMeasurements(filePath: string): Promise<ProfileMeasurements> {
  return (await loadMeasurementsCore(filePath)) as ProfileMeasurements;
}
