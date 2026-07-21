/**
 * Phase 5 — deterministic GEOMETRY background-coverage gate.
 *
 * The world-space background sprites must cover the camera's view at EVERY device aspect.
 * The bug it catches (real, from CountTheFruits): a sky sprite whose world half-width (9.6)
 * is narrower than the camera's world half-width at a wide aspect (orthoSize 5 × 2.22 = 11.1)
 * → uncovered strips at the frame edges on tall phones, invisible at 16:9.
 *
 * Coverage:
 *  - evaluator: a layer set covering the camera at 16:9 but NOT a wide aspect → the core bug;
 *    full coverage → pass at all aspects; absent background/camera/layers → refuse/FAIL;
 *    perspective camera → not_applicable.
 *  - capture parse helpers (parseCameraProps / unionRenderers / parseSceneLocator) pure.
 *  - wiring: a per-device coverage FAIL fails the verdict, is tagged with the device, lands
 *    in Must-fix, and does NOT inflate the screens-graded count.
 *
 * Style mirrors minigame-gates.test.ts (node:test + node:assert/strict).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateBackgroundCoverage,
  evaluateBackgroundSeam,
  type BackgroundData,
} from "../loombridge/minigame-gates/index.js";
import {
  BACKGROUND_DATA_FILE,
  isBackgroundKey,
  runMinigameGates,
} from "../loombridge/minigame-gates/run-minigame-gates.js";
import {
  parseCameraProps,
  parseSceneLocator,
  parseSpriteRendererOrder,
  unionRenderers,
} from "../loombridge/minigame-background.js";
import { assertValidMinigameContract } from "../loombridge/minigame-profiles/validator.js";
import { buildCrGroups, splitStateDevice, summarize } from "../loombridge/verify-minigame.js";
import type { MinigameContract } from "../loombridge/minigame-profiles/types.js";
import type { GateReport } from "../verification/gates/types.js";

// orthoSize 5 at 16:9 (1.778) → halfW = 8.9; at 20:9 (2.222) → halfW = 11.1.
const ASPECT_16x9 = 16 / 9;
const ASPECT_20x9 = 20 / 9;

/** A camera centred at the origin, orthoSize 5 (world half-height 5). */
function camera(orthographic = true): BackgroundData["camera"] {
  return { orthographic, orthoSize: 5, position: { x: 0, y: 0 } };
}

/** A single full-width background layer spanning ±halfWidth × ±5 (covers the frame height). */
function skyLayer(halfWidth: number, locator = "Scene:/Background/Sky"): BackgroundData["layers"][number] {
  return { locator, min: { x: -halfWidth, y: -5 }, max: { x: halfWidth, y: 5 } };
}

function layer(
  locator: string,
  min: { x: number; y: number },
  max: { x: number; y: number },
  sortingOrder: number,
  z = 0,
): BackgroundData["layers"][number] {
  return { locator, min, max, order: { sortingOrder, z, sortingLayerName: "Default" } };
}

function gate(report: GateReport): "pass" | "fail" | "warn" | "not_applicable" {
  return report.verdict;
}

// ── the core bug: covers at 16:9, NOT at a wider aspect ─────────────────────────────

test("background-coverage: a sky narrower than the wide-aspect view PASSES at 16:9 but FAILS at 20:9 (the CountTheFruits bug)", () => {
  // Sky half-width 9.6 (the real CountTheFruits value). At 16:9 halfW = 8.9 (covered); at
  // 20:9 halfW = 11.1 (the sky leaves uncovered strips at the left/right edges).
  const data: BackgroundData = { camera: camera(), layers: [skyLayer(9.6)] };

  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_16x9)), "pass", "covered at 16:9");

  const wide = evaluateBackgroundCoverage(data, ASPECT_20x9);
  assert.equal(gate(wide), "fail", "uncovered strips on a wide phone");
  // The detail names the offending edges (left/right) — the gap is horizontal.
  assert.match(wide.checks[0].detail, /left|right/, wide.checks[0].detail);
});

