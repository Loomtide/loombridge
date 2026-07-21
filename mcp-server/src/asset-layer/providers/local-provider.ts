import fs from "node:fs/promises";
import path from "node:path";
import type { AssetFile, AssetRegistryEntry } from "../types.js";
import type { AssetProviderAdapter, AssetProviderRequest, AssetProviderResolution } from "./types.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function safeLocalSourcePath(registryRoot: string, localPath: string): Promise<string | undefined> {
  if (path.isAbsolute(localPath)) {
    return undefined;
  }

  const root = path.resolve(registryRoot);
  const sourcePath = path.resolve(root, localPath);
  if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }

  try {
    const realRoot = await fs.realpath(root);
    const realSource = await fs.realpath(sourcePath);
    return realSource === realRoot || realSource.startsWith(`${realRoot}${path.sep}`) ? sourcePath : undefined;
  } catch {
    return undefined;
  }
}

export class LocalAssetProvider implements AssetProviderAdapter {
  readonly name = "local";

  canResolve(_entry: AssetRegistryEntry, file: AssetFile): boolean {
    return Boolean(file.localPath);
  }

  async resolve(request: AssetProviderRequest): Promise<AssetProviderResolution> {
    if (!request.file.localPath) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "skipped",
        diagnostics: [{
          code: "PROVIDER_SOURCE_MISSING",
          message: "Local asset provider requires file.localPath.",
          path: "files[0].localPath",
        }],
      };
    }

    await fs.mkdir(path.dirname(request.cachePath), { recursive: true });
    if (await fileExists(request.cachePath)) {
      return {
        status: "resolved",
        cachePath: request.cachePath,
        cacheStatus: "hit",
        diagnostics: [],
      };
    }

    const sourcePath = await safeLocalSourcePath(request.registryRoot, request.file.localPath);
    if (!sourcePath) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "skipped",
        diagnostics: [{
          code: "PROVIDER_SOURCE_MISSING",
          message: "Local asset provider requires localPath to stay under the registry root.",
          path: "files[0].localPath",
        }],
      };
    }

    await fs.copyFile(sourcePath, request.cachePath);
    return {
      status: "resolved",
      cachePath: request.cachePath,
      cacheStatus: "miss",
      diagnostics: [],
      metadata: { sourcePath },
    };
  }
}
