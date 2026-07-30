/**
 * THE FEEL PRODUCER (evidence arc E1; ledger L45/L46/L75/L76/L77, C1).
 *
 * `loombridge capture --slice <feel slice>` drives the canonical feel measurements
 * itself and writes `feel.json` from the bridge's OWN echoes. The file it replaces
 * was the moat's worst case: the door-one run's `feel.json` was 100 percent
 * agent-authored, every provenance field the gate reads was a literal the assembler
 * typed (`captureFps: FPS` where FPS was a module constant), the canonical-tap check
 * graded a hand-typed `tapTicks: 6` against a capture the bridge had reported as 7
 * ticks, and the coyote trial table was retyped from console output with three of
 * six rows having no raw file on disk at all. The same file with fabricated numbers
 * passed every gate identically.
 *
 * WHAT IS DIFFERENT HERE, mechanically:
 *   - every provenance field is copied from the op response, never from a constant
 *     or from the contract (the one exception is `captureFps`, which is an INPUT the
 *     op does not echo: it is recorded as `requestedCaptureFps` NEXT TO an
 *     `effectiveCaptureFps` re-derived from the echoed sampleCount/durationMs: H8);
 *   - `stimulus.tapTicks` is bound to the ECHOED `actualFixedTicks` of the tap phase,
 *     so a 6-tick request that really ran 7 ticks is refused by the canonical-tap
 *     check instead of passing as a typed 6 (L46/L40);
 *   - the coyote/jumpBuffer sweeps retain EVERY trial's raw echo, and the reported
 *     window is a pure function of those trials (`deriveSweepMetric` in
 *     `domain/feel-primitives.ts`), which the gate re-runs (L76/L77);
 *   - the seam-driven leg DISABLES the live input reader and PROVES the disable
 *     behaviorally before it measures anything (C1/L117, review M15).
 *
 * SESSION SHAPE (the ordering is load-bearing):
 *   1. play + input session
 *   2. warm-up tap                     : the cold-start caveat in feel-primitives.ts:
 *                                         a session's FIRST injected tap runs ~1 tick
 *                                         cold, so it must not be a graded capture
 *   3. KEYED legs, input reader LIVE   : capture_input_motion injects real keys, so
 *                                         the reader is the path they travel
 *   4. SEAM legs, input reader DISABLED: a probe writes the drive fields directly,
 *                                         where a live reader would zero them (C1)
 *   5. restore (re-enable, end session, stop) in a `finally`
 *
 * Nothing here judges the game: every number lands in `feel.json` and the gates
 * grade it. The only refusals are about the HARNESS (no seam declared, the reader
 * disable not provable, a sweep that does not bracket a threshold).
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { UnityClient } from "../../bridge/unity-client.js";
import type { BridgeResponse } from "../../shared/types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  type UnityRoutingMetadata,
} from "../../bridge/unity-client-resolver.js";
import {
  BRIDGE_SAMPLE_TICK_OFFSET,
  SHORT_HOP_CANONICAL_TAP_TICKS,
  deriveSweepMetric,
  firstDescentSampleIndex,
  landingSampleIndexAfter,
  type SweepMetric,
  type SweepTrialEcho,
  type TickSample,
} from "../../domain/feel-primitives.js";
import { resolveFeelSeam, type FeelSeam } from "../../domain/harness-seam.js";
import { deriveMetric, isValidTrajectory } from "./feel-derive.js";
import type { FeelMeasurementSource, FeelTrajectorySample } from "./gates/feel.js";

/** The producer marker every source this recipe writes carries (stage 1). */
export const FEEL_PRODUCER = "loombridge-capture";

/** Sampling cadence for the trajectory legs: finer than physics, resolves the short hop. */
export const TRAJECTORY_CAPTURE_FPS = 120;

/**
 * Ticks of settle before every keyed capture. Long enough for the previous leg's
 * motion to have stopped and the ground contact to be re-established.
 */
const SETTLE_TICKS = 12;

/**
 * Ticks of the run hold. Long, deliberately: `runSpeed` is the whole-window average,
 * so a controller with an acceleration ramp under-reads on a short window.
 */
const RUN_HOLD_TICKS = 90;

/** How many canonical short-hop attempts to capture (see SHORT_HOP_CAPTURE_ATTEMPTS rationale). */
const SHORT_HOP_ATTEMPTS = 3;

/** Sweep range floor/ceiling, in ticks, around the contract's target (when it has one). */
const SWEEP_MIN_TICKS = 8;
const SWEEP_MAX_TICKS = 20;
const SWEEP_DEFAULT_TICKS = 12;

/** Drive window for the reader-disable proof, in ticks. Short: the player is moving. */
const SEAM_PROOF_TICKS = 18;

/** Minimum displacement (u) the seam proof must produce before it means anything. */
const SEAM_PROOF_MIN_TOTAL_U = 0.05;

/**
 * Fraction of the average per-third displacement the FINAL third must still show.
 * A live reader zeroes the driven field every `Update`, so the driven value survives
 * one `FixedUpdate` and the tail of the window is flat (C1). A genuinely disabled
 * reader leaves a sustained ramp, whose final third is at least comparable to the
 * average. 0.2 is deliberately loose: this separates "moved all window" from "moved
 * one tick", not two similar ramps.
 */
const SEAM_PROOF_TAIL_FRACTION = 0.2;

export interface CaptureFeelArgs {
  /** Output dir for feel.json + console.json (the slice's verify dir). */
  outDir: string;
  /** The parsed acceptance contract (carries `harness.feelSeam` and `feel` targets). */
  contract: unknown;
  /** The minted `currentBuild.runId`. Stamped unconditionally (H11). */
  runId: string;
  /** Optional multi-editor routing target. */
  project?: string;
  /** Console log count to pull at the end of the session (default 200). */
  consoleCount?: number;
}

export interface CaptureFeelResult {
  feelPath: string;
  consolePath: string;
  /** Metrics written with a value. */
  measured: string[];
  /** Metrics attempted and honestly omitted, with the reason. */
  omitted: { metric: string; reason: string }[];
  /** Provenance gaps this run could not close (ops that echo too little). */
  gaps: string[];
  logCount: number;
}

