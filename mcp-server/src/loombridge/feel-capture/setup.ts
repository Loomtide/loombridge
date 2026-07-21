import fs from "node:fs/promises";
import path from "node:path";

import type {
  FeelCaptureContract,
  FeelCaptureInteraction,
  FeelCapturePrecondition,
  FeelCaptureSettleSpec,
  FeelCaptureSignal,
  FeelMetricRecipe,
  FeelSemanticProbeMetric,
} from "./types.js";
import { SHORT_HOP_CANONICAL_TAP_TICKS } from "../feel-primitives.js";
import { assertValidFeelCaptureContract } from "./validator.js";

export interface FeelCaptureSetupOptions {
  root: string;
  game?: string;
  playerPath: string;
  scene?: string;
  jumpButtonPath?: string;
  joystickPath?: string;
  moveRightKey?: string;
  jumpKey?: string;
  dashKey?: string;
  semanticProbes?: Extract<FeelCaptureInteraction, { kind: "semantic-probe" }>[];
  activatePaths?: string[];
  autoActivateUiRoot?: boolean;
  /**
   * Proposed Animator bool to sample as a measure-only `inputToAnimStateLatency`
   * sync signal on the jump interaction. Attached only when a jump interaction
   * exists; never fabricated, and a missing Animator simply leaves it unset.
   */
  animatorBoolSignal?: { bool: string; host?: string };
  outputPath?: string;
  force?: boolean;
}

const DASH_DISTANCE_CANONICAL_HOLD_MS = 150;

/**
 * Conservative defaults for the generic grounded-settle precondition that gates the
 * fixed-tick short-hop probe. They use only observable subject motion (no game-specific
 * grounded flag) so the same recipe generalizes across jump-bearing games, including
 * pointer/uGUI games where the settle observation must not depend on keyboard injection.
 */
const SHORT_HOP_SETTLE_TIMEOUT_MS = 3000;
const SHORT_HOP_SETTLE_POLL_MS = 200;
const SHORT_HOP_SETTLE_MIN_STABLE_SAMPLES = 6;
const SHORT_HOP_SETTLE_MIN_STABLE_MS = 100;
const SHORT_HOP_SETTLE_REST_THRESHOLD = 0.02;

function shortHopSettle(measure: { path: string; scene?: string }): FeelCaptureSettleSpec {
  return {
    kind: "settle-until-rest",
    measure,
    timeoutMs: SHORT_HOP_SETTLE_TIMEOUT_MS,
    pollMs: SHORT_HOP_SETTLE_POLL_MS,
    minStableSamples: SHORT_HOP_SETTLE_MIN_STABLE_SAMPLES,
    minStableMs: SHORT_HOP_SETTLE_MIN_STABLE_MS,
    restThreshold: SHORT_HOP_SETTLE_REST_THRESHOLD,
  };
}

function loc(pathValue: string, scene?: string): { path: string; scene?: string } {
  return scene ? { path: pathValue, scene } : { path: pathValue };
}

function normalizePath(pathValue: string): string {
  if (pathValue === "/") return "/";
  return `/${pathValue.split("/").filter(Boolean).join("/")}`;
}

function parentPath(pathValue: string): string | undefined {
  const parts = normalizePath(pathValue).split("/").filter(Boolean);
  if (parts.length <= 1) return undefined;
  return `/${parts.slice(0, -1).join("/")}`;
}

function commonAncestor(paths: string[]): string | undefined {
  const split = paths
    .map((p) => normalizePath(p).split("/").filter(Boolean))
    .filter((p) => p.length > 1);
  if (split.length === 0) return undefined;
  const common: string[] = [];
  for (let i = 0; i < split[0].length - 1; i += 1) {
    const segment = split[0][i];
    if (split.every((parts) => parts[i] === segment)) common.push(segment);
    else break;
  }
  return common.length > 0 ? `/${common.join("/")}` : undefined;
}

function activationPreconditions(opts: FeelCaptureSetupOptions): FeelCapturePrecondition[] {
  const explicit = (opts.activatePaths ?? []).map((p) => normalizePath(p));
  const inferred = opts.autoActivateUiRoot === false
    ? []
    : [
        commonAncestor([opts.jumpButtonPath, opts.joystickPath].filter((p): p is string => !!p))
          ?? parentPath(opts.jumpButtonPath ?? "")
          ?? parentPath(opts.joystickPath ?? ""),
      ].filter((p): p is string => !!p);
  return [...new Set([...explicit, ...inferred])].map((pathValue) => ({
    kind: "scene-set-active" as const,
    locator: loc(pathValue, opts.scene),
    active: true,
    restore: true,
  }));
}