test("background-coverage: a layer wide enough for the WIDEST aspect passes at all aspects", () => {
  // Half-width 12 ≥ the 20:9 halfW of 11.1, so it covers every aspect.
  const data: BackgroundData = { camera: camera(), layers: [skyLayer(12)] };
  for (const aspect of [ASPECT_16x9, ASPECT_20x9, 3 / 4, 9 / 16]) {
    assert.equal(gate(evaluateBackgroundCoverage(data, aspect)), "pass", `covered at aspect ${aspect}`);
  }
});

test("background-coverage: multiple layers UNION to cover the frame (left half + right half)", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      { locator: "Scene:/Bg/Left", min: { x: -12, y: -5 }, max: { x: 0.5, y: 5 } },
      { locator: "Scene:/Bg/Right", min: { x: -0.5, y: -5 }, max: { x: 12, y: 5 } },
    ],
  };
  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_20x9)), "pass", "two half-layers cover together");
});

// ── refuse-on-absent ────────────────────────────────────────────────────────────────

test("background-coverage: a missing background.json is a refuse-on-absent FAIL (never assumed covered)", () => {
  const report = evaluateBackgroundCoverage(null, ASPECT_16x9);
  assert.equal(gate(report), "fail");
  assert.match(report.checks[0].detail, /absent|no background\.json/i);
});

test("background-coverage: an empty layer set is a FAIL (nothing to cover the view)", () => {
  const data: BackgroundData = { camera: camera(), layers: [] };
  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_16x9)), "fail");
});

test("background-coverage: a camera with no usable orthoSize is a FAIL", () => {
  const data = { camera: { orthographic: true, orthoSize: 0, position: { x: 0, y: 0 } }, layers: [skyLayer(12)] } as BackgroundData;
  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_16x9)), "fail");
});

test("background-coverage: a PERSPECTIVE camera is not_applicable (out of scope), said loudly — never a silent pass", () => {
  const data: BackgroundData = { camera: camera(false), layers: [skyLayer(12)] };
  const report = evaluateBackgroundCoverage(data, ASPECT_16x9);
  assert.equal(gate(report), "not_applicable");
  assert.match(report.checks[0].detail, /perspective/i);
});

test("background-coverage: a non-positive aspect is a refuse-on-absent FAIL", () => {
  const data: BackgroundData = { camera: camera(), layers: [skyLayer(12)] };
  assert.equal(gate(evaluateBackgroundCoverage(data, 0)), "fail");
  assert.equal(gate(evaluateBackgroundCoverage(data, NaN)), "fail");
});

test("background-coverage: a camera offset shifts the view rect (an off-centre frame can uncover)", () => {
  // Camera shifted +3 on x; the view rect is [3-8.9, 3+8.9] at 16:9. A sky centred at origin
  // spanning ±9.6 covers [-9.6,9.6] → its right edge (9.6) < the view's right (11.9) → uncovered.
  const data: BackgroundData = {
    camera: { orthographic: true, orthoSize: 5, position: { x: 3, y: 0 } },
    layers: [skyLayer(9.6)],
  };
  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_16x9)), "fail", "offset camera exposes the right edge");
});

// ── pure capture parse helpers ──────────────────────────────────────────────────────

test("parseSceneLocator: splits 'Scene:/Path' on the first colon", () => {
  assert.deepEqual(parseSceneLocator("CountTheFruits:/Main Camera"), { scene: "CountTheFruits", path: "/Main Camera" });
  assert.deepEqual(parseSceneLocator("/Bare/Path"), { path: "/Bare/Path" });
});

test("parseCameraProps: reads m_Orthographic + m_OrthographicSize from the descriptors", () => {
  const props = [
    { displayName: "Orthographic", serializedPath: "m_Orthographic", currentValue: true },
    { displayName: "Size", serializedPath: "m_OrthographicSize", currentValue: 5 },
  ];
  assert.deepEqual(parseCameraProps(props), { orthographic: true, orthoSize: 5 });
});

