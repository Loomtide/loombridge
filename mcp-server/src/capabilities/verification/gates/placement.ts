/**
 * Placement gate.
 *
 * WHY: a 37/37-green clean-room build still shipped two visible placement bugs
 * the other gates missed, both of which this gate catches with PURE geometry:
 *
 *   1. VISIBLE GROUND ENDS — the boundary grounds stop INSIDE the camera frame
 *      (e.g. the right ground maxX 15.5 < frame maxX 17.1), so the player sees
 *      the platform's hard edge instead of it running off-screen. EDGE COVERAGE
 *      asserts the OUTER grounds run past the frame's left/right edges. Internal
 *      gaps (a deliberate pit between grounds) are fine — only the outer edges
 *      are checked.
 *
 *   2. FLOATING / SUNK PROPS — an object (e.g. the flag) placed by transform
 *      CENTER on the ground line, so its visible BASE sits above the grass
 *      surface (it floats), or below it (it sinks into the ground). GROUNDED
 *      ITEMS asserts each item's visible bottom Y ≈ its surface top Y within a
 *      tolerance.
 *
 * INPUT (the agent captures world bounds via `scene.get_bounds`):
 *
 *   {
 *     cameraFrame: { minX, maxX, minY, maxY },                 // the visible frame
 *     grounds?:     [{ name, minX, maxX, topY }],              // standable grounds
 *     groundedItems?:[{ name, visibleBottomY, surfaceTopY, toleranceU? }],
 *   }
 *
 * ACCEPTANCE: the optional `placement` section — `groundedToleranceU` is the
 * default float/sink slack (u) when an item omits its own `toleranceU`. Defaults
 * to 0.1 when both are absent.
 *
 * CHECKS:
 *  - EDGE COVERAGE (only when `grounds` is non-empty):
 *      • placement.edgeCoverage.left  — min(grounds.minX) ≤ frame.minX → PASS, else FAIL.
 *      • placement.edgeCoverage.right — max(grounds.maxX) ≥ frame.maxX → PASS, else FAIL.
 *  - GROUNDED ITEMS: one check per item. delta = visibleBottomY - surfaceTopY.
 *      • |delta| ≤ tol → PASS (rests on its surface).
 *      • delta >  tol  → FAIL (FLOATS above its surface).
 *      • delta < -tol  → FAIL (SUNK into its surface).
 *  - Neither grounds nor groundedItems captured → a single WARN.
 *
 * Mirrors the doc-comment + GateCheck style of `reachability.ts`.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** The camera frame (visible world rectangle) in world units. */
export interface PlacementCameraFrame {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A standable ground span: its horizontal extent + top (standable) surface. */
export interface PlacementGround {
  name: string;
  /** Left/right world-X extent of the ground. */
  minX: number;
  maxX: number;
  /** World-Y of the top (standable) surface. */
  topY: number;
}

/** An item that should rest ON a surface (its visible base vs the surface top). */
export interface PlacementGroundedItem {
  name: string;
  /** World-Y of the item's visible BOTTOM edge (not the transform center). */
  visibleBottomY: number;
  /** World-Y of the surface top the item is meant to rest on. */
  surfaceTopY: number;
  /** Per-item float/sink slack (u); falls back to acceptance default then 0.1. */
  toleranceU?: number;
}

/** The geometric layout the agent captures via `scene.get_bounds`. */
export interface PlacementInput {
  cameraFrame: PlacementCameraFrame;
  grounds?: PlacementGround[];
  groundedItems?: PlacementGroundedItem[];
}

export const GATE_NAME = "placement";

const EPS = 1e-6;

export function evaluatePlacement(
  input: PlacementInput,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];

  const frame = input.cameraFrame;
  const grounds = input.grounds ?? [];
  const groundedItems = input.groundedItems ?? [];

  if (grounds.length === 0 && groundedItems.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "placement.data",
        expected: "≥1 ground or grounded item captured",
        actual: "(none)",
        status: "warn",
        detail:
          "No placement data captured (no grounds, no groundedItems); placement not evaluated. Capture ground spans + grounded-item bounds via scene.get_bounds.",
      },
    ]);
  }

  // ---- EDGE COVERAGE (outer grounds must run past the frame's edges) ----
  if (grounds.length > 0) {
    const leftmost = Math.min(...grounds.map((g) => g.minX));
    const leftOk = leftmost <= frame.minX + EPS;
    checks.push({
      id: "placement.edgeCoverage.left",
      expected: `leftmost ground minX ≤ frame minX ${frame.minX}`,
      actual: `${leftmost}`,
      status: leftOk ? "pass" : "fail",
      detail: leftOk
        ? `Leftmost ground runs to X ${leftmost} (≤ frame left edge ${frame.minX}) — it runs off-screen, no visible end.`
        : `Leftmost ground starts at X ${leftmost}, inside the frame's left edge minX ${frame.minX} — the platform end is visible; extend the boundary ground past the frame.`,
    });

    const rightmost = Math.max(...grounds.map((g) => g.maxX));
    const rightOk = rightmost >= frame.maxX - EPS;
    checks.push({
      id: "placement.edgeCoverage.right",
      expected: `rightmost ground maxX ≥ frame maxX ${frame.maxX}`,
      actual: `${rightmost}`,
      status: rightOk ? "pass" : "fail",
      detail: rightOk
        ? `Rightmost ground runs to X ${rightmost} (≥ frame right edge ${frame.maxX}) — it runs off-screen, no visible end.`
        : `Rightmost ground ends at X ${rightmost}, inside the frame's right edge maxX ${frame.maxX} — the platform end is visible; extend the boundary ground past the frame.`,
    });
  }

  // ---- GROUNDED ITEMS (visible base must sit on its surface) ----
  const defaultTol = acceptance.placement?.groundedToleranceU ?? 0.1;
  for (const item of groundedItems) {
    const tol = item.toleranceU ?? defaultTol;
    const delta = item.visibleBottomY - item.surfaceTopY;
    const id = `placement.grounded.${item.name}`;
    const expected = `visible bottom Y ≈ surface top Y (|Δ| ≤ ${tol}u)`;
    const actual = `Δ ${delta.toFixed(2)}u (bottom ${item.visibleBottomY}, surface ${item.surfaceTopY})`;

    if (Math.abs(delta) <= tol) {
      checks.push({
        id,
        expected,
        actual,
        status: "pass",
        detail: `${item.name} rests on its surface (visible bottom Y ${item.visibleBottomY} ≈ surface top Y ${item.surfaceTopY}, |Δ| ${Math.abs(delta).toFixed(2)}u ≤ ${tol}u).`,
      });
      continue;
    }

    if (delta > tol) {
      checks.push({
        id,
        expected,
        actual,
        status: "fail",
        detail: `${item.name} FLOATS ${delta.toFixed(2)}u above its surface (visible bottom Y ${item.visibleBottomY} vs surface top Y ${item.surfaceTopY}). Likely placed by transform center on the surface line; drop it so its visible base meets the surface.`,
      });
      continue;
    }

    // delta < -tol
    checks.push({
      id,
      expected,
      actual,
      status: "fail",
      detail: `${item.name} is SUNK ${Math.abs(delta).toFixed(2)}u into its surface (visible bottom Y ${item.visibleBottomY} vs surface top Y ${item.surfaceTopY}). Raise it so its visible base meets the surface.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
