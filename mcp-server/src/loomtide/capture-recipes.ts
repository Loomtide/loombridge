export type CaptureKind = "framing" | "tiles" | "console";

/**
 * Which deterministic capture recipe a slice needs, derived from its
 * acceptance.gates (not a hardcoded slice-name list). Tiles/framing recipes
 * write their own console evidence; console-clean alone uses the console-only
 * recipe.
 */
export function captureKindForSlice(gates: string[]): CaptureKind | null {
  if (gates.includes("platform-tiles") || gates.includes("tile-render")) return "tiles";
  if (gates.includes("framing")) return "framing";
  if (gates.includes("console-clean")) return "console";
  return null;
}
