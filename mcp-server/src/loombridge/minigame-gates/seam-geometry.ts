/**
 * Depth-aware background seam geometry.
 *
 * `background-coverage` answers "does some layer cover every view sample?".
 * `background-seam` answers a different question: "is a front layer's cut edge
 * visible inside the camera frame?" A sky layer can cover the whole view while a
 * nearer hill/ground sprite ends inside the frame, producing a visible seam.
 *
 * v1 supports the common 2D setup: all background sprites are on the same Unity
 * sorting layer, ordered by SpriteRenderer.sortingOrder, with z as a tiebreak.
 * Mixed sorting layers are refused by the evaluator rather than guessed.
 */

import type { BackgroundLayer, BackgroundLayerOrder, BackgroundCamera } from "./types.js";
import { COVERAGE_EPSILON, pointInAabb, viewRect, type ViewRect } from "./coverage-geometry.js";
import type { SeamSegment } from "../../verification/gates/types.js";

export type SeamEdge = "bottom" | "left" | "right";

export interface SeamFinding {
  layer: BackgroundLayer;
  edge: SeamEdge;
  exposedWorldUnits: number;
}

/** Number of samples along one exposed edge. */
const SEAM_SAMPLES = 9;

function layerKey(order: BackgroundLayerOrder): string | null {
  if (order.sortingLayerId !== undefined) return `id:${order.sortingLayerId}`;
  if (order.sortingLayerName !== undefined) return `name:${order.sortingLayerName}`;
  return null;
}

/**
 * Return a reason the layer set's render order is not safely comparable, or null
 * when v1 can compare it. Missing `order` is handled by the evaluator's explicit
 * refuse-on-absent branch; this function handles the sorting-layer ambiguity.
 */
export function renderOrderUnsupportedReason(layers: BackgroundLayer[]): string | null {
  const keys = new Set<string>();
  for (const layer of layers) {
    if (!layer.order) continue;
    const key = layerKey(layer.order);
    if (key) keys.add(key);
  }
  if (keys.size > 1) {
    return "background layers use multiple sorting layers; v1 seam detection only compares layers within one sorting layer";
  }
  return null;
}

/** True iff `a` is visually in front of `b` under the v1 order model. */
export function isInFrontOf(a: BackgroundLayer, b: BackgroundLayer): boolean {
  if (!a.order || !b.order) return false;
  if (a.order.sortingOrder !== b.order.sortingOrder) {
    return a.order.sortingOrder > b.order.sortingOrder;
  }
  // Unity's common 2D camera looks down -Z; lower z is closer/front for tied order.
  return a.order.z < b.order.z - COVERAGE_EPSILON;
}

function sampleLine(start: number, end: number, i: number): number {
  if (SEAM_SAMPLES <= 1) return (start + end) / 2;
  const t = i / (SEAM_SAMPLES - 1);
  return start + t * (end - start);
}

function coveredByFrontLayer(
  px: number,
  py: number,
  layer: BackgroundLayer,
  layers: BackgroundLayer[],
): boolean {
  return layers.some((candidate) => candidate !== layer && isInFrontOf(candidate, layer) && pointInAabb(px, py, candidate));
}

function sampleEdge(
  layer: BackgroundLayer,
  layers: BackgroundLayer[],
  rect: ViewRect,
  edge: SeamEdge,
): SeamFinding | null {
  if (edge === "bottom") {
    if (layer.min.y <= rect.bottom + COVERAGE_EPSILON) return null;
    const fromX = Math.max(layer.min.x, rect.left);
    const toX = Math.min(layer.max.x, rect.right);
    if (toX <= fromX + COVERAGE_EPSILON) return null;
    const py = layer.min.y;
    for (let i = 0; i < SEAM_SAMPLES; i += 1) {
      const px = sampleLine(fromX, toX, i);
      if (!coveredByFrontLayer(px, py, layer, layers)) {
        return { layer, edge, exposedWorldUnits: layer.min.y - rect.bottom };
      }
    }
    return null;
  }

  if (edge === "left") {
    if (layer.min.x <= rect.left + COVERAGE_EPSILON) return null;
    const fromY = Math.max(layer.min.y, rect.bottom);
    const toY = Math.min(layer.max.y, rect.top);
    if (toY <= fromY + COVERAGE_EPSILON) return null;
    const px = layer.min.x;
    for (let i = 0; i < SEAM_SAMPLES; i += 1) {
      const py = sampleLine(fromY, toY, i);
      if (!coveredByFrontLayer(px, py, layer, layers)) {
        return { layer, edge, exposedWorldUnits: layer.min.x - rect.left };
      }
    }
    return null;
  }

  if (layer.max.x >= rect.right - COVERAGE_EPSILON) return null;
  const fromY = Math.max(layer.min.y, rect.bottom);
  const toY = Math.min(layer.max.y, rect.top);
  if (toY <= fromY + COVERAGE_EPSILON) return null;
  const px = layer.max.x;
  for (let i = 0; i < SEAM_SAMPLES; i += 1) {
    const py = sampleLine(fromY, toY, i);
    if (!coveredByFrontLayer(px, py, layer, layers)) {
      return { layer, edge, exposedWorldUnits: rect.right - layer.max.x };
    }
  }
  return null;
}

