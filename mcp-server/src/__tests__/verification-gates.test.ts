import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateVerdict,
  bandWindow,
  colorMatchesHex,
  evaluateAssetSourceFidelity,
  evaluateConsoleClean,
  evaluateCoverage,
  evaluateFeel,
  evaluateFeelProvenance,
  evaluateFrameIntegrity,
  evaluateFraming,
  evaluateManifest,
  evaluateParallaxMotion,
  evaluatePhysicsTimestep,
  evaluatePlacement,
  evaluatePlayability,
  evaluatePlatformTiles,
  evaluateTileRender,
  evaluatePropPurpose,
  evaluateReachability,
  evaluateRenderFrame,
  evaluateUiConformance,
  evaluateVisualArtifacts,
  fontMatches,
  hexToRgb255,
  normalizeFontName,
  rgb01ToHex,
  withinBand,
  type ConsoleLogsResult,
  type CoverageInput,
  type FeelMeasurements,
  type FrameIntegrityInput,
  type GateCheck,
  type GateReport,
  type PlacementInput,
  type ParallaxMotionInput,
  type PlayabilityResults,
  type PlatformTilesInput,
  type PropPurposeInput,
  type ReachabilityLayout,
  type RenderFrameInput,
  type ScanTextComponentsResult,
  type ScreenRectsResult,
  type TileRenderInput,
  type VisualArtifactsInput,
  type VerifyManifestResult,
} from "../capabilities/verification/gates/index.js";
import type { AcceptanceContract } from "../capabilities/verification/types.js";
import { createDraftAssetManifest, type AssetManifest } from "../capabilities/assets/asset-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const acceptancePath = path.resolve(
  __dirname,
  "../../..",
  "mcp-server/src/capabilities/verification/tiderunner.acceptance.json",
);

let acceptance: AcceptanceContract;
test("load tiderunner acceptance contract", async () => {
  acceptance = JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as AcceptanceContract;
  assert.equal(acceptance.game, "tiderunner");
});

function checkById(report: GateReport, id: string): GateCheck {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `expected a check with id "${id}" in gate "${report.gate}"; got: ${report.checks.map((x) => x.id).join(", ")}`);
  return c;
}

function approvedGeneratedAssetManifest(): AssetManifest {
  const heroHash = "e".repeat(64);
  const manifest = createDraftAssetManifest({
    mode: "generated",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: heroHash },
  });
  manifest.status = "approved";
  manifest.approvedAt = "2026-06-05T00:00:00.000Z";
  manifest.assetSources = manifest.assetSources.map((source) => ({
    ...source,
    approved: true,
    license: "project-generated",
  }));
  manifest.assets = manifest.assets.map((asset) => ({
    ...asset,
    status: "approved",
    resolvedPaths: [`Assets/Art/Generated/${asset.id}.png`],
    generatedExport: {
      generatedSetId: asset.sourceId ?? "generated_set_needed",
      generator: "test-generator",
      sourceImageSha256: heroHash,
      producedAt: "2026-06-05T00:00:00.000Z",
      license: "project-generated",
      provenance: {
        origin: "hero-shot-annotation",
        annotationId: `ann-${asset.id}`,
        tool: "test",
      },
    },
  }));
  return manifest;
}

// ---------------------------------------------------------------------------
// color helpers
// ---------------------------------------------------------------------------

test("color: hexToRgb255 parses 6-digit and shorthand hex", () => {
  assert.deepEqual(hexToRgb255("#ffd166"), { r: 255, g: 209, b: 102 });
  assert.deepEqual(hexToRgb255("#fff"), { r: 255, g: 255, b: 255 });
  assert.equal(hexToRgb255("nope"), null);
});

test("color: colorMatchesHex within ±2/255 tolerance", () => {
  // #ff4d8d -> {255, 77, 141}; magenta fixture is {1, 0.302, 0.553}
  assert.ok(colorMatchesHex({ r: 1, g: 0.302, b: 0.553, a: 1 }, "#ff4d8d"));
  // cyan #4dd0e1 is NOT gold #ffd166
  assert.ok(!colorMatchesHex({ r: 0.302, g: 0.816, b: 0.882, a: 1 }, "#ffd166"));
  // exactly 2/255 off passes; 3/255 off fails
  assert.ok(colorMatchesHex({ r: 2 / 255, g: 0, b: 0 }, "#000000"));
  assert.ok(!colorMatchesHex({ r: 3 / 255, g: 0, b: 0 }, "#000000"));
});

test("color: rgb01ToHex round-trips", () => {
  assert.equal(rgb01ToHex({ r: 1, g: 0.302, b: 0.553, a: 1 }), "#ff4d8d");
});

// ---------------------------------------------------------------------------
// font helpers
// ---------------------------------------------------------------------------

test("font: normalizeFontName strips TMP SDF suffix and is space-insensitive", () => {
  assert.equal(normalizeFontName("Press Start 2P SDF"), "pressstart2p");
  assert.equal(normalizeFontName("PressStart2P SDF"), "pressstart2p");
  assert.equal(normalizeFontName("LiberationSans SDF"), "liberationsans");
});

test("font: fontMatches tolerates the SDF suffix but not a different family", () => {
  assert.ok(fontMatches("Press Start 2P SDF", "Press Start 2P"));
  assert.ok(fontMatches("Press Start 2P", "Press Start 2P"));
  assert.ok(!fontMatches("LiberationSans SDF", "Press Start 2P"));
  assert.ok(!fontMatches(undefined, "Press Start 2P"));
});

// ---------------------------------------------------------------------------
// UI conformance — REAL Tiderunner HUD scan (captured live)
// ---------------------------------------------------------------------------

const liveHudScan: ScanTextComponentsResult = {
  components: [
    {
      name: "ScoreLabel",
      type: "TMPro.TextMeshProUGUI",
      fontName: "LiberationSans SDF",
      color: { r: 0.302, g: 0.816, b: 0.882, a: 1 }, // cyan #4dd0e1
    },
    { name: "TimerLabel", fontName: "LiberationSans SDF", color: { r: 1, g: 1, b: 1, a: 1 } },
    {
      name: "LivesLabel",
      fontName: "LiberationSans SDF",
      color: { r: 1, g: 0.302, b: 0.553, a: 1 }, // magenta #ff4d8d
    },
    {
      name: "MessageLabel",
      fontName: "LiberationSans SDF",
      color: { r: 1, g: 0.816, b: 0.4, a: 1 },
    },
  ],
};

test("ui-conformance (live HUD): font FAILs for all 4 components", () => {
  const r = evaluateUiConformance(liveHudScan, acceptance);
  for (const name of ["ScoreLabel", "TimerLabel", "LivesLabel", "MessageLabel"]) {
    assert.equal(checkById(r, `font.${name}`).status, "fail", `font.${name} should FAIL`);
  }
});

test("ui-conformance (live HUD): score color FAILs (#4dd0e1 != #ffd166)", () => {
  const r = evaluateUiConformance(liveHudScan, acceptance);
  const c = checkById(r, "color.ScoreLabel");
  assert.equal(c.status, "fail");
  assert.equal(c.expected, "#ffd166");
  assert.equal(c.actual, "#4dd0e1");
});

test("ui-conformance (live HUD): lives color PASSes (#ff4d8d == hearts)", () => {
  const r = evaluateUiConformance(liveHudScan, acceptance);
  const c = checkById(r, "color.LivesLabel");
  assert.equal(c.status, "pass");
  assert.equal(c.expected, "#ff4d8d");
});

test("ui-conformance (live HUD): timer color is CHECKABLE and matches the build (#ffffff)", () => {
  // Phase F added a `timer` palette role so color.TimerLabel is a real check, not
  // an un-checkable warn. The role hex is #ffffff to match what the build renders,
  // so the live (white) timer now passes rather than false-failing against #e8eaed.
  const r = evaluateUiConformance(liveHudScan, acceptance);
  const c = checkById(r, "color.TimerLabel");
  assert.notEqual(c.status, "warn"); // no longer un-checkable
  assert.equal(c.status, "pass");
  assert.equal(c.expected, "#ffffff");
  assert.equal(c.actual, "#ffffff");
});

test("ui-conformance: font compare is space-insensitive (TMP asset names drop spaces)", () => {
  // The TMP asset is named "PressStart2P SDF" (no internal spaces) while the
  // contract family is "Press Start 2P" — they must match. Regression for the
  // re-run false-fail where all 4 HUD fonts wrongly failed.
  assert.equal(fontMatches("PressStart2P SDF", "Press Start 2P"), true);
  assert.equal(fontMatches("Press Start 2P SDF", "Press Start 2P"), true);
  assert.equal(fontMatches("LiberationSans SDF", "Press Start 2P"), false);
});

test("ui-conformance: forbidden fonts fail even when no exact font family is required", () => {
  const nonTiderunnerAcceptance: AcceptanceContract = {
    ...acceptance,
    fonts: {
      global: { family: "Inter" },
      forbidden: [{ family: "Press Start 2P", note: "Tiderunner taste leakage" }],
    },
    hud: {
      elements: [
        {
          id: "deliveries",
          role: "Delivered count",
          anchor: "top-left",
          required: true,
        },
      ],
    },
  };
  const r = evaluateUiConformance(
    {
      components: [
        {
          name: "DeliveriesLabel",
          fontName: "PressStart2P SDF",
          color: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
      canvas: { renderMode: "Screen Space - Overlay" },
    },
    nonTiderunnerAcceptance,
  );

  const c = checkById(r, "fontForbidden.DeliveriesLabel");
  assert.equal(c.status, "fail");
  assert.equal(c.expected, "not Press Start 2P");
});

test("ui-conformance (live HUD): overall verdict is fail", () => {
  const r = evaluateUiConformance(liveHudScan, acceptance);
  assert.equal(r.verdict, "fail");
});

test("ui-conformance (live HUD): required score+lives present, no missing-failures", () => {
  const r = evaluateUiConformance(liveHudScan, acceptance);
  assert.equal(checkById(r, "presence.score").status, "pass");
  assert.equal(checkById(r, "presence.lives").status, "pass");
});

// conformant fixture -> all green
const conformantHudScan: ScanTextComponentsResult = {
  components: [
    {
      name: "ScoreLabel",
      type: "TMPro.TextMeshProUGUI",
      fontName: "Press Start 2P SDF",
      color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 }, // #ffd166
    },
    {
      name: "LivesLabel",
      fontName: "Press Start 2P SDF",
      color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 }, // #ff4d8d
    },
  ],
};

// Fully-conformant fixture WITH a passing render path (canvas captured,
// upscaleRT off) so the crispness check passes and the whole gate is green.
const conformantHudScanWithCanvas: ScanTextComponentsResult = {
  ...conformantHudScan,
  canvas: {
    renderMode: "Screen Space - Camera",
    cameraName: "UICamera",
    cameraHasPixelPerfect: true,
    cameraUpscaleRT: false,
  },
};

test("ui-conformance (conformant): all font/color/presence checks pass; crispness warns (no canvas captured)", () => {
  const r = evaluateUiConformance(conformantHudScan, acceptance);
  // Every check EXCEPT the crispness one passes; crispness warns because the
  // fixture omits canvas/camera info (the additive ui.hudCrispness check).
  const crisp = checkById(r, "ui.hudCrispness");
  assert.equal(crisp.status, "warn");
  assert.match(crisp.detail, /not captured/i);
  const others = r.checks.filter((c) => c.id !== "ui.hudCrispness");
  assert.ok(others.every((c) => c.status === "pass"), JSON.stringify(others, null, 2));
  // With only the crispness warn (no fails), the gate rolls up to warn.
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// UI conformance — HUD crispness (pixel-perfect upscale-RT blur)
// ---------------------------------------------------------------------------

test("ui.hudCrispness: Screen Space - Camera through a pixel-perfect upscale RT FAILs", () => {
  // The clean-room bug: a Screen Space - Camera HUD rendered by a pixel-perfect
  // camera with upscaleRT=true is rasterized at the native RT then upscaled,
  // so the HUD reads blurry/soft in play.
  const scan: ScanTextComponentsResult = {
    ...conformantHudScan,
    canvas: {
      renderMode: "Screen Space - Camera",
      cameraName: "PixelPerfectCamera",
      cameraHasPixelPerfect: true,
      cameraUpscaleRT: true,
    },
  };
  const r = evaluateUiConformance(scan, acceptance);
  const c = checkById(r, "ui.hudCrispness");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /upscale RT/i);
  assert.match(c.detail, /PixelPerfectCamera/);
  assert.match(c.detail, /upscaleRT=false/);
});

test("ui.hudCrispness: Screen Space - Camera with upscaleRT off PASSes", () => {
  const scan: ScanTextComponentsResult = {
    ...conformantHudScan,
    canvas: {
      renderMode: "Screen Space - Camera",
      cameraName: "PixelPerfectCamera",
      cameraHasPixelPerfect: true,
      cameraUpscaleRT: false,
    },
  };
  const r = evaluateUiConformance(scan, acceptance);
  const c = checkById(r, "ui.hudCrispness");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /won't blur/i);
});

test("ui.hudCrispness: no canvas captured -> WARN (back-compat for callers without canvas)", () => {
  const r = evaluateUiConformance(conformantHudScan, acceptance);
  const c = checkById(r, "ui.hudCrispness");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not captured/i);
});

