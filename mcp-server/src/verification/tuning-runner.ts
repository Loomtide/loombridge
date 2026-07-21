#!/usr/bin/env node
/**
 * Backend-only live Play Mode tuning runner.
 *
 * This is not a /loomtide command. It is a reusable verification primitive that
 * tries serialized candidate values while Unity stays in Play Mode, measures
 * each trial, and emits a compact report the caller can use before persisting
 * the chosen value in Edit Mode.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { UnityClient } from "../unity-client.js";
import type { BridgeResponse, EntityLocator } from "../types.js";
import type { NumericTarget, ToleranceBand, AcceptanceContract } from "./types.js";
import { assertValidAcceptanceContract } from "./validator.js";
import { bandWindow } from "./gates/feel.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  type UnityRoutingMetadata,
} from "./unity-client-resolver.js";

export type TuningTrialStatus = "pass" | "warn" | "fail";

export interface TuningMutation {
  locator: EntityLocator;
  type_name: string;
  property_path: string;
}

export interface TuningMeasurementRecipe {
  /** Currently supported live measurement op. Kept explicit for future recipes. */
  command?: "runtime.measure_motion";
  /** Params passed to the measurement op, usually { locator, durationMs, captureFps }. */
  params: Record<string, unknown>;
  /** Dot path in the op result. Defaults from metricId when omitted. */
  resultPath?: string;
  timeoutMs?: number;
}

