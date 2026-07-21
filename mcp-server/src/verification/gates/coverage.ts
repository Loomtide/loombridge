/**
 * Coverage gate (TRAJECTORY + CONTINUITY).
 *
 * WHY: a single post-drift frame is NOT enough. A clean-room parallax bug is
 * TIME-VARYING: the backdrop drifts smoothly then SNAPS several world units (a
 * teleport) once per cycle, exposing a gap on one edge only PART of the cycle.
 * A single sampled frame lands "covered" most of the time and "exposed" only a
 * fraction of it — so a one-frame gate would MISS the bug by luck. This gate
 * instead checks the layer's bounds SAMPLED ACROSS A FULL DRIFT CYCLE, and
 * catches both failure shapes:
 *
 *   1. COVERAGE  — at EVERY sample the backdrop must fully cover its frame.
 *   2. CONTINUITY — the layer's center must move SMOOTHLY between samples; a
 *      large jump is a teleport (the snap) and is itself a failure even if no
 *      single sampled frame happens to be exposed.
 *
 * INPUT — two forms (single-frame is kept for back-compat):
 *
 *   {
 *     cameraFrame: { minX, maxX, minY, maxY },   // default frame
 *     layers: [
 *       // (A) trajectory form (PREFERRED): bounds sampled over a full cycle.
 *       {
 *         name,
 *         samples: [
 *           { tMs, minX, maxX, minY, maxY, cameraFrame? },  // per-sample frame
 *           ...                                              // override allows
 *         ]                                                  // camera-follow
 *       },
 *       // (B) single-frame form (BACK-COMPAT): the layer's bounds directly.
 *       { name, minX, maxX, minY, maxY }
 *     ],
 *     atSeconds?,     // single-frame note (when the one capture was taken)
 *     cycleSeconds?,  // trajectory note (length of the sampled drift cycle)
 *   }
 *
 * ACCEPTANCE: `juice.parallax.layers` — the layers flagged `coversFrame: true`
 * are the FULL-SCREEN backdrops that MUST always cover the camera frame.
 * `juice.parallax.continuityThresholdU` (optional) sets the max allowed
 * per-step center excursion; if omitted the gate defaults to `frameWidth * 0.1`
 * where `frameWidth = cameraFrame.maxX - cameraFrame.minX`.
 *
 * CHECKS: one per required (coversFrame) layer.
 *  - TRAJECTORY (the layer has `samples`):
 *      • COVERAGE: assert EVERY sample's bounds cover its frame
 *        (sample.cameraFrame ?? input.cameraFrame). FAIL at the FIRST exposed
 *        sample, naming its tMs + the exposed side(s).
 *      • CONTINUITY: per-sample centerX = (minX+maxX)/2; for consecutive
 *        samples assert |Δcenter| ≤ continuityThreshold. A larger jump is a
 *        teleport → FAIL naming the tMs + the Δ.
 *      • Both pass → PASS (covers across the full N-sample cycle, continuous).
 *  - SINGLE-FRAME (back-compat, no `samples`): the old behaviour — assert the
 *    layer's minX/maxX/minY/maxY cover the camera frame; PASS/FAIL as before,
 *    plus an informational note that continuity was NOT checked (no trajectory)
 *    recommending a trajectory capture.
 *  - A coversFrame layer absent from `input.layers` → WARN ("not captured").
 *  - No coversFrame layer declared at all → a single WARN.
 *
 * BOTTOM-COVERAGE (separate, OPT-IN per layer via `coversBottom: true`):
 *  - A `coversBottom` layer is a backdrop that need NOT reach the top or the
 *    sides, but whose cropped BOTTOM edge must never show in-frame: its `minY`
 *    must sit at/below the viewport floor at EVERY sample. This catches a
 *    silhouette layer (e.g. Hills) whose bottom crop hangs above the pit floor,
 *    exposing a band of camera background. A layer already flagged `coversFrame`
 *    is skipped (full coverage subsumes the bottom check). FAIL (id
 *    `coverage.<name>.bottom`) at the FIRST sample where `minY > frame.minY`;
 *    PASS when it reaches the floor at every sample. Absent layer → WARN.
 *
 * Mirrors the doc-comment + GateCheck style of `framing.ts` / `reachability.ts`.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** A camera frame / layer bounds rectangle in world units. */
