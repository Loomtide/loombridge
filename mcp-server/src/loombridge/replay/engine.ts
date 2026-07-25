/**
 * Replay Verification — the deterministic replay engine (Phase A, slice A2).
 *
 * `replay(trace, driver)` orchestrates a single trace and returns a
 * `ReplayReport`. It is PURE given a `ReplayDriver`: all sequencing, anchor
 * ordering, first-divergence selection, and status/blocked logic live here, so
 * the whole contract is unit-testable against a `FakeDriver` with no live Unity.
 *
 * Design references (`Docs/FutureIdeas/ReplayVerification.md`):
 * - anchors-primary: a missed anchor IS the divergence; the run halts there.
 * - "no silent green": an undrivable target is `blocked` (with a reason), never a
 *   pass; the input-backend precondition and reset contract are gate-checked
 *   before any driving.
 */

import type { ReplayDriver } from "./driver.js";
import { dispatchConditionWithGestureRecovery, isContinuousGesture, preservesPendingGesture } from "./gesture-recovery.js";
import type {
  Action,
  Anchor,
  Assertion,
  AssertionResult,
  BlockedReason,
  ConditionSpec,
  FirstDivergence,
  ReplayReport,
  ReplayStatus,
  SegmentResult,
} from "./types.js";
import type { ReplayTrace } from "./types.js";

/** How long a `reachedWhenVisible` assertion waits for its element to become visible. */
const ASSERTION_GATE_TIMEOUT_MS = 4000;

