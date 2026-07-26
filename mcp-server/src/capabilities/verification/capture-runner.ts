#!/usr/bin/env node
/**
 * One-shot verification capture runner.
 *
 * Backend-only script: it composes existing Unity bridge operations,
 * runtime.capture_sequence, frame analysis, and run-gates. It deliberately does
 * not define any /loombridge command UX.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { UnityClient } from "../../bridge/unity-client.js";
import type { BridgeResponse } from "../../shared/types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  UNITY_PROJECT_ENV_VAR,
} from "../../bridge/unity-client-resolver.js";
import { analyzeVisualArtifactFrames, readPng, type NamedFrame } from "./analyze-frames.js";
import type { RenderFrameInput, RenderFrameSample } from "./gates/render-frame.js";
import { runGates } from "./run-gates.js";
import { assertValidAcceptanceContract } from "./validator.js";
import type { AcceptanceContract } from "./types.js";
import { scenarioPacks } from "../genre/genre-registry.js";
import { packageRoot } from "../../shared/pkg-root.js";
import {
  assertValidVerificationScenario,
  getVerificationResetPolicy,
  type VerificationCapture,
  type VerificationScenario,
  type VerificationSequence,
} from "./scenario.js";

export interface CaptureRunnerArgs {
  acceptancePath: string;
  scenarioPath?: string;
  outDir: string;
  project?: string;
}

export interface CaptureRunnerOutputPlan {
  outDir: string;
  framesDir: string;
  captureSequencePath: string;
  visualArtifactsPath: string;
  renderFramePath: string;
  screenRectsPath: string;
  runtimeAssertionsPath: string;
  consolePath: string;
  buildVerdictPath: string;
  fixListPath: string;
  summaryPath: string;
}

interface CapturedFrame {
  id: string;
  image_base64?: string;
  format?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface WrittenFrame {
  id: string;
  path: string;
  width?: number;
  height?: number;
}

type PngImage = Awaited<ReturnType<typeof readPng>>;

interface SendOptions {
  retryOnConnectionLoss?: boolean;
}

export interface SelectedScenarioPack {
  id: string;
  gameKind: string;
  path: string;
}

export interface FixListItem {
  gate: string;
  checkId: string;
  status: "fail" | "warn";
  detail: string;
  suggestedNextAction?: string;
}

export interface FixList {
  status: string;
  items: FixListItem[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/capabilities/verification/capture-runner.js \\",
      "  --acceptance <acceptance.json> \\",
      "  [--scenario <verification-scenario.json>] \\",
      "  --out <trace/verify> \\",
      "  [--project <projectPathCanonical|projectName>]",
      "",
      `When --project is omitted, ${UNITY_PROJECT_ENV_VAR} is honored before single-editor auto-selection.`,
      "When --scenario is omitted, the runner chooses a bundled verification/scenarios pack from the acceptance contract.",
      "Writes frames, capture-sequence.json, visual-artifacts.json, console.json, and build-verdict.json under --out.",
    ].join("\n"),
  );
}

export function parseCaptureRunnerArgs(argv: string[]): CaptureRunnerArgs {
  let acceptancePath = "";
  let scenarioPath = "";
  let outDir = "";
  let project = "";

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--acceptance") {
      acceptancePath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--scenario") {
      scenarioPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--out") {
      outDir = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--project") {
      project = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!acceptancePath) throw new Error("Missing required --acceptance <path>.");
  if (!outDir) throw new Error("Missing required --out <dir>.");

  return {
    acceptancePath: path.resolve(process.cwd(), acceptancePath),
    ...(scenarioPath ? { scenarioPath: path.resolve(process.cwd(), scenarioPath) } : {}),
    outDir: path.resolve(process.cwd(), outDir),
    ...(project ? { project } : {}),
  };
}

export function planCaptureRunnerOutputs(outDir: string): CaptureRunnerOutputPlan {
  const resolved = path.resolve(process.cwd(), outDir);
  return {
    outDir: resolved,
    framesDir: path.join(resolved, "frames"),
    captureSequencePath: path.join(resolved, "capture-sequence.json"),
    visualArtifactsPath: path.join(resolved, "visual-artifacts.json"),
    renderFramePath: path.join(resolved, "render-frame.json"),
    screenRectsPath: path.join(resolved, "screen-rects.json"),
    runtimeAssertionsPath: path.join(resolved, "runtime-assertions.json"),
    consolePath: path.join(resolved, "console.json"),
    buildVerdictPath: path.join(resolved, "build-verdict.json"),
    fixListPath: path.join(resolved, "fix-list.json"),
    summaryPath: path.join(resolved, "verification-summary.md"),
  };
}

function scenarioPackPath(fileName: string): string {
  const sourceDir = path.join(
    packageRoot(import.meta.url),
    "src",
    "capabilities",
    "verification",
    "scenarios",
  );
  return path.join(sourceDir, fileName);
}

export function knownScenarioPacks(): Array<{ id: string; gameKind: string }> {
  return scenarioPacks().map((pack) => ({ id: pack.id, gameKind: pack.gameKind }));
}

export function selectScenarioPack(acceptance: AcceptanceContract): SelectedScenarioPack {
  const pack = scenarioPacks().find((candidate) => candidate.matches(acceptance));
  if (!pack) {
    const known = knownScenarioPacks()
      .map((candidate) => `${candidate.id} (${candidate.gameKind})`)
      .join(", ");
    throw new Error(
      `No bundled verification scenario pack matches acceptance game '${acceptance.game}'. ` +
        `Known packs: ${known || "(none)"}. Pass --scenario <path> to use a project-specific scenario.`,
    );
  }
  return { id: pack.id, gameKind: pack.gameKind, path: scenarioPackPath(pack.fileName) };
}

export function resolveScenarioPath(args: CaptureRunnerArgs, acceptance: AcceptanceContract): string {
  return args.scenarioPath ?? selectScenarioPack(acceptance).path;
}

function sanitizeFrameId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "frame";
}

function normalizeFormat(format: unknown): "png" | "jpeg" {
  return format === "jpeg" ? "jpeg" : "png";
}

function namespacedFrameId(sequenceId: string, capture: CapturedFrame): string {
  const raw = typeof capture.id === "string" && capture.id.trim() ? capture.id.trim() : "frame";
  return raw.includes(":") ? raw : `${sequenceId}:${raw}`;
}

export function buildCaptureSequenceParams(
  scenario: VerificationScenario,
  sequence: VerificationSequence,
): Record<string, unknown> {
  const driver = sequence.driver ?? (
    scenario.driverDefaults?.locator &&
    scenario.driverDefaults.type_name &&
    scenario.driverDefaults.property_path
      ? {
          locator: scenario.driverDefaults.locator,
          type_name: scenario.driverDefaults.type_name,
          property_path: scenario.driverDefaults.property_path,
        }
      : undefined
  );

  return {
    measure: scenario.measure,
    ...(driver ? { driver } : {}),
    phases: sequence.phases,
    captures: sequence.captures,
    captureFps: sequence.captureFps ?? 120,
    includeSamples: sequence.includeSamples ?? false,
    resetDriversOnEnd: sequence.resetDriversOnEnd ?? true,
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function responseData(response: BridgeResponse, command: string): unknown {
  if (response.status === "error") {
    throw new Error(`${command} failed: ${response.error?.message ?? "unknown bridge error"}`);
  }
  return response.data;
}

function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost/i.test(message);
}

async function ensureConnected(client: UnityClient): Promise<void> {
  if (client.isConnected) return;
  if (await client.waitForReconnect(10000)) return;
  await client.connect();
}

async function send(
  client: UnityClient,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
  options: SendOptions = {},
): Promise<unknown> {
  const retryOnConnectionLoss = options.retryOnConnectionLoss ?? true;
  await ensureConnected(client);

  try {
    return responseData(await client.send(command, params, timeoutMs), command);
  } catch (error) {
    if (!retryOnConnectionLoss || !isConnectionLoss(error)) {
      throw error;
    }
    await ensureConnected(client);
    return responseData(await client.send(command, params, timeoutMs), command);
  }
}

async function applyResetPolicy(
  client: UnityClient,
  scenario: VerificationScenario,
  warnings: string[],
): Promise<void> {
  const reset = getVerificationResetPolicy(scenario);
  if (reset.type === "none") return;

  if (reset.type === "reload-scene") {
    if (!reset.scenePath) {
      warnings.push("resetPolicy reload-scene has no scenePath; reset skipped.");
      return;
    }
    await send(client, "editor.stop", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
    await send(client, "scene.open_scene", { path: reset.scenePath, mode: "Single" }, 30000);
    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    return;
  }

  if (reset.resetOperation) {
    await send(client, reset.resetOperation.command, reset.resetOperation.params ?? {}, reset.resetOperation.timeoutMs);
    await send(client, "editor.wait_for", { frames: 2, timeoutMs: 5000 }, 10000);
    return;
  }

  const message =
    "resetPolicy spawn-before-sequence has no resetOperation; running from current Play Mode state.";
  if (reset.warningOnly) {
    warnings.push(message);
    return;
  }
  throw new Error(`${message} Add playMode.resetPolicy.resetOperation or use resetPolicy none.`);
}

function captureListForSequence(sequence: VerificationSequence): VerificationCapture[] {
  return sequence.captures;
}

/**
 * The distinct driver `property_path`s a scenario drives — across `driverDefaults`,
 * each sequence's `driver`, and any per-phase drivers. Used to point a failed run at
 * the exact PlayerController fields the project must expose.
 */
