#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildScenarioDryRunResult,
  ScenarioRunner,
  type ScenarioToolInvoker,
} from "../capabilities/scenario/runner.js";
import { writeScenarioResult } from "../capabilities/scenario/result-writer.js";
import { validateScenarioDocument } from "../capabilities/scenario/validator.js";
import type { ScenarioDocument, ScenarioRunResult, ScenarioToolResult } from "../capabilities/scenario/types.js";

interface CliArgs {
  scenarioPath: string;
  outputPath: string;
  dryRun: boolean;
}

interface CliRuntime {
  invoke: ScenarioToolInvoker;
  close: () => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");

function printUsage(): void {
  console.log(
    "Usage: node dist/scenario-cli.js --scenario <path> [--output <path>] [--dry-run]",
  );
}

function parseArgs(argv: string[]): CliArgs {
  let scenarioPath = "";
  let outputPath = "../demo/.artifacts/scenario-report.json";
  let dryRun = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--scenario") {
      scenarioPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--output") {
      outputPath = argv[i + 1] ?? outputPath;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!scenarioPath) {
    throw new Error("Missing required --scenario <path> argument.");
  }

  return {
    scenarioPath: resolve(process.cwd(), scenarioPath),
    outputPath: resolve(process.cwd(), outputPath),
    dryRun,
  };
}

async function readScenarioDocument(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
}

function buildValidationFailureResult(
  scenarioName: string,
  issues: ScenarioRunResult["validationIssues"],
): ScenarioRunResult {
  const startedAtMs = Date.now();
  const finishedAtMs = startedAtMs;
  return {
    status: "fail",
    deterministic: true,
    scenario: {
      name: scenarioName,
      schemaVersion: "1",
    },
    startedAtMs,
    finishedAtMs,
    durationMs: 0,
    steps: [],
    diagnostics: {
      totalSteps: 0,
      passedSteps: 0,
      failedSteps: 0,
      blockedSteps: 0,
    },
    artifacts: [],
    artifactMetadata: {
      normalized: true,
      count: 0,
    },
    validationIssues: issues ?? [],
  };
}

function buildFatalFailureResult(scenarioName: string, message: string): ScenarioRunResult {
  const startedAtMs = Date.now();
  const finishedAtMs = startedAtMs;
  return {
    status: "fail",
    deterministic: true,
    scenario: {
      name: scenarioName,
      schemaVersion: "1",
    },
    startedAtMs,
    finishedAtMs,
    durationMs: 0,
    steps: [],
    diagnostics: {
      totalSteps: 0,
      passedSteps: 0,
      failedSteps: 1,
      blockedSteps: 0,
    },
    artifacts: [],
    artifactMetadata: {
      normalized: true,
      count: 0,
    },
    validationIssues: [
      {
        code: "CLI_FATAL",
        message,
        path: "cli",
      },
    ],
  };
}

async function createRuntime(): Promise<CliRuntime> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/surfaces/index.js"],
    cwd: MCP_SERVER_DIR,
    stderr: "pipe",
  });

  const client = new Client({ name: "scenario-cli", version: "0.1.0" });
  await client.connect(transport);

  const invoke: ScenarioToolInvoker = async (request): Promise<ScenarioToolResult> => {
    try {
      const result = await client.callTool({
        name: request.name,
        arguments: request.arguments,
      });

      return {
        isError: result.isError === true,
        content: (result.content ?? []) as ScenarioToolResult["content"],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  };

  return {
    invoke,
    close: async () => {
      await client.close();
    },
  };
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  let scenarioName = path.basename(args.scenarioPath);
  let runtime: CliRuntime | null = null;

  try {
    const raw = await readScenarioDocument(args.scenarioPath);
    if (raw && typeof raw === "object" && "name" in raw && typeof (raw as { name?: unknown }).name === "string") {
      scenarioName = (raw as { name: string }).name;
    }

    const validation = validateScenarioDocument(raw);
    if (!validation.valid) {
      const failure = buildValidationFailureResult(scenarioName, validation.issues);
      await writeScenarioResult(args.outputPath, failure);
      console.error(`[scenario-cli] validation failed (${validation.issues.length} issue(s))`);
      return 1;
    }

    const scenario = raw as ScenarioDocument;
    let result: ScenarioRunResult;

    if (args.dryRun) {
      result = buildScenarioDryRunResult(scenario);
      result.dryRun = true;
    } else {
      runtime = await createRuntime();
      const runner = new ScenarioRunner(runtime.invoke);
      result = await runner.run(scenario);
    }

    await writeScenarioResult(args.outputPath, result);
    console.error(`[scenario-cli] scenario=${scenario.name} status=${result.status} output=${args.outputPath}`);
    return result.status === "pass" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = buildFatalFailureResult(scenarioName, message);
    await writeScenarioResult(args.outputPath, failure);
    console.error(`[scenario-cli] fatal: ${message}`);
    return 1;
  } finally {
    if (runtime) {
      await runtime.close().catch(() => undefined);
    }
  }
}

const isMainModule = process.argv[1]?.endsWith("scenario-cli.js") || process.argv[1]?.endsWith("scenario-cli.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  });
}

export { run as runScenarioCli };
