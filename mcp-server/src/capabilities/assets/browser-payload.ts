#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AssetFile,
  AssetPrepareReport,
  AssetProfile,
  AssetRegistryEntry,
  AssetRegistryPack,
  AssetReviewStatus,
  AssetTrustTier,
  PreparedAsset,
} from "./types.js";
import {
  ApiCatalogSource,
  catalogRecordsToRegistryPack,
  type CatalogFetch,
  HttpCatalogSource,
  LocalCatalogSource,
} from "./catalog-source.js";
import { assetKindOf, loadAssetProfile, loadRegistryPack } from "./registry.js";
import { reviewStatusForEntry, trustTierForEntry } from "./trust.js";

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface AssetBrowserCategory {
  id: string;
  label: string;
}

export interface AssetBrowserAsset {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  primitive: string;
  kind: string;
  imagePath?: string;
  license?: string;
  licenseName?: string;
  placeholder?: boolean;
  tags?: string[];
  badges?: string[];
  author?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  provider?: string;
  providerType?: string;
  acquisitionLane?: string;
  trustTier?: string;
  reviewStatus?: AssetReviewStatus;
  reviewVerifiedBy?: string;
  reviewVerifiedAt?: string;
  policyStatus?: AssetTrustTier;
  attributionText?: string;
  sourceLinks?: {
    source?: string;
    download?: string;
    githubBlob?: string;
  };
  directDownloadUrl?: string;
  actionIntents?: string[];
  unityPath?: string;
  fileRole?: string;
  fileFormat?: string;
  fileSize?: string;
  width?: number;
  height?: number;
  pixelsPerUnit?: number;
  priority?: number;
}

export interface AssetBrowserPayload {
  title: string;
  registry: {
    name: string;
    status: string;
    syncedLabel: string;
  };
  categories: AssetBrowserCategory[];
  facets: Record<string, string[]>;
  assets: AssetBrowserAsset[];
  inventory: string[];
}

export interface BuildAssetBrowserPayloadOptions {
  registryPath?: string;
  catalogPath?: string;
  /**
   * Base URL of the hosted DB-backed search API (Phase B). When set, the browser pulls its
   * catalog from `<catalogApiUrl>/v1/assets/search` via `ApiCatalogSource` instead of static
   * shards or a local file. Mutually exclusive with `registryPath` and `catalogPath`.
   */
  catalogApiUrl?: string;
  /** Injectable fetcher passed to `ApiCatalogSource` (tests). Production omits it (uses global fetch). */
  catalogFetch?: CatalogFetch;
  profilePath: string;
  preferredLicense?: string;
  tags?: string[];
  previewCacheDir?: string;
  cacheImagePreviews?: boolean;
  fetchImpl?: FetchLike;
}

export interface BuildAssetBrowserPayloadFromReportOptions {
  prepareReportPath: string;
}

interface CliArgs extends BuildAssetBrowserPayloadOptions {
  prepareReportPath?: string;
  outputPath: string;
  help: boolean;
}

const categories: AssetBrowserCategory[] = [
  { id: "characters", label: "Characters" },
  { id: "environments", label: "Environments" },
  { id: "props", label: "Props & Items" },
  { id: "weapons", label: "Weapons" },
  { id: "vfx", label: "VFX" },
  { id: "audio", label: "Audio" },
  { id: "animations", label: "Animations" },
  { id: "materials", label: "Materials" },
  { id: "ui", label: "UI Kits" },
];

