import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkHandoffConsistency } from "../../../../capabilities/assets/handoff-consistency.js";
import { buildPrepareDiagnostics } from "../../../../capabilities/assets/reporting.js";
import type { AssetPrepareReport, PreparedAsset } from "../../../../capabilities/assets/types.js";

function acceptedAsset(id: string, unityPath: string, kind: "sprite" | "audio" = "sprite"): PreparedAsset {
  return {
    id,
    primitive: kind === "audio" ? "sfx_pickup" : "player",
    kind,
    status: "accepted",
    placeholder: false,
    cachePath: `/cache/${path.basename(unityPath)}`,
    unityPath,
    source: {
      title: "Fixture",
      url: "https://example.com/fixture",
      author: "Fixture Author",
      verified: true,
      provenance: { verifiedAt: "2026-05-26", origin: "test", fixture: "fixture" },
    },
    license: {
      name: "Creative Commons CC0 1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    provider: { name: "Fixture", url: "https://example.com", type: "local" },
    file: { role: kind === "audio" ? "audio" : "sprite", format: kind === "audio" ? "wav" : "png", localPath: "fixture" },
    metadata: kind === "audio"
      ? { format: "wav", sampleRate: 44100, channels: 1, bitDepth: 16, durationMs: 250 }
      : { format: "png", width: 32, height: 32 },
    cacheStatus: "hit",
    import: kind === "sprite"
      ? { tool: "unity_asset_create_sprite", toolArguments: { source_path: "/cache/player.png", path: unityPath } }
      : undefined,
    rejections: [],
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrepareReport(tempDir: string): Promise<string> {
  const assets = [
    acceptedAsset("kenney.topdown-shooter.robot.player", "Assets/Art/Sprites/Characters/kenney-robot-courier.png"),
    acceptedAsset("opengameart.fupi.switchyard.sfx.pickup", "Assets/Audio/SFX/switchyard-pickup.wav", "audio"),
  ];
  const report: AssetPrepareReport = {
    schemaVersion: "1",
    status: "pass",
    registry: { packId: "switchyard-2d", path: "asset-layer/registry/switchyard-2d.json" },
    profile: { id: "2d-topdown-arena", path: "asset-layer/profiles/2d-topdown-arena.json" },
    assets,
    diagnostics: buildPrepareDiagnostics(assets),
  };
  const reportPath = path.join(tempDir, "Assets/Handoff/switchyard-asset-prepare-report.json");
  await writeJson(reportPath, report);
  return reportPath;
}

test("handoff consistency passes when verdict ids match accepted prepare report assets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-handoff-pass-"));
  const prepareReportPath = await writePrepareReport(tempDir);
  const verdictPath = path.join(tempDir, "Assets/Handoff/build-verdict.json");
  const handoffPath = path.join(tempDir, "Assets/Handoff/SWITCHYARD_HANDOFF.md");

  await writeJson(verdictPath, {
    registryAssets: {
      used: true,
      skipped: false,
      usedByRole: {
        player: {
          id: "kenney.topdown-shooter.robot.player",
          unityPath: "Assets/Art/Sprites/Characters/kenney-robot-courier.png",
        },
        pickupSfx: {
          id: "opengameart.fupi.switchyard.sfx.pickup",
          unityPath: "Assets/Audio/SFX/switchyard-pickup.wav",
        },
      },
    },
  });
  await fs.writeFile(handoffPath, "Registry assets: used.\n");

  const report = await checkHandoffConsistency({
    prepareReportPath,
    verdictPaths: [verdictPath],
    textPaths: [handoffPath],
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.issues, []);
});

test("handoff consistency fails on stale skipped prose and mismatched audio ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-handoff-fail-"));
  const prepareReportPath = await writePrepareReport(tempDir);
  const verdictPath = path.join(tempDir, "Assets/Handoff/build-verdict.json");
  const handoffPath = path.join(tempDir, "Assets/Handoff/SWITCHYARD_HANDOFF.md");

  await writeJson(verdictPath, {
    registryAssets: {
      used: true,
      skipped: false,
      usedByRole: {
        pickupSfx: {
          id: "freesound.cc0.ui.pickup.bleep",
          unityPath: "Assets/Audio/SFX/switchyard-pickup.wav",
        },
      },
    },
  });
  await fs.writeFile(handoffPath, "Assets: registry assets were skipped because no project-local registry was available.\n");

  const report = await checkHandoffConsistency({
    prepareReportPath,
    verdictPaths: [verdictPath],
    textPaths: [handoffPath],
  });

  assert.equal(report.status, "fail");
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    "MISMATCHED_VERDICT_ASSET_ID",
    "STALE_REGISTRY_SKIPPED_TEXT",
  ]);
  assert.match(report.issues[0]?.message ?? "", /prepare report id is opengameart\.fupi\.switchyard\.sfx\.pickup/);
});

test("handoff consistency fails when accepted assets exist but verdict says registry was skipped", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-handoff-skipped-"));
  const prepareReportPath = await writePrepareReport(tempDir);
  const verdictPath = path.join(tempDir, "Assets/Handoff/final-verdict.json");

  await writeJson(verdictPath, {
    registryAssets: {
      used: false,
      skipped: true,
      usedByRole: {},
    },
  });

  const report = await checkHandoffConsistency({
    prepareReportPath,
    verdictPaths: [verdictPath],
  });

  assert.equal(report.status, "fail");
  assert.deepEqual(report.issues.map((issue) => issue.code), [
    "REGISTRY_USAGE_FALSE",
    "REGISTRY_USAGE_FALSE",
    "REGISTRY_USAGE_MISSING",
  ]);
});