export function collectScenarioDriverProps(scenario: VerificationScenario): string[] {
  const props = new Set<string>();
  if (scenario.driverDefaults?.property_path) props.add(scenario.driverDefaults.property_path);
  for (const sequence of scenario.sequences) {
    if (sequence.driver?.property_path) props.add(sequence.driver.property_path);
    for (const phase of sequence.phases) {
      for (const driver of phase.drivers ?? []) {
        if (driver.property_path) props.add(driver.property_path);
      }
    }
  }
  return [...props];
}

function isLocatorResolutionFailure(message: string): boolean {
  return /could not resolve locator|resolve locator|locator .*not found|no .*found for locator/i.test(message);
}

/**
 * If a capture failed because the scenario's player locator/driver did not resolve in the
 * running scene, rethrow with actionable guidance (the RUN-1 failure was a bare
 * `Could not resolve locator {scene:"Game",path:"/Player"}` with no next step). Any other
 * error passes through unchanged.
 */
export function augmentCaptureFailure(error: unknown, scenario: VerificationScenario): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!isLocatorResolutionFailure(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  const playerLocator = JSON.stringify(scenario.measure ?? scenario.driverDefaults?.locator ?? {});
  const driverProps = collectScenarioDriverProps(scenario);
  const driverList = driverProps.length > 0 ? driverProps.join(", ") : "(none)";
  const hint = [
    message,
    `[capture-runner] scenario '${scenario.id}' could not drive the player in the running scene. Likely causes:`,
    `  - Scene name: the locator ${playerLocator} may name a scene that isn't the one in Play Mode. This scenario omits "scene" so it resolves against the ACTIVE scene; if you re-added a "scene" field, set it to the built scene's name.`,
    `  - Player path: the built player object may not sit at "${scenario.measure?.path ?? "/Player"}". Confirm the player GameObject's hierarchy path.`,
    `  - Driver props: this scenario drives [${driverList}]; the project's PlayerController must expose these public fields. The skills' canonical drivers are forceHorizontal/forceJump/forceDash (see game-polish-2d/references/feel-mechanics.md).`,
    `Pass --scenario <path> to use a project-specific scenario instead of the bundled pack.`,
  ].join("\n");
  return new Error(hint);
}