test("parseCameraProps: a numeric Projection enum (1=Orthographic) is read as orthographic", () => {
  const props = [
    { displayName: "Projection", serializedPath: "m_Orthographic", currentValue: 1 },
    { serializedPath: "m_OrthographicSize", currentValue: 4.5 },
  ];
  assert.deepEqual(parseCameraProps(props), { orthographic: true, orthoSize: 4.5 });
});

test("parseCameraProps: a missing size or flag returns null (refuse-on-absent at capture)", () => {
  assert.equal(parseCameraProps([{ serializedPath: "m_Orthographic", currentValue: true }]), null);
  assert.equal(parseCameraProps([{ serializedPath: "m_OrthographicSize", currentValue: 5 }]), null);
  assert.equal(parseCameraProps(undefined), null);
});

test("unionRenderers: unions multiple renderer AABBs; returns null when none are usable", () => {
  const u = unionRenderers([
    { min: { x: -2, y: -1 }, max: { x: 1, y: 2 } },
    { min: { x: -1, y: -3 }, max: { x: 4, y: 1 } },
  ]);
  assert.deepEqual(u, { min: { x: -2, y: -3 }, max: { x: 4, y: 2 } });
  assert.equal(unionRenderers([]), null);
  assert.equal(unionRenderers([{ min: { x: 0 } }]), null);
});

test("parseSpriteRendererOrder: reads sorting order, layer, and z for seam detection", () => {
  const props = [
    { displayName: "Sorting Layer", serializedPath: "m_SortingLayer", currentValue: "Background" },
    { displayName: "Order in Layer", serializedPath: "m_SortingOrder", currentValue: 7 },
  ];
  assert.deepEqual(parseSpriteRendererOrder(props, -2), { sortingOrder: 7, z: -2, sortingLayerName: "Background" });
  assert.equal(parseSpriteRendererOrder([{ serializedPath: "m_SortingLayer", currentValue: "Background" }], 0), null);
});

// ── background-seam: visible cut edge / parallax seam ───────────────────────────────

test("background-seam: moved front hills FAIL even though sky covers the whole frame", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/HillFar", { x: -12, y: -6 }, { x: 12, y: -1 }, 1),
      // Bottom edge is inside the camera view: y=-4.21 > view bottom -5.
      layer("Scene:/Background/HillNear", { x: -12, y: -4.21 }, { x: 12, y: 1.2 }, 2),
      // Ground was also moved up: its bottom edge is inside the view.
      layer("Scene:/Background/Ground", { x: -12, y: -2.81 }, { x: 12, y: 0.2 }, 3),
    ],
  };

  assert.equal(gate(evaluateBackgroundCoverage(data, ASPECT_16x9)), "pass", "union coverage still passes");
  const seam = evaluateBackgroundSeam(data, ASPECT_16x9);
  assert.equal(gate(seam), "fail");
  assert.match(seam.checks[0].detail, /HillNear.*bottom edge exposed/i);
  assert.match(seam.checks[0].detail, /Ground.*bottom edge exposed/i);
});

test("background-seam: bled front layers PASS", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/HillNear", { x: -12, y: -5.5 }, { x: 12, y: 1.2 }, 2),
      layer("Scene:/Background/Ground", { x: -12, y: -5.4 }, { x: 12, y: 0.2 }, 3),
    ],
  };
  assert.equal(gate(evaluateBackgroundSeam(data, ASPECT_16x9)), "pass");
});

test("background-seam: a front layer covering an interior edge prevents a false positive", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/HillBehind", { x: -12, y: -4 }, { x: 12, y: 1.2 }, 1),
      // The front ground covers the strip below HillBehind's bottom edge, so the cut edge is hidden.
      layer("Scene:/Background/GroundFront", { x: -12, y: -5.5 }, { x: 12, y: -3.8 }, 2),
    ],
  };
  assert.equal(gate(evaluateBackgroundSeam(data, ASPECT_16x9)), "pass");
});

