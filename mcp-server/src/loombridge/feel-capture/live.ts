import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeResponse } from "../../types.js";
import type { UnityClient } from "../../unity-client.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  type UnityRoutingMetadata,
} from "../../verification/unity-client-resolver.js";
import { runFeelCaptureContract } from "./run.js";
import type {
  FeelCaptureContract,
  FeelCaptureInteraction,
  FeelCaptureLocator,
  FeelCapturePrecondition,
  FeelCaptureRunResult,
  FeelCaptureSignal,
} from "./types.js";

export interface FeelCaptureLiveClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  waitForReconnect(timeoutMs: number): Promise<boolean>;
  send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponse>;
}

export interface FeelCaptureLiveResolvedClient {
  client: FeelCaptureLiveClient;
  disconnect(): Promise<void>;
  routing?: () => UnityRoutingMetadata;
}

export interface FeelCaptureLiveArgs {
  root?: string;
  contractPath: string;
  outputPath: string;
  artifactsDir?: string;
  project?: string;
  sourceRoot?: string;
  clientFactory?: (project?: string) => FeelCaptureLiveResolvedClient;
}

export interface FeelCaptureLiveResult {
  outputPath: string;
  artifactsDir?: string;
  measurements: FeelCaptureRunResult["measurements"];
  raw: FeelCaptureRunResult["raw"];
  warnings: string[];
  unityRouting?: UnityRoutingMetadata;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function responseData(response: BridgeResponse, command: string): BridgeResponse {
  if (response.status === "error") {
    throw new Error(`${command} failed: ${response.error?.message ?? "unknown bridge error"}`);
  }
  return response;
}

function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost/i.test(message);
}

async function ensureConnected(client: FeelCaptureLiveClient): Promise<void> {
  if (client.isConnected) return;
  if (await client.waitForReconnect(10000)) return;
  await client.connect();
}

