#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { AssetPrepareReport, PreparedAsset } from "./types.js";

export interface HandoffConsistencyIssue {
  code:
    | "MISSING_PREPARE_REPORT"
    | "MISSING_VERDICT"
    | "REGISTRY_USAGE_FALSE"
    | "REGISTRY_USAGE_MISSING"
    | "UNKNOWN_VERDICT_ASSET"
    | "MISMATCHED_VERDICT_ASSET_ID"
    | "STALE_REGISTRY_SKIPPED_TEXT";
  path: string;
  message: string;
}

export interface HandoffConsistencyReport {
  status: "pass" | "fail";
  acceptedAssets: number;
  checkedVerdicts: string[];
  checkedTextFiles: string[];
  issues: HandoffConsistencyIssue[];
}

interface VerdictAsset {
  id?: unknown;
  unityPath?: unknown;
}

interface VerdictLike {
  registryAssets?: {
    used?: unknown;
    skipped?: unknown;
    usedByRole?: Record<string, VerdictAsset>;
  };
}

function acceptedAssetsByUnityPath(report: AssetPrepareReport): Map<string, PreparedAsset> {
  const assets = new Map<string, PreparedAsset>();
  for (const asset of report.assets) {
    if (asset.status === "accepted" && asset.unityPath) {
      assets.set(asset.unityPath, asset);
    }
  }
  return assets;
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function verdictIssues(options: {
  verdictPath: string;
  verdict: VerdictLike | undefined;
  accepted: Map<string, PreparedAsset>;
}): HandoffConsistencyIssue[] {
  const issues: HandoffConsistencyIssue[] = [];
  const { verdictPath, verdict, accepted } = options;

  if (!verdict) {
    issues.push({
      code: "MISSING_VERDICT",
      path: verdictPath,
      message: "Expected a verdict file with registryAssets usage metadata.",
    });
    return issues;
  }

  if (accepted.size > 0 && verdict.registryAssets?.used !== true) {
    issues.push({
      code: "REGISTRY_USAGE_FALSE",
      path: verdictPath,
      message: "Prepare report has accepted assets, but verdict does not declare registryAssets.used=true.",
    });
  }

  if (accepted.size > 0 && verdict.registryAssets?.skipped === true) {
    issues.push({
      code: "REGISTRY_USAGE_FALSE",
      path: verdictPath,
      message: "Prepare report has accepted assets, but verdict declares registryAssets.skipped=true.",
    });
  }

  const usedByRole = verdict.registryAssets?.usedByRole ?? {};
  if (accepted.size > 0 && Object.keys(usedByRole).length === 0) {
    issues.push({
      code: "REGISTRY_USAGE_MISSING",
      path: verdictPath,
      message: "Verdict should list registryAssets.usedByRole entries with id and unityPath.",
    });
  }

  for (const [role, asset] of Object.entries(usedByRole)) {
    const unityPath = typeof asset.unityPath === "string" ? asset.unityPath : "";
    const id = typeof asset.id === "string" ? asset.id : "";
    const prepared = accepted.get(unityPath);
    if (!prepared) {
      issues.push({
        code: "UNKNOWN_VERDICT_ASSET",
        path: verdictPath,
        message: `Role ${role} references ${unityPath || "<missing unityPath>"}, which is not an accepted asset in the prepare report.`,
      });
      continue;
    }

    if (prepared.id !== id) {
      issues.push({
        code: "MISMATCHED_VERDICT_ASSET_ID",
        path: verdictPath,
        message: `Role ${role} uses ${unityPath} with id ${id || "<missing id>"}, but the prepare report id is ${prepared.id}.`,
      });
    }
  }

  return issues;
}

function staleTextIssues(filePath: string, text: string | undefined, acceptedCount: number): HandoffConsistencyIssue[] {
  if (!text || acceptedCount === 0) {
    return [];
  }

  const stalePatterns = [
    /registry[^.\n]{0,160}\bskipped\b/i,
    /no project-local registry/i,
    /registry[^.\n]{0,160}\bunavailable\b/i,
    /final visuals use self-authored/i,
    /assets:\s*self-authored procedural/i,
  ];

  if (!stalePatterns.some((pattern) => pattern.test(text))) {
    return [];
  }

  return [{
    code: "STALE_REGISTRY_SKIPPED_TEXT",
    path: filePath,
    message: "Text still claims registry assets were skipped/unavailable or final assets are purely self-authored, but the prepare report has accepted assets.",
  }];
}

export async function checkHandoffConsistency(options: {
  prepareReportPath: string;
  verdictPaths?: string[];
  textPaths?: string[];
}): Promise<HandoffConsistencyReport> {
  const prepareReport = await readJsonFile<AssetPrepareReport>(options.prepareReportPath);
  if (!prepareReport) {
    return {
      status: "fail",
      acceptedAssets: 0,
      checkedVerdicts: [],
      checkedTextFiles: [],
      issues: [{
        code: "MISSING_PREPARE_REPORT",
        path: options.prepareReportPath,
        message: "Prepare report is required before checking registry handoff consistency.",
      }],
    };
  }

  const accepted = acceptedAssetsByUnityPath(prepareReport);
  const verdictPaths = options.verdictPaths ?? [];
  const textPaths = options.textPaths ?? [];
  const issues: HandoffConsistencyIssue[] = [];

  for (const verdictPath of verdictPaths) {
    const verdict = await readJsonFile<VerdictLike>(verdictPath);
    issues.push(...verdictIssues({ verdictPath, verdict, accepted }));
  }

  for (const textPath of textPaths) {
    const text = await readTextIfExists(textPath);
    issues.push(...staleTextIssues(textPath, text, accepted.size));
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    acceptedAssets: accepted.size,
    checkedVerdicts: verdictPaths,
    checkedTextFiles: textPaths,
    issues,
  };
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): {
  prepareReportPath: string;
  verdictPaths: string[];
  textPaths: string[];
  outputPath?: string;
  help: boolean;
} {
  const args = { prepareReportPath: "", verdictPaths: [] as string[], textPaths: [] as string[], outputPath: undefined as string | undefined, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--prepare-report":
        args.prepareReportPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--verdict":
        args.verdictPaths.push(...parseCsv(argv[++i] ?? "").map((item) => path.resolve(process.cwd(), item)));
        break;
      case "--text":
        args.textPaths.push(...parseCsv(argv[++i] ?? "").map((item) => path.resolve(process.cwd(), item)));
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
  if (args.help || !args.prepareReportPath) {
    console.log([
      "Usage: node dist/capabilities/assets/handoff-consistency.js --prepare-report <report.json>",
      "  [--verdict <build-verdict.json>[,<final-verdict.json>]]",
      "  [--text <handoff.md>[,<builder.cs>]] [--output <report.json>]",
    ].join("\n"));
    return args.help ? 0 : 1;
  }

  const report = await checkHandoffConsistency(args);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (report.status === "fail") {
    for (const issue of report.issues) {
      console.error(`[asset-layer] ${issue.code}: ${issue.message}`);
    }
  }
  return report.status === "pass" ? 0 : 1;
}

const isMainModule = process.argv[1]?.endsWith("handoff-consistency.js") || process.argv[1]?.endsWith("handoff-consistency.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[asset-layer] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