test("background-seam: occlusion is tested at the cut edge, not the gap midpoint", () => {
  const midpointOnly: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/Hill", { x: -12, y: -4 }, { x: 12, y: 1 }, 1),
      // Covers the midpoint between view bottom (-5) and Hill bottom (-4), but NOT Hill's actual cut edge.
      layer("Scene:/Background/MidStrip", { x: -12, y: -4.8 }, { x: 12, y: -4.6 }, 2),
    ],
  };
  assert.equal(gate(evaluateBackgroundSeam(midpointOnly, ASPECT_16x9)), "fail", "midpoint cover cannot hide the actual edge");
});

test("background-seam: top silhouettes are intentionally exempt", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/Horizon", { x: -12, y: -5.5 }, { x: 12, y: -1 }, 1),
    ],
  };
  assert.equal(gate(evaluateBackgroundSeam(data, ASPECT_16x9)), "pass");
});

test("background-seam: left/right interior cut edges FAIL", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/NarrowHill", { x: -7, y: -5.5 }, { x: 7, y: 1 }, 1),
    ],
  };
  const seam = evaluateBackgroundSeam(data, ASPECT_16x9);
  assert.equal(gate(seam), "fail");
  assert.match(seam.checks[0].detail, /left edge exposed/i);
  assert.match(seam.checks[0].detail, /right edge exposed/i);
});

test("background-seam: missing order and mixed sorting layers refuse instead of guessing", () => {
  const missingOrder: BackgroundData = {
    camera: camera(),
    layers: [{ locator: "Scene:/Background/Sky", min: { x: -12, y: -10 }, max: { x: 12, y: 10 } }],
  };
  const missing = evaluateBackgroundSeam(missingOrder, ASPECT_16x9);
  assert.equal(gate(missing), "fail");
  assert.match(missing.checks[0].detail, /lacks render-order/i);

  const mixed: BackgroundData = {
    camera: camera(),
    layers: [
      { ...layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0), order: { sortingOrder: 0, z: 0, sortingLayerName: "Back" } },
      { ...layer("Scene:/Background/Hill", { x: -12, y: -4 }, { x: 12, y: 1 }, 1), order: { sortingOrder: 1, z: 0, sortingLayerName: "Front" } },
    ],
  };
  const mixedReport = evaluateBackgroundSeam(mixed, ASPECT_16x9);
  assert.equal(gate(mixedReport), "fail");
  assert.match(mixedReport.checks[0].detail, /multiple sorting layers/i);
});

// ── background-seam: drawable annotation (cut-edge line + exposed strip) ─────────────

