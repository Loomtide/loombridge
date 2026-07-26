import type {
  AssetFile,
  AssetRegistryEntry,
  AssetValidationIssue,
  CacheStatus,
} from "../types.js";

export interface AssetProviderRequest {
  entry: AssetRegistryEntry;
  file: AssetFile;
  cachePath: string;
  registryRoot: string;
}

export interface AssetProviderResolution {
  status: "resolved" | "rejected";
  cachePath: string;
  cacheStatus: CacheStatus;
  diagnostics: AssetValidationIssue[];
  metadata?: Record<string, unknown>;
}

export interface AssetProviderAdapter {
  readonly name: string;
  canResolve(entry: AssetRegistryEntry, file: AssetFile): boolean;
  resolve(request: AssetProviderRequest): Promise<AssetProviderResolution>;
}