export async function decodeCapturedFrames(args: {
  sequenceId: string;
  result: unknown;
  framesDir: string;
}): Promise<WrittenFrame[]> {
  const result = args.result as { frames?: CapturedFrame[] };
  const frames = Array.isArray(result.frames) ? result.frames : [];
  const written: WrittenFrame[] = [];
  await fs.mkdir(args.framesDir, { recursive: true });

  for (const frame of frames) {
    if (typeof frame.image_base64 !== "string" || frame.image_base64.length === 0) {
      continue;
    }
    const id = namespacedFrameId(args.sequenceId, frame);
    const format = normalizeFormat(frame.format);
    const filename = `${sanitizeFrameId(id)}.${format === "jpeg" ? "jpg" : "png"}`;
    const absPath = path.join(args.framesDir, filename);
    await fs.writeFile(absPath, Buffer.from(frame.image_base64, "base64"));
    written.push({ id, path: absPath, width: frame.width, height: frame.height });
  }

  return written;
}

export function redactCaptureSequenceResult(args: {
  sequenceId: string;
  result: unknown;
  frames: Array<{ id: string; path: string; width?: number; height?: number }>;
}): unknown {
  if (typeof args.result !== "object" || args.result === null || Array.isArray(args.result)) {
    return args.result;
  }

  const source = args.result as { frames?: CapturedFrame[]; [key: string]: unknown };
  const framePathById = new Map(args.frames.map((frame) => [frame.id, frame]));
  const redactedFrames = Array.isArray(source.frames)
    ? source.frames.map((frame) => {
        const id = namespacedFrameId(args.sequenceId, frame);
        const decoded = framePathById.get(id);
        const { image_base64: _imageBase64, ...metadata } = frame;
        return {
          ...metadata,
          id,
          path: decoded?.path,
          width: decoded?.width ?? frame.width,
          height: decoded?.height ?? frame.height,
        };
      })
    : [];

  return {
    ...source,
    frames: redactedFrames,
  };
}

