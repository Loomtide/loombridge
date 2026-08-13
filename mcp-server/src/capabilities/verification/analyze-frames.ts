#!/usr/bin/env node
/**
 * Screenshot analyzer for the visual-artifacts gate.
 *
 * This deliberately stays dependency-free so agents can run it in clean MCP
 * installs. It handles Unity screenshot PNGs, compares a baseline frame against
 * action/stress frames, and emits classified `visual-artifacts.json` findings
 * instead of raw edge dumps.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

import type { VisualArtifactsInput } from "./gates/visual-artifacts.js";
import { isMainModule as isMainModuleUrl } from "../../shared/main-module.js";

interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface NamedFrame {
  id: string;
  path: string;
  image: RgbaImage;
}

export interface AnalyzeFrameOptions {
  /** Exclude the HUD/top chrome band from generic seam search. */
  stableTopFraction?: number;
  /** Stop before terrain/gameplay geometry dominates the frame. */
  stableBottomFraction?: number;
  /** Minimum width/height coverage for a visual line finding. */
  minLineFraction?: number;
  /** Rows at or below this luminance are treated as camera-clear/dark seams. */
  darkLumaThreshold?: number;
  /** Maximum per-row channel std-dev for a suspicious uniform row. */
  uniformStdDevThreshold?: number;
  /** Pixel RGB distance needed to count as changed against the baseline. */
  changedPixelDistance?: number;
  /** Minimum changed-pixel ratio against baseline for state-specific artifacts. */
  minChangedRowFraction?: number;
  /** Minimum row-to-row luma/std jump for a full-width seam boundary. */
  minTransitionDelta?: number;
}

