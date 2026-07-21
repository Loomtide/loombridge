/**
 * Parallax-motion gate.
 *
 * Verifies TargetFollow parallax from raw texture-offset samples. Coverage can
 * prove the backdrop never exposes an edge; this gate proves the layers actually
 * move at distinct, proportional depths instead of being flat pasted strips.
 */

import type { AcceptanceContract } from "../types.js";
import { numberGateTuning } from "../gate-tuning.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

export const GATE_NAME = "parallax-motion";

export interface ParallaxMotionSample {
  state?: string;
  offsetX?: number;
  offsetY?: number;
  playerX?: number;
  playerY?: number;
}

export interface ParallaxMotionLayer {
  name: string;
  mode?: string;
  factorX?: number;
  factorY?: number;
  tileWorldWidth?: number;
  tileWorldHeight?: number;
  samples?: ParallaxMotionSample[];
}

export interface ParallaxMotionInput {
  layers?: ParallaxMotionLayer[];
}

interface RatioSample {
  layer: string;
  ratio: number;
  expectedRatio: number;
  tolerance: number;
}

const EPS = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function layerName(layer: ParallaxMotionLayer): string {
  return layer.name || "(unnamed)";
}

function repeatDelta(delta: number): number {
  const wrapped = ((delta + 0.5) % 1 + 1) % 1;
  return wrapped - 0.5;
}

function absTolerance(acceptance: AcceptanceContract): number {
  return numberGateTuning(acceptance, GATE_NAME, "parallaxMotionAbsTolerance") ?? acceptance.platformer?.parallaxMotionAbsTolerance ?? 0.015;
}

function relTolerance(acceptance: AcceptanceContract): number {
  return numberGateTuning(acceptance, GATE_NAME, "parallaxMotionRelTolerance") ?? acceptance.platformer?.parallaxMotionRelTolerance ?? 0.15;
}

function idleTolerance(acceptance: AcceptanceContract): number {
  return numberGateTuning(acceptance, GATE_NAME, "parallaxMotionIdleTolerance") ?? acceptance.platformer?.parallaxMotionIdleTolerance ?? 0.001;
}

function toleranceFor(expected: number, acceptance: AcceptanceContract): number {
  return Math.max(absTolerance(acceptance), Math.abs(expected) * relTolerance(acceptance));
}

function sampleReady(sample: ParallaxMotionSample): boolean {
  return (
    isFiniteNumber(sample.offsetX) &&
    isFiniteNumber(sample.offsetY) &&
    isFiniteNumber(sample.playerX) &&
    isFiniteNumber(sample.playerY)
  );
}

function firstIdleSample(samples: ParallaxMotionSample[]): ParallaxMotionSample | undefined {
  return samples.find((sample) => sample.state === "idle" && sampleReady(sample));
}

function drivenSamples(samples: ParallaxMotionSample[]): ParallaxMotionSample[] {
  return samples.filter((sample) => sample.state !== "idle" && sampleReady(sample));
}

function evaluateIdle(layer: ParallaxMotionLayer, acceptance: AcceptanceContract): GateCheck | null {
  const samples = (layer.samples ?? []).filter((sample) => sample.state === "idle" && sampleReady(sample));
  if (samples.length < 2) return null;
  const base = samples[0]!;
  const tol = idleTolerance(acceptance);
  let maxDelta = 0;
  for (const sample of samples.slice(1)) {
    maxDelta = Math.max(
      maxDelta,
      Math.abs(repeatDelta(sample.offsetX! - base.offsetX!)),
      Math.abs(repeatDelta(sample.offsetY! - base.offsetY!)),
    );
  }
  return {
    id: `parallax-motion.idle.${layerName(layer)}`,
    expected: `idle texture offset constant within ±${tol}`,
    actual: `max circular Δ=${maxDelta.toFixed(4)}`,
    status: maxDelta <= tol ? "pass" : "fail",
    detail:
      maxDelta <= tol
        ? `Layer "${layerName(layer)}" is still while the player is idle.`
        : `Layer "${layerName(layer)}" changes texture offset while the player is idle; TargetFollow must not leak a time/drift term.`,
  };
}

