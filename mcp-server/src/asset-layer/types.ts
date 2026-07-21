import type { CatalogFetch } from "./catalog-source.js";

export type AssetPrimitive = "player" | "tile" | "collectible" | "background" | "decor" | string;
export type AssetKind = "sprite" | "audio" | "material" | "model" | "vector";
export type AssetFileFormat = "png" | "jpg" | "jpeg" | "wav" | "ogg" | "glb" | "svg";
export type AssetAcquisitionLane = "api" | "mirror-index" | "scraped-discovery";
export type AssetTrustTier = "trusted-default" | "attribution-required" | "unverified-discovery" | "blocked";
export type AssetReviewStatus = "unreviewed" | "needs-review" | "verified" | "rejected";
export type AssetReviewVerifierKind = "developer" | "loomtide" | "source-owner";
export type AssetIngestProvenanceMethod = "api" | "crawler" | "mirror-index";
export type AssetIngestPromotionRejectionReason =
  | "NON_COMMERCIAL"
  | "UNCLEAR_LICENSE"
  | "ATTRIBUTION_NOT_SUPPORTED"
  | "MISSING_AUTHOR"
  | "MISSING_DOWNLOAD_URL"
  | "PROVIDER_TERMS_CONFLICT"
  | "CHECKSUM_MISMATCH"
  | "MISSING_SOURCE"
  | "MISSING_FILE_METADATA"
  | "INVALID_PROVENANCE"
  | "UNREVIEWED_SCRAPED_CANDIDATE";
export type PreparedAssetStatus = "accepted" | "rejected";
export type PrepareReportStatus = "pass" | "fail";
export type AssetValidationCode =
  | "MISSING_FILE"
  | "MISSING_LICENSE"
  | "UNSUPPORTED_FORMAT"
  | "DIMENSIONS_TOO_LARGE"
  | "MISSING_SOURCE"
  | "INVALID_UNITY_PATH"
  | "UNKNOWN_PRIMITIVE"
  | "DIMENSIONS_UNREADABLE"
  | "UNSUPPORTED_KIND"
  | "PROVIDER_SOURCE_MISSING"
  | "PROVIDER_DOWNLOAD_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "CHECKSUM_MISMATCH"
  | "AUDIO_METADATA_UNREADABLE"
  | "AUDIO_FORMAT_UNSUPPORTED"
  | "AUDIO_SAMPLE_RATE_UNSUPPORTED"
  | "AUDIO_CHANNELS_UNSUPPORTED"
  | "AUDIO_DURATION_TOO_LONG"
  | "INVALID_SPRITE_SLICING";

export type AssetPolicyValidationCode =
  | "DUPLICATE_ID"
  | "MISSING_SOURCE"
  | "MISSING_LICENSE"
  | "MISSING_PROVIDER"
  | "MISSING_PROVENANCE"
  | "SOURCE_UNVERIFIED"
  | "DISALLOWED_LICENSE"
  | "DENIED_LICENSE"
  | "INVALID_CHECKSUM_DECLARATION"
  | "UNKNOWN_KIND"
  | "UNKNOWN_PRIMITIVE"
  | "UNSUPPORTED_PRIMITIVE_KIND";

export type CacheStatus = "hit" | "miss" | "skipped";

export interface AssetSourceProvenance {
  verifiedAt: string;
  origin: string;
  fixture: string;
  notes?: string;
  [key: string]: unknown;
}

export interface AssetSource {
  title: string;
  url: string;
  downloadPage?: string;
  author: string;
  verified?: boolean;
  provenance: AssetSourceProvenance;
}

export interface AssetLicense {
  name: string;
  spdx: string;
  url: string;
  requiresAttribution: boolean;
}

export interface AssetProvider {
  name: string;
  url: string;
  type?: "local" | "http" | "generation";
  acquisitionLane?: AssetAcquisitionLane;
  termsNotes?: string;
}

export interface AssetChecksum {
  algorithm: "sha256";
  value: string;
}

