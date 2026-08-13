#!/usr/bin/env node
/**
 * Backend-only tuning persist helper.
 *
 * Closes the live tuning loop by taking a passing best candidate from a
 * tuning-trials.json report, stopping Play Mode, applying the value in Edit
 * Mode, and reading it back for deterministic verification.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { UnityClient } from "../../bridge/unity-client.js";
import type { BridgeResponse } from "../../shared/types.js";
import {
  assertValidTuningSessionConfig,
  type TuningSessionConfig,
  type TuningTrialStatus,
  type TuningTrialsReport,
} from "./tuning-runner.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  type UnityRoutingMetadata,
} from "../../bridge/unity-client-resolver.js";
import { isMainModule as isMainModuleUrl } from "../../shared/main-module.js";

export interface TuningPersistInput {
  config: TuningSessionConfig;
  report: TuningTrialsReport;
  allowNonPassingCandidate?: boolean;
}

export interface TuningPersistRunnerArgs {
  configPath: string;
  reportPath: string;
  outPath: string;
  allowNonPassingCandidate: boolean;
  project?: string;
}

export interface TuningPersistIssue {
  code: string;
  path: string;
  message: string;
}

export interface TuningPersistValidationResult {
  valid: boolean;
  issues: TuningPersistIssue[];
}

export interface TuningPersistOperationPlan {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface TuningPersistReport {
  sessionId: string;
  metricId: string;
  persistedValue: number;
  locator: TuningSessionConfig["mutation"]["locator"];
  type_name: string;
  property_path: string;
  verification: {
    actualValue?: unknown;
    tolerance?: number;
    status: "pass" | "fail";
  };
  status: "pass" | "fail";
  unityRouting?: UnityRoutingMetadata;
  warnings?: string[];
  errors?: string[];
}

interface SendOptions {
  retryOnConnectionLoss?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pushIssue(issues: TuningPersistIssue[], code: string, pathName: string, message: string): void {
  issues.push({ code, path: pathName, message });
}

export function validateTuningPersistInput(input: TuningPersistInput): TuningPersistValidationResult {
  const issues: TuningPersistIssue[] = [];
  const { config, report, allowNonPassingCandidate = false } = input;

  if (!isRecord(config.mutation)) {
    pushIssue(issues, "MISSING_MUTATION", "config.mutation", "Tuning config mutation is required.");
  } else {
    if (!isRecord(config.mutation.locator)) {
      pushIssue(issues, "MISSING_MUTATION", "config.mutation.locator", "Mutation locator is required.");
    }
    if (typeof config.mutation.type_name !== "string" || config.mutation.type_name.trim().length === 0) {
      pushIssue(issues, "MISSING_MUTATION", "config.mutation.type_name", "Mutation component type_name is required.");
    }
    if (typeof config.mutation.property_path !== "string" || config.mutation.property_path.trim().length === 0) {
      pushIssue(
        issues,
        "MISSING_MUTATION",
        "config.mutation.property_path",
        "Mutation property_path is required.",
      );
    }
  }

  if (!report.bestCandidate) {
    pushIssue(issues, "MISSING_BEST_CANDIDATE", "report.bestCandidate", "Report has no bestCandidate to persist.");
  } else {
    if (!isFiniteNumber(report.bestCandidate.candidateValue)) {
      pushIssue(
        issues,
        "INVALID_CANDIDATE",
        "report.bestCandidate.candidateValue",
        "bestCandidate.candidateValue must be a finite number.",
      );
    }
    if (report.bestCandidate.status !== "pass" && !allowNonPassingCandidate) {
      pushIssue(
        issues,
        "NON_PASSING_CANDIDATE",
        "report.bestCandidate.status",
        "Refusing to persist non-passing bestCandidate without allowNonPassingCandidate.",
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidTuningPersistInput(input: TuningPersistInput): TuningPersistInput {
  const result = validateTuningPersistInput(input);
  if (!result.valid) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid tuning persist input: ${detail}`);
  }
  return input;
}

export function selectedCandidateValue(input: TuningPersistInput): number {
  assertValidTuningPersistInput(input);
  return input.report.bestCandidate!.candidateValue;
}

export function valuesEquivalent(expected: unknown, actual: unknown, tolerance = 0.0001): boolean {
  if (isFiniteNumber(expected) && isFiniteNumber(actual)) {
    return Math.abs(expected - actual) <= tolerance;
  }
  return Object.is(expected, actual);
}

export function planTuningPersistOperations(input: TuningPersistInput): TuningPersistOperationPlan[] {
  const value = selectedCandidateValue(input);
  const mutation = input.config.mutation;
  return [
    { command: "editor.stop", params: {}, timeoutMs: 30000 },
    { command: "editor.wait_for", params: { playMode: "stopped", timeoutMs: 30000 }, timeoutMs: 35000 },
    {
      command: "component.set_property",
      params: {
        locator: mutation.locator,
        type_name: mutation.type_name,
        property_path: mutation.property_path,
        value,
      },
      timeoutMs: 30000,
    },
    {
      command: "component.get_properties",
      params: {
        locator: mutation.locator,
        type_name: mutation.type_name,
        include_paths: [mutation.property_path],
      },
      timeoutMs: 30000,
    },
  ];
}

function propertyValueFromGetProperties(result: unknown, propertyPath: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.properties)) return undefined;
  const property = result.properties.find((candidate): candidate is Record<string, unknown> => (
    isRecord(candidate) &&
    (candidate.serializedPath === propertyPath ||
      candidate.path === propertyPath ||
      candidate.displayName === propertyPath)
  ));
  return property?.currentValue;
}

export function buildTuningPersistReport(args: {
  config: TuningSessionConfig;
  report: TuningTrialsReport;
  actualValue?: unknown;
  tolerance?: number;
  unityRouting?: UnityRoutingMetadata;
  warnings?: string[];
  errors?: string[];
}): TuningPersistReport {
  const persistedValue = args.report.bestCandidate?.candidateValue;
  if (!isFiniteNumber(persistedValue)) {
    throw new Error("Cannot build tuning persist report without numeric bestCandidate.candidateValue.");
  }

  const tolerance = args.tolerance ?? 0.0001;
  const verificationStatus = valuesEquivalent(persistedValue, args.actualValue, tolerance) ? "pass" : "fail";
  return {
    sessionId: args.report.sessionId,
    metricId: args.report.metricId,
    persistedValue,
    locator: args.config.mutation.locator,
    type_name: args.config.mutation.type_name,
    property_path: args.config.mutation.property_path,
    verification: {
      actualValue: args.actualValue,
      tolerance,
      status: verificationStatus,
    },
    status: verificationStatus,
    ...(args.unityRouting ? { unityRouting: args.unityRouting } : {}),
    ...(args.warnings && args.warnings.length > 0 ? { warnings: args.warnings } : {}),
    ...(args.errors && args.errors.length > 0 ? { errors: args.errors } : {}),
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
    if (!retryOnConnectionLoss || !isConnectionLoss(error)) throw error;
    await ensureConnected(client);
    return responseData(await client.send(command, params, timeoutMs), command);
  }
}

export async function persistTuningCandidate(args: {
  config: TuningSessionConfig;
  report: TuningTrialsReport;
  allowNonPassingCandidate?: boolean;
  client?: UnityClient;
  project?: string;
}): Promise<TuningPersistReport> {
  const input = assertValidTuningPersistInput({
    config: args.config,
    report: args.report,
    allowNonPassingCandidate: args.allowNonPassingCandidate,
  });
  const resolvedClient = args.client ? null : createUnityClientForCli({ project: args.project });
  const client = args.client ?? resolvedClient!.client;
  const ownsClient = !args.client;
  const warnings: string[] = [];
  const errors: string[] = [];
  let actualValue: unknown;
  let verificationPropertyPath = args.config.mutation.property_path;
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = resolvedClient ? buildUnityRoutingMetadata(resolvedClient) : undefined;

  try {
    if (ownsClient) await client.connect();
    try {
      await send(client, "editor.stop", {}, 30000);
    } catch (error) {
      warnings.push(`editor.stop failed or was unnecessary before persist: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
      const setResult = await send(
        client,
        "component.set_property",
        {
          locator: args.config.mutation.locator,
          type_name: args.config.mutation.type_name,
          property_path: args.config.mutation.property_path,
          value: input.report.bestCandidate!.candidateValue,
        },
        30000,
      );
      if (isRecord(setResult) && typeof setResult.property_path === "string" && setResult.property_path.trim()) {
        verificationPropertyPath = setResult.property_path;
      }
      const properties = await send(
        client,
        "component.get_properties",
        {
          locator: args.config.mutation.locator,
          type_name: args.config.mutation.type_name,
          include_paths: [verificationPropertyPath],
        },
        30000,
      );
      actualValue = propertyValueFromGetProperties(properties, verificationPropertyPath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (resolvedClient) unityRouting = buildUnityRoutingMetadata(resolvedClient);
  } finally {
    if (ownsClient) await resolvedClient!.disconnect();
  }

  return buildTuningPersistReport({
    config: args.config,
    report: args.report,
    actualValue,
    ...(unityRouting ? { unityRouting } : {}),
    warnings,
    errors,
  });
}

export function parseTuningPersistArgs(argv: string[]): TuningPersistRunnerArgs {
  let configPath = "";
  let reportPath = "";
  let outPath = "";
  let allowNonPassingCandidate = false;
  let project = "";

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--report") {
      reportPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--out") {
      outPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--allow-non-passing-candidate") {
      allowNonPassingCandidate = true;
    } else if (arg === "--project") {
      project = argv[i + 1] ?? "";
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!configPath) throw new Error("Missing required --config <tuning-session.json>.");
  if (!reportPath) throw new Error("Missing required --report <tuning-trials.json>.");
  if (!outPath) throw new Error("Missing required --out <tuning-persist.json>.");
  return {
    configPath: path.resolve(process.cwd(), configPath),
    reportPath: path.resolve(process.cwd(), reportPath),
    outPath: path.resolve(process.cwd(), outPath),
    allowNonPassingCandidate,
    ...(project ? { project } : {}),
  };
}

async function main(): Promise<number> {
  try {
    const args = parseTuningPersistArgs(process.argv);
    const config = assertValidTuningSessionConfig(await readJson(args.configPath));
    const report = await readJson(args.reportPath) as TuningTrialsReport;
    const persistReport = await persistTuningCandidate({
      config,
      report,
      allowNonPassingCandidate: args.allowNonPassingCandidate,
      project: args.project,
    });
    await writeJson(args.outPath, persistReport);
    console.error(
      `[tuning-persist] session=${persistReport.sessionId} metric=${persistReport.metricId} ` +
        `value=${persistReport.persistedValue} status=${persistReport.status} out=${args.outPath}`,
    );
    return persistReport.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(`[tuning-persist] fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMainModule = isMainModuleUrl(import.meta.url);
if (isMainModule) {
  main().then((code) => {
    process.exitCode = code;
  });
}
