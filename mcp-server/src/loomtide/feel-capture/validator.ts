import {
  type FeelCaptureContract,
  type FeelCaptureInteraction,
  type FeelCaptureSignal,
  type FeelSemanticProbeMetric,
} from "./types.js";

export interface FeelCaptureValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface FeelCaptureValidationResult {
  valid: boolean;
  issues: FeelCaptureValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function push(
  issues: FeelCaptureValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateLocator(value: unknown, path: string, issues: FeelCaptureValidationIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_LOCATOR", path, "locator must be an object.");
    return;
  }
  if (!isNonEmptyString(value.path)) {
    push(issues, "INVALID_LOCATOR", `${path}.path`, "locator.path must be a non-empty string.");
  }
}

function validateSignal(signal: unknown, path: string, issues: FeelCaptureValidationIssue[]): void {
  if (!isRecord(signal)) {
    push(issues, "INVALID_SIGNAL", path, "signal must be an object.");
    return;
  }
  if (!isNonEmptyString(signal.id)) push(issues, "INVALID_SIGNAL", `${path}.id`, "signal.id is required.");
  validateLocator(signal.locator, `${path}.locator`, issues);
  if (!isNonEmptyString(signal.type_name)) {
    push(issues, "INVALID_SIGNAL", `${path}.type_name`, "signal.type_name is required.");
  }
  const hasProperty = signal.property_path !== undefined;
  const hasMethod = signal.method_name !== undefined;
  if (hasProperty === hasMethod) {
    push(
      issues,
      "INVALID_SIGNAL_READER",
      path,
      "signal must specify exactly one of property_path or method_name.",
    );
  }
  if (hasProperty && !isNonEmptyString(signal.property_path)) {
    push(issues, "INVALID_SIGNAL_READER", `${path}.property_path`, "property_path must be non-empty.");
  }
  if (hasMethod && !isNonEmptyString(signal.method_name)) {
    push(issues, "INVALID_SIGNAL_READER", `${path}.method_name`, "method_name must be non-empty.");
  }
  if (signal.args !== undefined && !Array.isArray(signal.args)) {
    push(issues, "INVALID_SIGNAL_READER", `${path}.args`, "args must be an array when present.");
  }
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function locatorKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return JSON.stringify({
    scene: typeof value.scene === "string" ? value.scene : undefined,
    path: typeof value.path === "string" ? value.path : undefined,
    globalObjectId: typeof value.globalObjectId === "string" ? value.globalObjectId : undefined,
    instanceId: typeof value.instanceId === "string" ? value.instanceId : undefined,
  });
}

function validateSettle(
  value: unknown,
  path: string,
  issues: FeelCaptureValidationIssue[],
  interactionMeasure?: unknown,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    push(issues, "INVALID_SETTLE", path, "settle must be an object.");
    return;
  }
  if (value.kind !== "settle-until-rest") {
    push(issues, "UNKNOWN_SETTLE_KIND", `${path}.kind`, `unknown settle kind '${String(value.kind)}'.`);
    return;
  }
  validateLocator(value.measure, `${path}.measure`, issues);
  if (
    interactionMeasure !== undefined
    && locatorKey(value.measure) !== undefined
    && locatorKey(interactionMeasure) !== undefined
    && locatorKey(value.measure) !== locatorKey(interactionMeasure)
  ) {
    push(
      issues,
      "INVALID_SETTLE_MEASURE",
      `${path}.measure`,
      "settle.measure must exactly match the interaction measure so rest is proven on the measured subject.",
    );
  }
  if (value.timeoutMs !== undefined && !positiveNumber(value.timeoutMs)) {
    push(issues, "INVALID_SETTLE", `${path}.timeoutMs`, "settle.timeoutMs must be a finite number > 0 when present.");
  }
  if (value.pollMs !== undefined && !positiveNumber(value.pollMs)) {
    push(issues, "INVALID_SETTLE", `${path}.pollMs`, "settle.pollMs must be a finite number > 0 when present.");
  }
  if (value.minStableSamples !== undefined && !positiveInteger(value.minStableSamples)) {
    push(issues, "INVALID_SETTLE", `${path}.minStableSamples`, "settle.minStableSamples must be a positive integer when present.");
  }
  if (value.minStableMs !== undefined && !positiveNumber(value.minStableMs)) {
    push(issues, "INVALID_SETTLE", `${path}.minStableMs`, "settle.minStableMs must be a finite number > 0 when present.");
  }
  if (value.restThreshold !== undefined && !positiveNumber(value.restThreshold)) {
    push(issues, "INVALID_SETTLE", `${path}.restThreshold`, "settle.restThreshold must be a finite number > 0 when present.");
  }
}

