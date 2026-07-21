import type { EntityLocator } from "../types.js";

export const VERIFICATION_SCENARIO_SCHEMA_VERSION = "1";

export type VerificationResetPolicyName = "none" | "reload-scene" | "spawn-before-sequence";

export interface VerificationOperation {
  command: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VerificationResetPolicy {
  type: VerificationResetPolicyName;
  scenePath?: string;
  resetOperation?: VerificationOperation;
  warningOnly?: boolean;
}

export interface VerificationDriverDefault {
  locator?: EntityLocator;
  type_name?: string;
  property_path?: string;
}

export interface VerificationPhaseDriver {
  locator: EntityLocator;
  type_name: string;
  property_path: string;
  value: number | boolean;
}

export interface VerificationPhase {
  durationMs: number;
  value?: number | boolean;
  drivers?: VerificationPhaseDriver[];
}

export interface VerificationCapture {
  id: string;
  trigger?: "start" | "end" | "atMs" | "apexY";
  atMs?: number;
  view?: "scene" | "game";
  maxWidth?: number;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface VerificationSequence {
  id: string;
  driver?: {
    locator: EntityLocator;
    type_name: string;
    property_path: string;
  };
  phases: VerificationPhase[];
  captures: VerificationCapture[];
  captureFps?: number;
  includeSamples?: boolean;
  resetDriversOnEnd?: boolean;
}

export type VerificationScreenRectBoundsMode = "opaque" | "renderer" | "collider";
export type VerificationRuntimeAssertionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "approx"
  | "contains";

export interface VerificationRuntimeAssertion {
  id: string;
  locator: EntityLocator;
  component?: string;
  property_path: string;
  operator: VerificationRuntimeAssertionOperator;
  expected: unknown;
  tolerance?: number;
  timeoutMs?: number;
}

export interface VerificationScenario {
  schemaVersion: "1";
  id: string;
  gameKind: string;
  playMode: {
    enterOnce: boolean;
    resetPolicy: VerificationResetPolicyName | VerificationResetPolicy;
  };
  measure: EntityLocator;
  driverDefaults?: VerificationDriverDefault;
  sequences: VerificationSequence[];
  collect?: {
    screenRects?: EntityLocator[];
    screenRectCamera?: EntityLocator;
    screenRectBoundsMode?: VerificationScreenRectBoundsMode;
    runtimeAssertions?: VerificationRuntimeAssertion[];
    console?: boolean;
  };
  analysis?: {
    baselineFrameId?: string;
    stableTopFraction?: number;
    stableBottomFraction?: number;
    minLineFraction?: number;
    darkLumaThreshold?: number;
  };
}

export interface VerificationScenarioIssue {
  code: string;
  message: string;
  path: string;
}

export interface VerificationScenarioValidationResult {
  valid: boolean;
  issues: VerificationScenarioIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function push(issues: VerificationScenarioIssue[], code: string, message: string, path: string): void {
  issues.push({ code, message, path });
}

function validateLocator(value: unknown, path: string, issues: VerificationScenarioIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_LOCATOR", `${path} must be a locator object.`, path);
    return;
  }
  if (
    !isString(value.path) &&
    !isString(value.name) &&
    !isString(value.globalObjectId) &&
    !isString(value.instanceId) &&
    !isNumber(value.instanceId)
  ) {
    push(
      issues,
      "INVALID_LOCATOR",
      `${path} must include path, name, globalObjectId, or instanceId.`,
      path,
    );
  }
}

function validateOperation(value: unknown, path: string, issues: VerificationScenarioIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_OPERATION", `${path} must be an operation object.`, path);
    return;
  }
  if (!isString(value.command)) {
    push(issues, "MISSING_FIELD", `${path}.command is required.`, `${path}.command`);
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    push(issues, "INVALID_OPERATION", `${path}.params must be an object.`, `${path}.params`);
  }
  if (value.timeoutMs !== undefined && (!isNumber(value.timeoutMs) || value.timeoutMs < 1)) {
    push(issues, "INVALID_OPERATION", `${path}.timeoutMs must be a positive number.`, `${path}.timeoutMs`);
  }
}

function normalizeResetPolicy(value: unknown): VerificationResetPolicy | null {
  if (value === "none" || value === "reload-scene" || value === "spawn-before-sequence") {
    return { type: value };
  }
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type !== "none" && type !== "reload-scene" && type !== "spawn-before-sequence") return null;
  return value as unknown as VerificationResetPolicy;
}

function isCompleteDriver(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isRecord(value.locator) && isString(value.type_name) && isString(value.property_path);
}

