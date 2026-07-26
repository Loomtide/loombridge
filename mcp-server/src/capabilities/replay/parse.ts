/**
 * Replay Verification — trace parser/validator (Phase A, slice A1).
 *
 * `parseTrace(json)` validates an untrusted object into a `ReplayTrace`,
 * REFUSING (throwing) when a required field is absent or malformed rather than
 * coercing a partial trace into a silent run — the same "refuse when a bound
 * field is absent" discipline the verification gates use. It is intentionally a
 * small hand-rolled validator (no schema dependency), matching the explicit,
 * dependency-light style of the rest of the loombridge modules.
 */

import type {
  Action,
  Anchor,
  Assertion,
  Capture,
  ConditionOperator,
  Locator,
  ReplayTrace,
  ResetHook,
  ResetVerify,
  Segment,
} from "./types.js";

const OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "approx",
  "contains",
]);

export class TraceParseError extends Error {
  constructor(message: string) {
    super(`Invalid replay trace: ${message}`);
    this.name = "TraceParseError";
  }
}

export function parseTrace(input: unknown): ReplayTrace {
  const root = asObject(input, "trace");

  if (root.schemaVersion !== "0.1") {
    throw new TraceParseError(
      `schemaVersion must be "0.1" (got ${JSON.stringify(root.schemaVersion)})`,
    );
  }

  const id = requireId(root.id, "id");

  const start = asObject(root.start, "start");
  const scene = requireString(start.scene, "start.scene");
  const reset = parseReset(start.reset);

  const inputObj = asObject(root.input, "input");
  if (inputObj.backend !== "ui-events" && inputObj.backend !== "input-system") {
    throw new TraceParseError(
      `input.backend must be "ui-events" or "input-system" (got ${JSON.stringify(
        inputObj.backend,
      )})`,
    );
  }
  const backend = inputObj.backend;

  const segmentsRaw = requireArray(root.segments, "segments");
  if (segmentsRaw.length === 0) {
    throw new TraceParseError("segments must not be empty");
  }
  const segments = segmentsRaw.map((s, i) => parseSegment(s, `segments[${i}]`));
  const segmentIds = new Set<string>();
  for (const segment of segments) {
    if (segmentIds.has(segment.id)) {
      throw new TraceParseError(`duplicate segment id ${JSON.stringify(segment.id)}`);
    }
    segmentIds.add(segment.id);
  }

  const assertions = root.assertions === undefined
    ? undefined
    : requireArray(root.assertions, "assertions").map((a, i) =>
        parseAssertion(a, `assertions[${i}]`),
      );

  const outcome = asObject(root.outcome, "outcome");
  if (outcome.expected !== "success" && outcome.expected !== "failure") {
    throw new TraceParseError(
      `outcome.expected must be "success" or "failure" (got ${JSON.stringify(
        outcome.expected,
      )})`,
    );
  }

  // A negative-flow trace verifies that an intended failure OCCURRED — it must
  // declare something that observes it. Without any anchor or assertion the run
  // would pass on "the actions ran + console stayed clean", which is the exact
  // opposite of the failure it claims to verify. Refuse it rather than emit that
  // silent green (the engine treats `outcome.expected` as descriptive; the
  // observation contract is the anchors/assertions, so they must exist).
  if (outcome.expected === "failure") {
    const hasAnchor = segments.some((s) => (s.anchors?.length ?? 0) > 0);
    const hasAssertion = (assertions?.length ?? 0) > 0;
    if (!hasAnchor && !hasAssertion) {
      throw new TraceParseError(
        'an outcome.expected:"failure" trace must declare at least one anchor or assertion to observe the failure it verifies',
      );
    }
  }

  return {
    schemaVersion: "0.1",
    id,
    title: optionalString(root.title, "title"),
    intent: optionalString(root.intent, "intent"),
    start: { scene, reset },
    input: { backend },
    segments,
    assertions,
    outcome: { expected: outcome.expected },
  };
}

