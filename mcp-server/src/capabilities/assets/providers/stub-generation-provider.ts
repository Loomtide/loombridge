import type { AssetFile, AssetRegistryEntry } from "../types.js";
import type { AssetProviderAdapter, AssetProviderRequest, AssetProviderResolution } from "./types.js";

export class StubGenerationProvider implements AssetProviderAdapter {
  readonly name = "generation";

  canResolve(entry: AssetRegistryEntry, _file: AssetFile): boolean {
    return entry.provider.type === "generation";
  }

  async resolve(request: AssetProviderRequest): Promise<AssetProviderResolution> {
    return {
      status: "rejected",
      cachePath: request.cachePath,
      cacheStatus: "skipped",
      diagnostics: [{
        code: "PROVIDER_NOT_CONFIGURED",
        message: `Generation provider '${request.entry.provider.name}' is not configured. Implement an AssetProviderAdapter to enable this provider.`,
        path: "provider",
      }],
    };
  }
}