export interface CoverageRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** One trajectory sample: the layer's bounds at time `tMs` (+ optional frame). */
export interface CoverageSample extends CoverageRect {
  /** Milliseconds into the drift cycle this sample was captured. */
  tMs: number;
  /** Per-sample camera frame (camera-follow); falls back to input.cameraFrame. */
  cameraFrame?: CoverageRect;
}

/**
 * A captured parallax layer. Provide EITHER a trajectory (`samples`, preferred)
 * OR a single post-drift bounds rectangle (back-compat).
 */
export interface CoverageLayer extends Partial<CoverageRect> {
  name: string;
  /** Trajectory: the layer's bounds sampled across a full drift cycle. */
  samples?: CoverageSample[];
}

/** The `scene.get_bounds`-derived coverage capture. */
export interface CoverageInput {
  /** Default camera frame; a sample may override via `sample.cameraFrame`. */
  cameraFrame: CoverageRect;
  layers: CoverageLayer[];
  /** Seconds into the play soak a SINGLE-FRAME capture was taken (post-drift). */
  atSeconds?: number;
  /** Length of the sampled drift cycle, for the TRAJECTORY note. */
  cycleSeconds?: number;
}

export const GATE_NAME = "coverage";

const EPS = 1e-9;

/** Exposed-side messages where `rect` fails to cover `frame`. Empty = covered. */
function exposedSides(rect: CoverageRect, frame: CoverageRect, label: string): string[] {
  const exposed: string[] = [];
  if (rect.minX > frame.minX + EPS) {
    exposed.push(`left edge: ${label} minX ${rect.minX} > frame minX ${frame.minX}`);
  }
  if (rect.maxX < frame.maxX - EPS) {
    exposed.push(`right edge: ${label} maxX ${rect.maxX} < frame maxX ${frame.maxX}`);
  }
  if (rect.minY > frame.minY + EPS) {
    exposed.push(`bottom edge: ${label} minY ${rect.minY} > frame minY ${frame.minY}`);
  }
  if (rect.maxY < frame.maxY - EPS) {
    exposed.push(`top edge: ${label} maxY ${rect.maxY} < frame maxY ${frame.maxY}`);
  }
  return exposed;
}

/** TRAJECTORY check for one required layer: coverage at every sample + continuity. */
function evaluateTrajectory(
  layerName: string,
  samples: CoverageSample[],
  input: CoverageInput,
  continuityThreshold: number,
): GateCheck {
  const id = `coverage.${layerName}`;
  const n = samples.length;
  const cycleNote =
    input.cycleSeconds !== undefined
      ? ` over a ${input.cycleSeconds}s cycle`
      : "";

  // ---- COVERAGE: fail at the FIRST exposed sample ----
  for (const s of samples) {
    const frame = s.cameraFrame ?? input.cameraFrame;
    const exposed = exposedSides(s, frame, layerName);
    if (exposed.length > 0) {
      return {
        id,
        expected: "covers the camera frame at every trajectory sample",
        actual: `exposed at tMs=${s.tMs}`,
        status: "fail",
        detail: `Backdrop layer "${layerName}" no longer covers the camera frame — exposed at tMs=${s.tMs}: ${exposed.join("; ")}. The parallax drift leaves a gap exposing the camera background during the cycle.`,
      };
    }
  }

  // ---- CONTINUITY: fail at the FIRST teleport (Δcenter beyond threshold) ----
  let maxExcursion = 0;
  for (let i = 1; i < n; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const prevCenter = (prev.minX + prev.maxX) / 2;
    const curCenter = (cur.minX + cur.maxX) / 2;
    const delta = Math.abs(curCenter - prevCenter);
    maxExcursion = Math.max(maxExcursion, delta);
    if (delta > continuityThreshold + EPS) {
      return {
        id,
        expected: `continuous drift (|Δcenter| ≤ ${continuityThreshold.toFixed(2)}u per step)`,
        actual: `Δ ${delta.toFixed(2)}u at tMs=${cur.tMs}`,
        status: "fail",
        detail: `discontinuity at tMs=${cur.tMs}: backdrop "${layerName}" teleported ${delta.toFixed(2)}u (> ${continuityThreshold.toFixed(2)}u allowed). A snap of this size tears the parallax even if no single sampled frame is exposed.`,
      };
    }
  }

  // ---- both passed ----
  return {
    id,
    expected: "covers the camera frame at every sample + continuous drift",
    actual: `${n} samples covered, max excursion ${maxExcursion.toFixed(2)}u`,
    status: "pass",
    detail: `Backdrop layer "${layerName}" covers the frame across the full ${n}-sample cycle${cycleNote}; max center excursion ${maxExcursion.toFixed(2)}u (≤ ${continuityThreshold.toFixed(2)}u), continuous.`,
  };
}