function isRuntimeAssertionOperator(value: unknown): value is VerificationRuntimeAssertionOperator {
  return (
    value === "equals" ||
    value === "not_equals" ||
    value === "greater_than" ||
    value === "less_than" ||
    value === "approx" ||
    value === "contains"
  );
}

function validateCollect(value: unknown, path: string, issues: VerificationScenarioIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_COLLECT", `${path} must be an object.`, path);
    return;
  }

  if (value.screenRects !== undefined) {
    if (!Array.isArray(value.screenRects)) {
      push(issues, "INVALID_COLLECT", `${path}.screenRects must be an array.`, `${path}.screenRects`);
    } else {
      value.screenRects.forEach((locator, index) => {
        validateLocator(locator, `${path}.screenRects[${index}]`, issues);
      });
    }
  }

  if (value.screenRectCamera !== undefined) {
    validateLocator(value.screenRectCamera, `${path}.screenRectCamera`, issues);
  }

  if (
    value.screenRectBoundsMode !== undefined &&
    value.screenRectBoundsMode !== "opaque" &&
    value.screenRectBoundsMode !== "renderer" &&
    value.screenRectBoundsMode !== "collider"
  ) {
    push(
      issues,
      "INVALID_COLLECT",
      `${path}.screenRectBoundsMode must be opaque, renderer, or collider.`,
      `${path}.screenRectBoundsMode`,
    );
  }

  if (value.console !== undefined && typeof value.console !== "boolean") {
    push(issues, "INVALID_COLLECT", `${path}.console must be boolean.`, `${path}.console`);
  }

  if (value.runtimeAssertions !== undefined) {
    if (!Array.isArray(value.runtimeAssertions)) {
      push(
        issues,
        "INVALID_COLLECT",
        `${path}.runtimeAssertions must be an array.`,
        `${path}.runtimeAssertions`,
      );
    } else {
      value.runtimeAssertions.forEach((assertion, index) => {
        const assertionPath = `${path}.runtimeAssertions[${index}]`;
        if (!isRecord(assertion)) {
          push(issues, "INVALID_RUNTIME_ASSERTION", `${assertionPath} must be an object.`, assertionPath);
          return;
        }
        if (!isString(assertion.id)) {
          push(issues, "MISSING_FIELD", `${assertionPath}.id is required.`, `${assertionPath}.id`);
        }
        validateLocator(assertion.locator, `${assertionPath}.locator`, issues);
        if (assertion.component !== undefined && !isString(assertion.component)) {
          push(
            issues,
            "INVALID_RUNTIME_ASSERTION",
            `${assertionPath}.component must be a string.`,
            `${assertionPath}.component`,
          );
        }
        if (!isString(assertion.property_path)) {
          push(
            issues,
            "MISSING_FIELD",
            `${assertionPath}.property_path is required.`,
            `${assertionPath}.property_path`,
          );
        }
        if (!isRuntimeAssertionOperator(assertion.operator)) {
          push(
            issues,
            "INVALID_RUNTIME_ASSERTION",
            `${assertionPath}.operator must be equals, not_equals, greater_than, less_than, approx, or contains.`,
            `${assertionPath}.operator`,
          );
        }
        if (!Object.prototype.hasOwnProperty.call(assertion, "expected")) {
          push(issues, "MISSING_FIELD", `${assertionPath}.expected is required.`, `${assertionPath}.expected`);
        }
        if (assertion.tolerance !== undefined && (!isNumber(assertion.tolerance) || assertion.tolerance < 0)) {
          push(
            issues,
            "INVALID_RUNTIME_ASSERTION",
            `${assertionPath}.tolerance must be a non-negative number.`,
            `${assertionPath}.tolerance`,
          );
        }
        if (assertion.timeoutMs !== undefined && (!isNumber(assertion.timeoutMs) || assertion.timeoutMs < 1)) {
          push(
            issues,
            "INVALID_RUNTIME_ASSERTION",
            `${assertionPath}.timeoutMs must be a positive number.`,
            `${assertionPath}.timeoutMs`,
          );
        }
      });
    }
  }
}

export function getVerificationResetPolicy(scenario: VerificationScenario): VerificationResetPolicy {
  return normalizeResetPolicy(scenario.playMode.resetPolicy) ?? { type: "none" };
}

