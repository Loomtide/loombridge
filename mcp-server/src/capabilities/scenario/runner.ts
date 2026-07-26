import type {
  ScenarioDocument,
  ScenarioRunResult,
  ScenarioStep,
  ScenarioStepOutcome,
  ScenarioToolCallRequest,
  ScenarioToolResult,
} from "./types.js";

export type ScenarioToolInvoker = (request: ScenarioToolCallRequest) => Promise<ScenarioToolResult>;

export interface ScenarioRunnerOptions {
  defaultStepTimeoutMs?: number;
}

interface ParsedError {
  code?: string;
  message: string;
}

type StepStatus = ScenarioStepOutcome["status"];

const BLOCKED_ERROR_CODES = new Set([
  "PREFLIGHT_BLOCKED",
  "PREFLIGHT_CONNECTION_BLOCKED",
  "INPUT_CAPABILITY_BLOCKED",
]);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`Step timeout exceeded before execution (timeoutMs=${timeoutMs})`));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Step timeout exceeded (${timeoutMs}ms)`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parseToolError(result: ScenarioToolResult): ParsedError {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "Unknown tool error";
  const codeMatch = text.match(/^\[([A-Z0-9_]+)\]\s*/);
  if (codeMatch) {
    return {
      code: codeMatch[1],
      message: text.replace(/^\[[A-Z0-9_]+\]\s*/, ""),
    };
  }

  return { message: text };
}

function parseTextPayload(result: ScenarioToolResult): Record<string, unknown> | undefined {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { rawText: text };
  }
}

function collectArtifacts(result: ScenarioToolResult): string[] {
  const artifacts: string[] = [];
  result.content?.forEach((item, index) => {
    if (item.type === "image" && typeof item.mimeType === "string" && typeof item.data === "string") {
      artifacts.push(`inline:${item.mimeType}:${item.data.length}:content[${index}]`);
    }
  });
  return artifacts;
}

function normalizeArtifacts(artifacts: string[]): string[] {
  return Array.from(new Set(artifacts)).sort();
}

function classifyToolErrorStatus(parsed: ParsedError): Exclude<StepStatus, "pass"> {
  const code = (parsed.code ?? "").trim().toUpperCase();
  if (BLOCKED_ERROR_CODES.has(code)) {
    return "blocked";
  }

  if (/deterministic scenario preflight blocked/i.test(parsed.message)) {
    return "blocked";
  }

  if (/input capability blocked/i.test(parsed.message)) {
    return "blocked";
  }

  return "fail";
}

function readStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface RuntimeOutcome {
  status: StepStatus;
  error?: ParsedError;
}

function evaluateRuntimeOutcome(
  step: ScenarioStep,
  payload: Record<string, unknown> | undefined,
): RuntimeOutcome | null {
  if (step.kind !== "runtime_assert" && step.kind !== "runtime_wait") {
    return null;
  }

  const classificationRaw = readStringField(payload, "classification");
  const classification = classificationRaw?.trim().toLowerCase();
  const passed = payload?.passed;

  if (classification === "pass" || passed === true) {
    return { status: "pass" };
  }

  const runtimeMessage = readStringField(payload, "message")
    ?? `Runtime condition step '${step.id}' returned passed=false.`;

  if (classification === "blocked") {
    return {
      status: "blocked",
      error: {
        code: readStringField(payload, "failure_code")
          ?? readStringField(payload, "blocker_code")
          ?? "RUNTIME_BLOCKED",
        message: runtimeMessage,
      },
    };
  }

  return {
    status: "fail",
    error: {
      code: readStringField(payload, "failure_code") ?? "ASSERTION_FAILED",
      message: runtimeMessage,
    },
  };
}

export function buildToolCallRequest(step: ScenarioStep): ScenarioToolCallRequest {
  switch (step.kind) {
    case "tool_call":
      return {
        name: step.tool,
        arguments: step.arguments ?? {},
        timeoutMs: step.timeoutMs,
      };
    case "runtime_assert":
      return {
        name: "unity_runtime_assert_condition",
        arguments: {
          locator: step.locator,
          component: step.component,
          property_path: step.property_path,
          operator: step.operator,
          expected: step.expected,
          tolerance: step.tolerance,
        },
        timeoutMs: step.timeoutMs,
      };
    case "runtime_wait":
      return {
        name: "unity_runtime_wait_for_condition",
        arguments: {
          locator: step.locator,
          component: step.component,
          property_path: step.property_path,
          operator: step.operator,
          expected: step.expected,
          tolerance: step.tolerance,
          compiling: step.compiling,
          updating: step.updating,
          playMode: step.playMode,
          frames: step.frames,
          delayMs: step.delayMs,
          timeoutMs: step.timeoutMs,
        },
        timeoutMs: step.timeoutMs,
      };
    case "capture_screenshot":
      return {
        name: "unity_editor_screenshot",
        arguments: {
          view: step.view ?? "game",
          maxWidth: step.maxWidth,
          format: step.format,
          quality: step.quality,
        },
        timeoutMs: step.timeoutMs,
      };
  }
}

export function buildScenarioDryRunResult(scenario: ScenarioDocument): ScenarioRunResult {
  const startedAtMs = Date.now();
  const steps: ScenarioStepOutcome[] = scenario.steps.map((step, index) => {
    const request = buildToolCallRequest(step);
    return {
      stepIndex: index,
      stepId: step.id,
      stepName: step.name,
      kind: step.kind,
      startedAtMs,
      durationMs: 0,
      status: "pass",
      deterministic: true,
      tool: request.name,
      request: request.arguments,
      response: {
        dryRun: true,
        deterministic: true,
      },
      artifacts: [],
      artifactMetadata: {
        normalized: true,
        count: 0,
      },
    };
  });
  const finishedAtMs = Date.now();

  return {
    status: "pass",
    deterministic: true,
    scenario: {
      name: scenario.name,
      schemaVersion: scenario.schemaVersion,
    },
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    steps,
    diagnostics: {
      totalSteps: steps.length,
      passedSteps: steps.length,
      failedSteps: 0,
      blockedSteps: 0,
    },
    artifacts: [],
    artifactMetadata: {
      normalized: true,
      count: 0,
    },
  };
}

export class ScenarioRunner {
  private readonly _invokeTool: ScenarioToolInvoker;
  private readonly _defaultStepTimeoutMs: number;

  constructor(invokeTool: ScenarioToolInvoker, options: ScenarioRunnerOptions = {}) {
    this._invokeTool = invokeTool;
    this._defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? 10000;
  }

  async run(scenario: ScenarioDocument): Promise<ScenarioRunResult> {
    const startedAtMs = Date.now();
    const steps: ScenarioStepOutcome[] = [];
    const allArtifacts: string[] = [];
    let nonPassStepIndex: number | undefined;
    let nonPassStepId: string | undefined;
    let nonPassStepStatus: Exclude<StepStatus, "pass"> | undefined;

    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index]!;
      const stepStartMs = Date.now();
      const toolRequest = buildToolCallRequest(step);
      const timeoutMs = step.timeoutMs ?? this._defaultStepTimeoutMs;

      const outcome: ScenarioStepOutcome = {
        stepIndex: index,
        stepId: step.id,
        stepName: step.name,
        kind: step.kind,
        startedAtMs: stepStartMs,
        durationMs: 0,
        status: "pass",
        deterministic: true,
        tool: toolRequest.name,
        request: toolRequest.arguments,
        artifacts: [],
        artifactMetadata: {
          normalized: true,
          count: 0,
        },
      };

      try {
        const toolResult = await withTimeout(
          this._invokeTool({
            name: toolRequest.name,
            arguments: toolRequest.arguments,
            timeoutMs,
          }),
          timeoutMs,
        );

        outcome.durationMs = Date.now() - stepStartMs;
        outcome.response = parseTextPayload(toolResult);

        const inlineArtifacts = normalizeArtifacts(collectArtifacts(toolResult));
        outcome.artifacts = inlineArtifacts;
        outcome.artifactMetadata = {
          normalized: true,
          count: inlineArtifacts.length,
        };
        allArtifacts.push(...inlineArtifacts);

        if (toolResult.isError) {
          const parsed = parseToolError(toolResult);
          outcome.status = classifyToolErrorStatus(parsed);
          outcome.error = parsed;
        } else {
          const runtimeOutcome = evaluateRuntimeOutcome(step, outcome.response);
          if (runtimeOutcome && runtimeOutcome.status !== "pass") {
            outcome.status = runtimeOutcome.status;
            outcome.error = runtimeOutcome.error;
          }
        }
      } catch (error) {
        outcome.durationMs = Date.now() - stepStartMs;
        outcome.status = "fail";
        outcome.error = {
          code: "TIMEOUT",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      steps.push(outcome);

      if (outcome.status !== "pass") {
        nonPassStepIndex = index;
        nonPassStepId = step.id;
        nonPassStepStatus = outcome.status;
        break;
      }
    }

    const finishedAtMs = Date.now();
    const passedSteps = steps.filter((step) => step.status === "pass").length;
    const failedSteps = steps.filter((step) => step.status === "fail").length;
    const blockedSteps = steps.filter((step) => step.status === "blocked").length;
    const normalizedArtifacts = normalizeArtifacts(allArtifacts);
    const status: ScenarioRunResult["status"] = nonPassStepStatus === undefined
      ? "pass"
      : nonPassStepStatus;

    return {
      status,
      deterministic: true,
      scenario: {
        name: scenario.name,
        schemaVersion: scenario.schemaVersion,
      },
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      steps,
      failedStepIndex: nonPassStepIndex,
      failedStepId: nonPassStepId,
      failedStepStatus: nonPassStepStatus,
      diagnostics: {
        totalSteps: scenario.steps.length,
        passedSteps,
        failedSteps,
        blockedSteps,
      },
      artifacts: normalizedArtifacts,
      artifactMetadata: {
        normalized: true,
        count: normalizedArtifacts.length,
      },
    };
  }
}