/** SINGLE-FRAME (back-compat) check for one required layer. */
function evaluateSingleFrame(
  layerName: string,
  layer: CoverageLayer,
  input: CoverageInput,
): GateCheck {
  const id = `coverage.${layerName}`;
  const atSeconds = input.atSeconds;
  const whenNote =
    atSeconds !== undefined ? ` (post-drift capture at t=${atSeconds}s)` : "";
  const noTrajectoryNote =
    " NOTE: continuity was NOT checked (no trajectory) — capture bounds sampled across a full drift cycle (layer.samples) so the gate can also catch a parallax teleport/snap.";

  const rect: CoverageRect = {
    minX: layer.minX ?? Number.POSITIVE_INFINITY,
    maxX: layer.maxX ?? Number.NEGATIVE_INFINITY,
    minY: layer.minY ?? Number.POSITIVE_INFINITY,
    maxY: layer.maxY ?? Number.NEGATIVE_INFINITY,
  };
  const exposed = exposedSides(rect, input.cameraFrame, layerName);

  if (exposed.length === 0) {
    return {
      id,
      expected: "fully covers the camera frame",
      actual: "fully covers",
      status: "pass",
      detail: `Backdrop layer "${layerName}" still fully covers the camera frame${whenNote}.${noTrajectoryNote}`,
    };
  }
  return {
    id,
    expected: "fully covers the camera frame",
    actual: `exposes ${exposed.length} side(s)`,
    status: "fail",
    detail: `Backdrop layer "${layerName}" no longer covers the camera frame${whenNote}: ${exposed.join("; ")}. The parallax drift left a gap exposing the camera background.${noTrajectoryNote}`,
  };
}

/**
 * BOTTOM-COVERAGE check for one `coversBottom` layer: its bottom edge (`minY`)
 * must sit at/below the viewport floor (`frame.minY`) at EVERY sample. Works on
 * a trajectory (each sample's own frame) OR a single-frame capture.
 */