export function validateVerificationScenario(input: unknown): VerificationScenarioValidationResult {
  const issues: VerificationScenarioIssue[] = [];

  if (!isRecord(input)) {
    push(issues, "INVALID_DOCUMENT", "Verification scenario must be an object.", "scenario");
    return { valid: false, issues };
  }

  if (input.schemaVersion !== VERIFICATION_SCENARIO_SCHEMA_VERSION) {
    push(
      issues,
      "INVALID_SCHEMA_VERSION",
      `schemaVersion must be '${VERIFICATION_SCENARIO_SCHEMA_VERSION}'.`,
      "schemaVersion",
    );
  }
  if (!isString(input.id)) push(issues, "MISSING_FIELD", "id is required.", "id");
  if (!isString(input.gameKind)) push(issues, "MISSING_FIELD", "gameKind is required.", "gameKind");
  validateLocator(input.measure, "measure", issues);

  if (!isRecord(input.playMode)) {
    push(issues, "MISSING_FIELD", "playMode is required.", "playMode");
  } else {
    if (typeof input.playMode.enterOnce !== "boolean") {
      push(issues, "MISSING_FIELD", "playMode.enterOnce must be boolean.", "playMode.enterOnce");
    }
    const reset = normalizeResetPolicy(input.playMode.resetPolicy);
    if (!reset) {
      push(
        issues,
        "INVALID_RESET_POLICY",
        "playMode.resetPolicy must be none, reload-scene, spawn-before-sequence, or an object with type.",
        "playMode.resetPolicy",
      );
    } else {
      if (reset.type === "reload-scene" && !isString(reset.scenePath)) {
        push(
          issues,
          "MISSING_RESET_CONFIG",
          "reload-scene resetPolicy requires scenePath.",
          "playMode.resetPolicy.scenePath",
        );
      }
      if (reset.resetOperation !== undefined) {
        validateOperation(reset.resetOperation, "playMode.resetPolicy.resetOperation", issues);
      }
    }
  }

  if (input.driverDefaults !== undefined) {
    if (!isRecord(input.driverDefaults)) {
      push(issues, "INVALID_DRIVER_DEFAULTS", "driverDefaults must be an object.", "driverDefaults");
    } else {
      if (input.driverDefaults.locator !== undefined) {
        validateLocator(input.driverDefaults.locator, "driverDefaults.locator", issues);
      }
      for (const key of ["type_name", "property_path"]) {
        if (input.driverDefaults[key] !== undefined && !isString(input.driverDefaults[key])) {
          push(issues, "INVALID_DRIVER_DEFAULTS", `driverDefaults.${key} must be a string.`, `driverDefaults.${key}`);
        }
      }
    }
  }

  if (!Array.isArray(input.sequences) || input.sequences.length === 0) {
    push(issues, "MISSING_FIELD", "sequences must be a non-empty array.", "sequences");
  } else {
    const seenSequenceIds = new Set<string>();
    const seenCaptureIds = new Set<string>();
    input.sequences.forEach((sequence, sequenceIndex) => {
      const sequencePath = `sequences[${sequenceIndex}]`;
      if (!isRecord(sequence)) {
        push(issues, "INVALID_SEQUENCE", `${sequencePath} must be an object.`, sequencePath);
        return;
      }
      if (!isString(sequence.id)) {
        push(issues, "MISSING_FIELD", `${sequencePath}.id is required.`, `${sequencePath}.id`);
      } else if (seenSequenceIds.has(sequence.id)) {
        push(issues, "DUPLICATE_SEQUENCE_ID", `Duplicate sequence id '${sequence.id}'.`, `${sequencePath}.id`);
      } else {
        seenSequenceIds.add(sequence.id);
      }
      const hasSingleDriver =
        isCompleteDriver(sequence.driver) || isCompleteDriver(input.driverDefaults);
      if (sequence.driver !== undefined) {
        if (!isRecord(sequence.driver)) {
          push(issues, "INVALID_DRIVER", `${sequencePath}.driver must be an object.`, `${sequencePath}.driver`);
        } else {
          validateLocator(sequence.driver.locator, `${sequencePath}.driver.locator`, issues);
          if (!isString(sequence.driver.type_name)) {
            push(issues, "MISSING_FIELD", `${sequencePath}.driver.type_name is required.`, `${sequencePath}.driver.type_name`);
          }
          if (!isString(sequence.driver.property_path)) {
            push(issues, "MISSING_FIELD", `${sequencePath}.driver.property_path is required.`, `${sequencePath}.driver.property_path`);
          }
        }
      }
      if (!Array.isArray(sequence.phases) || sequence.phases.length === 0) {
        push(issues, "MISSING_FIELD", `${sequencePath}.phases must be a non-empty array.`, `${sequencePath}.phases`);
      } else {
        sequence.phases.forEach((phase, phaseIndex) => {
          const phasePath = `${sequencePath}.phases[${phaseIndex}]`;
          if (!isRecord(phase)) {
            push(issues, "INVALID_PHASE", `${phasePath} must be an object.`, phasePath);
            return;
          }
          if (!isNumber(phase.durationMs) || phase.durationMs <= 0) {
            push(issues, "INVALID_PHASE", `${phasePath}.durationMs must be > 0.`, `${phasePath}.durationMs`);
          }
          if (phase.value !== undefined && typeof phase.value !== "number" && typeof phase.value !== "boolean") {
            push(issues, "INVALID_PHASE", `${phasePath}.value must be number or boolean.`, `${phasePath}.value`);
          }
          const hasPhaseDrivers = Array.isArray(phase.drivers) && phase.drivers.length > 0;
          if (!hasPhaseDrivers) {
            if (!hasSingleDriver) {
              push(
                issues,
                "MISSING_DRIVER",
                `${phasePath} must define drivers[] or the sequence/scenario must define a single driver.`,
                phasePath,
              );
            } else if (phase.value === undefined) {
              push(
                issues,
                "MISSING_PHASE_VALUE",
                `${phasePath}.value is required when using a sequence/default single driver.`,
                `${phasePath}.value`,
              );
            }
          }
          if (phase.drivers !== undefined) {
            if (!Array.isArray(phase.drivers) || phase.drivers.length === 0) {
              push(issues, "INVALID_PHASE", `${phasePath}.drivers must be a non-empty array.`, `${phasePath}.drivers`);
            } else {
              phase.drivers.forEach((driver, driverIndex) => {
                const driverPath = `${phasePath}.drivers[${driverIndex}]`;
                if (!isRecord(driver)) {
                  push(issues, "INVALID_DRIVER", `${driverPath} must be an object.`, driverPath);
                  return;
                }
                validateLocator(driver.locator, `${driverPath}.locator`, issues);
                if (!isString(driver.type_name)) push(issues, "MISSING_FIELD", `${driverPath}.type_name is required.`, `${driverPath}.type_name`);
                if (!isString(driver.property_path)) push(issues, "MISSING_FIELD", `${driverPath}.property_path is required.`, `${driverPath}.property_path`);
                if (typeof driver.value !== "number" && typeof driver.value !== "boolean") {
                  push(issues, "MISSING_FIELD", `${driverPath}.value must be number or boolean.`, `${driverPath}.value`);
                }
              });
            }
          }
        });
      }
      if (!Array.isArray(sequence.captures) || sequence.captures.length === 0) {
        push(issues, "MISSING_FIELD", `${sequencePath}.captures must be a non-empty array.`, `${sequencePath}.captures`);
      } else {
        sequence.captures.forEach((capture, captureIndex) => {
          const capturePath = `${sequencePath}.captures[${captureIndex}]`;
          if (!isRecord(capture)) {
            push(issues, "INVALID_CAPTURE", `${capturePath} must be an object.`, capturePath);
            return;
          }
          if (!isString(capture.id)) {
            push(issues, "MISSING_FIELD", `${capturePath}.id is required.`, `${capturePath}.id`);
          } else {
            const scoped = `${sequence.id ?? sequenceIndex}:${capture.id}`;
            if (seenCaptureIds.has(scoped)) {
              push(issues, "DUPLICATE_CAPTURE_ID", `Duplicate capture id '${capture.id}' in sequence.`, `${capturePath}.id`);
            }
            seenCaptureIds.add(scoped);
          }
          if (
            capture.trigger !== undefined &&
            capture.trigger !== "start" &&
            capture.trigger !== "end" &&
            capture.trigger !== "atMs" &&
            capture.trigger !== "apexY"
          ) {
            push(issues, "INVALID_CAPTURE", `${capturePath}.trigger is unsupported.`, `${capturePath}.trigger`);
          }
          if (capture.trigger === "atMs" && !isNumber(capture.atMs)) {
            push(issues, "MISSING_FIELD", `${capturePath}.atMs is required for trigger atMs.`, `${capturePath}.atMs`);
          }
        });
      }
    });
  }

  if (input.collect !== undefined) {
    validateCollect(input.collect, "collect", issues);
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidVerificationScenario(input: unknown): VerificationScenario {
  const result = validateVerificationScenario(input);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Verification scenario validation failed: ${summary}`);
  }
  return input as VerificationScenario;
}
