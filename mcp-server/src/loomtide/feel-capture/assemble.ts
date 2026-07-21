import {
  deriveDashToGhostLatency,
  deriveFireIntervalMs,
  deriveGroundContactToDustLatency,
  deriveInputToAnimStateLatency,
  deriveInputToSfxLatency,
  deriveInputToSpawnLatency,
  deriveTimeToKill,
  interpretBisection,
  deriveMetric,
  isValidTrajectory,
  type SyncSeries,
} from "../../verification/feel-derive.js";
import type { FeelCaptureCoverageEntry, FeelCaptureRawResult } from "./types.js";

export interface AssembleMetricRecipe {
  metric: string;
  interactionId?: string;
  derivation: "trajectory" | "phase-delta" | "bisection" | "reported" | "sync" | "trace" | "unsupported";
  deriveAs?: string;
  phaseIndex?: number;
  axis?: "x" | "y";
  requiredKeys?: string[];
  seriesId?: string;
  referenceSeriesId?: string;
  targetValue?: number | boolean;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldTimeline(raw: FeelCaptureRawResult): SyncSeries[] {
  const timeline = raw.data?.fieldTimeline;
  if (!Array.isArray(timeline)) return [];
  return timeline.filter((entry): entry is SyncSeries => isRecord(entry) && typeof entry.id === "string");
}

function findSeries(raw: FeelCaptureRawResult, id?: string): SyncSeries | undefined {
  const series = fieldTimeline(raw);
  if (id) return series.find((entry) => entry.id === id);
  return series[0];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rawInputOnsetMs(raw: FeelCaptureRawResult): number | undefined {
  if (raw.inputOnsetMs !== undefined) return raw.inputOnsetMs;
  const dispatch = raw.data?.dispatch;
  if (!isRecord(dispatch)) return undefined;
  return finiteNumber(dispatch.dispatchedMs) ?? finiteNumber(dispatch.atMs);
}

function assembleTraceMetric(raw: FeelCaptureRawResult): { value?: number; reason?: string } {
  const replay = raw.data?.replay;
  const durationMs = finiteNumber(raw.data?.durationMs) ?? (isRecord(replay) ? finiteNumber(replay.durationMs) : undefined);
  if (durationMs === undefined) {
    return { reason: "trace replay did not report a finite durationMs value." };
  }
  return { value: durationMs };
}

function assembleBisectionMetric(raw: FeelCaptureRawResult): { value?: number; reason?: string } {
  const trials = raw.data?.trials;
  if (!Array.isArray(trials)) return { reason: "semantic probe did not report bisection trials." };
  const result = interpretBisection(trials);
  if (result.windowSeconds === null) {
    return { reason: result.reason ?? "semantic probe trials did not bracket a boundary." };
  }
  return { value: result.windowSeconds };
}

function assemblePhaseDeltaMetric(
  recipe: AssembleMetricRecipe,
  raw: FeelCaptureRawResult,
): { value?: number; reason?: string } {
  if (!Number.isInteger(recipe.phaseIndex) || (recipe.phaseIndex ?? -1) < 0) {
    return { reason: "phase-delta derivation requires a non-negative phaseIndex." };
  }
  const phases = raw.data?.phases;
  if (!Array.isArray(phases)) return { reason: "capture did not report per-phase motion evidence." };
  const phase = phases.find((entry) => isRecord(entry) && finiteNumber(entry.index) === recipe.phaseIndex);
  if (!isRecord(phase)) return { reason: `capture did not report phase ${recipe.phaseIndex}.` };
  const requiredKeys = recipe.requiredKeys ?? [];
  if (requiredKeys.length > 0) {
    const actualKeys = Array.isArray(phase.keys) ? phase.keys.filter((key): key is string => typeof key === "string") : [];
    // Compare case-insensitively: setup emits the developer's typed key casing ("d", "leftShift")
    // while the bridge canonicalizes captured phase keys to InputSystem Key enum names
    // ("D", "LeftShift"). A case-sensitive match would falsely demote a genuinely-held key.
    const actual = new Set(actualKeys.map((key) => key.toLowerCase()));
    const missing = requiredKeys.filter((key) => !actual.has(key.toLowerCase()));
    if (missing.length > 0) {
      return { reason: `phase ${recipe.phaseIndex} did not hold required key(s): ${missing.join(", ")}.` };
    }
  }
  const key = recipe.axis === "y" ? "deltaY" : "deltaX";
  const delta = finiteNumber(phase[key]);
  if (delta === undefined) return { reason: `phase ${recipe.phaseIndex} did not report finite ${key}.` };
  return { value: Math.abs(delta) };
}

function assembleSyncMetric(
  recipe: AssembleMetricRecipe,
  raw: FeelCaptureRawResult,
): { value?: number; reason?: string } {
  const metric = recipe.deriveAs ?? recipe.metric;
  const targetSeries = findSeries(raw, recipe.seriesId);
  const inputOnsetMs = rawInputOnsetMs(raw);
  const targetValue = recipe.targetValue ?? true;
  const result =
    metric === "dashToGhostMs"
      ? deriveDashToGhostLatency(findSeries(raw, recipe.referenceSeriesId), targetSeries)
      : metric === "ttkMs"
        ? deriveTimeToKill(findSeries(raw, recipe.referenceSeriesId), targetSeries)
        : metric === "groundContactToDustMs"
        ? deriveGroundContactToDustLatency(raw.samples ?? [], targetSeries)
        : metric === "inputToAnimStateLatency"
          ? deriveInputToAnimStateLatency(targetSeries, inputOnsetMs, targetValue)
          : metric === "fireIntervalMs"
            ? deriveFireIntervalMs(targetSeries)
            : metric === "fireInputToSpawnLatency"
              ? deriveInputToSpawnLatency(targetSeries, inputOnsetMs)
              : deriveInputToSfxLatency(targetSeries, inputOnsetMs);
  if (!result.ok) return { reason: result.reason };
  return { value: result.latencyMs };
}

export function assembleFeelCaptureMeasurements(args: {
  recipes: AssembleMetricRecipe[];
  raw: FeelCaptureRawResult[];
}): {
  metrics: Record<string, number>;
  coverage: FeelCaptureCoverageEntry[];
  omitted: { metric: string; reason: string }[];
} {
  const rawById = new Map(args.raw.map((r) => [r.interactionId, r]));
  const metrics: Record<string, number> = {};
  const coverage: FeelCaptureCoverageEntry[] = [];
  const omitted: { metric: string; reason: string }[] = [];

  for (const recipe of args.recipes) {
    if (recipe.derivation === "unsupported") {
      const reason = recipe.reason ?? "not measured — this interaction is unsupported by Unity automation.";
      coverage.push({ metric: recipe.metric, status: "unsupported", reason, interactionId: recipe.interactionId });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    if (!recipe.interactionId) {
      const reason = recipe.reason ?? "not measured — no capture recipe is bound to this metric.";
      coverage.push({ metric: recipe.metric, status: "not-measured", reason });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    const raw = rawById.get(recipe.interactionId);
    if (!raw) {
      const reason = "not measured — capture recipe was not run.";
      coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: recipe.interactionId });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    if (raw.status !== "measured") {
      const status = raw.status === "unsupported" ? "unsupported" : "attempted-blocked";
      const reason = raw.reason ?? `capture ${raw.status}.`;
      coverage.push({ metric: recipe.metric, status, reason, interactionId: raw.interactionId, source: raw.source });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    if (recipe.derivation === "sync") {
      const derived = assembleSyncMetric(recipe, raw);
      if (derived.value === undefined) {
        const reason = recipe.reason ?? derived.reason ?? `sync derivation inconclusive for ${recipe.metric}.`;
        coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
        omitted.push({ metric: recipe.metric, reason });
        continue;
      }
      metrics[recipe.metric] = Number(derived.value.toFixed(4));
      coverage.push({ metric: recipe.metric, status: "measured", interactionId: raw.interactionId, source: raw.source });
      continue;
    }
    if (recipe.derivation === "trace") {
      const derived = assembleTraceMetric(raw);
      if (derived.value === undefined) {
        const reason = recipe.reason ?? derived.reason ?? `trace derivation inconclusive for ${recipe.metric}.`;
        coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
        omitted.push({ metric: recipe.metric, reason });
        continue;
      }
      metrics[recipe.metric] = Number(derived.value.toFixed(4));
      coverage.push({ metric: recipe.metric, status: "measured", interactionId: raw.interactionId, source: raw.source });
      continue;
    }
    if (recipe.derivation === "bisection") {
      const derived = assembleBisectionMetric(raw);
      if (derived.value === undefined) {
        const reason = recipe.reason ?? derived.reason ?? `bisection derivation inconclusive for ${recipe.metric}.`;
        coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
        omitted.push({ metric: recipe.metric, reason });
        continue;
      }
      metrics[recipe.metric] = Number(derived.value.toFixed(4));
      coverage.push({ metric: recipe.metric, status: "measured", interactionId: raw.interactionId, source: raw.source });
      continue;
    }
    if (recipe.derivation === "phase-delta") {
      const derived = assemblePhaseDeltaMetric(recipe, raw);
      if (derived.value === undefined) {
        const reason = recipe.reason ?? derived.reason ?? `phase-delta derivation inconclusive for ${recipe.metric}.`;
        coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
        omitted.push({ metric: recipe.metric, reason });
        continue;
      }
      metrics[recipe.metric] = Number(derived.value.toFixed(4));
      coverage.push({ metric: recipe.metric, status: "measured", interactionId: raw.interactionId, source: raw.source });
      continue;
    }
    if (recipe.derivation !== "trajectory") {
      const reason = recipe.reason ?? `not measured — derivation '${recipe.derivation}' is not implemented by the generic assembler.`;
      coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    if (!isValidTrajectory(raw.samples)) {
      const reason = "derivation inconclusive — raw trajectory is missing or invalid.";
      coverage.push({ metric: recipe.metric, status: "attempted-blocked", reason, interactionId: raw.interactionId, source: raw.source });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    const derived = deriveMetric(recipe.deriveAs ?? recipe.metric, raw.samples, rawInputOnsetMs(raw));
    if (derived === null) {
      const reason = `derivation inconclusive — ${recipe.metric} could not be derived from this trajectory.`;
      coverage.push({ metric: recipe.metric, status: "not-measured", reason, interactionId: raw.interactionId, source: raw.source });
      omitted.push({ metric: recipe.metric, reason });
      continue;
    }
    metrics[recipe.metric] = Number(derived.toFixed(4));
    coverage.push({ metric: recipe.metric, status: "measured", interactionId: raw.interactionId, source: raw.source });
  }

  return { metrics, coverage, omitted };
}