async function analyzeFrames(
  scenario: VerificationScenario,
  frames: Array<{ id: string; path: string }>,
): Promise<unknown> {
  if (frames.length < 2) {
    return {
      frames: frames.map((frame) => ({ id: frame.id, longLines: [], bands: [] })),
      comparisons: [],
    };
  }

  const baselineId = scenario.analysis?.baselineFrameId;
  const baselineMeta =
    frames.find((frame) => frame.id === baselineId || frame.id.endsWith(`:${baselineId}`)) ?? frames[0]!;
  const stressMeta = frames.filter((frame) => frame !== baselineMeta && frame.path.endsWith(".png"));
  if (!baselineMeta.path.endsWith(".png") || stressMeta.length === 0) {
    return {
      frames: frames.map((frame) => ({ id: frame.id, longLines: [], bands: [] })),
      comparisons: [],
    };
  }

  const baseline: NamedFrame = {
    id: baselineMeta.id,
    path: baselineMeta.path,
    image: await readPng(baselineMeta.path),
  };
  const stressFrames: NamedFrame[] = [];
  for (const frame of stressMeta) {
    stressFrames.push({ id: frame.id, path: frame.path, image: await readPng(frame.path) });
  }

  return analyzeVisualArtifactFrames(baseline, stressFrames, {
    stableTopFraction: scenario.analysis?.stableTopFraction,
    stableBottomFraction: scenario.analysis?.stableBottomFraction,
    minLineFraction: scenario.analysis?.minLineFraction,
    darkLumaThreshold: scenario.analysis?.darkLumaThreshold,
  });
}

function relativeFrameList(outDir: string, frames: Array<{ id: string; path: string }>): Array<{ id: string; path: string }> {
  return frames.map((frame) => ({ id: frame.id, path: path.relative(outDir, frame.path) }));
}

function lumaAt(image: PngImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4;
  return image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722;
}

function isBlackPixel(image: PngImage, x: number, y: number): boolean {
  const index = (y * image.width + x) * 4;
  const alpha = image.data[index + 3];
  return alpha > 0 && lumaAt(image, x, y) <= 12;
}

function borderLineLength(args: {
  image: PngImage;
  maxLines: number;
  lineLength: number;
  sample: (line: number, offset: number) => { x: number; y: number };
  predicate: (image: PngImage, x: number, y: number) => boolean;
  minCoverage: number;
}): number {
  for (let line = 0; line < args.maxLines; line += 1) {
    let hits = 0;
    for (let offset = 0; offset < args.lineLength; offset += 1) {
      const { x, y } = args.sample(line, offset);
      if (args.predicate(args.image, x, y)) hits += 1;
    }
    if (hits / args.lineLength < args.minCoverage) return line;
  }
  return args.maxLines;
}

