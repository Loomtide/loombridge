/**
 * Color helpers for the UI-conformance gate.
 *
 * Unity reports text colors as 0–1 RGBA. The acceptance palette stores `#rrggbb`
 * hexes. We compare per-channel in 0–255 space with a small absolute tolerance
 * (default ±2/255) to absorb float/sRGB rounding.
 */

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface Rgb255 {
  r: number;
  g: number;
  b: number;
}

/** Default per-channel tolerance in 0–255 space. */
export const DEFAULT_COLOR_TOLERANCE_255 = 2;

/** Parse a `#rrggbb` (or `#rgb`) hex into 0–255 channels. Returns null if invalid. */
export function hexToRgb255(hex: string): Rgb255 | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Convert a 0–1 rgb to 0–255 (rounded). */
export function rgb01To255(c: Rgb01): Rgb255 {
  return {
    r: Math.round(clamp01(c.r) * 255),
    g: Math.round(clamp01(c.g) * 255),
    b: Math.round(clamp01(c.b) * 255),
  };
}

/** Convert a 0–255 rgb to `#rrggbb`. */
export function rgb255ToHex(c: Rgb255): string {
  const h = (n: number) => clamp255(Math.round(n)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Format a 0–1 rgba color as a `#rrggbb` hex (alpha dropped) for reporting. */
export function rgb01ToHex(c: Rgb01): string {
  return rgb255ToHex(rgb01To255(c));
}

/**
 * Does a 0–1 color match a `#rrggbb` hex within `tolerance255` per channel?
 * Returns false if the hex is unparseable.
 */
export function colorMatchesHex(
  color: Rgb01,
  hex: string,
  tolerance255: number = DEFAULT_COLOR_TOLERANCE_255,
): boolean {
  const want = hexToRgb255(hex);
  if (!want) return false;
  const got = rgb01To255(color);
  return (
    Math.abs(got.r - want.r) <= tolerance255 &&
    Math.abs(got.g - want.g) <= tolerance255 &&
    Math.abs(got.b - want.b) <= tolerance255
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
