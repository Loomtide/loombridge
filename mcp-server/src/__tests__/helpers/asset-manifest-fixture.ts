import { createDraftAssetManifest, writeAssetManifest, type AssetManifestMode } from "../../capabilities/assets/asset-manifest.js";
import { designStatus } from "../../capabilities/verification/design.js";
import { loombridgePaths } from "../../domain/state.js";

export async function writeApprovedAssetManifestForDesign(
  root: string,
  mode: AssetManifestMode = "hybrid",
): Promise<void> {
  const paths = loombridgePaths(root);
  const design = await designStatus(paths);
  if (design.status !== "approved" || !design.frozenMatches || !design.pngSha256) {
    throw new Error("writeApprovedAssetManifestForDesign requires an approved + frozen Design Target.");
  }
  const pngSha256 = design.pngSha256;

  const manifest = createDraftAssetManifest({
    mode,
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: design.pngSha256 },
  });
  manifest.status = "approved";
  manifest.approvedAt = "2026-06-05T00:00:00.000Z";
  for (const source of manifest.assetSources) source.approved = true;
  manifest.assets = manifest.assets.map((asset, i) => ({
    ...asset,
    status: "approved",
    resolvedPaths: [`Assets/Art/${i}-${asset.id}.png`],
    ...(asset.source === "registry"
      ? {
          registrySelection: {
            registryAssetId: `fixture.${asset.id}`,
            packId: "platformer-2d",
            primitive: "tile",
            license: {
              name: "Creative Commons Zero v1.0 Universal",
              spdx: "CC0-1.0",
              url: "https://creativecommons.org/publicdomain/zero/1.0/",
              requiresAttribution: false,
            },
            source: {
              title: `Fixture ${asset.role}`,
              url: "https://example.test/source",
              author: "Fixture",
              provenance: {
                verifiedAt: "2026-06-05",
                origin: "fixture",
                fixture: "asset-manifest-fixture",
              },
            },
            provider: {
              name: "Fixture",
              url: "https://example.test/provider",
            },
            placeholder: false,
          },
        }
      : {}),
    ...(asset.source === "generated"
      ? {
          generatedExport: {
            generatedSetId: "generated_set_needed",
            generator: "fixture-generator",
            sourceImageSha256: pngSha256,
            producedAt: "2026-06-05T00:00:00.000Z",
            license: "project-generated",
            provenance: {
              origin: "hero-shot-annotation",
              annotationId: `ann-${asset.id}`,
              prompt: `Generate ${asset.role}`,
              tool: "test-fixture",
            },
          },
        }
      : {}),
  }));
  await writeAssetManifest(paths, manifest);
}
