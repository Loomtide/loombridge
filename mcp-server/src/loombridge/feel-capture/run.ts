import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeResponse } from "../../types.js";
import { replay } from "../replay/engine.js";
import { parseTrace } from "../replay/parse.js";
import type { ReplayReport } from "../replay/types.js";
import { UnityDriver } from "../replay/unity-driver.js";
import type { FeelMeasurementStimulus, FeelTrajectorySample } from "../../verification/gates/feel.js";
import { assembleFeelCaptureMeasurements } from "./assemble.js";
import type {
  FeelCaptureContract,
  FeelCaptureInteraction,
  FeelCaptureRawResult,
  FeelCaptureRunResult,
  FeelCaptureSettleSpec,
  FeelMetricRecipe,
  FeelSemanticAnchor,
} from "./types.js";
import { evaluateFeelCaptureRuntimeGuard } from "./runtime-guard.js";
import { assertValidFeelCaptureContract, sampledFieldsForBridge } from "./validator.js";

export type FeelCaptureSend = (
  command: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<BridgeResponse | { data?: unknown; status?: string; error?: { message?: string } }>;

export interface FeelCaptureRunOptions {
  sourceRoot?: string;
  sourceCommit?: string;
  warn?: (message: string) => void;
  traceRoot?: string;
  replayCaptureDir?: string;
  runTraceReplay?: (
    interaction: Extract<FeelCaptureInteraction, { kind: "trace-replay" }>,
  ) => Promise<FeelTraceReplayArtifact>;
}

export interface FeelTraceReplayArtifact extends ReplayReport {
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

function bridgeData(response: Awaited<ReturnType<FeelCaptureSend>>, command: string): Record<string, unknown> {
  if (response.status === "error") {
    throw new Error(`${command} failed: ${response.error?.message ?? "unknown bridge error"}`);
  }
  const data = "data" in response ? response.data : response;
  return (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
}

function samplesFrom(data: Record<string, unknown>): FeelTrajectorySample[] | undefined {
  const samples = data.samples;
  if (!Array.isArray(samples)) return undefined;
  return samples
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      tMs: Number(s.tMs),
      x: Number(s.x),
      y: Number(s.y),
      // 3D measurement substrate: carry z through when the bridge emits it; omit otherwise
      // so legacy 2D captures keep an undefined z (treated as 0 by the calculators).
      ...(Number.isFinite(Number(s.z)) ? { z: Number(s.z) } : {}),
      ...(Number.isFinite(Number(s.phase)) ? { phase: Number(s.phase) } : {}),
    }));
}

