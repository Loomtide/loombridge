#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { planUnitySpriteImport } from "./organization.js";
import { HttpAssetProvider } from "./providers/http-provider.js";
import { LocalAssetProvider } from "./providers/local-provider.js";
import { StubGenerationProvider } from "./providers/stub-generation-provider.js";
import type { AssetProviderAdapter, AssetProviderResolution } from "./providers/types.js";
import {
  ApiCatalogSource,
  HttpCatalogSource,
  LocalCatalogSource,
  selectAssetsFromCatalog,
} from "./catalog-source.js";
import { assetKindOf, loadAssetProfile, loadRegistryPack, selectAssets, validateRegistryPolicy } from "./registry.js";
import { buildPrepareDiagnostics, computeSha256 } from "./reporting.js";
import { validatePreparedAudio, validatePreparedNonImage, validatePreparedSprite } from "./validator.js";
import type {
  AssetFile,
  AssetPrepareReport,
  AssetProfile,
  AssetRegistryEntry,
  AssetRegistryPack,
  AssetValidationIssue,
  CacheStatus,
  PrepareAssetsOptions,
  PreparedAsset,
} from "./types.js";

interface CliArgs extends PrepareAssetsOptions {
  help: boolean;
}

function printUsage(): void {
  console.log(
    "Usage: node dist/asset-layer/prepare-cli.js --profile <path-or-id> (--registry <path> | --catalog <path-or-url> | --catalog-api <baseUrl>) --output <path> --cache <dir> [--validate-only] [--genre <genre>] [--primitive <name>] [--tags <csv>] [--preferred-license <spdx>]",
  );
}

function resolveProfilePath(value: string): string {
  if (value.endsWith(".json") || value.includes("/") || value.includes("\\")) {
    return path.resolve(process.cwd(), value);
  }

  return path.resolve(process.cwd(), `../asset-layer/profiles/${value}.json`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    profilePath: "",
    outputPath: "../demo/.artifacts/platformer-assets.json",
    cacheDir: "../demo/.artifacts/asset-cache",
    primitives: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--profile":
        args.profilePath = resolveProfilePath(argv[++i] ?? "");
        break;
      case "--registry":
        args.registryPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--catalog": {
        const value = argv[++i] ?? "";
        args.catalogPath = /^https?:\/\//.test(value) ? value : path.resolve(process.cwd(), value);
        break;
      }
      case "--catalog-api":
        args.catalogApiUrl = argv[++i] ?? "";
        break;
      case "--output":
        args.outputPath = path.resolve(process.cwd(), argv[++i] ?? args.outputPath);
        break;
      case "--cache":
        args.cacheDir = path.resolve(process.cwd(), argv[++i] ?? args.cacheDir);
        break;
      case "--genre":
        args.genre = argv[++i] ?? "";
        break;
      case "--primitive":
        args.primitives?.push(argv[++i] ?? "");
        break;
      case "--tags":
        args.tags = (argv[++i] ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
        break;
      case "--preferred-license":
        args.preferredLicense = argv[++i] ?? "";
        break;
      case "--validate-only":
        args.validateOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.help && (!args.profilePath || (!args.registryPath && !args.catalogPath && !args.catalogApiUrl))) {
    throw new Error("Missing required --profile plus --registry/--catalog/--catalog-api arguments.");
  }

  args.outputPath = path.resolve(process.cwd(), args.outputPath);
  args.cacheDir = path.resolve(process.cwd(), args.cacheDir);
  return args;
}

function repoRootFromRegistry(registryPath: string): string {
  return path.resolve(path.dirname(registryPath), "../..");
}

function repoRootFromCatalog(catalogPath: string | undefined): string {
  if (!catalogPath || /^https?:\/\//.test(catalogPath)) {
    return process.cwd();
  }
  // Records pin `localPath` relative to the repo root (e.g. `asset-layer/...`).
  // Catalog shards can live at varying depths under `asset-layer/` (a flat
  // fixture at `asset-layer/catalog-fixtures/foo.json`, or a sharded public seed
  // at `asset-layer/catalog-public/<profile>/part-00000.jsonl`), so a fixed
  // `../..` undershoots the deeper layout. Anchor on the `asset-layer/` ancestor
  // and treat its parent as the repo root; fall back to the old heuristic when no
  // such ancestor exists.
  const resolved = path.resolve(catalogPath);
  const segments = resolved.split(path.sep);
  const anchor = segments.lastIndexOf("asset-layer");
  if (anchor > 0) {
    return segments.slice(0, anchor).join(path.sep) || path.sep;
  }
  return path.resolve(path.dirname(catalogPath), "../..");
}