function printUsage(): void {
  console.log(
    "Usage: node dist/capabilities/assets/browser-payload.js (--profile <path-or-id> (--registry <path> | --catalog <path-or-url> | --catalog-api <baseUrl>) | --prepare-report <report.json>) --output <payload.json> [--preferred-license <spdx>] [--tags <csv>] [--cache-previews] [--preview-cache <dir>]",
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
    registryPath: "",
    profilePath: "",
    outputPath: "../demos/.artifacts/platformer-asset-browser-payload.json",
    previewCacheDir: "../demos/.artifacts/asset-cache/browser-previews",
    help: false,
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
      case "--prepare-report":
        args.prepareReportPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--output":
        args.outputPath = path.resolve(process.cwd(), argv[++i] ?? args.outputPath);
        break;
      case "--preferred-license":
        args.preferredLicense = argv[++i] ?? "";
        break;
      case "--tags":
        args.tags = (argv[++i] ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
        break;
      case "--cache-previews":
        args.cacheImagePreviews = true;
        break;
      case "--preview-cache":
        args.previewCacheDir = path.resolve(process.cwd(), argv[++i] ?? args.previewCacheDir ?? "");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.help && !args.prepareReportPath && (!args.profilePath || (!args.registryPath && !args.catalogPath && !args.catalogApiUrl))) {
    throw new Error("Missing required --profile plus --registry/--catalog/--catalog-api arguments, or --prepare-report.");
  }

  return args;
}

function repoRootFromRegistry(registryPath: string): string {
  return path.resolve(path.dirname(registryPath), "../..");
}

function repoRootFromCatalog(catalogPath: string | undefined): string {
  if (!catalogPath || /^https?:\/\//.test(catalogPath)) {
    return process.cwd();
  }
  return path.resolve(path.dirname(catalogPath), "../..");
}

function sourceLabel(value: string): string {
  if (/^https?:\/\//.test(value)) {
    return value.replace(/^https?:\/\//, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  }
  return path.basename(value, path.extname(value)) || "asset-catalog";
}

async function loadRegistryPackForBrowser(
  options: BuildAssetBrowserPayloadOptions,
  profile: AssetProfile,
): Promise<{ registry: AssetRegistryPack; registryRoot: string }> {
  const sourceCount = [options.registryPath, options.catalogPath, options.catalogApiUrl]
    .filter((value) => Boolean(value)).length;
  if (sourceCount > 1) {
    throw new Error("Use exactly one of --registry, --catalog, or --catalog-api.");
  }

  if (options.registryPath) {
    const registryPath = path.resolve(options.registryPath);
    return {
      registry: await loadRegistryPack(registryPath),
      registryRoot: repoRootFromRegistry(registryPath),
    };
  }

  if (options.catalogApiUrl) {
    const source = new ApiCatalogSource(options.catalogApiUrl, options.catalogFetch);
    const records = await source.query({
      genre: profile.genre,
      preferredLicense: options.preferredLicense,
      tags: options.tags,
    });
    return {
      registry: catalogRecordsToRegistryPack(records, {
        packId: sourceLabel(options.catalogApiUrl),
        name: `Asset Catalog: ${sourceLabel(options.catalogApiUrl)}`,
        description: `Adapted from hosted asset catalog search API ${options.catalogApiUrl}.`,
      }),
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
  const records = await source.query({
    genre: profile.genre,
    preferredLicense: options.preferredLicense,
    tags: options.tags,
  });
  return {
    registry: catalogRecordsToRegistryPack(records, {
      packId: sourceLabel(options.catalogPath),
      name: `Asset Catalog: ${sourceLabel(options.catalogPath)}`,
      description: `Adapted from hosted asset catalog source ${options.catalogPath}.`,
    }),
    registryRoot: repoRootFromCatalog(options.catalogPath),
  };
}

function primaryFile(entry: AssetRegistryEntry): AssetFile | undefined {
  return entry.files[0];
}

function isImageFormat(format: string | undefined): boolean {
  return format === "png" || format === "jpg" || format === "jpeg";
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function sourceReference(file: AssetFile): string {
  return file.url ?? file.localPath ?? "unknown";
}

function reviewVerifiedByForEntry(entry: AssetRegistryEntry): string | undefined {
  return entry.review?.verifiedBy;
}

function reviewVerifiedAtForEntry(entry: AssetRegistryEntry): string | undefined {
  return entry.review?.verifiedAt;
}

function acquisitionLaneForEntry(entry: AssetRegistryEntry): string | undefined {
  return entry.acquisitionLane ?? entry.provider?.acquisitionLane;
}

function attributionTextForEntry(entry: AssetRegistryEntry): string | undefined {
  if (!entry.license?.requiresAttribution) {
    return undefined;
  }
  return `${entry.source?.title ?? entry.id} by ${entry.source?.author ?? "unknown"} (${entry.license.spdx})`;
}

function directDownloadUrl(file: AssetFile | undefined): string | undefined {
  return file?.url ?? file?.githubRawUrl;
}

function githubBlobUrl(file: AssetFile | undefined): string | undefined {
  return file?.githubBlobUrl;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
    .sort((a, b) => a.localeCompare(b));
}

function buildFacets(assets: AssetBrowserAsset[]): Record<string, string[]> {
  return {
    genre: [],
    category: uniqueSorted(assets.map((asset) => asset.category)),
    primitive: uniqueSorted(assets.map((asset) => asset.primitive)),
    kind: uniqueSorted(assets.map((asset) => asset.kind)),
    license: uniqueSorted(assets.map((asset) => asset.license)),
    provider: uniqueSorted(assets.map((asset) => asset.provider)),
    acquisitionLane: uniqueSorted(assets.map((asset) => asset.acquisitionLane)),
    trustTier: uniqueSorted(assets.map((asset) => asset.trustTier)),
    verificationStatus: uniqueSorted(assets.map((asset) => asset.reviewStatus)),
    tags: uniqueSorted(assets.flatMap((asset) => asset.tags ?? [])),
  };
}

export function browserPreviewCachePath(cacheDir: string, entry: AssetRegistryEntry, file: AssetFile): string {
  const hash = crypto.createHash("sha256").update(`${entry.id}:${sourceReference(file)}`).digest("hex").slice(0, 12);
  return path.join(cacheDir, `${safeName(entry.id)}-${safeName(file.role)}-${hash}.${file.format}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function computeSha256(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function checksumMatches(filePath: string, file: AssetFile): Promise<boolean> {
  if (!file.checksum) {
    return true;
  }

  return await computeSha256(filePath) === file.checksum.value;
}

function categoryForEntry(entry: AssetRegistryEntry): string {
  const kind = assetKindOf(entry);
  if (kind === "audio" || entry.primitive === "sfx_collectible") {
    return "audio";
  }

  switch (entry.primitive) {
    case "player":
    case "enemy":
      return "characters";
    case "tile":
    case "background":
    case "parallax_background":
      return "environments";
    case "vfx":
      return "vfx";
    case "collectible":
    case "decor":
      return "props";
    default:
      return "props";
  }
}

function categoryForPrimitiveKind(primitive: string, kind: string): string {
  if (kind === "audio" || primitive.startsWith("sfx_")) {
    return "audio";
  }

  switch (primitive) {
    case "player":
    case "enemy":
      return "characters";
    case "tile":
    case "background":
    case "parallax_background":
      return "environments";
    case "vfx":
      return "vfx";
    case "collectible":
    case "decor":
      return "props";
    default:
      return "props";
  }
}

function categoryLabel(categoryId: string): string {
  return categories.find((category) => category.id === categoryId)?.label ?? categoryId;
}

async function localImagePath(entry: AssetRegistryEntry, registryRoot: string): Promise<string | undefined> {
  const file = primaryFile(entry);
  if (!file?.localPath || !isImageFormat(file.format)) {
    return undefined;
  }

  const absolutePath = path.resolve(registryRoot, file.localPath);
  return await fileExists(absolutePath) ? absolutePath : undefined;
}

async function cachedImagePath(
  entry: AssetRegistryEntry,
  previewCacheDir: string | undefined,
  cacheImagePreviews: boolean,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const file = primaryFile(entry);
  if (!file?.url || !isImageFormat(file.format) || !previewCacheDir) {
    return undefined;
  }

  const cachePath = browserPreviewCachePath(path.resolve(previewCacheDir), entry, file);
  if (await fileExists(cachePath)) {
    return await checksumMatches(cachePath, file) ? cachePath : undefined;
  }

  if (!cacheImagePreviews) {
    return undefined;
  }

  const response = await fetchImpl(file.url);
  if (!response.ok) {
    return undefined;
  }

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, Buffer.from(await response.arrayBuffer()));
  if (!(await checksumMatches(cachePath, file))) {
    await fs.rm(cachePath, { force: true });
    return undefined;
  }

  return cachePath;
}

async function previewImagePath(
  entry: AssetRegistryEntry,
  registryRoot: string,
  options: BuildAssetBrowserPayloadOptions,
): Promise<string | undefined> {
  return await localImagePath(entry, registryRoot)
    ?? await cachedImagePath(
      entry,
      options.previewCacheDir,
      options.cacheImagePreviews === true,
      options.fetchImpl ?? fetch,
    );
}

async function localFileSize(entry: AssetRegistryEntry, registryRoot: string): Promise<string | undefined> {
  const file = primaryFile(entry);
  if (!file?.localPath) {
    return undefined;
  }

  const absolutePath = path.resolve(registryRoot, file.localPath);
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.size < 1024) {
      return `${stat.size} B`;
    }
    if (stat.size < 1024 * 1024) {
      return `${(stat.size / 1024).toFixed(1)} KB`;
    }
    return `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return undefined;
  }
}

async function fileSize(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.size < 1024) {
      return `${stat.size} B`;
    }
    if (stat.size < 1024 * 1024) {
      return `${(stat.size / 1024).toFixed(1)} KB`;
    }
    return `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return undefined;
  }
}

function displayNameForEntry(entry: AssetRegistryEntry, duplicateSourceTitle: boolean): string {
  const title = entry.source?.title ?? entry.id;
  if (!duplicateSourceTitle) {
    return title;
  }

  const primitive = entry.primitive.replaceAll("_", " ");
  return `${title} - ${primitive}`;
}

async function assetForEntry(
  entry: AssetRegistryEntry,
  registryRoot: string,
  duplicateSourceTitle: boolean,
  options: BuildAssetBrowserPayloadOptions,
): Promise<AssetBrowserAsset> {
  const category = categoryForEntry(entry);
  const file = primaryFile(entry);
  const badges = [
    entry.license?.spdx,
    entry.primitive,
    reviewStatusForEntry(entry) === "verified" ? "VERIFIED" : undefined,
    entry.license?.requiresAttribution ? "ATTRIBUTION" : undefined,
    entry.placeholder === true ? "PLACEHOLDER" : undefined,
  ].filter((value): value is string => Boolean(value));
  const reviewStatus = reviewStatusForEntry(entry);
  const fileDownloadUrl = directDownloadUrl(file);

  return {
    id: entry.id,
    name: displayNameForEntry(entry, duplicateSourceTitle),
    category,
    categoryLabel: categoryLabel(category),
    primitive: entry.primitive,
    kind: assetKindOf(entry),
    imagePath: await previewImagePath(entry, registryRoot, options),
    license: entry.license?.spdx,
    licenseName: entry.license?.name,
    placeholder: entry.placeholder === true,
    tags: entry.tags,
    badges,
    author: entry.source?.author,
    sourceTitle: entry.source?.title,
    sourceUrl: entry.source?.url,
    provider: entry.provider?.name,
    providerType: entry.provider?.type,
    acquisitionLane: acquisitionLaneForEntry(entry),
    trustTier: trustTierForEntry(entry),
    reviewStatus,
    reviewVerifiedBy: reviewVerifiedByForEntry(entry),
    reviewVerifiedAt: reviewVerifiedAtForEntry(entry),
    policyStatus: trustTierForEntry(entry),
    attributionText: attributionTextForEntry(entry),
    sourceLinks: {
      source: entry.source?.url,
      download: entry.source?.downloadPage,
      githubBlob: githubBlobUrl(file),
    },
    directDownloadUrl: fileDownloadUrl,
    actionIntents: [
      "inspect-source",
      fileDownloadUrl ? "download-preview" : undefined,
      trustTierForEntry(entry) === "trusted-default" ? "select" : "request-explicit-approval",
    ].filter((value): value is string => Boolean(value)),
    unityPath: entry.unity?.path,
    fileRole: file?.role,
    fileFormat: file?.format,
    fileSize: await localFileSize(entry, registryRoot),
    width: entry.technical?.width,
    height: entry.technical?.height,
    pixelsPerUnit: entry.technical?.pixelsPerUnit,
    priority: entry.priority,
  };
}

function displayNameForPreparedAsset(asset: PreparedAsset, duplicateSourceTitle: boolean): string {
  const title = asset.source?.title ?? asset.id;
  if (!duplicateSourceTitle) {
    return title;
  }

  return `${title} - ${asset.primitive.replaceAll("_", " ")}`;
}

async function assetForPreparedAsset(asset: PreparedAsset, duplicateSourceTitle: boolean): Promise<AssetBrowserAsset> {
  const category = categoryForPrimitiveKind(asset.primitive, asset.kind);
  const isImage = isImageFormat(asset.file?.format);
  const imageMetadata = asset.metadata && "width" in asset.metadata ? asset.metadata : undefined;
  const badges = [
    asset.license?.spdx,
    asset.primitive,
    asset.source?.verified === true ? "VERIFIED" : undefined,
    asset.license?.requiresAttribution ? "ATTRIBUTION" : undefined,
    asset.placeholder === true ? "PLACEHOLDER" : undefined,
  ].filter((value): value is string => Boolean(value));
  const policyStatus: AssetTrustTier = asset.license?.requiresAttribution
    ? "attribution-required"
    : asset.source?.verified === true && asset.license?.spdx === "CC0-1.0"
      ? "trusted-default"
      : "unverified-discovery";

  return {
    id: asset.id,
    name: displayNameForPreparedAsset(asset, duplicateSourceTitle),
    category,
    categoryLabel: categoryLabel(category),
    primitive: asset.primitive,
    kind: asset.kind,
    imagePath: isImage ? asset.cachePath : undefined,
    license: asset.license?.spdx,
    licenseName: asset.license?.name,
    placeholder: asset.placeholder === true,
    tags: [asset.primitive, asset.kind, asset.license?.spdx?.toLowerCase()].filter((value): value is string => Boolean(value)),
    badges,
    author: asset.source?.author,
    sourceTitle: asset.source?.title,
    sourceUrl: asset.source?.url,
    provider: asset.provider?.name,
    providerType: asset.provider?.type,
    acquisitionLane: asset.provider?.acquisitionLane,
    trustTier: policyStatus,
    reviewStatus: asset.source?.verified === true ? "verified" : "needs-review",
    policyStatus,
    attributionText: asset.license?.requiresAttribution
      ? `${asset.source?.title ?? asset.id} by ${asset.source?.author ?? "unknown"} (${asset.license.spdx})`
      : undefined,
    sourceLinks: {
      source: asset.source?.url,
      download: asset.source?.downloadPage,
      githubBlob: asset.file?.githubBlobUrl,
    },
    directDownloadUrl: asset.file?.url ?? asset.file?.githubRawUrl,
    actionIntents: [
      "inspect-source",
      policyStatus === "trusted-default" ? "select" : "request-explicit-approval",
    ],
    unityPath: asset.unityPath,
    fileRole: asset.file?.role,
    fileFormat: asset.file?.format,
    fileSize: await fileSize(asset.cachePath),
    width: imageMetadata?.width,
    height: imageMetadata?.height,
    pixelsPerUnit: asset.import?.toolArguments.pixels_per_unit,
  };
}

export async function buildAssetBrowserPayload(options: BuildAssetBrowserPayloadOptions): Promise<AssetBrowserPayload> {
  const profilePath = path.resolve(options.profilePath);
  const profile: AssetProfile = await loadAssetProfile(profilePath);
  const { registry, registryRoot } = await loadRegistryPackForBrowser(options, profile);

  const entries = registry.entries
    .filter((entry) => entry.genre === profile.genre || entry.genre === "game-asset")
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  const titleCounts = new Map<string, number>();
  for (const entry of entries) {
    const title = entry.source?.title ?? entry.id;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  const assets = await Promise.all(entries.map((entry) => {
    const title = entry.source?.title ?? entry.id;
    return assetForEntry(entry, registryRoot, (titleCounts.get(title) ?? 0) > 1, options);
  }));

  return {
    title: "Loombridge Asset Browser",
    registry: {
      name: registry.name,
      status: "loaded",
      syncedLabel: `${entries.length} registry entries`,
    },
    categories,
    facets: buildFacets(assets),
    assets,
    inventory: [],
  };
}

export async function buildAssetBrowserPayloadFromPrepareReport(
  options: BuildAssetBrowserPayloadFromReportOptions,
): Promise<AssetBrowserPayload> {
  const reportPath = path.resolve(options.prepareReportPath);
  const report = JSON.parse(await fs.readFile(reportPath, "utf-8")) as AssetPrepareReport;
  const accepted = report.assets
    .filter((asset) => asset.status === "accepted")
    .sort((a, b) => a.primitive.localeCompare(b.primitive) || a.id.localeCompare(b.id));
  const titleCounts = new Map<string, number>();
  for (const asset of accepted) {
    const title = asset.source?.title ?? asset.id;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  const assets = await Promise.all(accepted.map((asset) => {
    const title = asset.source?.title ?? asset.id;
    return assetForPreparedAsset(asset, (titleCounts.get(title) ?? 0) > 1);
  }));

  return {
    title: "Loombridge Asset Confirmation",
    registry: {
      name: report.registry.packId,
      status: report.status === "pass" ? "prepared" : report.status,
      syncedLabel: `${accepted.length} accepted - ${report.diagnostics.placeholder ?? 0} placeholders`,
    },
    categories,
    facets: buildFacets(assets),
    assets,
    inventory: accepted.map((asset) => asset.id),
  };
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const payload = args.prepareReportPath
    ? await buildAssetBrowserPayloadFromPrepareReport({ prepareReportPath: args.prepareReportPath })
    : await buildAssetBrowserPayload(args);
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`[asset-browser] assets=${payload.assets.length} output=${args.outputPath}`);
  return 0;
}

const isMainModule = process.argv[1]?.endsWith("browser-payload.js") || process.argv[1]?.endsWith("browser-payload.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[asset-browser] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
