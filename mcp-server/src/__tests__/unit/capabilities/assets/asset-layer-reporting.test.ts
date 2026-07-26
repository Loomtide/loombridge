import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareAssets } from "../../../../capabilities/assets/prepare-cli.js";
import { buildPrepareDiagnostics, renderAttributionMarkdown, writeAttributionMarkdown } from "../../../../capabilities/assets/reporting.js";
import type { AssetPrepareReport, PreparedAsset } from "../../../../capabilities/assets/types.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;
const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");

function prepared(id: string, primitive: string, kind: "sprite", status: "accepted" | "rejected"): PreparedAsset {
  return {
    id,
    primitive,
    kind,
    status,
    cachePath: `/cache/${id}.png`,
    unityPath: `Assets/Art/${id}.png`,
    source: {
      title: "Fixture",
      url: "https://example.com/source",
      author: "Fixture Author",
      verified: true,
      provenance: { verifiedAt: "2026-05-21", origin: "test", fixture: "test" },
    },
    license: {
      name: "Creative Commons CC0 1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    provider: { name: "Kenney", url: "https://www.kenney.nl/", type: "local" },
    file: { role: "sprite", format: "png", localPath: "fixture.png" },
    cacheStatus: status === "accepted" ? "hit" : "miss",
    metadata: { format: "png", width: 64, height: 64 },
    import: {
      tool: "unity_asset_create_sprite",
      toolArguments: { source_path: `/cache/${id}.png`, path: `Assets/Art/${id}.png` },
    },
    rejections: status === "accepted" ? [] : ["CHECKSUM_MISMATCH"],
  };
}

test("buildPrepareDiagnostics returns stable ordering and counts", () => {
  const diagnostics = buildPrepareDiagnostics([
    prepared("z-player", "player", "sprite", "accepted"),
    prepared("a-tile", "tile", "sprite", "rejected"),
  ]);

  assert.deepEqual(diagnostics.cache, { hit: 1, miss: 1, skipped: 0 });
  assert.deepEqual(Object.keys(diagnostics.byPrimitive ?? {}), ["player", "tile"]);
  assert.deepEqual(diagnostics.byKind?.sprite, { selected: 2, accepted: 1, rejected: 1 });
  assert.deepEqual(diagnostics.acceptedImports?.map((item) => item.toolArguments.path), ["Assets/Art/z-player.png"]);
  assert.deepEqual(diagnostics.rejections, [{ id: "a-tile", codes: ["CHECKSUM_MISMATCH"] }]);
});

test("prepareAssets rejects files whose sha256 does not match registry checksum", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-reporting-checksum-"));
  const registry = JSON.parse(await fs.readFile(registryPath, "utf-8")) as {
    entries: Array<{ files: Array<{ localPath?: string; checksum?: { algorithm: "sha256"; value: string } }> }>;
  };
  const sourceLocalPath = "asset-layer/fixtures/platformer/player-blue.png";
  await fs.mkdir(path.join(tempDir, path.dirname(sourceLocalPath)), { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "asset-layer/fixtures/platformer/player-blue.png"),
    path.join(tempDir, sourceLocalPath),
  );
  registry.entries = [registry.entries[0]];
  registry.entries[0].files[0].localPath = sourceLocalPath;
  registry.entries[0].files[0].checksum = {
    algorithm: "sha256",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  };
  const tempRegistryPath = path.join(tempDir, "asset-layer/registry/platformer-2d.json");
  const outputPath = path.join(tempDir, "report.json");
  await fs.mkdir(path.dirname(tempRegistryPath), { recursive: true });
  await fs.writeFile(tempRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const report = await prepareAssets({
    profilePath,
    registryPath: tempRegistryPath,
    cacheDir: path.join(tempDir, "cache"),
    outputPath,
    genre: "platformer-2d",
    primitives: ["player"],
  });

  assert.equal(report.status, "fail");
  assert.deepEqual(report.assets[0]?.rejections, ["CHECKSUM_MISMATCH"]);
  assert.equal(report.assets[0]?.checksum?.algorithm, "sha256");
});

test("writeAttributionMarkdown renders source, provider, license, and attribution fields", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-reporting-attribution-"));
  const reportPath = path.join(tempDir, "report.json");
  const outputPath = path.join(tempDir, "attribution.md");
  const report: AssetPrepareReport = {
    schemaVersion: "1",
    status: "pass",
    registry: { packId: "platformer-2d", path: registryPath },
    profile: { id: "2d-platformer", path: profilePath },
    assets: [prepared("kenney.platformer.tile.grass", "tile", "sprite", "accepted")],
    diagnostics: buildPrepareDiagnostics([]),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const markdown = await writeAttributionMarkdown({ reportPath, outputPath });

  assert.equal(markdown, renderAttributionMarkdown(report));
  assert.match(markdown, /Creative Commons CC0 1\.0 Universal/);
  assert.match(markdown, /Kenney/);
  assert.match(markdown, /Attribution Required/);
  assert.equal(await fs.readFile(outputPath, "utf-8"), markdown);
});