export function proposeFeelCaptureContract(opts: FeelCaptureSetupOptions): FeelCaptureContract {
  const player = loc(opts.playerPath, opts.scene);
  const interactions: FeelCaptureInteraction[] = [];
  const metrics: FeelMetricRecipe[] = [];
  const preconditions = activationPreconditions(opts);
  let jumpInteractionId: string | undefined;

  if (opts.jumpButtonPath) {
    jumpInteractionId = "jump-tap";
    interactions.push({
      id: "jump-tap",
      kind: "ugui-tap",
      measure: player,
      target: loc(opts.jumpButtonPath, opts.scene),
      settleMs: 400,
      captureMs: 1300,
    });
    metrics.push({ metric: "jumpApex", interactionId: "jump-tap", derivation: "trajectory" });
    metrics.push({ metric: "timeToApex", interactionId: "jump-tap", derivation: "trajectory" });
    metrics.push({ metric: "fallGravityMultiplier", interactionId: "jump-tap", derivation: "trajectory" });
    interactions.push({
      id: "short-hop-hold",
      kind: "ugui-hold",
      measure: player,
      target: loc(opts.jumpButtonPath, opts.scene),
      holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      settle: shortHopSettle(player),
      settleMs: 400,
      captureMs: 1300,
    });
    metrics.push({
      metric: "shortHopApex",
      interactionId: "short-hop-hold",
      derivation: "trajectory",
      stimulus: {
        metric: "shortHopApex",
        tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
      },
    });
    interactions.push({
      id: "double-jump-taps",
      kind: "ugui-multitap",
      measure: player,
      target: loc(opts.jumpButtonPath, opts.scene),
      taps: [{ atMs: 400 }, { atMs: 580 }],
      captureMs: 1300,
    });
    metrics.push({ metric: "doubleJumpApex", interactionId: "double-jump-taps", derivation: "trajectory", deriveAs: "jumpApex" });
  } else if (opts.jumpKey) {
    jumpInteractionId = "jump-key";
    interactions.push({
      id: "jump-key",
      kind: "keyboard",
      measure: player,
      phases: [
        { keys: [], durationMs: 200 },
        { keys: [opts.jumpKey], durationMs: 900 },
      ],
    });
    metrics.push({ metric: "jumpApex", interactionId: "jump-key", derivation: "trajectory" });
    metrics.push({ metric: "timeToApex", interactionId: "jump-key", derivation: "trajectory" });
    metrics.push({ metric: "fallGravityMultiplier", interactionId: "jump-key", derivation: "trajectory" });
    interactions.push({
      id: "short-hop-key",
      kind: "keyboard",
      measure: player,
      settle: shortHopSettle(player),
      phases: [
        { keys: [], durationMs: 200 },
        { keys: [opts.jumpKey], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
        { keys: [], durationMs: 1100 },
      ],
    });
    metrics.push({
      metric: "shortHopApex",
      interactionId: "short-hop-key",
      derivation: "trajectory",
      stimulus: {
        metric: "shortHopApex",
        tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
      },
    });
  } else {
    metrics.push({
      metric: "jumpApex",
      derivation: "unsupported",
      reason: "not measured — declare a jump button, Input System key, or test hook.",
    });
    metrics.push({
      metric: "timeToApex",
      derivation: "unsupported",
      reason: "not measured — declare a jump button, Input System key, or test hook.",
    });
    metrics.push({
      metric: "fallGravityMultiplier",
      derivation: "unsupported",
      reason: "not measured — declare a full-jump drive recipe that captures ascent and descent.",
    });
  }
  if (!opts.jumpKey && !opts.jumpButtonPath) {
    metrics.push({
      metric: "shortHopApex",
      derivation: "unsupported",
      reason: "not measured — declare a jump button or Input System jump key so generated setup can drive the canonical fixed-tick jump-cut stimulus.",
    });
  }

  if (opts.joystickPath) {
    interactions.push({
      id: "run-joystick",
      kind: "ugui-hold-drag",
      measure: player,
      target: loc(opts.joystickPath, opts.scene),
      dragTo: { dx: 220, dy: 0 },
      settleMs: 300,
      captureMs: 1200,
      releaseMs: 900,
    });
    metrics.push({ metric: "runSpeed", interactionId: "run-joystick", derivation: "trajectory" });
    metrics.push({ metric: "runAcceleration", interactionId: "run-joystick", derivation: "trajectory" });
    metrics.push({ metric: "runDeceleration", interactionId: "run-joystick", derivation: "trajectory" });
    metrics.push({ metric: "inputLatency", interactionId: "run-joystick", derivation: "trajectory" });
  } else if (opts.moveRightKey) {
    interactions.push({
      id: "run-key",
      kind: "keyboard",
      measure: player,
      phases: [
        { keys: [], durationMs: 200 },
        { keys: [opts.moveRightKey], durationMs: 900 },
        { keys: [], durationMs: 400 },
      ],
    });
    metrics.push({ metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" });
    metrics.push({ metric: "runAcceleration", interactionId: "run-key", derivation: "trajectory" });
    metrics.push({ metric: "runDeceleration", interactionId: "run-key", derivation: "trajectory" });
    metrics.push({ metric: "inputLatency", interactionId: "run-key", derivation: "trajectory" });
  } else {
    metrics.push({
      metric: "runSpeed",
      derivation: "unsupported",
      reason: "not measured — declare a joystick, Input System key, or test hook.",
    });
    metrics.push({
      metric: "runAcceleration",
      derivation: "unsupported",
      reason: "not measured — declare a joystick, Input System key, or test hook.",
    });
    metrics.push({
      metric: "runDeceleration",
      derivation: "unsupported",
      reason: "not measured — declare a run recipe with release/settle evidence.",
    });
    metrics.push({
      metric: "inputLatency",
      derivation: "unsupported",
      reason: "not measured — declare a run input so onset-to-motion latency can be derived.",
    });
  }

  if (opts.moveRightKey && opts.dashKey) {
    interactions.push({
      id: "dash-key",
      kind: "keyboard",
      measure: player,
      phases: [
        { keys: [], durationMs: 200 },
        { keys: [opts.moveRightKey], durationMs: 300 },
        { keys: [opts.moveRightKey, opts.dashKey], durationMs: DASH_DISTANCE_CANONICAL_HOLD_MS },
        { keys: [opts.moveRightKey], durationMs: 300 },
      ],
    });
    metrics.push({
      metric: "dashDistance",
      interactionId: "dash-key",
      derivation: "phase-delta",
      phaseIndex: 2,
      axis: "x",
      requiredKeys: [opts.moveRightKey, opts.dashKey],
    });
  } else {
    metrics.push({
      metric: "dashDistance",
      derivation: "unsupported",
      reason: opts.joystickPath
        ? "not measured by generated setup yet — mobile dash requires simultaneous joystick + dash-button multi-pointer support."
        : "not measured — declare Input System move-right and dash keys so generated setup can isolate the dash phase.",
    });
  }

  const semanticProbeMetrics = new Set<FeelSemanticProbeMetric>();
  for (const probe of opts.semanticProbes ?? []) {
    interactions.push(probe);
    semanticProbeMetrics.add(probe.metric);
    metrics.push({
      metric: probe.metric,
      interactionId: probe.id,
      derivation: "bisection",
    });
  }
  if (!semanticProbeMetrics.has("coyoteTime")) {
    metrics.push({
      metric: "coyoteTime",
      derivation: "unsupported",
      reason:
        "not measured — generated setup needs an explicit semantic-probe contract with ledge/ground-lost and jump-input anchors for input-timing bisection.",
    });
  }
  if (!semanticProbeMetrics.has("jumpBuffer")) {
    metrics.push({
      metric: "jumpBuffer",
      derivation: "unsupported",
      reason:
        "not measured — generated setup needs an explicit semantic-probe contract with landing/grounded-ready and pre-jump-buffered-input anchors for input-timing bisection.",
    });
  }

  // L3 sync: a measure-only input→anim-state latency from a sampled Animator bool.
  // Attached ONLY when a jump interaction exists to carry it; never fabricated.
  if (opts.animatorBoolSignal && jumpInteractionId) {
    const signalId = `anim-${opts.animatorBoolSignal.bool}`;
    const signal: FeelCaptureSignal = {
      id: signalId,
      locator: loc(opts.animatorBoolSignal.host ?? opts.playerPath, opts.scene),
      type_name: "Animator",
      method_name: "GetBool",
      args: [opts.animatorBoolSignal.bool],
    };
    const jump = interactions.find((i) => i.id === jumpInteractionId);
    if (
      jump
      && (jump.kind === "keyboard" || jump.kind === "ugui-tap" || jump.kind === "ugui-multitap"
        || jump.kind === "ugui-hold-drag" || jump.kind === "ugui-hold" || jump.kind === "world-pointer"
        || jump.kind === "trace-replay")
    ) {
      jump.sampledFields = [...(jump.sampledFields ?? []), signal];
      metrics.push({
        metric: "inputToAnimStateLatency",
        interactionId: jumpInteractionId,
        derivation: "sync",
        seriesId: signalId,
        targetValue: true,
      });
    }
  }

  return assertValidFeelCaptureContract({
    schemaVersion: "1",
    game: opts.game,
    subjects: [{ id: "player", role: "primary controlled subject", locator: player }],
    ...(preconditions.length === 0 ? {} : { preconditions }),
    interactions,
    metrics,
  });
}

export async function writeFeelCaptureContract(
  contract: FeelCaptureContract,
  outputPath: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  let exists = false;
  try {
    await fs.access(outputPath);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists && !opts.force) throw new Error(`${outputPath} already exists; pass --force to overwrite.`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(assertValidFeelCaptureContract(contract), null, 2)}\n`, "utf-8");
}