/** The one wire primitive the session needs; a scripted fake satisfies it in tests. */
export type FeelSend = (
  command: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export interface FeelSessionOptions {
  send: FeelSend;
  contract: unknown;
  runId: string;
  editorSessionId?: string;
  unityRouting?: UnityRoutingMetadata;
  /** Injected clock so the emitted `measuredAt` is deterministic under test. */
  now?: () => string;
  log?: (message: string) => void;
  consoleCount?: number;
}

export interface FeelSessionOutput {
  /** The `feel.json` document, ready to write. */
  feel: Record<string, unknown>;
  /** The `console.json` document (logs pulled at the end of the session). */
  console: Record<string, unknown>;
  measured: string[];
  omitted: { metric: string; reason: string }[];
  gaps: string[];
  logCount: number;
}

// ── small readers over the op responses ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function samplesOf(data: unknown): TickSample[] {
  const raw = isRecord(data) ? data.samples : undefined;
  if (!Array.isArray(raw)) return [];
  const out: TickSample[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const tMs = num(entry.tMs);
    const x = num(entry.x);
    const y = num(entry.y);
    if (tMs === undefined || x === undefined || y === undefined) continue;
    out.push({ tMs, x, y });
  }
  return out;
}

function phasesOf(data: unknown): Record<string, unknown>[] {
  const raw = isRecord(data) ? data.phases : undefined;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/** The measurement window the op echoed (`durationMs`, or probe's `totalDurationMs`). */
function windowMsOf(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  return num(data.durationMs) ?? num(data.totalDurationMs);
}

/**
 * The EFFECTIVE sampling cadence, re-derived from the run's own echoes (H8/L47).
 * `captureFps` is an input the op never echoes back, so recording it alone lets a
 * file claim 120 for a capture that really sampled at 11Hz. N samples span N-1
 * intervals, which is the endpoint convention the gate's own re-derivation uses.
 */
export function effectiveCaptureFps(sampleCount: number | undefined, windowMs: number | undefined): number | undefined {
  if (sampleCount === undefined || windowMs === undefined) return undefined;
  if (sampleCount < 2 || windowMs <= 0) return undefined;
  return (sampleCount - 1) / (windowMs / 1000);
}

/** Round to 4dp for a readable file; the re-derive tolerance (1e-3) absorbs it. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ── the seam-disable proof (review M15) ─────────────────────────────────────

export interface SeamPersistenceVerdict {
  ok: boolean;
  reason?: string;
  totalDx: number;
  tailDx: number;
  /** Displacement the final third would show if motion were sustained evenly. */
  expectedTailDx: number;
}

/**
 * Did the driven seam value SURVIVE the window, or was it zeroed after a tick?
 *
 * This is the behavioral half of M15 and it exists because the read-back half
 * cannot be trusted to exist: component enabled state is write-only over the bridge
 * (ledger L117: `component.get_properties` on the reader returns only its script
 * reference and `runtime.get_snapshot` returns undefined), which is precisely what
 * let C1's misdiagnosis stand for a whole slice. So the recipe proves the disable by
 * its EFFECT: drive `moveX` for a window and require the motion to persist. With the
 * reader live, the driven value survives exactly one `FixedUpdate` and the window's
 * tail is flat.
 *
 * Pure, so the LITMUS is a synthetic trajectory: a one-tick-then-flat trace must
 * refuse, a sustained ramp must pass.
 */
export function evaluateSeamPersistence(samples: TickSample[]): SeamPersistenceVerdict {
  if (samples.length < 6) {
    return {
      ok: false,
      reason: `the seam proof returned ${samples.length} sample(s); at least 6 are needed to compare the window's tail against its whole.`,
      totalDx: 0,
      tailDx: 0,
      expectedTailDx: 0,
    };
  }
  const first = samples[0].x;
  const last = samples[samples.length - 1].x;
  const twoThirds = samples[Math.floor((samples.length - 1) * (2 / 3))].x;
  const totalDx = Math.abs(last - first);
  const tailDx = Math.abs(last - twoThirds);
  const expectedTailDx = totalDx / 3;
  if (totalDx < SEAM_PROOF_MIN_TOTAL_U) {
    return {
      ok: false,
      reason:
        `driving the seam moved the player ${totalDx.toFixed(4)}u, below the ${SEAM_PROOF_MIN_TOTAL_U}u floor: ` +
        "the declared drive field does not move this player (wrong component/field name), or the input reader zeroed it immediately.",
      totalDx,
      tailDx,
      expectedTailDx,
    };
  }
  if (tailDx < SEAM_PROOF_TAIL_FRACTION * expectedTailDx) {
    return {
      ok: false,
      reason:
        `the driven value did NOT survive the window: the final third moved ${tailDx.toFixed(4)}u against ${expectedTailDx.toFixed(4)}u expected from the total. ` +
        "That is the ledger-C1 signature: a live input reader rewriting the seam every Update, so the driver survives one FixedUpdate. " +
        "The declared harness.feelSeam.inputReaderComponent was not actually disabled; measuring through the seam now would report one tick of motion as the whole result.",
      totalDx,
      tailDx,
      expectedTailDx,
    };
  }
  return { ok: true, totalDx, tailDx, expectedTailDx };
}

// ── capture composition ─────────────────────────────────────────────────────

interface KeyedPhase {
  keys: string[];
  fixedTicks: number;
}

function keyedPhases(phases: KeyedPhase[]): Record<string, unknown>[] {
  return phases.map((p) => ({ keys: p.keys, fixedTicks: p.fixedTicks }));
}

/**
 * One `runtime.capture_input_motion` call, returned as its RAW response plus the
 * fields the sources need. Nothing is normalised away: `raw` is what lands in the
 * evidence file.
 */
interface KeyedCapture {
  raw: Record<string, unknown>;
  samples: TickSample[];
  phases: Record<string, unknown>[];
  sampleCount: number | undefined;
  durationMs: number | undefined;
  projectFixedTimestepBeforeMeasurement: number | undefined;
  measurementFixedTimestep: number | undefined;
  requestedCaptureFps: number;
}

/**
 * Read the player's world position, for the spawn restore below. Defensive about
 * the snapshot shape (the op returns "identity, active flags, transform values"):
 * an unreadable spawn is reported, never guessed.
 */
export function positionFromSnapshot(data: unknown): { x: number; y: number; z: number } | null {
  const roots: unknown[] = [data];
  if (isRecord(data)) {
    roots.push(data.transform, data.position);
    if (isRecord(data.transform)) roots.push(data.transform.position);
  }
  for (const root of roots) {
    if (!isRecord(root)) continue;
    const x = num(root.x);
    const y = num(root.y);
    if (x !== undefined && y !== undefined) return { x, y, z: num(root.z) ?? 0 };
  }
  return null;
}