function analyzeRenderFrameImage(id: string, image: PngImage): RenderFrameSample {
  const maxVertical = Math.floor(image.height / 2);
  const maxHorizontal = Math.floor(image.width / 2);
  const blackTop = borderLineLength({
    image,
    maxLines: maxVertical,
    lineLength: image.width,
    sample: (line, x) => ({ x, y: line }),
    predicate: isBlackPixel,
    minCoverage: 0.98,
  });
  const blackBottom = borderLineLength({
    image,
    maxLines: maxVertical,
    lineLength: image.width,
    sample: (line, x) => ({ x, y: image.height - 1 - line }),
    predicate: isBlackPixel,
    minCoverage: 0.98,
  });
  const blackLeft = borderLineLength({
    image,
    maxLines: maxHorizontal,
    lineLength: image.height,
    sample: (line, y) => ({ x: line, y }),
    predicate: isBlackPixel,
    minCoverage: 0.98,
  });
  const blackRight = borderLineLength({
    image,
    maxLines: maxHorizontal,
    lineLength: image.height,
    sample: (line, y) => ({ x: image.width - 1 - line, y }),
    predicate: isBlackPixel,
    minCoverage: 0.98,
  });
  // Uniform in-game regions such as skies or floors are valid content. Phase C
  // only emits the low-risk black/clear-bar measurement; richer uniform-border
  // classification needs mask/context support before it can be a hard signal.
  const uniformTop = 0;
  const uniformBottom = 0;
  const uniformLeft = 0;
  const uniformRight = 0;

  const left = Math.max(blackLeft, uniformLeft);
  const right = Math.max(blackRight, uniformRight);
  const top = Math.max(blackTop, uniformTop);
  const bottom = Math.max(blackBottom, uniformBottom);

  return {
    id,
    width: image.width,
    height: image.height,
    edgeBlackFraction: {
      top: blackTop / image.height,
      right: blackRight / image.width,
      bottom: blackBottom / image.height,
      left: blackLeft / image.width,
    },
    uniformBorderFraction: {
      top: uniformTop / image.height,
      right: uniformRight / image.width,
      bottom: uniformBottom / image.height,
      left: uniformLeft / image.width,
    },
    contentRect: {
      x: left,
      y: top,
      width: Math.max(0, image.width - left - right),
      height: Math.max(0, image.height - top - bottom),
    },
  };
}

export async function analyzeRenderFrames(frames: Array<{ id: string; path: string }>): Promise<RenderFrameInput> {
  const samples: RenderFrameSample[] = [];
  for (const frame of frames) {
    if (!frame.path.endsWith(".png")) continue;
    samples.push(analyzeRenderFrameImage(frame.id, await readPng(frame.path)));
  }
  return { frames: samples };
}

export function buildScreenRectsParams(scenario: VerificationScenario): Record<string, unknown> | null {
  const locators = scenario.collect?.screenRects;
  if (!locators || locators.length === 0) return null;
  return {
    locators,
    ...(scenario.collect?.screenRectCamera ? { camera: scenario.collect.screenRectCamera } : {}),
    ...(scenario.collect?.screenRectBoundsMode ? { boundsMode: scenario.collect.screenRectBoundsMode } : {}),
  };
}

