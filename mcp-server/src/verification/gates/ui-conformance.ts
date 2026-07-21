/**
 * UI / asset-conformance gate (§3.1).
 *
 * INPUT: the `ui.scan_text_components` op output —
 *   `{ components: [{ name, type, fontAssetPath, fontName, color{r,g,b,a}, ... }] }`
 * ACCEPTANCE: the `fonts`, `palette`, and `hud` sections of the contract.
 *
 * CHECKS:
 *  - font: every component's `fontName` matches `fonts.global.family`
 *    (and `fonts.byRole[role]` where a HUD element maps the component to a role).
 *  - color: each mapped HUD element's color matches its `colorRole` palette hex
 *    within tolerance (compare 0–1 rgba to the `#rrggbb` ±2/255).
 *  - presence: every required HUD element is present in the scan.
 *
 * Components are mapped to HUD elements/roles by matching the component `name`
 * against the HUD element `id` (case-insensitive substring), so `ScoreLabel`
 * maps to the `score` element.
 */

import type { AcceptanceContract, HudElement } from "../types.js";
import { colorMatchesHex, rgb01ToHex } from "./color.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** A single scanned text component (subset of the op output we consume). */
export interface ScannedTextComponent {
  name: string;
  type?: string;
  fontAssetPath?: string;
  fontName?: string;
  color?: { r: number; g: number; b: number; a?: number };
  fontSize?: number;
  alignment?: string;
  anchor?: string;
  text?: string;
}

/** The `ui.scan_text_components` op output shape. */
export interface ScanTextComponentsResult {
  components: ScannedTextComponent[];
  /**
   * Optional canvas/camera render-path info, used by the `ui.hudCrispness`
   * check to catch a HUD rasterized through a pixel-perfect upscale RT (which
   * renders the HUD at the native RT resolution then upscales → blurry in play).
   */
  canvas?: {
    /** Canvas render mode, e.g. "Screen Space - Camera". */
    renderMode?: string;
    /** Name of the render camera (for the failure message). */
    cameraName?: string;
    /** Whether the render camera carries a PixelPerfectCamera component. */
    cameraHasPixelPerfect?: boolean;
    /** Whether that PixelPerfectCamera has `upscaleRT` enabled. */
    cameraUpscaleRT?: boolean;
  };
}

export const GATE_NAME = "ui-conformance";

/**
 * Normalize a font name for comparison: lowercase, strip a trailing TMP "SDF"
 * marker, then remove ALL whitespace so the compare is space-insensitive. TMP
 * asset names often drop the design family's spaces — "PressStart2P SDF" must
 * match the contract family "Press Start 2P" (both -> "pressstart2p").
 */
export function normalizeFontName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*sdf$/i, "")
    .replace(/\s+/g, "");
}

/**
 * Normalize a canvas render-mode string for comparison: lowercase, then strip
 * ALL spaces and hyphens so "Screen Space - Camera" -> "screenspacecamera".
 */
export function normalizeRenderMode(mode: string): string {
  return mode.toLowerCase().replace(/[\s-]+/g, "");
}

/** Does a scanned font satisfy the required family (TMP "SDF" suffix tolerated)? */
export function fontMatches(scanned: string | undefined, required: string): boolean {
  if (!scanned) return false;
  return normalizeFontName(scanned) === normalizeFontName(required);
}

/** Map a component to a HUD element by id-substring on the component name. */
function mapComponentToHud(
  comp: ScannedTextComponent,
  hud: HudElement[],
): HudElement | undefined {
  const lname = comp.name.toLowerCase();
  // Prefer the longest id match so "lives" beats a hypothetical "live".
  const candidates = hud
    .filter((el) => lname.includes(el.id.toLowerCase()))
    .sort((a, b) => b.id.length - a.id.length);
  return candidates[0];
}

/** Find the palette hex for a colorRole; null if no entry maps that role. */
function hexForRole(acceptance: AcceptanceContract, role: string): string | null {
  for (const entry of acceptance.palette.entries) {
    if (entry.roles.includes(role)) return entry.hex;
  }
  return null;
}

