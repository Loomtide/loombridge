/**
 * run-gates CLI glue tests — drives the Phase-C evaluators from a directory of
 * captured op-output JSON files using the REAL captured Tiderunner fixtures
 * (the same data the gates test uses: LiberationSans font, cyan score,
 * player centerX 0.102, manifest all_ok). Asserts the assembled
 * build-verdict.json is overall `fail` with the expected per-gate verdicts,
 * plus the missing-input -> WARN degrade and the advisory `--vlm` merge.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contractCoverageRefusals, gradedGates, runGates, isGateInStage, VERIFY_STAGES, type ReviewFindings } from "../../../../capabilities/verification/run-gates.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import { createDraftAssetManifest, type AssetManifest } from "../../../../capabilities/assets/asset-manifest.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";
import { producedPlayabilityEvidence } from "../../../_support/playability-fixture.js";

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

/**
 * The bundled TideRunner contract PLUS the stage-3 win binding.
 *
 * `harness.playability` is deliberately NOT part of the golden seeded contract (a
 * guessed seam is worse than an absent one: the observer's refusal names the exact
 * JSON to add, a wrong component name would fail silently at read time). The
 * fixtures below grade PRODUCED playability evidence, which the gate re-checks
 * against the contract's own win binding, so these tests declare it here.
 */
function withPlayabilityHarness(contract: AcceptanceContract): AcceptanceContract {
  return {
    ...contract,
    harness: {
      ...(contract as { harness?: Record<string, unknown> }).harness,
      playability: {
        playerLocator: "/Player",
        stateLocator: "/GameManager",
        stateComponent: "GameManager",
        fields: { win: "isWin", score: "score", lives: "lives" },
        winRule: "all-collectibles",
        collectibles: { namePattern: "Apple" },
        keys: { moveRight: "D", restart: "R" },
      },
    },
  } as AcceptanceContract;
}

/**
 * The same contract, read synchronously, so the module-level CAPTURES table can
 * mint playability evidence bound to THIS contract's feel targets (the gate
 * re-derives the kinematic bound from the contract and refuses a mismatch).
 */
const ACCEPTANCE_SYNC = withPlayabilityHarness(
  JSON.parse(readFileSync(acceptancePath, "utf-8")) as AcceptanceContract,
);

async function loadAcceptance(): Promise<AcceptanceContract> {
  return withPlayabilityHarness(JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as AcceptanceContract);
}

async function loadSwitchyardAcceptance(): Promise<AcceptanceContract> {
  return JSON.parse(await fs.readFile(switchyardAcceptancePath, "utf-8")) as AcceptanceContract;
}


/**
 * The playability evidence every conformant fixture below uses.
 *
 * Stage 3 caps AGENT-ASSEMBLED playability.json at warn (an eight-line hand-typed
 * file used to produce a full pass: ledger L97/L98), so a fixture that wants a
 * green playability gate now has to carry a recording. This mints the produced
 * shape, and its headline is whatever the derivation reads out of that recording.
 */