export interface AssetFile {
  role: "sprite" | "spritesheet" | "background" | "decor" | "audio" | "model" | "vector";
  format: AssetFileFormat;
  localPath?: string;
  url?: string;
  githubRawUrl?: string;
  githubBlobUrl?: string;
  sizeBytes?: number;
  sha256?: string;
  checksum?: AssetChecksum;
}

export interface AssetReview {
  status: AssetReviewStatus;
  verifiedBy?: AssetReviewVerifierKind;
  verifiedAt?: string;
  reviewer?: string;
  notes?: string;
  reason?: string;
}

export interface AssetTechnicalMetadata {
  width?: number;
  height?: number;
  pixelsPerUnit?: number;
  transparent?: boolean;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  durationMs?: number;
}

export type AssetSpriteMode = "single" | "multiple";
export type AssetSpritePivotName = "center" | "bottom" | "top" | "left" | "right" | "bottomLeft" | "bottomRight" | "topLeft" | "topRight";

export interface AssetSpritePivotPoint {
  x: number;
  y: number;
}

export type AssetSpritePivot = AssetSpritePivotName | AssetSpritePivotPoint;

export interface AssetSpriteGridCoordinate {
  name: string;
  column: number;
  row: number;
  pivot?: AssetSpritePivot;
  tags?: string[];
}

export interface AssetSpriteRect {
  name: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  pivot?: AssetSpritePivot;
  tags?: string[];
}

export interface AssetSpriteGridSlicing {
  mode: "grid";
  cell: {
    width: number;
    height: number;
  };
  offset?: {
    x: number;
    y: number;
  };
  spacing?: {
    x: number;
    y: number;
  };
  pivot?: AssetSpritePivot;
  sprites: AssetSpriteGridCoordinate[];
}

export interface AssetSpriteRectSlicing {
  mode: "rects";
  pivot?: AssetSpritePivot;
  sprites: AssetSpriteRect[];
}

export type AssetSpriteSlicing = AssetSpriteGridSlicing | AssetSpriteRectSlicing;

export interface AssetUnityImport {
  path: string;
  pixelsPerUnit: number;
  spriteMode?: AssetSpriteMode;
  filterMode?: "Point" | "Bilinear";
  slicing?: AssetSpriteSlicing;
  defaultSpriteName?: string;
}

export interface AssetRegistryEntry {
  id: string;
  genre: string;
  primitive: AssetPrimitive;
  kind?: AssetKind;
  priority?: number;
  /**
   * True when the entry's bytes are a generated placeholder (proof-of-pipeline art) rather
   * than the real CC0 asset. License/provenance can still be verified; the BYTES are not the
   * real art. prepare surfaces these so a build never silently ships stubs as production art.
   */
  placeholder?: boolean;
  source: AssetSource;
  license: AssetLicense;
  provider: AssetProvider;
  files: AssetFile[];
  technical: AssetTechnicalMetadata;
  tags: string[];
  unity: AssetUnityImport;
  review?: AssetReview;
  acquisitionLane?: AssetAcquisitionLane;
  trustTier?: AssetTrustTier;
  policyStatus?: AssetTrustTier;
}

export interface AssetRegistryPack {
  schemaVersion: "1";
  packId: string;
  name: string;
  description?: string;
  entries: AssetRegistryEntry[];
}

export interface AssetCatalogRecord extends Omit<AssetRegistryEntry, "files" | "review"> {
  review: AssetReview;
  acquisitionLane?: AssetAcquisitionLane;
  trustTier?: AssetTrustTier;
  policyStatus?: AssetTrustTier;
  /**
   * Optional public url of a displayable thumbnail/preview image for this record.
   * Generic (any kind may carry one) and NOT a `files[]` entry — `files[]` are the
   * asset's own bytes. For a 3D model (glb, whose bytes are not an image) this is
   * the pre-rendered preview PNG that ships alongside the model.
   */
  thumbnailUrl?: string;
  category?: string;
  pack?: {
    packId: string;
    name?: string;
    version?: string;
    catalogPath?: string;
  };
  files: AssetFile[];
}

