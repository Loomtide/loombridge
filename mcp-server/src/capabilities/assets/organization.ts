import path from "node:path";
import type { AssetProfile, AssetRegistryEntry, UnitySpriteImportPlan } from "./types.js";

function assertAssetsPath(unityPath: string): void {
  if (!unityPath.startsWith("Assets/") || unityPath.includes("..")) {
    throw new Error(`Invalid Unity asset path: ${unityPath}`);
  }
}

export function planUnitySpriteImport(options: {
  entry: AssetRegistryEntry;
  profile: AssetProfile;
  sourcePath: string;
}): UnitySpriteImportPlan {
  const primitive = options.profile.primitives[options.entry.primitive];
  if (!primitive) {
    throw new Error(`Unknown primitive '${options.entry.primitive}' for profile '${options.profile.id}'.`);
  }

  assertAssetsPath(primitive.unityFolder);
  const fileName = path.posix.basename(options.entry.unity.path.replaceAll("\\", "/"));
  const unityPath = path.posix.join(primitive.unityFolder, fileName);
  assertAssetsPath(unityPath);

  const unity = options.entry.unity;
  return {
    tool: "unity_asset_create_sprite",
    source_path: options.sourcePath,
    path: unityPath,
    toolArguments: {
      source_path: options.sourcePath,
      path: unityPath,
      pixels_per_unit: unity.pixelsPerUnit,
      sprite_mode: unity.spriteMode ?? options.profile.unity.defaultSpriteMode,
      filter_mode: unity.filterMode ?? options.profile.unity.defaultFilterMode,
      ...(unity.slicing ? { slicing: unity.slicing } : {}),
      ...(unity.defaultSpriteName ? { default_sprite_name: unity.defaultSpriteName } : {}),
    },
  };
}