export function evaluateUiConformance(
  scan: ScanTextComponentsResult,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];
  const components = scan.components ?? [];
  const hud = acceptance.hud.elements ?? [];
  const globalFamily = acceptance.fonts.global?.family;
  const forbiddenFonts = acceptance.fonts.forbidden ?? [];

  // ---- font checks (every scanned component) ----
  for (const comp of components) {
    const forbidden = forbiddenFonts.find((font) =>
      fontMatches(comp.fontName, font.family),
    );
    if (forbidden) {
      checks.push({
        id: `fontForbidden.${comp.name}`,
        expected: `not ${forbidden.family}`,
        actual: comp.fontName ?? "(none)",
        status: "fail",
        detail: `${comp.name} uses forbidden font "${forbidden.family}"${
          forbidden.note ? ` (${forbidden.note})` : ""
        }.`,
      });
    }

    const mapped = mapComponentToHud(comp, hud);
    // Resolve the required family: per-element font > byRole > global.
    let requiredFamily = globalFamily;
    let source = "fonts.global";
    if (mapped) {
      const byRole = acceptance.fonts.byRole?.[mapped.id];
      if (mapped.font) {
        requiredFamily = mapped.font;
        source = `hud.${mapped.id}.font`;
      } else if (byRole?.family) {
        requiredFamily = byRole.family;
        source = `fonts.byRole.${mapped.id}`;
      }
    }

    if (!requiredFamily) {
      checks.push({
        id: `font.${comp.name}`,
        expected: "(a required font family)",
        actual: comp.fontName ?? "(none)",
        status: "warn",
        detail: `No required font family in acceptance (global/byRole) for ${comp.name}; cannot check.`,
      });
      continue;
    }

    const ok = fontMatches(comp.fontName, requiredFamily);
    checks.push({
      id: `font.${comp.name}`,
      expected: requiredFamily,
      actual: comp.fontName ?? "(none)",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${comp.name} uses ${requiredFamily} (${source}).`
        : `${comp.name} font is "${comp.fontName ?? "none"}", expected "${requiredFamily}" (${source}).`,
    });
  }

  // ---- color checks (components mapped to a HUD element with a colorRole) ----
  for (const comp of components) {
    const mapped = mapComponentToHud(comp, hud);
    if (!mapped?.colorRole) continue;
    const hex = hexForRole(acceptance, mapped.colorRole);
    if (!hex) {
      checks.push({
        id: `color.${comp.name}`,
        expected: `(palette role "${mapped.colorRole}")`,
        actual: comp.color ? rgb01ToHex(comp.color) : "(none)",
        status: "warn",
        detail: `colorRole "${mapped.colorRole}" for ${mapped.id} has no palette entry; cannot check.`,
      });
      continue;
    }
    if (!comp.color) {
      checks.push({
        id: `color.${comp.name}`,
        expected: hex,
        actual: "(none)",
        status: "fail",
        detail: `${comp.name} has no scanned color to compare against ${hex}.`,
      });
      continue;
    }
    const ok = colorMatchesHex(comp.color, hex);
    const actualHex = rgb01ToHex(comp.color);
    checks.push({
      id: `color.${comp.name}`,
      expected: hex,
      actual: actualHex,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${comp.name} color ${actualHex} matches ${mapped.colorRole} ${hex}.`
        : `${comp.name} color ${actualHex} != ${mapped.colorRole} ${hex}.`,
    });
  }

  // ---- presence checks (required HUD elements) ----
  for (const el of hud) {
    const required = el.required !== false;
    if (!required) continue;
    const present = components.some((c) =>
      c.name.toLowerCase().includes(el.id.toLowerCase()),
    );
    checks.push({
      id: `presence.${el.id}`,
      expected: "present",
      actual: present ? "present" : "missing",
      status: present ? "pass" : "fail",
      detail: present
        ? `Required HUD element "${el.id}" (${el.role}) is present.`
        : `Required HUD element "${el.id}" (${el.role}) is missing from the scan.`,
    });
  }

  // ---- HUD crispness (render path won't blur the HUD) ----
  const canvas = scan.canvas;
  if (!canvas) {
    checks.push({
      id: "ui.hudCrispness",
      expected: "HUD render path captured (canvas/camera info)",
      actual: "(not captured)",
      status: "warn",
      detail:
        "HUD render path not captured (canvas/camera info) — crispness not checked; capture it (see hud-kit).",
    });
  } else {
    const renderMode = canvas.renderMode ?? "";
    const isScreenSpaceCamera =
      normalizeRenderMode(renderMode) === "screenspacecamera";
    const cameraName = canvas.cameraName ?? "unknown";
    const blursHud =
      isScreenSpaceCamera &&
      canvas.cameraHasPixelPerfect === true &&
      canvas.cameraUpscaleRT === true;
    checks.push({
      id: "ui.hudCrispness",
      expected: "HUD render path won't blur the HUD",
      actual: blursHud
        ? `Screen Space - Camera through pixel-perfect upscale RT (${cameraName})`
        : `render mode "${renderMode || "(none)"}"`,
      status: blursHud ? "fail" : "pass",
      detail: blursHud
        ? `HUD renders through the pixel-perfect upscale RT (camera ${cameraName}): it's rasterized at the native RT then upscaled → blurry/soft in play. Set PixelPerfectCamera.upscaleRT=false, or move the HUD to a separate non-pixel-perfect UI camera.`
        : "HUD render path won't blur the HUD.",
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