export interface AssetCatalogShard {
  schemaVersion?: "1";
  catalogId?: string;
  provider?: AssetProvider;
  pack?: {
    packId: string;
    name?: string;
    version?: string;
  };
  assets?: AssetCatalogRecord[];
}

export interface AssetIngestLicenseClaim {
  name?: string;
  spdx?: string;
  url?: string;
  requiresAttribution?: boolean;
  commercialUse?: boolean;
  raw?: string;
}

export interface AssetIngestObservedFile {
  url: string;
  role?: AssetFile["role"];
  format?: AssetFileFormat;
  sizeBytes?: number;
  sha256?: string;
}

export interface AssetIngestObservedMetadata {
  genre?: string;
  primitive?: string;
  kind?: AssetKind;
  category?: string;
  tags?: string[];
  technical?: AssetTechnicalMetadata;
  unity?: Partial<AssetUnityImport>;
}

export interface AssetIngestCandidate {
  schemaVersion: "1";
  id: string;
  acquisitionLane: AssetAcquisitionLane;
  sourceUrl: string;
  pageTitle?: string;
  author?: string;
  provider: AssetProvider;
  licenseClaim: AssetIngestLicenseClaim;
  fileUrls: string[];
  observed: AssetIngestObservedMetadata & {
    files?: AssetIngestObservedFile[];
  };
  provenance: {
    discoveredAt: string;
    method: AssetIngestProvenanceMethod;
    provider: string;
    sourceRecordId?: string;
    indexUrl?: string;
    notes?: string;
  };
  review: AssetReview;
  rejection?: {
    reason: AssetIngestPromotionRejectionReason;
    detail: string;
  };
}

export interface AssetProfilePrimitive {
  description?: string;
  unityFolder: string;
  supportedKinds?: AssetKind[];
}

export interface AssetProfile {
  schemaVersion: "1";
  id: string;
  genre: string;
  description?: string;
  scaleProfile?: {
    reference: string;
    referenceGames?: string[];
    tile: {
      pixels: number;
      pixelsPerUnit: number;
      worldSize: number;
    };
    player: {
      visualHeightTiles: number;
      targetWorldHeight: number;
      screenHeightRatio?: {
        min: number;
        max: number;
      };
    };
    camera: {
      profile: string;
      orthographicSize: number;
      verticalTilesVisible: number;
      framingOffset?: {
        x: number;
        y: number;
      };
    };
  };
  validation: {
    allowedFormats: AssetFileFormat[];
    maxDimensions: {
      width: number;
      height: number;
    };
    maxTexturePixels?: number;
    expectedPixelsPerUnit: number;
    requiredProvenanceFields: string[];
    allowedLicenses: string[];
    allowedKinds?: AssetKind[];
    licensePolicy?: {
      allowedSpdx: string[];
      deniedSpdx?: string[];
    };
    checksumPolicy?: {
      requireSha256?: boolean;
    };
    sourcePolicy?: {
      requireVerified?: boolean;
      minimumProvenanceFields?: string[];
    };
    audio?: {
      allowedFormats: Extract<AssetFileFormat, "wav" | "ogg">[];
      allowedSampleRates: number[];
      allowedChannels: number[];
      maxDurationMs: number;
      allowedBitDepths?: number[];
    };
  };
  primitives: Record<string, AssetProfilePrimitive>;
  unity: {
    rootFolder: string;
    defaultSpriteMode: "single";
    defaultFilterMode: "Point" | "Bilinear";
    toolArguments: {
      sourcePathKey: "source_path";
      destinationPathKey: "path";
    };
  };
}

export interface AssetSelectionOptions {
  genre: string;
  primitives?: string[];
  tags?: string[];
  preferredLicense?: string;
}

export interface AssetCatalogQueryOptions {
  genre?: string;
  primitive?: string;
  primitives?: string[];
  kind?: AssetKind;
  tags?: string[];
  license?: string;
  provider?: string;
  verificationStatus?: AssetReviewStatus;
  text?: string;
  preferredLicense?: string;
}

