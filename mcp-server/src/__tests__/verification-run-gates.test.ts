/**
 * run-gates CLI glue tests — drives the Phase-C evaluators from a directory of
 * captured op-output JSON files using the REAL captured Tiderunner fixtures
 * (the same data the gates test uses: LiberationSans font, cyan score,
 * player centerX 0.102, manifest all_ok). Asserts the assembled
 * build-verdict.json is overall `fail` with the expected per-gate verdicts,
 * plus the missing-input -> WARN degrade and the advisory `--vlm` merge.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runGates, isGateInStage, VERIFY_STAGES, type ReviewFindings } from "../capabilities/verification/run-gates.js";
import type { AcceptanceContract } from "../capabilities/verification/types.js";
import { createDraftAssetManifest, type AssetManifest } from "../capabilities/assets/asset-manifest.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const acceptancePath = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/capabilities/verification/tiderunner.acceptance.json",
);
const switchyardAcceptancePath = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/capabilities/verification/switchyard-courier.acceptance.json",
);

async function loadAcceptance(): Promise<AcceptanceContract> {
  return JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as AcceptanceContract;
}

async function loadSwitchyardAcceptance(): Promise<AcceptanceContract> {
  return JSON.parse(await fs.readFile(switchyardAcceptancePath, "utf-8")) as AcceptanceContract;
}

function cleanTileRenderCapture(): Record<string, unknown> {
  return {
    platforms: [{
      name: "Ground",
      drawMode: "Tiled",
      rendererCount: 1,
      widthTiles: 16,
      tileSprite: {
        name: "ground_tile",
        tileWidthPx: 16,
        edgeCols: 2,
        columnLuma: [0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41, 0.40, 0.40, 0.41],
      },
    }],
  };
}

function cleanParallaxMotionCapture(): Record<string, unknown> {
  return {
    layers: [
      {
        name: "Sky",
        mode: "TargetFollow",
        factorX: 0.2,
        factorY: 0,
        tileWorldWidth: 2.5,
        tileWorldHeight: 2.5,
        samples: [
          { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
          { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
          { state: "run-right", offsetX: 0.08, offsetY: 0, playerX: 1, playerY: 0 },
          { state: "at-apex", offsetX: 0.08, offsetY: 0, playerX: 1, playerY: 0.5 },
        ],
      },
      {
        name: "Hills",
        mode: "TargetFollow",
        factorX: 0.5,
        factorY: 0,
        tileWorldWidth: 2.5,
        tileWorldHeight: 2.5,
        samples: [
          { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
          { state: "idle", offsetX: 0, offsetY: 0, playerX: 0, playerY: 0 },
          { state: "run-right", offsetX: 0.2, offsetY: 0, playerX: 1, playerY: 0 },
          { state: "at-apex", offsetX: 0.2, offsetY: 0, playerX: 1, playerY: 0.5 },
        ],
      },
    ],
  };
}

function cleanFeelCapture(): Record<string, unknown> {
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
  };
}

// REAL captured Tiderunner op outputs (mirrors verification-gates.test.ts).
const CAPTURES: Record<string, unknown> = {
  "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
  "ui-scan.json": {
    components: [
      { name: "ScoreLabel", type: "TMPro.TextMeshProUGUI", fontName: "LiberationSans SDF", color: { r: 0.302, g: 0.816, b: 0.882, a: 1 } },
      { name: "TimerLabel", fontName: "LiberationSans SDF", color: { r: 1, g: 1, b: 1, a: 1 } },
      { name: "LivesLabel", fontName: "LiberationSans SDF", color: { r: 1, g: 0.302, b: 0.553, a: 1 } },
      { name: "MessageLabel", fontName: "LiberationSans SDF", color: { r: 1, g: 0.816, b: 0.4, a: 1 } },
    ],
  },
  "screen-rects.json": {
    camera: {
      name: "Main Camera",
      orthographic: true,
      orthographicSize: 5.854,
      authoredOrthographicSize: 4.5,
      position: { x: 8, y: 4.5, z: -10 },
      pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false, pixelSnapping: true },
    },
    objects: [
      { name: "Player", centerXFraction: 0.102, isPartiallyClipped: false },
      { name: "Flag", centerXFraction: 0.867, isPartiallyClipped: false },
    ],
  },
  "playability.json": {
    completable: true,
    completionMethod: "played", // completed by movement, not a teleport
    winRuleObserved: "all-fruit", // Phase F: now the ACCEPTED rule -> conforms
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  },
  "coverage.json": {
    cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 },
    layers: [{ name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 }],
    atSeconds: 8,
  },
  "parallax-motion.json": cleanParallaxMotionCapture(),
  "render-frame.json": {
    frames: [{ id: "spawn", width: 1920, height: 1080, edgeBlackFraction: { top: 0, right: 0, bottom: 0, left: 0 }, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
  "visual-artifacts.json": {
    frames: [{ id: "spawn", longLines: [] }],
  },
  "platform-tiles.json": {
    platforms: [{ name: "Ground", widthTiles: 16, heightTiles: 1, rows: [{ index: 0, role: "top_cap" }], colliderTopY: 1, visibleTopY: 1 }],
  },
  "tile-render.json": cleanTileRenderCapture(),
  "reachability.json": {
    platforms: [{ name: "Ground", topY: 0, minX: -4, maxX: 16 }],
    collectibles: [
      { name: "Apple1", x: 2, y: 1.5 },
      { name: "Apple2", x: 8, y: 2.0 },
    ],
  },
  "feel.json": cleanFeelCapture(),
};

async function writeCaptures(dir: string, files: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf-8");
  }
}

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-run-gates-"));
}

function approvedGeneratedManifest(): AssetManifest {
  const heroHash = "f".repeat(64);
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

test("run-gates (post-reconcile live captures): overall fail driven by UI font/color findings", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, CAPTURES);
    const report = await runGates({ acceptance, inputsDir: dir });

    assert.equal(report.status, "fail");
    assert.equal(report.gates["manifest"], "pass");
    assert.equal(report.gates["ui-conformance"], "fail");
    // Static camera -> framing no longer warns on the anchor.
    assert.equal(report.gates["framing"], "pass");
    // all-fruit accepted -> playability passes.
    assert.equal(report.gates["playability"], "pass");
    assert.equal(report.gates["feel"], "pass");

    const failIds = report.failures.map((c) => c.id);
    assert.ok(failIds.includes("font.ScoreLabel"));
    assert.ok(failIds.includes("color.ScoreLabel"));
    // The win-rule mismatch is resolved by the reconcile; not a failure anymore.
    assert.ok(!failIds.includes("playability.winRule"));
    // The anchor is neither a failure nor a warn under a static camera.
    assert.ok(!failIds.includes("anchor.player"));
    assert.ok(!report.warnings.some((c) => c.id === "anchor.player"));

    // No advisory block unless --vlm provided.
    assert.equal(report.reviewFindings, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: asset-manifest input adds asset-source-fidelity gate and flags drift", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    const manifest = approvedGeneratedManifest();
    await writeCaptures(dir, {
      ...CAPTURES,
      "asset-manifest.json": {
        manifest,
        observedAssets: [{
          assetId: "player_character",
          source: "registry",
          paths: ["Assets/Art/Sprites/Characters/registry-player.png"],
        }],
      },
    });
    const report = await runGates({ acceptance, inputsDir: dir });

    assert.equal(report.gates["asset-source-fidelity"], "fail");
    assert.ok(report.failures.some((failure) => failure.id === "asset-source.observed.player_character"));
    assert.ok(report.failures.some((failure) => /differs from the manifest source or paths/.test(failure.detail)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: a forged artDeferred:true in the staged input cannot neuter asset-source fidelity under an art:final contract (RCL-D02 review)", async () => {
  const acceptance = await loadAcceptance(); // no `art` section => art:final
  const dir = await mkTmpDir();
  try {
    // An approved manifest whose required roles are primitiveFinal with provenance STRIPPED.
    const manifest = approvedGeneratedManifest();
    manifest.assets = manifest.assets.map((asset) => {
      const a = { ...asset, primitiveFinal: true } as Record<string, unknown>;
      delete a.resolvedPaths;
      delete a.generatedExport;
      return a as unknown as (typeof manifest.assets)[number];
    });
    await writeCaptures(dir, {
      ...CAPTURES,
      // THE FORGE: the agent-staged gate input claims gray-box to waive provenance, even though
      // the on-disk acceptance contract is art:final. The orchestrator must IGNORE this flag and
      // derive artDeferred from disk-truth (false) — so the unprovenanced roles do NOT pass.
      "asset-manifest.json": { manifest, artDeferred: true },
    });
    const report = await runGates({ acceptance, inputsDir: dir });
    assert.notEqual(
      report.gates["asset-source-fidelity"],
      "pass",
      "a forged artDeferred:true must not let primitiveFinal skip asset-source fidelity under art:final",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: asset-source-fidelity is not graded for slices that did not request it", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    const manifest = approvedGeneratedManifest();
    await writeCaptures(dir, {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [] },
      "asset-manifest.json": {
        manifest,
        observedAssets: [{
          assetId: "player_character",
          source: "registry",
          paths: ["Assets/Art/Sprites/Characters/registry-player.png"],
        }],
      },
    });
    const report = await runGates({
      acceptance,
      inputsDir: dir,
      selectGates: new Set(["manifest"]),
    });

    assert.equal(report.gates["asset-source-fidelity"], "not_applicable");
    assert.equal(report.failures.some((failure) => failure.id === "asset-source.observed.player_character"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: asset-source-fidelity is out of scope for construct stage diagnostics", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    const manifest = approvedGeneratedManifest();
    await writeCaptures(dir, {
      "asset-manifest.json": {
        manifest,
        observedAssets: [{
          assetId: "player_character",
          source: "registry",
          paths: ["Assets/Art/Sprites/Characters/registry-player.png"],
        }],
      },
    });
    const report = await runGates({
      acceptance,
      inputsDir: dir,
      stage: "construct",
    });

    assert.equal(report.gates["asset-source-fidelity"], "not_applicable");
    assert.equal(report.failures.some((failure) => failure.id === "asset-source.observed.player_character"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: a missing capture degrades that gate to WARN (does not crash)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    // Drop the feel capture; everything else present.
    const partial = { ...CAPTURES };
    delete (partial as Record<string, unknown>)["feel.json"];
    await writeCaptures(dir, partial);

    const report = await runGates({ acceptance, inputsDir: dir });

    // feel degrades to a WARN gate with a single `feel.input` check.
    assert.equal(report.gates["feel"], "warn");
    const inputCheck = report.checks.find((c) => c.id === "feel.input");
    assert.ok(inputCheck, "expected a feel.input degraded check");
    assert.equal(inputCheck?.status, "warn");
    // Tier-1 still fails because ui-conformance fails (font/color) regardless.
    assert.equal(report.status, "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: empty inputs dir -> all gates WARN, overall warn (no crash)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const report = await runGates({ acceptance, inputsDir: dir });
    assert.equal(report.status, "warn");
    for (const gate of ["manifest", "ui-conformance", "framing", "render-frame", "coverage", "parallax-motion", "visual-artifacts", "reachability", "placement", "platform-tiles", "tile-render", "prop-purpose", "playability", "feel", "feel-provenance", "physics-timestep", "console-clean"]) {
      assert.equal(report.gates[gate], "warn", `${gate} should degrade to warn`);
    }
    assert.equal(report.failures.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: contract-declared not_applicable gates are skipped, not warned", async () => {
  const acceptance = await loadSwitchyardAcceptance();
  const dir = await mkTmpDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const report = await runGates({ acceptance, inputsDir: dir });

    assert.equal(report.gates["coverage"], "not_applicable");
    assert.equal(report.gates["parallax-motion"], "not_applicable");
    assert.equal(report.gates["platform-tiles"], "not_applicable");
    assert.equal(report.gates["tile-render"], "not_applicable");
    assert.equal(report.gates["reachability"], "not_applicable");
    assert.ok(!report.warnings.some((c) => c.id === "coverage.input"));
    assert.ok(!report.warnings.some((c) => c.id === "reachability.input"));

    assert.equal(report.gates["manifest"], "warn");
    assert.equal(report.gates["playability"], "warn");
    assert.equal(report.status, "warn");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: --vlm merges advisory reviewFindings under a SEPARATE key, not the status", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, CAPTURES);
    const vlm: ReviewFindings = {
      frames: [{ id: "win", path: ".artifacts/verify/frames/win.png" }],
      criteria: [
        { id: "end-state-styling", status: "fail", reason: "YOU WIN uses default font, mock specifies Press Start 2P", evidenceFrame: "win" },
        { id: "palette-adherence", status: "warn", reason: "sky reads slightly cool vs mock", evidenceFrame: "win" },
      ],
      summary: "1 fail / 1 warn (advisory)",
    };
    const vlmPath = path.join(dir, "vlm-review.json");
    await fs.writeFile(vlmPath, JSON.stringify(vlm, null, 2), "utf-8");

    const report = await runGates({ acceptance, inputsDir: dir, vlmPath });

    // The advisory block is present and untouched...
    assert.ok(report.reviewFindings);
    assert.equal(report.reviewFindings?.criteria.length, 2);
    assert.equal(report.reviewFindings?.criteria[0]?.id, "end-state-styling");
    // ...but the advisory fail does NOT change the Tier-1 verdict math: the
    // status is still driven only by the Tier-1 gates (which fail on their own).
    assert.equal(report.status, "fail");
    // No advisory criterion id leaked into the Tier-1 failures list.
    assert.ok(!report.failures.some((c) => c.id === "end-state-styling"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: --vlm with byte-identical key frames FAILs via frame-integrity gate", async () => {
  // The clean-room bug: distinct-state key frames (spawn, win) that are the SAME
  // image — a stale/duplicate capture the perceptual review rubber-stamped.
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    // Conformant Tier-1 captures so the ONLY thing that can fail is frame-integrity.
    await writeCaptures(dir, {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
      "ui-scan.json": {
        components: [
          { name: "ScoreLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 } },
          { name: "LivesLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 } },
        ],
        canvas: { renderMode: "Screen Space - Camera", cameraName: "UICamera", cameraHasPixelPerfect: true, cameraUpscaleRT: false },
      },
      "screen-rects.json": {
        camera: {
          name: "Main Camera",
          orthographic: true,
          orthographicSize: 5.854,
          authoredOrthographicSize: 4.5,
          position: { x: 8, y: 4.5, z: -10 },
          pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false, pixelSnapping: true },
        },
        objects: [
          { name: "Player", centerXFraction: 0.4, isPartiallyClipped: false },
          { name: "Flag", centerXFraction: 0.85, isPartiallyClipped: false },
        ],
      },
      "playability.json": { completable: true, completionMethod: "played", winRuleObserved: "all-fruit", hazardKills: true, collectibleIncrements: true, postWinInputLocked: true, postWinPlayerFrozen: true, restartWorks: true },
      "coverage.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, layers: [{ name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 }], atSeconds: 8 },
      "parallax-motion.json": cleanParallaxMotionCapture(),
      "render-frame.json": { frames: [{ id: "spawn", width: 1920, height: 1080, edgeBlackFraction: { top: 0, right: 0, bottom: 0, left: 0 }, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      "visual-artifacts.json": { frames: [{ id: "spawn", longLines: [] }] },
      "platform-tiles.json": { platforms: [{ name: "Ground", widthTiles: 16, heightTiles: 1, rows: [{ index: 0, role: "top_cap" }], colliderTopY: 1, visibleTopY: 1 }] },
      "tile-render.json": cleanTileRenderCapture(),
      "reachability.json": { platforms: [{ name: "Ground", topY: 0, minX: -4, maxX: 16 }], collectibles: [{ name: "Apple1", x: 2, y: 1.5 }, { name: "Apple2", x: 8, y: 2.0 }] },
      "placement.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, grounds: [{ name: "Ground", minX: -1, maxX: 17, topY: 1 }], groundedItems: [{ name: "Flag", visibleBottomY: 1.0, surfaceTopY: 1.0 }] },
      "feel.json": cleanFeelCapture(),
    });

    // Two key frames that are BYTE-IDENTICAL (same bytes written to both files).
    const framesDir = path.join(dir, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    const sameBytes = Buffer.from("PNGDATA-identical-capture");
    await fs.writeFile(path.join(framesDir, "spawn.png"), sameBytes);
    await fs.writeFile(path.join(framesDir, "win.png"), sameBytes);

    const vlm: ReviewFindings = {
      frames: [
        { id: "spawn", path: "frames/spawn.png" },
        { id: "win", path: "frames/win.png" },
      ],
      criteria: [{ id: "end-state-styling", status: "pass", reason: "win banner styled (rubber-stamped against a stale frame)", evidenceFrame: "win" }],
      summary: "advisory",
    };
    const vlmPath = path.join(dir, "vlm-review.json");
    await fs.writeFile(vlmPath, JSON.stringify(vlm, null, 2), "utf-8");

    const report = await runGates({ acceptance, inputsDir: dir, vlmPath });

    assert.equal(report.status, "fail");
    assert.equal(report.gates["frame-integrity"], "fail");
    const c = report.failures.find((x) => x.id === "frame-integrity.distinct");
    assert.ok(c, "expected a frame-integrity.distinct failure");
    assert.match(c.actual, /spawn/);
    assert.match(c.actual, /win/);
    // Advisory block still merged untouched.
    assert.ok(report.reviewFindings);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: --vlm with DISTINCT key frames -> frame-integrity passes (no forced fail)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    // Same conformant Tier-1 captures so overall pass hinges on frame-integrity.
    await writeCaptures(dir, {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
      "ui-scan.json": {
        components: [
          { name: "ScoreLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 } },
          { name: "LivesLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 } },
        ],
        canvas: { renderMode: "Screen Space - Camera", cameraName: "UICamera", cameraHasPixelPerfect: true, cameraUpscaleRT: false },
      },
      "screen-rects.json": {
        camera: {
          name: "Main Camera",
          orthographic: true,
          orthographicSize: 5.854,
          authoredOrthographicSize: 4.5,
          position: { x: 8, y: 4.5, z: -10 },
          pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false, pixelSnapping: true },
        },
        objects: [
          { name: "Player", centerXFraction: 0.4, isPartiallyClipped: false },
          { name: "Flag", centerXFraction: 0.85, isPartiallyClipped: false },
        ],
      },
      "playability.json": { completable: true, completionMethod: "played", winRuleObserved: "all-fruit", hazardKills: true, collectibleIncrements: true, postWinInputLocked: true, postWinPlayerFrozen: true, restartWorks: true },
      "coverage.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, layers: [{ name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 }, { name: "Hills", minX: -1, maxX: 17, minY: -1, maxY: 7 }], atSeconds: 8 },
      "parallax-motion.json": cleanParallaxMotionCapture(),
      "render-frame.json": { frames: [{ id: "spawn", width: 1920, height: 1080, edgeBlackFraction: { top: 0, right: 0, bottom: 0, left: 0 }, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      "visual-artifacts.json": { frames: [{ id: "spawn", longLines: [] }] },
      "platform-tiles.json": { platforms: [{ name: "Ground", widthTiles: 16, heightTiles: 1, rows: [{ index: 0, role: "top_cap" }], colliderTopY: 1, visibleTopY: 1 }] },
      "tile-render.json": cleanTileRenderCapture(),
      "reachability.json": { platforms: [{ name: "Ground", topY: 0, minX: -4, maxX: 16 }], collectibles: [{ name: "Apple1", x: 2, y: 1.5 }, { name: "Apple2", x: 8, y: 2.0 }] },
      "placement.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, grounds: [{ name: "Ground", minX: -1, maxX: 17, topY: 1 }], groundedItems: [{ name: "Flag", visibleBottomY: 1.0, surfaceTopY: 1.0 }] },
      "objects.json": { player: { name: "Player", bounds: { minX: 0, maxX: 1, minY: 0, maxY: 2 } }, props: [{ name: "Apple1", bounds: { minX: 2, maxX: 3, minY: 1, maxY: 2 }, hasCollider: false, scripts: ["Collectible"] }] },
      "console.json": { logs: [{ type: "log", message: "Entered play mode" }] },
      "feel.json": cleanFeelCapture(),
    });

    // Two DIFFERENT key frames.
    const framesDir = path.join(dir, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, "spawn.png"), Buffer.from("PNGDATA-spawn-state"));
    await fs.writeFile(path.join(framesDir, "win.png"), Buffer.from("PNGDATA-win-state-different"));

    const vlm: ReviewFindings = {
      frames: [
        { id: "spawn", path: "frames/spawn.png" },
        { id: "win", path: "frames/win.png" },
      ],
      criteria: [{ id: "end-state-styling", status: "pass", reason: "win banner styled", evidenceFrame: "win" }],
      summary: "advisory",
    };
    const vlmPath = path.join(dir, "vlm-review.json");
    await fs.writeFile(vlmPath, JSON.stringify(vlm, null, 2), "utf-8");

    const report = await runGates({ acceptance, inputsDir: dir, vlmPath });

    assert.equal(report.gates["frame-integrity"], "pass");
    // frame-integrity itself does not force a fail; the build is overall pass.
    assert.equal(report.status, "pass");
    assert.equal(report.failures.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── P1.3: ONE consolidated multi-state review at the verify root ─────────────
// The default verify path is a single VLM over ALL capturePack states' frames
// (not spawn-only). A root-level vlm-review.json references frames by their
// state-relative path; run-gates resolves them relative to the VLM file's own
// dir, so the consolidated review spans every state subdir, and frame-integrity
// hashes across ALL of them (a stale capture in ANY state is caught).

/** Conformant Tier-1 captures (so the only failure axis is frame-integrity). */
function conformantCaptures(): Record<string, unknown> {
  return {
    "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
    "ui-scan.json": {
      components: [
        { name: "ScoreLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 } },
        { name: "LivesLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 } },
      ],
      canvas: { renderMode: "Screen Space - Camera", cameraName: "UICamera", cameraHasPixelPerfect: true, cameraUpscaleRT: false },
    },
    "screen-rects.json": {
      camera: {
        name: "Main Camera",
        orthographic: true,
        orthographicSize: 5.854,
        authoredOrthographicSize: 4.5,
        position: { x: 8, y: 4.5, z: -10 },
        pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false, pixelSnapping: true },
      },
      objects: [
        { name: "Player", centerXFraction: 0.4, isPartiallyClipped: false },
        { name: "Flag", centerXFraction: 0.85, isPartiallyClipped: false },
      ],
    },
    "playability.json": { completable: true, completionMethod: "played", winRuleObserved: "all-fruit", hazardKills: true, collectibleIncrements: true, postWinInputLocked: true, postWinPlayerFrozen: true, restartWorks: true },
    "coverage.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, layers: [{ name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 }, { name: "Hills", minX: -1, maxX: 17, minY: -1, maxY: 7 }], atSeconds: 8 },
    "parallax-motion.json": cleanParallaxMotionCapture(),
    "render-frame.json": { frames: [{ id: "spawn", width: 1920, height: 1080, edgeBlackFraction: { top: 0, right: 0, bottom: 0, left: 0 }, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    "visual-artifacts.json": { frames: [{ id: "spawn", longLines: [] }] },
    "platform-tiles.json": { platforms: [{ name: "Ground", widthTiles: 16, heightTiles: 1, rows: [{ index: 0, role: "top_cap" }], colliderTopY: 1, visibleTopY: 1 }] },
    "tile-render.json": cleanTileRenderCapture(),
    "reachability.json": { platforms: [{ name: "Ground", topY: 0, minX: -4, maxX: 16 }], collectibles: [{ name: "Apple1", x: 2, y: 1.5 }, { name: "Apple2", x: 8, y: 2.0 }] },
    "placement.json": { cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 }, grounds: [{ name: "Ground", minX: -1, maxX: 17, topY: 1 }], groundedItems: [{ name: "Flag", visibleBottomY: 1.0, surfaceTopY: 1.0 }] },
    "objects.json": { player: { name: "Player", bounds: { minX: 0, maxX: 1, minY: 0, maxY: 2 } }, props: [{ name: "Apple1", bounds: { minX: 2, maxX: 3, minY: 1, maxY: 2 }, hasCollider: false, scripts: ["Collectible"] }] },
    "console.json": { logs: [{ type: "log", message: "Entered play mode" }] },
    "feel.json": cleanFeelCapture(),
  };
}

/** Write one distinct PNG per state under `<dir>/<state>/frames/<state>.png`. */
async function writeStateFrames(dir: string, states: string[]): Promise<void> {
  for (const state of states) {
    const framesDir = path.join(dir, state, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, `${state}.png`), Buffer.from(`PNGDATA-${state}-state`));
  }
}

test("run-gates: ONE consolidated review at the verify root resolves frames across all state subdirs (P1.3)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, conformantCaptures());
    const states = ["spawn", "hazard", "movement", "win"];
    await writeStateFrames(dir, states);

    // The consolidated review lives at the verify ROOT and references each frame
    // by its state-relative path — exactly the default flow in vlm-review.md §5.
    const vlm: ReviewFindings = {
      reference: { heroShot: ".loombridge/design/hero-shot.png", heroShotSha256: "a".repeat(64) },
      independence: { independent: true, reviewerCount: 3 },
      frames: states.map((s) => ({ id: s, path: `${s}/frames/${s}.png` })),
      criteria: [
        { id: "composition-match", status: "pass", reason: "layout matches", evidenceFrame: "spawn" },
        { id: "parallax-present", status: "pass", reason: "layers present", evidenceFrame: "spawn" },
        { id: "platform-tiers", status: "pass", reason: "staged", evidenceFrame: "movement" },
        { id: "element-placement-arc", status: "pass", reason: "on the arc", evidenceFrame: "movement" },
      ],
      summary: "consolidated multi-state review",
    };
    const vlmPath = path.join(dir, "vlm-review.json"); // verify ROOT, not a per-state subdir
    await fs.writeFile(vlmPath, JSON.stringify(vlm, null, 2), "utf-8");

    const report = await runGates({ acceptance, inputsDir: dir, vlmPath });

    // All four cross-state frames resolved + hashed distinct → frame-integrity passes.
    assert.equal(report.gates["frame-integrity"], "pass");
    assert.equal(report.status, "pass", JSON.stringify(report.failures));
    // The consolidated findings (incl. reference + independence) flow to the verdict.
    assert.equal(report.reviewFindings?.frames?.length, 4);
    assert.equal(report.reviewFindings?.reference?.heroShotSha256, "a".repeat(64));
    assert.equal(report.reviewFindings?.independence?.reviewerCount, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: consolidated review catches a stale capture in a NON-spawn state (P1.3 + P0.4)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, conformantCaptures());
    await writeStateFrames(dir, ["spawn", "movement"]);
    // hazard and win share BYTE-IDENTICAL frames — a stale capture across two
    // distinct states that a spawn-only review would never have seen.
    const sameBytes = Buffer.from("PNGDATA-stale-shared-frame");
    for (const state of ["hazard", "win"]) {
      await fs.mkdir(path.join(dir, state, "frames"), { recursive: true });
      await fs.writeFile(path.join(dir, state, "frames", `${state}.png`), sameBytes);
    }

    const vlm: ReviewFindings = {
      reference: { heroShotSha256: "a".repeat(64) },
      independence: { independent: true, reviewerCount: 2 },
      frames: ["spawn", "hazard", "movement", "win"].map((s) => ({ id: s, path: `${s}/frames/${s}.png` })),
      criteria: [{ id: "composition-match", status: "pass", reason: "ok", evidenceFrame: "spawn" }],
      summary: "consolidated",
    };
    const vlmPath = path.join(dir, "vlm-review.json");
    await fs.writeFile(vlmPath, JSON.stringify(vlm, null, 2), "utf-8");

    const report = await runGates({ acceptance, inputsDir: dir, vlmPath });

    assert.equal(report.gates["frame-integrity"], "fail");
    const c = report.failures.find((x) => x.id === "frame-integrity.distinct");
    assert.ok(c, "expected a cross-state frame-integrity.distinct failure");
    assert.match(c.actual, /hazard/);
    assert.match(c.actual, /win/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run-gates: conformant captures -> overall pass", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
      "ui-scan.json": {
        components: [
          { name: "ScoreLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 } },
          { name: "LivesLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 } },
        ],
        // Render path captured + upscaleRT off -> ui.hudCrispness passes (no warn).
        canvas: {
          renderMode: "Screen Space - Camera",
          cameraName: "UICamera",
          cameraHasPixelPerfect: true,
          cameraUpscaleRT: false,
        },
      },
      "screen-rects.json": {
        camera: {
          name: "Main Camera",
          orthographic: true,
          orthographicSize: 5.854,
          authoredOrthographicSize: 4.5,
          position: { x: 8, y: 4.5, z: -10 },
          pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false, pixelSnapping: true },
        },
        objects: [
          { name: "Player", centerXFraction: 0.4, isPartiallyClipped: false },
          { name: "Flag", centerXFraction: 0.85, isPartiallyClipped: false },
        ],
      },
      "playability.json": {
        completable: true,
        completionMethod: "played", // completed by movement, not a teleport
        winRuleObserved: "all-fruit", // Phase F accepted rule
        hazardKills: true,
        collectibleIncrements: true,
        postWinInputLocked: true,
        postWinPlayerFrozen: true,
        restartWorks: true,
      },
      "coverage.json": {
        cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 },
        // Sky covers the frame; Hills reaches below the floor (coversBottom passes).
        layers: [
          { name: "Sky", minX: -1, maxX: 17, minY: -1, maxY: 10 },
          { name: "Hills", minX: -1, maxX: 17, minY: -1, maxY: 7 },
        ],
        atSeconds: 8,
      },
      "parallax-motion.json": cleanParallaxMotionCapture(),
      "render-frame.json": {
        frames: [{ id: "spawn", width: 1920, height: 1080, edgeBlackFraction: { top: 0, right: 0, bottom: 0, left: 0 }, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } }],
      },
      "visual-artifacts.json": {
        frames: [{ id: "spawn", longLines: [] }],
      },
      "platform-tiles.json": {
        platforms: [{ name: "Ground", widthTiles: 16, heightTiles: 1, rows: [{ index: 0, role: "top_cap" }], colliderTopY: 1, visibleTopY: 1 }],
      },
      "tile-render.json": cleanTileRenderCapture(),
      "reachability.json": {
        platforms: [{ name: "Ground", topY: 0, minX: -4, maxX: 16 }],
        collectibles: [
          { name: "Apple1", x: 2, y: 1.5 },
          { name: "Apple2", x: 8, y: 2.0 },
        ],
      },
      "placement.json": {
        cameraFrame: { minX: 0, maxX: 16, minY: 0, maxY: 9 },
        // Boundary grounds run past both frame edges; flag rests on its surface.
        grounds: [{ name: "Ground", minX: -1, maxX: 17, topY: 1 }],
        groundedItems: [{ name: "Flag", visibleBottomY: 1.0, surfaceTopY: 1.0 }],
      },
      "objects.json": {
        // A functional collectible clear of the player -> prop-purpose passes.
        player: { name: "Player", bounds: { minX: 0, maxX: 1, minY: 0, maxY: 2 } },
        props: [
          { name: "Apple1", bounds: { minX: 2, maxX: 3, minY: 1, maxY: 2 }, hasCollider: false, scripts: ["Collectible"] },
        ],
      },
      "console.json": { logs: [{ type: "log", message: "Entered play mode" }] },
      "feel.json": cleanFeelCapture(),
    });

    const report = await runGates({ acceptance, inputsDir: dir });
    assert.equal(report.status, "pass");
    assert.equal(report.failures.length, 0);
    assert.equal(report.warnings.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── verify --stage: phase-scoped gate subsets (stage-fixture harness) ────────

test("isGateInStage — full run includes all; restricted stages scope the gate set", () => {
  // No stage / the explicit `verify` stage = full run.
  assert.equal(isGateInStage(undefined, "playability"), true);
  assert.equal(isGateInStage("verify", "feel"), true);
  // construct = objects + HUD + console only.
  assert.equal(isGateInStage("construct", "manifest"), true);
  assert.equal(isGateInStage("construct", "ui-conformance"), true);
  assert.equal(isGateInStage("construct", "playability"), false);
  assert.equal(isGateInStage("construct", "feel"), false);
  // level = layout/reachability/framing.
  assert.equal(isGateInStage("level", "reachability"), true);
  assert.equal(isGateInStage("level", "placement"), true);
  assert.equal(isGateInStage("level", "feel"), false);
  assert.deepEqual([...VERIFY_STAGES], ["construct", "level", "polish", "verify"]);
});

test("runGates --stage construct: only construct gates count; out-of-stage gates are not_applicable", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, conformantCaptures());
    const report = await runGates({ acceptance, inputsDir: dir, stage: "construct" });

    assert.equal(report.status, "pass");
    // In-stage gates graded.
    assert.equal(report.gates["manifest"], "pass");
    assert.equal(report.gates["ui-conformance"], "pass");
    // Out-of-stage gates are reported but not_applicable (don't affect status).
    assert.equal(report.gates["playability"], "not_applicable");
    assert.equal(report.gates["feel"], "not_applicable");
    assert.equal(report.gates["reachability"], "not_applicable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runGates --stage construct: a FAILING out-of-stage gate does NOT fail the stage (isolation)", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    // Everything conformant EXCEPT playability is broken (not completable).
    await writeCaptures(dir, {
      ...conformantCaptures(),
      "playability.json": { completable: false, completionMethod: "none", winRuleObserved: "none", hazardKills: false, collectibleIncrements: false, postWinInputLocked: false, postWinPlayerFrozen: false, restartWorks: false },
    });

    // Full run fails on playability.
    const full = await runGates({ acceptance, inputsDir: dir });
    assert.equal(full.status, "fail");
    assert.equal(full.gates["playability"], "fail");

    // The SAME captures under --stage construct pass: playability is out of scope.
    const staged = await runGates({ acceptance, inputsDir: dir, stage: "construct" });
    assert.equal(staged.status, "pass", "a broken playability must not fail the construct stage");
    assert.equal(staged.gates["playability"], "not_applicable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runGates --stage construct: a FAILING in-stage gate DOES fail the stage", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    // Break manifest (an in-stage gate for construct).
    await writeCaptures(dir, {
      ...conformantCaptures(),
      "verify-manifest.json": { missing: ["Player"], placeholders: [], extras: [], all_ok: false },
    });
    const staged = await runGates({ acceptance, inputsDir: dir, stage: "construct" });
    assert.equal(staged.status, "fail", "a broken in-stage gate must fail the stage");
    assert.equal(staged.gates["manifest"], "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
