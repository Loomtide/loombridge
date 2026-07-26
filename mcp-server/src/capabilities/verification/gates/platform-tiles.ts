/**
 * Platform-tiles gate.
 *
 * Platformer-specific structural check for tiled terrain. It catches cases where
 * a capped/grass-top tile is repeated vertically (double-cap bands), tile spans
 * are stretched to non-integer cell counts, or colliders do not line up with the
 * visible walkable surface.
 */

import type { AcceptanceContract } from "../types.js";
import { numberGateTuning } from "../gate-tuning.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export const GATE_NAME = "platform-tiles";

export type PlatformTileRole =
  | "top_cap"
  | "body_fill"
  | "left_cap"
  | "right_cap"
  | "decor"
  | "unknown";

export interface PlatformTileRow {
  index: number;
  role: PlatformTileRole;
  spriteName?: string;
}

export interface PlatformTileCapture {
  name: string;
  widthTiles?: number;
  heightTiles?: number;
  tileWidthU?: number;
  tileHeightU?: number;
  rows?: PlatformTileRow[];
  colliderTopY?: number;
  visibleTopY?: number;
}

export interface PlatformTilesInput {
  platforms?: PlatformTileCapture[];
}

function nearlyInteger(value: number, tolerance: number): boolean {
  return Math.abs(value - Math.round(value)) <= tolerance;
}

function isTopLike(role: PlatformTileRole): boolean {
  return role === "top_cap" || role === "left_cap" || role === "right_cap";
}

export function evaluatePlatformTiles(
  input: PlatformTilesInput,
  acceptance: AcceptanceContract,
): GateReport {
  const platforms = input.platforms ?? [];
  if (platforms.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "platform-tiles.data",
        expected: "≥1 platform tile construction captured",
        actual: "(none)",
        status: "warn",
        detail:
          "No platform tile data captured; tile semantics were not evaluated. Emit platform-tiles.json with rows/roles, tile counts, and collider/visible top data.",
      },
    ]);
  }

  const cfg = acceptance.platformer ?? {};
  const integerTol = numberGateTuning(acceptance, GATE_NAME, "tileIntegerTolerance") ?? cfg.tileIntegerTolerance ?? 0.01;
  const surfaceTol = numberGateTuning(acceptance, GATE_NAME, "colliderSurfaceToleranceU") ?? cfg.colliderSurfaceToleranceU ?? acceptance.placement?.groundedToleranceU ?? 0.1;
  const checks: GateCheck[] = [];

  for (const platform of platforms) {
    if (platform.widthTiles !== undefined) {
      checks.push({
        id: `platform-tiles.width.${platform.name}`,
        expected: `integer tile width (±${integerTol})`,
        actual: String(platform.widthTiles),
        status: nearlyInteger(platform.widthTiles, integerTol) ? "pass" : "fail",
        detail: nearlyInteger(platform.widthTiles, integerTol)
          ? `Platform "${platform.name}" width is an integer tile multiple.`
          : `Platform "${platform.name}" width is ${platform.widthTiles} tiles, which will stretch or gap tiles. Use whole tile multiples.`,
      });
    }

    if (platform.heightTiles !== undefined) {
      checks.push({
        id: `platform-tiles.height.${platform.name}`,
        expected: `integer tile height (±${integerTol})`,
        actual: String(platform.heightTiles),
        status: nearlyInteger(platform.heightTiles, integerTol) ? "pass" : "fail",
        detail: nearlyInteger(platform.heightTiles, integerTol)
          ? `Platform "${platform.name}" height is an integer tile multiple.`
          : `Platform "${platform.name}" height is ${platform.heightTiles} tiles, which will stretch or gap tile rows. Use whole tile multiples.`,
      });
    }

    const rows = platform.rows ?? [];
    if (rows.length === 0) {
      checks.push({
        id: `platform-tiles.rows.${platform.name}`,
        expected: "captured row roles",
        actual: "(none)",
        status: "warn",
        detail: `Platform "${platform.name}" did not capture row tile roles; cannot verify top-cap/body-fill construction.`,
      });
    } else {
      for (const row of rows) {
        const rowId = `platform-tiles.row.${platform.name}.${row.index}`;
        if (row.index === 0) {
          checks.push({
            id: rowId,
            expected: "top row is top_cap/decor/unknown or a one-row body platform",
            actual: row.role,
            status: row.role === "top_cap" || row.role === "body_fill" || row.role === "decor" || row.role === "unknown" ? "pass" : "fail",
            detail:
              row.role === "top_cap" || row.role === "body_fill" || row.role === "decor" || row.role === "unknown"
                ? `Platform "${platform.name}" top row role "${row.role}" is acceptable.`
                : `Platform "${platform.name}" top row uses "${row.role}", which is not a valid top surface role.`,
          });
        } else {
          const repeatsCap = isTopLike(row.role);
          checks.push({
            id: rowId,
            expected: "non-top rows use body_fill/decor/unknown, never capped/top tiles",
            actual: row.role,
            status: repeatsCap ? "fail" : "pass",
            detail: repeatsCap
              ? `Platform "${platform.name}" repeats capped/top tile role "${row.role}" on row ${row.index}. Thick ground must be top-cap row plus body/fill rows.`
              : `Platform "${platform.name}" row ${row.index} uses body/decor/unknown role "${row.role}" below the top row.`,
          });
        }
      }
    }

    if (platform.colliderTopY !== undefined && platform.visibleTopY !== undefined) {
      const delta = Math.abs(platform.colliderTopY - platform.visibleTopY);
      checks.push({
        id: `platform-tiles.colliderTop.${platform.name}`,
        expected: `collider top aligns to visible walkable top (|Δ| ≤ ${surfaceTol}u)`,
        actual: `|Δ| ${delta.toFixed(3)}u`,
        status: delta <= surfaceTol ? "pass" : "fail",
        detail:
          delta <= surfaceTol
            ? `Platform "${platform.name}" collider top aligns with the visible walkable surface.`
            : `Platform "${platform.name}" collider top (${platform.colliderTopY}) does not match visible top (${platform.visibleTopY}). Colliders should match the walkable surface, not the padded sprite bounds.`,
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
