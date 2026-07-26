import type {
  ScenarioDocument,
  ScenarioStep,
  ScenarioValidationIssue,
  ScenarioValidationResult,
} from "./types.js";

const SCHEMA_VERSION = "1";
const DISALLOWED_GAME_SPECIFIC_PATTERN = /(mario|platformer|enemy|coin|boss|rpg|fps)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pushIssue(
  issues: ScenarioValidationIssue[],
  code: string,
  message: string,
  path: string,
  stepIndex?: number,
): void {
  issues.push({ code, message, path, stepIndex });
}

function validateStep(step: unknown, index: number, issues: ScenarioValidationIssue[]): void {
  const basePath = `steps[${index}]`;
  if (!isRecord(step)) {
    pushIssue(issues, "INVALID_STEP", "Step must be an object.", basePath, index);
    return;
  }

  if (!isString(step.id)) {
    pushIssue(issues, "MISSING_FIELD", "Step id is required.", `${basePath}.id`, index);
  }

  if (!isString(step.name)) {
    pushIssue(issues, "MISSING_FIELD", "Step name is required.", `${basePath}.name`, index);
  }

  if (step.timeoutMs !== undefined && (!isNumber(step.timeoutMs) || step.timeoutMs < 1)) {
    pushIssue(issues, "INVALID_TIMEOUT", "timeoutMs must be a positive number.", `${basePath}.timeoutMs`, index);
  }

  const kind = step.kind;
  if (!isString(kind)) {
    pushIssue(issues, "MISSING_FIELD", "Step kind is required.", `${basePath}.kind`, index);
    return;
  }

  switch (kind) {
    case "tool_call": {
      if (!isString(step.tool)) {
        pushIssue(issues, "MISSING_FIELD", "tool_call step requires tool.", `${basePath}.tool`, index);
        return;
      }

      if (!step.tool.startsWith("unity_")) {
        pushIssue(
          issues,
          "INVALID_TOOL",
          "tool_call step tool must start with 'unity_'.",
          `${basePath}.tool`,
          index,
        );
      }

      if (DISALLOWED_GAME_SPECIFIC_PATTERN.test(step.tool)) {
        pushIssue(
          issues,
          "DISALLOWED_GAME_SPECIFIC_NAME",
          `Tool name '${step.tool}' is not allowed in generic scenarios.`,
          `${basePath}.tool`,
          index,
        );
      }

      if (step.arguments !== undefined && !isRecord(step.arguments)) {
        pushIssue(issues, "INVALID_ARGUMENTS", "tool_call arguments must be an object.", `${basePath}.arguments`, index);
      }
      return;
    }
    case "runtime_assert":
    case "runtime_wait": {
      if (!isRecord(step.locator)) {
        pushIssue(issues, "MISSING_FIELD", `${kind} step requires locator object.`, `${basePath}.locator`, index);
      }
      if (!isString(step.property_path)) {
        pushIssue(issues, "MISSING_FIELD", `${kind} step requires property_path.`, `${basePath}.property_path`, index);
      }
      if (!isString(step.operator)) {
        pushIssue(issues, "MISSING_FIELD", `${kind} step requires operator.`, `${basePath}.operator`, index);
      }
      if (step.expected === undefined) {
        pushIssue(issues, "MISSING_FIELD", `${kind} step requires expected value.`, `${basePath}.expected`, index);
      }
      return;
    }
    case "capture_screenshot": {
      if (step.view !== undefined && step.view !== "scene" && step.view !== "game") {
        pushIssue(issues, "INVALID_VIEW", "capture_screenshot view must be 'scene' or 'game'.", `${basePath}.view`, index);
      }
      return;
    }
    default:
      pushIssue(
        issues,
        "UNKNOWN_STEP_KIND",
        `Unknown step kind '${String(kind)}'.`,
        `${basePath}.kind`,
        index,
      );
      return;
  }
}

export function validateScenarioDocument(input: unknown): ScenarioValidationResult {
  const issues: ScenarioValidationIssue[] = [];

  if (!isRecord(input)) {
    pushIssue(issues, "INVALID_DOCUMENT", "Scenario document must be an object.", "scenario");
    return { valid: false, issues };
  }

  if (!isString(input.schemaVersion)) {
    pushIssue(issues, "MISSING_FIELD", "schemaVersion is required.", "schemaVersion");
  } else if (input.schemaVersion !== SCHEMA_VERSION) {
    pushIssue(issues, "INVALID_SCHEMA_VERSION", `schemaVersion must be '${SCHEMA_VERSION}'.`, "schemaVersion");
  }

  if (!isString(input.name)) {
    pushIssue(issues, "MISSING_FIELD", "Scenario name is required.", "name");
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    pushIssue(issues, "MISSING_STEPS", "Scenario must include at least one step.", "steps");
  } else {
    const seenStepIds = new Set<string>();
    input.steps.forEach((step, index) => {
      validateStep(step, index, issues);

      if (isRecord(step) && isString(step.id)) {
        if (seenStepIds.has(step.id)) {
          pushIssue(
            issues,
            "DUPLICATE_STEP_ID",
            `Duplicate step id '${step.id}'.`,
            `steps[${index}].id`,
            index,
          );
        }
        seenStepIds.add(step.id);
      }
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function assertValidScenarioDocument(input: unknown): ScenarioDocument {
  const result = validateScenarioDocument(input);
  if (!result.valid) {
    const summary = result.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`Scenario validation failed: ${summary}`);
  }
  return input as ScenarioDocument;
}

export function validateScenarioStepKindsForGenericUse(step: ScenarioStep): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  if (step.kind === "tool_call" && DISALLOWED_GAME_SPECIFIC_PATTERN.test(step.tool)) {
    pushIssue(
      issues,
      "DISALLOWED_GAME_SPECIFIC_NAME",
      `Tool name '${step.tool}' is not allowed in generic scenarios.`,
      `step:${step.id}.tool`,
    );
  }
  return issues;
}