interface RowMetrics {
  y: number;
  avgLuma: number;
  stdDev: number;
  darkRunFraction: number;
  changedFraction: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const DEFAULT_OPTIONS: Required<AnalyzeFrameOptions> = {
  stableTopFraction: 0.12,
  stableBottomFraction: 0.68,
  minLineFraction: 0.85,
  darkLumaThreshold: 42,
  uniformStdDevThreshold: 10,
  changedPixelDistance: 26,
  minChangedRowFraction: 0.45,
  minTransitionDelta: 22,
};

function usage(): string {
  return [
    "Usage: node dist/capabilities/verification/analyze-frames.js \\",
    "  --baseline-id spawn --baseline frames/spawn.png \\",
    "  --stress-id jump --stress frames/jump.png \\",
    "  --output .artifacts/verify/visual-artifacts.json",
    "",
    "Multiple stress frames are supported by repeating --stress-id/--stress.",
    "Optional: --stable-top-fraction 0.12 --stable-bottom-fraction 0.68 --min-line-fraction 0.85",
  ].join("\n");
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function bytesPerPixel(colorType: number, bitDepth: number): number {
  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth}; expected 8-bit screenshots.`);
  }
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`Unsupported PNG color type ${colorType}; expected grayscale/RGB/RGBA.`);
  }
}

export async function readPng(pathname: string): Promise<RgbaImage> {
  const buffer = await fs.readFile(pathname);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${pathname} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      const compression = data[10] ?? -1;
      const filter = data[11] ?? -1;
      const interlace = data[12] ?? -1;
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error(`${pathname} uses unsupported PNG encoding settings.`);
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0 || idat.length === 0) {
    throw new Error(`${pathname} is missing PNG IHDR/IDAT data.`);
  }

  const bpp = bytesPerPixel(colorType, bitDepth);
  const stride = width * bpp;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = new Uint8Array(height * stride);
  let src = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[src++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = inflated[src++];
      const left = x >= bpp ? raw[rowStart + x - bpp] ?? 0 : 0;
      const up = y > 0 ? raw[prevStart + x] ?? 0 : 0;
      const upLeft = y > 0 && x >= bpp ? raw[prevStart + x - bpp] ?? 0 : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + Math.floor((left + up) / 2);
          break;
        case 4:
          value = rawByte + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`${pathname} uses unsupported PNG row filter ${filterType}.`);
      }
      raw[rowStart + x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, out = 0; i < raw.length; i += bpp, out += 4) {
    if (colorType === 0) {
      const g = raw[i] ?? 0;
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    } else if (colorType === 2) {
      rgba[out] = raw[i] ?? 0;
      rgba[out + 1] = raw[i + 1] ?? 0;
      rgba[out + 2] = raw[i + 2] ?? 0;
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const g = raw[i] ?? 0;
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = raw[i + 1] ?? 255;
    } else {
      rgba[out] = raw[i] ?? 0;
      rgba[out + 1] = raw[i + 1] ?? 0;
      rgba[out + 2] = raw[i + 2] ?? 0;
      rgba[out + 3] = raw[i + 3] ?? 255;
    }
  }

  return { width, height, data: rgba };
}

function pixelOffset(image: RgbaImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

function lumaAt(image: RgbaImage, x: number, y: number): number {
  const i = pixelOffset(image, x, y);
  const r = image.data[i] ?? 0;
  const g = image.data[i + 1] ?? 0;
  const b = image.data[i + 2] ?? 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbDistance(a: RgbaImage, b: RgbaImage, x: number, y: number): number {
  const ia = pixelOffset(a, x, y);
  const ib = pixelOffset(b, x, y);
  const dr = (a.data[ia] ?? 0) - (b.data[ib] ?? 0);
  const dg = (a.data[ia + 1] ?? 0) - (b.data[ib + 1] ?? 0);
  const db = (a.data[ia + 2] ?? 0) - (b.data[ib + 2] ?? 0);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rowMetrics(frame: RgbaImage, baseline: RgbaImage | undefined, y: number, options: Required<AnalyzeFrameOptions>): RowMetrics {
  let sum = 0;
  let sumSquares = 0;
  let longestDarkRun = 0;
  let currentDarkRun = 0;
  let changed = 0;

  for (let x = 0; x < frame.width; x += 1) {
    const luma = lumaAt(frame, x, y);
    sum += luma;
    sumSquares += luma * luma;
    if (luma <= options.darkLumaThreshold) {
      currentDarkRun += 1;
      longestDarkRun = Math.max(longestDarkRun, currentDarkRun);
    } else {
      currentDarkRun = 0;
    }
    if (
      baseline &&
      baseline.width === frame.width &&
      baseline.height === frame.height &&
      rgbDistance(frame, baseline, x, y) >= options.changedPixelDistance
    ) {
      changed += 1;
    }
  }

  const avg = sum / frame.width;
  const variance = Math.max(0, sumSquares / frame.width - avg * avg);
  return {
    y,
    avgLuma: avg,
    stdDev: Math.sqrt(variance),
    darkRunFraction: longestDarkRun / frame.width,
    changedFraction: baseline ? changed / frame.width : 1,
  };
}

function isSuspiciousRow(metrics: RowMetrics, baselineMetrics: RowMetrics | undefined, options: Required<AnalyzeFrameOptions>): boolean {
  const hasLongDarkUniformRun =
    metrics.darkRunFraction >= options.minLineFraction &&
    metrics.stdDev <= options.uniformStdDevThreshold;
  if (!hasLongDarkUniformRun) return false;

  if (!baselineMetrics) return true;
  const baselineAlreadyHadSameLine =
    baselineMetrics.darkRunFraction >= options.minLineFraction &&
    baselineMetrics.stdDev <= options.uniformStdDevThreshold;

  return !baselineAlreadyHadSameLine && metrics.changedFraction >= options.minChangedRowFraction;
}

function transitionDelta(a: RowMetrics, b: RowMetrics): number {
  return Math.abs(a.avgLuma - b.avgLuma) + Math.abs(a.stdDev - b.stdDev);
}

function isSuspiciousTransition(
  upper: RowMetrics,
  lower: RowMetrics,
  baselineUpper: RowMetrics | undefined,
  baselineLower: RowMetrics | undefined,
  options: Required<AnalyzeFrameOptions>,
): boolean {
  const upperUniformDark =
    upper.darkRunFraction >= options.minLineFraction &&
    upper.stdDev <= options.uniformStdDevThreshold;
  const lowerUniformDark =
    lower.darkRunFraction >= options.minLineFraction &&
    lower.stdDev <= options.uniformStdDevThreshold;
  if (!upperUniformDark && !lowerUniformDark) return false;

  const delta = transitionDelta(upper, lower);
  if (delta < options.minTransitionDelta) return false;

  if (!baselineUpper || !baselineLower) return true;
  const baselineDelta = transitionDelta(baselineUpper, baselineLower);
  return delta - baselineDelta >= options.minTransitionDelta * 0.5;
}

function stableRange(height: number, options: Required<AnalyzeFrameOptions>): { startY: number; endY: number } {
  const startY = Math.max(0, Math.floor(height * options.stableTopFraction));
  const endY = Math.min(height - 1, Math.ceil(height * options.stableBottomFraction));
  return { startY, endY };
}

function stableRegionChangeFraction(frame: RgbaImage, baseline: RgbaImage | undefined, options: Required<AnalyzeFrameOptions>): number | undefined {
  if (!baseline || baseline.width !== frame.width || baseline.height !== frame.height) return undefined;
  const { startY, endY } = stableRange(frame.height, options);
  let changed = 0;
  let total = 0;
  for (let y = startY; y <= endY; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      total += 1;
      if (rgbDistance(frame, baseline, x, y) >= options.changedPixelDistance) {
        changed += 1;
      }
    }
  }
  return total === 0 ? 0 : changed / total;
}

function detectFrameArtifacts(id: string, frame: RgbaImage, baseline: RgbaImage | undefined, options: Required<AnalyzeFrameOptions>): NonNullable<VisualArtifactsInput["frames"]>[number] {
  const { startY, endY } = stableRange(frame.height, options);
  const suspicious: RowMetrics[] = [];
  const metricByY = new Map<number, RowMetrics>();
  const baselineMetricByY = new Map<number, RowMetrics>();

  const getMetrics = (image: RgbaImage, cache: Map<number, RowMetrics>, y: number, comparison?: RgbaImage): RowMetrics => {
    const cached = cache.get(y);
    if (cached) return cached;
    const computed = rowMetrics(image, comparison, y, options);
    cache.set(y, computed);
    return computed;
  };

  for (let y = startY; y <= endY; y += 1) {
    const metrics = getMetrics(frame, metricByY, y, baseline);
    const baseMetrics =
      baseline && baseline.width === frame.width && baseline.height === frame.height
        ? getMetrics(baseline, baselineMetricByY, y)
        : undefined;
    if (isSuspiciousRow(metrics, baseMetrics, options)) {
      suspicious.push(metrics);
    }
  }

  for (let y = startY; y < endY; y += 1) {
    const upper = getMetrics(frame, metricByY, y, baseline);
    const lower = getMetrics(frame, metricByY, y + 1, baseline);
    const baseUpper =
      baseline && baseline.width === frame.width && baseline.height === frame.height
        ? getMetrics(baseline, baselineMetricByY, y)
        : undefined;
    const baseLower =
      baseline && baseline.width === frame.width && baseline.height === frame.height
        ? getMetrics(baseline, baselineMetricByY, y + 1)
        : undefined;
    if (isSuspiciousTransition(upper, lower, baseUpper, baseLower, options)) {
      suspicious.push(upper.darkRunFraction >= lower.darkRunFraction ? upper : lower);
    }
  }

  suspicious.sort((a, b) => a.y - b.y);
  for (let i = suspicious.length - 1; i > 0; i -= 1) {
    if (suspicious[i]!.y === suspicious[i - 1]!.y) {
      suspicious.splice(i, 1);
    }
  }

  const longLines: NonNullable<VisualArtifactsInput["frames"]>[number]["longLines"] = [];
  const bands: NonNullable<VisualArtifactsInput["frames"]>[number]["bands"] = [];
  let index = 0;
  while (index < suspicious.length) {
    const start = suspicious[index]!;
    let end = start;
    while (index + 1 < suspicious.length && suspicious[index + 1]!.y === end.y + 1) {
      index += 1;
      end = suspicious[index]!;
    }
    const group = suspicious.filter((row) => row.y >= start.y && row.y <= end.y);
    const strongest = group.reduce((best, row) => (row.darkRunFraction > best.darkRunFraction ? row : best), start);
    const thickness = end.y - start.y + 1;
    const y = Math.round((start.y + end.y) / 2);
    if (thickness <= 8) {
      longLines?.push({
        orientation: "horizontal",
        lengthFraction: strongest.darkRunFraction,
        classification: "background_seam",
        y,
        thicknessPx: thickness,
        contrast: Number(strongest.changedFraction.toFixed(3)),
        note: `Detected dark uniform row in stable background region (${start.y}-${end.y}); absent from baseline.`,
      });
    } else {
      bands?.push({
        orientation: "horizontal",
        coverageFraction: strongest.darkRunFraction,
        classification: "render_band",
        thicknessFraction: Number((thickness / frame.height).toFixed(4)),
        note: `Detected dark uniform band in stable background region (${start.y}-${end.y}); absent from baseline.`,
      });
    }
    index += 1;
  }

  return { id, longLines, bands };
}

export function analyzeVisualArtifactFrames(baseline: NamedFrame, stressFrames: NamedFrame[], rawOptions: AnalyzeFrameOptions = {}): VisualArtifactsInput {
  const options: Required<AnalyzeFrameOptions> = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(rawOptions) as Array<[keyof AnalyzeFrameOptions, number | undefined]>) {
    if (value !== undefined) {
      options[key] = value;
    }
  }
  const frames: NonNullable<VisualArtifactsInput["frames"]> = [
    { id: baseline.id, longLines: [], bands: [] },
  ];
  const comparisons: NonNullable<VisualArtifactsInput["comparisons"]> = [];

  for (const frame of stressFrames) {
    const analyzed = detectFrameArtifacts(frame.id, frame.image, baseline.image, options);
    frames.push(analyzed);
    const change = stableRegionChangeFraction(frame.image, baseline.image, options);
    comparisons.push({
      from: baseline.id,
      to: frame.id,
      movedLine:
        (analyzed.longLines ?? []).some((line) => line.classification === "background_seam") ||
        (analyzed.bands ?? []).some((band) => band.classification === "render_band" || band.classification === "background_seam"),
      stableRegionChangeFraction: change !== undefined ? Number(change.toFixed(4)) : undefined,
    });
  }

  return { frames, comparisons };
}

interface CliArgs {
  baselineId: string;
  baselinePath?: string;
  stress: Array<{ id: string; path: string }>;
  outputPath?: string;
  options: AnalyzeFrameOptions;
}

function parseNumberFlag(name: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`Missing value for ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${name}: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    baselineId: "spawn",
    stress: [],
    options: {},
  };
  let pendingStressId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--baseline-id":
        args.baselineId = argv[++i] ?? args.baselineId;
        break;
      case "--baseline":
        args.baselinePath = argv[++i];
        break;
      case "--stress-id":
        pendingStressId = argv[++i];
        break;
      case "--stress": {
        const stressPath = argv[++i];
        if (!stressPath) throw new Error("Missing value for --stress");
        args.stress.push({ id: pendingStressId ?? `stress-${args.stress.length + 1}`, path: stressPath });
        pendingStressId = undefined;
        break;
      }
      case "--output":
        args.outputPath = argv[++i];
        break;
      case "--stable-top-fraction":
        args.options.stableTopFraction = parseNumberFlag(arg, argv[++i]);
        break;
      case "--stable-bottom-fraction":
        args.options.stableBottomFraction = parseNumberFlag(arg, argv[++i]);
        break;
      case "--min-line-fraction":
        args.options.minLineFraction = parseNumberFlag(arg, argv[++i]);
        break;
      case "--dark-luma-threshold":
        args.options.darkLumaThreshold = parseNumberFlag(arg, argv[++i]);
        break;
      case "--help":
      case "-h":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!args.baselinePath) throw new Error(`Missing --baseline\n${usage()}`);
  if (args.stress.length === 0) throw new Error(`Missing at least one --stress frame\n${usage()}`);
  if (!args.outputPath) throw new Error(`Missing --output\n${usage()}`);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseline: NamedFrame = {
    id: args.baselineId,
    path: args.baselinePath!,
    image: await readPng(args.baselinePath!),
  };
  const stressFrames: NamedFrame[] = [];
  for (const item of args.stress) {
    stressFrames.push({ id: item.id, path: item.path, image: await readPng(item.path) });
  }

  const output = analyzeVisualArtifactFrames(baseline, stressFrames, args.options);
  await fs.mkdir(path.dirname(args.outputPath!), { recursive: true });
  await fs.writeFile(args.outputPath!, `${JSON.stringify(output, null, 2)}\n`);

  const findingCount =
    output.frames?.reduce((total, frame) => total + (frame.longLines?.length ?? 0) + (frame.bands?.length ?? 0), 0) ?? 0;
  console.log(`[analyze-frames] wrote ${args.outputPath} (${findingCount} visual finding${findingCount === 1 ? "" : "s"})`);
}

const invokedAsCli =   isMainModuleUrl(import.meta.url);

if (invokedAsCli) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[analyze-frames] ${message}`);
    process.exit(1);
  });
}