// ---------------------------------------------------------------------------
// Framing — REAL Tiderunner screen rects
// ---------------------------------------------------------------------------

// A camera block that reproduces tiderunner.acceptance.json's framing.camera —
// the raw capture writer (`loombridge capture`) enriches screen-rects.json with this.
const liveCamera = {
  name: "Main Camera",
  orthographic: true,
  // Runtime value overscans under PixelPerfect (Game view not 16:9); the gate
  // enforces authoredOrthographicSize, not this.
  orthographicSize: 5.854,
  authoredOrthographicSize: 4.5,
  position: { x: 8, y: 4.5, z: -10 },
  pixelPerfect: {
    assetsPPU: 16,
    refResolutionX: 256,
    refResolutionY: 144,
    upscaleRT: false,
    pixelSnapping: true,
  },
};

const liveScreenRects: ScreenRectsResult = {
  camera: liveCamera,
  objects: [
    { name: "Player", centerXFraction: 0.102, isPartiallyClipped: false },
    { name: "Flag", centerXFraction: 0.867, isPartiallyClipped: false },
  ],
};

test("framing (live, static camera): off-target anchor is INFORMATIONAL pass, not warn", () => {
  // The contract sets framing.cameraMode = "static" (Phase F reconcile), so the
  // 40% lead-the-look anchor does not apply per-frame: a player far from 0.40 is
  // reported as a pass with a note, never a warn.
  assert.equal(acceptance.framing.cameraMode, "static");
  const r = evaluateFraming(liveScreenRects, acceptance);
  const c = checkById(r, "anchor.player");
  assert.equal(c.status, "pass"); // 0.102 vs 0.40 but static camera -> informational pass
  assert.equal(c.actual, "0.102");
  assert.match(c.detail ?? "", /static/i);
});

test("framing (live): flag is in frame (pass), no clipping fails", () => {
  const r = evaluateFraming(liveScreenRects, acceptance);
  assert.equal(checkById(r, "clip.Flag").status, "pass");
  assert.equal(checkById(r, "clip.Player").status, "pass");
  assert.ok(!r.checks.some((c) => c.status === "fail"));
});

test("framing (live, static camera): overall verdict is pass (no anchor warn)", () => {
  const r = evaluateFraming(liveScreenRects, acceptance);
  assert.equal(r.verdict, "pass");
  assert.ok(!r.checks.some((c) => c.status === "warn"));
});