function validatePrecondition(value: unknown, path: string, issues: FeelCaptureValidationIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_PRECONDITION", path, "precondition must be an object.");
    return;
  }
  if (value.kind !== "scene-set-active") {
    push(issues, "UNKNOWN_PRECONDITION_KIND", `${path}.kind`, `unknown precondition kind '${String(value.kind)}'.`);
    return;
  }
  validateLocator(value.locator, `${path}.locator`, issues);
  if (typeof value.active !== "boolean") {
    push(issues, "INVALID_PRECONDITION", `${path}.active`, "scene-set-active precondition requires boolean active.");
  }
  if (value.restore !== undefined && typeof value.restore !== "boolean") {
    push(issues, "INVALID_PRECONDITION", `${path}.restore`, "restore must be boolean when present.");
  }
}

function validateUniqueIds(
  items: unknown[],
  path: string,
  issues: FeelCaptureValidationIssue[],
  code: string,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (!isRecord(item) || !isNonEmptyString(item.id)) return;
    if (seen.has(item.id)) {
      push(issues, code, `${path}.${i}.id`, `duplicate id '${item.id}'.`);
      return;
    }
    seen.add(item.id);
  });
}

function validateSemanticProbe(value: Record<string, unknown>, path: string, issues: FeelCaptureValidationIssue[]): void {
  const metric = value.metric;
  if (metric !== "coyoteTime" && metric !== "jumpBuffer") {
    push(issues, "INVALID_SEMANTIC_PROBE", `${path}.metric`, "semantic-probe metric must be coyoteTime or jumpBuffer.");
  }
  validateLocator(value.measure, `${path}.measure`, issues);

  const anchors = Array.isArray(value.anchors) ? value.anchors : undefined;
  if (!anchors || anchors.length === 0) {
    push(issues, "INVALID_SEMANTIC_ANCHORS", `${path}.anchors`, "semantic-probe requires non-empty anchors.");
  } else {
    validateUniqueIds(anchors, `${path}.anchors`, issues, "DUPLICATE_SEMANTIC_ANCHOR_ID");
    anchors.forEach((anchor, i) => {
      if (!isRecord(anchor)) {
        push(issues, "INVALID_SEMANTIC_ANCHOR", `${path}.anchors.${i}`, "semantic anchor must be an object.");
        return;
      }
      if (!isNonEmptyString(anchor.id)) {
        push(issues, "INVALID_SEMANTIC_ANCHOR", `${path}.anchors.${i}.id`, "semantic anchor id is required.");
      }
      if (
        anchor.kind !== "ground-lost"
        && anchor.kind !== "grounded-ready"
        && anchor.kind !== "jump-input"
        && anchor.kind !== "pre-jump-buffered-input"
      ) {
        push(issues, "INVALID_SEMANTIC_ANCHOR", `${path}.anchors.${i}.kind`, "unknown semantic anchor kind.");
      }
      if (typeof anchor.phaseIndex !== "number" || !Number.isInteger(anchor.phaseIndex) || anchor.phaseIndex < 0) {
        push(issues, "INVALID_SEMANTIC_ANCHOR", `${path}.anchors.${i}.phaseIndex`, "semantic anchor phaseIndex must be a non-negative integer.");
      }
    });
    const kinds = new Set(
      anchors
        .filter(isRecord)
        .map((anchor) => anchor.kind)
        .filter((kind): kind is string => typeof kind === "string"),
    );
    const requiredKinds: Record<FeelSemanticProbeMetric, string[]> = {
      coyoteTime: ["ground-lost", "jump-input"],
      jumpBuffer: ["pre-jump-buffered-input", "grounded-ready"],
    };
    if (metric === "coyoteTime" || metric === "jumpBuffer") {
      for (const kind of requiredKinds[metric]) {
        if (!kinds.has(kind)) {
          push(issues, "MISSING_SEMANTIC_ANCHOR", `${path}.anchors`, `${metric} semantic-probe requires a ${kind} anchor.`);
        }
      }
    }
  }

  const trials = Array.isArray(value.trials) ? value.trials : undefined;
  if (!trials || trials.length < 2) {
    push(issues, "INVALID_SEMANTIC_TRIALS", `${path}.trials`, "semantic-probe requires at least two bisection trials.");
  } else {
    trials.forEach((trial, trialIndex) => {
      if (!isRecord(trial)) {
        push(issues, "INVALID_SEMANTIC_TRIAL", `${path}.trials.${trialIndex}`, "semantic trial must be an object.");
        return;
      }
      if (!positiveNumber(trial.delayMs)) {
        push(issues, "INVALID_SEMANTIC_TRIAL", `${path}.trials.${trialIndex}.delayMs`, "semantic trial delayMs must be a finite number > 0.");
      }
      if (!Array.isArray(trial.phases) || trial.phases.length === 0) {
        push(issues, "INVALID_SEMANTIC_TRIAL", `${path}.trials.${trialIndex}.phases`, "semantic trial requires non-empty runtime probe phases.");
        return;
      }
      const phases = trial.phases;
      if (anchors) {
        anchors.forEach((anchor, anchorIndex) => {
          if (!isRecord(anchor) || typeof anchor.phaseIndex !== "number") return;
          if (anchor.phaseIndex >= phases.length) {
            push(
              issues,
              "SEMANTIC_ANCHOR_OUT_OF_RANGE",
              `${path}.anchors.${anchorIndex}.phaseIndex`,
              `semantic anchor phaseIndex ${anchor.phaseIndex} is outside trial ${trialIndex} phases.`,
            );
          }
        });
      }
      phases.forEach((phase, phaseIndex) => {
        if (!isRecord(phase)) {
          push(issues, "INVALID_SEMANTIC_PHASE", `${path}.trials.${trialIndex}.phases.${phaseIndex}`, "semantic trial phase must be an object.");
          return;
        }
        if (!positiveNumber(phase.durationMs)) {
          push(issues, "INVALID_SEMANTIC_PHASE", `${path}.trials.${trialIndex}.phases.${phaseIndex}.durationMs`, "semantic phase durationMs must be a finite number > 0.");
        }
        if (phase.drivers !== undefined) {
          if (!Array.isArray(phase.drivers) || phase.drivers.length === 0) {
            push(issues, "INVALID_SEMANTIC_DRIVER", `${path}.trials.${trialIndex}.phases.${phaseIndex}.drivers`, "semantic phase drivers must be a non-empty array when present.");
          } else {
            phase.drivers.forEach((driver, driverIndex) => {
              const driverPath = `${path}.trials.${trialIndex}.phases.${phaseIndex}.drivers.${driverIndex}`;
              if (!isRecord(driver)) {
                push(issues, "INVALID_SEMANTIC_DRIVER", driverPath, "semantic driver must be an object.");
                return;
              }
              validateLocator(driver.locator, `${driverPath}.locator`, issues);
              if (!isNonEmptyString(driver.type_name)) push(issues, "INVALID_SEMANTIC_DRIVER", `${driverPath}.type_name`, "semantic driver type_name is required.");
              if (!isNonEmptyString(driver.property_path)) push(issues, "INVALID_SEMANTIC_DRIVER", `${driverPath}.property_path`, "semantic driver property_path is required.");
              if (typeof driver.value !== "number" && typeof driver.value !== "boolean") {
                push(issues, "INVALID_SEMANTIC_DRIVER", `${driverPath}.value`, "semantic driver value must be number or boolean.");
              }
            });
          }
        } else {
          push(
            issues,
            "MISSING_SEMANTIC_DRIVER",
            `${path}.trials.${trialIndex}.phases.${phaseIndex}.drivers`,
            "semantic probe phases must declare drivers[]; runtime.probe has no generic no-op phase form.",
          );
        }
      });
    });
  }

  const jumpEvidence = value.jumpEvidence;
  if (!isRecord(jumpEvidence)) {
    push(issues, "INVALID_SEMANTIC_JUMP_EVIDENCE", `${path}.jumpEvidence`, "semantic-probe requires jumpEvidence.");
  } else {
    if (jumpEvidence.kind !== "trajectory-rise") {
      push(issues, "INVALID_SEMANTIC_JUMP_EVIDENCE", `${path}.jumpEvidence.kind`, "jumpEvidence.kind must be trajectory-rise.");
    }
    if (!isNonEmptyString(jumpEvidence.afterAnchorId)) {
      push(issues, "INVALID_SEMANTIC_JUMP_EVIDENCE", `${path}.jumpEvidence.afterAnchorId`, "jumpEvidence.afterAnchorId is required.");
    } else if (anchors && !anchors.some((anchor) => isRecord(anchor) && anchor.id === jumpEvidence.afterAnchorId)) {
      push(issues, "UNKNOWN_SEMANTIC_ANCHOR", `${path}.jumpEvidence.afterAnchorId`, `unknown semantic anchor '${jumpEvidence.afterAnchorId}'.`);
    }
    if (jumpEvidence.minRise !== undefined && !positiveNumber(jumpEvidence.minRise)) {
      push(issues, "INVALID_SEMANTIC_JUMP_EVIDENCE", `${path}.jumpEvidence.minRise`, "jumpEvidence.minRise must be a finite number > 0 when present.");
    }
  }

  if (value.captureFps !== undefined && !positiveNumber(value.captureFps)) {
    push(issues, "INVALID_SEMANTIC_PROBE", `${path}.captureFps`, "semantic-probe captureFps must be a finite number > 0 when present.");
  }
}

