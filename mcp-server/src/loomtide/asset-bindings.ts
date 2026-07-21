import {
  assertValidAssetManifest,
  type AssetManifest,
  type AssetSourceType,
  type ManifestGeneratedExport,
  type ManifestRegistrySelection,
} from "./asset-manifest.js";

export interface ResolvedSliceAssetBinding {
  assetId: string;
  role: string;
  source: AssetSourceType;
  sourceId?: string;
  paths: string[];
  registrySelection?: ManifestRegistrySelection;
  generatedExport?: ManifestGeneratedExport;
  styleLock?: string;
}

export interface ResolvedSliceAssetBindings {
  sliceId: string;
  assets: ResolvedSliceAssetBinding[];
}

export function resolveAssetBindingsForSlice(manifest: AssetManifest, sliceId: string): ResolvedSliceAssetBindings {
  assertValidAssetManifest(manifest);
  if (manifest.status !== "approved") {
    throw new Error(`Cannot resolve asset bindings for slice '${sliceId}': asset manifest is not approved.`);
  }

  const binding = manifest.sliceBindings.find((candidate) => candidate.sliceId === sliceId);
  if (!binding) {
    throw new Error(`Asset manifest has no slice binding for '${sliceId}'.`);
  }

  return {
    sliceId,
    assets: binding.assetIds.map((assetId) => {
      const asset = manifest.assets.find((candidate) => candidate.id === assetId);
      if (!asset) {
        throw new Error(`Asset manifest slice '${sliceId}' references unknown asset '${assetId}'.`);
      }
      if (!asset.resolvedPaths?.length) {
        throw new Error(`Asset manifest asset '${assetId}' has no resolvedPaths for slice '${sliceId}'.`);
      }
      return {
        assetId: asset.id,
        role: asset.role,
        source: asset.source,
        ...(asset.sourceId ? { sourceId: asset.sourceId } : {}),
        paths: [...asset.resolvedPaths],
        ...(asset.registrySelection ? { registrySelection: asset.registrySelection } : {}),
        ...(asset.generatedExport ? { generatedExport: asset.generatedExport } : {}),
        ...(asset.styleLock ? { styleLock: asset.styleLock } : {}),
      };
    }),
  };
}

export function resolveAllSliceAssetBindings(manifest: AssetManifest): ResolvedSliceAssetBindings[] {
  assertValidAssetManifest(manifest);
  return manifest.sliceBindings.map((binding) => resolveAssetBindingsForSlice(manifest, binding.sliceId));
}