function parseReset(value: unknown): ReplayTrace["start"]["reset"] {
  if (value === "scene-load") return "scene-load";
  if (value === "relaunch") return "relaunch";
  if (isObject(value)) {
    if (typeof value.hook === "string") {
      throw new TraceParseError(
        'start.reset.hook is now { do: "tap"|"set", ... }, not a string',
      );
    }
    if (value.hook === undefined) {
      throw new TraceParseError('start.reset object must declare a "hook"');
    }
    return { hook: parseResetHook(value.hook) };
  }
  throw new TraceParseError(
    'start.reset must be "scene-load", "relaunch", or { hook: { do: "tap"|"set", ... } }',
  );
}

function parseResetHook(value: unknown): ResetHook {
  const obj = asObject(value, "start.reset.hook");
  const verify = obj.verify === undefined ? undefined : parseResetVerify(obj.verify);
  if (obj.do === "tap") {
    return { do: "tap", locator: parseLocator(obj.locator, "start.reset.hook.locator"), verify };
  }
  if (obj.do === "set") {
    // value is optional (the driver defaults it to true).
    return {
      do: "set",
      locator: parseLocator(obj.locator, "start.reset.hook.locator"),
      component: requireString(obj.component, "start.reset.hook.component"),
      property: requireString(obj.property, "start.reset.hook.property"),
      value: obj.value,
      verify,
    };
  }
  throw new TraceParseError(
    `start.reset.hook.do must be "tap" or "set" (got ${JSON.stringify(obj.do)})`,
  );
}

function parseResetVerify(value: unknown): ResetVerify {
  const obj = asObject(value, "start.reset.hook.verify");
  return {
    locator: parseLocator(obj.locator, "start.reset.hook.verify.locator"),
    timeoutMs: optionalNumber(obj.timeoutMs, "start.reset.hook.verify.timeoutMs"),
  };
}

function parseSegment(value: unknown, path: string): Segment {
  const obj = asObject(value, path);
  const id = requireId(obj.id, `${path}.id`);
  // Multi-scene EVIDENCE (#284): the runtime scene this segment was demonstrated in. Must round-trip
  // through parse — the no-`--scene` front door reads a freshly recorded trace back via `parseTrace`,
  // and inference reads `segment.scene`, so dropping it here would silently collapse every multi-scene
  // trace to a single-scene fallback. Optional ⇒ back-compatible (absent stays absent).
  const scene = optionalString(obj.scene, `${path}.scene`);
  const actions = requireArray(obj.actions, `${path}.actions`).map((a, i) =>
    parseAction(a, `${path}.actions[${i}]`),
  );
  const anchors = obj.anchors === undefined
    ? undefined
    : requireArray(obj.anchors, `${path}.anchors`).map((a, i) =>
        parseAnchor(a, `${path}.anchors[${i}]`),
      );
  const captures = obj.captures === undefined
    ? undefined
    : requireArray(obj.captures, `${path}.captures`).map((c, i) =>
        parseCapture(c, `${path}.captures[${i}]`),
      );

  // Anchor ids must be unique within the segment (the engine matches captures
  // and anchorsReached by id), and a capture's `atAnchor` must reference one.
  const anchorIds = new Set<string>();
  for (const anchor of anchors ?? []) {
    if (anchorIds.has(anchor.id)) {
      throw new TraceParseError(`${path}: duplicate anchor id ${JSON.stringify(anchor.id)}`);
    }
    anchorIds.add(anchor.id);
  }
  for (const capture of captures ?? []) {
    if (capture.atAnchor !== undefined && !anchorIds.has(capture.atAnchor)) {
      throw new TraceParseError(
        `${path}: capture ${JSON.stringify(capture.id)} atAnchor ${JSON.stringify(
          capture.atAnchor,
        )} does not match any anchor in the segment`,
      );
    }
  }

  return { id, actions, anchors, captures, ...(scene !== undefined ? { scene } : {}) };
}

