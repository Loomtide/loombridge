import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SLICE_ASSET_BINDINGS,
  createDraftAssetManifest,
  type AssetManifest,
  type ManifestGeneratedExport,
  type ManifestRegistrySelection,
} from "../../../../capabilities/assets/asset-manifest.js";
import { resolveAllSliceAssetBindings, resolveAssetBindingsForSlice } from "../../../../capabilities/assets/asset-bindings.js";

const HASH = "d".repeat(64);
const APPROVED_AT = "2026-06-05T00:00:00.000Z";

function registrySelection(assetId: string): ManifestRegistrySelection {
  return {
    registryAssetId: `registry.${assetId}`,
    packId: "platformer-2d",
    primitive: "tile",
    license: {
      name: "Creative Commons Zero v1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    source: {
      title: `Registry ${assetId}`,
      url: "https://example.test/source",
      author: "Fixture",
      provenance: {
        verifiedAt: "2026-06-05",
        origin: "fixture",
        fixture: "asset-bindings",
      },
    },
    provider: {
      name: "Fixture",
      url: "https://example.test/provider",
    },
    placeholder: false,
  };
}

function generatedExport(assetId: string): ManifestGeneratedExport {
  return {
    generatedSetId: "generated_set_needed",
    generator: "fixture-generator",
    sourceImageSha256: HASH,
    producedAt: APPROVED_AT,
    license: "project-generated",
    provenance: {
      origin: "hero-shot-annotation",
      annotationId: `ann-${assetId}`,
      prompt: `Generate ${assetId}`,
      tool: "test-fixture",
    },
  };
}

function approvedManifest(mode: "registry" | "generated" | "hybrid" = "hybrid"): AssetManifest {
  const manifest = createDraftAssetManifest({
    mode,
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
  });
  manifest.status = "approved";
  manifest.approvedAt = APPROVED_AT;
  for (const source of manifest.assetSources) source.approved = true;
  manifest.assets = manifest.assets.map((asset) => ({
    ...asset,
    status: "approved",
    resolvedPaths: [`Assets/Art/${asset.source}/${asset.id}.png`],
    ...(asset.source === "registry" ? { registrySelection: registrySelection(asset.id) } : {}),
    ...(asset.source === "generated" ? { generatedExport: generatedExport(asset.id) } : {}),
  }));
  return manifest;
}

test("default asset manifest names the canonical asset ids for every slice", () => {
  assert.deepEqual(DEFAULT_SLICE_ASSET_BINDINGS, [
    { sliceId: "framing", assetIds: ["player_character", "parallax_background", "foreground_prop"] },
    { sliceId: "ground-tiling", assetIds: ["platform_tiles", "one_way_platform"] },
    { sliceId: "player-feel", assetIds: ["player_character"] },
    { sliceId: "parallax", assetIds: ["parallax_background", "foreground_prop"] },
    { sliceId: "collectibles", assetIds: ["collectible"] },
    { sliceId: "hazards", assetIds: ["hazard"] },
    { sliceId: "hud", assetIds: ["hud_style", "button_style"] },
    { sliceId: "juice", assetIds: ["vfx_particle"] },
    { sliceId: "end-state", assetIds: ["button_style", "hud_style"] },
  ]);
});

test("resolveAssetBindingsForSlice returns manifest paths and provenance for mixed-source slices", () => {
  const manifest = approvedManifest("hybrid");

  const framing = resolveAssetBindingsForSlice(manifest, "framing");

  assert.equal(framing.sliceId, "framing");
  assert.deepEqual(framing.assets.map((asset) => asset.assetId), ["player_character", "parallax_background", "foreground_prop"]);
  assert.equal(framing.assets.find((asset) => asset.assetId === "player_character")?.registrySelection?.registryAssetId, "registry.player_character");
  assert.equal(framing.assets.find((asset) => asset.assetId === "parallax_background")?.generatedExport?.provenance.annotationId, "ann-parallax_background");
  assert.ok(framing.assets.every((asset) => asset.paths[0]?.startsWith("Assets/Art/")));
});

test("resolveAssetBindingsForSlice refuses unknown slice ids and draft manifests", () => {
  const manifest = approvedManifest("generated");
  assert.throws(() => resolveAssetBindingsForSlice(manifest, "missing-slice"), /no slice binding/);

  const draft = createDraftAssetManifest({
    mode: "generated",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
  });
  assert.throws(() => resolveAssetBindingsForSlice(draft, "hud"), /asset manifest is not approved/);
});

test("resolveAllSliceAssetBindings covers every declared slice without registry search", () => {
  const manifest = approvedManifest("generated");

  const all = resolveAllSliceAssetBindings(manifest);

  assert.deepEqual(all.map((binding) => binding.sliceId), DEFAULT_SLICE_ASSET_BINDINGS.map((binding) => binding.sliceId));
  const hud = all.find((binding) => binding.sliceId === "hud");
  assert.deepEqual(hud?.assets.map((asset) => asset.assetId), ["hud_style", "button_style"]);
  assert.ok(hud?.assets.every((asset) => asset.source === "generated"));
  assert.ok(hud?.assets.every((asset) => asset.generatedExport?.provenance.origin === "hero-shot-annotation"));
});