test("background-seam annotation: one TOP-origin segment per flagged layer with a horizontal bottom line", () => {
  // The moved-hills fixture: HillNear (min.y -4.21) + Ground (min.y -2.81) both bleed inside
  // the frame at 16:9 (rect bottom -5, top 5). Sky/HillFar bleed past, so 2 segments.
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/HillFar", { x: -12, y: -6 }, { x: 12, y: -1 }, 1),
      layer("Scene:/Background/HillNear", { x: -12, y: -4.21 }, { x: 12, y: 1.2 }, 2),
      layer("Scene:/Background/Ground", { x: -12, y: -2.81 }, { x: 12, y: 0.2 }, 3),
    ],
  };
  const seam = evaluateBackgroundSeam(data, ASPECT_16x9, { width: 1280, height: 720 });
  assert.equal(gate(seam), "fail");
  const ann = seam.checks[0].seamAnnotation;
  assert.ok(ann, "fail carries a seamAnnotation");
  assert.deepEqual(ann.viewport, { width: 1280, height: 720 });
  // One segment per flagged layer (HillNear + Ground), all bottom edges.
  assert.equal(ann.segments.length, 2);
  assert.ok(ann.segments.every((s) => s.edge === "bottom"));

  // Ground (largest exposed depth) sorts first. Its bottom line is HORIZONTAL (y0===y1) at the
  // expected normalized ny for min.y=-2.81: (top - y)/(top - bottom) = (5 - -2.81)/10 = 0.781.
  const ground = ann.segments[0];
  assert.match(ground.layerLocator, /Ground/);
  assert.equal(ground.line.y0, ground.line.y1, "bottom edge is a horizontal line");
  assert.ok(Math.abs(ground.line.y0 - 0.781) < 1e-6, `ny ${ground.line.y0}`);
  // The strip runs from the line down to the frame bottom (ny=1).
  assert.ok(Math.abs(ground.strip.y - ground.line.y0) < 1e-6, "strip starts at the line");
  assert.ok(Math.abs(ground.strip.y + ground.strip.height - 1) < 1e-6, "strip reaches the frame bottom");
  // exposedFraction = (min.y - bottom)/height = (-2.81 - -5)/10 = 0.219.
  assert.ok(Math.abs(ground.exposedFraction - 0.219) < 1e-6, `exposedFraction ${ground.exposedFraction}`);
});

test("background-seam annotation: left/right cut edges draw vertical lines + side strips", () => {
  // NarrowHill spans x∈[-7,7] inside a view rect x∈[-8.89,8.89] at 16:9 → exposed on BOTH sides.
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/NarrowHill", { x: -7, y: -5.5 }, { x: 7, y: 1 }, 1),
    ],
  };
  const seam = evaluateBackgroundSeam(data, ASPECT_16x9, { width: 1280, height: 720 });
  assert.equal(gate(seam), "fail");
  const ann = seam.checks[0].seamAnnotation;
  assert.ok(ann);
  const left = ann.segments.find((s) => s.edge === "left");
  const right = ann.segments.find((s) => s.edge === "right");
  assert.ok(left && right, "both a left and right segment");
  // Vertical lines: x0===x1.
  assert.equal(left.line.x0, left.line.x1, "left edge is a vertical line");
  assert.equal(right.line.x0, right.line.x1, "right edge is a vertical line");
  // Left strip hugs the frame left (x=0 → the line); right strip runs from the line to frame right (x+width≈1).
  assert.equal(left.strip.x, 0);
  assert.ok(Math.abs(left.strip.x + left.strip.width - left.line.x0) < 1e-6, "left strip ends at the line");
  assert.ok(Math.abs(right.strip.x - right.line.x0) < 1e-6, "right strip starts at the line");
  assert.ok(Math.abs(right.strip.x + right.strip.width - 1) < 1e-6, "right strip reaches the frame right");
});

test("background-seam annotation: a PASS carries no seamAnnotation", () => {
  const data: BackgroundData = {
    camera: camera(),
    layers: [
      layer("Scene:/Background/Sky", { x: -12, y: -10 }, { x: 12, y: 10 }, 0),
      layer("Scene:/Background/Ground", { x: -12, y: -5.4 }, { x: 12, y: 0.2 }, 3),
    ],
  };
  const seam = evaluateBackgroundSeam(data, ASPECT_16x9, { width: 1280, height: 720 });
  assert.equal(gate(seam), "pass");
  assert.equal(seam.checks[0].seamAnnotation, undefined);
});

// ── wiring: per-device grading, verdict, device tag, Must-fix, screen count ──────────

