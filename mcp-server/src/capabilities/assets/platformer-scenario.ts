#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ScenarioDocument, ScenarioStep, ScenarioToolCallStep } from "../scenario/types.js";
import type { AssetPrepareReport, PreparedAsset } from "./types.js";

interface PlatformerScenarioTemplate {
  schemaVersion: "1";
  name: string;
  description: string;
  baseScenario: string;
  scenePath: string;
  solidSpriteStepIds: string[];
  spriteAssignments: Record<string, string>;
  includeBackground?: boolean;
}

const fallbackTileSurfaceSizes: Record<string, { x: number; y: number }> = {
  "/Ground": { x: 18, y: 0.5 },
  "/Platform1": { x: 3, y: 0.35 },
  "/Platform2": { x: 3, y: 0.35 },
  "/Platform3": { x: 3, y: 0.35 },
};

const tileSurfaceLayout: Record<string, { minWidth: number; rows: number }> = {
  "/Ground": { minWidth: 18, rows: 2 },
  "/Platform1": { minWidth: 3, rows: 1 },
  "/Platform2": { minWidth: 3, rows: 1 },
  "/Platform3": { minWidth: 3, rows: 1 },
};

export interface GeneratePlatformerAssetScenarioOptions {
  reportPath: string;
  templatePath: string;
  outputPath: string;
}

interface CliArgs extends GeneratePlatformerAssetScenarioOptions {
  help: boolean;
}