function parseAction(value: unknown, path: string): Action {
  const obj = asObject(value, path);
  switch (obj.do) {
    case "tap":
      return { do: "tap", locator: parseLocator(obj.locator, `${path}.locator`) };
    case "world-tap":
      return { do: "world-tap", locator: parseLocator(obj.locator, `${path}.locator`) };
    case "key-tap":
      return { do: "key-tap", key: requireString(obj.key, `${path}.key`) };
    case "key-hold":
      return {
        do: "key-hold",
        key: requireString(obj.key, `${path}.key`),
        durationMs: requireHoldDurationMs(obj.durationMs, `${path}.durationMs`),
      };
    case "key-down":
      return { do: "key-down", key: requireString(obj.key, `${path}.key`) };
    case "key-up":
      return { do: "key-up", key: requireString(obj.key, `${path}.key`) };
    case "wait":
      return { do: "wait", durationMs: requireHoldDurationMs(obj.durationMs, `${path}.durationMs`) };
    case "drag":
      return {
        do: "drag",
        from: parseLocator(obj.from, `${path}.from`),
        to: parseLocator(obj.to, `${path}.to`),
        travelPx: optionalNonNegativeFiniteNumber(obj.travelPx, `${path}.travelPx`),
        travelRefHeight: optionalNonNegativeFiniteNumber(obj.travelRefHeight, `${path}.travelRefHeight`),
        releaseNorm: parseReleaseNorm(obj.releaseNorm, `${path}.releaseNorm`),
      };
    case "wait-for-visible":
      return {
        do: "wait-for-visible",
        locator: parseLocator(obj.locator, `${path}.locator`),
        timeoutMs: optionalNumber(obj.timeoutMs, `${path}.timeoutMs`),
        minDelayMs: optionalNumber(obj.minDelayMs, `${path}.minDelayMs`),
      };
    case "wait-for-condition":
      // The recorder-grafted precondition gate. Reuse the ConditionSpec parsers
      // (locator/operator/expected/optional component+tolerance) — a MALFORMED
      // spec (missing property_path/operator/expected) THROWS via parseCondition,
      // never silently dropped — plus an optional wait budget.
      return {
        do: "wait-for-condition",
        ...parseCondition(obj, path),
        timeoutMs: optionalNumber(obj.timeoutMs, `${path}.timeoutMs`),
      };
    default:
      throw new TraceParseError(
        `${path}.do must be one of tap | world-tap | key-tap | key-hold | key-down | key-up | wait | drag | wait-for-visible | wait-for-condition (got ${JSON.stringify(
          obj.do,
        )})`,
      );
  }
}

/** A held key can't pace replay indefinitely — cap the wall-clock hold. */
const MAX_KEY_HOLD_MS = 10_000;

/**
 * A `key-hold` duration: a positive finite number of milliseconds, CLAMPED to
 * `MAX_KEY_HOLD_MS` so an over-long (or fat-fingered) value can't make replay
 * hang on a single held key. Refuses a missing / non-positive / NaN value rather
 * than defaulting one — a hold with no duration is a malformed action.
 */
function requireHoldDurationMs(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TraceParseError(`${path} must be a positive number of milliseconds`);
  }
  return Math.min(value, MAX_KEY_HOLD_MS);
}

function parseAnchor(value: unknown, path: string): Anchor {
  const obj = asObject(value, path);
  const id = requireId(obj.id, `${path}.id`);
  if (obj.kind === "ui-visible") {
    return {
      id,
      kind: "ui-visible",
      locator: parseLocator(obj.locator, `${path}.locator`),
      timeoutMs: optionalNumber(obj.timeoutMs, `${path}.timeoutMs`),
    };
  }
  if (obj.kind === "condition") {
    return {
      id,
      kind: "condition",
      timeoutMs: optionalNumber(obj.timeoutMs, `${path}.timeoutMs`),
      ...parseCondition(obj, path),
    };
  }
  throw new TraceParseError(
    `${path}.kind must be "ui-visible" or "condition" (got ${JSON.stringify(
      obj.kind,
    )})`,
  );
}