/** A contract that enables background-coverage across a base (16:9) + wide (20:9) device set. */
function coverageContract(deterministic: string[] = ["background-coverage"]): MinigameContract {
  return assertValidMinigameContract({
    schemaVersion: "1",
    id: "coverage-game",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/Game.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    devices: [
      { id: "base-16x9", label: "16:9", width: 1280, height: 720 },
      { id: "wide-20x9", label: "Tall Android (20:9)", width: 2400, height: 1080 },
    ],
    requiredInFrame: [{ id: "tile", locator: "Game:/Canvas/Tile" }],
    states: [
      { id: "start", kind: "start", requiredInFrame: ["tile"] },
      { id: "win", kind: "success_reward" },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 90 },
    interactionFlow: { happyPath: ["start", "win"] },
    artifactThresholds: {},
    backgroundLayers: ["Game:/Background/Sky"],
    backgroundCamera: "Game:/Main Camera",
    checks: { deterministic },
  });
}

/** Write the per-state captures the start state needs so the run grades it, + a background.json. */
async function writeCoveragePack(dir: string, skyHalfWidth: number, withOrder = false): Promise<void> {
  // Both devices need a `<state>@<device>` capture so the per-device loop grades the state.
  const uiDoc = (state: string) => ({
    state,
    viewport: { width: 1280, height: 720, aspect: ASPECT_16x9 },
    objects: [
      { id: "tile", path: "/Canvas/Tile", role: "image", active: true, isVisible: true, isFullyVisible: true, screenRect: { x: 100, y: 100, width: 200, height: 200 }, viewportRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ],
  });
  for (const dev of ["base-16x9", "wide-20x9"]) {
    await fs.writeFile(path.join(dir, `start@${dev}.ui-rects.json`), JSON.stringify(uiDoc("start"), null, 2), "utf-8");
  }
  await fs.writeFile(path.join(dir, "start.ui-rects.json"), JSON.stringify(uiDoc("start"), null, 2), "utf-8");
  await fs.writeFile(path.join(dir, "start.console.json"), JSON.stringify({ errorCount: 0 }), "utf-8");

  const background: BackgroundData = {
    camera: camera(),
    layers: [withOrder ? layer("Game:/Background/Sky", { x: -skyHalfWidth, y: -5 }, { x: skyHalfWidth, y: 5 }, 0) : skyLayer(skyHalfWidth)],
  };
  await fs.writeFile(path.join(dir, BACKGROUND_DATA_FILE), JSON.stringify(background, null, 2), "utf-8");
}

test("wiring: a per-device coverage FAIL fails the verdict, is keyed per device, and stays OUT of the screen count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-coverage-"));
  try {
    // Sky 9.6: covers 16:9 (base) but not 20:9 (wide) — a per-device fail on the wide device.
    await writeCoveragePack(dir, 9.6);
    const contract = coverageContract();
    const verdict = await runMinigameGates(contract, dir);

    // The verdict fails (worst-of) because the wide device is uncovered.
    assert.equal(verdict.status, "fail");

    // The background reports live under reserved sentinel keys, one per device.
    const bgKeys = Object.keys(verdict.states).filter(isBackgroundKey);
    assert.equal(bgKeys.length, 2, `one background key per device; got ${bgKeys.join(", ")}`);
    const baseKey = bgKeys.find((k) => k.endsWith("@base-16x9"))!;
    const wideKey = bgKeys.find((k) => k.endsWith("@wide-20x9"))!;
    assert.equal(verdict.states[baseKey][0].verdict, "pass", "base 16:9 covered");
    assert.equal(verdict.states[wideKey][0].verdict, "fail", "wide 20:9 uncovered");

    // The screen count is exactly the 2 CONTRACT states (start graded; win is an
    // uncaptured success_reward) — the background sentinel adds NO screen even though it
    // contributed per-device reports to verdict.states.
    const s = summarize(verdict.states);
    assert.equal(s.statesTotal, 2, "2 contract screens (start, win); the background sentinel is not a screen");
    // background-coverage is the ONLY enabled check and it is frame-level (not per-state), so
    // no per-STATE check ran — statesGraded is 0 (and crucially is NOT inflated by the sentinel).
    assert.equal(s.statesGraded, 0, "no per-state screen check ran; the sentinel never counts as a graded screen");
    // The sentinel's logical key must NOT appear among the counted screens.
    const countedLogical = new Set(
      Object.keys(verdict.states).filter((k) => !isBackgroundKey(k)).map((k) => splitStateDevice(k).state),
    );
    assert.ok(!countedLogical.has("__background-coverage__"), "the sentinel is never a counted screen");

    // splitStateDevice resolves the device id off the sentinel key (the last '@' is the delimiter).
    assert.equal(splitStateDevice(wideKey).deviceId, "wide-20x9");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("wiring: the coverage FAIL lands in the Must-fix (blockingFailures) tier, tagged with its device", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-coverage-"));
  try {
    await writeCoveragePack(dir, 9.6);
    const contract = coverageContract();
    const verdict = await runMinigameGates(contract, dir);

    // Flatten the way the report does, then group into CR tiers.
    const failures = Object.entries(verdict.states).flatMap(([key, reports]) => {
      const { state, deviceId } = splitStateDevice(key);
      return reports.flatMap((r) =>
        r.checks
          .filter((c) => c.status === "fail")
          .map((c) => ({
            state,
            gate: r.gate,
            id: c.id,
            expected: c.expected,
            actual: c.actual,
            detail: c.detail,
            device: deviceId ? { id: deviceId, label: deviceId } : undefined,
          })),
      );
    });
    const cr = buildCrGroups(verdict.states, failures, [], [], undefined, undefined, [], undefined, new Map([["wide-20x9", "Tall Android (20:9)"]]));

    const bgBlocking = cr.blockingFailures.filter((f) => f.gate === "background-coverage");
    assert.equal(bgBlocking.length, 1, "the coverage fail is a Must-fix blocking failure");
    assert.equal(bgBlocking[0].device?.id, "wide-20x9", "the finding is tagged with the failing device");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("wiring: full coverage passes on EVERY device and the verdict is green", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-coverage-"));
  try {
    await writeCoveragePack(dir, 12); // wide enough for 20:9
    const contract = coverageContract();
    const verdict = await runMinigameGates(contract, dir);
    const bgKeys = Object.keys(verdict.states).filter(isBackgroundKey);
    for (const k of bgKeys) assert.equal(verdict.states[k][0].verdict, "pass", `${k} covered`);
    assert.equal(verdict.status, "pass");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("wiring: background-seam is graded only under the per-device sentinel, never as per-state unrecognized noise", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-seam-"));
  try {
    await writeCoveragePack(dir, 12, true);
    const verdict = await runMinigameGates(coverageContract(["background-seam"]), dir);

    const bgKeys = Object.keys(verdict.states).filter(isBackgroundKey);
    assert.equal(bgKeys.length, 2, `one seam key per device; got ${bgKeys.join(", ")}`);
    for (const k of bgKeys) {
      assert.equal(verdict.states[k][0].gate, "background-seam");
      assert.equal(verdict.states[k][0].verdict, "pass");
    }
    const perStateSeamReports = Object.entries(verdict.states)
      .filter(([key]) => !isBackgroundKey(key))
      .flatMap(([, reports]) => reports)
      .filter((r) => r.gate === "background-seam");
    assert.equal(perStateSeamReports.length, 0, "frame/device-level seam gate must not produce per-state not_applicable noise");
    assert.equal(verdict.status, "pass");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("wiring: a missing background.json refuses (FAIL) per device — never a silent green", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-coverage-"));
  try {
    await writeCoveragePack(dir, 12);
    await fs.rm(path.join(dir, BACKGROUND_DATA_FILE)); // delete the geometry pack
    const verdict = await runMinigameGates(coverageContract(), dir);
    const bgKeys = Object.keys(verdict.states).filter(isBackgroundKey);
    for (const k of bgKeys) assert.equal(verdict.states[k][0].verdict, "fail", `${k} refuses on absent background.json`);
    assert.equal(verdict.status, "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