async function keyedCapture(
  send: FeelSend,
  playerLocator: string,
  phases: KeyedPhase[],
  captureFps: number,
): Promise<KeyedCapture> {
  const data = await send(
    "runtime.capture_input_motion",
    {
      measure: { path: playerLocator },
      phases: keyedPhases(phases),
      captureFps,
      includeSamples: true,
    },
    120000,
  );
  const raw = isRecord(data) ? data : {};
  return {
    raw,
    samples: samplesOf(raw),
    phases: phasesOf(raw),
    sampleCount: num(raw.sampleCount),
    durationMs: windowMsOf(raw),
    projectFixedTimestepBeforeMeasurement: num(raw.projectFixedTimestepBeforeMeasurement),
    measurementFixedTimestep: num(raw.measurementFixedTimestep),
    requestedCaptureFps: captureFps,
  };
}

/** The echoed `actualFixedTicks` of one phase: the value the stimulus binds to (L46). */
export function actualFixedTicksOfPhase(
  phases: Record<string, unknown>[],
  phaseIndex: number,
): number | undefined {
  const phase = phases.find((p) => num(p.index) === phaseIndex);
  return phase ? num(phase.actualFixedTicks) : undefined;
}

/** Provenance fields every keyed source carries, all from the echo (except the requested fps). */
function keyedProvenance(
  capture: KeyedCapture,
  measuredAt: string,
): Partial<FeelMeasurementSource> & Record<string, unknown> {
  const effective = effectiveCaptureFps(capture.sampleCount, capture.durationMs);
  return {
    source: "runtime.capture_input_motion",
    producedBy: FEEL_PRODUCER,
    sampleCount: capture.sampleCount,
    durationMs: capture.durationMs,
    // `captureFps` stays the REQUESTED pin (the field the existing gates read);
    // the two fields below make the request/reality pair explicit (H8).
    captureFps: capture.requestedCaptureFps,
    requestedCaptureFps: capture.requestedCaptureFps,
    ...(effective === undefined ? {} : { effectiveCaptureFps: round4(effective) }),
    measuredAt,
    projectFixedTimestepBeforeMeasurement: capture.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: capture.measurementFixedTimestep,
  };
}

// ── sweep planning ──────────────────────────────────────────────────────────

/**
 * How far to sweep, in ticks. Bound to the contract's TARGET (where to look), never
 * to a measured value: the trials still have to bracket a threshold on their own, so
 * a wrong target produces a refusal ("every trial jumped"), never a wrong number.
 */
export function sweepTicksForTarget(targetSeconds: number | undefined, fixedTimestep: number): number {
  if (targetSeconds === undefined || !Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    return SWEEP_DEFAULT_TICKS;
  }
  const ticks = Math.ceil(targetSeconds / fixedTimestep) + 4;
  return Math.min(SWEEP_MAX_TICKS, Math.max(SWEEP_MIN_TICKS, ticks));
}

function targetSeconds(contract: unknown, metric: string): number | undefined {
  const feel = isRecord(contract) ? contract.feel : undefined;
  const entry = isRecord(feel) ? feel[metric] : undefined;
  return isRecord(entry) ? num(entry.target) : undefined;
}

/**
 * A trial is only comparable in TICKS when the capture sampled ONE SAMPLE PER
 * PHYSICS TICK. `captureFps` 120 against a 60Hz sim yields two samples per tick and
 * every index in the convention would be doubled, so the sweeps pin the sampling
 * cadence to the physics rate ECHOED by the session's first capture, and this check
 * proves the pin landed rather than assuming it.
 */
export function samplesPerTick(samples: TickSample[], fixedTimestep: number): number | null {
  if (samples.length < 3 || !Number.isFinite(fixedTimestep) || fixedTimestep <= 0) return null;
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i += 1) deltas.push(samples[i].tMs - samples[i - 1].tMs);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  if (!(median > 0)) return null;
  return (fixedTimestep * 1000) / median;
}

// ── the session ─────────────────────────────────────────────────────────────

/**
 * Drive the whole feel session over `send` and return the documents to write.
 * Every wire interaction goes through `send`, so the unit suite runs the real
 * recipe against a scripted bridge with no editor in the room.
 */