function printUsage(): void {
  console.log(
    "Usage: node dist/asset-layer/platformer-scenario.js --report <platformer-assets.json> --template <template.json> --output <scenario.json>",
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    reportPath: "../demo/.artifacts/platformer-assets.json",
    templatePath: "../demo/scenarios/build-platformer-with-assets.template.json",
    outputPath: "../demo/scenarios/build-platformer-with-assets.json",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--report":
        args.reportPath = path.resolve(process.cwd(), argv[++i] ?? args.reportPath);
        break;
      case "--template":
        args.templatePath = path.resolve(process.cwd(), argv[++i] ?? args.templatePath);
        break;
      case "--output":
        args.outputPath = path.resolve(process.cwd(), argv[++i] ?? args.outputPath);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.reportPath = path.resolve(process.cwd(), args.reportPath);
  args.templatePath = path.resolve(process.cwd(), args.templatePath);
  args.outputPath = path.resolve(process.cwd(), args.outputPath);
  return args;
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

function isToolCall(step: ScenarioStep): step is ScenarioToolCallStep {
  return step.kind === "tool_call";
}

function acceptedAssetsByPrimitive(report: AssetPrepareReport): Map<string, PreparedAsset> {
  const assets = new Map<string, PreparedAsset>();
  for (const asset of report.assets) {
    if (asset.status === "accepted" && !assets.has(asset.primitive)) {
      assets.set(asset.primitive, asset);
    }
  }
  return assets;
}

function createImportStep(asset: PreparedAsset): ScenarioToolCallStep {
  if (!asset.import) {
    throw new Error(`Asset '${asset.id}' does not have a Unity sprite import plan.`);
  }

  return {
    id: `import-asset-${asset.primitive}`,
    name: `Import ${asset.primitive} asset`,
    kind: "tool_call",
    tool: "unity_asset_create_sprite",
    arguments: { ...asset.import.toolArguments },
  };
}

function createBackgroundSteps(background: PreparedAsset): ScenarioStep[] {
  return [
    {
      id: "create-backdrop",
      name: "Create Backdrop",
      kind: "tool_call",
      tool: "unity_scene_create_object",
      arguments: {
        name: "Backdrop",
        position: { x: 0, y: 0.5, z: 2 },
        scale: { x: 18, y: 9, z: 1 },
      },
    },
    {
      id: "backdrop-renderer",
      name: "Backdrop SpriteRenderer",
      kind: "tool_call",
      tool: "unity_component_add",
      arguments: { locator: { path: "/Backdrop" }, type_name: "SpriteRenderer" },
    },
    {
      id: "backdrop-sorting",
      name: "Backdrop sorting order",
      kind: "tool_call",
      tool: "unity_component_set_property",
      arguments: {
        locator: { path: "/Backdrop" },
        type_name: "SpriteRenderer",
        property_path: "sortingOrder",
        value: -10,
      },
    },
    {
      id: "backdrop-assign",
      name: "Assign background sprite to Backdrop",
      kind: "tool_call",
      tool: "unity_asset_assign_sprite",
      arguments: {
        locator: { path: "/Backdrop" },
        sprite_path: background.unityPath,
      },
    },
  ];
}

function isTileSurfaceAssignStep(step: ScenarioToolCallStep): string | undefined {
  if (step.tool !== "unity_asset_assign_sprite") {
    return undefined;
  }

  const locator = step.arguments?.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return undefined;
  }

  const pathValue = (locator as { path?: unknown }).path;
  return typeof pathValue === "string" && fallbackTileSurfaceSizes[pathValue] ? pathValue : undefined;
}

function roundWorldSize(value: number): number {
  return Number(value.toFixed(4));
}

function tileWorldSize(tileAsset: PreparedAsset | undefined): { x: number; y: number } | undefined {
  const importArgs = tileAsset?.import?.toolArguments;
  const slicing = importArgs?.slicing;
  const pixelsPerUnit = importArgs?.pixels_per_unit ?? 100;
  if (!slicing || pixelsPerUnit <= 0) {
    return undefined;
  }

  if (slicing.mode === "grid") {
    return {
      x: slicing.cell.width / pixelsPerUnit,
      y: slicing.cell.height / pixelsPerUnit,
    };
  }

  const defaultSpriteName = importArgs?.default_sprite_name;
  const sprite = slicing.sprites.find((candidate) => !defaultSpriteName || candidate.name === defaultSpriteName);
  if (!sprite) {
    return undefined;
  }

  return {
    x: sprite.rect.width / pixelsPerUnit,
    y: sprite.rect.height / pixelsPerUnit,
  };
}

function tileAlignedSurfaceSize(locatorPath: string, tileAsset: PreparedAsset | undefined): { x: number; y: number } | undefined {
  const fallback = fallbackTileSurfaceSizes[locatorPath];
  if (!fallback) {
    return undefined;
  }

  const tileSize = tileWorldSize(tileAsset);
  const layout = tileSurfaceLayout[locatorPath];
  if (!tileSize || !layout) {
    return fallback;
  }

  return {
    x: roundWorldSize(Math.ceil(layout.minWidth / tileSize.x) * tileSize.x),
    y: roundWorldSize(layout.rows * tileSize.y),
  };
}

function tileSurfaceSizingSteps(locatorPath: string, tileAsset: PreparedAsset | undefined): ScenarioStep[] {
  const size = tileAlignedSurfaceSize(locatorPath, tileAsset);
  if (!size) {
    return [];
  }

  const idPrefix = locatorPath.replace(/^\//, "").toLowerCase();
  const locator = { path: locatorPath };
  return [
    {
      id: `${idPrefix}-renderer-tiled`,
      name: `${locatorPath.slice(1)} SpriteRenderer tiled draw mode`,
      kind: "tool_call",
      tool: "unity_component_set_property",
      arguments: {
        locator,
        type_name: "SpriteRenderer",
        property_path: "m_DrawMode",
        value: "Tiled",
      },
    },
    {
      id: `${idPrefix}-renderer-size`,
      name: `${locatorPath.slice(1)} SpriteRenderer tile surface size`,
      kind: "tool_call",
      tool: "unity_component_set_property",
      arguments: {
        locator,
        type_name: "SpriteRenderer",
        property_path: "m_Size",
        value: size,
      },
    },
    {
      id: `${idPrefix}-collider-size`,
      name: `${locatorPath.slice(1)} BoxCollider2D tile surface size`,
      kind: "tool_call",
      tool: "unity_component_set_property",
      arguments: {
        locator,
        type_name: "BoxCollider2D",
        property_path: "m_Size",
        value: size,
      },
    },
  ];
}

function rewriteStep(
  step: ScenarioStep,
  template: PlatformerScenarioTemplate,
  assetsByPrimitive: Map<string, PreparedAsset>,
): ScenarioStep {
  const rewritten = structuredClone(step) as ScenarioStep;
  if (!isToolCall(rewritten)) {
    return rewritten;
  }

  if (rewritten.tool === "unity_asset_assign_sprite") {
    const spritePath = rewritten.arguments?.sprite_path;
    if (typeof spritePath === "string") {
      const primitive = template.spriteAssignments[spritePath];
      const asset = primitive ? assetsByPrimitive.get(primitive) : undefined;
      if (asset) {
        const defaultSpriteName = asset.import?.toolArguments.default_sprite_name;
        rewritten.arguments = {
          ...rewritten.arguments,
          sprite_path: asset.unityPath,
          ...(defaultSpriteName ? { sprite_name: defaultSpriteName } : {}),
        };
      }
    }
  }

  if (rewritten.tool === "unity_scene_create_object" && typeof rewritten.arguments?.name === "string") {
    const locatorPath = `/${rewritten.arguments.name}`;
    if (fallbackTileSurfaceSizes[locatorPath]) {
      rewritten.arguments = {
        ...rewritten.arguments,
        scale: { x: 1, y: 1, z: 1 },
      };
    }
  }

  if (rewritten.id === "save-scene") {
    rewritten.arguments = {
      ...rewritten.arguments,
      path: template.scenePath,
    };
  }

  return rewritten;
}

export async function generatePlatformerAssetScenario(
  options: GeneratePlatformerAssetScenarioOptions,
): Promise<ScenarioDocument> {
  const template = await readJson<PlatformerScenarioTemplate>(options.templatePath);
  const report = await readJson<AssetPrepareReport>(options.reportPath);
  if (report.status !== "pass") {
    throw new Error(`Prepared asset report is not usable: status=${report.status}`);
  }

  const baseScenarioPath = path.resolve(path.dirname(options.templatePath), template.baseScenario);
  const baseScenario = await readJson<ScenarioDocument>(baseScenarioPath);
  const assetsByPrimitive = acceptedAssetsByPrimitive(report);
  const tileAsset = assetsByPrimitive.get("tile");
  const importAssets = report.assets.filter((asset) => asset.status === "accepted" && asset.kind === "sprite" && asset.import);
  const importSteps = importAssets.map(createImportStep);
  const background = template.includeBackground ? assetsByPrimitive.get("background") : undefined;
  const solidSpriteStepIds = new Set(template.solidSpriteStepIds);
  const steps: ScenarioStep[] = [];
  let insertedImports = false;

  for (const step of baseScenario.steps) {
    if (solidSpriteStepIds.has(step.id)) {
      if (!insertedImports) {
        steps.push(...importSteps);
        if (background) {
          steps.push(...createBackgroundSteps(background));
        }
        insertedImports = true;
      }
      continue;
    }

    steps.push(rewriteStep(step, template, assetsByPrimitive));
    const rewrittenStep = steps[steps.length - 1];
    if (rewrittenStep && isToolCall(rewrittenStep)) {
      const tileSurfacePath = isTileSurfaceAssignStep(rewrittenStep);
      if (tileSurfacePath) {
        steps.push(...tileSurfaceSizingSteps(tileSurfacePath, tileAsset));
      }
    }
  }

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: template.name,
    description: template.description,
    steps,
  };

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, `${JSON.stringify(scenario, null, 2)}\n`);
  return scenario;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const scenario = await generatePlatformerAssetScenario(args);
  console.error(`[asset-layer] scenario=${scenario.name} steps=${scenario.steps.length} output=${args.outputPath}`);
  return 0;
}

const isMainModule = process.argv[1]?.endsWith("platformer-scenario.js") || process.argv[1]?.endsWith("platformer-scenario.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[asset-layer] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