function sampledFields(interaction: Record<string, unknown>): unknown[] {
  return Array.isArray(interaction.sampledFields) ? interaction.sampledFields : [];
}

function validateInteraction(value: unknown, path: string, issues: FeelCaptureValidationIssue[]): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_INTERACTION", path, "interaction must be an object.");
    return;
  }
  if (!isNonEmptyString(value.id)) {
    push(issues, "INVALID_INTERACTION", `${path}.id`, "interaction.id is required.");
  }
  const kind = value.kind;
  if (!isNonEmptyString(kind)) {
    push(issues, "INVALID_INTERACTION", `${path}.kind`, "interaction.kind is required.");
    return;
  }

  switch (kind) {
    case "keyboard":
      validateLocator(value.measure, `${path}.measure`, issues);
      validateSettle(value.settle, `${path}.settle`, issues, value.measure);
      if (!Array.isArray(value.phases) || value.phases.length === 0) {
        push(issues, "INVALID_INTERACTION", `${path}.phases`, "keyboard requires non-empty phases.");
      } else {
        value.phases.forEach((phase, i) => {
          if (!isRecord(phase)) {
            push(issues, "INVALID_INTERACTION", `${path}.phases.${i}`, "keyboard phase must be an object.");
            return;
          }
          const hasDurationMs = phase.durationMs !== undefined;
          const hasFixedTicks = phase.fixedTicks !== undefined;
          if (hasDurationMs === hasFixedTicks) {
            push(issues, "INVALID_INTERACTION", `${path}.phases.${i}`, "keyboard phase must specify exactly one of durationMs or fixedTicks.");
          }
          if (hasDurationMs && (typeof phase.durationMs !== "number" || !Number.isFinite(phase.durationMs) || phase.durationMs <= 0)) {
            push(issues, "INVALID_INTERACTION", `${path}.phases.${i}.durationMs`, "durationMs must be a finite number > 0.");
          }
          if (hasFixedTicks && (typeof phase.fixedTicks !== "number" || !Number.isFinite(phase.fixedTicks) || !Number.isInteger(phase.fixedTicks) || phase.fixedTicks <= 0)) {
            push(issues, "INVALID_INTERACTION", `${path}.phases.${i}.fixedTicks`, "fixedTicks must be a positive integer.");
          }
          if (phase.keys !== undefined && (!Array.isArray(phase.keys) || phase.keys.some((k) => !isNonEmptyString(k)))) {
            push(issues, "INVALID_INTERACTION", `${path}.phases.${i}.keys`, "keys must be an array of non-empty strings when present.");
          }
        });
      }
      break;
    case "ugui-tap":
      validateLocator(value.measure, `${path}.measure`, issues);
      validateLocator(value.target, `${path}.target`, issues);
      break;
    case "ugui-multitap":
      validateLocator(value.measure, `${path}.measure`, issues);
      validateLocator(value.target, `${path}.target`, issues);
      if (!Array.isArray(value.taps) || value.taps.length === 0) {
        push(issues, "INVALID_INTERACTION", `${path}.taps`, "ugui-multitap requires non-empty taps.");
      } else {
        let prev = -Infinity;
        value.taps.forEach((tap, i) => {
          if (!isRecord(tap) || typeof tap.atMs !== "number" || !Number.isFinite(tap.atMs) || tap.atMs < 0 || tap.atMs < prev) {
            push(issues, "INVALID_INTERACTION", `${path}.taps.${i}.atMs`, "tap atMs values must be finite, >= 0, and ascending.");
          }
          if (isRecord(tap) && typeof tap.atMs === "number") prev = tap.atMs;
        });
      }
      break;
    case "ugui-hold-drag":
      validateLocator(value.measure, `${path}.measure`, issues);
      validateLocator(value.target, `${path}.target`, issues);
      if (!isRecord(value.dragTo)) {
        push(issues, "INVALID_INTERACTION", `${path}.dragTo`, "ugui-hold-drag requires dragTo.");
      } else {
        const dx = value.dragTo.dx;
        const dy = value.dragTo.dy;
        const valid = typeof dx === "number" && Number.isFinite(dx)
          && typeof dy === "number" && Number.isFinite(dy)
          && (dx !== 0 || dy !== 0);
        if (!valid) push(issues, "INVALID_INTERACTION", `${path}.dragTo`, "dragTo dx/dy must be finite and non-zero.");
      }
      break;
    case "ugui-hold":
      validateLocator(value.measure, `${path}.measure`, issues);
      validateLocator(value.target, `${path}.target`, issues);
      validateSettle(value.settle, `${path}.settle`, issues, value.measure);
      if (typeof value.holdFixedTicks !== "number" || !Number.isFinite(value.holdFixedTicks) || !Number.isInteger(value.holdFixedTicks) || value.holdFixedTicks <= 0) {
        push(issues, "INVALID_INTERACTION", `${path}.holdFixedTicks`, "ugui-hold requires positive integer holdFixedTicks.");
      }
      break;
    case "world-pointer":
      validateLocator(value.measure, `${path}.measure`, issues);
      if (typeof value.x !== "number" || !Number.isFinite(value.x)) {
        push(issues, "INVALID_INTERACTION", `${path}.x`, "world-pointer requires finite x.");
      }
      if (typeof value.y !== "number" || !Number.isFinite(value.y)) {
        push(issues, "INVALID_INTERACTION", `${path}.y`, "world-pointer requires finite y.");
      }
      break;
    case "trace-replay":
      if (!isNonEmptyString(value.traceId)) {
        push(issues, "INVALID_INTERACTION", `${path}.traceId`, "trace-replay requires traceId.");
      }
      break;
    case "semantic-probe":
      validateSemanticProbe(value, path, issues);
      break;
    case "unsupported":
      if (!isNonEmptyString(value.reason)) {
        push(issues, "INVALID_INTERACTION", `${path}.reason`, "unsupported requires a reason.");
      }
      break;
    default:
      push(issues, "UNKNOWN_INTERACTION_KIND", `${path}.kind`, `unknown interaction kind '${kind}'.`);
  }

  sampledFields(value).forEach((signal, i) => validateSignal(signal, `${path}.sampledFields.${i}`, issues));
}

