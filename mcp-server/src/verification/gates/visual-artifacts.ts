/**
 * Visual-artifacts gate.
 *
 * Catches state-specific screenshot defects that ordinary world-space gates miss:
 * jump-only backdrop seams, full-width bands, or camera-clear exposure during
 * motion. Capture tooling emits CLASSIFIED line/band facts per named frame:
 * expected gameplay geometry (platform edges, HUD bars, end-card borders) should
 * be masked or explicitly classified so it does not fail as a render artifact.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export const GATE_NAME = "visual-artifacts";

export interface VisualArtifactLine {
  orientation: "horizontal" | "vertical";
  /** Line length as fraction of frame width/height. */
  lengthFraction: number;
  /**
   * Capture-side classification. Only artifact-like classes hard-fail. Expected
   * geometry is reported as pass/informational so raw line detectors can include
   * platform/HUD edges without creating false failures.
   */
  classification?:
    | "background_seam"
    | "camera_edge"
    | "render_band"
    | "platform_edge"
    | "hud_edge"
    | "end_card_edge"
    | "expected_geometry"
    | "unknown";
  /** Explicit marker for geometry that should not count as an artifact. */
  expectedGeometry?: boolean;
  /** Pixel position when known. */
  x?: number;
  y?: number;
  thicknessPx?: number;
  contrast?: number;
  note?: string;
}

export interface VisualArtifactBand {
  orientation: "horizontal" | "vertical";
  coverageFraction: number;
  classification?:
    | "background_seam"
    | "camera_edge"
    | "render_band"
    | "platform_edge"
    | "hud_edge"
    | "end_card_edge"
    | "expected_geometry"
    | "unknown";
  expectedGeometry?: boolean;
  thicknessFraction?: number;
  note?: string;
}

export interface VisualArtifactFrame {
  id: string;
  longLines?: VisualArtifactLine[];
  bands?: VisualArtifactBand[];
}

export interface VisualArtifactComparison {
  from: string;
  to: string;
  /** True when a seam/band follows gameplay state such as jump/camera motion. */
  movedLine?: boolean;
  stableRegionChangeFraction?: number;
}

export interface VisualArtifactsInput {
  frames?: VisualArtifactFrame[];
  comparisons?: VisualArtifactComparison[];
}

function artifactStatus(
  classification: VisualArtifactLine["classification"],
  expectedGeometry?: boolean,
): "artifact" | "expected" | "unknown" {
  if (expectedGeometry === true) return "expected";
  if (
    classification === "platform_edge" ||
    classification === "hud_edge" ||
    classification === "end_card_edge" ||
    classification === "expected_geometry"
  ) {
    return "expected";
  }
  if (
    classification === "background_seam" ||
    classification === "camera_edge" ||
    classification === "render_band"
  ) {
    return "artifact";
  }
  return "unknown";
}

