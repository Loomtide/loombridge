/**
 * Render-frame gate.
 *
 * WHY: world-space camera/background coverage can pass while the actual Game
 * view screenshot is boxed with black bars or an unintended viewport border.
 * This gate evaluates screenshot-level analysis captured into `render-frame.json`.
 *
 * The gate intentionally consumes precomputed pixel facts instead of decoding
 * PNGs here. Unity/capture tooling can evolve independently as long as it emits
 * frame dimensions plus border/content coverage measurements.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export const GATE_NAME = "render-frame";

export interface RenderFrameBorderFractions {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface RenderFrameContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderFrameSample {
  /** Stable frame id, e.g. spawn/jump/dash/win. */
  id: string;
  width: number;
  height: number;
  /** Fraction of each edge that is black or camera-clear border. */
  edgeBlackFraction?: RenderFrameBorderFractions;
  /** Fraction of each edge that is visually uniform, not just black. */
  uniformBorderFraction?: RenderFrameBorderFractions;
  /** Bounding rect of non-border content in screenshot pixels. */
  contentRect?: RenderFrameContentRect;
}

export interface RenderFrameInput {
  frames?: RenderFrameSample[];
}

function maxBorder(border?: RenderFrameBorderFractions): number {
  if (!border) return 0;
  return Math.max(border.top ?? 0, border.right ?? 0, border.bottom ?? 0, border.left ?? 0);
}

function contentCoverage(sample: RenderFrameSample): number | null {
  if (!sample.contentRect || sample.width <= 0 || sample.height <= 0) return null;
  const contentArea = sample.contentRect.width * sample.contentRect.height;
  return contentArea / (sample.width * sample.height);
}

export function evaluateRenderFrame(
  input: RenderFrameInput,
  acceptance: AcceptanceContract,
): GateReport {
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "render-frame.data",
        expected: "≥1 analyzed play-mode screenshot",
        actual: "(none)",
        status: "warn",
        detail:
          "No render-frame samples captured; viewport-fill/letterbox checks were not evaluated. Emit render-frame.json from live Game-view screenshot analysis.",
      },
    ]);
  }

  const renderCfg = acceptance.render ?? {};
  const viewportMode = renderCfg.viewportMode ?? "full";
  const maxAllowedBorder = renderCfg.maxBorderFraction ?? 0.02;
  const minCoverage = Math.max(0, Math.min(1, 1 - maxAllowedBorder * 2));
  const checks: GateCheck[] = [];

  if (viewportMode === "any") {
    checks.push({
      id: "render-frame.viewportMode",
      expected: "full or letterbox viewport policy",
      actual: "any",
      status: "not_applicable",
      detail: "Acceptance contract allows any viewport framing; render-frame border checks skipped.",
    });
    return makeGateReport(GATE_NAME, checks);
  }

  for (const frame of frames) {
    const edgeBlack = maxBorder(frame.edgeBlackFraction);
    const uniform = maxBorder(frame.uniformBorderFraction);
    const worstBorder = Math.max(edgeBlack, uniform);
    const coverage = contentCoverage(frame);

    if (viewportMode === "letterbox") {
      checks.push({
        id: `render-frame.viewport.${frame.id}`,
        expected: "letterbox allowed by contract",
        actual: `max border ${(worstBorder * 100).toFixed(1)}%`,
        status: "pass",
        detail: `Frame "${frame.id}" has border measurements, but viewportMode=letterbox explicitly allows bars.`,
      });
      continue;
    }

    checks.push({
      id: `render-frame.viewport.${frame.id}`,
      expected: `full viewport (max edge border ≤ ${(maxAllowedBorder * 100).toFixed(1)}%)`,
      actual: `black ${(edgeBlack * 100).toFixed(1)}%, uniform ${(uniform * 100).toFixed(1)}%`,
      status: worstBorder <= maxAllowedBorder ? "pass" : "fail",
      detail:
        worstBorder <= maxAllowedBorder
          ? `Frame "${frame.id}" fills the screenshot; no unintended letterbox/boxed border detected.`
          : `Frame "${frame.id}" appears boxed/letterboxed: edge border ${(worstBorder * 100).toFixed(1)}% exceeds ${(maxAllowedBorder * 100).toFixed(1)}%. Use a full-viewport camera/pixel-art setup or declare intentional letterbox in the contract.`,
    });

    if (coverage !== null) {
      checks.push({
        id: `render-frame.content.${frame.id}`,
        expected: `content coverage ≥ ${(minCoverage * 100).toFixed(1)}%`,
        actual: `${(coverage * 100).toFixed(1)}%`,
        status: coverage >= minCoverage ? "pass" : "fail",
        detail:
          coverage >= minCoverage
            ? `Frame "${frame.id}" content rect covers enough of the output frame.`
            : `Frame "${frame.id}" content rect covers only ${(coverage * 100).toFixed(1)}% of the output, suggesting black margins or an unintended camera viewport rect.`,
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