test("framing (follow camera): off-target anchor is a WARN, not informational", () => {
  // With a non-static (or absent) cameraMode the anchor check warns when off
  // target — the pre-reconcile behavior. We synthesize a follow-camera contract.
  const followAccept = {
    ...acceptance,
    framing: { ...acceptance.framing, cameraMode: "follow" as const },
  };
  const r = evaluateFraming(liveScreenRects, followAccept);
  assert.equal(checkById(r, "anchor.player").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("framing (cameraMode absent): off-target anchor still WARNs (back-compat)", () => {
  const noMode = {
    ...acceptance,
    framing: { ...acceptance.framing, cameraMode: undefined },
  };
  const r = evaluateFraming(liveScreenRects, noMode);
  assert.equal(checkById(r, "anchor.player").status, "warn");
});

test("framing (static, on-anchor) + no clipping -> pass", () => {
  const r = evaluateFraming(
    {
      camera: liveCamera,
      objects: [
        { name: "Player", centerXFraction: 0.4, isPartiallyClipped: false },
        { name: "Flag", centerXFraction: 0.85, isPartiallyClipped: false },
      ],
    },
    acceptance,
  );
  assert.equal(checkById(r, "anchor.player").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("framing (clipped player): clipping is a hard FAIL", () => {
  const r = evaluateFraming(
    {
      camera: liveCamera,
      objects: [{ name: "Player", centerXFraction: 0.0, isPartiallyClipped: true, clipSide: "left" }],
    },
    acceptance,
  );
  assert.equal(checkById(r, "clip.Player").status, "fail");
  assert.equal(r.verdict, "fail");
});

// ---------------------------------------------------------------------------
// Framing — camera check (closes the gap: a wrong camera used to pass because
// the gate only looked at the player rect)
// ---------------------------------------------------------------------------

test("framing camera (match): projection + position + ortho + pixelPerfect all pass", () => {
  const r = evaluateFraming(liveScreenRects, acceptance);
  assert.equal(checkById(r, "camera.projection").status, "pass");
  assert.equal(checkById(r, "camera.position").status, "pass");
  assert.equal(checkById(r, "camera.orthographicSize").status, "pass");
  assert.equal(checkById(r, "camera.pixelPerfect.assetsPPU").status, "pass");
  assert.equal(checkById(r, "camera.pixelPerfect.refResolution").status, "pass");
  assert.equal(checkById(r, "camera.pixelPerfect.upscaleRT").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("framing camera (orthographicSize): the AUTHORED value is enforced, runtime overscan is not a fail", () => {
  // Runtime 5.854 (overscan) but authored 4.5 == contract -> pass; the runtime
  // value is recorded but never the enforced one.
  const r = evaluateFraming(liveScreenRects, acceptance);
  const c = checkById(r, "camera.orthographicSize");
  assert.equal(c.status, "pass");
  assert.match(c.actual, /4\.5/);
  assert.match(c.actual, /overscan/i); // runtime 5.854 noted, not enforced
});

test("framing camera (wrong authored orthographicSize): hard FAIL", () => {
  const r = evaluateFraming(
    { camera: { ...liveCamera, authoredOrthographicSize: 5 }, objects: liveScreenRects.objects },
    acceptance,
  );
  assert.equal(checkById(r, "camera.orthographicSize").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("framing camera (no authored orthographicSize): degrades to WARN", () => {
  const { authoredOrthographicSize: _omit, ...camNoAuthored } = liveCamera;
  const r = evaluateFraming({ camera: camNoAuthored, objects: liveScreenRects.objects }, acceptance);
  assert.equal(checkById(r, "camera.orthographicSize").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("framing camera (perspective): projection is a hard FAIL", () => {
  const r = evaluateFraming(
    { camera: { ...liveCamera, orthographic: false }, objects: liveScreenRects.objects },
    acceptance,
  );
  assert.equal(checkById(r, "camera.projection").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("framing camera (off position): camera.position is a hard FAIL", () => {
  const r = evaluateFraming(
    { camera: { ...liveCamera, position: { x: 0, y: 0, z: -10 } }, objects: liveScreenRects.objects },
    acceptance,
  );
  assert.equal(checkById(r, "camera.position").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("framing camera (upscaleRT=true): the blurry-HUD pin is a hard FAIL", () => {
  const r = evaluateFraming(
    {
      camera: { ...liveCamera, pixelPerfect: { ...liveCamera.pixelPerfect, upscaleRT: true } },
      objects: liveScreenRects.objects,
    },
    acceptance,
  );
  assert.equal(checkById(r, "camera.pixelPerfect.upscaleRT").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("framing camera (wrong PPU / refResolution): hard FAIL", () => {
  const r = evaluateFraming(
    {
      camera: { ...liveCamera, pixelPerfect: { ...liveCamera.pixelPerfect, assetsPPU: 100, refResolutionX: 320, refResolutionY: 180 } },
      objects: liveScreenRects.objects,
    },
    acceptance,
  );
  assert.equal(checkById(r, "camera.pixelPerfect.assetsPPU").status, "fail");
  assert.equal(checkById(r, "camera.pixelPerfect.refResolution").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("framing camera (no camera block): degrades to WARN, not a false green", () => {
  const r = evaluateFraming({ objects: liveScreenRects.objects }, acceptance);
  const c = checkById(r, "camera.capture");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /loombridge capture/i);
  assert.equal(r.verdict, "warn");
});

test("framing camera (no pixelPerfect block): degrades to WARN", () => {
  const r = evaluateFraming(
    { camera: { name: "Main Camera", orthographic: true, position: { x: 8, y: 4.5, z: -10 } }, objects: liveScreenRects.objects },
    acceptance,
  );
  assert.equal(checkById(r, "camera.projection").status, "pass");
  assert.equal(checkById(r, "camera.position").status, "pass");
  assert.equal(checkById(r, "camera.pixelPerfect").status, "warn");
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("manifest (live, all_ok): PASS", () => {
  const fixture: VerifyManifestResult = { missing: [], placeholders: [], extras: [], all_ok: true };
  const r = evaluateManifest(fixture, acceptance);
  assert.equal(r.verdict, "pass");
  assert.ok(r.checks.every((c) => c.status === "pass"));
});

test("manifest: missing required -> FAIL, placeholders -> FAIL", () => {
  const fixture: VerifyManifestResult = {
    missing: [{ name: "Flag" }],
    placeholders: ["Player (placeholder sprite)"],
    extras: [],
  };
  const r = evaluateManifest(fixture, acceptance);
  assert.equal(checkById(r, "manifest.missing").status, "fail");
  assert.equal(checkById(r, "manifest.placeholders").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("manifest: extras default to WARN (extrasAreFailure false)", () => {
  const fixture: VerifyManifestResult = { missing: [], placeholders: [], extras: ["DebugCube"] };
  const r = evaluateManifest(fixture, acceptance);
  assert.equal(checkById(r, "manifest.extras").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("manifest: extras FAIL when extrasAreFailure is true", () => {
  const strict = { ...acceptance, manifest: { ...acceptance.manifest, extrasAreFailure: true } };
  const fixture: VerifyManifestResult = { missing: [], placeholders: [], extras: ["DebugCube"] };
  const r = evaluateManifest(fixture, strict);
  assert.equal(checkById(r, "manifest.extras").status, "fail");
});

test("asset-source-fidelity: approved manifest and matching observed paths pass", () => {
  const manifest = approvedGeneratedAssetManifest();
  const r = evaluateAssetSourceFidelity({
    manifest,
    observedAssets: [{
      assetId: "player_character",
      source: "generated",
      paths: ["Assets/Art/Generated/player_character.png"],
      generatedSetId: "generated_set_needed",
    }],
  });
  assert.equal(r.verdict, "pass", r.checks.filter((check) => check.status === "fail").map((check) => check.detail).join(" | "));
  assert.equal(checkById(r, "asset-source.manifest-approved").status, "pass");
  assert.equal(checkById(r, "asset-source.observed.player_character").status, "pass");
});

test("asset-source-fidelity: flags unapproved source and observed asset drift separately", () => {
  const manifest = approvedGeneratedAssetManifest();
  manifest.assetSources[0]!.approved = false;
  const r = evaluateAssetSourceFidelity({
    manifest,
    observedAssets: [{
      assetId: "player_character",
      source: "registry",
      paths: ["Assets/Art/Sprites/Characters/registry-player.png"],
      registryAssetId: "registry.player",
    }],
  });
  assert.equal(r.verdict, "fail");
  assert.equal(checkById(r, "asset-source.source-approved.generated_set_needed").status, "fail");
  assert.equal(checkById(r, "asset-source.binding.player_character").status, "fail");
  assert.equal(checkById(r, "asset-source.observed.player_character").status, "fail");
});

test("asset-source-fidelity: observed registry fallback fails without blaming composition", () => {
  const manifest = approvedGeneratedAssetManifest();
  const r = evaluateAssetSourceFidelity({
    manifest,
    observedAssets: [{
      assetId: "player_character",
      source: "registry",
      paths: ["Assets/Art/Sprites/Characters/registry-player.png"],
    }],
  });
  assert.equal(r.verdict, "fail");
  assert.equal(checkById(r, "asset-source.observed.player_character").status, "fail");
  assert.match(checkById(r, "asset-source.observed.player_character").detail, /differs from the manifest source or paths/);
});

// ---------------------------------------------------------------------------
// Playability — the all-fruit-vs-reach-flag mismatch
// ---------------------------------------------------------------------------

test("playability (live build): all-fruit is now the ACCEPTED rule -> PASS", () => {
  // Phase F reconcile: win.rule = "all-fruit" (the build's score>=totalCoins is
  // the accepted rule), so the observed all-fruit win now conforms.
  const results: PlayabilityResults = {
    completable: true,
    completionMethod: "played", // completed by movement, not a teleport
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  const c = checkById(r, "playability.winRule");
  assert.equal(c.status, "pass"); // observed all-fruit == accepted all-fruit
  assert.equal(c.expected, "all-fruit");
  assert.equal(c.actual, "all-fruit");
  assert.equal(checkById(r, "playability.completable").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("playability: a divergent win rule (reach-flag) FAILs against accepted all-fruit", () => {
  // If a build instead fired the win by reaching the flag (diverging from the
  // accepted all-fruit rule), the gate flags it.
  const results: PlayabilityResults = {
    completable: true,
    winRuleObserved: "reach-flag",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  const c = checkById(r, "playability.winRule");
  assert.equal(c.status, "fail");
  assert.equal(c.expected, "all-fruit");
  assert.equal(c.actual, "reach-flag");
  assert.equal(r.verdict, "fail");
});

test("playability: not completable FAILs; unobserved fields WARN", () => {
  const results: PlayabilityResults = { completable: false };
  const r = evaluatePlayability(results, acceptance);
  assert.equal(checkById(r, "playability.completable").status, "fail");
  assert.equal(checkById(r, "playability.hazardKills").status, "warn");
  assert.equal(checkById(r, "playability.collectibleIncrements").status, "warn");
  assert.equal(checkById(r, "playability.winRule").status, "warn");
  assert.equal(r.verdict, "fail");
});

test("playability: completionMethod 'teleported' downgrades completable to WARN", () => {
  // Completion proven by teleport proves the win logic, not traversal — so the
  // completable check warns (reachability is verified by the reachability gate).
  const results: PlayabilityResults = {
    completable: true,
    completionMethod: "teleported",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  const c = checkById(r, "playability.completable");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /teleport/i);
  assert.match(c.detail, /reachability/i);
});

test("playability: completionMethod 'played' PASSes completable", () => {
  const results: PlayabilityResults = {
    completable: true,
    completionMethod: "played",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  assert.equal(checkById(r, "playability.completable").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("playability: completable true but completionMethod absent -> WARN (capture it)", () => {
  const results: PlayabilityResults = {
    completable: true,
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  const c = checkById(r, "playability.completable");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not recorded/i);
});

test("playability: modal end-state failures FAIL when gameplay keeps running behind overlay", () => {
  const results: PlayabilityResults = {
    completable: true,
    completionMethod: "played",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: false,
    postWinPlayerFrozen: false,
    restartWorks: true,
  };
  const r = evaluatePlayability(results, acceptance);
  assert.equal(checkById(r, "playability.postWinInputLocked").status, "fail");
  assert.equal(checkById(r, "playability.postWinPlayerFrozen").status, "fail");
  assert.equal(checkById(r, "playability.restartWorks").status, "pass");
  assert.equal(r.verdict, "fail");
});

test("playability: continuous end-state contract skips modal freeze checks", () => {
  const results: PlayabilityResults = {
    completable: true,
    completionMethod: "played",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
  };
  const r = evaluatePlayability(results, {
    ...acceptance,
    win: { ...acceptance.win, endStateMode: "continuous" },
  });
  assert.equal(checkById(r, "playability.endStateMode").status, "pass");
  assert.equal(r.checks.some((c) => c.id === "playability.postWinInputLocked"), false);
  assert.equal(r.verdict, "pass");
});

// ---------------------------------------------------------------------------
// Reachability — closes the teleport-completion hole (geometric envelope)
// ---------------------------------------------------------------------------

test("reachability: an out-of-envelope collectible FAILs (y too high)", () => {
  // Platforms top out at y=4; jumpApex 2.2 + vMargin 0.5 -> max reach ~6.7.
  // A collectible at y=8 is unreachable even though a teleport could place it.
  const layout: ReachabilityLayout = {
    platforms: [
      { name: "Ground", topY: 3, minX: -2, maxX: 10 },
      { name: "Ledge", topY: 4, minX: 4, maxX: 8 },
    ],
    collectibles: [{ name: "FloatingApple", x: 6, y: 8 }],
  };
  const r = evaluateReachability(layout, acceptance);
  const c = checkById(r, "reach.FloatingApple");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /exceeds max reach/i);
  assert.equal(r.verdict, "fail");
});

test("reachability: a within-envelope collectible PASSes (names its platform)", () => {
  const layout: ReachabilityLayout = {
    platforms: [
      { name: "Ground", topY: 3, minX: -2, maxX: 10 },
      { name: "Ledge", topY: 4, minX: 4, maxX: 8 },
    ],
    collectibles: [{ name: "Apple", x: 6, y: 5 }],
  };
  const r = evaluateReachability(layout, acceptance);
  const c = checkById(r, "reach.Apple");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /reachable from/i);
  assert.equal(r.verdict, "pass");
});

test("reachability: a launcher extends vertical reach", () => {
  // No platform reaches y=8, but a trampoline with launchApex 6 (topY 0 +6+0.5)
  // does, and the collectible sits directly above it.
  const layout: ReachabilityLayout = {
    platforms: [{ name: "Ground", topY: 0, minX: -2, maxX: 2 }],
    launchers: [{ name: "Trampoline", x: 5, topY: 0, launchApex: 6 }],
    collectibles: [{ name: "HighApple", x: 5, y: 6 }],
  };
  const r = evaluateReachability(layout, acceptance);
  const c = checkById(r, "reach.HighApple");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /launcher/i);
});

test("reachability: empty collectibles -> single WARN", () => {
  const layout: ReachabilityLayout = {
    platforms: [{ name: "Ground", topY: 0, minX: -2, maxX: 10 }],
    collectibles: [],
  };
  const r = evaluateReachability(layout, acceptance);
  assert.equal(r.checks.length, 1);
  assert.equal(checkById(r, "reachability.collectibles").status, "warn");
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// Coverage — catches a parallax seam that exposes the camera background
// ---------------------------------------------------------------------------

const cameraFrame = { minX: 0, maxX: 16, minY: 0, maxY: 9 };

// ---- single-frame (back-compat) ----

test("coverage (single-frame): a drifted Sky that no longer covers the left edge FAILs", () => {
  const input: CoverageInput = {
    cameraFrame,
    layers: [{ name: "Sky", minX: 0.4, maxX: 16, minY: 0, maxY: 9 }],
    atSeconds: 8,
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /left edge/i);
  assert.match(c.detail, /t=8s/);
  // Back-compat note: continuity NOT checked (no trajectory) -> recommend a capture.
  assert.match(c.detail, /continuity was NOT checked/i);
  assert.equal(r.verdict, "fail");
});

test("coverage (single-frame): a fully-covering Sky PASSes (with no-trajectory note)", () => {
  const input: CoverageInput = {
    cameraFrame,
    layers: [
      { name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 },
      // Hills is coversBottom in the contract; include a floor-reaching capture
      // so its bottom check passes and the gate rolls up to pass.
      { name: "Hills", minX: -1, maxX: 17, minY: -1, maxY: 7 },
    ],
    atSeconds: 8,
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /continuity was NOT checked/i);
  assert.equal(r.verdict, "pass");
});

test("coverage: Sky not captured -> WARN", () => {
  const input: CoverageInput = {
    cameraFrame,
    layers: [{ name: "Hills", minX: 0.4, maxX: 16, minY: 0, maxY: 9 }],
    atSeconds: 8,
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not captured/i);
  assert.equal(r.verdict, "warn");
});

// ---- trajectory (preferred) ----

/**
 * The REAL clean-room sawtooth: a 24u-wide Sky sprite (bounds = centerX ± 12)
 * drifts smoothly 10.0 -> 8.06, then SNAPS to 15.98 (+7.92u teleport), repeating.
 * cameraFrame is {0,16,0,9}. With center ~8.06 the sprite spans [-3.94, 20.06] so
 * it still covers the frame on that worst smooth frame — meaning a SINGLE frame
 * could pass — but the +7.92u snap is a discontinuity the trajectory gate catches.
 */
function sawtoothSky(): CoverageInput {
  const centers = [10.0, 9.5, 9.0, 8.5, 8.06, 15.98, 15.5, 15.0, 14.5, 14.0];
  return {
    cameraFrame,
    cycleSeconds: 13,
    layers: [
      {
        name: "Sky",
        samples: centers.map((c, i) => ({
          tMs: i * 1500,
          minX: c - 12,
          maxX: c + 12,
          minY: -1,
          maxY: 10,
        })),
      },
    ],
  };
}

test("coverage (trajectory): the real sawtooth FAILs (teleport snap, or exposed sample)", () => {
  const r = evaluateCoverage(sawtoothSky(), acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "fail");
  // The failure is either an exposed sample OR the +7.92u teleport — both are real.
  assert.match(c.detail, /teleported|exposed|discontinuity/i);
  assert.equal(r.verdict, "fail");
});

test("coverage (trajectory): the real sawtooth exposes a frame edge at the snap sample", () => {
  // At the snap center 15.98 the 24u sprite spans [3.98, 27.98] -> left edge of
  // the {0,16} frame is exposed (minX 3.98 > 0). Coverage is checked before
  // continuity, so this exposed sample (tMs=7500, the snap) trips FIRST.
  const r = evaluateCoverage(sawtoothSky(), acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /exposed at tMs=7500/);
  assert.match(c.detail, /left edge/i);
});

test("coverage (trajectory): a teleport that still covers every frame trips CONTINUITY only", () => {
  // A 24u sprite (center ± 12) covers the {0,16} frame for any center in [4,12].
  // Drift 12 -> 10.4 smoothly (1.6u steps, within threshold), then SNAP 10.4 -> 4
  // (Δ6.4u). EVERY sample still covers the frame, so coverage passes — but the
  // 6.4u snap is a teleport the CONTINUITY check catches.
  const centers = [12.0, 10.4, 4.0, 5.6, 7.2];
  const input: CoverageInput = {
    cameraFrame,
    cycleSeconds: 13,
    layers: [
      {
        name: "Sky",
        samples: centers.map((c, i) => ({
          tMs: i * 1500,
          minX: c - 12,
          maxX: c + 12,
          minY: -1,
          maxY: 10,
        })),
      },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /discontinuity at tMs=3000/); // 10.4 -> 4 snap, 3rd sample
  assert.match(c.detail, /6\.40u/);
  assert.match(c.detail, /teleported/i);
  assert.equal(r.verdict, "fail");
});

test("coverage (trajectory): a static texture-offset backdrop PASSes (covers every sample, continuous)", () => {
  // A static-quad scrolling-texture layer: the GameObject bounds never move
  // (texture offset scrolls, transform does not), so centerX is constant and
  // every sample fully covers the frame.
  const input: CoverageInput = {
    cameraFrame,
    cycleSeconds: 13,
    layers: [
      {
        name: "Sky",
        samples: [0, 2000, 4000, 6000, 8000, 10000, 12000].map((tMs) => ({
          tMs,
          minX: -2,
          maxX: 18,
          minY: -1,
          maxY: 10,
        })),
      },
      {
        // Hills is coversBottom in the contract; a static floor-reaching layer
        // passes the bottom check so the whole gate rolls up to pass.
        name: "Hills",
        samples: [0, 2000, 4000, 6000, 8000, 10000, 12000].map((tMs) => ({
          tMs,
          minX: -2,
          maxX: 18,
          minY: -1,
          maxY: 7,
        })),
      },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Sky");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /across the full 7-sample cycle/);
  assert.match(c.detail, /continuous/);
  assert.equal(r.verdict, "pass");
});

test("coverage (trajectory): per-sample cameraFrame (camera-follow) is honored", () => {
  // The frame follows the player; the backdrop must cover EACH per-sample frame.
  // Here every layer-vs-frame pair covers AND moves together within threshold.
  const input: CoverageInput = {
    cameraFrame,
    layers: [
      {
        name: "Sky",
        samples: [
          { tMs: 0, minX: -2, maxX: 18, minY: -1, maxY: 10, cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 } },
          { tMs: 1000, minX: -1, maxX: 19, minY: -1, maxY: 10, cameraFrame: { minX: 1, maxX: 17, minY: 0, maxY: 9 } },
        ],
      },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  assert.equal(checkById(r, "coverage.Sky").status, "pass");
});

// ---- bottom-coverage (catches a backdrop's cropped bottom edge in-frame) ----

test("coverage (bottom): the REAL Hills crop FAILs (minY above the pit floor)", () => {
  // The clean-room bug: the camera frame floor is minY -0.66 but Hills bottoms
  // out at minY 2.2 — its cropped bottom edge shows a band of camera background
  // in the pit. Hills is coversBottom (not coversFrame — it's a silhouette).
  const input: CoverageInput = {
    cameraFrame: { minX: -1.45, maxX: 17.45, minY: -0.66, maxY: 9.66 },
    cycleSeconds: 6,
    layers: [
      {
        name: "Sky",
        samples: [{ tMs: 0, minX: -4, maxX: 20, minY: -2, maxY: 11 }],
      },
      {
        name: "Hills",
        samples: [{ tMs: 0, minX: -4, maxX: 20, minY: 2.2, maxY: 8.2 }],
      },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Hills.bottom");
  assert.equal(c.status, "fail");
  assert.equal(c.actual, "Hills minY 2.2 > frame minY -0.66 (bottom crop exposed)");
  assert.match(c.detail, /bottom crop|band of camera background/i);
  assert.equal(r.verdict, "fail");
});

test("coverage (bottom): a Hills layer that reaches below the floor PASSes", () => {
  const input: CoverageInput = {
    cameraFrame: { minX: -1.45, maxX: 17.45, minY: -0.66, maxY: 9.66 },
    layers: [
      { name: "Sky", samples: [{ tMs: 0, minX: -4, maxX: 20, minY: -2, maxY: 11 }] },
      { name: "Hills", samples: [{ tMs: 0, minX: -4, maxX: 20, minY: -1, maxY: 8.2 }] },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Hills.bottom");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /never exposed/i);
});

test("coverage (bottom): single-frame Hills above the floor FAILs", () => {
  // Back-compat single-frame form (no samples) is bottom-checked too.
  const input: CoverageInput = {
    cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 },
    layers: [
      { name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 },
      { name: "Hills", minX: -1, maxX: 17, minY: 1.5, maxY: 7 },
    ],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Hills.bottom");
  assert.equal(c.status, "fail");
  assert.match(c.actual, /minY 1\.5 > frame minY 0/);
});

test("coverage (bottom): a coversBottom layer absent from capture -> WARN", () => {
  const input: CoverageInput = {
    cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 },
    layers: [{ name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 }],
  };
  const r = evaluateCoverage(input, acceptance);
  const c = checkById(r, "coverage.Hills.bottom");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not captured/i);
});

// ---------------------------------------------------------------------------
// Console-clean — runtime warnings/errors a green build ignored
// ---------------------------------------------------------------------------

test("console-clean: an Error/Exception entry FAILs", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      { type: "log", message: "started" },
      { type: "error", message: "NullReferenceException: Object reference not set" },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  const c = checkById(r, "console-clean.errors");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /NullReference/);
  assert.equal(r.verdict, "fail");
});

test("console-clean: the REAL PixelPerfect odd-resolution WARNING FAILs (rendering)", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      {
        type: "warning",
        message:
          "Rendering at an odd-numbered resolution (1281x720). Pixel Perfect Camera may not work properly in this situation.",
      },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  const c = checkById(r, "console-clean.rendering");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /visual artifact/i);
  assert.match(c.detail, /odd/i);
  assert.equal(r.verdict, "fail");
  // It's a rendering FAIL, not a benign warn.
  assert.ok(!r.checks.some((x) => x.id === "console-clean.warnings"));
});

test("console-clean: a benign warning WARNs (not fail)", () => {
  const logs: ConsoleLogsResult = {
    logs: [{ type: "warning", message: "Sprite atlas not preloaded; minor hitch." }],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  const c = checkById(r, "console-clean.warnings");
  assert.equal(c.status, "warn");
  assert.equal(r.verdict, "warn");
  assert.ok(!r.checks.some((x) => x.status === "fail"));
});

test("console-clean: the IPC-fallback infra warning is allowlisted → PASS (never fails, even strict)", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      { type: "log", message: "started" },
      {
        type: "warning",
        message:
          "[Loombridge] IPC transport unavailable in auto mode; fallback to tcp. reason: Unix domain socket API is unavailable on this runtime",
      },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  const c = checkById(r, "console-clean.infra");
  assert.equal(c.status, "pass");
  // It is NOT classified as a build-breaking warning, and nothing fails.
  assert.ok(!r.checks.some((x) => x.id === "console-clean.warnings"));
  assert.ok(!r.checks.some((x) => x.status === "fail"));
  assert.equal(r.verdict, "pass");
});

test("console-clean: a NON-allowlisted warning alongside the infra warning still WARNs (allowlist is narrow)", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      { type: "warning", message: "IPC transport unavailable; fallback to tcp" },
      { type: "warning", message: "Your gameplay script left a dangling coroutine." },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  assert.equal(checkById(r, "console-clean.infra").status, "pass");
  assert.equal(checkById(r, "console-clean.warnings").status, "warn");
  assert.match(checkById(r, "console-clean.warnings").detail, /dangling coroutine/);
  assert.equal(r.verdict, "warn");
});

test("console-clean: a warning containing only fallback-to-tcp wording is NOT allowlisted", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      { type: "warning", message: "Gameplay network fallback to tcp timed out while spawning pickups." },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  assert.ok(!r.checks.some((x) => x.id === "console-clean.infra"));
  assert.equal(checkById(r, "console-clean.warnings").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("console-clean: a real Error is NOT excused by an infra warning being present (startup error still FAILs)", () => {
  const logs: ConsoleLogsResult = {
    logs: [
      // The infra warning is in the (preserved) startup phase...
      { type: "warning", message: "IPC transport unavailable; fallback to tcp" },
      // ...but a real Awake/Start error must still fail the build.
      { type: "error", message: "NullReferenceException in PlayerController.Awake" },
    ],
  };
  const r = evaluateConsoleClean(logs, acceptance);
  assert.equal(checkById(r, "console-clean.errors").status, "fail");
  assert.match(checkById(r, "console-clean.errors").detail, /NullReference/);
  assert.equal(r.verdict, "fail");
});

test("console-clean: a clean console PASSes (bare array tolerated)", () => {
  const r = evaluateConsoleClean([{ type: "log", message: "ok" }], acceptance);
  const c = checkById(r, "console-clean.clean");
  assert.equal(c.status, "pass");
  assert.equal(r.verdict, "pass");
});

test("console-clean: missing/uncapturable input -> WARN (degrade)", () => {
  const r = evaluateConsoleClean({} as ConsoleLogsResult, acceptance);
  // empty logs array -> clean PASS; an entirely absent logs is treated as clean.
  // To test the degrade path, pass a non-array logs.
  const degraded = evaluateConsoleClean(
    { logs: "nope" as unknown as [] } as ConsoleLogsResult,
    acceptance,
  );
  assert.equal(checkById(degraded, "console-clean.input").status, "warn");
  // An empty console is genuinely clean.
  assert.equal(r.verdict, "pass");
});

// ---------------------------------------------------------------------------
// Prop-purpose — purposeless / player-clipping props
// ---------------------------------------------------------------------------

const propPlayer = { name: "Player", bounds: { minX: 0, maxX: 1, minY: 0, maxY: 2 } };

function propAcceptance(overrides: Partial<AcceptanceContract["props"]> = {}): AcceptanceContract {
  return { ...acceptance, props: { checkPlayerOverlap: true, ...overrides } };
}

test("prop-purpose: a decor box (no collider/script) overlapping the player FAILs BOTH rules", () => {
  // The clean-room bug: a decorative box at spawn with no gameplay role, clipping
  // the player. Both the purpose rule and the player-overlap rule fail.
  const input: PropPurposeInput = {
    player: propPlayer,
    props: [
      { name: "DecorBox", bounds: { minX: 0.5, maxX: 1.5, minY: 0.5, maxY: 1.5 }, hasCollider: false, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  assert.equal(checkById(r, "prop-purpose.DecorBox").status, "fail");
  assert.match(checkById(r, "prop-purpose.DecorBox").detail, /purposeless prop/i);
  assert.equal(checkById(r, "prop-overlap.DecorBox").status, "fail");
  assert.match(checkById(r, "prop-overlap.DecorBox").detail, /overlaps the player/i);
  assert.equal(r.verdict, "fail");
});

test("prop-purpose: the same box listed in intentionalDecor and clear of the player PASSes", () => {
  const accept = propAcceptance({ intentionalDecor: ["DecorBox"] });
  const input: PropPurposeInput = {
    player: propPlayer,
    props: [
      { name: "DecorBox", bounds: { minX: 5, maxX: 6, minY: 0, maxY: 1 }, hasCollider: false, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, accept);
  assert.equal(checkById(r, "prop-purpose.DecorBox").status, "pass");
  assert.match(checkById(r, "prop-purpose.DecorBox").detail, /intentional decor/i);
  assert.equal(checkById(r, "prop-overlap.DecorBox").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("prop-purpose: a collectible (scripts [Collectible]) PASSes the purpose rule", () => {
  const input: PropPurposeInput = {
    player: propPlayer,
    props: [
      { name: "Apple1", bounds: { minX: 8, maxX: 9, minY: 1, maxY: 2 }, hasCollider: false, scripts: ["Collectible"] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  const c = checkById(r, "prop-purpose.Apple1");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /Collectible/);
  assert.equal(checkById(r, "prop-overlap.Apple1").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("prop-purpose: missing capture (no props) -> single WARN", () => {
  const r = evaluatePropPurpose({ player: propPlayer, props: [] }, propAcceptance());
  assert.equal(r.checks.length, 1);
  assert.equal(checkById(r, "prop-purpose.data").status, "warn");
  assert.equal(r.verdict, "warn");
});

// --- GROUNDING: a collider-bearing prop dodged purpose+overlap but floats ---

// One ground span the floating-prop cases reason against.
const propGrounds = [{ name: "Ground", minX: 0, maxX: 20, topY: 1 }];

test("prop-purpose (grounding): a collider box floating above all grounds FAILs (prop-grounded)", () => {
  // The live dodge: a decorative box given a Collider2D (passes purpose) and moved
  // off spawn (passes overlap), then parked floating near the flag, base above ground.
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      // bottom (minY 5) far above the ground top (1) -> floats.
      { name: "FloatBox", bounds: { minX: 10, maxX: 11, minY: 5, maxY: 6 }, hasCollider: true, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  // Purpose + overlap still pass (it has a collider, clear of player).
  assert.equal(checkById(r, "prop-purpose.FloatBox").status, "pass");
  assert.equal(checkById(r, "prop-overlap.FloatBox").status, "pass");
  // Grounding catches it.
  const g = checkById(r, "prop-grounded.FloatBox");
  assert.equal(g.status, "fail");
  assert.match(g.detail, /float/i);
  assert.equal(r.verdict, "fail");
});

test("prop-purpose (grounding): the same box resting on the ground (bottom ≈ topY) PASSes", () => {
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      // bottom (minY 1.05) within 0.1u of the ground top (1) and over [0,20] -> rests.
      { name: "FloatBox", bounds: { minX: 10, maxX: 11, minY: 1.05, maxY: 2.05 }, hasCollider: true, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  const g = checkById(r, "prop-grounded.FloatBox");
  assert.equal(g.status, "pass");
  assert.match(g.detail, /rests on/i);
  assert.equal(r.verdict, "pass");
});

test("prop-purpose (grounding): a box listed in intentionalFloating is exempt and PASSes", () => {
  const accept = propAcceptance({ intentionalFloating: ["FloatBox"] });
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      // floats, but it's a deliberate floating object.
      { name: "FloatBox", bounds: { minX: 10, maxX: 11, minY: 5, maxY: 6 }, hasCollider: true, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, accept);
  // No grounding check emitted for an exempt prop.
  assert.ok(!r.checks.some((c) => c.id === "prop-grounded.FloatBox"));
  assert.equal(r.verdict, "pass");
});

test("prop-purpose (grounding): no grounds captured -> grounding check skipped (back-compat)", () => {
  const input: PropPurposeInput = {
    player: propPlayer,
    // grounds intentionally absent.
    props: [
      { name: "FloatBox", bounds: { minX: 10, maxX: 11, minY: 5, maxY: 6 }, hasCollider: true, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  // Purpose + overlap still run; grounding is entirely skipped.
  assert.equal(checkById(r, "prop-purpose.FloatBox").status, "pass");
  assert.ok(!r.checks.some((c) => c.id === "prop-grounded.FloatBox"));
  assert.equal(r.verdict, "pass");
});

test("prop-purpose (grounding): bottomY overrides bounds.minY for the float check", () => {
  // bounds.minY would say grounded, but the explicit collider bottomY floats.
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      { name: "FloatBox", bounds: { minX: 10, maxX: 11, minY: 1.0, maxY: 6 }, bottomY: 5, hasCollider: true, scripts: [] },
    ],
  };
  const r = evaluatePropPurpose(input, propAcceptance());
  assert.equal(checkById(r, "prop-grounded.FloatBox").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("prop-purpose (semantic): a collider-only prop fails when no gameplay role/evidence exists", () => {
  const accept = propAcceptance({
    purposes: [{ nameRegex: "RouteBox", purpose: "route_platform" }],
  });
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      {
        name: "RouteBox",
        bounds: { minX: 10, maxX: 11, minY: 1, maxY: 2 },
        hasCollider: true,
        scripts: [],
      },
    ],
  };
  const r = evaluatePropPurpose(input, accept);
  assert.equal(checkById(r, "prop-purpose.RouteBox").status, "pass");
  assert.equal(checkById(r, "prop-semantic.RouteBox").status, "fail");
  assert.match(checkById(r, "prop-semantic.RouteBox").detail, /lacks the required evidence/i);
  assert.equal(r.verdict, "fail");
});

test("prop-purpose (semantic): a route platform with traversal evidence passes", () => {
  const accept = propAcceptance({
    purposes: [{ nameRegex: "RouteBox", purpose: "route_platform" }],
  });
  const input: PropPurposeInput = {
    player: propPlayer,
    grounds: propGrounds,
    props: [
      {
        name: "RouteBox",
        bounds: { minX: 10, maxX: 11, minY: 1, maxY: 2 },
        hasCollider: true,
        scripts: [],
        routeEvidence: { usedInTraversal: true, connectsTo: "Flag" },
      },
    ],
  };
  const r = evaluatePropPurpose(input, accept);
  assert.equal(checkById(r, "prop-semantic.RouteBox").status, "pass");
  assert.equal(r.verdict, "pass");
});

// ---------------------------------------------------------------------------
// Render-frame / visual-artifacts / platform-tiles — screenshot + tile checks
// ---------------------------------------------------------------------------

test("render-frame: black bars fail full-viewport contract", () => {
  const input: RenderFrameInput = {
    frames: [
      {
        id: "jump",
        width: 1920,
        height: 1080,
        edgeBlackFraction: { left: 0.12, right: 0.12, top: 0, bottom: 0 },
        contentRect: { x: 230, y: 0, width: 1460, height: 1080 },
      },
    ],
  };
  const r = evaluateRenderFrame(input, acceptance);
  assert.equal(checkById(r, "render-frame.viewport.jump").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("render-frame: full-bleed frame passes", () => {
  const input: RenderFrameInput = {
    frames: [
      {
        id: "spawn",
        width: 1920,
        height: 1080,
        edgeBlackFraction: { left: 0, right: 0, top: 0, bottom: 0 },
        uniformBorderFraction: { left: 0.005, right: 0.005, top: 0, bottom: 0 },
        contentRect: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ],
  };
  const r = evaluateRenderFrame(input, acceptance);
  assert.equal(checkById(r, "render-frame.viewport.spawn").status, "pass");
  assert.equal(checkById(r, "render-frame.content.spawn").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("visual-artifacts: a jump-only long horizontal seam fails", () => {
  const input: VisualArtifactsInput = {
    frames: [
      { id: "jump", longLines: [{ orientation: "horizontal", lengthFraction: 0.96, y: 440, classification: "background_seam" }] },
    ],
    comparisons: [{ from: "spawn", to: "jump", movedLine: true }],
  };
  const r = evaluateVisualArtifacts(input, acceptance);
  assert.equal(checkById(r, "visual-artifacts.line.jump.0").status, "fail");
  assert.equal(checkById(r, "visual-artifacts.movingLine.spawn->jump").status, "fail");
});

test("visual-artifacts: expected platform edges pass, unclassified long lines warn", () => {
  const input: VisualArtifactsInput = {
    frames: [
      {
        id: "spawn",
        longLines: [
          { orientation: "horizontal", lengthFraction: 0.98, y: 325, classification: "platform_edge" },
          { orientation: "horizontal", lengthFraction: 0.97, y: 390, classification: "unknown" },
        ],
      },
    ],
  };
  const r = evaluateVisualArtifacts(input, acceptance);
  assert.equal(checkById(r, "visual-artifacts.line.spawn.0").status, "pass");
  assert.match(checkById(r, "visual-artifacts.line.spawn.0").detail, /expected geometry/i);
  assert.equal(checkById(r, "visual-artifacts.line.spawn.1").status, "warn");
  assert.match(checkById(r, "visual-artifacts.line.spawn.1").detail, /unclassified/i);
  assert.equal(r.verdict, "warn");
});

test("platform-tiles: repeated top-cap row below row 0 fails", () => {
  const input: PlatformTilesInput = {
    platforms: [
      {
        name: "Ground",
        widthTiles: 12,
        heightTiles: 3,
        visibleTopY: 1,
        colliderTopY: 1,
        rows: [
          { index: 0, role: "top_cap" },
          { index: 1, role: "top_cap" },
          { index: 2, role: "body_fill" },
        ],
      },
    ],
  };
  const r = evaluatePlatformTiles(input, acceptance);
  assert.equal(checkById(r, "platform-tiles.row.Ground.1").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("platform-tiles: top-cap plus body rows and aligned collider passes", () => {
  const input: PlatformTilesInput = {
    platforms: [
      {
        name: "Ground",
        widthTiles: 12,
        heightTiles: 3,
        visibleTopY: 1,
        colliderTopY: 1.03,
        rows: [
          { index: 0, role: "top_cap" },
          { index: 1, role: "body_fill" },
          { index: 2, role: "body_fill" },
        ],
      },
    ],
  };
  const r = evaluatePlatformTiles(input, acceptance);
  assert.equal(r.verdict, "pass");
});

test("platform-tiles: gateTuning overrides legacy platformer tolerances", () => {
  const tuned = {
    ...acceptance,
    platformer: { tileIntegerTolerance: 0.01 },
    gateTuning: { byGate: { "platform-tiles": { tileIntegerTolerance: 0.5 } } },
  } as AcceptanceContract;
  const input: PlatformTilesInput = {
    platforms: [{ name: "Ground", widthTiles: 12.25, rows: [{ index: 0, role: "top_cap" }] }],
  };
  const r = evaluatePlatformTiles(input, tuned);
  assert.equal(checkById(r, "platform-tiles.width.Ground").status, "pass");
});

// ---------------------------------------------------------------------------
// Tile-render — renderer count + drawMode + raw luma seam check
// ---------------------------------------------------------------------------

function tileRenderInput(overrides: Partial<NonNullable<TileRenderInput["platforms"]>[number]> = {}): TileRenderInput {
  return {
    platforms: [
      {
        name: "Ground",
        drawMode: "Tiled",
        rendererCount: 1,
        widthTiles: 8,
        tileSprite: {
          name: "ground_tile",
          tileWidthPx: 16,
          edgeCols: 2,
          columnLuma: [0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41],
        },
        ...overrides,
      },
    ],
  };
}

test("tile-render: clean seamless tiled span passes", () => {
  const r = evaluateTileRender(tileRenderInput(), acceptance);
  assert.equal(checkById(r, "tile-render.drawmode.Ground").status, "pass");
  assert.equal(checkById(r, "tile-render.renderers.Ground").status, "pass");
  assert.equal(checkById(r, "tile-render.seam.Ground").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("tile-render: per-tile renderers fail renderer-count check", () => {
  const r = evaluateTileRender(tileRenderInput({ rendererCount: 8 }), acceptance);
  assert.equal(checkById(r, "tile-render.renderers.Ground").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("tile-render: gateTuning overrides legacy platformer renderer cap", () => {
  const tuned = {
    ...acceptance,
    platformer: { tileRenderMaxRenderers: 2 },
    gateTuning: { byGate: { "tile-render": { tileRenderMaxRenderers: 6 } } },
  } as AcceptanceContract;
  const r = evaluateTileRender(tileRenderInput({ rendererCount: 4 }), tuned);
  assert.equal(checkById(r, "tile-render.renderers.Ground").status, "pass");
});

test("tile-render: Simple drawMode on a wide span fails", () => {
  const r = evaluateTileRender(tileRenderInput({ drawMode: "Simple" }), acceptance);
  assert.equal(checkById(r, "tile-render.drawmode.Ground").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("tile-render: symmetric border band fails edge-vs-interior seam metric", () => {
  // This is the RUN-2 blind spot: leftEdge ≈ rightEdge, so a left-vs-right test
  // would pass, but both edges are far brighter than the interior and repeat at
  // every tile|tile junction.
  const r = evaluateTileRender(
    tileRenderInput({
      tileSprite: {
        name: "bordered",
        tileWidthPx: 16,
        edgeCols: 2,
        columnLuma: [0.82, 0.80, 0.40, 0.41, 0.40, 0.39, 0.40, 0.41, 0.40, 0.39, 0.40, 0.41, 0.40, 0.39, 0.80, 0.82],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "tile-render.seam.Ground").status, "fail");
  assert.match(checkById(r, "tile-render.seam.Ground").actual, /edgeInterior=/);
  assert.equal(r.verdict, "fail");
});

test("tile-render: no platforms warns rather than crashes", () => {
  const r = evaluateTileRender({}, acceptance);
  assert.equal(checkById(r, "tile-render.data").status, "warn");
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// Parallax-motion — TargetFollow offset response + active-axis depth
// ---------------------------------------------------------------------------

function layerSamples(factorX: number, factorY = 0, tile = 2.5): NonNullable<ParallaxMotionInput["layers"]>[number] {
  return {
    name: factorX < 0.3 ? "Sky" : "Hills",
    mode: "TargetFollow",
    factorX,
    factorY,
    tileWorldWidth: tile,
    tileWorldHeight: tile,
    samples: [
      { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
      { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
      { state: "run-right", offsetX: 1 * factorX / tile, offsetY: 0, playerX: 1, playerY: 0 },
      { state: "at-apex", offsetX: 1 * factorX / tile, offsetY: 0.5 * factorY / tile, playerX: 1, playerY: 0.5 },
    ],
  };
}

function parallaxMotionInput(layers: NonNullable<ParallaxMotionInput["layers"]> = [layerSamples(0.2), { ...layerSamples(0.5), name: "Hills" }]): ParallaxMotionInput {
  return { layers };
}

test("parallax-motion: real multi-layer TargetFollow parallax passes", () => {
  const r = evaluateParallaxMotion(parallaxMotionInput(), acceptance);
  assert.equal(checkById(r, "parallax-motion.idle.Sky").status, "pass");
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "pass");
  assert.equal(checkById(r, "parallax-motion.depth").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("parallax-motion: depth ordering is independent of capture array order", () => {
  const r = evaluateParallaxMotion(
    parallaxMotionInput([{ ...layerSamples(0.5), name: "Hills" }, { ...layerSamples(0.2), name: "Sky" }]),
    acceptance,
  );
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "pass");
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
  assert.equal(checkById(r, "parallax-motion.depth").status, "pass");
  assert.match(checkById(r, "parallax-motion.depth").actual, /Sky=.*Hills=/);
  assert.equal(r.verdict, "pass");
});

test("parallax-motion: flat cut-out layers with non-zero factors fail response", () => {
  const flat = [layerSamples(0.2), { ...layerSamples(0.5), name: "Hills" }].map((layer) => ({
    ...layer,
    samples: layer.samples!.map((sample) => sample.state === "idle" ? sample : { ...sample, offsetX: 0, offsetY: 0 }),
  }));
  const r = evaluateParallaxMotion(parallaxMotionInput(flat), acceptance);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "fail");
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: all layers moving at the same ratio fail depth", () => {
  const sameRatio = [
    { ...layerSamples(0.5), name: "Sky" },
    { ...layerSamples(0.5), name: "Hills" },
  ];
  const r = evaluateParallaxMotion(parallaxMotionInput(sameRatio), acceptance);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "pass");
  assert.equal(checkById(r, "parallax-motion.depth").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: factorY 0 with no vertical motion passes and X depth still counts", () => {
  const r = evaluateParallaxMotion(parallaxMotionInput(), acceptance);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
  assert.match(checkById(r, "parallax-motion.depth").detail, /X/);
  assert.equal(r.verdict, "pass");
});

test("parallax-motion: circular delta handles texture-offset wrap", () => {
  const wrapLayer = layerSamples(0.2);
  wrapLayer.name = "Sky";
  wrapLayer.samples = [
    { state: "idle", offsetX: 0.95, offsetY: 0, playerX: 0, playerY: 0 },
    { state: "idle", offsetX: 0.95, offsetY: 0, playerX: 0, playerY: 0 },
    { state: "run-right", offsetX: 0.03, offsetY: 0, playerX: 1, playerY: 0 },
  ];
  const near = layerSamples(0.5);
  near.name = "Hills";
  near.samples = [
    { state: "idle", offsetX: 0.95, offsetY: 0, playerX: 0, playerY: 0 },
    { state: "idle", offsetX: 0.95, offsetY: 0, playerX: 0, playerY: 0 },
    { state: "run-right", offsetX: 0.15, offsetY: 0, playerX: 1, playerY: 0 },
  ];
  const r = evaluateParallaxMotion(parallaxMotionInput([wrapLayer, near]), acceptance);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("parallax-motion: idle drift fails idle check", () => {
  const sky = layerSamples(0.2);
  sky.samples![1] = { state: "idle", offsetX: 0.02, offsetY: 0, playerX: 0, playerY: 0 };
  const r = evaluateParallaxMotion(parallaxMotionInput([sky, { ...layerSamples(0.5), name: "Hills" }]), acceptance);
  assert.equal(checkById(r, "parallax-motion.idle.Sky").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: wrong-speed layer fails response", () => {
  const sky = layerSamples(0.2);
  sky.samples![2] = { state: "run-right", offsetX: 0.2, offsetY: 0, playerX: 1, playerY: 0 };
  const r = evaluateParallaxMotion(parallaxMotionInput([sky, { ...layerSamples(0.5), name: "Hills" }]), acceptance);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: gateTuning overrides legacy platformer response tolerance", () => {
  const sky = layerSamples(0.2);
  sky.samples![2] = { state: "run-right", offsetX: 0.2, offsetY: 0, playerX: 1, playerY: 0 };
  const tuned = {
    ...acceptance,
    platformer: { parallaxMotionAbsTolerance: 0.015 },
    gateTuning: { byGate: { "parallax-motion": { parallaxMotionAbsTolerance: 0.13 } } },
  } as AcceptanceContract;
  const r = evaluateParallaxMotion(parallaxMotionInput([sky, { ...layerSamples(0.5), name: "Hills" }]), tuned);
  assert.equal(checkById(r, "parallax-motion.response.Sky").status, "pass");
});

test("parallax-motion: non-TargetFollow layer is explicit methodology-gap not_applicable", () => {
  const r = evaluateParallaxMotion(
    parallaxMotionInput([
      {
        name: "Clouds",
        mode: "AmbientDrift",
        factorX: 0.2,
        factorY: 0,
        tileWorldWidth: 2.5,
        samples: [{ state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 }],
      },
    ]),
    acceptance,
  );
  assert.equal(checkById(r, "parallax-motion.mode.Clouds").status, "not_applicable");
  assert.equal(checkById(r, "parallax-motion.depth").status, "not_applicable");
  assert.equal(r.verdict, "not_applicable");
});

test("parallax-motion: absent mode is a hard failure, not a skip", () => {
  const layer = layerSamples(0.2);
  delete layer.mode;
  const r = evaluateParallaxMotion(parallaxMotionInput([layer, { ...layerSamples(0.5), name: "Hills" }]), acceptance);
  assert.equal(checkById(r, "parallax-motion.mode.Sky").status, "fail");
  assert.equal(checkById(r, "parallax-motion.response.Hills").status, "pass");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: unknown mode is a hard failure, not a methodology skip", () => {
  const layer = { ...layerSamples(0.2), mode: "TargetFollower" };
  const r = evaluateParallaxMotion(parallaxMotionInput([layer, { ...layerSamples(0.5), name: "Hills" }]), acceptance);
  assert.equal(checkById(r, "parallax-motion.mode.Sky").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: TargetFollow missing factors or tile sizes fails metadata", () => {
  const missingFactor = layerSamples(0.2);
  delete missingFactor.factorX;
  const missingTileHeight = { ...layerSamples(0.5), name: "Hills" };
  delete missingTileHeight.tileWorldHeight;
  const r = evaluateParallaxMotion(parallaxMotionInput([missingFactor, missingTileHeight]), acceptance);
  assert.equal(checkById(r, "parallax-motion.metadata.Sky").status, "fail");
  assert.equal(checkById(r, "parallax-motion.metadata.Hills").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("parallax-motion: empty capture warns rather than crashes", () => {
  const r = evaluateParallaxMotion({}, acceptance);
  assert.equal(checkById(r, "parallax-motion.data").status, "warn");
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// Placement — visible ground ends (edge coverage) + floating/sunk props
// ---------------------------------------------------------------------------

test("placement (edge coverage): rightmost ground inside the frame FAILs (visible end)", () => {
  // The clean-room bug: the right ground maxX 15.5 sits inside the visible frame
  // maxX 17.1, so the player sees the platform's hard end instead of it running
  // off-screen.
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
    grounds: [
      { name: "GroundLeft", minX: -18, maxX: -2, topY: 4 },
      { name: "GroundRight", minX: 2, maxX: 15.5, topY: 4 },
    ],
  };
  const r = evaluatePlacement(input, acceptance);
  const right = checkById(r, "placement.edgeCoverage.right");
  assert.equal(right.status, "fail");
  assert.match(right.detail, /15\.5/);
  assert.match(right.detail, /17\.1/);
  assert.match(right.detail, /platform end is visible/i);
  // The left ground (-18) runs past the frame left edge (-17.1) -> left passes.
  assert.equal(checkById(r, "placement.edgeCoverage.left").status, "pass");
  assert.equal(r.verdict, "fail");
});

test("placement (edge coverage): grounds spanning past both edges PASS", () => {
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
    grounds: [
      { name: "GroundLeft", minX: -20, maxX: -2, topY: 4 },
      { name: "GroundRight", minX: 2, maxX: 20, topY: 4 },
    ],
  };
  const r = evaluatePlacement(input, acceptance);
  assert.equal(checkById(r, "placement.edgeCoverage.left").status, "pass");
  assert.equal(checkById(r, "placement.edgeCoverage.right").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("placement (grounded item): a flag floating above its surface FAILs", () => {
  // The clean-room bug: the flag is placed by transform center on the ground
  // line, so its visible base (4.8) sits 0.80u above the grass surface (4.0).
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
    groundedItems: [{ name: "Flag", visibleBottomY: 4.8, surfaceTopY: 4.0 }],
  };
  const r = evaluatePlacement(input, acceptance);
  const c = checkById(r, "placement.grounded.Flag");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /FLOATS 0\.80u/);
  assert.equal(r.verdict, "fail");
});

test("placement (grounded item): a flag resting on its surface PASSes", () => {
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
    groundedItems: [{ name: "Flag", visibleBottomY: 4.0, surfaceTopY: 4.0 }],
  };
  const r = evaluatePlacement(input, acceptance);
  const c = checkById(r, "placement.grounded.Flag");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /rests on its surface/i);
  assert.equal(r.verdict, "pass");
});

test("placement (grounded item): a sunk item FAILs with a SUNK message", () => {
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
    groundedItems: [{ name: "Sign", visibleBottomY: 3.4, surfaceTopY: 4.0 }],
  };
  const r = evaluatePlacement(input, acceptance);
  const c = checkById(r, "placement.grounded.Sign");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /SUNK 0\.60u/);
});

test("placement: no grounds and no grounded items -> single WARN", () => {
  const input: PlacementInput = {
    cameraFrame: { minX: -17.1, maxX: 17.1, minY: -9, maxY: 9 },
  };
  const r = evaluatePlacement(input, acceptance);
  assert.equal(r.checks.length, 1);
  assert.equal(checkById(r, "placement.data").status, "warn");
  assert.match(r.checks[0].detail, /no placement data captured/i);
  assert.equal(r.verdict, "warn");
});

// ---------------------------------------------------------------------------
// Feel
// ---------------------------------------------------------------------------

test("feel: bandWindow handles percent and abs", () => {
  const pct = bandWindow({ target: 7, unit: "u/s", band: { percent: 5 } });
  assert.ok(Math.abs(pct.lo - 6.65) < 1e-9 && Math.abs(pct.hi - 7.35) < 1e-9);
  const abs = bandWindow({ target: 0.1, unit: "s", band: { abs: 0.02 } });
  assert.ok(Math.abs(abs.lo - 0.08) < 1e-9 && Math.abs(abs.hi - 0.12) < 1e-9);
});

test("feel: withinBand respects percent/abs", () => {
  assert.ok(withinBand(6.7, { target: 7, unit: "u/s", band: { percent: 5 } }));
  assert.ok(!withinBand(6.0, { target: 7, unit: "u/s", band: { percent: 5 } }));
});

test("feel (conformant): on-target measurements PASS", () => {
  const m: FeelMeasurements = {
    runSpeed: 7.0,
    jumpApex: 2.2,
    timeToApex: 320,
    shortHopApex: 0.72,
    dashDistance: 2.8125, // Phase F: corrected dash target (18.75 × 0.15)
    coyoteTime: 0.1,
    jumpBuffer: 0.1,
  };
  const r = evaluateFeel(m, acceptance);
  assert.equal(r.verdict, "pass");
  assert.ok(r.checks.length >= 7);
});

test("feel (out of band): run + dash out of band FAIL", () => {
  const m: FeelMeasurements = {
    runSpeed: 9.0, // spec 7 ±5%
    jumpApex: 2.2,
    timeToApex: 320,
    dashDistance: 5.0, // spec 2.8125 ±5%
  };
  const r = evaluateFeel(m, acceptance);
  assert.equal(checkById(r, "feel.runSpeed").status, "fail");
  assert.equal(checkById(r, "feel.dashDistance").status, "fail");
  assert.equal(checkById(r, "feel.jumpApex").status, "pass");
  assert.equal(r.verdict, "fail");
});

test("feel: unmeasured metric -> WARN, not fail", () => {
  const m: FeelMeasurements = { runSpeed: 7.0 };
  const r = evaluateFeel(m, acceptance);
  assert.equal(checkById(r, "feel.runSpeed").status, "pass");
  assert.equal(checkById(r, "feel.jumpApex").status, "warn");
  assert.equal(r.verdict, "warn");
});

function feelWithProvenance(overrides: Partial<FeelMeasurements> = {}): FeelMeasurements {
  return {
    runSpeed: 7.0,
    jumpApex: 2.2,
    timeToApex: 320,
    shortHopApex: 0.72,
    dashDistance: 2.8125,
    coyoteTime: 0.1,
    jumpBuffer: 0.1,
    provenance: {
      sources: [
        {
          source: "FeelHarness",
          sampleCount: 180,
          captureFps: 60,
          measuredAt: "2026-05-31T00:00:00.000Z",
          projectFixedTimestepBeforeMeasurement: 0.0166667,
          measurementFixedTimestep: 0.0166667,
          measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"],
          // F5: shortHopApex is stimulus-sensitive — record the canonical 6-tick tap.
          stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" },
        },
        {
          source: "runtime.probe",
          sampleCount: 90,
          captureFps: 60,
          measuredAt: "2026-05-31T00:00:01.000Z",
          projectFixedTimestepBeforeMeasurement: 0.0166667,
          measurementFixedTimestep: 0.0166667,
          measuredMetrics: ["dashDistance", "coyoteTime", "jumpBuffer"],
        },
      ],
    },
    ...overrides,
  };
}

test("feel-provenance: full per-metric/source coverage passes", () => {
  const r = evaluateFeelProvenance(feelWithProvenance(), acceptance);
  assert.equal(checkById(r, "feel-provenance.present").status, "pass");
  for (const metric of ["runSpeed", "jumpApex", "timeToApex", "shortHopApex", "dashDistance", "coyoteTime", "jumpBuffer"]) {
    assert.equal(checkById(r, `feel-provenance.${metric}`).status, "pass");
  }
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: numbers-only feel.json fails the present check", () => {
  const r = evaluateFeelProvenance({ runSpeed: 7.0, jumpApex: 2.2 }, acceptance);
  assert.equal(checkById(r, "feel-provenance.present").status, "fail");
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("feel-provenance: FeelHarness-only source does not certify probe-only metrics", () => {
  const m = feelWithProvenance({
    provenance: {
      sources: [
        {
          source: "FeelHarness",
          sampleCount: 180,
          captureFps: 60,
          measuredAt: "2026-05-31T00:00:00.000Z",
          projectFixedTimestepBeforeMeasurement: 0.0166667,
          measurementFixedTimestep: 0.0166667,
          measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"],
          stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" },
        },
      ],
    },
  });
  const r = evaluateFeelProvenance(m, acceptance);
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "pass");
  assert.equal(checkById(r, "feel-provenance.dashDistance").status, "fail");
  assert.equal(checkById(r, "feel-provenance.coyoteTime").status, "fail");
  assert.equal(checkById(r, "feel-provenance.jumpBuffer").status, "fail");
});

test("feel-provenance: a valid FeelHarness source falsely listing dashDistance is wrong-owner and fails", () => {
  const m = feelWithProvenance({
    provenance: {
      sources: [
        {
          source: "FeelHarness",
          sampleCount: 180,
          captureFps: 60,
          measuredAt: "2026-05-31T00:00:00.000Z",
          projectFixedTimestepBeforeMeasurement: 0.0166667,
          measurementFixedTimestep: 0.0166667,
          measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex", "dashDistance"],
          stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" },
        },
      ],
    },
  });
  const r = evaluateFeelProvenance(m, acceptance);
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "pass");
  assert.equal(checkById(r, "feel-provenance.dashDistance").status, "fail");
  assert.match(checkById(r, "feel-provenance.dashDistance").actual, /wrong-owner/);
});

test("feel-provenance: invalid covering source fails its covered metrics", () => {
  const r = evaluateFeelProvenance(
    {
      runSpeed: 7.0,
      provenance: {
        sources: [
          {
            source: "FeelHarness",
            sampleCount: 0,
            captureFps: 60,
            measuredAt: "",
            projectFixedTimestepBeforeMeasurement: 0.0166667,
            measurementFixedTimestep: 0.0166667,
            measuredMetrics: ["runSpeed"],
          },
        ],
      },
    },
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "fail");
  assert.match(checkById(r, "feel-provenance.runSpeed").actual, /invalid/);
});

test("feel-provenance: no measured accepted metrics warns", () => {
  const r = evaluateFeelProvenance({}, acceptance);
  assert.equal(checkById(r, "feel-provenance.data").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("feel-provenance: runtime.probe certifies shortHopApex (harness HopMeasure is frame-quantized)", () => {
  // shortHopApex is co-owned by FeelHarness AND runtime.probe: the harness HopMeasure
  // is frame-quantized and cannot resolve the tight short-hop band, so the behavioral
  // probe peak-Y is the authoritative source. A probe source owning shortHopApex certifies it.
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "FeelHarness", sampleCount: 29, captureFps: 60, measuredAt: "2026-05-31T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex"] },
          { source: "runtime.probe", sampleCount: 119, captureFps: 120, measuredAt: "2026-05-31T00:00:01.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["dashDistance", "coyoteTime", "jumpBuffer", "shortHopApex"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.shortHopApex").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: ownership guard intact — runtime.probe cannot certify FeelHarness-only runSpeed", () => {
  // A probe source claiming runSpeed (FeelHarness-only) is wrong-owner, not valid — the
  // co-ownership of shortHopApex must not leak into letting the probe certify other metrics.
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "runtime.probe", sampleCount: 90, captureFps: 60, measuredAt: "2026-05-31T00:00:01.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "shortHopApex", "dashDistance", "coyoteTime", "jumpBuffer"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "fail");
  assert.match(checkById(r, "feel-provenance.runSpeed").actual, /wrong-owner/);
  assert.equal(checkById(r, "feel-provenance.shortHopApex").status, "pass");
});

test("feel-provenance: runtime.capture_input_motion certifies the four trajectory metrics", () => {
  // capture_input_motion is the SAME sampler as measure_motion (it injects keys
  // in-loop), so it owns the trajectory metrics and is a valid provenance source.
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "runtime.capture_input_motion", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
          { source: "runtime.probe", sampleCount: 90, captureFps: 60, measuredAt: "2026-06-12T00:00:01.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["dashDistance", "coyoteTime", "jumpBuffer"] },
        ],
      },
    }),
    acceptance,
  );
  for (const metric of ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"]) {
    assert.equal(checkById(r, `feel-provenance.${metric}`).status, "pass");
  }
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: runtime.capture_input_motion certifies projectileSpeed as a trajectory metric", () => {
  const shooterAcceptance: AcceptanceContract = {
    ...acceptance,
    feel: {
      ...(acceptance.feel ?? {}),
      extra: {
        ...(acceptance.feel?.extra ?? {}),
        projectileSpeed: { target: 18, unit: "u/s", band: { percent: 10 } },
      },
    },
  };
  const r = evaluateFeelProvenance(
    {
      projectileSpeed: 18,
      provenance: {
        sources: [
          {
            source: "runtime.capture_input_motion",
            sampleCount: 31,
            captureFps: 60,
            measuredAt: "2026-06-25T00:40:00.000Z",
            projectFixedTimestepBeforeMeasurement: 0.02,
            measurementFixedTimestep: 0.02,
            measuredMetrics: ["projectileSpeed"],
          },
        ],
      },
    } as unknown as FeelMeasurements,
    shooterAcceptance,
  );
  assert.equal(checkById(r, "feel-provenance.projectileSpeed").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: runtime.capture_input_motion certifies aimTurnRateDegPerSec as a rotation trajectory metric", () => {
  const shooterAcceptance: AcceptanceContract = {
    ...acceptance,
    feel: {
      ...(acceptance.feel ?? {}),
      extra: {
        ...(acceptance.feel?.extra ?? {}),
        aimTurnRateDegPerSec: { target: 120, unit: "x", band: { percent: 10 } },
      },
    },
  };
  const r = evaluateFeelProvenance(
    {
      aimTurnRateDegPerSec: 119.976,
      provenance: {
        sources: [
          {
            source: "runtime.capture_input_motion",
            sampleCount: 113,
            captureFps: 60,
            measuredAt: "2026-06-26T00:40:00.000Z",
            projectFixedTimestepBeforeMeasurement: 0.02,
            measurementFixedTimestep: 0.02,
            measuredMetrics: ["aimTurnRateDegPerSec"],
          },
        ],
      },
    } as unknown as FeelMeasurements,
    shooterAcceptance,
  );
  assert.equal(checkById(r, "feel-provenance.aimTurnRateDegPerSec").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: runtime.capture_input_motion certifies lookInputToYawLatencyMs as an input-bound rotation metric", () => {
  const shooterAcceptance: AcceptanceContract = {
    ...acceptance,
    feel: {
      ...(acceptance.feel ?? {}),
      extra: {
        ...(acceptance.feel?.extra ?? {}),
        lookInputToYawLatencyMs: { target: 16.67, unit: "ms", band: { percent: 20 } },
      },
    },
  };
  const r = evaluateFeelProvenance(
    {
      lookInputToYawLatencyMs: 16.67,
      provenance: {
        sources: [
          {
            source: "runtime.capture_input_motion",
            sampleCount: 60,
            captureFps: 60,
            measuredAt: "2026-06-26T00:45:00.000Z",
            projectFixedTimestepBeforeMeasurement: 0.02,
            measurementFixedTimestep: 0.02,
            measuredMetrics: ["lookInputToYawLatencyMs"],
          },
        ],
      },
    } as unknown as FeelMeasurements,
    shooterAcceptance,
  );
  assert.equal(checkById(r, "feel-provenance.lookInputToYawLatencyMs").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: runtime.capture_input_motion certifies dashDistance only with phase-delta evidence", () => {
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "FeelHarness", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
          {
            source: "runtime.capture_input_motion",
            sampleCount: 180,
            captureFps: 60,
            measuredAt: "2026-06-12T00:00:01.000Z",
            projectFixedTimestepBeforeMeasurement: 0.0166667,
            measurementFixedTimestep: 0.0166667,
            measuredMetrics: ["dashDistance"],
            derivation: "phase-delta",
            phases: [
              { index: 0, deltaX: 0 },
              { index: 1, keys: ["D", "LeftShift"], deltaX: 2.8125 },
            ],
            phaseIndex: 1,
            axis: "x",
            phaseKeys: ["D", "LeftShift"],
            requiredKeys: ["D", "LeftShift"],
          },
          { source: "runtime.probe", sampleCount: 90, captureFps: 60, measuredAt: "2026-06-12T00:00:02.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["coyoteTime", "jumpBuffer"] },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.dashDistance").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("feel-provenance: runtime.capture_input_motion dashDistance from a non-dash phase fails", () => {
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "FeelHarness", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
          {
            source: "runtime.capture_input_motion",
            sampleCount: 180,
            captureFps: 60,
            measuredAt: "2026-06-12T00:00:01.000Z",
            projectFixedTimestepBeforeMeasurement: 0.0166667,
            measurementFixedTimestep: 0.0166667,
            measuredMetrics: ["dashDistance"],
            derivation: "phase-delta",
            phases: [{ index: 1, keys: ["D"], deltaX: 2.8125 }],
            phaseIndex: 1,
            axis: "x",
            phaseKeys: ["D"],
            requiredKeys: ["D", "LeftShift"],
          },
          { source: "runtime.probe", sampleCount: 90, captureFps: 60, measuredAt: "2026-06-12T00:00:02.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["coyoteTime", "jumpBuffer"] },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.dashDistance").status, "fail");
  assert.match(checkById(r, "feel-provenance.dashDistance").actual, /wrong-owner/);
});

test("feel-provenance: runtime.capture_input_motion dashDistance without phase-delta evidence fails", () => {
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "FeelHarness", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"], stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
          { source: "runtime.capture_input_motion", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:01.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["dashDistance"] },
          { source: "runtime.probe", sampleCount: 90, captureFps: 60, measuredAt: "2026-06-12T00:00:02.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["coyoteTime", "jumpBuffer"] },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.dashDistance").status, "fail");
  assert.match(checkById(r, "feel-provenance.dashDistance").actual, /wrong-owner/);
});

test("feel-provenance: runtime.capture_input_motion cannot certify a metric outside its ownership", () => {
  // coyoteTime is owned by runtime.probe only; a capture_input_motion source claiming
  // it is wrong-owner, not valid — ownership must not over-broaden to all metrics.
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "runtime.capture_input_motion", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex", "coyoteTime"] },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "pass");
  assert.equal(checkById(r, "feel-provenance.coyoteTime").status, "fail");
  assert.match(checkById(r, "feel-provenance.coyoteTime").actual, /wrong-owner/);
});

test("feel-provenance: an unknown source string is invalid and refuses its covered metrics", () => {
  // A source label not in VALID_SOURCES is refused (never silently skipped), even
  // when it lists a real trajectory metric.
  const r = evaluateFeelProvenance(
    feelWithProvenance({
      provenance: {
        sources: [
          { source: "runtime.capture_input_motion_v2", sampleCount: 180, captureFps: 60, measuredAt: "2026-06-12T00:00:00.000Z", projectFixedTimestepBeforeMeasurement: 0.0166667, measurementFixedTimestep: 0.0166667, measuredMetrics: ["runSpeed", "jumpApex", "timeToApex", "shortHopApex"] },
        ],
      },
    }),
    acceptance,
  );
  assert.equal(checkById(r, "feel-provenance.runSpeed").status, "fail");
  assert.match(checkById(r, "feel-provenance.runSpeed").actual, /invalid/);
});

test("physics-timestep: matching project and measurement timesteps pass", () => {
  const r = evaluatePhysicsTimestep(feelWithProvenance(), acceptance);
  assert.equal(checkById(r, "physics-timestep.project").status, "pass");
  assert.equal(checkById(r, "physics-timestep.measurement").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("physics-timestep: project 50Hz while measurement is pinned 60Hz fails project check", () => {
  const m = feelWithProvenance();
  m.provenance!.sources![0]!.projectFixedTimestepBeforeMeasurement = 0.02;
  const r = evaluatePhysicsTimestep(m, acceptance);
  assert.equal(checkById(r, "physics-timestep.project").status, "fail");
  assert.equal(checkById(r, "physics-timestep.measurement").status, "pass");
  assert.equal(r.verdict, "fail");
});

test("physics-timestep: measurement timestep mismatch fails measurement check", () => {
  const m = feelWithProvenance();
  m.provenance!.sources![1]!.measurementFixedTimestep = 0.02;
  const r = evaluatePhysicsTimestep(m, acceptance);
  assert.equal(checkById(r, "physics-timestep.measurement").status, "fail");
  assert.equal(r.verdict, "fail");
});

test("physics-timestep: a finer integer-multiple captureFps (120fps sampling of 60Hz) passes", () => {
  // The probe samples the transform at 120fps for finer resolution while physics still
  // steps at 60Hz (measurementFixedTimestep unchanged) — finer sampling never corrupts
  // the deterministic sim. captureFps is allowed to be a finer integer multiple.
  const m = feelWithProvenance();
  m.provenance!.sources![1]!.captureFps = 120;
  const r = evaluatePhysicsTimestep(m, acceptance);
  assert.equal(checkById(r, "physics-timestep.captureFps").status, "pass");
  assert.equal(checkById(r, "physics-timestep.project").status, "pass");
  assert.equal(checkById(r, "physics-timestep.measurement").status, "pass");
  assert.equal(r.verdict, "pass");
});

test("physics-timestep: a NON-integer captureFps multiple (90fps of 60Hz) warns; timesteps still pass", () => {
  // 90/60 = 1.5 is not a finer INTEGER multiple — the captureFps consistency check still
  // flags it (warn), but the real anti-gaming guard (project + measurement timestep equality)
  // is untouched and still passes. This is the same logic that keeps 60fps-of-50Hz (1.2x) flagged.
  const m = feelWithProvenance();
  m.provenance!.sources![1]!.captureFps = 90;
  const r = evaluatePhysicsTimestep(m, acceptance);
  assert.equal(checkById(r, "physics-timestep.captureFps").status, "warn");
  assert.equal(checkById(r, "physics-timestep.project").status, "pass");
  assert.equal(checkById(r, "physics-timestep.measurement").status, "pass");
});

test("physics-timestep: absent timestep fields fail", () => {
  const m = feelWithProvenance();
  delete m.provenance!.sources![0]!.projectFixedTimestepBeforeMeasurement;
  delete m.provenance!.sources![1]!.measurementFixedTimestep;
  const r = evaluatePhysicsTimestep(m, acceptance);
  assert.equal(checkById(r, "physics-timestep.project").status, "fail");
  assert.equal(checkById(r, "physics-timestep.measurement").status, "fail");
});

test("physics-timestep: no measured accepted metrics warns", () => {
  const r = evaluatePhysicsTimestep({}, acceptance);
  assert.equal(checkById(r, "physics-timestep.data").status, "warn");
  assert.equal(r.verdict, "warn");
});

test("physics-timestep: no physics contract is not_applicable", () => {
  const r = evaluatePhysicsTimestep(feelWithProvenance(), { ...acceptance, physics: undefined });
  assert.equal(checkById(r, "physics-timestep.contract").status, "not_applicable");
  assert.equal(r.verdict, "not_applicable");
});

// ---------------------------------------------------------------------------
// Aggregator — the full Tiderunner run after the Phase F reconcile
// ---------------------------------------------------------------------------

test("aggregate: post-reconcile live run -> overall fail driven by the UI font/color findings", () => {
  const ui = evaluateUiConformance(liveHudScan, acceptance);
  const framing = evaluateFraming(liveScreenRects, acceptance);
  const manifest = evaluateManifest(
    { missing: [], placeholders: [], extras: [], all_ok: true },
    acceptance,
  );
  // Phase F adopted all-fruit, so the observed all-fruit win now conforms.
  const playability = evaluatePlayability(
    {
      completable: true,
      completionMethod: "played",
      winRuleObserved: "all-fruit",
      hazardKills: true,
      collectibleIncrements: true,
      postWinInputLocked: true,
      postWinPlayerFrozen: true,
      restartWorks: true,
    },
    acceptance,
  );
  // The build's true dash is 18.75 × 0.15 = 2.8125u (the 3.0u capture was the slip).
  const feel = evaluateFeel(
    { runSpeed: 7.0, jumpApex: 2.2, timeToApex: 320, shortHopApex: 0.72, dashDistance: 2.8125, coyoteTime: 0.1, jumpBuffer: 0.1 },
    acceptance,
  );

  const verdict = aggregateVerdict([manifest, ui, framing, playability, feel]);

  assert.equal(verdict.status, "fail");
  assert.equal(verdict.gates["manifest"], "pass");
  assert.equal(verdict.gates["ui-conformance"], "fail");
  // Static camera -> framing no longer warns on the anchor.
  assert.equal(verdict.gates["framing"], "pass");
  // all-fruit accepted -> playability passes.
  assert.equal(verdict.gates["playability"], "pass");
  assert.equal(verdict.gates["feel"], "pass");

  // The remaining real findings are the UI font misses + the score color.
  const failIds = verdict.failures.map((c) => c.id);
  assert.ok(failIds.includes("font.ScoreLabel"));
  assert.ok(failIds.includes("color.ScoreLabel"));
  // The win-rule is no longer a failure after the reconcile.
  assert.ok(!failIds.includes("playability.winRule"));
  // The anchor is neither a failure nor a warn under a static camera.
  assert.ok(!failIds.includes("anchor.player"));
  assert.ok(!verdict.warnings.some((c) => c.id === "anchor.player"));

  // flat checks == sum of all gate checks
  const total = [manifest, ui, framing, playability, feel].reduce((n, g) => n + g.checks.length, 0);
  assert.equal(verdict.checks.length, total);
});

test("aggregate: all-pass gates -> overall pass", () => {
  // Use the canvas-equipped conformant fixture so ui.hudCrispness passes too
  // (the bare conformantHudScan now warns on the additive crispness check).
  const ui = evaluateUiConformance(conformantHudScanWithCanvas, acceptance);
  const manifest = evaluateManifest({ missing: [], placeholders: [], extras: [], all_ok: true }, acceptance);
  const verdict = aggregateVerdict([ui, manifest]);
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.warnings.length, 0);
});

test("aggregate: only warns -> overall warn", () => {
  const framing = evaluateFraming(liveScreenRects, acceptance); // pass (static camera)
  const manifest = evaluateManifest({ missing: [], placeholders: [], extras: ["DebugCube"] }, acceptance); // warn (extras)
  const verdict = aggregateVerdict([framing, manifest]);
  assert.equal(verdict.status, "warn");
  assert.equal(verdict.failures.length, 0);
  assert.ok(verdict.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// Frame integrity — distinct-state key frames must not be byte-identical
// ---------------------------------------------------------------------------

test("frame-integrity: 3 frames with distinct hashes -> PASS", () => {
  const input: FrameIntegrityInput = {
    frames: [
      { id: "spawn", path: "frames/spawn.png", hash: "aaaa1111" },
      { id: "dash-mid", path: "frames/dash-mid.png", hash: "bbbb2222" },
      { id: "win", path: "frames/win.png", hash: "cccc3333" },
    ],
  };
  const r = evaluateFrameIntegrity(input, acceptance);
  const c = checkById(r, "frame-integrity.distinct");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /pairwise distinct/i);
  assert.equal(r.verdict, "pass");
});

test("frame-integrity: two distinct ids sharing a hash -> FAIL naming both ids", () => {
  const input: FrameIntegrityInput = {
    frames: [
      { id: "spawn", path: "frames/spawn.png", hash: "dupdup" },
      { id: "win", path: "frames/win.png", hash: "dupdup" },
    ],
  };
  const r = evaluateFrameIntegrity(input, acceptance);
  const c = checkById(r, "frame-integrity.distinct");
  assert.equal(c.status, "fail");
  assert.match(c.actual, /spawn/);
  assert.match(c.actual, /win/);
  assert.match(c.detail, /byte-identical/i);
  assert.equal(r.verdict, "fail");
});

test("frame-integrity: the REAL case — 3 ids all the same hash -> FAIL", () => {
  // The clean-room bug: spawn/win/dash-mid were the SAME captured image.
  const sameHash = "0123456789abcdef0123456789abcdef";
  const input: FrameIntegrityInput = {
    frames: [
      { id: "spawn", path: "frames/spawn.png", hash: sameHash },
      { id: "win", path: "frames/win.png", hash: sameHash },
      { id: "dash-mid", path: "frames/dash-mid.png", hash: sameHash },
    ],
  };
  const r = evaluateFrameIntegrity(input, acceptance);
  const c = checkById(r, "frame-integrity.distinct");
  assert.equal(c.status, "fail");
  assert.match(c.actual, /spawn/);
  assert.match(c.actual, /win/);
  assert.match(c.actual, /dash-mid/);
  // The 12-char prefix of the shared hash is reported.
  assert.match(c.actual, /0123456789ab/);
  assert.equal(r.verdict, "fail");
});

test("frame-integrity: one null hash warns; a remaining collision still FAILs", () => {
  const input: FrameIntegrityInput = {
    frames: [
      { id: "spawn", path: "frames/spawn.png", hash: null }, // unreadable
      { id: "win", path: "frames/win.png", hash: "dupe" },
      { id: "dash-mid", path: "frames/dash-mid.png", hash: "dupe" },
    ],
  };
  const r = evaluateFrameIntegrity(input, acceptance);
  const warn = checkById(r, "frame-integrity.spawn.readable");
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /could not read\/hash/i);
  // The remaining two hashed frames still collide -> FAIL.
  const c = checkById(r, "frame-integrity.distinct");
  assert.equal(c.status, "fail");
  assert.match(c.actual, /win/);
  assert.match(c.actual, /dash-mid/);
  assert.equal(r.verdict, "fail");
});

test("frame-integrity: one null hash warns; remaining distinct frames PASS", () => {
  const input: FrameIntegrityInput = {
    frames: [
      { id: "spawn", path: "frames/spawn.png", hash: null }, // unreadable
      { id: "win", path: "frames/win.png", hash: "aaaa" },
      { id: "dash-mid", path: "frames/dash-mid.png", hash: "bbbb" },
    ],
  };
  const r = evaluateFrameIntegrity(input, acceptance);
  assert.equal(checkById(r, "frame-integrity.spawn.readable").status, "warn");
  assert.equal(checkById(r, "frame-integrity.distinct").status, "pass");
  // A WARN + a PASS rolls up to WARN (the unreadable frame is surfaced).
  assert.equal(r.verdict, "warn");
});

test("frame-integrity: no frames declared -> single WARN (does not crash)", () => {
  const r = evaluateFrameIntegrity({ frames: [] }, acceptance);
  assert.equal(r.checks.length, 1);
  const c = checkById(r, "frame-integrity.frames");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /no key frames declared/i);
  assert.equal(r.verdict, "warn");
});