export async function runFeelSession(options: FeelSessionOptions): Promise<FeelSessionOutput> {
  const { send } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const consoleCount = options.consoleCount ?? 200;

  const resolution = resolveFeelSeam(options.contract);
  if (!resolution.ok) throw new Error(resolution.refusal);
  const seam = resolution.seam;

  if (!options.editorSessionId) {
    // The session id is the only thing binding this evidence to the editor session
    // that produced it (the co-temporality hole, ledger L106). Absent binding is a
    // refusal, not a blank field.
    throw new Error(
      "REFUSED: the bridge handshake supplied no editorSessionId, so the produced feel.json could not be bound to the editor session that measured it.",
    );
  }

  const sources: Record<string, unknown>[] = [];
  const metrics: Record<string, number> = {};
  const omitted: { metric: string; reason: string }[] = [];
  const gaps: string[] = [];
  const measuredAt = now();
  const opLog: Record<string, unknown>[] = [];
  const record = (op: string, detail: Record<string, unknown>): void => {
    opLog.push({ op, ...detail });
  };

  let readerDisabled = false;
  let readerDisableEvidence: Record<string, unknown> = { attempted: false };
  let logs: unknown[] = [];

  const setReaderEnabled = async (enabled: boolean): Promise<void> => {
    await send(
      "component.set_property",
      {
        locator: { path: seam.playerLocator },
        type_name: seam.inputReaderComponent,
        property_path: "m_Enabled",
        value: enabled,
      },
      15000,
    );
    record("component.set_property", { type_name: seam.inputReaderComponent, property_path: "m_Enabled", value: enabled });
  };

  /**
   * EVERY LEG STARTS FROM THE SAME PLACE. Legs run back to back in one play session
   * and each one MOVES the player: a 60-tick run leg leaves it seven units to the
   * right, which for the next leg can mean measuring a jump that starts in mid-air
   * off the end of the platform. Restoring the spawn between legs is what makes the
   * legs independent. The spawn is READ from the live scene, never assumed, and an
   * unreadable spawn is recorded as a gap rather than replaced with a guess.
   */
  let spawn: { x: number; y: number; z: number } | null = null;
  const restoreSpawn = async (): Promise<void> => {
    if (spawn === null) return;
    await send("scene.set_transform", { locator: { path: seam.playerLocator }, position: spawn }, 15000);
  };

  try {
    await send("editor.play", {}, 30000);
    await send("editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    await send("input.begin_session", { backend: "InputSystem" }, 15000);

    try {
      spawn = positionFromSnapshot(await send("runtime.get_snapshot", { locator: { path: seam.playerLocator } }, 15000));
      record("runtime.get_snapshot", { purpose: "player spawn (restored between legs)" });
    } catch {
      spawn = null;
    }
    if (spawn === null) {
      gaps.push(
        "the player's spawn position could not be read, so legs were NOT reset between captures: a leg that moves the player can displace the next one.",
      );
    }

    // ── 1. warm-up (COLD START, feel-primitives.ts): a session's first injected tap
    // realizes ~1 tick cold, so it is thrown away rather than graded.
    await restoreSpawn();
    const warmup = await keyedCapture(
      send,
      seam.playerLocator,
      [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [seam.keys.jump], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
        { keys: [], fixedTicks: 30 },
      ],
      TRAJECTORY_CAPTURE_FPS,
    );
    record("runtime.capture_input_motion", { leg: "warm-up (discarded)", sampleCount: warmup.sampleCount });

    // The physics rate comes from the bridge, not the contract: the sweeps pin
    // their sampling to THIS number so one sample means one tick.
    const fixedTimestep = warmup.measurementFixedTimestep;
    if (fixedTimestep === undefined || fixedTimestep <= 0) {
      throw new Error(
        "REFUSED: the capture op echoed no usable measurementFixedTimestep, so tick-indexed sweeps cannot be planned or derived.",
      );
    }
    const sweepFps = Math.round(1 / fixedTimestep);

    // ── 2. run leg ────────────────────────────────────────────────────────────
    await restoreSpawn();
    // ONE PHASE, all hold. `runSpeed` is the whole-window average displacement rate
    // (`deriveRunSpeed`), so a settle or release phase inside the same capture would
    // dilute it toward zero: a 60-tick hold inside a 96-tick window reads 4.4 u/s for
    // a 7 u/s controller. The spawn restore above is what makes the settle
    // unnecessary: the player is already at rest at a known place. The hold is long
    // so an acceleration ramp is a small fraction of the window.
    const run = await keyedCapture(
      send,
      seam.playerLocator,
      [{ keys: [seam.keys.moveRight], fixedTicks: RUN_HOLD_TICKS }],
      TRAJECTORY_CAPTURE_FPS,
    );
    record("runtime.capture_input_motion", { leg: "run", sampleCount: run.sampleCount });
    emitTrajectorySource(run, ["runSpeed"], measuredAt, metrics, sources, omitted);

    // ── 3. jump leg ───────────────────────────────────────────────────────────
    await restoreSpawn();
    const jump = await keyedCapture(
      send,
      seam.playerLocator,
      [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [seam.keys.jump], fixedTicks: 24 },
        { keys: [], fixedTicks: 72 },
      ],
      TRAJECTORY_CAPTURE_FPS,
    );
    record("runtime.capture_input_motion", { leg: "jump", sampleCount: jump.sampleCount });
    emitTrajectorySource(jump, ["jumpApex", "timeToApex"], measuredAt, metrics, sources, omitted);

    // ── 4. short hop: the canonical tap, N attempts, stimulus bound to the ECHO ──
    const attempts: { capture: KeyedCapture; apex: number | null; tapTicks: number | undefined }[] = [];
    for (let i = 0; i < SHORT_HOP_ATTEMPTS; i += 1) {
      await restoreSpawn();
      const capture = await keyedCapture(
        send,
        seam.playerLocator,
        [
          { keys: [], fixedTicks: SETTLE_TICKS },
          { keys: [seam.keys.jump], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: [], fixedTicks: 72 },
        ],
        TRAJECTORY_CAPTURE_FPS,
      );
      record("runtime.capture_input_motion", { leg: `shortHop[${i}]`, sampleCount: capture.sampleCount });
      const apex = isValidTrajectory(capture.samples as FeelTrajectorySample[])
        ? deriveMetric("shortHopApex", capture.samples as FeelTrajectorySample[])
        : null;
      attempts.push({ capture, apex, tapTicks: actualFixedTicksOfPhase(capture.phases, 1) });
    }
    emitShortHop(attempts, measuredAt, metrics, sources, omitted);

    // ── 5. coyote sweep ───────────────────────────────────────────────────────
    await runSweep({
      metric: "coyoteTime",
      send,
      seam,
      contract: options.contract,
      fixedTimestep,
      sweepFps,
      measuredAt,
      metrics,
      sources,
      omitted,
      record,
      log,
      beforeLeg: restoreSpawn,
    });

    // ── 6. jump-buffer sweep ──────────────────────────────────────────────────
    await runSweep({
      metric: "jumpBuffer",
      send,
      seam,
      contract: options.contract,
      fixedTimestep,
      sweepFps,
      measuredAt,
      metrics,
      sources,
      omitted,
      record,
      log,
      beforeLeg: restoreSpawn,
    });

    // ── 7. SEAM leg: reader disabled, proven, then the dash ───────────────────
    if (!seam.fields.dashHeld) {
      omitted.push({
        metric: "dashDistance",
        reason: "harness.feelSeam.fields.dashHeld is not declared, so the dash cannot be driven through the seam.",
      });
    } else {
      await restoreSpawn();
      await setReaderEnabled(false);
      readerDisabled = true;
      readerDisableEvidence = await proveReaderDisabled(send, seam, sweepFps, record);
      if (readerDisableEvidence.ok !== true) {
        omitted.push({
          metric: "dashDistance",
          reason: `the input-reader disable could not be proven, so no seam-driven measurement was taken: ${String(readerDisableEvidence.reason ?? "unknown")}`,
        });
      } else {
        await restoreSpawn();
        const dash = await captureDash(send, seam, sweepFps, record);
        emitDash(dash, measuredAt, metrics, sources, omitted, gaps);
      }
    }
    log(`[loombridge capture] feel: measured ${Object.keys(metrics).join(", ") || "(nothing)"}`);
  } finally {
    // Restore in reverse order, best-effort: an interrupted session must not leave
    // the game with its input reader switched off.
    if (readerDisabled) {
      try {
        await setReaderEnabled(true);
      } catch {
        gaps.push(
          `the input reader "${seam.inputReaderComponent}" could not be re-enabled at the end of the session; re-enter play mode before playing the game by hand.`,
        );
      }
    }
    try {
      await send("input.end_session", {}, 10000);
    } catch {
      // best-effort
    }
    try {
      const consoleData = await send("editor.console_logs", { count: consoleCount }, 15000);
      const raw = isRecord(consoleData) ? consoleData.logs : undefined;
      logs = Array.isArray(raw) ? raw : [];
    } catch {
      logs = [];
    }
    try {
      await send("editor.stop", {}, 30000);
      await send("editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
    } catch {
      // best-effort
    }
  }

  const provenance = {
    writer: FEEL_PRODUCER,
    recipe: "feel",
    capturedAt: measuredAt,
    capturedInPlayMode: true,
    runId: options.runId,
    editorSessionId: options.editorSessionId,
    ...(options.unityRouting ? { unityRouting: options.unityRouting } : {}),
    seam,
    readerDisable: readerDisableEvidence,
    omitted,
    gaps,
    ops: opLog,
  };

  const feel: Record<string, unknown> = {
    ...metrics,
    provenance: { sources },
    _provenance: provenance,
  };

  return {
    feel,
    console: { logs, _provenance: provenance },
    measured: Object.keys(metrics),
    omitted,
    gaps,
    logCount: logs.length,
  };
}

// ── source emitters ─────────────────────────────────────────────────────────

function emitTrajectorySource(
  capture: KeyedCapture,
  wanted: string[],
  measuredAt: string,
  metrics: Record<string, number>,
  sources: Record<string, unknown>[],
  omitted: { metric: string; reason: string }[],
): void {
  if (!isValidTrajectory(capture.samples as FeelTrajectorySample[])) {
    for (const metric of wanted) {
      omitted.push({ metric, reason: "the capture returned no usable trajectory (need ≥2 finite, strictly time-ordered samples)." });
    }
    return;
  }
  const measuredMetrics: string[] = [];
  for (const metric of wanted) {
    const value = deriveMetric(metric, capture.samples as FeelTrajectorySample[]);
    if (value === null) {
      omitted.push({ metric, reason: `the capture's own samples do not derive ${metric} (the stimulus did not produce the signal).` });
      continue;
    }
    metrics[metric] = round4(value);
    measuredMetrics.push(metric);
  }
  if (measuredMetrics.length === 0) return;
  sources.push({
    ...keyedProvenance(capture, measuredAt),
    derivation: "trajectory",
    measuredMetrics,
    samples: capture.samples,
    phases: capture.phases,
  });
}

/**
 * The canonical short hop. Keeps the MEDIAN REGISTERING attempt and discards misses
 * (the tap occasionally fails to register at all: a miss is never blended in), and
 * binds `stimulus.tapTicks` to the ECHOED `actualFixedTicks` of the tap phase (L46):
 * a request for 6 ticks that really ran 7 now fails the canonical-tap check instead
 * of passing as a typed 6.
 */
function emitShortHop(
  attempts: { capture: KeyedCapture; apex: number | null; tapTicks: number | undefined }[],
  measuredAt: string,
  metrics: Record<string, number>,
  sources: Record<string, unknown>[],
  omitted: { metric: string; reason: string }[],
): void {
  const registering = attempts.filter((a): a is { capture: KeyedCapture; apex: number; tapTicks: number | undefined } => a.apex !== null);
  if (registering.length === 0) {
    omitted.push({
      metric: "shortHopApex",
      reason: `all ${attempts.length} canonical ${SHORT_HOP_CANONICAL_TAP_TICKS}-tick taps failed to register a hop, so no short-hop height was measured.`,
    });
    return;
  }
  registering.sort((a, b) => a.apex - b.apex);
  const chosen = registering[Math.floor((registering.length - 1) / 2)];
  metrics.shortHopApex = round4(chosen.apex);
  sources.push({
    ...keyedProvenance(chosen.capture, measuredAt),
    derivation: "trajectory",
    measuredMetrics: ["shortHopApex"],
    samples: chosen.capture.samples,
    phases: chosen.capture.phases,
    stimulus: {
      metric: "shortHopApex",
      // NEVER a literal: the tap the bridge says it ran (L40/L46).
      ...(chosen.tapTicks === undefined ? {} : { tapTicks: chosen.tapTicks }),
      phases: `[${"jump"} ${chosen.tapTicks ?? "?"}t (echoed actualFixedTicks)][release]`,
    },
    attempts: attempts.map((a, index) => ({
      index,
      registered: a.apex !== null,
      apex: a.apex,
      actualFixedTicks: a.tapTicks,
    })),
  });
}

interface SweepRunArgs {
  metric: SweepMetric;
  send: FeelSend;
  seam: FeelSeam;
  contract: unknown;
  fixedTimestep: number;
  sweepFps: number;
  measuredAt: string;
  metrics: Record<string, number>;
  sources: Record<string, unknown>[];
  omitted: { metric: string; reason: string }[];
  record: (op: string, detail: Record<string, unknown>) => void;
  log: (message: string) => void;
  /** Restore the player spawn before each capture in the sweep. */
  beforeLeg: () => Promise<void>;
}

/**
 * A threshold sweep: one calibration capture to locate the reference event, then a
 * trial per tick offset. EVERY trial's raw echo is retained; the reported window is
 * `deriveSweepMetric` over those echoes, the same function the gate re-runs (L76/L77).
 */
async function runSweep(args: SweepRunArgs): Promise<void> {
  const { metric, send, seam, fixedTimestep, sweepFps, metrics, sources, omitted, record } = args;
  const maxTicks = sweepTicksForTarget(targetSeconds(args.contract, metric), fixedTimestep);

  await args.beforeLeg();
  const calibration = await keyedCapture(send, seam.playerLocator, calibrationPhases(metric, seam), sweepFps);
  record("runtime.capture_input_motion", { leg: `${metric} calibration`, sampleCount: calibration.sampleCount });

  const perTick = samplesPerTick(calibration.samples, fixedTimestep);
  if (perTick === null || Math.abs(perTick - 1) > 0.25) {
    omitted.push({
      metric,
      reason:
        `the sweep needs ONE sample per physics tick to index ticks, and the calibration capture sampled ${perTick === null ? "an unreadable cadence" : `${perTick.toFixed(2)} samples/tick`} ` +
        `(captureFps ${sweepFps} against a ${(1 / fixedTimestep).toFixed(2)}Hz sim).`,
    });
    return;
  }

  const descent = firstDescentSampleIndex(calibration.samples);
  if (descent === null) {
    omitted.push({
      metric,
      reason:
        metric === "coyoteTime"
          ? "the calibration walk never left the ground: there is no ledge within the walk window, so no coyote sweep is possible from this spawn."
          : "the calibration jump never fell: no landing to sweep against.",
    });
    return;
  }
  const referenceIndex = metric === "coyoteTime" ? descent : landingSampleIndexAfter(calibration.samples, descent);
  if (referenceIndex === null) {
    omitted.push({ metric, reason: "the calibration capture never landed inside its window, so the sweep could not be centred." });
    return;
  }

  const trials: SweepTrialEcho[] = [];
  // Offsets start at ONE tick, not zero: at offset 0 the press is consumed on the
  // very step the reference event happens, which for coyote is an ordinary grounded
  // jump (the derivation refuses that trial by design) and for the buffer is a press
  // on the landing tick itself. Neither is a threshold measurement.
  for (let offset = 1; offset <= maxTicks; offset += 1) {
    const plan = trialPhases(metric, seam, referenceIndex, offset);
    if (plan === null) {
      omitted.push({
        metric,
        reason: `the reference event lands at sample ${referenceIndex}, too early to place a press ${offset} tick(s) from it (the settle phase would have to be negative).`,
      });
      return;
    }
    await args.beforeLeg();
    const capture = await keyedCapture(send, seam.playerLocator, plan.phases, sweepFps);
    record("runtime.capture_input_motion", { leg: `${metric} trial[${offset}]`, sampleCount: capture.sampleCount });
    trials.push({
      index: offset,
      pressPhaseIndex: plan.pressPhaseIndex,
      phases: capture.phases as SweepTrialEcho["phases"],
      samples: capture.samples,
    });
  }

  const derivation = deriveSweepMetric(metric, trials, fixedTimestep);
  if (derivation.windowSeconds === null) {
    omitted.push({ metric, reason: derivation.reason ?? "the sweep did not resolve a threshold." });
    // The trials are still recorded so the refusal is auditable rather than a
    // sentence: a re-run can see exactly which offsets were tried.
    sources.push(sweepSource(metric, trials, calibration, args, [], derivation));
    return;
  }
  metrics[metric] = round4(derivation.windowSeconds);
  sources.push(sweepSource(metric, trials, calibration, args, [metric], derivation));
}

function sweepSource(
  metric: SweepMetric,
  trials: SweepTrialEcho[],
  calibration: KeyedCapture,
  args: SweepRunArgs,
  measuredMetrics: string[],
  derivation: ReturnType<typeof deriveSweepMetric>,
): Record<string, unknown> {
  // The sweep is N captures, so the cadence fields are the sweep's TOTALS: every
  // trial is one capture at the same pin, and the effective cadence re-derives from
  // the same pair the gate uses.
  const sampleCount = trials.reduce((sum, t) => sum + t.samples.length, 0);
  const durationMs = trials.reduce((sum, t) => sum + (t.samples.length > 1 ? t.samples[t.samples.length - 1].tMs - t.samples[0].tMs : 0), 0);
  const effective = effectiveCaptureFps(sampleCount, durationMs);
  return {
    source: "runtime.capture_input_motion",
    producedBy: FEEL_PRODUCER,
    derivation: "input-bisection",
    measuredMetrics,
    sampleCount,
    durationMs: round4(durationMs),
    captureFps: args.sweepFps,
    requestedCaptureFps: args.sweepFps,
    ...(effective === undefined ? {} : { effectiveCaptureFps: round4(effective) }),
    measuredAt: args.measuredAt,
    projectFixedTimestepBeforeMeasurement: calibration.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: calibration.measurementFixedTimestep,
    /** The convention, named in the file so a reader knows what the ticks mean. */
    tickOffset: BRIDGE_SAMPLE_TICK_OFFSET,
    /** Raw echo per trial: the gate re-derives the headline from THESE (L77). */
    trials,
    /** What the derivation read out of them (never the input to it). */
    observations: derivation.observations,
    boundaryTicks: derivation.boundaryTicks,
    firstFailedTicks: derivation.firstFailedTicks,
    ...(derivation.reason ? { derivationRefusal: derivation.reason } : {}),
  };
}

/** The calibration capture: walk off the ledge (coyote) or jump and land (buffer). */
function calibrationPhases(metric: SweepMetric, seam: FeelSeam): KeyedPhase[] {
  return metric === "coyoteTime"
    ? [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [seam.keys.moveRight], fixedTicks: 90 },
      ]
    : [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [seam.keys.jump], fixedTicks: 8 },
        { keys: [], fixedTicks: 100 },
      ];
}

