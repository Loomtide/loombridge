/**
 * Tile-render gate.
 *
 * Platformer-specific render check for tiled terrain. `platform-tiles` verifies
 * structural construction; this gate closes the RUN-2 blind spot: terrain that
 * is structurally valid but visibly repeats a per-tile border/seam.
 */

import type { AcceptanceContract } from "../types.js";
import { numberGateTuning } from "../gate-tuning.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export const GATE_NAME = "tile-render";

export interface TileSpriteCapture {
  name?: string;
  tileWidthPx?: number;
  edgeCols?: number;
  /** Mean luminance per source-sprite column, left → right. */
  columnLuma?: number[];
}

export interface TileRenderPlatform {
  name: string;
  drawMode?: string;
  rendererCount?: number;
  widthTiles?: number;
  tileSprite?: TileSpriteCapture;
}

export interface TileRenderInput {
  platforms?: TileRenderPlatform[];
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanAbsAdjacentDelta(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i += 1) {
    sum += Math.abs(values[i]! - values[i - 1]!);
  }
  return sum / (values.length - 1);
}

function finiteColumns(values: unknown): number[] | null {
  if (!Array.isArray(values)) return null;
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return values;
}

function seamMetrics(sprite: TileSpriteCapture, acceptance: AcceptanceContract): {
  edgeCols: number;
  edgeInteriorContrast: number;
  junctionContrast: number;
  interiorDelta: number;
  threshold: number;
} | null {
  const columns = finiteColumns(sprite.columnLuma);
  const tileWidthPx = sprite.tileWidthPx ?? columns?.length;
  const edgeCols = Math.max(1, Math.floor(sprite.edgeCols ?? numberGateTuning(acceptance, GATE_NAME, "tileRenderEdgeCols") ?? acceptance.platformer?.tileRenderEdgeCols ?? 2));
  if (!columns || !tileWidthPx || columns.length !== tileWidthPx || columns.length < edgeCols * 2 + 2) {
    return null;
  }

  const leftEdge = columns.slice(0, edgeCols);
  const rightEdge = columns.slice(columns.length - edgeCols);
  const leftInterior = columns.slice(edgeCols, edgeCols * 2);
  const rightInterior = columns.slice(columns.length - edgeCols * 2, columns.length - edgeCols);
  const interior = columns.slice(edgeCols, columns.length - edgeCols);
  const junction = [...rightEdge, ...leftEdge];
  const factor = numberGateTuning(acceptance, GATE_NAME, "tileRenderSeamToleranceFactor") ?? acceptance.platformer?.tileRenderSeamToleranceFactor ?? 4;

  const edgeInteriorContrast = Math.max(
    Math.abs(mean(leftEdge) - mean(leftInterior)),
    Math.abs(mean(rightEdge) - mean(rightInterior)),
  );
  const junctionContrast = meanAbsAdjacentDelta(junction);
  const interiorDelta = meanAbsAdjacentDelta(interior);

  return {
    edgeCols,
    edgeInteriorContrast,
    junctionContrast,
    interiorDelta,
    threshold: interiorDelta * factor,
  };
}

export function evaluateTileRender(
  input: TileRenderInput,
  acceptance: AcceptanceContract,
): GateReport {
  const platforms = input.platforms ?? [];
  if (platforms.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "tile-render.data",
        expected: "≥1 platform render capture",
        actual: "(none)",
        status: "warn",
        detail:
          "No tile-render data captured; seamless tiled rendering was not evaluated. Emit tile-render.json with drawMode, rendererCount, widthTiles, and tileSprite columnLuma.",
      },
    ]);
  }

  const rendererCap = numberGateTuning(acceptance, GATE_NAME, "tileRenderMaxRenderers") ?? acceptance.platformer?.tileRenderMaxRenderers ?? 2;
  const checks: GateCheck[] = [];

  for (const platform of platforms) {
    const widthTiles = platform.widthTiles ?? 0;
    const multiTile = widthTiles > 1;
    checks.push({
      id: `tile-render.drawmode.${platform.name}`,
      expected: multiTile ? 'SpriteRenderer.drawMode "Tiled" for multi-tile spans' : "single-tile span may use any drawMode",
      actual: platform.drawMode ?? "(absent)",
      status: !multiTile || platform.drawMode === "Tiled" ? "pass" : "fail",
      detail:
        !multiTile || platform.drawMode === "Tiled"
          ? `Platform "${platform.name}" drawMode is valid for its span.`
          : `Platform "${platform.name}" is ${widthTiles} tiles wide but uses drawMode "${platform.drawMode ?? "(absent)"}"; wide terrain must tile, not stretch or compose per tile.`,
    });

    const rendererCount = platform.rendererCount ?? 0;
    const rendererDefect = multiTile && (rendererCount > rendererCap || rendererCount >= widthTiles);
    checks.push({
      id: `tile-render.renderers.${platform.name}`,
      expected: `rendererCount ≤ ${rendererCap} and not one renderer per tile`,
      actual: String(platform.rendererCount ?? "(absent)"),
      status: rendererDefect ? "fail" : "pass",
      detail: rendererDefect
        ? `Platform "${platform.name}" uses ${rendererCount} renderers for ${widthTiles} tiles; this scales with tile count and will expose per-tile object/sprite borders.`
        : `Platform "${platform.name}" renderer count does not scale with tile count.`,
    });

    const metrics = platform.tileSprite ? seamMetrics(platform.tileSprite, acceptance) : null;
    if (!metrics) {
      checks.push({
        id: `tile-render.seam.${platform.name}`,
        expected: "tileSprite.columnLuma length == tileWidthPx and enough edge/interior columns",
        actual: "insufficient samples",
        status: "warn",
        detail: `Platform "${platform.name}" did not capture enough raw tile-sprite luminance columns to judge repeated seams.`,
      });
      continue;
    }

    const seamDefect =
      metrics.edgeInteriorContrast > metrics.threshold ||
      metrics.junctionContrast > metrics.threshold;
    checks.push({
      id: `tile-render.seam.${platform.name}`,
      expected: `edge/interior and repeated-junction contrast ≤ interiorDelta × tolerance (${metrics.threshold.toFixed(4)})`,
      actual: `edgeInterior=${metrics.edgeInteriorContrast.toFixed(4)}, junction=${metrics.junctionContrast.toFixed(4)}, interiorDelta=${metrics.interiorDelta.toFixed(4)}, edgeCols=${metrics.edgeCols}`,
      status: seamDefect ? "fail" : "pass",
      detail: seamDefect
        ? `Platform "${platform.name}" tile sprite has a visible repeated edge band; the edge columns differ from the interior or create a high-contrast tile|tile junction.`
        : `Platform "${platform.name}" tile sprite edges are continuous with the interior at repeated tile seams.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