function sourceLabel(value: string): string {
  if (/^https?:\/\//.test(value)) {
    return value.replace(/^https?:\/\//, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  }
  return path.basename(value, path.extname(value)) || "asset-catalog";
}

async function loadRegistryForPrepare(
  options: PrepareAssetsOptions,
  profile: AssetProfile,
): Promise<{ registry: AssetRegistryPack; sourcePath: string; registryRoot: string }> {
  const sourceCount = [options.registryPath, options.catalogPath, options.catalogApiUrl]
    .filter((value) => Boolean(value)).length;
  if (sourceCount > 1) {
    throw new Error("Use exactly one of --registry, --catalog, or --catalog-api.");
  }

  if (options.registryPath) {
    const registryPath = path.resolve(options.registryPath);
    return {
      registry: await loadRegistryPack(registryPath),
      sourcePath: registryPath,
      registryRoot: repoRootFromRegistry(registryPath),
    };
  }

  if (options.catalogApiUrl) {
    const source = new ApiCatalogSource(options.catalogApiUrl, options.catalogFetch);
    const entries = await selectAssetsFromCatalog(source, {
      genre: options.genre ?? profile.genre,
      primitives: options.primitives,
      tags: options.tags,
      preferredLicense: options.preferredLicense,
    });
    return {
      registry: {
        schemaVersion: "1",
        packId: sourceLabel(options.catalogApiUrl),
        name: `Asset Catalog: ${sourceLabel(options.catalogApiUrl)}`,
        description: `Adapted from hosted asset catalog search API ${options.catalogApiUrl}.`,
        entries,
      },
      sourcePath: options.catalogApiUrl,
      // Records from the API carry public URLs (no localPath); anchor on cwd like the http path.
      registryRoot: process.cwd(),
    };
  }

  if (!options.catalogPath) {
    throw new Error("Missing required --registry, --catalog, or --catalog-api.");
  }

  const source = /^https?:\/\//.test(options.catalogPath)
    ? new HttpCatalogSource(options.catalogPath)
    : new LocalCatalogSource(options.catalogPath);
  const entries = await selectAssetsFromCatalog(source, {
    genre: options.genre ?? profile.genre,
    primitives: options.primitives,
    tags: options.tags,
    preferredLicense: options.preferredLicense,
  });
  return {
    registry: {
      schemaVersion: "1",
      packId: sourceLabel(options.catalogPath),
      name: `Asset Catalog: ${sourceLabel(options.catalogPath)}`,
      description: `Adapted from hosted asset catalog source ${options.catalogPath}.`,
      entries,
    },
    sourcePath: options.catalogPath,
    registryRoot: repoRootFromCatalog(options.catalogPath),
  };
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function sourceReference(file: AssetFile): string {
  return file.url ?? file.localPath ?? "unknown";
}

function deterministicCachePath(cacheDir: string, entry: AssetRegistryEntry, file: AssetFile): string {
  const hash = crypto.createHash("sha256").update(`${entry.id}:${sourceReference(file)}`).digest("hex").slice(0, 12);
  return path.join(cacheDir, `${safeName(entry.id)}-${safeName(file.role)}-${hash}.${file.format}`);
}

function firstFile(entry: AssetRegistryEntry): AssetFile {
  const file = entry.files[0];
  if (!file) {
    throw new Error(`Asset entry ${entry.id} does not declare files.`);
  }

  return file;
}

function defaultProviders(): AssetProviderAdapter[] {
  return [
    new StubGenerationProvider(),
    new LocalAssetProvider(),
    new HttpAssetProvider(),
  ];
}

async function resolveWithProviders(
  entry: AssetRegistryEntry,
  file: AssetFile,
  cachePath: string,
  registryRoot: string,
  providers: AssetProviderAdapter[],
): Promise<AssetProviderResolution> {
  const candidates = providers.filter((provider) => provider.canResolve(entry, file));
  if (candidates.length === 0) {
    return {
      status: "rejected",
      cachePath,
      cacheStatus: "skipped",
      diagnostics: [{
        code: "PROVIDER_NOT_CONFIGURED",
        message: "No asset provider can resolve this entry.",
      }],
    };
  }

  const diagnostics: AssetValidationIssue[] = [];
  let cacheStatus: CacheStatus = "skipped";
  for (const provider of candidates) {
    try {
      const resolution = await provider.resolve({ entry, file, cachePath, registryRoot });
      if (resolution.status === "resolved") {
        return resolution;
      }

      cacheStatus = resolution.cacheStatus;
      diagnostics.push(...resolution.diagnostics);
    } catch (error) {
      cacheStatus = "miss";
      diagnostics.push({
        code: "PROVIDER_SOURCE_MISSING",
        message: `${provider.name} provider failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    status: "rejected",
    cachePath,
    cacheStatus,
    diagnostics: diagnostics.length > 0
      ? diagnostics
      : [{
        code: "PROVIDER_SOURCE_MISSING",
        message: "No asset provider resolved this entry.",
      }],
  };
}

async function prepareEntry(
  entry: AssetRegistryEntry,
  profile: AssetProfile,
  cacheDir: string,
  registryRoot: string,
  providers: AssetProviderAdapter[],
): Promise<PreparedAsset> {
  const file = firstFile(entry);
  const cachePath = deterministicCachePath(cacheDir, entry, file);
  const kind = assetKindOf(entry);

  try {
    const resolution = await resolveWithProviders(entry, file, cachePath, registryRoot, providers);
    if (resolution.status === "rejected") {
      return {
        id: entry.id,
        primitive: entry.primitive,
        kind,
        status: "rejected",
        cachePath,
        unityPath: entry.unity.path,
        source: entry.source,
        license: entry.license,
        provider: entry.provider,
        file,
        cacheStatus: resolution.cacheStatus,
        providerDiagnostics: resolution.diagnostics,
        import: {
          tool: "unity_asset_create_sprite",
          toolArguments: {
            source_path: cachePath,
            path: entry.unity.path,
          },
        },
        rejections: resolution.diagnostics.map((diagnostic) => diagnostic.code),
      };
    }

    if (file.url && !file.checksum) {
      const missingChecksumDiagnostic = {
        code: "CHECKSUM_MISMATCH" as const,
        message: "Remote asset files require a pinned sha256 checksum before prepare can approve downloaded bytes.",
        path: "files[0].checksum",
      };
      return {
        id: entry.id,
        primitive: entry.primitive,
        kind,
        status: "rejected",
        cachePath,
        unityPath: entry.unity.path,
        source: entry.source,
        license: entry.license,
        provider: entry.provider,
        file,
        cacheStatus: resolution.cacheStatus,
        providerDiagnostics: [missingChecksumDiagnostic],
        import: {
          tool: "unity_asset_create_sprite",
          toolArguments: {
            source_path: cachePath,
            path: entry.unity.path,
          },
        },
        rejections: [missingChecksumDiagnostic.code],
      };
    }

    const checksum = await computeSha256(cachePath);
    if (file.checksum && file.checksum.value !== checksum.value) {
      const checksumDiagnostic = {
        code: "CHECKSUM_MISMATCH" as const,
        message: `Prepared file sha256 ${checksum.value} does not match registry checksum ${file.checksum.value}.`,
        path: "files[0].checksum",
      };
      return {
        id: entry.id,
        primitive: entry.primitive,
        kind,
        status: "rejected",
        cachePath,
        unityPath: entry.unity.path,
        source: entry.source,
        license: entry.license,
        provider: entry.provider,
        file,
        checksum,
        cacheStatus: resolution.cacheStatus,
        providerDiagnostics: resolution.diagnostics,
        import: {
          tool: "unity_asset_create_sprite",
          toolArguments: {
            source_path: cachePath,
            path: entry.unity.path,
          },
        },
        rejections: [checksumDiagnostic.code],
      };
    }

    const importPlan = kind === "sprite"
      ? planUnitySpriteImport({ entry, profile, sourcePath: cachePath })
      : undefined;
    const unityPath = importPlan?.path ?? entry.unity.path;
    const validation = kind === "audio"
      ? await validatePreparedAudio({ entry, profile, sourcePath: cachePath, unityPath })
      : kind === "sprite"
        ? await validatePreparedSprite({
          entry,
          profile,
          sourcePath: cachePath,
          unityPath,
        })
        : await validatePreparedNonImage({ entry, profile, sourcePath: cachePath, unityPath });
    const rejections = validation.issues.map((issue) => issue.code);
    return {
      id: entry.id,
      primitive: entry.primitive,
      kind,
      placeholder: entry.placeholder === true,
      status: validation.status,
      cachePath,
      unityPath,
      source: entry.source,
      license: entry.license,
      provider: entry.provider,
      file,
      metadata: validation.metadata,
      checksum,
      cacheStatus: resolution.cacheStatus,
      providerDiagnostics: resolution.diagnostics,
      import: importPlan ? {
        tool: importPlan.tool,
        toolArguments: importPlan.toolArguments,
      } : undefined,
      rejections,
    };
  } catch (error) {
    return {
      id: entry.id,
      primitive: entry.primitive,
      kind,
      status: "rejected",
      cachePath,
      unityPath: entry.unity.path,
      source: entry.source,
      license: entry.license,
      provider: entry.provider,
      file,
      cacheStatus: "skipped",
      providerDiagnostics: [{
        code: "PROVIDER_SOURCE_MISSING",
        message: error instanceof Error ? error.message : String(error),
      }],
      import: {
        tool: "unity_asset_create_sprite",
        toolArguments: {
          source_path: cachePath,
          path: entry.unity.path,
        },
      },
      rejections: [`FILE_PREPARE_FAILED:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export interface PrepareAssetsDeps {
  /**
   * Optional provider chain override (testability seam). When supplied, prepare uses
   * THIS chain instead of `defaultProviders()`. Production callers omit `deps` (or omit
   * `providers`), so the default behavior is exactly `defaultProviders()` as before.
   */
  providers?: AssetProviderAdapter[];
}

export async function prepareAssets(
  options: PrepareAssetsOptions,
  deps: PrepareAssetsDeps = {},
): Promise<AssetPrepareReport> {
  const profilePath = path.resolve(options.profilePath);
  const outputPath = path.resolve(options.outputPath);
  const cacheDir = path.resolve(options.cacheDir);
  const profile = await loadAssetProfile(profilePath);
  const { registry, sourcePath, registryRoot } = await loadRegistryForPrepare(options, profile);
  const validationIssues = validateRegistryPolicy(registry, profile);
  if (validationIssues.length > 0) {
    const report: AssetPrepareReport = {
      schemaVersion: "1",
      status: "fail",
      registry: {
        packId: registry.packId,
        path: sourcePath,
      },
      profile: {
        id: profile.id,
        path: profilePath,
      },
      assets: [],
      diagnostics: buildPrepareDiagnostics([], validationIssues),
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const genre = options.genre ?? profile.genre;
  const primitives = options.primitives && options.primitives.length > 0
    ? options.primitives
    : Object.keys(profile.primitives);
  const selected = selectAssets(registry, {
    genre,
    primitives,
    tags: options.tags,
    preferredLicense: options.preferredLicense,
  });
  const assets: PreparedAsset[] = [];
  const providers = deps.providers ?? defaultProviders();

  for (const entry of selected) {
    assets.push(await prepareEntry(entry, profile, cacheDir, registryRoot, providers));
  }

  const accepted = assets.filter((asset) => asset.status === "accepted").length;
  const rejected = assets.length - accepted;
  const report: AssetPrepareReport = {
    schemaVersion: "1",
    status: rejected === 0 ? "pass" : "fail",
    registry: {
      packId: registry.packId,
      path: sourcePath,
    },
    profile: {
      id: profile.id,
      path: profilePath,
    },
    assets,
    diagnostics: buildPrepareDiagnostics(assets),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const report = await prepareAssets(args);
  const ph = report.diagnostics.placeholder ?? 0;
  const phNote = ph > 0 ? ` PLACEHOLDER-ART=${ph} (not real bytes — swap before shipping)` : "";
  console.error(`[asset-layer] status=${report.status} selected=${report.diagnostics.selected}${phNote} output=${args.outputPath}`);
  return report.status === "pass" ? 0 : 1;
}

const isMainModule = process.argv[1]?.endsWith("prepare-cli.js") || process.argv[1]?.endsWith("prepare-cli.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[asset-layer] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
