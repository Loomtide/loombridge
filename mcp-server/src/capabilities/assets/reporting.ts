#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AssetChecksum,
  AssetPrepareReport,
  AssetPolicyValidationIssue,
  PreparedAsset,
  PreparedAssetImport,
} from "./types.js";

type CountBucket = { selected: number; accepted: number; rejected: number };

function emptyBucket(): CountBucket {
  return { selected: 0, accepted: 0, rejected: 0 };
}

function sortObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

export async function computeSha256(filePath: string): Promise<AssetChecksum> {
  const bytes = await fs.readFile(filePath);
  return {
    algorithm: "sha256",
    value: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

export function buildPrepareDiagnostics(
  assets: PreparedAsset[],
  validationIssues: AssetPolicyValidationIssue[] = [],
): AssetPrepareReport["diagnostics"] {
  const selected = assets.length;
  const accepted = assets.filter((asset) => asset.status === "accepted").length;
  const rejected = selected - accepted;
  const placeholder = assets.filter((asset) => asset.placeholder).length;
  const cache = { hit: 0, miss: 0, skipped: 0 };
  const byPrimitive: Record<string, CountBucket> = {};
  const byKind: Record<string, CountBucket> = {};

  for (const asset of assets) {
    cache[asset.cacheStatus ?? "skipped"] += 1;

    const primitiveBucket = byPrimitive[asset.primitive] ?? emptyBucket();
    primitiveBucket.selected += 1;
    primitiveBucket[asset.status === "accepted" ? "accepted" : "rejected"] += 1;
    byPrimitive[asset.primitive] = primitiveBucket;

    const kindBucket = byKind[asset.kind] ?? emptyBucket();
    kindBucket.selected += 1;
    kindBucket[asset.status === "accepted" ? "accepted" : "rejected"] += 1;
    byKind[asset.kind] = kindBucket;
  }

  return {
    selected,
    accepted,
    rejected,
    placeholder,
    cache,
    byPrimitive: sortObject(byPrimitive),
    byKind: sortObject(byKind),
    validationIssues: [...validationIssues].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)),
    providerDiagnostics: assets
      .filter((asset) => (asset.providerDiagnostics?.length ?? 0) > 0)
      .map((asset) => ({
        id: asset.id,
        codes: [...(asset.providerDiagnostics?.map((diagnostic) => diagnostic.code) ?? [])].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    acceptedImports: assets
      .filter((asset) => asset.status === "accepted" && asset.import)
      .map((asset) => asset.import as PreparedAssetImport)
      .sort((a, b) => a.toolArguments.path.localeCompare(b.toolArguments.path)) as PreparedAssetImport[],
    rejections: assets
      .filter((asset) => asset.rejections.length > 0)
      .map((asset) => ({ id: asset.id, codes: [...asset.rejections].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function attributionRows(report: AssetPrepareReport): PreparedAsset[] {
  return report.assets
    .filter((asset) => asset.status === "accepted")
    .sort((a, b) => a.source.title.localeCompare(b.source.title) || a.id.localeCompare(b.id));
}

export function renderAttributionMarkdown(report: AssetPrepareReport): string {
  const lines = [
    "# Platformer Asset Attribution",
    "",
    `Registry: ${report.registry.packId}`,
    `Profile: ${report.profile.id}`,
    "",
    "| Asset | Source | Author / Provider | License | Source URL | Attribution Required |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const asset of attributionRows(report)) {
    lines.push([
      asset.id,
      asset.source.title,
      `${asset.source.author} / ${asset.provider.name}`,
      asset.license.name,
      asset.source.url,
      asset.license.requiresAttribution ? "yes" : "no",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

export async function writeAttributionMarkdown(options: {
  reportPath: string;
  outputPath: string;
}): Promise<string> {
  const raw = await fs.readFile(options.reportPath, "utf-8");
  const report = JSON.parse(raw) as AssetPrepareReport;
  const markdown = renderAttributionMarkdown(report);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, markdown);
  return markdown;
}

function parseArgs(argv: string[]): { reportPath: string; outputPath: string; help: boolean } {
  const args = { reportPath: "", outputPath: "", help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--report":
        args.reportPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--output":
        args.outputPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help || !args.reportPath || !args.outputPath) {
    console.log("Usage: node dist/capabilities/assets/reporting.js --report <report.json> --output <attribution.md>");
    return args.help ? 0 : 1;
  }

  await writeAttributionMarkdown(args);
  console.error(`[asset-layer] attribution=${args.outputPath}`);
  return 0;
}

const isMainModule = process.argv[1]?.endsWith("reporting.js") || process.argv[1]?.endsWith("reporting.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[asset-layer] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