/**
 * The trial phases for one tick offset.
 *
 * The press phase is placed so the DERIVED offset comes out at `offset`: for coyote
 * `elapsed = press − unground + 2`, for the buffer `lead = landing − press − 2`. The
 * placement is a plan, not an assumption: the real offset is whatever the trial's
 * own echo says, which is why a drifting reference event weakens the sweep's
 * resolution but can never corrupt its arithmetic.
 */
export function trialPhases(
  metric: SweepMetric,
  seam: FeelSeam,
  referenceIndex: number,
  offset: number,
): { phases: KeyedPhase[]; pressPhaseIndex: number } | null {
  if (metric === "coyoteTime") {
    const pressIndex = referenceIndex + offset - BRIDGE_SAMPLE_TICK_OFFSET;
    const walkTicks = pressIndex - SETTLE_TICKS;
    if (walkTicks < 1) return null;
    return {
      phases: [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [seam.keys.moveRight], fixedTicks: walkTicks },
        { keys: [seam.keys.moveRight, seam.keys.jump], fixedTicks: 2 },
        { keys: [seam.keys.moveRight], fixedTicks: 36 },
      ],
      pressPhaseIndex: 2,
    };
  }
  const pressIndex = referenceIndex - offset - BRIDGE_SAMPLE_TICK_OFFSET;
  const fallTicks = pressIndex - SETTLE_TICKS - 8;
  if (fallTicks < 1) return null;
  return {
    phases: [
      { keys: [], fixedTicks: SETTLE_TICKS },
      { keys: [seam.keys.jump], fixedTicks: 8 },
      { keys: [], fixedTicks: fallTicks },
      { keys: [seam.keys.jump], fixedTicks: 2 },
      { keys: [], fixedTicks: 40 },
    ],
    pressPhaseIndex: 3,
  };
}