function axisResponse(
  layer: ParallaxMotionLayer,
  sample: ParallaxMotionSample,
  baseline: ParallaxMotionSample,
  axis: "x" | "y",
  tileSize: number,
  factor: number,
  acceptance: AcceptanceContract,
): { ok: boolean; detail: string; ratio?: RatioSample } {
  const offsetKey = axis === "x" ? "offsetX" : "offsetY";
  const playerKey = axis === "x" ? "playerX" : "playerY";
  const playerDelta = sample[playerKey]! - baseline[playerKey]!;
  const measured = repeatDelta(sample[offsetKey]! - baseline[offsetKey]!);
  const expectedRaw = playerDelta * factor / tileSize;
  const expected = repeatDelta(expectedRaw);
  const tol = toleranceFor(expected, acceptance);
  const error = Math.abs(measured - expected);
  const ok = error <= tol;
  return {
    ok,
    detail: `${axis}: measured=${measured.toFixed(4)} expected=${expected.toFixed(4)} playerΔ=${playerDelta.toFixed(4)} factor=${factor} tile=${tileSize} tol=${tol.toFixed(4)}`,
    ratio:
      Math.abs(playerDelta) > EPS && Math.abs(factor) > EPS
        ? {
            layer: layerName(layer),
            ratio: measured / playerDelta,
            expectedRatio: factor / tileSize,
            tolerance: Math.max(absTolerance(acceptance) / Math.abs(playerDelta), Math.abs(factor / tileSize) * relTolerance(acceptance)),
          }
        : undefined,
  };
}

function evaluateResponse(
  layer: ParallaxMotionLayer,
  acceptance: AcceptanceContract,
): { check: GateCheck; ratiosX: RatioSample[]; ratiosY: RatioSample[] } {
  const samples = layer.samples ?? [];
  const baseline = firstIdleSample(samples);
  const driven = drivenSamples(samples);
  const ratiosX: RatioSample[] = [];
  const ratiosY: RatioSample[] = [];

  if (!baseline || driven.length === 0) {
    return {
      check: {
        id: `parallax-motion.response.${layerName(layer)}`,
        expected: "≥1 idle baseline sample and ≥1 driven sample with offset/player positions",
        actual: `idle=${baseline ? 1 : 0}, driven=${driven.length}`,
        status: "warn",
        detail: `Layer "${layerName(layer)}" does not have enough TargetFollow samples to verify proportional response.`,
      },
      ratiosX,
      ratiosY,
    };
  }

  const factorX = layer.factorX!;
  const factorY = layer.factorY!;
  const tileW = layer.tileWorldWidth!;
  const tileH = layer.tileWorldHeight!;

  const failures: string[] = [];
  const details: string[] = [];
  let xRatioAdded = false;
  let yRatioAdded = false;
  for (const sample of driven) {
    const x = axisResponse(layer, sample, baseline, "x", tileW, factorX, acceptance);
    const y = axisResponse(layer, sample, baseline, "y", tileH, factorY, acceptance);
    details.push(`${sample.state ?? "(driven)"} [${x.detail}; ${y.detail}]`);
    if (!x.ok) failures.push(`${sample.state ?? "(driven)"} ${x.detail}`);
    if (!y.ok) failures.push(`${sample.state ?? "(driven)"} ${y.detail}`);
    if (x.ratio && !xRatioAdded) {
      ratiosX.push(x.ratio);
      xRatioAdded = true;
    }
    if (y.ratio && !yRatioAdded) {
      ratiosY.push(y.ratio);
      yRatioAdded = true;
    }
  }

  return {
    check: {
      id: `parallax-motion.response.${layerName(layer)}`,
      expected: "circular offsetΔ ≈ playerΔ × factor / tileWorldSize per axis; factor 0 means no motion",
      actual: details.join(" | "),
      status: failures.length === 0 ? "pass" : "fail",
      detail:
        failures.length === 0
          ? `Layer "${layerName(layer)}" tracks TargetFollow displacement on every driven sample.`
          : `Layer "${layerName(layer)}" does not match its declared TargetFollow factor: ${failures.join(" | ")}`,
    },
    ratiosX,
    ratiosY,
  };
}

function depthAxisPass(ratios: RatioSample[]): boolean {
  if (ratios.length < 2) return false;
  const ordered = [...ratios].sort((a, b) => a.expectedRatio - b.expectedRatio);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const tol = Math.max(prev.tolerance, cur.tolerance);
    if (!(cur.expectedRatio - prev.expectedRatio > tol)) return false;
    if (!(cur.ratio - prev.ratio > tol)) return false;
  }
  return true;
}

function summarizeRatios(ratios: RatioSample[]): string {
  if (ratios.length === 0) return "(none)";
  return [...ratios]
    .sort((a, b) => a.expectedRatio - b.expectedRatio)
    .map((r) => `${r.layer}=${r.ratio.toFixed(4)} (expected ${r.expectedRatio.toFixed(4)})`)
    .join(", ");
}