function parseCapture(value: unknown, path: string): Capture {
  const obj = asObject(value, path);
  return {
    id: requireId(obj.id, `${path}.id`),
    atAnchor: optionalString(obj.atAnchor, `${path}.atAnchor`),
    settleMs: optionalNumber(obj.settleMs, `${path}.settleMs`),
  };
}

function parseAssertion(value: unknown, path: string): Assertion {
  const obj = asObject(value, path);
  return {
    id: requireId(obj.id, `${path}.id`),
    ...parseCondition(obj, path),
    reachedWhenVisible: optionalBoolean(obj.reachedWhenVisible, `${path}.reachedWhenVisible`),
  };
}

function parseCondition(
  obj: Record<string, unknown>,
  path: string,
): {
  locator: Locator;
  component?: string;
  property_path: string;
  operator: ConditionOperator;
  expected: unknown;
  tolerance?: number;
} {
  const operator = requireString(obj.operator, `${path}.operator`);
  if (!OPERATORS.has(operator)) {
    throw new TraceParseError(
      `${path}.operator must be one of ${[...OPERATORS].join(" | ")} (got ${JSON.stringify(
        operator,
      )})`,
    );
  }
  if (!("expected" in obj)) {
    throw new TraceParseError(`${path}.expected is required`);
  }
  return {
    locator: parseLocator(obj.locator, `${path}.locator`),
    component: optionalString(obj.component, `${path}.component`),
    property_path: requireString(obj.property_path, `${path}.property_path`),
    operator: operator as ConditionOperator,
    expected: obj.expected,
    tolerance: optionalNumber(obj.tolerance, `${path}.tolerance`),
  };
}

function parseLocator(value: unknown, path: string): Locator {
  const obj = asObject(value, path);
  return {
    path: requireString(obj.path, `${path}.path`),
    scene: optionalString(obj.scene, `${path}.scene`),
    globalObjectId: optionalString(obj.globalObjectId, `${path}.globalObjectId`),
    instanceId: optionalString(obj.instanceId, `${path}.instanceId`),
  };
}

// ───────────────────────────── primitives ─────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TraceParseError(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TraceParseError(`${path} must be an array`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceParseError(`${path} must be a non-empty string`);
  }
  return value;
}

/**
 * True if `id` is safe to use as a single filesystem path segment — no path
 * separators and no `..`. Used for trace/capture ids (which become directory and
 * file names) AND by the CLI to validate `--id` before it builds output paths.
 */
export function isSafePathSegment(id: string): boolean {
  return id.length > 0 && id !== "." && !/[\\/]/.test(id) && !id.includes("..");
}

/**
 * An id used in a filesystem path (trace id → proof dir, capture id → PNG name).
 * Reject path separators and `..` so a hand-authored/promoted trace cannot write
 * a capture artifact outside its capture directory.
 */
function requireId(value: unknown, path: string): string {
  const id = requireString(value, path);
  if (!isSafePathSegment(id)) {
    throw new TraceParseError(
      `${path} must not contain path separators or '..' (got ${JSON.stringify(id)})`,
    );
  }
  return id;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TraceParseError(`${path} must be a number`);
  }
  return value;
}

function optionalNonNegativeFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TraceParseError(`${path} must be a finite number >= 0`);
  }
  return value;
}

/**
 * An optional normalized release point `{ x, y }` for a custom-drop drag — each a
 * finite number in [0,1]. Absent ⇒ undefined (release at `to`). Present-but-malformed
 * (missing axis, out-of-range, NaN) THROWS rather than silently dropping the release
 * point, which would misroute the gesture back to the drop-target center.
 */
function parseReleaseNorm(
  value: unknown,
  path: string,
): { x: number; y: number } | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value, path);
  const axis = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new TraceParseError(`${path}.${name} must be a finite number in [0,1]`);
    }
    return v;
  };
  return { x: axis(obj.x, "x"), y: axis(obj.y, "y") };
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TraceParseError(`${path} must be a boolean`);
  }
  return value;
}