export function evaluateVisualArtifacts(
  input: VisualArtifactsInput,
  acceptance: AcceptanceContract,
): GateReport {
  const frames = input.frames ?? [];
  const comparisons = input.comparisons ?? [];

  if (frames.length === 0 && comparisons.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "visual-artifacts.data",
        expected: "stateful screenshot artifact analysis",
        actual: "(none)",
        status: "warn",
        detail:
          "No visual-artifacts samples captured; state-specific seam/band checks were not evaluated. Capture spawn plus action/stress frames and analyze for long lines or moving bands.",
      },
    ]);
  }

  const cfg = acceptance.render ?? {};
  const maxLine = cfg.maxArtifactLineFraction ?? 0.85;
  const maxStableChange = cfg.maxStableRegionChangeFraction ?? 0.08;
  const checks: GateCheck[] = [];

  for (const frame of frames) {
    const lines = frame.longLines ?? [];
    if (lines.length === 0) {
      checks.push({
        id: `visual-artifacts.lines.${frame.id}`,
        expected: `no long seam line ≥ ${(maxLine * 100).toFixed(0)}% of frame`,
        actual: "none",
        status: "pass",
        detail: `Frame "${frame.id}" has no captured long horizontal/vertical seam lines.`,
      });
    } else {
      for (const [index, line] of lines.entries()) {
        const kind = artifactStatus(line.classification, line.expectedGeometry);
        const status =
          kind === "expected"
            ? "pass"
            : line.lengthFraction >= maxLine
              ? kind === "artifact"
                ? "fail"
                : "warn"
              : "warn";
        checks.push({
          id: `visual-artifacts.line.${frame.id}.${index}`,
          expected: `no classified artifact line ≥ ${(maxLine * 100).toFixed(0)}% of frame`,
          actual: `${line.classification ?? "unknown"} ${line.orientation} ${(line.lengthFraction * 100).toFixed(1)}%${line.y !== undefined ? ` at y=${line.y}` : ""}`,
          status,
          detail:
            kind === "expected"
              ? `Frame "${frame.id}" reported a long ${line.orientation} line, but it is classified as expected geometry (${line.classification ?? "expectedGeometry"}), so it is not a render-artifact failure.`
              : status === "fail"
              ? `Frame "${frame.id}" has an obvious ${line.orientation} seam/band spanning ${(line.lengthFraction * 100).toFixed(1)}% of the frame. Check parallax/camera/pixel snapping and state-specific backgrounds.`
              : kind === "unknown" && line.lengthFraction >= maxLine
                ? `Frame "${frame.id}" has a long but unclassified ${line.orientation} line. Mask expected geometry or classify it as background_seam/camera_edge/render_band before treating it as a hard failure.`
                : `Frame "${frame.id}" has a possible ${line.orientation} artifact below the hard threshold; inspect or justify it.`,
        });
      }
    }

    for (const [index, band] of (frame.bands ?? []).entries()) {
      const kind = artifactStatus(band.classification, band.expectedGeometry);
      const status =
        kind === "expected"
          ? "pass"
          : band.coverageFraction >= maxLine
            ? kind === "artifact"
              ? "fail"
              : "warn"
            : "warn";
      checks.push({
        id: `visual-artifacts.band.${frame.id}.${index}`,
        expected: `no classified artifact band ≥ ${(maxLine * 100).toFixed(0)}% of frame`,
        actual: `${band.classification ?? "unknown"} ${band.orientation} ${(band.coverageFraction * 100).toFixed(1)}%`,
        status,
        detail:
          kind === "expected"
            ? `Frame "${frame.id}" reported a large ${band.orientation} band, but it is classified as expected geometry (${band.classification ?? "expectedGeometry"}), so it is not a render-artifact failure.`
            : status === "fail"
            ? `Frame "${frame.id}" contains a large ${band.orientation} band across ${(band.coverageFraction * 100).toFixed(1)}% of the frame.`
            : kind === "unknown" && band.coverageFraction >= maxLine
              ? `Frame "${frame.id}" contains a large but unclassified ${band.orientation} band. Mask expected geometry or classify it as background_seam/camera_edge/render_band before treating it as a hard failure.`
              : `Frame "${frame.id}" contains a possible ${band.orientation} band; inspect or justify it.`,
      });
    }
  }

  for (const comparison of comparisons) {
    if (comparison.movedLine === true) {
      checks.push({
        id: `visual-artifacts.movingLine.${comparison.from}->${comparison.to}`,
        expected: "no seam/band moves between stable scene states",
        actual: "moving line detected",
        status: "fail",
        detail: `A seam/band moved between "${comparison.from}" and "${comparison.to}", which usually indicates parallax UV, camera, or pixel-snapping artifacts during motion.`,
      });
    }
    if (comparison.stableRegionChangeFraction !== undefined) {
      const change = comparison.stableRegionChangeFraction;
      checks.push({
        id: `visual-artifacts.stableRegion.${comparison.from}->${comparison.to}`,
        expected: `stable background change ≤ ${(maxStableChange * 100).toFixed(1)}%`,
        actual: `${(change * 100).toFixed(1)}%`,
        status: change <= maxStableChange ? "pass" : "warn",
        detail:
          change <= maxStableChange
            ? `Stable regions stayed visually consistent between "${comparison.from}" and "${comparison.to}".`
            : `Stable-region pixels changed by ${(change * 100).toFixed(1)}% between "${comparison.from}" and "${comparison.to}"; inspect for state-specific render artifacts.`,
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
