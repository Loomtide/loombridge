/**
 * `inputToSfxLatency` gate (SFX dogfood backlog High #7 "Sync").
 *
 * Measures the latency from a driving input onset to the resulting SfxPlayer cue edge,
 * derived from a pairing capture (`sfx-latency.json`, `SfxLatencyCapture`), with an
 * OPTIONAL cross-read of the sfx-runtime probe snapshot for fabrication detection.
 *
 * Harness-fault ≠ game-defect (CLAUDE.md): a MISSING pairing is `blocked`/`incomplete`,
 * NEVER a pass. Integrity rules (review D4):
 *  - zero pairs / no capture → WARN (blocked — latency you did not measure cannot pass).
 *  - fewer than `MIN_LATENCY_PAIRS` (3) valid pairs → WARN ("insufficient pairs —
 *    latency unverified"), never a graded pass: a single sample cannot certify a band.
 *  - a pair missing a bound field, or with `cueTimeMs < inputTimeMs` (the cue "fired
 *    before" the input) → FAIL (an impossible pairing is a defect, refused not skipped).
 *  - a pair latency below `IMPLAUSIBLE_LATENCY_FLOOR_MS` (8ms — sub-half-frame at
 *    60 Hz; includes exactly 0) → FAIL "implausibly low — clock pairing suspect"
 *    (mirrors the hitscan 16.67ms-floor reasoning: real input→audio paths cross at
 *    least a frame boundary plus DSP scheduling; a 0ms edge means the two timestamps
 *    were sampled from the same clock read, not a real pairing).
 *  - probe cross-check: when the same run's probe snapshot is available, the number
 *    of pairs must be ≤ the cue's `perCue` fire count — more pairings than recorded
 *    fires is a fabricated capture → FAIL.
 *  - a declared band (`verification.sfx.inputToSfxLatencyMs`) → PASS/FAIL on the median.
 *  - measured but NO band declared → WARN (measured value reported, but nothing to
 *    certify it against — incomplete, not a silent pass).
 *
 * Pure function — unit-testable from a synthetic capture + optional band, no live editor.
 */

import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import type { NumericTarget } from "../types.js";
import type { CueMapSchema } from "../../loomtide/sfx/cue-map.js";
import type { SfxLatencyCapture } from "../../loomtide/sfx/capture-shapes.js";
import { validateSfxProbeSnapshot } from "../../loomtide/sfx/probe-contract.js";
import { bandWindow, withinBand } from "./feel.js";

export const GATE_NAME = "inputToSfxLatency";

/** Minimum valid pairs before the median is graded; fewer = WARN unverified (D4). */
export const MIN_LATENCY_PAIRS = 3;

/**
 * Latencies below this are refused as physically implausible (D4): sub-half-frame at
 * 60 Hz. A real input→audio edge crosses at least a frame boundary + DSP scheduling;
 * 0ms means both timestamps came from the same clock read (pairing bug), not physics.
 */