function cleanPlayabilityCapture(contract: unknown): Record<string, unknown> {
  return producedPlayabilityEvidence({ contract, contractWinRule: "all-fruit" });
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
    shortHopApex: 1.41,
    dashDistance: 2.8125,
    coyoteTime: 0.1,
    jumpBuffer: 0.1,
    provenance: {
      sources: [
        {
          source: "FeelHarness",
          // L47/E6: the echoed window makes the cadence re-derivable, and the
          // structural count is `fps * window + one fencepost per capture window`
          // (60fps across one 3000ms window is 181 samples).
          sampleCount: 181,
          durationMs: 3000,
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
          sampleCount: 91,
          durationMs: 1500,
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
  "playability.json": cleanPlayabilityCapture(ACCEPTANCE_SYNC),
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

/** An approved REGISTRY-sourced manifest, so the registry provenance branch has something to bind. */
function approvedRegistryManifest(): AssetManifest {
  const heroHash = "f".repeat(64);
  const manifest = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: heroHash },
  });
  manifest.status = "approved";
  manifest.approvedAt = "2026-06-05T00:00:00.000Z";
  manifest.assetSources = manifest.assetSources.map((source) => ({ ...source, approved: true }));
  manifest.assets = manifest.assets.map((asset) => ({
    ...asset,
    source: "registry" as const,
    status: "approved" as const,
    resolvedPaths: [`Assets/Art/Registry/${asset.id}.png`],
    registrySelection: {
      registryAssetId: `reg-${asset.id}-APPROVED`,
      packId: "pack-1",
      primitive: "sprite",
      license: { name: "CC0", spdx: "CC0-1.0", url: "https://example.invalid/cc0", requiresAttribution: false },
      source: { title: "Pack One", url: "https://example.invalid/pack-1", author: "example", provenance: {} },
      provider: { name: "example", url: "https://example.invalid" },
      placeholder: false,
    },
  }));
  return manifest;
}

/*
 * D: OMITTING THE BOUND FIELD CERTIFIED WHERE DECLARING IT REFUSED.
 *
 * `asset-source-fidelity.ts` carried the literal house anti-pattern:
 *
 *   if (observed?.registryAssetId && asset.registrySelection?.registryAssetId !== observed.registryAssetId)
 *
 * A FALSY `registryAssetId` on the observed record skipped the binding entirely, and nothing
 * else covers it: `asset-source.observed.<id>` compares only `source` and `paths`. The same
 * shape sat on the `generatedSetId` branch.
 *
 * The audit filed this as PLAUSIBLE (reasoned, not demonstrated). DEMONSTRATED, on the real
 * `runGates` path, one registry-bound manifest and three observation records:
 *
 *   [D honest]              {"gate":"pass","failures":[]}
 *   [D declared drift]      {"gate":"fail","failures":["asset-source.registry-drift.player_character"]}
 *   [D OMITTED field]       {"gate":"pass","failures":[]}
 *   [D no observation]      {"gate":"pass","failures":[]}
 *
 * Row 3 is the finding: the SAME observation, one field deleted, flips a failing gate green.
 *
 * DELIBERATELY NOT CHANGED: row 4, "no observation for this asset at all". `verify` stages the
 * BARE `.loombridge/ASSET_MANIFEST.json` into the inputs dir itself, and that copy carries no
 * observations by construction, so failing it would manufacture a tier-1 game defect out of a
 * harness gap on every ordinary project (there is an explicit guard above asserting a valid
 * staged declaration must NOT fail this gate). That path is already handled honestly by the
 * staged-document marker, which keeps it out of `gradedGates`.
 *
 * LITMUS, run 2026-08-13. Both drift blocks reverted to `if (observed?.registryAssetId && …)` /
 * `if (observed?.generatedSetId && …)`, rebuilt, re-run:
 *
 *   ✖ MOAT (D): an observation that OMITS the bound registry/generated id must refuse, not skip (5.43575ms)
 *     AssertionError [ERR_ASSERTION]: omitting registryAssetId must not be cheaper than declaring a wrong one
 *
 *     'pass' !== 'fail'
 *
 *   ℹ pass 23
 *   ℹ fail 1
 *
 * Restored: 24 pass, 0 fail.
 */
test("MOAT (D): an observation that OMITS the bound registry/generated id must refuse, not skip", async () => {
  const acceptance = await loadAcceptance();
  const manifest = approvedRegistryManifest();
  const honest = manifest.assets.map((asset) => ({
    assetId: asset.id,
    source: asset.source,
    paths: asset.resolvedPaths ?? [],
    registryAssetId: asset.registrySelection!.registryAssetId,
  }));

  const gradeWith = async (observedAssets: unknown[]): Promise<{ gate: string; failures: string[] }> => {
    const dir = await mkTmpDir();
    try {
      await writeCaptures(dir, { "asset-manifest.json": { manifest, observedAssets } });
      const report = await runGates({
        acceptance,
        inputsDir: dir,
        selectGates: new Set(["asset-source-fidelity"]),
      });
      return {
        gate: String(report.gates["asset-source-fidelity"]),
        failures: report.failures.map((f) => f.id),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  // CONTROL: an honest observation passes, so the failures below are the check firing rather
  // than the fixture being broken.
  assert.deepEqual(await gradeWith(honest), { gate: "pass", failures: [] });

  // DECLARED DRIFT, refused today, and the baseline the omission is measured against.
  const drifted = honest.map((o, i) => (i === 0 ? { ...o, registryAssetId: "reg-SOMETHING-ELSE" } : o));
  const driftReport = await gradeWith(drifted);
  assert.equal(driftReport.gate, "fail");
  assert.ok(driftReport.failures.some((id) => id.startsWith("asset-source.registry-drift.")));

  // THE ATTACK: the SAME record with the bound field deleted.
  const omitted = honest.map((o, i) => {
    if (i !== 0) return o;
    const { registryAssetId: _dropped, ...rest } = o;
    return rest;
  });
  const omittedReport = await gradeWith(omitted);
  assert.equal(
    omittedReport.gate,
    "fail",
    "omitting registryAssetId must not be cheaper than declaring a wrong one",
  );
  assert.ok(
    omittedReport.failures.some((id) => id === `asset-source.registry-drift.${manifest.assets[0]!.id}`),
    `the refusal must name the asset: ${omittedReport.failures.join(", ")}`,
  );

  // THE SAME RULE ON THE GENERATED BRANCH.
  const generated = approvedGeneratedManifest();
  const generatedObserved = generated.assets.map((asset) => ({
    assetId: asset.id,
    source: asset.source,
    paths: asset.resolvedPaths ?? [],
    generatedSetId: asset.generatedExport!.generatedSetId,
  }));
  const gradeGenerated = async (observedAssets: unknown[]): Promise<string> => {
    const dir = await mkTmpDir();
    try {
      await writeCaptures(dir, { "asset-manifest.json": { manifest: generated, observedAssets } });
      const report = await runGates({
        acceptance,
        inputsDir: dir,
        selectGates: new Set(["asset-source-fidelity"]),
      });
      return String(report.gates["asset-source-fidelity"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  assert.equal(await gradeGenerated(generatedObserved), "pass", "the honest generated observation passes");
  assert.equal(
    await gradeGenerated(
      generatedObserved.map((o, i) => {
        if (i !== 0) return o;
        const { generatedSetId: _dropped, ...rest } = o;
        return rest;
      }),
    ),
    "fail",
    "omitting generatedSetId must not be cheaper than declaring a wrong one",
  );
});

test("D false-failure check: a BARE staged manifest with no observations at all still passes the gate", async () => {
  // The scoping that keeps this fix from turning every ordinary project red. `verify` copies
  // `.loombridge/ASSET_MANIFEST.json` into the inputs dir itself; that document carries no
  // `observedAssets`, so if "no observation" became a failure, a project with nothing wrong
  // with it would report a tier-1 game defect (exit 1, STATE verified-failing) on every run.
  // Harness fault is never a game defect. The staged-document marker already keeps that copy
  // out of `gradedGates`, which is the honest answer to "did this run measure the game".
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, { "asset-manifest.json": approvedRegistryManifest() });
    const report = await runGates({ acceptance, inputsDir: dir, selectGates: new Set(["asset-source-fidelity"]) });
    assert.notEqual(
      report.gates["asset-source-fidelity"],
      "fail",
      "a valid staged declaration must not fail: that would manufacture a game defect from a harness gap",
    );
    assert.deepEqual(gradedGates(report), [], "and it still is not evidence that this run measured the game");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/*
 * D2: D CONVERTED "DELETE A FIELD" INTO "DELETE A LIST ENTRY".
 *
 * D made the drift row unconditional on the observation EXISTING, so an observation that omits
 * the bound id refuses. It left the row conditional on the observation existing AT ALL, and
 * deleting the whole entry is cheaper than blanking a field inside it. Worse, `run-gates.ts`
 * decides capture-versus-staged-document purely on the presence of a `manifest` key, so a
 * WRAPPED capture carrying an EMPTY observation list counted as GRADED evidence that the run
 * measured the game.
 *
 * BEFORE, one registry-bound manifest, four inputs, real `runGates`:
 *
 *   [honest]                   pass, graded ["asset-source-fidelity"]
 *   [wrong id]                 fail
 *   [omitted field (D's fix)]  fail
 *   [ATTACK: drop that ENTRY]  pass, graded ["asset-source-fidelity"]
 *   [ATTACK: observedAssets=[] ] pass, graded ["asset-source-fidelity"]
 *
 * THE FIX IS PR #88's DENOMINATOR RULE: the expected observations are RECOMPUTABLE as
 * `manifest.assets`, by the same code path that reads them, so a capture that observed fewer
 * assets than the manifest declares has a shrunken denominator rather than a smaller obligation.
 * The reverse walk comes with it: an observation for an asset the manifest does not declare is
 * an observation of something nobody approved.
 *
 * The staged-document carve-out stays, NARROWED to what its own argument covers: a BARE
 * `.loombridge/ASSET_MANIFEST.json` (which `verify` stages itself and which carries no
 * observations by construction) is a declaration, not a capture, and failing it would
 * manufacture a tier-1 game defect out of a harness gap. A WRAPPED input is a capture and is
 * held to the manifest's own denominator, which is the difference `assetSourceIsCapture` was
 * already drawing everywhere except here.
 *
 * LITMUS, run 2026-08-13. The `asset-source.observed.<id>` no-observation branch reverted to
 * `status: "pass"` and the undeclared-observation walk removed, rebuilt, re-run:
 *
 *   ✖ MOAT (D2): a capture that observed FEWER assets than the manifest declares is a shrunken denominator (7.478958ms)
 *     AssertionError [ERR_ASSERTION]: dropping the observation ENTRY must not be cheaper than blanking a field in it
 *
 *     'pass' !== 'fail'
 *
 *   ℹ pass 25
 *   ℹ fail 1
 *
 * Restored: 26 pass, 0 fail.
 */
test("MOAT (D2): a capture that observed FEWER assets than the manifest declares is a shrunken denominator", async () => {
  const acceptance = await loadAcceptance();
  const manifest = approvedRegistryManifest();
  const honest = manifest.assets.map((asset) => ({
    assetId: asset.id,
    source: asset.source,
    paths: asset.resolvedPaths ?? [],
    registryAssetId: asset.registrySelection!.registryAssetId,
  }));
  assert.ok(honest.length >= 2, "the fixture needs more than one asset for 'drop one entry' to be meaningful");

  const gradeWith = async (observedAssets: unknown[]): Promise<{ gate: string; failures: string[]; graded: string[] }> => {
    const dir = await mkTmpDir();
    try {
      await writeCaptures(dir, { "asset-manifest.json": { manifest, observedAssets } });
      const report = await runGates({
        acceptance,
        inputsDir: dir,
        selectGates: new Set(["asset-source-fidelity"]),
      });
      return {
        gate: String(report.gates["asset-source-fidelity"]),
        failures: report.failures.map((f) => f.id),
        graded: gradedGates(report),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  // CONTROL: the full observation set passes and IS graded evidence.
  const control = await gradeWith(honest);
  assert.deepEqual({ gate: control.gate, failures: control.failures }, { gate: "pass", failures: [] });
  assert.deepEqual(control.graded, ["asset-source-fidelity"]);

  // ATTACK 1: drop ONE entry. Every remaining observation is honest.
  const dropped = honest.slice(1);
  const droppedReport = await gradeWith(dropped);
  assert.equal(
    droppedReport.gate,
    "fail",
    "dropping the observation ENTRY must not be cheaper than blanking a field in it",
  );
  assert.ok(
    droppedReport.failures.some((id) => id === `asset-source.observed.${manifest.assets[0]!.id}`),
    `the refusal must name the unobserved asset: ${droppedReport.failures.join(", ")}`,
  );

  // ATTACK 2: drop them ALL, which is the same attack taken to its end and the one that also
  // counted as GRADED.
  const emptied = await gradeWith([]);
  assert.equal(emptied.gate, "fail", "an empty observation list is a shrunken denominator, not a clean run");
  assert.equal(
    emptied.failures.length,
    manifest.assets.length,
    `every declared asset owes an observation: ${emptied.failures.join(", ")}`,
  );

  // AND THE REVERSE WALK: an observation for an asset the approved manifest does not declare.
  const undeclared = await gradeWith([...honest, { assetId: "not-in-the-manifest", source: "registry", paths: [] }]);
  assert.equal(undeclared.gate, "fail", "an observation of something nobody approved is not evidence of fidelity");
  assert.ok(
    undeclared.failures.some((id) => id === "asset-source.observed-undeclared.not-in-the-manifest"),
    `the refusal must name it: ${undeclared.failures.join(", ")}`,
  );
});

test("D2 false-failure check: the BARE staged declaration is still exempt, and a gray-box primitive-final role owes no observation", async () => {
  // The two shapes that MUST stay green, because the denominator rule is exactly the kind of
  // tightening that turns an ordinary project red and then gets relaxed back into a hole.
  //
  //  1. the BARE `.loombridge/ASSET_MANIFEST.json` `verify` stages itself. It carries no
  //     observations BY CONSTRUCTION, so holding it to the manifest's denominator would report a
  //     tier-1 game defect on every ordinary project. Harness fault is never a game defect.
  //  2. a `primitiveFinal` role under `art.mode:"deferred"`: the engine primitive IS the
  //     deliverable, there is no imported asset to observe, and the gate says so already.
  const acceptance = await loadAcceptance();
  const bare = await mkTmpDir();
  try {
    await writeCaptures(bare, { "asset-manifest.json": approvedRegistryManifest() });
    const report = await runGates({ acceptance, inputsDir: bare, selectGates: new Set(["asset-source-fidelity"]) });
    assert.notEqual(report.gates["asset-source-fidelity"], "fail", "a bare staged declaration must not fail");
    assert.deepEqual(gradedGates(report), [], "and it is still not evidence that this run measured the game");
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }

  const grayboxManifest = approvedRegistryManifest();
  grayboxManifest.assets = grayboxManifest.assets.map((asset) => ({
    ...asset,
    primitiveFinal: true,
    resolvedPaths: [],
    registrySelection: undefined,
  }));
  const graybox = await mkTmpDir();
  try {
    await writeCaptures(graybox, { "asset-manifest.json": { manifest: grayboxManifest, observedAssets: [] } });
    const report = await runGates({
      acceptance: { ...acceptance, art: { mode: "deferred" } },
      inputsDir: graybox,
      selectGates: new Set(["asset-source-fidelity"]),
    });
    assert.notEqual(
      report.gates["asset-source-fidelity"],
      "fail",
      "a gray-box role whose deliverable is the engine primitive owes no observation",
    );
  } finally {
    await fs.rm(graybox, { recursive: true, force: true });
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
      "playability.json": cleanPlayabilityCapture(ACCEPTANCE_SYNC),
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
      "playability.json": cleanPlayabilityCapture(ACCEPTANCE_SYNC),
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
    "playability.json": cleanPlayabilityCapture(ACCEPTANCE_SYNC),
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
      "playability.json": cleanPlayabilityCapture(ACCEPTANCE_SYNC),
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

// ── gradedGates: did this run actually CHECK anything? ───────────────────────

test("gradedGates: only gates whose evaluator consumed a real capture count as graded", async () => {
  const acceptance = await loadAcceptance();

  // Empty inputs: every gate degrades to a capture-missing WARN, so NOTHING graded.
  const empty = await mkTmpDir();
  try {
    const report = await runGates({ acceptance, inputsDir: empty });
    assert.ok(Object.keys(report.gates).length > 0, "the report still lists every gate");
    assert.equal(report.status, "warn", "a warn status alone cannot answer 'did anything grade?'");
    assert.deepEqual(gradedGates(report), [], "a warn-because-missing gate is not a graded gate");
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }

  // One real capture: exactly the gates that read it grade, and nothing else does.
  const one = await mkTmpDir();
  try {
    await writeCaptures(one, { "console.json": conformantCaptures()["console.json"] });
    const report = await runGates({ acceptance, inputsDir: one });
    assert.deepEqual(gradedGates(report), ["console-clean"]);
  } finally {
    await fs.rm(one, { recursive: true, force: true });
  }

  // A full conformant pack grades many gates (the partial/full boundary is real).
  const full = await mkTmpDir();
  try {
    await writeCaptures(full, conformantCaptures());
    const graded = gradedGates(await runGates({ acceptance, inputsDir: full }));
    assert.ok(graded.length > 1, `expected several graded gates, got ${JSON.stringify(graded)}`);
    assert.ok(graded.includes("console-clean") && graded.includes("manifest"), JSON.stringify(graded));
  } finally {
    await fs.rm(full, { recursive: true, force: true });
  }
});

test("gradedGates: the SFX arm grades NOTHING when the cue map was never staged", async () => {
  // FX2. The SFX gates are opt-in, and when they are ON, an empty inputs dir blocks them
  // via a DIFFERENT marker id than every other gate (`<gate>.cue-map`, not `<gate>.input`):
  // they cannot know which cues are required, so they never even reach their capture.
  // Without that id in the capture-absent list, four blocked gates would count as graded,
  // the nothing-graded refusal would not fire, and an SFX-enabled project with zero
  // captures would flip STATE to a quotable `verified-warn`.
  const acceptance = await loadAcceptance();
  const withSfx: AcceptanceContract = {
    ...acceptance,
    verification: {
      ...(acceptance.verification ?? {}),
      sfx: { enabled: true, inputToSfxLatencyMs: { target: 60, unit: "ms", band: { abs: 20 } } },
    },
  };
  const empty = await mkTmpDir();
  try {
    const report = await runGates({ acceptance: withSfx, inputsDir: empty });

    // Non-vacuity: the SFX gates really are in this report and really are blocked.
    const sfxGates = Object.keys(report.gates).filter((g) => g.toLowerCase().includes("sfx"));
    assert.ok(sfxGates.length >= 4, `the SFX arm did not run at all: ${JSON.stringify(Object.keys(report.gates))}`);
    assert.ok(
      report.checks.some((c) => c.id.endsWith(".cue-map") && c.actual === "(missing)"),
      "the blocked-cue-map marker is what this test is guarding; it is absent",
    );

    assert.deepEqual(
      gradedGates(report),
      [],
      "an SFX gate blocked on a missing cue map never consumed a capture; it is not graded evidence",
    );
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("gradedGates: the BARE staged asset manifest is not graded evidence; the WRAPPED capture is", async () => {
  // FX12/H2. `verify` copies `.loombridge/ASSET_MANIFEST.json` into the inputs dir itself.
  // That copy is the project's DECLARATION, with no `observedAssets` and therefore no
  // observation of the build at all. A capture run writes the wrapped
  // `{ manifest, observedAssets }` shape instead. Only the latter is evidence that this
  // run measured the game.
  const acceptance = await loadAcceptance();
  const manifest = approvedGeneratedManifest();

  const bare = await mkTmpDir();
  try {
    await writeCaptures(bare, { "asset-manifest.json": manifest as unknown as Record<string, unknown> });
    const report = await runGates({ acceptance, inputsDir: bare });

    // The gate still RAN and still has a verdict: a self-contradicting declaration is
    // still a defect. What it must not be is the evidence that carried the run.
    assert.ok(report.gates["asset-source-fidelity"] !== undefined, "the gate must still run");
    assert.ok(
      report.checks.some((c) => c.id === "asset-source-fidelity.staged-document"),
      "the staged-document marker is missing; nothing distinguishes a declaration from a capture",
    );
    assert.deepEqual(gradedGates(report), [], "a staged project document is not a graded gate");
    // S1 final-test HIGH-1: a VALID bare staged manifest must not FAIL the gate. The
    // artDeferred flag is injected at the wrapper level, never into the manifest document,
    // so schema validation sees the same clean manifest either way. A fail here would be a
    // harness artifact reported as a tier-1 game defect (exit 1, verified-failing STATE)
    // on a project with nothing wrong with it.
    assert.notEqual(
      report.gates["asset-source-fidelity"],
      "fail",
      "a valid staged declaration failed the gate: the harness manufactured a game defect",
    );
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }

  const wrapped = await mkTmpDir();
  try {
    await writeCaptures(wrapped, {
      "asset-manifest.json": {
        manifest,
        observedAssets: manifest.assets.map((a) => ({
          assetId: a.id,
          source: a.source,
          paths: a.resolvedPaths ?? [],
          generatedSetId: a.sourceId,
        })),
      },
    });
    const report = await runGates({ acceptance, inputsDir: wrapped });
    assert.ok(
      !report.checks.some((c) => c.id === "asset-source-fidelity.staged-document"),
      "a wrapped capture must NOT be marked as a staged document",
    );
    assert.deepEqual(
      gradedGates(report),
      ["asset-source-fidelity"],
      "a captured observation of what the build used IS graded evidence",
    );
  } finally {
    await fs.rm(wrapped, { recursive: true, force: true });
  }
});

test("gradedGates: a not_applicable gate never counts, however it became not_applicable", async () => {
  const acceptance = await loadAcceptance();
  const dir = await mkTmpDir();
  try {
    await writeCaptures(dir, conformantCaptures());
    // Out of stage: the excluded gates report not_applicable, so they drop out of the
    // graded set even though their capture files are sitting right there.
    const staged = await runGates({ acceptance, inputsDir: dir, stage: "construct" });
    const graded = gradedGates(staged);
    assert.ok(graded.length > 0, "the in-stage gates still grade");
    for (const gate of graded) {
      assert.notEqual(staged.gates[gate], "not_applicable", `${gate} must not be counted`);
    }
    // Slice selection is the other route to not_applicable, and behaves identically.
    const sliced = await runGates({ acceptance, inputsDir: dir, selectGates: new Set(["console-clean"]) });
    assert.deepEqual(gradedGates(sliced), ["console-clean"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- Section waivers: the human exit, and only the human exit ---------------------------------
//
// A genre can be structurally uncertifiable: the 3d-shooter seed's validator REQUIRES `win.rule`
// while the only gate covering `win` is `playability`, a 2D observer a 3D build cannot satisfy.
// The waiver is the recorded human decision that a section is knowingly ungraded.

/** A contract that REQUIRES the reachability section, with no gate in the plan walking it. */
function uncoveredContract(verification?: unknown): unknown {
  return {
    schemaVersion: "1", game: "X", genre: "g",
    reachability: { jumps: [{ id: "a", gapM: 3 }] },
    ...(verification ? { verification } : {}),
  };
}

test("an uncovered required section refuses", () => {
  assert.equal(contractCoverageRefusals({ acceptance: uncoveredContract(), gates: [] }).length, 1);
});

test("an explicit, attributed waiver clears the refusal", () => {
  const waived = uncoveredContract({
    sectionWaivers: { reachability: { reason: "3D genre; the reachability grader is 2D-only", approvedBy: "avinash" } },
  });
  assert.deepEqual(contractCoverageRefusals({ acceptance: waived, gates: [] }), []);
});

test("LITMUS: the MACHINE-written gate-applicability field cannot waive anything", () => {
  // The bypass this design exists to prevent. `promote.ts` writes `verification.gates` itself
  // (`verificationOverrides` marks six gates `not_applicable`), and four required sections are
  // covered ONLY by those six. Keying consent off that field lets a promoted contract grant
  // itself consent: measured 1 refusal before, 0 after.
  const machineWritten = uncoveredContract({ gates: { reachability: "not_applicable" } });
  assert.equal(
    contractCoverageRefusals({ acceptance: machineWritten, gates: [] }).length,
    1,
    "gate applicability is machine-written and must never read as human consent",
  );
});

test("LITMUS: an unattributable or unexplained waiver does not count", () => {
  // Without this, `{}` or a blank string silences the refusal and the waiver carries no more
  // information than the machine-written field it replaced.
  for (const bad of [
    {},
    { reason: "x" },
    { approvedBy: "y" },
    { reason: "", approvedBy: "y" },
    { reason: "x", approvedBy: "   " },
    "just a string",
  ]) {
    assert.equal(
      contractCoverageRefusals({ acceptance: uncoveredContract({ sectionWaivers: { reachability: bad } }), gates: [] }).length,
      1,
      `a waiver of ${JSON.stringify(bad)} must not silence the refusal`,
    );
  }
});

test("a waiver is per SECTION: it does not silence a different uncovered section", () => {
  const two = {
    schemaVersion: "1", game: "X", genre: "g",
    reachability: { jumps: [{ id: "a", gapM: 3 }] },
    placement: { groundedItems: [{ id: "crate" }] },
    verification: { sectionWaivers: { reachability: { reason: "r", approvedBy: "a" } } },
  };
  const refusals = contractCoverageRefusals({ acceptance: two, gates: [] });
  assert.equal(refusals.length >= 1, true, "the un-waived section must still refuse");
  assert.equal(refusals.some((r) => r.includes("reachability")), false, "the waived one must not");
});
