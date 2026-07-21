/**
 * Shared world-space COVERAGE GEOMETRY primitives for the `background-coverage` gate
 * (`evaluators.ts`) and the background-discovery helper (`minigame-background-discover.ts`).
 *
 * Both must agree EXACTLY on what "the camera view is covered" means, so the geometry
 * lives here once: a set the discovery helper calls "covered" is precisely the set the
 * gate will pass (no geometry drift). The gate's evaluator imports these and keeps its
 * pass/fail/na messages byte-for-byte identical; the discovery helper uses `viewRect` +
 * `coverageStats` to score and classify candidate layers.
 *
 * The view rect is the orthographic camera's world rectangle at a given aspect:
 * `halfW = orthoSize × aspect`, `halfH = orthoSize`, centred on the camera position.
 * Coverage is tested by grid-sampling COVERAGE_GRID² points and requiring each to lie
 * inside ≥1 layer AABB.
 */

import type { WorldAabb } from "./types.js";

/** Grid resolution: sample N×N points across the camera view rect. */
export const COVERAGE_GRID = 9;
/** World-unit slack when testing a sample point against a layer AABB (sub-pixel float slop). */
export const COVERAGE_EPSILON = 1e-3;

/** The minimal camera shape the coverage geometry needs (structural — orthoSize + world position). */
export interface CoverageCamera {
  orthoSize: number;
  position: { x: number; y: number };
}

/** A camera's world VIEW RECT at one aspect (the rectangle the layers must cover). */
export interface ViewRect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** Per-side count of uncovered samples + worst-sample summary (the gate's report inputs). */
export interface CoverageStats {
  /** Number of grid samples covered by ≥1 layer AABB. */
  covered: number;
  /** Total grid samples (COVERAGE_GRID²). */
  total: number;
  /** `covered / total` in [0,1]. */
  fraction: number;
  /** Number of uncovered samples (`total - covered`). */
  uncovered: number;
  /** Per-frame-side count of uncovered samples (which edge the gaps cluster on). */
  sideGaps: { left: number; right: number; top: number; bottom: number };
  /** World-unit distance of the worst uncovered sample past the nearest layer edge. */
  worstGap: number;
  /** The frame side of the worst uncovered sample (`""` when fully covered). */
  worstSide: string;
}

/** True iff `(px,py)` lies inside the AABB `a` (inclusive, with epsilon slack). */
export function pointInAabb(px: number, py: number, a: WorldAabb): boolean {
  return (
    px >= a.min.x - COVERAGE_EPSILON &&
    px <= a.max.x + COVERAGE_EPSILON &&
    py >= a.min.y - COVERAGE_EPSILON &&
    py <= a.max.y + COVERAGE_EPSILON
  );
}

/**
 * Build the orthographic camera's world view rect at `aspect`
 * (`halfW = orthoSize × aspect`, `halfH = orthoSize`, centred on the camera position).
 */
export function viewRect(camera: CoverageCamera, aspect: number): ViewRect {
  const halfW = camera.orthoSize * aspect;
  const halfH = camera.orthoSize;
  const cx = camera.position.x;
  const cy = camera.position.y;
  return { left: cx - halfW, right: cx + halfW, bottom: cy - halfH, top: cy + halfH };
}

/**
 * Grid-sample the camera view rect at `aspect` and measure how the `layers` AABBs cover it.
 * Each of the COVERAGE_GRID² samples must lie inside ≥1 layer AABB; uncovered samples are
 * tallied per frame side, and the worst sample's world distance past the nearest layer edge
 * is tracked. The exact loop the `background-coverage` gate grades with.
 */
export function coverageStats(
  layers: WorldAabb[],
  camera: CoverageCamera,
  aspect: number,
): CoverageStats {
  const { left, right, bottom, top } = viewRect(camera, aspect);

  let uncovered = 0;
  let total = 0;
  let worstGap = 0;
  let worstSide = "";
  const sideGaps = { left: 0, right: 0, top: 0, bottom: 0 };

  for (let i = 0; i < COVERAGE_GRID; i += 1) {
    const u = i / (COVERAGE_GRID - 1);
    const px = left + u * (right - left);
    for (let j = 0; j < COVERAGE_GRID; j += 1) {
      total += 1;
      const v = j / (COVERAGE_GRID - 1);
      const py = bottom + v * (top - bottom);
      if (layers.some((layer) => pointInAabb(px, py, layer))) continue;

      uncovered += 1;
      // Distance to the NEAREST layer edge (the smallest world gap this sample is outside by).
      let nearest = Infinity;
      for (const layer of layers) {
        const dx = Math.max(layer.min.x - px, px - layer.max.x, 0);
        const dy = Math.max(layer.min.y - py, py - layer.max.y, 0);
        nearest = Math.min(nearest, Math.hypot(dx, dy));
      }
      // Which frame side this gap sits on (the edge the sample is closest to).
      const dl = px - left;
      const dr = right - px;
      const db = py - bottom;
      const dt = top - py;
      const side =
        Math.min(dl, dr, db, dt) === dl ? "left" :
        Math.min(dl, dr, db, dt) === dr ? "right" :
        Math.min(dl, dr, db, dt) === db ? "bottom" : "top";
      sideGaps[side] += 1;
      if (nearest > worstGap) {
        worstGap = nearest;
        worstSide = side;
      }
    }
  }

  return {
    covered: total - uncovered,
    total,
    fraction: total > 0 ? (total - uncovered) / total : 0,
    uncovered,
    sideGaps,
    worstGap,
    worstSide,
  };
}
