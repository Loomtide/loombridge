import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAssetProfile, loadRegistryPack } from "../asset-layer/registry.js";
import { validatePreparedSprite } from "../asset-layer/validator.js";
import type { AssetProfile, AssetRegistryEntry } from "../asset-layer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
const tilePath = path.join(repoRoot, "asset-layer/fixtures/platformer/grass-tile.png");

async function loadTile(): Promise<{ profile: AssetProfile; entry: AssetRegistryEntry }> {
  const profile = await loadAssetProfile(profilePath);
  const registry = await loadRegistryPack(registryPath);
  const entry = registry.entries.find((candidate) => candidate.id === "kenney.platformer.tile.grass");
  assert.ok(entry);
  return { profile, entry };
}

test("validatePreparedSprite accepts a profile-compliant sprite", async () => {
  const { profile, entry } = await loadTile();
  const result = await validatePreparedSprite({ entry, profile, sourcePath: tilePath, unityPath: entry.unity.path });

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.metadata, { format: "png", width: 64, height: 64 });
});

test("validatePreparedSprite rejects missing license and source provenance", async () => {
  const { profile, entry } = await loadTile();
  const invalidEntry: AssetRegistryEntry = {
    ...entry,
    license: { ...entry.license, spdx: "", name: "" },
    source: { ...entry.source, url: "", provenance: { ...entry.source.provenance, verifiedAt: "" } },
  };
  const result = await validatePreparedSprite({
    entry: invalidEntry,
    profile,
    sourcePath: tilePath,
    unityPath: invalidEntry.unity.path,
  });
  const codes = result.issues.map((issue) => issue.code);

  assert.equal(result.status, "rejected");
  assert.ok(codes.includes("MISSING_LICENSE"));
  assert.ok(codes.includes("MISSING_SOURCE"));
});

test("validatePreparedSprite rejects unsupported formats, oversized dimensions, and bad Unity paths", async () => {
  const { profile, entry } = await loadTile();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-asset-validator-"));
  const unsupportedPath = path.join(tempDir, "tile.gif");
  await fs.writeFile(unsupportedPath, "not an image");
  const strictProfile: AssetProfile = {
    ...profile,
    validation: {
      ...profile.validation,
      maxDimensions: { width: 16, height: 16 },
    },
  };

  const unsupported = await validatePreparedSprite({
    entry,
    profile,
    sourcePath: unsupportedPath,
    unityPath: "../Bad/tile.gif",
  });
  assert.ok(unsupported.issues.some((issue) => issue.code === "UNSUPPORTED_FORMAT"));
  assert.ok(unsupported.issues.some((issue) => issue.code === "INVALID_UNITY_PATH"));

  const oversized = await validatePreparedSprite({
    entry,
    profile: strictProfile,
    sourcePath: tilePath,
    unityPath: entry.unity.path,
  });
  assert.ok(oversized.issues.some((issue) => issue.code === "DIMENSIONS_TOO_LARGE"));
});