function evaluateBottomCoverage(
  layerName: string,
  layer: CoverageLayer,
  input: CoverageInput,
): GateCheck {
  const id = `coverage.${layerName}.bottom`;
  const expected = "extends to/below the viewport floor (layer minY ≤ frame minY) so its bottom edge is never exposed";

  // Collect (layerMinY, frame, tMs?) probes from trajectory or single-frame.
  const probes: Array<{ minY: number; frameMinY: number; tMs?: number }> =
    layer.samples && layer.samples.length > 0
      ? layer.samples.map((s) => ({
          minY: s.minY,
          frameMinY: (s.cameraFrame ?? input.cameraFrame).minY,
          tMs: s.tMs,
        }))
      : [
          {
            minY: layer.minY ?? Number.POSITIVE_INFINITY,
            frameMinY: input.cameraFrame.minY,
          },
        ];

  for (const p of probes) {
    if (p.minY > p.frameMinY + EPS) {
      const at = p.tMs !== undefined ? ` at tMs=${p.tMs}` : "";
      return {
        id,
        expected,
        actual: `${layerName} minY ${p.minY} > frame minY ${p.frameMinY} (bottom crop exposed)`,
        status: "fail",
        detail: `Backdrop layer "${layerName}" stops at minY ${p.minY}, above the viewport floor minY ${p.frameMinY}${at} — its cropped bottom edge shows a band of camera background in the pit. Extend it down past the frame floor.`,
      };
    }
  }

  const maxBottom = Math.max(...probes.map((p) => p.minY));
  const floor = probes[0]?.frameMinY ?? input.cameraFrame.minY;
  return {
    id,
    expected,
    actual: `${layerName} minY ${maxBottom} ≤ frame minY ${floor}`,
    status: "pass",
    detail: `Backdrop layer "${layerName}" extends to/below the viewport floor at every sample (worst minY ${maxBottom} ≤ frame minY ${floor}); its bottom edge is never exposed.`,
  };
}

export function evaluateCoverage(
  input: CoverageInput,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];

  const allLayers = acceptance.juice?.parallax?.layers ?? [];
  const requiredLayers = allLayers.filter((l) => l.coversFrame === true);
  // Bottom-only backdrops: `coversBottom` layers NOT already fully covered.
  const bottomLayers = allLayers.filter(
    (l) => l.coversBottom === true && l.coversFrame !== true,
  );

  if (requiredLayers.length === 0 && bottomLayers.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "coverage.declared",
        expected: "≥1 juice.parallax layer flagged coversFrame:true or coversBottom:true",
        actual: "(none)",
        status: "warn",
        detail:
          "No full-cover or bottom-cover backdrop layer declared in juice.parallax (no layer has coversFrame:true or coversBottom:true); coverage not evaluated.",
      },
    ]);
  }

  const frame = input.cameraFrame;
  const frameWidth = frame.maxX - frame.minX;
  const continuityThreshold =
    acceptance.juice?.parallax?.continuityThresholdU ?? frameWidth * 0.1;
  const captured = input.layers ?? [];
  const atSeconds = input.atSeconds;
  const whenNote =
    atSeconds !== undefined ? ` (post-drift capture at t=${atSeconds}s)` : "";

  for (const required of requiredLayers) {
    const found = captured.find((l) => l.name === required.name);
    if (!found) {
      checks.push({
        id: `coverage.${required.name}`,
        expected: "fully covers the camera frame",
        actual: "(not captured)",
        status: "warn",
        detail: `Full-cover layer "${required.name}" was not captured${whenNote}; cannot verify it still covers the frame. Capture its bounds across a drift cycle (layer.samples) via scene.get_bounds.`,
      });
      continue;
    }

    if (found.samples && found.samples.length > 0) {
      checks.push(
        evaluateTrajectory(required.name, found.samples, input, continuityThreshold),
      );
    } else {
      checks.push(evaluateSingleFrame(required.name, found, input));
    }
  }

  // ---- BOTTOM-COVERAGE (opt-in, bottom-only) ----
  for (const bottom of bottomLayers) {
    const found = captured.find((l) => l.name === bottom.name);
    if (!found) {
      checks.push({
        id: `coverage.${bottom.name}.bottom`,
        expected: "extends to/below the viewport floor (layer minY ≤ frame minY)",
        actual: "(not captured)",
        status: "warn",
        detail: `Bottom-cover layer "${bottom.name}" was not captured${whenNote}; cannot verify its bottom edge reaches the viewport floor. Capture its bounds (layer.samples) via scene.get_bounds.`,
      });
      continue;
    }
    checks.push(evaluateBottomCoverage(bottom.name, found, input));
  }

  return makeGateReport(GATE_NAME, checks);
}