async function send(
  client: FeelCaptureLiveClient,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<BridgeResponse> {
  await ensureConnected(client);
  try {
    return responseData(await client.send(command, params, timeoutMs), command);
  } catch (error) {
    if (!isConnectionLoss(error)) throw error;
    await ensureConnected(client);
    return responseData(await client.send(command, params, timeoutMs), command);
  }
}

function defaultClientFactory(project?: string): FeelCaptureLiveResolvedClient {
  const resolved = createUnityClientForCli({ project });
  return {
    client: resolved.client as UnityClient,
    disconnect: () => resolved.disconnect(),
    routing: () => buildUnityRoutingMetadata(resolved),
  };
}

function locatorsFromInteraction(interaction: FeelCaptureInteraction): FeelCaptureLocator[] {
  switch (interaction.kind) {
    case "keyboard":
    case "ugui-tap":
    case "ugui-multitap":
    case "ugui-hold-drag":
    case "ugui-hold":
    case "world-pointer":
      return [
        "measure" in interaction ? interaction.measure : undefined,
        "target" in interaction ? interaction.target : undefined,
        "settle" in interaction ? interaction.settle?.measure : undefined,
        ...(interaction.sampledFields ?? []).map((f) => f.locator),
      ].filter((l): l is FeelCaptureLocator => !!l);
    case "semantic-probe":
      return [
        interaction.measure,
        ...interaction.trials.flatMap((trial) =>
          trial.phases.flatMap((phase) => (phase.drivers ?? []).map((driver) => driver.locator)),
        ),
      ];
    case "trace-replay":
      return (interaction.sampledFields ?? []).map((f) => f.locator);
    case "unsupported":
      return [];
  }
}

function locatorsFromContract(contract: FeelCaptureContract): FeelCaptureLocator[] {
  return [
    ...contract.subjects.map((s) => s.locator),
    ...(contract.preconditions ?? []).map((p) => p.locator),
    ...contract.interactions.flatMap(locatorsFromInteraction),
    ...(contract.signals ?? []).map((s: FeelCaptureSignal) => s.locator),
  ];
}

function scenePathFor(scene: string): string {
  if (scene.endsWith(".unity") || scene.includes("/")) return scene;
  return `Assets/Scenes/${scene}.unity`;
}

function sceneNameForLocator(scene: string): string {
  if (!scene.endsWith(".unity") && !scene.includes("/")) return scene;
  return path.basename(scene, ".unity");
}

function normalizeLocatorScene<T extends FeelCaptureLocator | undefined>(locator: T): T {
  if (!locator?.scene) return locator;
  return { ...locator, scene: sceneNameForLocator(locator.scene) } as T;
}

function normalizeSignalScenes(signal: FeelCaptureSignal): FeelCaptureSignal {
  return { ...signal, locator: normalizeLocatorScene(signal.locator) };
}

function normalizeInteractionScenes(interaction: FeelCaptureInteraction): FeelCaptureInteraction {
  switch (interaction.kind) {
    case "keyboard":
      return {
        ...interaction,
        measure: normalizeLocatorScene(interaction.measure),
        ...(interaction.settle
          ? { settle: { ...interaction.settle, measure: normalizeLocatorScene(interaction.settle.measure) } }
          : {}),
        sampledFields: interaction.sampledFields?.map(normalizeSignalScenes),
      };
    case "ugui-tap":
    case "ugui-multitap":
    case "ugui-hold-drag":
    case "ugui-hold":
      return {
        ...interaction,
        measure: normalizeLocatorScene(interaction.measure),
        target: normalizeLocatorScene(interaction.target),
        ...("settle" in interaction && interaction.settle
          ? { settle: { ...interaction.settle, measure: normalizeLocatorScene(interaction.settle.measure) } }
          : {}),
        sampledFields: interaction.sampledFields?.map(normalizeSignalScenes),
      };
    case "world-pointer":
      return {
        ...interaction,
        measure: normalizeLocatorScene(interaction.measure),
        sampledFields: interaction.sampledFields?.map(normalizeSignalScenes),
      };
    case "trace-replay":
      return {
        ...interaction,
        sampledFields: interaction.sampledFields?.map(normalizeSignalScenes),
      };
    case "semantic-probe":
      return {
        ...interaction,
        measure: normalizeLocatorScene(interaction.measure),
        trials: interaction.trials.map((trial) => ({
          ...trial,
          phases: trial.phases.map((phase) => ({
            ...phase,
            drivers: phase.drivers?.map((driver) => ({
              ...driver,
              locator: normalizeLocatorScene(driver.locator),
            })),
          })),
        })),
      };
    case "unsupported":
      return interaction;
  }
}

function normalizeContractScenesForBridge(contract: FeelCaptureContract): FeelCaptureContract {
  return {
    ...contract,
    subjects: contract.subjects.map((subject) => ({
      ...subject,
      locator: normalizeLocatorScene(subject.locator),
    })),
    preconditions: contract.preconditions?.map((precondition) => ({
      ...precondition,
      locator: normalizeLocatorScene(precondition.locator),
    })),
    interactions: contract.interactions.map(normalizeInteractionScenes),
    signals: contract.signals?.map(normalizeSignalScenes),
  };
}

function hasKeyboardInteractions(contract: FeelCaptureContract): boolean {
  return contract.interactions.some((interaction) => interaction.kind === "keyboard");
}

function sceneNamesFromContract(contract: FeelCaptureContract): string[] {
  return [...new Set(locatorsFromContract(contract).map((l) => l.scene).filter((s): s is string => !!s))];
}

function activeSelfFrom(response: BridgeResponse): boolean | undefined {
  const data = response.data;
  return typeof data === "object"
    && data !== null
    && !Array.isArray(data)
    && typeof (data as Record<string, unknown>).activeSelf === "boolean"
    ? (data as Record<string, unknown>).activeSelf as boolean
    : undefined;
}

function isBareSceneName(scene: string): boolean {
  return !scene.endsWith(".unity") && !scene.includes("/");
}

async function loadedSceneNames(client: FeelCaptureLiveClient): Promise<string[]> {
  const response = await send(client, "scene.get_hierarchy", { depth: 0 }, 30000);
  const data = response.data;
  const scenes = (data as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((s) => (s as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === "string");
}

async function openContractScene(
  contract: FeelCaptureContract,
  client: FeelCaptureLiveClient,
  warnings: string[],
): Promise<void> {
  const scenes = sceneNamesFromContract(contract);
  if (scenes.length === 0) return;
  if (scenes.length > 1) {
    warnings.push(`Contract references multiple scenes (${scenes.join(", ")}); live runner did not auto-open a scene.`);
    return;
  }
  const scene = scenes[0];

  if (isBareSceneName(scene)) {
    // Reuse the loaded scene when it already matches by name. This is the common
    // developer-facing dogfood case (grading the scene you're looking at) AND the only
    // generic way to handle a project whose scenes do NOT live under Assets/Scenes/ —
    // we have no generic asset-path resolver for a bare scene name, so guessing
    // "Assets/Scenes/<name>.unity" used to fail with NOT_FOUND on such projects.
    const loaded = await loadedSceneNames(client);
    const targetName = sceneNameForLocator(scene);
    if (loaded.includes(targetName)) {
      await send(client, "editor.stop", {}, 30000);
      await send(client, "editor.wait_for", { playMode: "stopped", frames: 2, timeoutMs: 30000 }, 35000);
      return;
    }

    // Not loaded. A bare scene name cannot be resolved to an asset path generically,
    // so refuse with an actionable message instead of guessing Assets/Scenes/<name>.unity.
    throw new Error(
      `Scene '${scene}' is not loaded in the editor and cannot be resolved by name. `
        + `Load it in the Unity editor before capture, or set the contract scene to an explicit asset path `
        + `(e.g. "Assets/.../${scene}.unity").`,
    );
  }

  await send(client, "editor.stop", {}, 30000);
  await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
  await send(client, "scene.open_scene", { path: scenePathFor(scene), mode: "Single" }, 30000);
  await send(client, "editor.wait_for", { playMode: "stopped", frames: 2, timeoutMs: 30000 }, 35000);
}

async function applyPreconditions(
  preconditions: FeelCapturePrecondition[] | undefined,
  client: FeelCaptureLiveClient,
  warnings: string[],
): Promise<(() => Promise<void>)[]> {
  const restore: (() => Promise<void>)[] = [];
  for (const precondition of preconditions ?? []) {
    if (precondition.kind !== "scene-set-active") continue;
    let originalActive: boolean | undefined;
    if (precondition.restore !== false) {
      try {
        const snapshot = await send(client, "runtime.get_snapshot", { locator: precondition.locator }, 10000);
        originalActive = activeSelfFrom(snapshot);
      } catch (error) {
        warnings.push(`Could not read active state for ${precondition.locator.path}; restore skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await send(client, "scene.set_active", { locator: precondition.locator, active: precondition.active }, 10000);
    if (originalActive !== undefined) {
      restore.push(async () => {
        await send(client, "scene.set_active", { locator: precondition.locator, active: originalActive }, 10000);
      });
    }
  }
  return restore;
}

export async function runFeelCaptureLive(args: FeelCaptureLiveArgs): Promise<FeelCaptureLiveResult> {
  const contract = await readJson(args.contractPath) as FeelCaptureContract;
  const runtimeContract = normalizeContractScenesForBridge(contract);
  const warnings: string[] = [];
  const resolved = (args.clientFactory ?? defaultClientFactory)(args.project);
  const client = resolved.client;
  let unityRouting: UnityRoutingMetadata | undefined;
  let result: FeelCaptureRunResult | undefined;
  let restorePreconditions: (() => Promise<void>)[] = [];
  let inputSessionStarted = false;

  try {
    await client.connect();
    await openContractScene(contract, client, warnings);
    restorePreconditions = await applyPreconditions(runtimeContract.preconditions, client, warnings);
    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    if (hasKeyboardInteractions(runtimeContract)) {
      try {
        await send(client, "input.begin_session", { backend: "InputSystem" }, 10000);
        inputSessionStarted = true;
      } catch (error) {
        warnings.push(`Failed to begin Input System session for keyboard capture: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    result = await runFeelCaptureContract(
      runtimeContract,
      (command, params, timeoutMs) => send(client, command, params, timeoutMs),
      {
        sourceRoot: args.sourceRoot,
        traceRoot: path.join(args.root ?? path.dirname(args.contractPath), ".loombridge", "replays", "traces"),
        replayCaptureDir: args.artifactsDir ? path.join(args.artifactsDir, "replay") : undefined,
        warn: (message) => warnings.push(message),
      },
    );
    unityRouting = resolved.routing?.();
  } finally {
    if (inputSessionStarted) {
      try {
        await ensureConnected(client);
        await send(client, "input.end_session", {}, 10000);
      } catch (error) {
        warnings.push(`Failed to end Input System session cleanly: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await ensureConnected(client);
      await send(client, "editor.stop", {}, 30000);
      await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
    } catch (error) {
      warnings.push(`Failed to stop Play Mode cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const restore of restorePreconditions.reverse()) {
      try {
        await ensureConnected(client);
        await restore();
      } catch (error) {
        warnings.push(`Failed to restore capture precondition: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await resolved.disconnect();
    } catch (error) {
      warnings.push(`Failed to disconnect Unity client cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!result) {
    throw new Error("capture did not produce a result");
  }

  const measurements = {
    ...result.measurements,
    provenance: {
      ...result.measurements.provenance,
      unityRouting,
      warnings,
    },
  };
  await writeJson(args.outputPath, measurements);

  if (args.artifactsDir) {
    await writeJson(path.join(args.artifactsDir, "capture-contract.json"), contract);
    await writeJson(path.join(args.artifactsDir, "raw-captures.json"), result.raw);
    await writeJson(path.join(args.artifactsDir, "capture-summary.json"), {
      schemaVersion: "1",
      contractPath: args.contractPath,
      measurementsPath: args.outputPath,
      unityRouting,
      warnings,
      captureCoverage: measurements.captureCoverage ?? [],
      measuredMetrics: Object.keys(measurements.metrics ?? {}),
    });
  }

  return {
    outputPath: args.outputPath,
    artifactsDir: args.artifactsDir,
    measurements,
    raw: result.raw,
    warnings,
    unityRouting,
  };
}