// ── the seam leg ────────────────────────────────────────────────────────────

async function probe(
  send: FeelSend,
  seam: FeelSeam,
  phases: Record<string, unknown>[],
  captureFps: number,
): Promise<Record<string, unknown>> {
  const data = await send(
    "runtime.probe",
    {
      measure: { path: seam.playerLocator },
      phases,
      captureFps,
      includeSamples: true,
      // L120: drivers persist across phases AND across calls. Every probe this
      // recipe issues ends with an explicit zeroing STOP phase (below) AND leaves
      // the reset on, so a left-set moveX cannot keep running the player through
      // the inter-call gap and off a ledge into a hazard.
      resetDriversOnEnd: true,
    },
    120000,
  );
  return isRecord(data) ? data : {};
}

function driver(seam: FeelSeam, field: string, value: unknown): Record<string, unknown> {
  return {
    locator: { path: seam.playerLocator },
    type_name: seam.controllerComponent,
    property_path: field,
    value,
  };
}

/**
 * M15: prove the reader disable BEFORE measuring through the seam, two ways, and
 * record which one answered.
 */
async function proveReaderDisabled(
  send: FeelSend,
  seam: FeelSeam,
  captureFps: number,
  record: (op: string, detail: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  // (a) The READ-BACK attempt. Expected to come back unreadable today (L117:
  // component enabled state is write-only over the bridge): recorded either way so
  // the day the bridge starts answering, the evidence says so.
  let snapshotReadBack: unknown = { available: false, reason: "not attempted" };
  try {
    const snapshot = await send(
      "runtime.get_snapshot",
      {
        locator: { path: seam.playerLocator },
        components: [seam.inputReaderComponent],
        include_paths: ["enabled", "m_Enabled"],
      },
      15000,
    );
    snapshotReadBack = { available: true, response: snapshot };
    record("runtime.get_snapshot", { purpose: "input-reader enabled read-back (L117)" });
  } catch (error) {
    snapshotReadBack = { available: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // (b) The BEHAVIORAL proof, which is the one that decides.
  // A SETTLE PHASE FIRST, so the drive window has a BASELINE. `runtime.probe` echoes
  // no pre-step sample: its first sample is already the state after the first driven
  // tick, so a drive-only window cannot see the very motion the C1 contention
  // produces (one tick, then flat) and would read a flat zero. The last settle sample
  // is the baseline the drive is measured from.
  const settleTicks = 6;
  const data = await probe(
    send,
    seam,
    [
      { durationMs: (settleTicks * 1000) / captureFps, drivers: [driver(seam, seam.fields.moveX, 0)] },
      { durationMs: (SEAM_PROOF_TICKS * 1000) / captureFps, drivers: [driver(seam, seam.fields.moveX, 1)] },
      { durationMs: 100, drivers: [driver(seam, seam.fields.moveX, 0)] },
    ],
    captureFps,
  );
  record("runtime.probe", { leg: "reader-disable proof (M15)", sampleCount: num(data.sampleCount) });
  const echoedPhases = phasesOf(data);
  const settleCount = num(echoedPhases[0]?.sampleCount) ?? 0;
  const driveCount = num(echoedPhases[1]?.sampleCount) ?? 0;
  const driveSamples = samplesOf(data).slice(Math.max(settleCount - 1, 0), settleCount + driveCount);
  const verdict = evaluateSeamPersistence(driveSamples);
  return {
    attempted: true,
    ok: verdict.ok,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    decidedBy: "behavioral (driven-value persistence)",
    behavioral: {
      driveTicks: SEAM_PROOF_TICKS,
      totalDx: round4(verdict.totalDx),
      tailDx: round4(verdict.tailDx),
      expectedTailDx: round4(verdict.expectedTailDx),
      samples: driveSamples,
    },
    snapshotReadBack,
  };
}

interface DashCapture {
  raw: Record<string, unknown>;
  samples: TickSample[];
  sampleCount: number | undefined;
  durationMs: number | undefined;
  requestedCaptureFps: number;
  /**
   * The three fields `runtime.probe` did NOT echo before stage 3 (ledger L75).
   * Read from the response when present and left ABSENT when not: an older bridge
   * still produces the honest gap below rather than a typed constant.
   */
  echoedCaptureFps: number | undefined;
  projectFixedTimestepBeforeMeasurement: number | undefined;
  measurementFixedTimestep: number | undefined;
}

/**
 * The dash, whole-window (ledger L42/L91). The phase-delta recipe is off by one tick
 * BY CONSTRUCTION: one of the dash's ticks always lands in the following phase: and
 * the ledger records the pressure that creates: the obvious way to make the number
 * pass is to lengthen the dash. With `moveX` pinned to 0 for the whole window the
 * only displacement in the capture IS the dash, so the whole-window delta is the
 * exact value and no phase boundary is involved.
 */
async function captureDash(
  send: FeelSend,
  seam: FeelSeam,
  captureFps: number,
  record: (op: string, detail: Record<string, unknown>) => void,
): Promise<DashCapture> {
  const dashHeld = seam.fields.dashHeld!;
  const data = await probe(
    send,
    seam,
    [
      { durationMs: 200, drivers: [driver(seam, seam.fields.moveX, 0), driver(seam, dashHeld, false)] },
      { durationMs: 150, drivers: [driver(seam, dashHeld, true)] },
      { durationMs: 500, drivers: [driver(seam, dashHeld, false)] },
      // L120: the terminal zeroing STOP phase, always.
      { durationMs: 100, drivers: [driver(seam, seam.fields.moveX, 0), driver(seam, dashHeld, false)] },
    ],
    captureFps,
  );
  record("runtime.probe", { leg: "dash (whole-window, moveX pinned 0)", sampleCount: num(data.sampleCount) });
  return {
    raw: data,
    samples: samplesOf(data),
    sampleCount: num(data.sampleCount),
    durationMs: windowMsOf(data),
    requestedCaptureFps: captureFps,
    echoedCaptureFps: num(data.captureFps),
    projectFixedTimestepBeforeMeasurement: num(data.projectFixedTimestepBeforeMeasurement),
    measurementFixedTimestep: num(data.measurementFixedTimestep),
  };
}

/**
 * THE PROVENANCE WALL, now with a door in it (stage 3).
 *
 * Stage 2 shipped this leg with a wall: `runtime.probe` echoed `phases`,
 * `sampleCount`, `totalDurationMs` and `samples`, and NOT `captureFps`,
 * `projectFixedTimestepBeforeMeasurement` or `measurementFixedTimestep`.
 * `validMeasurementSource` requires the last two, so the only route to a green dash
 * was for the writer to TYPE them, which is exactly ledger L75 (the door-one run
 * typed `captureFps: 60` and both timestep numbers as module constants into three
 * probe sources and disclosed it honestly). A producer doing the same would be
 * laundering with a nicer label, so this recipe refused to.
 *
 * Stage 3 closed it at the source: `ComputeProbeResult` now echoes all three, the
 * same values `capture_input_motion` reports through `MotionMetrics.AttachProvenance`.
 * They are copied here from the RESPONSE, never from a constant.
 *
 * The absent path is kept, unchanged, for a project on an older bridge: the value is
 * still written (it is real and re-derivable from the retained samples), the missing
 * echoes are still NOT invented, feel-provenance still refuses to certify the source,
 * and the gap is still named in `_provenance.gaps`.
 */
function emitDash(
  dash: DashCapture,
  measuredAt: string,
  metrics: Record<string, number>,
  sources: Record<string, unknown>[],
  omitted: { metric: string; reason: string }[],
  gaps: string[],
): void {
  if (dash.samples.length < 2) {
    omitted.push({ metric: "dashDistance", reason: "the dash probe returned no usable trajectory." });
    return;
  }
  const distance = Math.abs(dash.samples[dash.samples.length - 1].x - dash.samples[0].x);
  metrics.dashDistance = round4(distance);
  const effective = effectiveCaptureFps(dash.sampleCount, dash.durationMs);
  // Which of the three the OP actually echoed. Absent stays absent.
  const missing = (
    [
      ["captureFps", dash.echoedCaptureFps],
      ["projectFixedTimestepBeforeMeasurement", dash.projectFixedTimestepBeforeMeasurement],
      ["measurementFixedTimestep", dash.measurementFixedTimestep],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  sources.push({
    source: "runtime.probe",
    producedBy: FEEL_PRODUCER,
    derivation: "window-delta",
    measuredMetrics: ["dashDistance"],
    sampleCount: dash.sampleCount,
    durationMs: dash.durationMs,
    requestedCaptureFps: dash.requestedCaptureFps,
    // The ECHOED pin, when the bridge reports one. `captureFps` is the field the
    // existing gates read, so it is only written when the op said it.
    ...(dash.echoedCaptureFps === undefined ? {} : { captureFps: dash.echoedCaptureFps }),
    ...(effective === undefined ? {} : { effectiveCaptureFps: round4(effective) }),
    measuredAt,
    samples: dash.samples,
    phases: phasesOf(dash.raw),
    ...(dash.projectFixedTimestepBeforeMeasurement === undefined
      ? {}
      : { projectFixedTimestepBeforeMeasurement: dash.projectFixedTimestepBeforeMeasurement }),
    ...(dash.measurementFixedTimestep === undefined
      ? {}
      : { measurementFixedTimestep: dash.measurementFixedTimestep }),
    ...(missing.length === 0 ? {} : { notEchoedByOp: missing }),
  });
  if (missing.length > 0) {
    gaps.push(
      `runtime.probe echoed no ${missing.join(", ")}, so the dash source cannot satisfy validMeasurementSource without the writer TYPING them (ledger L75). ` +
        "They are left absent and feel-provenance will refuse to certify dashDistance. This bridge predates the stage-3 ComputeProbeResult echo: update the " +
        "Loombridge package in this project. The measured value itself is real and re-derives from the retained whole-window samples.",
    );
  }
}

// ── the live wrapper ────────────────────────────────────────────────────────

function responseData(response: BridgeResponse, command: string): unknown {
  if (response.status === "error") {
    throw new Error(`${command} failed: ${response.error?.message ?? "unknown bridge error"}`);
  }
  return response.data;
}

function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost|code=1006/i.test(message);
}

async function ensureConnected(client: UnityClient): Promise<void> {
  if (client.isConnected) return;
  if (await client.waitForReconnect(15000)) return;
  await client.connect();
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Capture feel evidence into `outDir` against the live editor. */
export async function captureFeelEvidence(args: CaptureFeelArgs): Promise<CaptureFeelResult> {
  const feelPath = path.join(args.outDir, "feel.json");
  const consolePath = path.join(args.outDir, "console.json");

  // The seam refusal must land BEFORE a play-mode session is opened: nothing about
  // the editor changes the answer, and the operator gets the JSON to add instead of
  // a game that entered and left play for nothing.
  const resolution = resolveFeelSeam(args.contract);
  if (!resolution.ok) throw new Error(resolution.refusal);

  const resolved = createUnityClientForCli({ ...(args.project ? { project: args.project } : {}) });
  const client = resolved.client;
  const send: FeelSend = async (command, params = {}, timeoutMs) => {
    await ensureConnected(client);
    try {
      return responseData(await client.send(command, params, timeoutMs), command);
    } catch (error) {
      if (!isConnectionLoss(error)) throw error;
      await ensureConnected(client);
      return responseData(await client.send(command, params, timeoutMs), command);
    }
  };

  try {
    await client.connect();
    const routing = buildUnityRoutingMetadata(resolved);
    const output = await runFeelSession({
      send,
      contract: args.contract,
      runId: args.runId,
      ...(routing.editorSessionId ? { editorSessionId: routing.editorSessionId } : {}),
      unityRouting: routing,
      ...(args.consoleCount === undefined ? {} : { consoleCount: args.consoleCount }),
      log: (message) => console.error(message),
    });
    await writeJson(feelPath, output.feel);
    await writeJson(consolePath, output.console);
    return {
      feelPath,
      consolePath,
      measured: output.measured,
      omitted: output.omitted,
      gaps: output.gaps,
      logCount: output.logCount,
    };
  } finally {
    await resolved.disconnect();
  }
}