export interface TuningOperation {
  command: TuningOperationCommand;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface TuningResetPolicy {
  beforeEach?: TuningOperation;
  waitFramesAfterReset?: number;
  waitFramesAfterSet?: number;
}

export interface TuningReplayPolicy {
  /** Operations that drive/replay the action after the candidate is applied and before measurement starts. */
  beforeMeasure?: TuningOperation[];
  waitFramesAfterReplay?: number;
}

export interface TuningSessionConfig {
  schemaVersion?: "1";
  id: string;
  metricId: string;
  mutation: TuningMutation;
  candidates: number[];
  measurement: TuningMeasurementRecipe;
  reset?: TuningResetPolicy;
  replay?: TuningReplayPolicy;
  /** Optional override when the acceptance contract does not define this metric. */
  target?: NumericTarget;
}

export interface TuningConfigIssue {
  code: string;
  path: string;
  message: string;
}

export interface TuningValidationResult {
  valid: boolean;
  issues: TuningConfigIssue[];
}

export interface TuningTrialResult {
  candidateValue: number;
  measuredValue?: number;
  errorFromTarget?: number;
  status: TuningTrialStatus;
  notes?: string[];
  error?: string;
}

export interface TuningTrialsReport {
  sessionId: string;
  metricId: string;
  target?: number;
  unit?: string;
  band?: ToleranceBand;
  trials: TuningTrialResult[];
  bestCandidate?: TuningTrialResult;
  warnings?: string[];
  unityRouting?: UnityRoutingMetadata;
  recommendation: string;
}

export interface TuningRunnerArgs {
  acceptancePath: string;
  configPath: string;
  outPath: string;
  project?: string;
}

interface SendOptions {
  retryOnConnectionLoss?: boolean;
}

const ALLOWED_TUNING_OPERATION_COMMANDS = new Set([
  "component.set_property",
  "editor.wait_for",
  "runtime.assert_condition",
  "runtime.wait_for_condition",
  "runtime.probe",
  "runtime.capture_sequence",
  "scene.set_transform",
] as const);

export type TuningOperationCommand = typeof ALLOWED_TUNING_OPERATION_COMMANDS extends Set<infer Command>
  ? Command
  : never;

function pushIssue(issues: TuningConfigIssue[], code: string, pathName: string, message: string): void {
  issues.push({ code, path: pathName, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateLocator(value: unknown, pathName: string, issues: TuningConfigIssue[]): void {
  if (!isRecord(value)) {
    pushIssue(issues, "INVALID_LOCATOR", pathName, `${pathName} must be a locator object.`);
    return;
  }
  if (
    !isString(value.path) &&
    !isString(value.name) &&
    !isString(value.globalObjectId) &&
    !isString(value.instanceId) &&
    !isFiniteNumber(value.instanceId)
  ) {
    pushIssue(
      issues,
      "INVALID_LOCATOR",
      pathName,
      `${pathName} must include path, name, globalObjectId, or instanceId.`,
    );
  }
}

function validateOperation(value: unknown, pathName: string, issues: TuningConfigIssue[]): void {
  if (!isRecord(value)) {
    pushIssue(issues, "INVALID_OPERATION", pathName, `${pathName} must be an operation object.`);
    return;
  }
  if (!isString(value.command)) {
    pushIssue(issues, "MISSING_FIELD", `${pathName}.command`, `${pathName}.command is required.`);
  } else if (!ALLOWED_TUNING_OPERATION_COMMANDS.has(value.command as TuningOperationCommand)) {
    pushIssue(
      issues,
      "UNSUPPORTED_OPERATION",
      `${pathName}.command`,
      `${pathName}.command must be one of: ${Array.from(ALLOWED_TUNING_OPERATION_COMMANDS).join(", ")}.`,
    );
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    pushIssue(issues, "INVALID_OPERATION", `${pathName}.params`, `${pathName}.params must be an object.`);
  }
  if (value.timeoutMs !== undefined && (!isFiniteNumber(value.timeoutMs) || value.timeoutMs < 1)) {
    pushIssue(
      issues,
      "INVALID_OPERATION",
      `${pathName}.timeoutMs`,
      `${pathName}.timeoutMs must be a positive number.`,
    );
  }
}

export function validateTuningSessionConfig(input: unknown): TuningValidationResult {
  const issues: TuningConfigIssue[] = [];

  if (!isRecord(input)) {
    pushIssue(issues, "INVALID_DOCUMENT", "config", "Tuning config must be an object.");
    return { valid: false, issues };
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== "1") {
    pushIssue(issues, "INVALID_SCHEMA_VERSION", "schemaVersion", "schemaVersion must be '1'.");
  }
  if (!isString(input.id)) pushIssue(issues, "MISSING_FIELD", "id", "id is required.");
  if (!isString(input.metricId)) pushIssue(issues, "MISSING_FIELD", "metricId", "metricId is required.");

  if (!isRecord(input.mutation)) {
    pushIssue(issues, "MISSING_FIELD", "mutation", "mutation is required.");
  } else {
    validateLocator(input.mutation.locator, "mutation.locator", issues);
    if (!isString(input.mutation.type_name)) {
      pushIssue(issues, "MISSING_FIELD", "mutation.type_name", "mutation.type_name is required.");
    }
    if (!isString(input.mutation.property_path)) {
      pushIssue(issues, "MISSING_FIELD", "mutation.property_path", "mutation.property_path is required.");
    }
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    pushIssue(issues, "MISSING_FIELD", "candidates", "candidates must be a non-empty number array.");
  } else {
    input.candidates.forEach((candidate, index) => {
      if (!isFiniteNumber(candidate)) {
        pushIssue(issues, "INVALID_CANDIDATE", `candidates[${index}]`, `candidates[${index}] must be a finite number.`);
      }
    });
  }

  if (!isRecord(input.measurement)) {
    pushIssue(issues, "MISSING_FIELD", "measurement", "measurement is required.");
  } else {
    if (
      input.measurement.command !== undefined &&
      input.measurement.command !== "runtime.measure_motion"
    ) {
      pushIssue(
        issues,
        "UNSUPPORTED_MEASUREMENT",
        "measurement.command",
        "Only runtime.measure_motion is supported in this tuning slice.",
      );
    }
    if (!isRecord(input.measurement.params)) {
      pushIssue(issues, "MISSING_FIELD", "measurement.params", "measurement.params is required.");
    } else {
      validateLocator(input.measurement.params.locator, "measurement.params.locator", issues);
    }
    if (input.measurement.resultPath !== undefined && !isString(input.measurement.resultPath)) {
      pushIssue(issues, "INVALID_MEASUREMENT", "measurement.resultPath", "measurement.resultPath must be a string.");
    }
    if (
      input.measurement.timeoutMs !== undefined &&
      (!isFiniteNumber(input.measurement.timeoutMs) || input.measurement.timeoutMs < 1)
    ) {
      pushIssue(
        issues,
        "INVALID_MEASUREMENT",
        "measurement.timeoutMs",
        "measurement.timeoutMs must be a positive number.",
      );
    }
  }

  if (input.reset !== undefined) {
    if (!isRecord(input.reset)) {
      pushIssue(issues, "INVALID_RESET", "reset", "reset must be an object.");
    } else {
      if (input.reset.beforeEach !== undefined) {
        validateOperation(input.reset.beforeEach, "reset.beforeEach", issues);
      }
      for (const key of ["waitFramesAfterReset", "waitFramesAfterSet"]) {
        if (input.reset[key] !== undefined && (!isFiniteNumber(input.reset[key]) || input.reset[key] < 0)) {
          pushIssue(issues, "INVALID_RESET", `reset.${key}`, `reset.${key} must be a non-negative number.`);
        }
      }
    }
  }

  if (input.replay !== undefined) {
    if (!isRecord(input.replay)) {
      pushIssue(issues, "INVALID_REPLAY", "replay", "replay must be an object.");
    } else {
      if (input.replay.beforeMeasure !== undefined) {
        if (!Array.isArray(input.replay.beforeMeasure)) {
          pushIssue(
            issues,
            "INVALID_REPLAY",
            "replay.beforeMeasure",
            "replay.beforeMeasure must be an operation array.",
          );
        } else {
          input.replay.beforeMeasure.forEach((operation, index) => {
            validateOperation(operation, `replay.beforeMeasure[${index}]`, issues);
          });
        }
      }
      if (
        input.replay.waitFramesAfterReplay !== undefined &&
        (!isFiniteNumber(input.replay.waitFramesAfterReplay) || input.replay.waitFramesAfterReplay < 0)
      ) {
        pushIssue(
          issues,
          "INVALID_REPLAY",
          "replay.waitFramesAfterReplay",
          "replay.waitFramesAfterReplay must be a non-negative number.",
        );
      }
    }
  }

  if (input.target !== undefined) {
    if (!isRecord(input.target)) {
      pushIssue(issues, "INVALID_TARGET", "target", "target must be an object.");
    } else {
      if (!isFiniteNumber(input.target.target)) {
        pushIssue(issues, "INVALID_TARGET", "target.target", "target.target must be a finite number.");
      }
      if (!isString(input.target.unit)) {
        pushIssue(issues, "INVALID_TARGET", "target.unit", "target.unit is required.");
      }
      if (input.target.band !== undefined) {
        if (!isRecord(input.target.band)) {
          pushIssue(issues, "INVALID_TARGET", "target.band", "target.band must be an object.");
        } else {
          if (input.target.band.percent !== undefined && (!isFiniteNumber(input.target.band.percent) || input.target.band.percent < 0)) {
            pushIssue(issues, "INVALID_TARGET", "target.band.percent", "target.band.percent must be non-negative.");
          }
          if (input.target.band.abs !== undefined && (!isFiniteNumber(input.target.band.abs) || input.target.band.abs < 0)) {
            pushIssue(issues, "INVALID_TARGET", "target.band.abs", "target.band.abs must be non-negative.");
          }
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidTuningSessionConfig(input: unknown): TuningSessionConfig {
  const result = validateTuningSessionConfig(input);
  if (!result.valid) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid tuning config: ${detail}`);
  }
  return input as TuningSessionConfig;
}

export function getMetricTarget(
  acceptance: Pick<AcceptanceContract, "feel">,
  config: Pick<TuningSessionConfig, "metricId" | "target">,
): NumericTarget | undefined {
  if (config.target) return config.target;
  const key = config.metricId as keyof AcceptanceContract["feel"];
  const target = acceptance.feel?.[key];
  return isRecord(target) && isFiniteNumber(target.target) && isString(target.unit)
    ? target as unknown as NumericTarget
    : undefined;
}

function expandedWindow(target: NumericTarget): { lo: number; hi: number } {
  const window = bandWindow(target);
  if (target.band?.abs !== undefined) {
    return { lo: target.target - target.band.abs * 2, hi: target.target + target.band.abs * 2 };
  }
  if (target.band?.percent !== undefined) {
    const d = (Math.abs(target.target) * target.band.percent * 2) / 100;
    return { lo: target.target - d, hi: target.target + d };
  }
  return window;
}

export function scoreMeasuredValue(measuredValue: number, target: NumericTarget): {
  measuredValue: number;
  errorFromTarget: number;
  status: TuningTrialStatus;
} {
  const window = bandWindow(target);
  const errorFromTarget = measuredValue - target.target;
  if (measuredValue >= window.lo - 1e-9 && measuredValue <= window.hi + 1e-9) {
    return { measuredValue, errorFromTarget, status: "pass" };
  }
  const near = expandedWindow(target);
  const status = measuredValue >= near.lo - 1e-9 && measuredValue <= near.hi + 1e-9 ? "warn" : "fail";
  return { measuredValue, errorFromTarget, status };
}

export function selectBestCandidate(trials: TuningTrialResult[]): TuningTrialResult | undefined {
  const measured = trials.filter((trial) => trial.measuredValue !== undefined);
  if (measured.length === 0) return undefined;
  const rank = (status: TuningTrialStatus): number => status === "pass" ? 0 : status === "warn" ? 1 : 2;
  return measured.sort((a, b) => {
    const statusDelta = rank(a.status) - rank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return Math.abs(a.errorFromTarget ?? Number.POSITIVE_INFINITY) -
      Math.abs(b.errorFromTarget ?? Number.POSITIVE_INFINITY);
  })[0];
}

export function buildTuningReport(args: {
  config: TuningSessionConfig;
  target?: NumericTarget;
  trials: TuningTrialResult[];
  warnings?: string[];
  unityRouting?: UnityRoutingMetadata;
}): TuningTrialsReport {
  const bestCandidate = selectBestCandidate(args.trials);
  const recommendation = bestCandidate
    ? bestCandidate.status === "pass"
      ? `Use candidate ${bestCandidate.candidateValue}; it is inside the target band. Persist this value in Edit Mode, then run final verification.`
      : `Best measured candidate is ${bestCandidate.candidateValue}, but it is ${bestCandidate.status}. Continue tuning or revise the measurement setup before persisting.`
    : "No candidate produced a usable measurement; fix trial errors before persisting any value.";

  return {
    sessionId: args.config.id,
    metricId: args.config.metricId,
    target: args.target?.target,
    unit: args.target?.unit,
    band: args.target?.band,
    trials: args.trials,
    ...(bestCandidate ? { bestCandidate } : {}),
    ...(args.warnings && args.warnings.length > 0 ? { warnings: args.warnings } : {}),
    ...(args.unityRouting ? { unityRouting: args.unityRouting } : {}),
    recommendation,
  };
}

const DEFAULT_RESULT_PATHS: Record<string, string> = {
  runSpeed: "avgRunSpeed",
  jumpApex: "deltaY",
  timeToApex: "timeToApexMs",
  dashDistance: "deltaX",
};

function resultPathFor(config: TuningSessionConfig): string {
  return config.measurement.resultPath ?? DEFAULT_RESULT_PATHS[config.metricId] ?? config.metricId;
}

function getPathValue(input: unknown, pathName: string): unknown {
  return pathName.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, input);
}

export function extractMeasuredValue(result: unknown, config: TuningSessionConfig): number {
  const value = getPathValue(result, resultPathFor(config));
  if (!isFiniteNumber(value)) {
    throw new Error(`Measurement result did not contain numeric '${resultPathFor(config)}'.`);
  }
  return value;
}

export function planTuningTrialOperations(config: TuningSessionConfig): Array<{ command: string; params: Record<string, unknown>; timeoutMs?: number }> {
  const ops: Array<{ command: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  if (config.reset?.beforeEach) {
    ops.push({
      command: config.reset.beforeEach.command,
      params: config.reset.beforeEach.params ?? {},
      timeoutMs: config.reset.beforeEach.timeoutMs,
    });
  }
  ops.push({
    command: "component.set_property",
    params: {
      locator: config.mutation.locator,
      type_name: config.mutation.type_name,
      property_path: config.mutation.property_path,
      value: "<candidate>",
    },
  });
  for (const operation of config.replay?.beforeMeasure ?? []) {
    ops.push({
      command: operation.command,
      params: operation.params ?? {},
      timeoutMs: operation.timeoutMs,
    });
  }
  ops.push({
    command: config.measurement.command ?? "runtime.measure_motion",
    params: config.measurement.params,
    timeoutMs: config.measurement.timeoutMs ?? 30000,
  });
  return ops;
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
    if (!retryOnConnectionLoss || !isConnectionLoss(error)) throw error;
    await ensureConnected(client);
    return responseData(await client.send(command, params, timeoutMs), command);
  }
}

async function waitFrames(client: UnityClient, frames: number | undefined): Promise<void> {
  if (!frames || frames <= 0) return;
  await send(client, "editor.wait_for", { frames, timeoutMs: 10000 }, 15000);
}

async function runOperation(client: UnityClient, operation: TuningOperation): Promise<void> {
  await send(client, operation.command, operation.params ?? {}, operation.timeoutMs);
}

export async function runTuningSession(args: {
  acceptance: AcceptanceContract;
  config: TuningSessionConfig;
  client?: UnityClient;
  project?: string;
}): Promise<TuningTrialsReport> {
  const target = getMetricTarget(args.acceptance, args.config);
  if (!target) {
    throw new Error(`No acceptance feel target for '${args.config.metricId}'. Add config.target or acceptance.feel.${args.config.metricId}.`);
  }

  const resolvedClient = args.client ? null : createUnityClientForCli({ project: args.project });
  const client = args.client ?? resolvedClient!.client;
  const ownsClient = !args.client;
  const trials: TuningTrialResult[] = [];
  const warnings: string[] = [];
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = resolvedClient ? buildUnityRoutingMetadata(resolvedClient) : undefined;

  try {
    if (ownsClient) await client.connect();
    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);

    for (const candidate of args.config.candidates) {
      const notes: string[] = [];
      try {
        if (args.config.reset?.beforeEach) {
          const op = args.config.reset.beforeEach;
          await send(client, op.command, op.params ?? {}, op.timeoutMs);
          await waitFrames(client, args.config.reset.waitFramesAfterReset);
        }

        await send(
          client,
          "component.set_property",
          {
            locator: args.config.mutation.locator,
            type_name: args.config.mutation.type_name,
            property_path: args.config.mutation.property_path,
            value: candidate,
          },
          30000,
        );
        await waitFrames(client, args.config.reset?.waitFramesAfterSet ?? 2);

        for (const operation of args.config.replay?.beforeMeasure ?? []) {
          await runOperation(client, operation);
        }
        await waitFrames(client, args.config.replay?.waitFramesAfterReplay);

        const measured = await send(
          client,
          args.config.measurement.command ?? "runtime.measure_motion",
          args.config.measurement.params,
          args.config.measurement.timeoutMs ?? 30000,
          { retryOnConnectionLoss: false },
        );
        const measuredValue = extractMeasuredValue(measured, args.config);
        trials.push({
          candidateValue: candidate,
          ...scoreMeasuredValue(measuredValue, target),
          ...(notes.length > 0 ? { notes } : {}),
        });
      } catch (error) {
        trials.push({
          candidateValue: candidate,
          status: "fail",
          notes,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (resolvedClient) unityRouting = buildUnityRoutingMetadata(resolvedClient);
  } finally {
    try {
      try {
        await ensureConnected(client);
        await send(client, "editor.stop", {}, 30000);
        await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
      } catch (error) {
        warnings.push(`Failed to stop Play Mode after tuning trials: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (ownsClient) await resolvedClient!.disconnect();
    }
  }

  return buildTuningReport({
    config: args.config,
    target,
    trials,
    warnings,
    ...(unityRouting ? { unityRouting } : {}),
  });
}

export function parseTuningRunnerArgs(argv: string[]): TuningRunnerArgs {
  let acceptancePath = "";
  let configPath = "";
  let outPath = "";
  let project = "";

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--acceptance") {
      acceptancePath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--config") {
      configPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--out") {
      outPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--project") {
      project = argv[i + 1] ?? "";
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!acceptancePath) throw new Error("Missing required --acceptance <path>.");
  if (!configPath) throw new Error("Missing required --config <path>.");
  if (!outPath) throw new Error("Missing required --out <tuning-trials.json>.");
  return {
    acceptancePath: path.resolve(process.cwd(), acceptancePath),
    configPath: path.resolve(process.cwd(), configPath),
    outPath: path.resolve(process.cwd(), outPath),
    ...(project ? { project } : {}),
  };
}

async function main(): Promise<number> {
  try {
    const args = parseTuningRunnerArgs(process.argv);
    const acceptance = assertValidAcceptanceContract(await readJson(args.acceptancePath));
    const config = assertValidTuningSessionConfig(await readJson(args.configPath));
    const report = await runTuningSession({ acceptance, config, project: args.project });
    await writeJson(args.outPath, report);
    console.error(`[tuning-runner] session=${report.sessionId} metric=${report.metricId} trials=${report.trials.length} out=${args.outPath}`);
    return report.bestCandidate?.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(`[tuning-runner] fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMainModule =
  process.argv[1]?.endsWith("tuning-runner.js") || process.argv[1]?.endsWith("tuning-runner.ts");
if (isMainModule) {
  main().then((code) => {
    process.exitCode = code;
  });
}