export const IMPLAUSIBLE_LATENCY_FLOOR_MS = 8;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Median of a non-empty numeric array (mean of the two middle values when even). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluateInputToSfxLatency(
  capture: SfxLatencyCapture,
  cueMap: CueMapSchema,
  band?: NumericTarget,
  /**
   * Optional cross-read of the same run's probe snapshot (`sfx-probe.json`): pairs
   * count must be ≤ the cue's recorded fire count (D4 anti-fabrication). An invalid
   * probe is ignored here (its own validation failures are `sfx-runtime`'s verdict).
   */
  probeRaw?: unknown,
): GateReport {
  // D3 shape guard: wrong-shape capture = graceful FAIL, never a thrown abort.
  if (!isObject(capture)) {
    return makeGateReport(GATE_NAME, [
      {
        id: "inputToSfxLatency.capture",
        expected: "sfx-latency.json object with `cueId` + `pairs`",
        actual: "(malformed)",
        status: "fail",
        detail:
          "sfx-latency.json is present but malformed (not an object) — a present-but-unreadable capture is a defect, refused (never weaker than a missing one).",
      },
    ]);
  }

  const checks: GateCheck[] = [];
  const cueIds = new Set(cueMap.cues.map((c) => c.id));

  if (typeof capture.cueId !== "string" || capture.cueId.length === 0) {
    checks.push({
      id: "inputToSfxLatency.cue",
      expected: "capture names the cue it measures",
      actual: "(absent)",
      status: "fail",
      detail: "sfx-latency.json has no `cueId` — cannot attribute the latency to a cue (refusing).",
    });
    return makeGateReport(GATE_NAME, checks);
  }
  if (!cueIds.has(capture.cueId)) {
    checks.push({
      id: "inputToSfxLatency.cue",
      expected: "cueId is a declared cue",
      actual: `unknown cue \`${capture.cueId}\``,
      status: "warn",
      detail: `Latency capture names cue \`${capture.cueId}\` which is not in the cue map (drift).`,
    });
  }

  const pairs = Array.isArray(capture.pairs) ? capture.pairs : [];
  if (pairs.length === 0) {
    checks.push({
      id: "inputToSfxLatency.pairs",
      expected: "≥1 input-onset / cue-edge pair",
      actual: "(none)",
      status: "warn",
      detail: `No input→cue pairs captured for \`${capture.cueId}\` — BLOCKED/incomplete, not a pass (latency was not measured).`,
    });
    return makeGateReport(GATE_NAME, checks);
  }

  // D4 anti-fabrication: with a valid probe snapshot from the same run, there can
  // never be MORE latency pairings than the cue actually fired.
  if (probeRaw !== undefined) {
    const parsed = validateSfxProbeSnapshot(probeRaw);
    if (parsed.ok && parsed.snapshot) {
      const fires = parsed.snapshot.perCue[capture.cueId] ?? 0;
      if (pairs.length > fires) {
        checks.push({
          id: "inputToSfxLatency.fabrication",
          expected: `pairs ≤ probe perCue fire count (${fires})`,
          actual: `${pairs.length} pairs`,
          status: "fail",
          detail: `Latency capture has ${pairs.length} input→cue pairs but the probe snapshot recorded only ${fires} fire(s) of \`${capture.cueId}\` — more pairings than fires is a fabricated capture (refusing).`,
        });
        return makeGateReport(GATE_NAME, checks);
      }
    }
  }

  const latencies: number[] = [];
  let refused = false;
  pairs.forEach((p, i) => {
    if (!isObject(p) || !isFiniteNumber(p.inputTimeMs) || !isFiniteNumber(p.cueTimeMs)) {
      checks.push({
        id: `inputToSfxLatency.pair.${i}`,
        expected: "finite inputTimeMs + cueTimeMs",
        actual: `inputTimeMs=${String((p as unknown as Record<string, unknown>)?.inputTimeMs)}, cueTimeMs=${String((p as unknown as Record<string, unknown>)?.cueTimeMs)}`,
        status: "fail",
        detail: `Pair ${i} is missing a bound timestamp — refusing (an absent field is a defect, not a skip).`,
      });
      refused = true;
      return;
    }
    const latency = p.cueTimeMs - p.inputTimeMs;
    if (latency < 0) {
      checks.push({
        id: `inputToSfxLatency.pair.${i}`,
        expected: "cueTimeMs >= inputTimeMs",
        actual: `${latency}ms`,
        status: "fail",
        detail: `Pair ${i}: the cue edge (${p.cueTimeMs}ms) precedes the input (${p.inputTimeMs}ms) — an impossible pairing (refused).`,
      });
      refused = true;
      return;
    }
    if (latency < IMPLAUSIBLE_LATENCY_FLOOR_MS) {
      checks.push({
        id: `inputToSfxLatency.pair.${i}`,
        expected: `latency ≥ ${IMPLAUSIBLE_LATENCY_FLOOR_MS}ms (sub-half-frame is not a real input→audio path)`,
        actual: `${latency}ms`,
        status: "fail",
        detail: `Pair ${i}: latency ${latency}ms is implausibly low — clock pairing suspect (a 0/near-0 edge means both timestamps came from the same clock read, not a real input→audio pairing; refused).`,
      });
      refused = true;
      return;
    }
    latencies.push(latency);
  });

  if (refused || latencies.length === 0) {
    return makeGateReport(GATE_NAME, checks);
  }

  // D4 minimum sample size: too few pairs cannot certify a band — WARN, not a pass.
  if (latencies.length < MIN_LATENCY_PAIRS) {
    checks.push({
      id: "inputToSfxLatency.pairs",
      expected: `≥${MIN_LATENCY_PAIRS} valid input-onset / cue-edge pairs`,
      actual: `${latencies.length}`,
      status: "warn",
      detail: `Only ${latencies.length} valid pair(s) captured for \`${capture.cueId}\` — insufficient pairs, latency unverified (a band verdict needs ≥${MIN_LATENCY_PAIRS} samples).`,
    });
    return makeGateReport(GATE_NAME, checks);
  }

  const med = median(latencies);
  if (!band) {
    checks.push({
      id: "inputToSfxLatency.value",
      expected: "verification.sfx.inputToSfxLatencyMs band declared",
      actual: `${med.toFixed(2)}ms (median of ${latencies.length})`,
      status: "warn",
      detail: `Measured median input→SFX latency ${med.toFixed(2)}ms for \`${capture.cueId}\`, but no band is declared to grade it — incomplete, not a pass.`,
    });
    return makeGateReport(GATE_NAME, checks);
  }

  const { lo, hi, label } = bandWindow(band);
  const ok = withinBand(med, band);
  checks.push({
    id: "inputToSfxLatency.value",
    expected: `${band.target}${band.unit} (${label}) → [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
    actual: `${med.toFixed(2)}ms (median of ${latencies.length})`,
    status: ok ? "pass" : "fail",
    detail: ok
      ? `Median input→SFX latency ${med.toFixed(2)}ms for \`${capture.cueId}\` is within band.`
      : `Median input→SFX latency ${med.toFixed(2)}ms for \`${capture.cueId}\` is OUT of band [${lo.toFixed(2)}, ${hi.toFixed(2)}].`,
  });
  return makeGateReport(GATE_NAME, checks);
}