/** Clamp `n` into [0,1] (normalized image-space coords must stay in-frame). */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Convert a `SeamFinding` + view `rect` into a drawable `SeamSegment` with normalized
 * TOP-origin coords (image space), clamped to [0,1]. For a world point (wx,wy):
 *   nx = (wx - rect.left) / (rect.right - rect.left)
 *   ny = (rect.top - wy)  / (rect.top - rect.bottom)
 *
 * - bottom: a horizontal line at the layer's `min.y`, across its in-frame x-range; the
 *   strip is BELOW it (line ny → frame bottom ny=1). exposedFraction is the depth below
 *   the line as a fraction of the frame height.
 * - left:   a vertical line at the layer's `min.x`, over its in-frame y-extent; the strip
 *   is from the frame left (nx=0) to the line. exposedFraction is that width fraction.
 * - right:  a vertical line at the layer's `max.x`; the strip is from the line to the
 *   frame right (nx=1). exposedFraction is that width fraction.
 */
export function seamSegment(finding: SeamFinding, rect: ViewRect): SeamSegment {
  const w = rect.right - rect.left;
  const h = rect.top - rect.bottom;
  const nx = (wx: number): number => clamp01((wx - rect.left) / w);
  const ny = (wy: number): number => clamp01((rect.top - wy) / h);
  const L = finding.layer;

  if (finding.edge === "bottom") {
    const x0 = nx(Math.max(L.min.x, rect.left));
    const x1 = nx(Math.min(L.max.x, rect.right));
    const y = ny(L.min.y); // the cut-edge line (top-origin)
    return {
      edge: "bottom",
      layerLocator: L.locator,
      line: { x0, y0: y, x1, y1: y },
      strip: { x: Math.min(x0, x1), y, width: Math.abs(x1 - x0), height: clamp01(1 - y) },
      exposedFraction: clamp01((L.min.y - rect.bottom) / h),
    };
  }

  if (finding.edge === "left") {
    const x = nx(L.min.x);
    const yTop = ny(Math.min(L.max.y, rect.top));
    const yBot = ny(Math.max(L.min.y, rect.bottom));
    return {
      edge: "left",
      layerLocator: L.locator,
      line: { x0: x, y0: yTop, x1: x, y1: yBot },
      strip: { x: 0, y: Math.min(yTop, yBot), width: x, height: Math.abs(yBot - yTop) },
      exposedFraction: clamp01((L.min.x - rect.left) / w),
    };
  }

  // right
  const x = nx(L.max.x);
  const yTop = ny(Math.min(L.max.y, rect.top));
  const yBot = ny(Math.max(L.min.y, rect.bottom));
  return {
    edge: "right",
    layerLocator: L.locator,
    line: { x0: x, y0: yTop, x1: x, y1: yBot },
    strip: { x, y: Math.min(yTop, yBot), width: clamp01(1 - x), height: Math.abs(yBot - yTop) },
    exposedFraction: clamp01((rect.right - L.max.x) / w),
  };
}

/** Find visible cut edges on bottom/left/right; the top edge is an intended horizon/silhouette. */
export function seamFindings(
  layers: BackgroundLayer[],
  camera: BackgroundCamera,
  aspect: number,
): { rect: ViewRect; findings: SeamFinding[] } {
  const rect = viewRect(camera, aspect);
  const findings: SeamFinding[] = [];
  for (const layer of layers) {
    for (const edge of ["bottom", "left", "right"] as const) {
      const finding = sampleEdge(layer, layers, rect, edge);
      if (finding) findings.push(finding);
    }
  }
  return { rect, findings };
}
