import fs from "node:fs/promises";
import path from "node:path";
import { readWavMetadata } from "./audio-metadata.js";
import { readImageMetadata } from "./image-metadata.js";
import type {
  AssetKind,
  AssetSpriteSlicing,
  AudioMetadata,
  AssetProfile,
  AssetRegistryEntry,
  AssetValidationIssue,
  AssetValidationResult,
  ImageMetadata,
} from "./types.js";

function pushIssue(issues: AssetValidationIssue[], code: AssetValidationIssue["code"], message: string): void {
  issues.push({ code, message });
}

function uniqueIssues(issues: AssetValidationIssue[]): AssetValidationIssue[] {
  const seen = new Set<string>();
  const result: AssetValidationIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.code)) {
      continue;
    }
    seen.add(issue.code);
    result.push(issue);
  }
  return result.sort((a, b) => a.code.localeCompare(b.code));
}

function hasSourceMetadata(entry: AssetRegistryEntry, profile: AssetProfile): boolean {
  if (!entry.source?.title || !entry.source.url || !entry.source.author || !entry.source.provenance) {
    return false;
  }

  return profile.validation.requiredProvenanceFields.every((field) => {
    const value = entry.source.provenance[field];
    return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
  });
}

function isValidUnityPath(unityPath: string): boolean {
  return unityPath.startsWith("Assets/") && !unityPath.includes("..");
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).replace(".", "").toLowerCase();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function validateDimensions(profile: AssetProfile, metadata: ImageMetadata, issues: AssetValidationIssue[]): void {
  if (
    metadata.width > profile.validation.maxDimensions.width
    || metadata.height > profile.validation.maxDimensions.height
  ) {
    pushIssue(
      issues,
      "DIMENSIONS_TOO_LARGE",
      `Image dimensions ${metadata.width}x${metadata.height} exceed ${profile.validation.maxDimensions.width}x${profile.validation.maxDimensions.height}.`,
    );
  }

  const maxTexturePixels = profile.validation.maxTexturePixels;
  if (maxTexturePixels && metadata.width * metadata.height > maxTexturePixels) {
    pushIssue(
      issues,
      "DIMENSIONS_TOO_LARGE",
      `Image pixel count ${metadata.width * metadata.height} exceeds ${maxTexturePixels}.`,
    );
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function validateSpriteSlicing(
  slicing: AssetSpriteSlicing | undefined,
  metadata: ImageMetadata | undefined,
  issues: AssetValidationIssue[],
): Set<string> {
  const names = new Set<string>();
  if (!slicing) {
    pushIssue(issues, "INVALID_SPRITE_SLICING", "Multiple sprite imports require slicing metadata.");
    return names;
  }

  if (!Array.isArray(slicing.sprites) || slicing.sprites.length === 0) {
    pushIssue(issues, "INVALID_SPRITE_SLICING", "Sprite slicing must declare at least one named sprite.");
    return names;
  }

  for (const sprite of slicing.sprites) {
    if (!sprite.name || names.has(sprite.name)) {
      pushIssue(issues, "INVALID_SPRITE_SLICING", `Sprite slice names must be non-empty and unique: '${sprite.name ?? ""}'.`);
    }
    names.add(sprite.name);
  }

  if (!metadata) {
    return names;
  }

  if (slicing.mode === "grid") {
    const offset = slicing.offset ?? { x: 0, y: 0 };
    const spacing = slicing.spacing ?? { x: 0, y: 0 };
    if (
      !isPositiveInteger(slicing.cell.width)
      || !isPositiveInteger(slicing.cell.height)
      || !isNonNegativeInteger(offset.x)
      || !isNonNegativeInteger(offset.y)
      || !isNonNegativeInteger(spacing.x)
      || !isNonNegativeInteger(spacing.y)
    ) {
      pushIssue(issues, "INVALID_SPRITE_SLICING", "Grid slicing cell, offset, and spacing values must be valid integers.");
      return names;
    }

    for (const sprite of slicing.sprites) {
      const right = offset.x + sprite.column * (slicing.cell.width + spacing.x) + slicing.cell.width;
      const bottom = offset.y + sprite.row * (slicing.cell.height + spacing.y) + slicing.cell.height;
      if (!isNonNegativeInteger(sprite.column) || !isNonNegativeInteger(sprite.row) || right > metadata.width || bottom > metadata.height) {
        pushIssue(issues, "INVALID_SPRITE_SLICING", `Grid sprite '${sprite.name}' is outside ${metadata.width}x${metadata.height}.`);
      }
    }
    return names;
  }

  for (const sprite of slicing.sprites) {
    const rect = sprite.rect;
    if (
      !isNonNegativeInteger(rect.x)
      || !isNonNegativeInteger(rect.y)
      || !isPositiveInteger(rect.width)
      || !isPositiveInteger(rect.height)
      || rect.x + rect.width > metadata.width
      || rect.y + rect.height > metadata.height
    ) {
      pushIssue(issues, "INVALID_SPRITE_SLICING", `Rect sprite '${sprite.name}' is outside ${metadata.width}x${metadata.height}.`);
    }
  }
  return names;
}

export async function validatePreparedSprite(options: {
  entry: AssetRegistryEntry;
  profile: AssetProfile;
  sourcePath: string;
  unityPath: string;
}): Promise<AssetValidationResult> {
  const issues: AssetValidationIssue[] = [];
  const extension = extensionOf(options.sourcePath);
  let metadata: ImageMetadata | undefined;

  if (!await exists(options.sourcePath)) {
    pushIssue(issues, "MISSING_FILE", `Prepared file does not exist: ${options.sourcePath}`);
  }

  if (!options.profile.validation.allowedLicenses.includes(options.entry.license?.spdx ?? "")) {
    pushIssue(issues, "MISSING_LICENSE", `License '${options.entry.license?.spdx ?? ""}' is not allowed.`);
  }

  if (!hasSourceMetadata(options.entry, options.profile)) {
    pushIssue(issues, "MISSING_SOURCE", "Required source/provenance metadata is missing.");
  }

  if (!options.profile.primitives[options.entry.primitive]) {
    pushIssue(issues, "UNKNOWN_PRIMITIVE", `Unknown primitive '${options.entry.primitive}'.`);
  }

  if (!isValidUnityPath(options.unityPath)) {
    pushIssue(issues, "INVALID_UNITY_PATH", `Unity path must stay under Assets/: ${options.unityPath}`);
  }

  if (!options.profile.validation.allowedFormats.includes(extension as "png" | "jpg" | "jpeg")) {
    pushIssue(issues, "UNSUPPORTED_FORMAT", `File extension '${extension}' is not supported.`);
  } else if (await exists(options.sourcePath)) {
    try {
      metadata = await readImageMetadata(options.sourcePath);
      if (!options.profile.validation.allowedFormats.includes(metadata.format)) {
        pushIssue(issues, "UNSUPPORTED_FORMAT", `Image format '${metadata.format}' is not supported.`);
      }
      validateDimensions(options.profile, metadata, issues);
      const spriteMode = options.entry.unity.spriteMode ?? options.profile.unity.defaultSpriteMode;
      if (spriteMode === "multiple") {
        const spriteNames = validateSpriteSlicing(options.entry.unity.slicing, metadata, issues);
        if (options.entry.unity.defaultSpriteName && !spriteNames.has(options.entry.unity.defaultSpriteName)) {
          pushIssue(
            issues,
            "INVALID_SPRITE_SLICING",
            `Default sprite '${options.entry.unity.defaultSpriteName}' is not declared in slicing metadata.`,
          );
        }
      } else if (options.entry.unity.slicing) {
        pushIssue(issues, "INVALID_SPRITE_SLICING", "Slicing metadata requires spriteMode 'multiple'.");
      }
    } catch (error) {
      pushIssue(
        issues,
        "DIMENSIONS_UNREADABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const unique = uniqueIssues(issues);
  return {
    status: unique.length === 0 ? "accepted" : "rejected",
    issues: unique,
    metadata,
  };
}

export async function validatePreparedAudio(options: {
  entry: AssetRegistryEntry;
  profile: AssetProfile;
  sourcePath: string;
  unityPath: string;
}): Promise<AssetValidationResult> {
  const issues: AssetValidationIssue[] = [];
  const extension = extensionOf(options.sourcePath);
  const constraints = options.profile.validation.audio;
  let metadata: AudioMetadata | undefined;

  if (!await exists(options.sourcePath)) {
    pushIssue(issues, "MISSING_FILE", `Prepared file does not exist: ${options.sourcePath}`);
  }

  if (!constraints || !constraints.allowedFormats.includes(extension as "wav")) {
    pushIssue(issues, "AUDIO_FORMAT_UNSUPPORTED", `Audio extension '${extension}' is not supported.`);
  }

  if (!options.profile.validation.allowedLicenses.includes(options.entry.license?.spdx ?? "")) {
    pushIssue(issues, "MISSING_LICENSE", `License '${options.entry.license?.spdx ?? ""}' is not allowed.`);
  }

  if (!hasSourceMetadata(options.entry, options.profile)) {
    pushIssue(issues, "MISSING_SOURCE", "Required source/provenance metadata is missing.");
  }

  if (!options.profile.primitives[options.entry.primitive]) {
    pushIssue(issues, "UNKNOWN_PRIMITIVE", `Unknown primitive '${options.entry.primitive}'.`);
  }

  if (!isValidUnityPath(options.unityPath)) {
    pushIssue(issues, "INVALID_UNITY_PATH", `Unity path must stay under Assets/: ${options.unityPath}`);
  }

  if (constraints && extension === "wav" && await exists(options.sourcePath)) {
    try {
      metadata = await readWavMetadata(options.sourcePath);
      if (!constraints.allowedSampleRates.includes(metadata.sampleRate)) {
        pushIssue(issues, "AUDIO_SAMPLE_RATE_UNSUPPORTED", `Sample rate ${metadata.sampleRate} is not allowed.`);
      }
      if (!constraints.allowedChannels.includes(metadata.channels)) {
        pushIssue(issues, "AUDIO_CHANNELS_UNSUPPORTED", `Channel count ${metadata.channels} is not allowed.`);
      }
      if (constraints.allowedBitDepths && !constraints.allowedBitDepths.includes(metadata.bitDepth)) {
        pushIssue(issues, "AUDIO_FORMAT_UNSUPPORTED", `Bit depth ${metadata.bitDepth} is not allowed.`);
      }
      if (metadata.durationMs > constraints.maxDurationMs) {
        pushIssue(issues, "AUDIO_DURATION_TOO_LONG", `Duration ${metadata.durationMs}ms exceeds ${constraints.maxDurationMs}ms.`);
      }
    } catch (error) {
      pushIssue(
        issues,
        "AUDIO_METADATA_UNREADABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const unique = uniqueIssues(issues);
  return {
    status: unique.length === 0 ? "accepted" : "rejected",
    issues: unique,
    metadata,
  };
}

export async function validatePreparedNonImage(options: {
  entry: AssetRegistryEntry;
  profile: AssetProfile;
  sourcePath: string;
  unityPath: string;
}): Promise<AssetValidationResult> {
  const issues: AssetValidationIssue[] = [];
  const extension = extensionOf(options.sourcePath);
  const kind = options.entry.kind ?? "sprite";

  if (!await exists(options.sourcePath)) {
    pushIssue(issues, "MISSING_FILE", `Prepared file does not exist: ${options.sourcePath}`);
  }

  if (!options.profile.validation.allowedLicenses.includes(options.entry.license?.spdx ?? "")) {
    pushIssue(issues, "MISSING_LICENSE", `License '${options.entry.license?.spdx ?? ""}' is not allowed.`);
  }

  if (!hasSourceMetadata(options.entry, options.profile)) {
    pushIssue(issues, "MISSING_SOURCE", "Required source/provenance metadata is missing.");
  }

  const primitive = options.profile.primitives[options.entry.primitive];
  if (!primitive) {
    pushIssue(issues, "UNKNOWN_PRIMITIVE", `Unknown primitive '${options.entry.primitive}'.`);
  } else if (primitive.supportedKinds && !primitive.supportedKinds.includes(kind as AssetKind)) {
    pushIssue(issues, "UNSUPPORTED_KIND", `Primitive '${options.entry.primitive}' does not support kind '${kind}'.`);
  }

  if (!isValidUnityPath(options.unityPath)) {
    pushIssue(issues, "INVALID_UNITY_PATH", `Unity path must stay under Assets/: ${options.unityPath}`);
  }

  if (!options.profile.validation.allowedFormats.includes(extension as "glb" | "svg")) {
    pushIssue(issues, "UNSUPPORTED_FORMAT", `File extension '${extension}' is not supported.`);
  }

  const unique = uniqueIssues(issues);
  return {
    status: unique.length === 0 ? "accepted" : "rejected",
    issues: unique,
  };
}
