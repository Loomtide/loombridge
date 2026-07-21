import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildScenarioDryRunResult } from "../scenario/runner.js";
import { validateScenarioDocument } from "../scenario/validator.js";
import { generatePlatformerAssetScenario } from "../asset-layer/platformer-scenario.js";
import type { AssetPrepareReport } from "../asset-layer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function asset(id: string, primitive: string, unityPath: string, defaultSpriteName?: string): AssetPrepareReport["assets"][number] {
  return {
    id,
    primitive,
    kind: "sprite",
    status: "accepted",
    cachePath: `/cache/${id}.png`,
    unityPath,
    source: {
      title: "Fixture",
      url: "https://example.com/source",
      author: "Fixture Author",
      provenance: { verifiedAt: "2026-05-21", origin: "test", fixture: "test" },
    },
    license: {
      name: "Creative Commons CC0 1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    provider: { name: "Fixture", url: "https://example.com" },
    file: { role: "sprite", format: "png", localPath: "fixture.png" },
    metadata: { format: "png", width: 64, height: 64 },
    import: {
      tool: "unity_asset_create_sprite",
      toolArguments: {
        source_path: `/cache/${id}.png`,
        path: unityPath,
        ...(defaultSpriteName ? {
          sprite_mode: "multiple",
          default_sprite_name: defaultSpriteName,
          slicing: {
            mode: "grid",
            cell: { width: 32, height: 32 },
            sprites: [{ name: defaultSpriteName, column: 0, row: 0 }],
          },
        } : {}),
      },
    },
    rejections: [],
  };
}

test("generatePlatformerAssetScenario builds a generic asset-backed scenario and dry-run validates", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-asset-scenario-"));
  const reportPath = path.join(tempDir, "platformer-assets.json");
  const outputPath = path.join(tempDir, "build-platformer-with-assets.json");
  const report: AssetPrepareReport = {
    schemaVersion: "1",
    status: "pass",
    registry: { packId: "platformer-2d", path: "fixture-registry.json" },
    profile: { id: "2d-platformer", path: "fixture-profile.json" },
    assets: [
      asset("player", "player", "Assets/Art/Sprites/Characters/player-blue.png"),
      asset("tile", "tile", "Assets/Art/Sprites/Tiles/grass-tile.png", "tile.grass.center"),
      asset("coin", "collectible", "Assets/Art/Sprites/Collectibles/coin-gold.png"),
      asset("sky", "background", "Assets/Art/Backgrounds/sky-background.png"),
    ],
    diagnostics: { selected: 4, accepted: 4, rejected: 0, rejections: [] },
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const scenario = await generatePlatformerAssetScenario({
    reportPath,
    templatePath: path.join(repoRoot, "demo/scenarios/build-platformer-with-assets.template.json"),
    outputPath,
  });
  const validation = validateScenarioDocument(scenario);
  const dryRun = buildScenarioDryRunResult(scenario);
  const generatedRaw = await fs.readFile(outputPath, "utf-8");

  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(dryRun.status, "pass");
  assert.equal(scenario.name, "build-platformer-with-assets");
  assert.match(generatedRaw, /source_path/);
  assert.match(generatedRaw, /Assets\/Art\/Sprites\/Characters\/player-blue\.png/);
  assert.match(generatedRaw, /unity_asset_create_sprite/);
  assert.match(generatedRaw, /unity_asset_assign_sprite/);
  assert.match(generatedRaw, /tile\.grass\.center/);
  assert.match(generatedRaw, /sprite_name/);
  assert.match(generatedRaw, /m_DrawMode/);
  assert.match(generatedRaw, /"Tiled"/);
  assert.match(generatedRaw, /"m_Size"/);
  assert.match(generatedRaw, /"x": 18\.24/);
  assert.match(generatedRaw, /"y": 0\.64/);
  assert.match(generatedRaw, /"x": 3\.2/);
  assert.match(generatedRaw, /PlatformerCameraController/);
  assert.match(generatedRaw, /assert-camera-followed-right/);
  assert.match(generatedRaw, /"orthographicSize"/);
  assert.match(generatedRaw, /"framingOffset"/);
  assert.match(generatedRaw, /"value": 2\.1/);
  assert.doesNotMatch(generatedRaw, /Assets\/Sprites\/Green\.png|Assets\/Sprites\/Blue\.png|Assets\/Sprites\/Yellow\.png/);
  assert.ok(scenario.steps.every((step) => step.kind !== "tool_call" || !step.tool.includes("platformer")));
});