function blocked(interaction: FeelCaptureInteraction, source: string, reason: string): FeelCaptureRawResult {
  return { interactionId: interaction.id, kind: interaction.kind, source, status: "attempted-blocked", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireDispatchActuated(
  interaction: FeelCaptureInteraction,
  source: string,
  data: Record<string, unknown>,
  label: string,
): FeelCaptureRawResult | undefined {
  const dispatch = data.dispatch;
  if (!isRecord(dispatch) || dispatch.actuated !== true) {
    return blocked(interaction, source, `${label} did not report positive actuation evidence.`);
  }
  return undefined;
}

function requireWorldPointerMotionEvidence(
  interaction: Extract<FeelCaptureInteraction, { kind: "world-pointer" }>,
  data: Record<string, unknown>,
): FeelCaptureRawResult | undefined {
  const dispatch = data.dispatch;
  if (!isRecord(dispatch) || finiteNumber(dispatch.dispatchedMs) === undefined) {
    return blocked(interaction, "runtime.capture_pointer_motion", "world pointer tap did not report positive dispatch evidence.");
  }
  const samples = samplesFrom(data) ?? [];
  const onsetMs = finiteNumber(dispatch.dispatchedMs) ?? finiteNumber(dispatch.atMs) ?? 0;
  const after = samples.filter((sample) => Number.isFinite(sample.tMs) && sample.tMs >= onsetMs);
  if (after.length < 2) {
    return blocked(interaction, "runtime.capture_pointer_motion", "world pointer capture did not include enough post-dispatch samples.");
  }
  const first = after[0];
  const moved = after.some((sample) => Math.hypot(sample.x - first.x, sample.y - first.y) > 0.0001);
  if (!moved) {
    return blocked(interaction, "runtime.capture_pointer_motion", "world pointer dispatch produced no measured subject motion.");
  }
  return undefined;
}

async function acquireWorldPointerFocus(
  interaction: Extract<FeelCaptureInteraction, { kind: "world-pointer" }>,
  send: FeelCaptureSend,
): Promise<FeelCaptureRawResult | undefined> {
  try {
    const data = bridgeData(await send("editor.focus_game_view", {}, 10000), "editor.focus_game_view");
    if (data.gameViewFocused !== true) {
      return {
        ...blocked(
          interaction,
          "editor.focus_game_view",
          "world-pointer capture could not acquire Game View focus before dispatch.",
        ),
        data,
      };
    }
    return undefined;
  } catch (error) {
    return blocked(
      interaction,
      "editor.focus_game_view",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireScheduledTapsActuated(
  interaction: Extract<FeelCaptureInteraction, { kind: "ugui-multitap" }>,
  data: Record<string, unknown>,
): FeelCaptureRawResult | undefined {
  const taps = data.taps;
  if (!Array.isArray(taps) || taps.length !== interaction.taps.length) {
    return blocked(
      interaction,
      "runtime.capture_pointer_motion",
      "scheduled taps did not report positive actuation evidence for every requested tap.",
    );
  }
  const allActuated = taps.every((t) => isRecord(t) && t.actuated === true);
  if (!allActuated) {
    return blocked(interaction, "runtime.capture_pointer_motion", "one or more scheduled taps did not actuate the target.");
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function keyCount(keys: unknown): number {
  return nonEmptyStrings(keys).length;
}

function phaseByIndex(phases: unknown, index: number | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(phases) || index === undefined) return undefined;
  return phases.find((phase): phase is Record<string, unknown> =>
    isRecord(phase) && finiteNumber(phase.index) === index);
}

function estimatedCaptureFps(samples: FeelTrajectorySample[] | undefined): number | undefined {
  if (!samples || samples.length < 2) return undefined;
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].tMs - samples[i - 1].tMs;
    if (Number.isFinite(dt) && dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return undefined;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  return Number((1000 / median).toFixed(3));
}

function timingEvidence(data: Record<string, unknown> | undefined, samples: FeelTrajectorySample[] | undefined): Record<string, unknown> {
  const measuredAt = typeof data?.measuredAt === "string" && data.measuredAt.length > 0
    ? data.measuredAt
    : new Date().toISOString();
  const captureFps = finiteNumber(data?.captureFps) ?? estimatedCaptureFps(samples);
  const projectFixedTimestepBeforeMeasurement = finiteNumber(data?.projectFixedTimestepBeforeMeasurement);
  const measurementFixedTimestep = finiteNumber(data?.measurementFixedTimestep);
  return {
    measuredAt,
    ...(captureFps !== undefined ? { captureFps } : {}),
    ...(projectFixedTimestepBeforeMeasurement !== undefined ? { projectFixedTimestepBeforeMeasurement } : {}),
    ...(measurementFixedTimestep !== undefined ? { measurementFixedTimestep } : {}),
  };
}

function realizedFixedTickStimulus(
  data: Record<string, unknown> | undefined,
  stimulus: FeelMeasurementStimulus,
  interaction: FeelCaptureInteraction | undefined,
): boolean {
  if (stimulus.tapTicks === undefined || !Number.isInteger(stimulus.tapTicks) || stimulus.tapTicks <= 0) {
    return false;
  }
  if (!interaction || interaction.kind !== "keyboard") return false;
  const activeIndexes = interaction.phases
    .map((phase, index) => (keyCount(phase.keys) > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (activeIndexes.length !== 1) return false;
  const candidateIndexes = interaction.phases
    .map((phase, index) => (
      phase.fixedTicks === stimulus.tapTicks && keyCount(phase.keys) > 0 ? index : -1
    ))
    .filter((index) => index >= 0);
  if (candidateIndexes.length !== 1) return false;
  const phaseIndex = candidateIndexes[0];
  if (activeIndexes[0] !== phaseIndex) return false;
  const releasePhase = interaction.phases[phaseIndex + 1];
  if (!releasePhase || keyCount(releasePhase.keys) > 0) return false;

  const phases = data?.phases;
  if (!Array.isArray(phases)) return false;
  return phases.some((phase) => {
    if (!isRecord(phase)) return false;
    if (finiteNumber(phase.index) !== phaseIndex) return false;
    if (keyCount(phase.keys) === 0) return false;
    const requested = finiteNumber(phase.requestedFixedTicks);
    const actual = finiteNumber(phase.actualFixedTicks);
    return requested === stimulus.tapTicks && actual === stimulus.tapTicks;
  });
}

function realizedPointerHoldStimulus(
  data: Record<string, unknown> | undefined,
  stimulus: FeelMeasurementStimulus,
  interaction: FeelCaptureInteraction | undefined,
): boolean {
  if (stimulus.tapTicks === undefined || !Number.isInteger(stimulus.tapTicks) || stimulus.tapTicks <= 0) {
    return false;
  }
  if (!interaction || interaction.kind !== "ugui-hold" || interaction.holdFixedTicks !== stimulus.tapTicks) {
    return false;
  }
  const dispatch = data?.dispatch;
  if (!isRecord(dispatch) || dispatch.actuated !== true) return false;
  if (dispatch.raycastHit !== true) return false;
  return finiteNumber(data?.requestedFixedTicks) === stimulus.tapTicks
    && finiteNumber(data?.actualFixedTicks) === stimulus.tapTicks;
}

function verifiedTrajectoryStimulus(
  recipeStimulus: FeelMeasurementStimulus | undefined,
  raw: FeelCaptureRawResult,
  interaction: FeelCaptureInteraction | undefined,
): FeelMeasurementStimulus | undefined {
  if (!recipeStimulus) return undefined;
  if (recipeStimulus.metric === "shortHopApex") {
    const verified = interaction?.kind === "ugui-hold"
      ? realizedPointerHoldStimulus(raw.data, recipeStimulus, interaction)
      : realizedFixedTickStimulus(raw.data, recipeStimulus, interaction);
    return verified ? recipeStimulus : undefined;
  }
  return recipeStimulus;
}

function pointerInputOnsetMs(data: Record<string, unknown>): number | undefined {
  const dispatch = data.dispatch;
  if (isRecord(dispatch)) {
    return finiteNumber(dispatch.dispatchedMs) ?? finiteNumber(dispatch.atMs);
  }
  const taps = data.taps;
  if (Array.isArray(taps)) {
    const firstTap = taps.find(isRecord);
    if (firstTap) return finiteNumber(firstTap.dispatchedMs) ?? finiteNumber(firstTap.atMs);
  }
  return undefined;
}

function keyboardInputOnsetMs(interaction: Extract<FeelCaptureInteraction, { kind: "keyboard" }>): number | undefined {
  let elapsed = 0;
  for (const phase of interaction.phases) {
    if ((phase.keys ?? []).length > 0) return elapsed;
    if (phase.durationMs === undefined) return undefined;
    elapsed += phase.durationMs;
  }
  return undefined;
}

function semanticAnchorTimeMs(anchor: FeelSemanticAnchor, phases: { durationMs: number }[]): number {
  return phases.slice(0, anchor.phaseIndex).reduce((sum, phase) => sum + phase.durationMs, 0);
}

function semanticDelayAnchors(
  interaction: Extract<FeelCaptureInteraction, { kind: "semantic-probe" }>,
): { start?: FeelSemanticAnchor; end?: FeelSemanticAnchor; reason?: string } {
  const startKind = interaction.metric === "coyoteTime" ? "ground-lost" : "pre-jump-buffered-input";
  const endKind = interaction.metric === "coyoteTime" ? "jump-input" : "grounded-ready";
  const start = interaction.anchors.find((anchor) => anchor.kind === startKind);
  const end = interaction.anchors.find((anchor) => anchor.kind === endKind);
  if (!start || !end) {
    return { reason: `semantic probe requires ${startKind} and ${endKind} anchors to compute actual delay.` };
  }
  return { start, end };
}

function classifyTrajectoryRise(args: {
  samples: FeelTrajectorySample[];
  anchorTimeMs: number;
  minRise: number;
}): { jumped?: boolean; baselineY?: number; maxY?: number; maxRise?: number; reason?: string } {
  const after = args.samples.filter((sample) => Number.isFinite(sample.tMs) && sample.tMs >= args.anchorTimeMs);
  if (after.length < 2) {
    return { reason: "semantic probe did not capture enough post-anchor samples to classify jump evidence." };
  }
  const baselineY = after[0].y;
  const maxY = Math.max(...after.map((sample) => sample.y));
  const maxRise = maxY - baselineY;
  return {
    jumped: Number.isFinite(maxRise) && maxRise >= args.minRise,
    baselineY,
    maxY,
    maxRise,
  };
}

async function runSemanticProbe(
  interaction: Extract<FeelCaptureInteraction, { kind: "semantic-probe" }>,
  send: FeelCaptureSend,
): Promise<FeelCaptureRawResult> {
  const minRise = interaction.jumpEvidence.minRise ?? 0.05;
  const afterAnchor = interaction.anchors.find((anchor) => anchor.id === interaction.jumpEvidence.afterAnchorId);
  const delayAnchors = semanticDelayAnchors(interaction);
  if (!afterAnchor) {
    return blocked(
      interaction,
      "runtime.probe",
      `semantic probe references unknown jumpEvidence anchor '${interaction.jumpEvidence.afterAnchorId}'.`,
    );
  }
  if (delayAnchors.reason || !delayAnchors.start || !delayAnchors.end) {
    return blocked(interaction, "runtime.probe", delayAnchors.reason ?? "semantic probe cannot compute actual delay.");
  }

  const trials: Record<string, unknown>[] = [];
  const allSamples: FeelTrajectorySample[] = [];
  let firstTiming: Record<string, unknown> | undefined;
  for (let trialIndex = 0; trialIndex < interaction.trials.length; trialIndex += 1) {
    const trial = interaction.trials[trialIndex];
    const data = bridgeData(await send("runtime.probe", {
      measure: interaction.measure,
      phases: trial.phases.map((phase) => ({
        durationMs: phase.durationMs,
        ...(phase.drivers ? { drivers: phase.drivers } : {}),
      })),
      includeSamples: true,
      resetDriversOnEnd: true,
      ...(interaction.captureFps === undefined ? {} : { captureFps: interaction.captureFps }),
    }, 60000), "runtime.probe");
    const samples = samplesFrom(data) ?? [];
    if (samples.length === 0) {
      return {
        ...blocked(
          interaction,
          "runtime.probe",
          `semantic probe trial ${trialIndex} produced no trajectory samples; cannot classify ${interaction.metric}.`,
        ),
        data: { trials, failedTrial: { trialIndex, delayMs: trial.delayMs, raw: data } },
      };
    }
    firstTiming ??= timingEvidence(data, samples);
    allSamples.push(...samples);
    const anchorTimeMs = semanticAnchorTimeMs(afterAnchor, trial.phases);
    const actualDelayMs =
      semanticAnchorTimeMs(delayAnchors.end, trial.phases) - semanticAnchorTimeMs(delayAnchors.start, trial.phases);
    if (!Number.isFinite(actualDelayMs) || actualDelayMs <= 0) {
      return {
        ...blocked(
          interaction,
          "runtime.probe",
          `semantic probe trial ${trialIndex} has invalid anchor timing; actual delay is ${actualDelayMs}ms.`,
        ),
        data: { trials, failedTrial: { trialIndex, requestedDelayMs: trial.delayMs, actualDelayMs, raw: data } },
      };
    }
    if (Math.abs(actualDelayMs - trial.delayMs) > 0.001) {
      return {
        ...blocked(
          interaction,
          "runtime.probe",
          `semantic probe trial ${trialIndex} declared delayMs ${trial.delayMs} but anchor timing is ${actualDelayMs}ms.`,
        ),
        data: { trials, failedTrial: { trialIndex, requestedDelayMs: trial.delayMs, actualDelayMs, raw: data } },
      };
    }
    const classified = classifyTrajectoryRise({ samples, anchorTimeMs, minRise });
    if (classified.jumped === undefined) {
      return {
        ...blocked(
          interaction,
          "runtime.probe",
          `semantic probe trial ${trialIndex} could not classify jump evidence: ${classified.reason ?? "unknown reason"}`,
        ),
        data: { trials, failedTrial: { trialIndex, delayMs: trial.delayMs, raw: data } },
      };
    }
    trials.push({
      trialIndex,
      delayMs: actualDelayMs,
      requestedDelayMs: trial.delayMs,
      jumped: classified.jumped,
      jumpEvidence: {
        kind: interaction.jumpEvidence.kind,
        afterAnchorId: afterAnchor.id,
        anchorTimeMs,
        minRise,
        baselineY: classified.baselineY,
        maxY: classified.maxY,
        maxRise: classified.maxRise,
      },
      anchors: interaction.anchors.map((anchor) => ({
        id: anchor.id,
        kind: anchor.kind,
        phaseIndex: anchor.phaseIndex,
        tMs: semanticAnchorTimeMs(anchor, trial.phases),
      })),
      sampleCount: samples.length,
      timing: timingEvidence(data, samples),
    });
  }

  return {
    interactionId: interaction.id,
    kind: interaction.kind,
    source: "runtime.probe",
    status: "attempted-blocked",
    reason:
      "semantic probe anchors are declared phase labels, but runtime.probe does not yet observe ground-lost/grounded-ready events; coyoteTime/jumpBuffer are not measured.",
    data: {
      metric: interaction.metric,
      anchors: interaction.anchors,
      trials,
      minRise,
      ...firstTiming,
    },
    samples: allSamples,
  };
}

function tracePathFor(traceRoot: string, traceId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(traceId)) {
    throw new Error(`traceId ${JSON.stringify(traceId)} must be a file-safe id without path separators.`);
  }
  const fileName = traceId.endsWith(".json") ? traceId : `${traceId}.json`;
  return path.join(traceRoot, fileName);
}

async function defaultRunTraceReplay(
  interaction: Extract<FeelCaptureInteraction, { kind: "trace-replay" }>,
  send: FeelCaptureSend,
  options: FeelCaptureRunOptions,
): Promise<FeelTraceReplayArtifact> {
  if (!options.traceRoot) {
    throw new Error("trace-replay interaction requires a traceRoot; run through live capture or pass traceRoot explicitly.");
  }
  const tracePath = tracePathFor(options.traceRoot, interaction.traceId);
  const trace = parseTrace(JSON.parse(await fs.readFile(tracePath, "utf-8")));
  const startedAt = new Date();
  const captureDir = options.replayCaptureDir
    ? path.join(options.replayCaptureDir, interaction.id)
    : path.join(options.traceRoot, "..", "actual", interaction.id);
  const driver = new UnityDriver(
    (command, params, timeoutMs) => send(command, params, timeoutMs) as Promise<BridgeResponse>,
    { captureDir },
  );
  const report = await replay(trace, driver);
  const finishedAt = new Date();
  return {
    ...report,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

function requireKeyboardActuated(
  interaction: Extract<FeelCaptureInteraction, { kind: "keyboard" }>,
  data: Record<string, unknown>,
  requireSubjectMotion: boolean,
): FeelCaptureRawResult | undefined {
  const activePhases = interaction.phases
    .map((phase, index) => ({ index, keys: phase.keys ?? [] }))
    .filter((phase) => phase.keys.length > 0);
  const activePhaseIndexes = new Set(activePhases.map((phase) => phase.index));
  if (activePhases.length === 0) {
    return blocked(interaction, "runtime.capture_input_motion", "keyboard recipe has no active key phase.");
  }

  const phases = data.phases;
  if (!Array.isArray(phases)) {
    return blocked(interaction, "runtime.capture_input_motion", "keyboard capture did not report per-phase actuation evidence.");
  }
  for (const requested of activePhases) {
    const actualPhase = phases.find((phase) => isRecord(phase) && finiteNumber(phase.index) === requested.index);
    if (!isRecord(actualPhase)) {
      return blocked(interaction, "runtime.capture_input_motion", `keyboard capture did not report active phase ${requested.index}.`);
    }
    const actualKeys = Array.isArray(actualPhase.keys)
      ? actualPhase.keys.filter((key): key is string => typeof key === "string")
      : [];
    const actual = new Set(actualKeys.map((key) => key.toLowerCase()));
    const missing = requested.keys.filter((key) => !actual.has(key.toLowerCase()));
    if (missing.length > 0) {
      return blocked(
        interaction,
        "runtime.capture_input_motion",
        `keyboard capture active phase ${requested.index} did not hold requested key(s): ${missing.join(", ")}.`,
      );
    }
  }
  if (!requireSubjectMotion) return undefined;

  const moved = phases.some((phase) => {
    if (!isRecord(phase)) return false;
    const index = finiteNumber(phase.index);
    if (index === undefined || !activePhaseIndexes.has(index)) return false;
    const dx = Math.abs(finiteNumber(phase.deltaX) ?? 0);
    const dy = Math.abs(finiteNumber(phase.deltaY) ?? 0);
    return dx > 1e-4 || dy > 1e-4;
  });
  if (!moved) {
    return blocked(
      interaction,
      "runtime.capture_input_motion",
      "keyboard input did not move the measured subject during any active key phase.",
    );
  }
  return undefined;
}

function interactionNeedsSubjectMotion(interaction: FeelCaptureInteraction, metrics: FeelMetricRecipe[]): boolean {
  return metrics.some((metric) =>
    metric.interactionId === interaction.id
    && (metric.derivation === "trajectory" || metric.derivation === "phase-delta"));
}

// Conservative settle defaults applied when a settle spec omits a tunable. They use only
// observable subject motion so the precondition generalizes across jump-bearing games.
const SETTLE_DEFAULT_TIMEOUT_MS = 3000;
const SETTLE_DEFAULT_POLL_MS = 200;
const SETTLE_DEFAULT_MIN_STABLE_SAMPLES = 6;
const SETTLE_DEFAULT_MIN_STABLE_MS = 100;
const SETTLE_DEFAULT_REST_THRESHOLD = 0.02;

export interface FeelCaptureSettleEvidence {
  kind: "settle-until-rest";
  status: "rested" | "timeout" | "not-observed";
  timeoutMs: number;
  pollMs: number;
  minStableSamples: number;
  minStableMs: number;
  restThreshold: number;
  probeCount: number;
  observedSampleCount: number;
  stableSampleCount: number;
  stableDurationMs: number;
  maxTrailingDisplacement?: number;
  elapsedMs: number;
  reason?: string;
}

/**
 * Returns the longest trailing run of samples whose consecutive per-sample displacement
 * stays under `restThreshold`, along with the max displacement seen in that trailing run.
 * Rest is proven only from observed subject motion — never derived from a falling tail.
 */
function trailingRest(
  samples: FeelTrajectorySample[],
  restThreshold: number,
): { stableCount: number; stableDurationMs: number; maxTrailingDisplacement: number } {
  if (samples.length === 0) return { stableCount: 0, stableDurationMs: 0, maxTrailingDisplacement: Infinity };
  if (samples.length === 1) return { stableCount: 1, stableDurationMs: 0, maxTrailingDisplacement: 0 };
  let stableCount = 1;
  let maxTrailingDisplacement = 0;
  let stableStartIndex = samples.length - 1;
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const a = samples[i];
    const b = samples[i - 1];
    const disp = Math.hypot(a.x - b.x, a.y - b.y);
    if (!Number.isFinite(disp) || disp > restThreshold) break;
    maxTrailingDisplacement = Math.max(maxTrailingDisplacement, disp);
    stableCount += 1;
    stableStartIndex = i - 1;
  }
  const startMs = samples[stableStartIndex]?.tMs;
  const endMs = samples[samples.length - 1]?.tMs;
  const stableDurationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : 0;
  return { stableCount, stableDurationMs, maxTrailingDisplacement };
}

const SETTLE_OBSERVATION_SOURCE = "runtime.measure_motion";

/**
 * Observe the measured subject until it is at rest, WITHOUT injecting any input. Uses
 * `runtime.measure_motion` rather than the keyboard injection capture path so the same
 * settle precondition is safe for pointer/uGUI games and legacy mobile projects. Returns
 * settle evidence; the caller refuses the dependent interaction unless status is "rested".
 */
async function runSettle(
  settle: FeelCaptureSettleSpec,
  send: FeelCaptureSend,
): Promise<FeelCaptureSettleEvidence> {
  const timeoutMs = settle.timeoutMs ?? SETTLE_DEFAULT_TIMEOUT_MS;
  const pollMs = settle.pollMs ?? SETTLE_DEFAULT_POLL_MS;
  const minStableSamples = settle.minStableSamples ?? SETTLE_DEFAULT_MIN_STABLE_SAMPLES;
  const minStableMs = settle.minStableMs ?? SETTLE_DEFAULT_MIN_STABLE_MS;
  const restThreshold = settle.restThreshold ?? SETTLE_DEFAULT_REST_THRESHOLD;

  const base: FeelCaptureSettleEvidence = {
    kind: "settle-until-rest",
    status: "not-observed",
    timeoutMs,
    pollMs,
    minStableSamples,
    minStableMs,
    restThreshold,
    probeCount: 0,
    observedSampleCount: 0,
    stableSampleCount: 0,
    stableDurationMs: 0,
    elapsedMs: 0,
  };

  let elapsedMs = 0;
  let observedSampleCount = 0;
  let lastTrailing: { stableCount: number; stableDurationMs: number; maxTrailingDisplacement: number } | undefined;
  while (elapsedMs < timeoutMs) {
    const data = bridgeData(await send(SETTLE_OBSERVATION_SOURCE, {
      locator: settle.measure,
      durationMs: pollMs,
      includeSamples: true,
    }, 45000), SETTLE_OBSERVATION_SOURCE);
    base.probeCount += 1;
    elapsedMs += pollMs;
    base.elapsedMs = elapsedMs;
    const samples = samplesFrom(data) ?? [];
    observedSampleCount += samples.length;
    base.observedSampleCount = observedSampleCount;
    // Evaluate rest within THIS probe window (a fresh, contiguous trajectory). A cross-probe
    // splice could hide a discontinuity; the window-local trailing run is the honest signal.
    const trailing = trailingRest(samples, restThreshold);
    lastTrailing = trailing;
    base.stableSampleCount = trailing.stableCount;
    base.stableDurationMs = Number(trailing.stableDurationMs.toFixed(3));
    base.maxTrailingDisplacement = Number.isFinite(trailing.maxTrailingDisplacement)
      ? Number(trailing.maxTrailingDisplacement.toFixed(5))
      : undefined;
    if (
      samples.length >= minStableSamples
      && trailing.stableCount >= minStableSamples
      && trailing.stableDurationMs >= minStableMs
    ) {
      base.status = "rested";
      return base;
    }
  }

  if (observedSampleCount === 0 || lastTrailing === undefined) {
    base.status = "not-observed";
    base.reason = "settle precondition observed no subject motion samples; cannot prove the subject was grounded/rested.";
    return base;
  }
  base.status = "timeout";
  base.reason = `subject did not settle to rest within ${timeoutMs}ms (needed ${minStableSamples} stable samples for ${minStableMs}ms under ${restThreshold}u; best trailing run was ${lastTrailing.stableCount} samples over ${Number(lastTrailing.stableDurationMs.toFixed(3))}ms).`;
  return base;
}

function settleSpecOf(interaction: FeelCaptureInteraction): FeelCaptureSettleSpec | undefined {
  if (interaction.kind === "keyboard" || interaction.kind === "ugui-hold") {
    return interaction.settle;
  }
  return undefined;
}

async function runInteraction(
  interaction: FeelCaptureInteraction,
  send: FeelCaptureSend,
  options: FeelCaptureRunOptions,
  metrics: FeelMetricRecipe[],
): Promise<FeelCaptureRawResult> {
  if (interaction.kind === "unsupported") {
    return {
      interactionId: interaction.id,
      kind: interaction.kind,
      source: "unsupported",
      status: "unsupported",
      reason: interaction.reason,
    };
  }

  try {
    // Generic grounded-settle precondition: gate the dependent interaction on observable
    // rest evidence. An un-rested or unobserved subject blocks the interaction — we never
    // derive a metric from a falling/stale trajectory.
    const settleSpec = settleSpecOf(interaction);
    let settleEvidence: FeelCaptureSettleEvidence | undefined;
    if (settleSpec) {
      settleEvidence = await runSettle(settleSpec, send);
      if (settleEvidence.status !== "rested") {
        return {
          ...blocked(
            interaction,
            SETTLE_OBSERVATION_SOURCE,
            settleEvidence.reason
              ?? `settle precondition did not reach rest (status ${settleEvidence.status}).`,
          ),
          data: { settle: settleEvidence },
        };
      }
    }
    const withSettle = (data: Record<string, unknown>): Record<string, unknown> =>
      settleEvidence ? { ...data, settle: settleEvidence } : data;

    switch (interaction.kind) {
      case "keyboard": {
        const data = withSettle(bridgeData(await send("runtime.capture_input_motion", {
          measure: interaction.measure,
          phases: interaction.phases,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_input_motion"));
        const inputBlocked = requireKeyboardActuated(interaction, data, interactionNeedsSubjectMotion(interaction, metrics));
        if (inputBlocked) return { ...inputBlocked, data: withSettle({}) };
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_input_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
          inputOnsetMs: keyboardInputOnsetMs(interaction),
        };
      }
      case "ugui-tap": {
        const data = bridgeData(await send("runtime.capture_pointer_motion", {
          measure: interaction.measure,
          target: interaction.target,
          settleMs: interaction.settleMs,
          captureMs: interaction.captureMs,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_pointer_motion");
        const dispatchBlocked = requireDispatchActuated(interaction, "runtime.capture_pointer_motion", data, "pointer tap");
        if (dispatchBlocked) return dispatchBlocked;
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_pointer_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
          inputOnsetMs: pointerInputOnsetMs(data),
        };
      }
      case "ugui-multitap": {
        const data = bridgeData(await send("runtime.capture_pointer_motion", {
          measure: interaction.measure,
          target: interaction.target,
          taps: interaction.taps,
          captureMs: interaction.captureMs,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_pointer_motion");
        const tapsBlocked = requireScheduledTapsActuated(interaction, data);
        if (tapsBlocked) return tapsBlocked;
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_pointer_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
          inputOnsetMs: pointerInputOnsetMs(data),
        };
      }
      case "ugui-hold-drag": {
        const data = bridgeData(await send("runtime.capture_pointer_hold_motion", {
          measure: interaction.measure,
          target: interaction.target,
          dragTo: interaction.dragTo,
          settleMs: interaction.settleMs,
          captureMs: interaction.captureMs,
          releaseMs: interaction.releaseMs,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_pointer_hold_motion");
        const dispatchBlocked = requireDispatchActuated(interaction, "runtime.capture_pointer_hold_motion", data, "pointer hold-drag");
        if (dispatchBlocked) return dispatchBlocked;
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_pointer_hold_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
          inputOnsetMs: pointerInputOnsetMs(data),
        };
      }
      case "ugui-hold": {
        const data = withSettle(bridgeData(await send("runtime.capture_pointer_hold_motion", {
          measure: interaction.measure,
          target: interaction.target,
          settleMs: interaction.settleMs,
          captureMs: interaction.captureMs,
          releaseFixedTicks: interaction.holdFixedTicks,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_pointer_hold_motion"));
        const dispatchBlocked = requireDispatchActuated(interaction, "runtime.capture_pointer_hold_motion", data, "pointer hold");
        if (dispatchBlocked) return { ...dispatchBlocked, data: withSettle({}) };
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_pointer_hold_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
          inputOnsetMs: pointerInputOnsetMs(data),
        };
      }
      case "trace-replay": {
        const report = await (options.runTraceReplay ?? ((i) => defaultRunTraceReplay(i, send, options)))(interaction);
        const data = { replay: report, durationMs: report.durationMs };
        if (report.status === "pass") {
          return {
            interactionId: interaction.id,
            kind: interaction.kind,
            source: "replay.trace",
            status: "measured",
            data,
          };
        }
        const reason = report.status === "blocked"
          ? `trace replay blocked: ${report.blockedReason ?? "unknown replay blocker"}`
          : `trace replay failed: ${report.firstDivergence?.actual ?? "trace did not reach its declared outcome"}`;
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "replay.trace",
          status: "attempted-blocked",
          reason,
          data,
        };
      }
      case "world-pointer": {
        const focusBlocked = await acquireWorldPointerFocus(interaction, send);
        if (focusBlocked) return focusBlocked;
        const data = bridgeData(await send("runtime.capture_pointer_motion", {
          measure: interaction.measure,
          world: { x: interaction.x, y: interaction.y },
          settleMs: 300,
          captureMs: interaction.captureMs ?? 1000,
          includeSamples: true,
          sampledFields: sampledFieldsForBridge(interaction.sampledFields),
        }, 45000), "runtime.capture_pointer_motion");
        const dispatchBlocked = requireWorldPointerMotionEvidence(interaction, data);
        if (dispatchBlocked) return dispatchBlocked;
        return {
          interactionId: interaction.id,
          kind: interaction.kind,
          source: "runtime.capture_pointer_motion",
          status: "measured",
          data,
          samples: samplesFrom(data),
        };
      }
      case "semantic-probe":
        return await runSemanticProbe(interaction, send);
    }
  } catch (error) {
    return blocked(interaction, interaction.kind, error instanceof Error ? error.message : String(error));
  }
}

export async function runFeelCaptureContract(
  input: FeelCaptureContract,
  send: FeelCaptureSend,
  options: FeelCaptureRunOptions = {},
): Promise<FeelCaptureRunResult> {
  const contract = assertValidFeelCaptureContract(input);
  const runtimeGuard = evaluateFeelCaptureRuntimeGuard({
    sourceRoot: options.sourceRoot,
    sourceCommit: options.sourceCommit,
  });
  if (runtimeGuard.status === "warn") options.warn?.(runtimeGuard.message);
  const raw: FeelCaptureRawResult[] = [];
  for (const interaction of contract.interactions) {
    raw.push(await runInteraction(interaction, send, options, contract.metrics));
  }
  const assembled = assembleFeelCaptureMeasurements({
    recipes: contract.metrics,
    raw,
  });
  return {
    raw,
    measurements: {
      metrics: assembled.metrics,
      provenance: {
        note: "Generated by Loombridge generic feel capture runner.",
        runtimeGuard,
        sources: raw.flatMap((r) => {
          const measuredMetrics = assembled.coverage
            .filter((c) => c.interactionId === r.interactionId && c.status === "measured")
            .map((c) => c.metric);
          const trajectoryMetrics = measuredMetrics.filter((metric) =>
            contract.metrics.some((m) => m.metric === metric && m.derivation === "trajectory"),
          );
          const phaseDeltaMetrics = measuredMetrics.filter((metric) =>
            contract.metrics.some((m) => m.metric === metric && m.derivation === "phase-delta"),
          );
          const syncMetrics = measuredMetrics.filter((metric) =>
            contract.metrics.some((m) => m.metric === metric && m.derivation === "sync"),
          );
          const traceMetrics = measuredMetrics.filter((metric) =>
            contract.metrics.some((m) => m.metric === metric && m.derivation === "trace"),
          );
          const bisectionMetrics = measuredMetrics.filter((metric) =>
            contract.metrics.some((m) => m.metric === metric && m.derivation === "bisection"),
          );
          const stimulusRecipe = contract.metrics.find((m) =>
            m.interactionId === r.interactionId
              && m.stimulus
              && measuredMetrics.includes(m.metric)
              && m.metric === m.stimulus.metric,
          );
          const sourceInteraction = contract.interactions.find((i) => i.id === r.interactionId);
          const keyboardInteraction: Extract<FeelCaptureInteraction, { kind: "keyboard" }> | undefined =
            sourceInteraction?.kind === "keyboard" ? sourceInteraction : undefined;
          const stimulus = verifiedTrajectoryStimulus(stimulusRecipe?.stimulus, r, sourceInteraction);
          const inputOnsetMs = r.inputOnsetMs ?? (keyboardInteraction ? keyboardInputOnsetMs(keyboardInteraction) : undefined);
          const base = {
            source: r.source,
            interactionId: r.interactionId,
            status: r.status,
            reason: r.reason,
            sampleCount: r.samples?.length ?? 0,
            ...timingEvidence(r.data, r.samples),
            ...(inputOnsetMs !== undefined ? { inputOnsetMs } : {}),
            samples: r.samples,
          };
          if (
            trajectoryMetrics.length === 0
            && phaseDeltaMetrics.length === 0
            && syncMetrics.length === 0
            && traceMetrics.length === 0
            && bisectionMetrics.length === 0
          ) {
            return [{ ...base, measuredMetrics }];
          }
          const sources: Record<string, unknown>[] = [];
          if (trajectoryMetrics.length > 0) {
            sources.push({
              ...base,
              measuredMetrics: trajectoryMetrics,
              ...(r.status === "measured" && r.samples && r.samples.length > 0 ? { derivation: "trajectory" } : {}),
              ...(stimulus && trajectoryMetrics.includes(stimulus.metric) ? { stimulus } : {}),
            });
          }
          if (phaseDeltaMetrics.length > 0) {
            for (const metric of phaseDeltaMetrics) {
              const recipe = contract.metrics.find((m) =>
                m.metric === metric && m.interactionId === r.interactionId && m.derivation === "phase-delta");
              sources.push({
                ...base,
                measuredMetrics: [metric],
                derivation: "phase-delta",
                phases: r.data?.phases,
                phaseIndex: recipe?.phaseIndex,
                axis: recipe?.axis ?? "x",
                phaseKeys: nonEmptyStrings(phaseByIndex(r.data?.phases, recipe?.phaseIndex)?.keys),
                requiredKeys: recipe?.requiredKeys,
              });
            }
          }
          if (syncMetrics.length > 0) {
            sources.push({
              ...base,
              measuredMetrics: syncMetrics,
              derivation: "sync",
              fieldTimeline: r.data?.fieldTimeline,
            });
          }
          if (traceMetrics.length > 0) {
            sources.push({
              ...base,
              measuredMetrics: traceMetrics,
              derivation: "trace",
              replay: r.data?.replay,
              durationMs: r.data?.durationMs,
            });
          }
          if (bisectionMetrics.length > 0) {
            sources.push({
              ...base,
              measuredMetrics: bisectionMetrics,
              trials: r.data?.trials,
              anchors: r.data?.anchors,
              metric: r.data?.metric,
            });
          }
          return sources;
        }),
      },
      captureCoverage: assembled.coverage,
    },
  };
}