export function validateFeelCaptureContract(input: unknown): FeelCaptureValidationResult {
  const issues: FeelCaptureValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_DOCUMENT", path: "", message: "contract must be an object." }],
    };
  }
  if (input.schemaVersion !== "1") {
    push(issues, "INVALID_SCHEMA_VERSION", "schemaVersion", "schemaVersion must be '1'.");
  }
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) {
    push(issues, "INVALID_SUBJECTS", "subjects", "at least one subject is required.");
  } else {
    validateUniqueIds(input.subjects, "subjects", issues, "DUPLICATE_SUBJECT_ID");
    input.subjects.forEach((subject, i) => {
      if (!isRecord(subject)) {
        push(issues, "INVALID_SUBJECT", `subjects.${i}`, "subject must be an object.");
        return;
      }
      if (!isNonEmptyString(subject.id)) push(issues, "INVALID_SUBJECT", `subjects.${i}.id`, "subject.id is required.");
      validateLocator(subject.locator, `subjects.${i}.locator`, issues);
    });
  }

  if (!Array.isArray(input.interactions)) {
    push(issues, "INVALID_INTERACTIONS", "interactions", "interactions must be an array.");
  } else {
    validateUniqueIds(input.interactions, "interactions", issues, "DUPLICATE_INTERACTION_ID");
    input.interactions.forEach((interaction, i) => validateInteraction(interaction, `interactions.${i}`, issues));
  }
  if (Array.isArray(input.signals)) {
    validateUniqueIds(input.signals, "signals", issues, "DUPLICATE_SIGNAL_ID");
    input.signals.forEach((signal, i) => validateSignal(signal, `signals.${i}`, issues));
  }
  if (Array.isArray(input.interactions)) {
    input.interactions.forEach((interaction, i) => {
      if (!isRecord(interaction)) return;
      const fields = sampledFields(interaction);
      if (fields.length > 0) {
        validateUniqueIds(fields, `interactions.${i}.sampledFields`, issues, "DUPLICATE_SIGNAL_ID");
      }
    });
  }
  if (Array.isArray(input.preconditions)) {
    input.preconditions.forEach((precondition, i) => validatePrecondition(precondition, `preconditions.${i}`, issues));
  }

  const interactionIds = new Set(
    Array.isArray(input.interactions)
      ? input.interactions
        .filter((v): v is FeelCaptureInteraction => isRecord(v) && isNonEmptyString(v.id))
        .map((v) => v.id)
      : [],
  );
  if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
    push(issues, "INVALID_METRICS", "metrics", "at least one metric recipe is required.");
  } else {
    input.metrics.forEach((metric, i) => {
      const p = `metrics.${i}`;
      if (!isRecord(metric)) {
        push(issues, "INVALID_METRIC", p, "metric recipe must be an object.");
        return;
      }
      if (!isNonEmptyString(metric.metric)) push(issues, "INVALID_METRIC", `${p}.metric`, "metric is required.");
      if (!isNonEmptyString(metric.derivation)) push(issues, "INVALID_METRIC", `${p}.derivation`, "derivation is required.");
      if (metric.derivation === "unsupported" || metric.derivation === "reported") {
        if (metric.interactionId !== undefined) {
          push(issues, "INVALID_METRIC", `${p}.interactionId`, "unsupported/reported metrics must not bind to an interaction.");
        }
      } else if (!isNonEmptyString(metric.interactionId)) {
        push(issues, "MISSING_INTERACTION", `${p}.interactionId`, "metric requires an interactionId.");
      } else if (!interactionIds.has(metric.interactionId)) {
        push(issues, "UNKNOWN_INTERACTION", `${p}.interactionId`, `unknown interaction '${metric.interactionId}'.`);
      }
      if (metric.derivation === "unsupported" && !isNonEmptyString(metric.reason)) {
        push(issues, "MISSING_UNSUPPORTED_REASON", `${p}.reason`, "unsupported metric requires a reason.");
      }
      if (metric.derivation === "phase-delta") {
        if (typeof metric.phaseIndex !== "number" || !Number.isInteger(metric.phaseIndex) || metric.phaseIndex < 0) {
          push(issues, "INVALID_METRIC", `${p}.phaseIndex`, "phase-delta metric requires a non-negative integer phaseIndex.");
        }
        if (metric.axis !== undefined && metric.axis !== "x" && metric.axis !== "y") {
          push(issues, "INVALID_METRIC", `${p}.axis`, "phase-delta metric axis must be 'x' or 'y'.");
        }
        if (metric.requiredKeys !== undefined && (!Array.isArray(metric.requiredKeys) || !metric.requiredKeys.every(isNonEmptyString))) {
          push(issues, "INVALID_METRIC", `${p}.requiredKeys`, "phase-delta metric requiredKeys must be non-empty strings when present.");
        }
      }
      if (metric.derivation === "bisection") {
        if (metric.metric !== "coyoteTime" && metric.metric !== "jumpBuffer") {
          push(issues, "INVALID_METRIC", `${p}.metric`, "bisection derivation is only valid for coyoteTime or jumpBuffer.");
        }
        const interaction = Array.isArray(input.interactions)
          ? input.interactions.find((candidate) =>
            isRecord(candidate) && candidate.id === metric.interactionId)
          : undefined;
        if (interaction && isRecord(interaction) && interaction.kind !== "semantic-probe") {
          push(issues, "INVALID_METRIC", `${p}.interactionId`, "bisection derivation requires a semantic-probe interaction.");
        }
      }
      if (metric.stimulus !== undefined) {
        if (!isRecord(metric.stimulus)) {
          push(issues, "INVALID_METRIC_STIMULUS", `${p}.stimulus`, "stimulus must be an object when present.");
        } else {
          if (metric.stimulus.metric !== metric.metric) {
            push(issues, "INVALID_METRIC_STIMULUS", `${p}.stimulus.metric`, "stimulus.metric must match metric.");
          }
          if (metric.stimulus.tapTicks !== undefined && (
            typeof metric.stimulus.tapTicks !== "number"
            || !Number.isFinite(metric.stimulus.tapTicks)
            || !Number.isInteger(metric.stimulus.tapTicks)
            || metric.stimulus.tapTicks <= 0
          )) {
            push(issues, "INVALID_METRIC_STIMULUS", `${p}.stimulus.tapTicks`, "stimulus.tapTicks must be a positive integer when present.");
          }
          if (metric.stimulus.phases !== undefined && !isNonEmptyString(metric.stimulus.phases)) {
            push(issues, "INVALID_METRIC_STIMULUS", `${p}.stimulus.phases`, "stimulus.phases must be a non-empty string when present.");
          }
        }
      }
    });
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidFeelCaptureContract(input: unknown): FeelCaptureContract {
  const result = validateFeelCaptureContract(input);
  if (!result.valid) {
    const first = result.issues[0];
    throw new Error(`${first.path}: ${first.message}`);
  }
  return input as FeelCaptureContract;
}

export function sampledFieldsForBridge(fields: FeelCaptureSignal[] | undefined): Record<string, unknown>[] | undefined {
  if (!fields || fields.length === 0) return undefined;
  return fields.map((f) => ({
    id: f.id,
    locator: f.locator,
    type_name: f.type_name,
    ...(f.property_path === undefined ? {} : { property_path: f.property_path }),
    ...(f.method_name === undefined ? {} : { method_name: f.method_name }),
    ...(f.args === undefined ? {} : { args: f.args }),
  }));
}
