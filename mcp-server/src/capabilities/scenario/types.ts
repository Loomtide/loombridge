import type { EntityLocator, RuntimeComparator } from "../../shared/types.js";

export type ScenarioStepKind =
  | "tool_call"
  | "runtime_assert"
  | "runtime_wait"
  | "capture_screenshot";

export interface ScenarioBaseStep {
  id: string;
  name: string;
  kind: ScenarioStepKind;
  timeoutMs?: number;
}

export interface ScenarioToolCallStep extends ScenarioBaseStep {
  kind: "tool_call";
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface ScenarioRuntimeAssertStep extends ScenarioBaseStep {
  kind: "runtime_assert";
  locator: EntityLocator;
  component?: string;
  property_path: string;
  operator: RuntimeComparator;
  expected: unknown;
  tolerance?: number;
}

export interface ScenarioRuntimeWaitStep extends ScenarioBaseStep {
  kind: "runtime_wait";
  locator: EntityLocator;
  component?: string;
  property_path: string;
  operator: RuntimeComparator;
  expected: unknown;
  tolerance?: number;
  compiling?: boolean;
  updating?: boolean;
  playMode?: "playing" | "paused" | "stopped";
  frames?: number;
  delayMs?: number;
}

export interface ScenarioCaptureScreenshotStep extends ScenarioBaseStep {
  kind: "capture_screenshot";
  view?: "scene" | "game";
  maxWidth?: number;
  format?: "jpeg" | "png";
  quality?: number;
}

export type ScenarioStep =
  | ScenarioToolCallStep
  | ScenarioRuntimeAssertStep
  | ScenarioRuntimeWaitStep
  | ScenarioCaptureScreenshotStep;

export interface ScenarioDocument {
  schemaVersion: "1";
  name: string;
  description?: string;
  steps: ScenarioStep[];
}

export interface ScenarioValidationIssue {
  code: string;
  message: string;
  path: string;
  stepIndex?: number;
}

export interface ScenarioValidationResult {
  valid: boolean;
  issues: ScenarioValidationIssue[];
}

export interface ScenarioToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScenarioToolResult {
  isError?: boolean;
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}

export interface ScenarioStepOutcome {
  stepIndex: number;
  stepId: string;
  stepName: string;
  kind: ScenarioStepKind;
  startedAtMs: number;
  durationMs: number;
  status: "pass" | "fail" | "blocked";
  deterministic: true;
  tool: string;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
  };
  artifacts?: string[];
  artifactMetadata?: {
    normalized: true;
    count: number;
  };
}

export interface ScenarioRunResult {
  status: "pass" | "fail" | "blocked";
  deterministic: true;
  scenario: {
    name: string;
    schemaVersion: "1";
  };
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  steps: ScenarioStepOutcome[];
  failedStepIndex?: number;
  failedStepId?: string;
  failedStepStatus?: "fail" | "blocked";
  diagnostics: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    blockedSteps: number;
  };
  artifacts: string[];
  artifactMetadata?: {
    normalized: true;
    count: number;
  };
  validationIssues?: ScenarioValidationIssue[];
  dryRun?: boolean;
}
