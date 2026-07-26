import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planUnitySpriteImport } from "../capabilities/assets/organization.js";
import { loadAssetProfile, loadRegistryPack } from "../capabilities/assets/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

test("planUnitySpriteImport routes primitives to deterministic Assets/Art folders", async () => {
  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"));
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const cases = [
    ["kenney.pixel-platformer.player.sheet", "Assets/Art/Sprites/Characters/kenney-pixel-platformer-characters.png"],
    ["kenney.platformer.tile.grass", "Assets/Art/Sprites/Tiles/grass-tile.png"],
    ["kenney.platformer.collectible.coin", "Assets/Art/Sprites/Collectibles/coin-gold.png"],
    ["opengameart.grasslands.background.sky", "Assets/Art/Backgrounds/sky-background.png"],
  ] as const;

  for (const [id, expectedPath] of cases) {
    const entry = registry.entries.find((candidate) => candidate.id === id);
    assert.ok(entry);

    const plan = planUnitySpriteImport({
      entry,
      profile,
      sourcePath: `/cache/${id}.png`,
    });

    assert.equal(plan.path, expectedPath);
    assert.equal(plan.source_path, `/cache/${id}.png`);
    assert.deepEqual(plan.toolArguments, {
      source_path: `/cache/${id}.png`,
      path: expectedPath,
      pixels_per_unit: 100,
      sprite_mode: entry.unity.spriteMode ?? "single",
      filter_mode: entry.unity.filterMode ?? "Bilinear",
      ...(entry.unity.slicing ? { slicing: entry.unity.slicing } : {}),
      ...(entry.unity.defaultSpriteName ? { default_sprite_name: entry.unity.defaultSpriteName } : {}),
    });
  }
});

test("planUnitySpriteImport rejects unknown primitives and invalid folders", async () => {
  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"));
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const entry = { ...registry.entries[0]!, primitive: "boss", unity: { ...registry.entries[0]!.unity, path: "../Bad.png" } };

  assert.throws(
    () => planUnitySpriteImport({ entry, profile, sourcePath: "/cache/boss.png" }),
    /Unknown primitive/,
  );
});
