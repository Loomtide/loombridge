/**
 * `sfx-runtime` gate (SFX dogfood backlog High #7 "Runtime").
 *
 * Expected cues actually FIRED during the drive scenario. Consumes a probe snapshot
 * (`sfx-probe.json`, `SfxProbeSnapshot`) captured from the SfxPlayer counters.
 *
 * Honesty rules (CLAUDE.md):
 *  - The snapshot is validated FIRST (`validateSfxProbeSnapshot`); a stale / internally
 *    inconsistent snapshot is a FAILURE, not silently-graded runtime data.
 *  - Every required cue must have `perCue[cue] > 0` UNLESS the cue is declared
 *    scenario-exempt. An exempt cue is reported `not_applicable` WITH a note — never
 *    silently skipped (the "scenario-exempt cues declared, not silently skipped" rule).
 *  - A required, non-exempt cue with count 0 / absent is a FAILURE — assuming silence
 *    means success is exactly the false-green this gate exists to prevent.
 *
 * Pure function — unit-testable from a synthetic snapshot + cue map, no live editor.
 */

import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import type { CueMapSchema } from "../../sfx/cue-map.js";
import { validateSfxProbeSnapshot } from "../../sfx/probe-contract.js";

export const GATE_NAME = "sfx-runtime";

export function evaluateSfxRuntime(
  probeRaw: unknown,
  cueMap: CueMapSchema,
  scenarioExemptCues: readonly string[] = [],
): GateReport {
  const parsed = validateSfxProbeSnapshot(probeRaw);
  if (!parsed.ok || !parsed.snapshot) {
    // A malformed / inconsistent snapshot is not trustworthy runtime evidence.
    return makeGateReport(
      GATE_NAME,
      parsed.refusals.map((r, i) => ({
        id: `sfx-runtime.snapshot.${i}`,
        expected: "a consistent probe snapshot",
        actual: "(refused)",
        status: "fail" as const,
        detail: r,
      })),
    );
  }

  const snapshot = parsed.snapshot;
  const exempt = new Set(scenarioExemptCues);
  const cueIds = new Set(cueMap.cues.map((c) => c.id));
  const checks: GateCheck[] = [];

  for (const cue of cueMap.cues) {
    if (cue.required !== true) continue;
    const count = snapshot.perCue[cue.id] ?? 0;
    if (exempt.has(cue.id)) {
      checks.push({
        id: `sfx-runtime.${cue.id}`,
        expected: "required cue fires (or is declared scenario-exempt)",
        actual: `scenario-exempt (count=${count})`,
        status: "not_applicable",
        detail: `Required cue \`${cue.id}\` is declared scenario-exempt; the drive scenario does not exercise it (explicitly declared, not silently skipped).`,
      });
      continue;
    }
    checks.push({
      id: `sfx-runtime.${cue.id}`,
      expected: "perCue count > 0",
      actual: String(count),
      status: count > 0 ? "pass" : "fail",
      detail:
        count > 0
          ? `Required cue \`${cue.id}\` fired ${count}× during the drive.`
          : `Required cue \`${cue.id}\` did NOT fire during the drive (count 0) — refusing (silence is not success).`,
    });
  }

  // An exemption naming a cue the map does not declare is drift — surface it.
  for (const id of exempt) {
    if (!cueIds.has(id)) {
      checks.push({
        id: `sfx-runtime.exempt.${id}`,
        expected: "scenario-exempt cue is a declared cue",
        actual: `unknown cue \`${id}\``,
        status: "warn",
        detail: `scenarioExemptCues names \`${id}\` which is not in the cue map (drift).`,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      id: "sfx-runtime.data",
      expected: "≥1 required cue in the cue map",
      actual: "(none required)",
      status: "warn",
      detail: "Cue map declares no required cues; runtime firing was not evaluated.",
    });
  }
  return makeGateReport(GATE_NAME, checks);
}