async function collectRuntimeAssertions(
  client: UnityClient,
  scenario: VerificationScenario,
  warnings: string[],
): Promise<{ assertions: Array<Record<string, unknown>> }> {
  const assertions = scenario.collect?.runtimeAssertions ?? [];
  const results: Array<Record<string, unknown>> = [];
  for (const assertion of assertions) {
    const { id, timeoutMs, ...params } = assertion;
    try {
      results.push({
        id,
        ok: true,
        result: await send(client, "runtime.assert_condition", params, timeoutMs ?? 10000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`runtime assertion '${id}' failed to collect: ${message}`);
      results.push({
        id,
        ok: false,
        error: message,
      });
    }
  }
  return { assertions: results };
}

export function renderVerificationSummary(args: {
  scenario: VerificationScenario;
  frameCount: number;
  warnings: string[];
  verdictStatus: string;
  fixList: FixList;
}): string {
  const lines = [
    `# Verification Summary`,
    "",
    `- scenario: ${args.scenario.id}`,
    `- gameKind: ${args.scenario.gameKind}`,
    `- frames: ${args.frameCount}`,
    `- status: ${args.verdictStatus}`,
  ];
  if (args.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...args.warnings.map((warning) => `- ${warning}`));
  }
  if (args.fixList.items.length > 0) {
    lines.push("", "## Fix List", "");
    for (const item of args.fixList.items) {
      const next = item.suggestedNextAction ? ` Next: ${item.suggestedNextAction}` : "";
      lines.push(`- [${item.status}] ${item.gate}/${item.checkId}: ${item.detail}${next}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeSummary(args: {
  outputPath: string;
  scenario: VerificationScenario;
  frameCount: number;
  warnings: string[];
  verdictStatus: string;
  fixList: FixList;
}): Promise<void> {
  await fs.writeFile(args.outputPath, renderVerificationSummary(args), "utf-8");
}

function oneLine(value: string, maxLength = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function inferGateForCheck(checkId: string): string {
  if (checkId.startsWith("render-frame.")) return "render-frame";
  if (checkId.startsWith("manifest.")) return "manifest";
  if (
    checkId.startsWith("ui.") ||
    checkId.startsWith("font.") ||
    checkId.startsWith("color.") ||
    checkId.startsWith("presence.")
  ) {
    return "ui-conformance";
  }
  if (checkId.startsWith("anchor.") || checkId.startsWith("clip.")) return "framing";
  if (checkId.startsWith("coverage.")) return "coverage";
  if (checkId.startsWith("visual-artifacts.")) return "visual-artifacts";
  if (checkId.startsWith("reachability.")) return "reachability";
  if (checkId.startsWith("placement.")) return "placement";
  if (checkId.startsWith("platform-tiles.")) return "platform-tiles";
  if (checkId.startsWith("tile-render.")) return "tile-render";
  if (checkId.startsWith("prop-purpose.") || checkId.startsWith("prop.")) return "prop-purpose";
  if (checkId.startsWith("playability.")) return "playability";
  if (checkId.startsWith("feel.")) return "feel";
  if (checkId.startsWith("feel-provenance.")) return "feel-provenance";
  if (checkId.startsWith("physics-timestep.")) return "physics-timestep";
  if (checkId.startsWith("console.")) return "console-clean";
  if (checkId.startsWith("frame-integrity.")) return "frame-integrity";
  const dot = checkId.indexOf(".");
  return dot > 0 ? checkId.slice(0, dot) : "unknown";
}

function suggestNextAction(detail: string): string | undefined {
  const lower = detail.toLowerCase();
  if (lower.includes("no \"") && lower.includes(" in --inputs")) {
    return "Capture the missing gate input under the runner's --out directory (.loombridge/verify/<state>/ in the canonical flow) and rerun.";
  }
  if (lower.includes("boxed") || lower.includes("letterbox") || lower.includes("black margins")) {
    return "Fix the camera/Game-view viewport fill, or declare intentional letterbox in the contract.";
  }
  if (lower.includes("font")) {
    return "Update the UI font to match the contract, or revise the contract if the new font is intentional.";
  }
  if (lower.includes("color") || lower.includes("palette")) {
    return "Align the UI/world color with the acceptance palette, or revise the contract if intentional.";
  }
  if (lower.includes("console") || lower.includes("error") || lower.includes("exception")) {
    return "Inspect console.json, fix runtime/editor errors, then rerun verification.";
  }
  if (lower.includes("fully inside") || lower.includes("clipped") || lower.includes("off-screen")) {
    return "Adjust placement or camera framing so required objects remain visible.";
  }
  if (lower.includes("tile") || lower.includes("cap")) {
    return "Rebuild terrain with the expected tile/collider structure for this genre.";
  }
  return undefined;
}

export function buildFixList(
  verdict: {
    status: string;
    failures?: Array<{ id: string; detail: string; status: string }>;
    warnings?: Array<{ id: string; detail: string; status: string }>;
  },
  limit = 10,
): FixList {
  const candidates = [...(verdict.failures ?? []), ...(verdict.warnings ?? [])]
    .filter((check) => check.status === "fail" || check.status === "warn")
    .slice(0, limit);

  return {
    status: verdict.status,
    items: candidates.map((check) => {
      const detail = oneLine(check.detail);
      const suggestedNextAction = suggestNextAction(detail);
      return {
        gate: inferGateForCheck(check.id),
        checkId: check.id,
        status: check.status as "fail" | "warn",
        detail,
        ...(suggestedNextAction ? { suggestedNextAction } : {}),
      };
    }),
  };
}

export async function runCaptureRunner(args: CaptureRunnerArgs): Promise<number> {
  const outputs = planCaptureRunnerOutputs(args.outDir);
  const acceptance = assertValidAcceptanceContract(await readJson(args.acceptancePath));
  const scenarioPath = resolveScenarioPath(args, acceptance as AcceptanceContract);
  const scenario = assertValidVerificationScenario(await readJson(scenarioPath));
  const warnings: string[] = [];
  const resolvedClient = createUnityClientForCli({ project: args.project });
  const client = resolvedClient.client;
  const sequenceResults: Array<{ sequenceId: string; requestedCaptures: VerificationCapture[]; result: unknown }> = [];
  const writtenFrames: WrittenFrame[] = [];
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = buildUnityRoutingMetadata(resolvedClient);

  await fs.mkdir(outputs.framesDir, { recursive: true });

  try {
    await client.connect();
    await send(client, "editor.clear_console", {}, 10000);
    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);

    for (const sequence of scenario.sequences) {
      await applyResetPolicy(client, scenario, warnings);
      let result: unknown;
      try {
        result = await send(
          client,
          "runtime.capture_sequence",
          buildCaptureSequenceParams(scenario, sequence),
          90000,
          { retryOnConnectionLoss: false },
        );
      } catch (error) {
        throw augmentCaptureFailure(error, scenario);
      }
      const sequenceFrames = await decodeCapturedFrames({
        sequenceId: sequence.id,
        result,
        framesDir: outputs.framesDir,
      });
      writtenFrames.push(...sequenceFrames);
      const relativeSequenceFrames = relativeFrameList(outputs.outDir, sequenceFrames);
      sequenceResults.push({
        sequenceId: sequence.id,
        requestedCaptures: captureListForSequence(sequence),
        result: redactCaptureSequenceResult({
          sequenceId: sequence.id,
          result,
          frames: relativeSequenceFrames,
        }),
      });
    }

    const screenRectsParams = buildScreenRectsParams(scenario);
    if (screenRectsParams) {
      try {
        await writeJson(outputs.screenRectsPath, await send(client, "scene.get_screen_rects", screenRectsParams, 30000));
      } catch (error) {
        warnings.push(
          `screen-rect collection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if ((scenario.collect?.runtimeAssertions ?? []).length > 0) {
      await writeJson(outputs.runtimeAssertionsPath, await collectRuntimeAssertions(client, scenario, warnings));
    }

    if (scenario.collect?.console !== false) {
      await writeJson(outputs.consolePath, await send(client, "editor.console_logs", { count: 200 }, 10000));
    }
    unityRouting = buildUnityRoutingMetadata(resolvedClient);
  } finally {
    try {
      try {
        await ensureConnected(client);
        await send(client, "editor.stop", {}, 30000);
        await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
      } catch (error) {
        warnings.push(`Failed to stop Play Mode cleanly: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      await resolvedClient.disconnect();
    }
  }

  await writeJson(outputs.captureSequencePath, {
    scenarioId: scenario.id,
    unityRouting,
    frames: relativeFrameList(outputs.outDir, writtenFrames),
    sequences: sequenceResults,
    warnings,
  });
  await writeJson(outputs.visualArtifactsPath, await analyzeFrames(scenario, writtenFrames));
  await writeJson(outputs.renderFramePath, await analyzeRenderFrames(writtenFrames));

  const verdict = await runGates({
    acceptance: acceptance as AcceptanceContract,
    inputsDir: outputs.outDir,
  });
  const fixList = buildFixList(verdict);
  await writeJson(outputs.buildVerdictPath, verdict);
  await writeJson(outputs.fixListPath, fixList);
  await writeSummary({
    outputPath: outputs.summaryPath,
    scenario,
    frameCount: writtenFrames.length,
    warnings,
    verdictStatus: verdict.status,
    fixList,
  });

  console.error(
    `[capture-runner] scenario=${scenario.id} frames=${writtenFrames.length} status=${verdict.status} out=${outputs.outDir}`,
  );
  return verdict.status === "fail" ? 1 : 0;
}

async function main(): Promise<number> {
  try {
    return await runCaptureRunner(parseCaptureRunnerArgs(process.argv));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capture-runner] fatal: ${message}`);
    printUsage();
    return 1;
  }
}

const isMainModule =
  process.argv[1]?.endsWith("capture-runner.js") || process.argv[1]?.endsWith("capture-runner.ts");
if (isMainModule) {
  main().then((code) => {
    process.exitCode = code;
  });
}