function evaluateDepth(ratiosX: RatioSample[], ratiosY: RatioSample[], targetLayerCount: number): GateCheck {
  if (targetLayerCount === 0) {
    return {
      id: "parallax-motion.depth",
      expected: "TargetFollow layers with at least one active axis",
      actual: "no TargetFollow layers",
      status: "not_applicable",
      detail: "No TargetFollow layers were captured; AmbientDrift/CameraFollow need mode-specific formulas and are not graded by this gate.",
    };
  }

  const xPass = depthAxisPass(ratiosX);
  const yPass = depthAxisPass(ratiosY);
  return {
    id: "parallax-motion.depth",
    expected: "≥2 TargetFollow layers with distinct, depth-ordered measured ratios on at least one active axis",
    actual: `x: ${summarizeRatios(ratiosX)}; y: ${summarizeRatios(ratiosY)}`,
    status: xPass || yPass ? "pass" : "fail",
    detail:
      xPass || yPass
        ? `TargetFollow layers have distinct depth-ordered relative motion on ${xPass ? "X" : "Y"}.`
        : "TargetFollow layers do not show distinct depth-ordered motion on any active axis; this is consistent with flat/equal-motion cut-out strips.",
  };
}

function evaluateMode(layer: ParallaxMotionLayer): GateCheck | null {
  if (layer.mode === "TargetFollow") return null;
  if (layer.mode === "AmbientDrift" || layer.mode === "CameraFollow") {
    return {
      id: `parallax-motion.mode.${layerName(layer)}`,
      expected: 'mode "TargetFollow" for S4-parallax-a',
      actual: layer.mode,
      status: "not_applicable",
      detail: `Layer "${layerName(layer)}" is ${layer.mode}; AmbientDrift/CameraFollow need mode-specific formulas and are intentionally not graded here.`,
    };
  }
  return {
    id: `parallax-motion.mode.${layerName(layer)}`,
    expected: 'explicit mode "TargetFollow", "AmbientDrift", or "CameraFollow"',
    actual: layer.mode ?? "(absent)",
    status: "fail",
    detail: `Layer "${layerName(layer)}" is missing a known parallax mode. The emitter must not omit mode metadata to escape TargetFollow grading.`,
  };
}

function evaluateTargetMetadata(layer: ParallaxMotionLayer): GateCheck | null {
  const ok =
    isFiniteNumber(layer.factorX) &&
    isFiniteNumber(layer.factorY) &&
    isFiniteNumber(layer.tileWorldWidth) &&
    layer.tileWorldWidth > 0 &&
    isFiniteNumber(layer.tileWorldHeight) &&
    layer.tileWorldHeight > 0;
  if (ok) return null;
  return {
    id: `parallax-motion.metadata.${layerName(layer)}`,
    expected: "TargetFollow capture declares factorX, factorY, positive tileWorldWidth, and positive tileWorldHeight",
    actual: `factorX=${String(layer.factorX)}, factorY=${String(layer.factorY)}, tileWorldWidth=${String(layer.tileWorldWidth)}, tileWorldHeight=${String(layer.tileWorldHeight)}`,
    status: "fail",
    detail: `Layer "${layerName(layer)}" is TargetFollow but omitted required mapping metadata. Missing factors or tile sizes must fail, not default to static/no-motion.`,
  };
}

export function evaluateParallaxMotion(
  input: ParallaxMotionInput,
  acceptance: AcceptanceContract,
): GateReport {
  const layers = input.layers ?? [];
  if (layers.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "parallax-motion.data",
        expected: "≥1 parallax layer motion capture",
        actual: "(none)",
        status: "warn",
        detail:
          "No parallax-motion data captured; TargetFollow depth motion was not evaluated. Emit parallax-motion.json with layer mode/factors/tile sizes and idle/run/apex offset samples.",
      },
    ]);
  }

  const checks: GateCheck[] = [];
  const ratiosX: RatioSample[] = [];
  const ratiosY: RatioSample[] = [];
  let targetLayerCount = 0;

  for (const layer of layers) {
    const modeCheck = evaluateMode(layer);
    if (modeCheck) {
      checks.push(modeCheck);
      continue;
    }

    targetLayerCount += 1;
    const metadata = evaluateTargetMetadata(layer);
    if (metadata) {
      checks.push(metadata);
      continue;
    }
    const idle = evaluateIdle(layer, acceptance);
    if (idle) checks.push(idle);
    const response = evaluateResponse(layer, acceptance);
    checks.push(response.check);
    ratiosX.push(...response.ratiosX);
    ratiosY.push(...response.ratiosY);
  }

  checks.push(evaluateDepth(ratiosX, ratiosY, targetLayerCount));
  return makeGateReport(GATE_NAME, checks);
}