export interface ImageMetadata {
  format: Extract<AssetFileFormat, "png" | "jpg" | "jpeg">;
  width: number;
  height: number;
}

export interface AudioMetadata {
  format: Extract<AssetFileFormat, "wav">;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationMs: number;
}

export interface PreparedAssetImport {
  tool: "unity_asset_create_sprite";
  toolArguments: {
    source_path: string;
    path: string;
    pixels_per_unit?: number;
    sprite_mode?: AssetSpriteMode;
    filter_mode?: "Point" | "Bilinear";
    slicing?: AssetSpriteSlicing;
    default_sprite_name?: string;
  };
}

export interface UnitySpriteImportPlan {
  tool: "unity_asset_create_sprite";
  source_path: string;
  path: string;
  toolArguments: {
    source_path: string;
    path: string;
    pixels_per_unit?: number;
    sprite_mode?: AssetSpriteMode;
    filter_mode?: "Point" | "Bilinear";
    slicing?: AssetSpriteSlicing;
    default_sprite_name?: string;
  };
}

export interface AssetValidationIssue {
  code: AssetValidationCode;
  message: string;
  path?: string;
}

export interface AssetValidationResult {
  status: PreparedAssetStatus;
  issues: AssetValidationIssue[];
  metadata?: ImageMetadata | AudioMetadata;
}

export interface AssetPolicyValidationIssue {
  code: AssetPolicyValidationCode;
  path: string;
  message: string;
}

export interface PreparedAsset {
  id: string;
  primitive: string;
  kind: AssetKind;
  status: PreparedAssetStatus;
  /** Mirrors the registry entry: true when these bytes are a generated placeholder, not real art. */
  placeholder?: boolean;
  cachePath: string;
  unityPath: string;
  source: AssetSource;
  license: AssetLicense;
  provider: AssetProvider;
  file: AssetFile;
  metadata?: ImageMetadata | AudioMetadata;
  checksum?: AssetChecksum;
  cacheStatus?: CacheStatus;
  providerDiagnostics?: AssetValidationIssue[];
  import?: PreparedAssetImport;
  rejections: string[];
}

export interface AssetPrepareReport {
  schemaVersion: "1";
  status: PrepareReportStatus;
  registry: {
    packId: string;
    path: string;
  };
  profile: {
    id: string;
    path: string;
  };
  assets: PreparedAsset[];
  diagnostics: {
    selected: number;
    accepted: number;
    rejected: number;
    /** How many selected assets are placeholder bytes (not real art). >0 ⇒ swap art before shipping. */
    placeholder?: number;
    cache?: {
      hit: number;
      miss: number;
      skipped: number;
    };
    byPrimitive?: Record<string, { selected: number; accepted: number; rejected: number }>;
    byKind?: Record<string, { selected: number; accepted: number; rejected: number }>;
    validationIssues?: AssetPolicyValidationIssue[];
    providerDiagnostics?: Array<{
      id: string;
      codes: string[];
    }>;
    acceptedImports?: PreparedAssetImport[];
    rejections: Array<{
      id: string;
      codes: string[];
    }>;
  };
}

export interface PrepareAssetsOptions {
  profilePath: string;
  registryPath?: string;
  catalogPath?: string;
  /**
   * Base URL of the hosted DB-backed search API (Phase B). When set, prepare pulls its catalog
   * from `<catalogApiUrl>/v1/assets/search` via `ApiCatalogSource` instead of static shards or a
   * local file. Mutually exclusive with `registryPath` and `catalogPath`.
   */
  catalogApiUrl?: string;
  /** Injectable fetcher passed to `ApiCatalogSource` (tests). Production omits it (uses global fetch). */
  catalogFetch?: CatalogFetch;
  outputPath: string;
  cacheDir: string;
  genre?: string;
  primitives?: string[];
  tags?: string[];
  preferredLicense?: string;
  validateOnly?: boolean;
}