export async function replay(
  trace: ReplayTrace,
  driver: ReplayDriver,
): Promise<ReplayReport> {
  try {
    return await runReplay(trace, driver);
  } finally {
    // Always release driver-owned resources (e.g. a keyboard input session),
    // whatever the verdict or a thrown harness error. Swallow teardown errors so
    // they can never flip or mask the run's outcome.
    try {
      await driver.teardown?.();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function runReplay(
  trace: ReplayTrace,
  driver: ReplayDriver,
): Promise<ReplayReport> {
  // 1. Input-backend precondition (the gate, before any driving).
  const capability = await driver.capabilityCheck(trace.input.backend);
  if (!capability.supported) {
    return blockedReport(
      trace,
      capability.reason ?? "unsupported-input-backend",
    );
  }

  // 2. Reset to a known start state.
  const reset = await driver.reset(trace.start);
  if (!reset.ok) {
    return blockedReport(trace, reset.reason ?? "reset-unavailable", reset.detail);
  }

  const segments: SegmentResult[] = [];
  let firstDivergence: FirstDivergence | undefined;
  let blockedReason: BlockedReason | undefined;
  let halted = false;
  // The most recent continuous (scrub/stir) gesture, tracked ACROSS segments — re-driven by the phase
  // gate's adaptive recovery when it fails (a gesture and the gate it advances may be in adjacent segments).
  let lastGesture: Action | undefined;

  // 3. Drive each segment: actions → anchors → captures, in order.
  for (const segment of trace.segments) {
    if (halted) {
      segments.push({
        id: segment.id,
        status: "not_reached",
        anchorsReached: [],
        captures: [],
      });
      continue;
    }

    const anchorsReached: string[] = [];
    let segmentFailed = false;
    let segmentBlocked = false;

    // 3a. Actions.
    for (let i = 0; i < segment.actions.length; i++) {
      const action = segment.actions[i];
      // A phase gate (`wait-for-condition`) is driven with adaptive gesture recovery: if it fails, the
      // preceding continuous gesture (a stir/scrub) is re-driven with escalating travel until the
      // game's phase signal advances or a bounded budget is spent — so an under-reproduced gesture on
      // an extreme aspect self-corrects instead of stalling the run.
      const result =
        action.do === "wait-for-condition"
          ? await dispatchConditionWithGestureRecovery(driver, action, lastGesture)
          : await driver.dispatch(action);
      // Adjacency guard: arm on a continuous gesture; CLEAR on any discrete input between it and a gate
      // (incl. across a segment boundary) so a gate advanced by a tap can't recover a stale, far-earlier
      // gesture; only the waits preserve it.
      if (isContinuousGesture(action)) lastGesture = action;
      else if (!preservesPendingGesture(action)) lastGesture = undefined;
      if (result.ok) continue;
      if (result.blocked) {
        // A missing capability (e.g. a world-space tap, or keyboard on a legacy-
        // only project), NOT a regression: mark the segment blocked, skip its
        // remaining actions, and keep running the rest of the trace. Never a
        // silent pass. The reason reflects which capability was missing.
        segmentBlocked = true;
        if (!blockedReason) blockedReason = blockedReasonFor(action);
        break;
      }
      firstDivergence = {
        segment: segment.id,
        step: i,
        kind: "action-failed",
        expected: describeAction(action),
        actual: result.detail ?? "action failed",
      };
      segmentFailed = true;
      halted = true;
      break;
    }

    // 3b. Anchors (primary progression) — skipped if the segment's action blocked.
    if (!segmentFailed && !segmentBlocked) {
      const anchors = segment.anchors ?? [];
      for (let j = 0; j < anchors.length; j++) {
        const anchor = anchors[j];
        const result = await driver.waitForAnchor(anchor);
        if (!result.reached) {
          firstDivergence = {
            segment: segment.id,
            step: j,
            kind: "anchor-missed",
            expected: describeAnchor(anchor),
            actual: result.actual ?? "not observed",
          };
          segmentFailed = true;
          halted = true;
          break;
        }
        anchorsReached.push(anchor.id);
      }
    }

    // 3c. Captures (only once the segment's actions + anchors succeeded).
    const captures: SegmentResult["captures"] = [];
    if (!segmentFailed) {
      for (const capture of segment.captures ?? []) {
        if (capture.atAnchor && !anchorsReached.includes(capture.atAnchor)) {
          continue;
        }
        const outcome = await driver.capture(capture.id, capture.settleMs);
        captures.push({
          id: capture.id,
          artifact: outcome.artifact,
          sha256: outcome.sha256,
        });
      }
    }

    segments.push({
      id: segment.id,
      status: segmentFailed ? "fail" : segmentBlocked ? "blocked" : "pass",
      anchorsReached,
      captures,
    });
  }

  // 4. End-state assertions (not_reached if the run halted earlier).
  const assertions: AssertionResult[] = [];
  for (const assertion of trace.assertions ?? []) {
    if (halted) {
      assertions.push({ id: assertion.id, status: "not_reached" });
      continue;
    }

    // GATE: an assertion with `reachedWhenVisible` only counts once the game actually
    // REACHED the asserted screen (its element visible) — otherwise it reads a stale /
    // scene-DEFAULT value and could false-pass. A never-visible element is a fail
    // ("state not reached"), never a silent pass on the default.
    if (assertion.reachedWhenVisible) {
      const reached = await driver.waitForAnchor({
        id: assertion.id,
        kind: "ui-visible",
        locator: assertion.locator,
        timeoutMs: ASSERTION_GATE_TIMEOUT_MS,
      });
      if (!reached.reached) {
        assertions.push({ id: assertion.id, status: "fail" });
        firstDivergence ??= {
          segment: null,
          kind: "assertion-failed",
          expected: `reach ${assertion.locator.path} then ${describeCondition(assertion)}`,
          actual: `${reached.actual ?? "not visible"} — state not reached (if the value is on an always-present / non-rendered element, set reachedWhenVisible:false)`,
        };
        continue;
      }
    }

    const outcome = await driver.evaluateAssertion(assertion);
    assertions.push({ id: assertion.id, status: outcome.pass ? "pass" : "fail" });
    if (!outcome.pass && !firstDivergence) {
      firstDivergence = {
        segment: null,
        kind: "assertion-failed",
        expected: describeCondition(assertion),
        actual: outcome.actual ?? "assertion failed",
      };
    }
  }

  // 5. Console health (read once we got past reset).
  const consoleOutcome = await driver.readConsole();
  const consoleFailed = consoleOutcome.errorCount > 0;
  if (consoleFailed && !firstDivergence) {
    firstDivergence = {
      segment: null,
      kind: "console-error",
      expected: "no console errors",
      actual: `${consoleOutcome.errorCount} console error(s)`,
    };
  }

  // 6. Overall status: a genuine divergence is fail; else a blocked step (missing
  // capability) keeps the trace from a clean pass; else pass. (fail > blocked > pass)
  const assertionFailed = assertions.some((a) => a.status === "fail");
  const anyBlocked = segments.some((s) => s.status === "blocked");
  const status: ReplayStatus =
    firstDivergence || assertionFailed || consoleFailed
      ? "fail"
      : anyBlocked
        ? "blocked"
        : "pass";

  return {
    traceId: trace.id,
    status,
    resetTier: reset.tier ?? null,
    ...(anyBlocked && blockedReason ? { blockedReason } : {}),
    firstDivergence,
    segments,
    assertions,
    console: {
      status: consoleFailed ? "fail" : "pass",
      errorCount: consoleOutcome.errorCount,
      errors: consoleOutcome.errors,
    },
  };
}

/** A report for a trace that was never drivable (blocked before/at reset). */
function blockedReport(
  trace: ReplayTrace,
  reason: ReplayReport["blockedReason"] & string,
  detail?: string,
): ReplayReport {
  return {
    traceId: trace.id,
    status: "blocked",
    resetTier: null,
    blockedReason: reason,
    ...(detail ? { blockedDetail: detail } : {}),
    segments: trace.segments.map((s) => ({
      id: s.id,
      status: "not_reached",
      anchorsReached: [],
      captures: [],
    })),
    assertions: (trace.assertions ?? []).map((a) => ({
      id: a.id,
      status: "not_reached",
    })),
    console: { status: "pass", errorCount: 0, errors: [] },
  };
}

function describeAction(action: Action): string {
  switch (action.do) {
    case "tap":
      return `tap ${action.locator.path}`;
    case "world-tap":
      return `world-tap ${action.locator.path}`;
    case "key-tap":
      return `key-tap ${action.key}`;
    case "key-hold":
      return `key-hold ${action.key} for ${action.durationMs}ms`;
    case "key-down":
      return `key-down ${action.key}`;
    case "key-up":
      return `key-up ${action.key}`;
    case "wait":
      return `wait ${action.durationMs}ms`;
    case "drag":
      return `drag ${action.from.path} → ${action.to.path}`;
    case "wait-for-visible":
      return `wait-for-visible ${action.locator.path}`;
    case "wait-for-condition":
      return `wait-for-condition ${describeCondition(action)}`;
  }
}

/** Which capability a blocked action was missing — keyboard vs world-space input. */
function blockedReasonFor(action: Action): BlockedReason {
  return action.do === "key-tap" ||
    action.do === "key-hold" ||
    action.do === "key-down" ||
    action.do === "key-up"
    ? "keyboard-input-unsupported"
    : "world-input-unsupported";
}

function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === "ui-visible") {
    return `${anchor.locator.path} visible`;
  }
  return describeCondition(anchor);
}

function describeCondition(spec: ConditionSpec): string {
  const target = spec.component
    ? `${spec.component}.${spec.property_path}`
    : spec.property_path;
  return `${target} ${spec.operator} ${JSON.stringify(spec.expected)}`;
}
