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
  ANCHOR_SOURCE_GROUNDED,
  ANCHOR_SOURCE_Y_DESCENT_NOTE,
  BRIDGE_INJECTION_LATENCY_TICKS,
  BRIDGE_SAMPLE_TICK_OFFSET,
  GROUNDED_FIELD_ID,
  SHORT_HOP_CANONICAL_TAP_TICKS,
  deriveSweepMetric,
  firstDescentSampleIndex,
  groundedAnchorSampleIndex,
  landingSampleIndexAfter,
  type FieldTimelineEcho,
  type SweepMetric,
  type SweepTrialEcho,
  type TickSample,
} from "../../domain/feel-primitives.js";
import { resolveFeelSeam, type FeelSeam, locatorParam } from "../../domain/harness-seam.js";
import { deriveMetric, isStaticTrajectory, isValidTrajectory } from "./feel-derive.js";
import { GRADED_FEEL_METRICS, type FeelMeasurementSource, type FeelTrajectorySample } from "./gates/feel.js";

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
 * DEFAULT ticks of the run hold. Long, deliberately: `runSpeed` is the whole-window
 * average, so a controller with an acceleration ramp under-reads on a short window.
 *
 * It is a DEFAULT rather than a constant because 90 ticks is 10.5 units at 7 u/s and
 * the harness has no idea what is 10.5 units away. On the first level with hazards it
 * drove the player into spikes three times and the game's own end state froze the
 * rest of the session. `harness.feelSeam.runLeg.ticks` overrides it.
 */
const RUN_HOLD_TICKS = 90;

/**
 * The RUN LEG's hold, in physics ticks. The coyote calibration walk used to share it
 * and no longer does (E6 session three): the run leg must stay ON the ground for its
 * whole hold and the coyote walk must LEAVE it, so one number could not bound both.
 */
function runLegTicks(seam: FeelSeam): number {
  return seam.runLeg?.ticks ?? RUN_HOLD_TICKS;
}

/**
 * THE LEDGE HUNT (E6 session three). The coyote calibration walks until the player
 * actually ungrounds, in steps, from a fresh spawn each time: the ledge's distance is
 * a fact about the level that the harness has to OBSERVE, not one the contract can
 * state. Stepping (rather than one long walk) keeps the drive as short as the level
 * allows, which is the same safety concern the runway bound was introduced for.
 */
const COYOTE_WALK_STEP_TICKS = 60;

/**
 * The hard cap on that hunt, in physics ticks. 600 ticks is ten seconds of walking
 * (70 units at 7 u/s): past that the harness is not looking for a ledge, it is
 * driving the player across the whole level. Same ceiling as `RUN_LEG_MAX_TICKS`,
 * for the same reason.
 */
const COYOTE_WALK_MAX_TICKS = 600;

/**
 * The named refusal when the hunt reaches the cap. `coyoteTime` is then NOT measured
 * and the reason says what to change, because the harness cannot invent a ledge.
 */
export const NO_REACHABLE_LEDGE_REASON =
  `this level has no reachable ledge in the declared direction: walking up to ${COYOTE_WALK_MAX_TICKS} physics ticks from the spawn ` +
  "never ungrounded the player, so coyoteTime cannot be measured; declare a runway direction with a walkable ledge " +
  "(harness.feelSeam.runLeg.direction), or measure this metric on a level that has one.";

/**
 * Ticks of horizontal hold a coyote trial keeps AFTER the press. The player is already
 * off the ledge and airborne by then, so `runLeg.ticks` (a bound on how far the level's
 * GROUND runway may be driven) no longer describes it.
 */
const COYOTE_TRIAL_TRAILING_TICKS = 36;

/**
 * The horizontal KEY the run leg and the calibration walks inject. `direction: -1`
 * says the safe runway lies left, and `resolveFeelSeam` has already refused a -1 that
 * declares no `keys.moveLeft`, so the non-null assertion below cannot fire.
 */
function runLegKey(seam: FeelSeam): string {
  return seam.runLeg?.direction === -1 ? seam.keys.moveLeft! : seam.keys.moveRight;
}

/** The sign the SEAM-driven legs write into `fields.moveX` for a horizontal drive. */
function runLegSign(seam: FeelSeam): 1 | -1 {
  return seam.runLeg?.direction === -1 ? -1 : 1;
}

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
  /**
   * Metrics the contract BANDS that this capture did not measure. Non-empty means the
   * capture cannot feed its own gate, which the CLI reports as a failed recipe
   * (exit 1): the verdict would fail on "NOT MEASURED" anyway, and a capture that
   * exits 0 having produced an ungradeable file is the shape that lets a run look
   * clean right up to the verdict.
   *
   * INTERSECTED WITH THE GRADED SET (`GRADED_FEEL_METRICS`): a band on a metric no
   * gate reads is inert, and failing a capture over one is a refusal no re-capture
   * can clear. Those land in `outOfScopeAcceptedTargets` instead.
   */
  unmeasuredAcceptedTargets: string[];
  /** Banded metrics the feel gate does not grade: reported, never a failure. */
  outOfScopeAcceptedTargets: string[];
  /** The leg a liveness check ended the session on, when one did. */
  aborted?: { leg: string; reason: string };
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
  /**
   * Metrics the CONTRACT bands (`feel.<metric>.target`) that this session did not
   * measure. A capture that cannot feed its own gate is not a successful capture, so
   * the CLI turns a non-empty list into a failed recipe outcome (exit 1) rather than
   * a green run whose verdict then fails on "NOT MEASURED". Intersected with the
   * metric set the feel gate actually grades (see `CaptureFeelResult`).
   */
  unmeasuredAcceptedTargets: string[];
  /** Banded metrics the feel gate does not grade: reported, never a failure. */
  outOfScopeAcceptedTargets: string[];
  /** The leg the session gave up on, when a liveness check ended it early. */
  aborted?: { leg: string; reason: string };
}

/**
 * The session's own stop signal. Thrown by the liveness guard and caught inside
 * `runFeelSession`, so the `finally` still restores the reader / ends the input
 * session / leaves play mode, and the evidence gathered so far is still WRITTEN
 * (a thrown-through error would lose the file that proves why the run stopped).
 */
class FeelSessionAbort extends Error {
  constructor(readonly leg: string, message: string) {
    super(message);
    this.name = "FeelSessionAbort";
  }
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
 * file claim 120 for a capture that really sampled at 11Hz.
 *
 * N samples span N-1 intervals, PER WINDOW. A source that aggregates `windowCount`
 * independent captures into one pair sampled both endpoints of each of them, so it
 * spans `N - windowCount` intervals. Getting this wrong is not cosmetic: the live
 * ten-trial sweep recorded 60.6708fps for a capture that really ran at exactly 60,
 * and the gate (which re-derives the same way) then had to be told to tolerate the
 * error instead of catching it.
 */
export function effectiveCaptureFps(
  sampleCount: number | undefined,
  windowMs: number | undefined,
  windowCount = 1,
): number | undefined {
  if (sampleCount === undefined || windowMs === undefined) return undefined;
  if (!Number.isInteger(windowCount) || windowCount < 1) return undefined;
  if (sampleCount < windowCount + 1 || windowMs <= 0) return undefined;
  return (sampleCount - windowCount) / (windowMs / 1000);
}

/** Round to 4dp for a readable file; the re-derive tolerance (1e-3) absorbs it. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ── the seam-disable proof (review M15) ─────────────────────────────────────

export interface SeamPersistenceVerdict {
  ok: boolean;
  reason?: string;
  /**
   * WHICH refusal this is, so the caller can go and find out MORE before printing a
   * diagnosis. `"no-motion"` is the ambiguous one: a wrong drive field and a dead
   * game look identical from the trajectory alone, and this pure function cannot tell
   * them apart (see `diagnoseFrozenPlayer`).
   */
  reasonKind?: "too-few-samples" | "no-motion" | "one-tick";
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
      reasonKind: "too-few-samples",
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
      reasonKind: "no-motion",
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
      reasonKind: "one-tick",
      totalDx,
      tailDx,
      expectedTailDx,
    };
  }
  return { ok: true, totalDx, tailDx, expectedTailDx };
}

// ── the frozen-player diagnosis (E6 finding: honest blame) ──────────────────

/**
 * IS THE PLAYER EVEN ALIVE? A pure reader over a `runtime.get_snapshot` response.
 *
 * The no-motion refusal above blames the SEAM ("wrong component/field name"), and on
 * the live run that sentence was simply false: the seam was correct and the game had
 * entered its modal end state, which disabled the controller and froze the player at
 * one point for the rest of the session. An operator who believes the message goes
 * and edits a correct contract.
 *
 * So before blaming the seam, the recipe asks the scene. This function reads the
 * shapes `runtime.get_snapshot` actually returns (verified against the live E6
 * response: `components[].runtimeProperties[] = {name, value}` alongside a
 * `properties[]` list, plus the object's own `activeInHierarchy`) and answers with a
 * NAMED end-state reason, or null when nothing in the snapshot says the player is
 * disabled. Null means "the snapshot does not accuse anything", never "all is well":
 * the caller keeps the seam sentence in that case, which is the honest split.
 */
export function diagnoseFrozenPlayer(snapshot: unknown, seam: FeelSeam): string | null {
  if (!isRecord(snapshot)) return null;

  if (snapshot.activeInHierarchy === false) {
    return (
      `the player object ${JSON.stringify(seam.playerLocator)} is INACTIVE in the hierarchy, so nothing can drive it: ` +
      "the game may have entered an end state (or despawned the player); restart play mode before measuring."
    );
  }

  const components = Array.isArray(snapshot.components) ? snapshot.components.filter(isRecord) : [];
  for (const component of components) {
    const typeName = typeof component.type_name === "string" ? component.type_name : "";
    const values = componentPropertyValues(component);

    if (typeName === seam.controllerComponent && (values.get("enabled") === false || values.get("m_Enabled") === false)) {
      return (
        `the controller component "${seam.controllerComponent}" reports enabled=false, so the driven seam field is never read: ` +
        "the game may be in an end state; restart play mode before measuring."
      );
    }
    if ((typeName === "Rigidbody2D" || typeName === "Rigidbody") && values.get("simulated") === false) {
      return (
        `the player's ${typeName} reports simulated=false, so physics cannot move it: ` +
        "the game may be in an end state; restart play mode before measuring."
      );
    }
  }
  return null;
}

/**
 * Does the snapshot AFFIRMATIVELY report the controller enabled? Absence is not a
 * yes: the liveness guard treats "the bridge could not answer" as no evidence of
 * life, which is the refuse-don't-skip posture the rest of this file takes.
 */
export function controllerReportsEnabled(snapshot: unknown, seam: FeelSeam): boolean {
  if (!isRecord(snapshot)) return false;
  if (snapshot.activeInHierarchy === false) return false;
  const components = Array.isArray(snapshot.components) ? snapshot.components.filter(isRecord) : [];
  for (const component of components) {
    if (component.type_name !== seam.controllerComponent) continue;
    const values = componentPropertyValues(component);
    if (values.get("enabled") === true || values.get("m_Enabled") === true) return true;
  }
  return false;
}

/** `{name: value}` over BOTH property lists a snapshot component may carry. */
function componentPropertyValues(component: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of ["properties", "runtimeProperties"] as const) {
    const list = component[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      out.set(entry.name, entry.value);
    }
  }
  // Some snapshot shapes carry a plain `{enabled: false}` object instead of a list.
  const plain = component.properties;
  if (isRecord(plain)) for (const [name, value] of Object.entries(plain)) out.set(name, value);
  return out;
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
  /** `fieldTimeline[]` as echoed (empty unless the call declared `sampledFields`). */
  fieldTimeline: FieldTimelineEcho[];
}

/** The echoed `fieldTimeline[]`, verbatim. Absent stays absent (no fabricated entry). */
function fieldTimelinesOf(data: unknown): FieldTimelineEcho[] {
  const raw = isRecord(data) ? data.fieldTimeline : undefined;
  return Array.isArray(raw) ? (raw.filter(isRecord) as FieldTimelineEcho[]) : [];
}

/**
 * The ground-flag timeline this capture carries, found by the ID the recipe asked
 * for. Matched by id ONLY: taking "the one entry there is" would bind the anchor to
 * whatever field happened to be sampled.
 */
function groundedTimelineOf(capture: KeyedCapture): FieldTimelineEcho | undefined {
  return capture.fieldTimeline.find((entry) => entry.id === GROUNDED_FIELD_ID);
}

/**
 * The `sampledFields` spec the coyote sweep sends, or undefined when the seam
 * declares no ground flag. `runtime.capture_input_motion` honours `sampledFields` and
 * samples the member on the trajectory's own tick clock; `runtime.probe` has no such
 * parameter (ledger L71), which is why the sweeps run through the keyed capture op.
 */
function groundedSampledFields(seam: FeelSeam): Record<string, unknown>[] | undefined {
  const field = seam.fields.grounded;
  if (field === undefined) return undefined;
  return [
    {
      id: GROUNDED_FIELD_ID,
      locator: locatorParam(seam.playerLocator),
      type_name: seam.controllerComponent,
      property_path: field,
    },
  ];
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
  sampledFields?: Record<string, unknown>[],
): Promise<KeyedCapture> {
  const data = await send(
    "runtime.capture_input_motion",
    {
      measure: locatorParam(playerLocator),
      phases: keyedPhases(phases),
      captureFps,
      includeSamples: true,
      ...(sampledFields === undefined ? {} : { sampledFields }),
    },
    120000,
  );
  const raw = isRecord(data) ? data : {};
  return {
    raw,
    samples: samplesOf(raw),
    phases: phasesOf(raw),
    fieldTimeline: fieldTimelinesOf(raw),
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
        locator: locatorParam(seam.playerLocator),
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
    await send("scene.set_transform", { locator: locatorParam(seam.playerLocator), position: spawn }, 15000);
  };

  /**
   * THE LIVENESS READING, BETWEEN LEGS (E6, TideRunner run 2).
   *
   * Run 2 measured a corpse: the run leg produced no motion, and so did the jump leg,
   * and the short hop, and the coyote walk, and the buffer sweep, and the seam proof.
   * Six captures of a frozen player, five omissions, two zeroes, and eight minutes of
   * play mode to produce a file that could not feed its gate.
   *
   * So a leg that produced NO motion at all is followed by one cheap question. The
   * player is alive if EITHER the leg moved it, OR the controller component answers
   * that it is enabled. Nothing else counts: a snapshot the bridge cannot answer is
   * not evidence of life, and continuing on "we could not tell" is what produced the
   * five corpses. When the answer is death, the session stops HERE, with the reason
   * named, and everything captured so far is still written.
   */
  const assertAlive = async (leg: string, samples: TickSample[]): Promise<void> => {
    if (samples.length > 0 && !isStaticTrajectory(samples as FeelTrajectorySample[])) return;
    let snapshot: unknown;
    try {
      snapshot = await send(
        "runtime.get_snapshot",
        {
          locator: locatorParam(seam.playerLocator),
          components: [seam.controllerComponent],
          include_paths: ["enabled", "m_Enabled"],
        },
        15000,
      );
      record("runtime.get_snapshot", { purpose: `liveness after the ${leg} leg`, leg });
    } catch (error) {
      snapshot = { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (controllerReportsEnabled(snapshot, seam)) return;
    const diagnosis = diagnoseFrozenPlayer(snapshot, seam);
    throw new FeelSessionAbort(
      leg,
      `the ${leg} leg moved the player not at all, and the controller "${seam.controllerComponent}" does not report itself enabled` +
        `${diagnosis === null ? "" : ` (${diagnosis})`}. ` +
        "Measuring the remaining legs would record the same frozen player five more times, so the session stopped here. " +
        "Restart play mode (and check the game is not sitting in a modal end state) before re-capturing.",
    );
  };

  let aborted: { leg: string; reason: string } | undefined;

  try {
    await send("editor.play", {}, 30000);
    await send("editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    await send("input.begin_session", { backend: "InputSystem" }, 15000);

    try {
      spawn = positionFromSnapshot(await send("runtime.get_snapshot", { locator: locatorParam(seam.playerLocator) }, 15000));
      record("runtime.get_snapshot", { purpose: "player spawn (restored between legs)" });
    } catch (error) {
      // E6 F4: an UNRESOLVABLE seam locator is a wiring refusal, not a degraded
      // measurement. Swallowing it here once turned a shipped locator bug into a
      // "legs were not reset" note while every later leg failed anyway.
      const msg = error instanceof Error ? error.message : String(error);
      if (/LOCATOR_UNRESOLVED|Could not resolve locator/i.test(msg)) {
        throw new Error(
          `the feel seam's playerLocator ${JSON.stringify(seam.playerLocator)} does not resolve in the ` +
            `running scene: fix harness.feelSeam before measuring (${msg})`,
        );
      }
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
      [{ keys: [runLegKey(seam)], fixedTicks: runLegTicks(seam) }],
      TRAJECTORY_CAPTURE_FPS,
    );
    record("runtime.capture_input_motion", { leg: "run", sampleCount: run.sampleCount });
    emitTrajectorySource(run, ["runSpeed"], measuredAt, metrics, sources, omitted);
    await assertAlive("run", run.samples);

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
    await assertAlive("jump", jump.samples);

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
    await assertAlive("shortHop", attempts[attempts.length - 1]?.capture.samples ?? []);

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
  } catch (error) {
    if (!(error instanceof FeelSessionAbort)) throw error;
    aborted = { leg: error.leg, reason: error.message };
    log(`[loombridge capture] feel: ABORTED after the ${error.leg} leg: ${error.message}`);
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

  // THE CONTRACT'S OWN LIST, closed out. Every metric the contract bands and this
  // session did not measure gets an omission entry, so `feel.json` never leaves a
  // banded metric silently absent: a metric with neither a value nor a stated
  // reason is the shape a reader mistakes for "not applicable".
  const acceptedTargets = acceptedFeelTargets(options.contract);
  const explained = new Set(omitted.map((entry) => entry.metric));
  for (const metric of acceptedTargets) {
    if (metrics[metric] !== undefined || explained.has(metric)) continue;
    omitted.push({
      metric,
      reason: outOfScopeFeelTargets(options.contract).includes(metric)
        ? OUT_OF_SCOPE_TARGET_REASON
        : aborted
          ? `the session was ABORTED after the ${aborted.leg} leg, so this metric was never attempted: ${aborted.reason}`
          : "the session ended before this metric was measured.",
    });
  }
  // WHAT THE CAPTURE OWES IS WHAT THE GATE GRADES (E6 session three). A contract may
  // band a metric no gate reads: TideRunner bands `dashTime` and `dashCooldown`, which
  // no leg measures and `evaluateFeel` never looks at. Counting those made the recipe
  // exit 1 on a run whose seven graded metrics were all measured, and no re-capture
  // could ever clear it: the only fix was to edit the contract. They are reported as
  // out-of-scope NOTES instead, and the exit-1 set is the intersection with the graded
  // set: still every metric a verdict will demand, and nothing a verdict ignores.
  const unmeasuredAcceptedTargets = acceptedTargets.filter(
    (metric) => metrics[metric] === undefined && GRADED_METRIC_SET.has(metric),
  );
  const outOfScopeAcceptedTargets = outOfScopeFeelTargets(options.contract);

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
    ...(aborted ? { aborted } : {}),
    omitted,
    unmeasuredAcceptedTargets,
    ...(outOfScopeAcceptedTargets.length === 0 ? {} : { outOfScopeAcceptedTargets }),
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
    unmeasuredAcceptedTargets,
    outOfScopeAcceptedTargets,
    ...(aborted ? { aborted } : {}),
  };
}

/** The metric ids `evaluateFeel` grades, as a set. Never a second list (see gates/feel.ts). */
const GRADED_METRIC_SET: ReadonlySet<string> = new Set<string>(GRADED_FEEL_METRICS as string[]);

/** Why an out-of-scope banded metric is not measured. Named once, said everywhere. */
export const OUT_OF_SCOPE_TARGET_REASON =
  "the feel gate does not grade this metric (it is outside evaluateFeel's graded set), so the capture has no leg for it: " +
  "the band is inert. Remove it from the contract, or keep it as documentation, but no capture can satisfy it.";

/**
 * Banded feel targets the feel GATE does not grade. Reported as notes, never as a
 * capture failure: no re-capture can clear them.
 */
export function outOfScopeFeelTargets(contract: unknown): string[] {
  return acceptedFeelTargets(contract).filter((metric) => !GRADED_METRIC_SET.has(metric));
}

/**
 * The feel metrics the CONTRACT bands: every `feel.<metric>` (and `feel.extra.<metric>`)
 * carrying a finite numeric `target`. This is the same predicate the feel-provenance
 * gate uses to decide which metrics it grades, so "what the capture owes" and "what
 * the gate will demand" cannot drift apart.
 */
export function acceptedFeelTargets(contract: unknown): string[] {
  const feel = isRecord(contract) ? contract.feel : undefined;
  if (!isRecord(feel)) return [];
  const names: string[] = [];
  const collect = (entries: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (key === "extra") continue;
      if (isRecord(value) && num(value.target) !== undefined) names.push(key);
    }
  };
  collect(feel);
  if (isRecord(feel.extra)) collect(feel.extra);
  return names;
}

// ── source emitters ─────────────────────────────────────────────────────────

/**
 * THE DEGENERATE-LEG REASON (E6, TideRunner run 2). Named once, here, because both the
 * omission and the session abort say it.
 */
export const DEGENERATE_LEG_REASON =
  "the player never moved during this leg: the game may have entered an end state or the controller is disabled.";

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
  // THE FROZEN CORPSE. Every apex/speed derivation over a trajectory that never left
  // its first position is a well-formed ZERO, and run 2 shipped exactly that:
  // `jumpApex: 0`, `timeToApex: 0`, both certified by a structurally valid source
  // over 218 samples at one point. A zero derived from no motion is not a
  // measurement, so the metric is OMITTED with the reason named.
  if (isStaticTrajectory(capture.samples as FeelTrajectorySample[])) {
    for (const metric of wanted) omitted.push({ metric, reason: DEGENERATE_LEG_REASON });
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

/** What a calibration pass established before any trial is driven. */
interface SweepCalibration {
  capture: KeyedCapture;
  /** The sample index the trials are placed relative to. */
  referenceIndex: number;
  /**
   * Ticks removed when PLANNING a press so the derived offset comes out at `offset`:
   * the same half of the convention the derivation applies to this anchor.
   */
  anchorOffsetTicks: number;
  /** Named in the evidence (coyote only): which anchor the trials will use. */
  anchorSource?: string;
  /** Upper bound on a trial's walk, from the OBSERVED ledge distance (coyote only). */
  maxWalkTicks?: number;
}

/** The cadence pin, proven rather than assumed. Returns the refusal, or null. */
function cadenceRefusal(
  capture: KeyedCapture,
  fixedTimestep: number,
  sweepFps: number,
): string | null {
  const perTick = samplesPerTick(capture.samples, fixedTimestep);
  if (perTick !== null && Math.abs(perTick - 1) <= 0.25) return null;
  return (
    `the sweep needs ONE sample per physics tick to index ticks, and the calibration capture sampled ${perTick === null ? "an unreadable cadence" : `${perTick.toFixed(2)} samples/tick`} ` +
    `(captureFps ${sweepFps} against a ${(1 / fixedTimestep).toFixed(2)}Hz sim).`
  );
}

/**
 * THE COYOTE CALIBRATION: walk until the player actually LEAVES THE GROUND.
 *
 * This used to be a walk of exactly `runLeg.ticks`, and that was a contradiction on
 * any real level (E6 session three): the run leg's bound exists to keep the player ON
 * the ground for its whole hold, while this walk's whole job is to leave it. A level
 * that declared a safe 60-tick runway therefore refused the coyote sweep outright.
 * The walk now searches, in `COYOTE_WALK_STEP_TICKS` steps from a fresh spawn each
 * time, until ungrounding is OBSERVED or the hard cap is reached.
 *
 * Ungrounding is observed by the controller's own ground flag when the seam declares
 * one, and by the first confirmed descent otherwise. The two answers are different
 * ticks on a rig whose ground probe is smaller than its collider, which is the whole
 * point of `fields.grounded`.
 */
async function calibrateCoyoteLedge(
  args: SweepRunArgs,
  maxTicks: number,
  sampledFields: Record<string, unknown>[] | undefined,
): Promise<SweepCalibration | { refusal: string }> {
  const { send, seam, fixedTimestep, sweepFps, record, log } = args;
  const move = runLegKey(seam);

  for (
    let walkTicks = COYOTE_WALK_STEP_TICKS;
    walkTicks <= COYOTE_WALK_MAX_TICKS;
    walkTicks += COYOTE_WALK_STEP_TICKS
  ) {
    await args.beforeLeg();
    const capture = await keyedCapture(
      send,
      seam.playerLocator,
      [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [move], fixedTicks: walkTicks },
      ],
      sweepFps,
      sampledFields,
    );
    record("runtime.capture_input_motion", {
      leg: `coyoteTime calibration (walk ${walkTicks}t)`,
      sampleCount: capture.sampleCount,
    });

    const cadence = cadenceRefusal(capture, fixedTimestep, sweepFps);
    if (cadence !== null) return { refusal: cadence };

    const descent = firstDescentSampleIndex(capture.samples);

    if (sampledFields !== undefined) {
      const timeline = groundedTimelineOf(capture);
      if (timeline === undefined) {
        return {
          refusal:
            `harness.feelSeam.fields.grounded is declared as ${JSON.stringify(seam.fields.grounded)} but the capture echoed no fieldTimeline entry for it: ` +
            "this bridge predates the sampledFields echo (L3a). Update the Loombridge package in this project, or remove fields.grounded to " +
            "accept the rig-dependent descent anchor. Falling back silently would report an exactly-anchored number that is not one.",
        };
      }
      const anchor = groundedAnchorSampleIndex(
        timeline,
        capture.samples.length,
        descent === null ? capture.samples.length - 1 : descent,
      );
      if ("index" in anchor) {
        return {
          capture,
          referenceIndex: anchor.index,
          // The anchor index IS the ungrounding step, so only the press path's
          // injection latency remains (see BRIDGE_SAMPLE_LAG_TICKS).
          anchorOffsetTicks: BRIDGE_INJECTION_LATENCY_TICKS,
          anchorSource: ANCHOR_SOURCE_GROUNDED,
          maxWalkTicks: anchor.index - SETTLE_TICKS + maxTicks,
        };
      }
      // A field the bridge cannot read will not become readable by walking further.
      if (anchor.kind === "unreadable") return { refusal: anchor.refusal };
      log(`[loombridge capture] feel: coyoteTime calibration: no ungrounding within a ${walkTicks}-tick walk; extending.`);
      continue;
    }

    if (descent !== null) {
      return {
        capture,
        referenceIndex: descent,
        anchorOffsetTicks: BRIDGE_SAMPLE_TICK_OFFSET,
        anchorSource: ANCHOR_SOURCE_Y_DESCENT_NOTE,
        maxWalkTicks: descent - SETTLE_TICKS + maxTicks,
      };
    }
    log(`[loombridge capture] feel: coyoteTime calibration: no descent within a ${walkTicks}-tick walk; extending.`);
  }
  return { refusal: NO_REACHABLE_LEDGE_REASON };
}

/** The jump-buffer calibration: one jump, and the landing it is swept against. */
async function calibrateBufferLanding(args: SweepRunArgs): Promise<SweepCalibration | { refusal: string }> {
  const { send, seam, fixedTimestep, sweepFps, record } = args;
  await args.beforeLeg();
  const capture = await keyedCapture(
    send,
    seam.playerLocator,
    [
      { keys: [], fixedTicks: SETTLE_TICKS },
      { keys: [seam.keys.jump], fixedTicks: 8 },
      { keys: [], fixedTicks: 100 },
    ],
    sweepFps,
  );
  record("runtime.capture_input_motion", { leg: "jumpBuffer calibration", sampleCount: capture.sampleCount });

  const cadence = cadenceRefusal(capture, fixedTimestep, sweepFps);
  if (cadence !== null) return { refusal: cadence };

  const descent = firstDescentSampleIndex(capture.samples);
  if (descent === null) return { refusal: "the calibration jump never fell: no landing to sweep against." };
  const landing = landingSampleIndexAfter(capture.samples, descent);
  if (landing === null) {
    return { refusal: "the calibration capture never landed inside its window, so the sweep could not be centred." };
  }
  return { capture, referenceIndex: landing, anchorOffsetTicks: BRIDGE_SAMPLE_TICK_OFFSET };
}

/**
 * A threshold sweep: one calibration pass to locate the reference event, then a
 * trial per tick offset. EVERY trial's raw echo is retained (including the grounded
 * timeline that anchors it); the reported window is `deriveSweepMetric` over those
 * echoes, the same function the gate re-runs (L76/L77).
 */
async function runSweep(args: SweepRunArgs): Promise<void> {
  const { metric, send, seam, fixedTimestep, sweepFps, metrics, sources, omitted, record, log } = args;
  const maxTicks = sweepTicksForTarget(targetSeconds(args.contract, metric), fixedTimestep);
  const sampledFields = metric === "coyoteTime" ? groundedSampledFields(seam) : undefined;

  const calibration =
    metric === "coyoteTime"
      ? await calibrateCoyoteLedge(args, maxTicks, sampledFields)
      : await calibrateBufferLanding(args);
  if ("refusal" in calibration) {
    omitted.push({ metric, reason: calibration.refusal });
    return;
  }

  const trials: SweepTrialEcho[] = [];
  // Offsets start at ONE tick, not zero: at offset 0 the press is consumed on the
  // very step the reference event happens, which for coyote is an ordinary grounded
  // jump (the derivation refuses that trial by design) and for the buffer is a press
  // on the landing tick itself. Neither is a threshold measurement.
  for (let offset = 1; offset <= maxTicks; offset += 1) {
    const plan = trialPhases(metric, seam, calibration.referenceIndex, offset, {
      anchorOffsetTicks: calibration.anchorOffsetTicks,
      ...(calibration.maxWalkTicks === undefined ? {} : { maxWalkTicks: calibration.maxWalkTicks }),
    });
    if ("refusal" in plan) {
      // The trials gathered so far are still retained below when they bracket a
      // threshold; a sweep that stops early because the runway ran out is a smaller
      // sweep, not a corrupt one.
      if (trials.length === 0) {
        omitted.push({ metric, reason: plan.refusal });
        return;
      }
      log(`[loombridge capture] feel: ${metric} sweep stopped at offset ${offset}: ${plan.refusal}`);
      break;
    }
    await args.beforeLeg();
    const capture = await keyedCapture(send, seam.playerLocator, plan.phases, sweepFps, sampledFields);
    record("runtime.capture_input_motion", { leg: `${metric} trial[${offset}]`, sampleCount: capture.sampleCount });
    const groundedTimeline = sampledFields === undefined ? undefined : groundedTimelineOf(capture);
    if (sampledFields !== undefined && groundedTimeline === undefined) {
      // The calibration proved the bridge echoes this timeline, so a trial without one
      // is not an older bridge: it is a sweep whose trials would not share one anchor.
      omitted.push({
        metric,
        reason: `trial ${offset} came back with no grounded-field timeline although the calibration had one, so the sweep's trials do not share a single anchor. Re-capture.`,
      });
      sources.push(sweepSource(metric, trials, calibration, args, [], deriveSweepMetric(metric, trials, fixedTimestep)));
      return;
    }
    trials.push({
      index: offset,
      pressPhaseIndex: plan.pressPhaseIndex,
      phases: capture.phases as SweepTrialEcho["phases"],
      samples: capture.samples,
      ...(groundedTimeline === undefined ? {} : { groundedTimeline }),
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
  calibration: SweepCalibration,
  args: SweepRunArgs,
  measuredMetrics: string[],
  derivation: ReturnType<typeof deriveSweepMetric>,
): Record<string, unknown> {
  // The sweep is N captures, so the cadence fields are the sweep's TOTALS: every
  // trial is one capture at the same pin, and the effective cadence re-derives from
  // the same pair the gate uses.
  const sampleCount = trials.reduce((sum, t) => sum + t.samples.length, 0);
  const durationMs = trials.reduce((sum, t) => sum + (t.samples.length > 1 ? t.samples[t.samples.length - 1].tMs - t.samples[0].tMs : 0), 0);
  // ONE FENCEPOST PER TRIAL. Each trial is its own capture window and sampled both
  // of its endpoints, so the summed pair spans `sampleCount - trials.length`
  // intervals. `windowCount` is written next to it so the file states the shape it
  // is in; the gate counts the same number off `trials[]` and refuses a disagreement.
  const windowCount = trials.length;
  const effective = effectiveCaptureFps(sampleCount, durationMs, windowCount);
  return {
    source: "runtime.capture_input_motion",
    producedBy: FEEL_PRODUCER,
    derivation: "input-bisection",
    measuredMetrics,
    sampleCount,
    durationMs: round4(durationMs),
    windowCount,
    captureFps: args.sweepFps,
    requestedCaptureFps: args.sweepFps,
    ...(effective === undefined ? {} : { effectiveCaptureFps: round4(effective) }),
    measuredAt: args.measuredAt,
    projectFixedTimestepBeforeMeasurement: calibration.capture.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: calibration.capture.measurementFixedTimestep,
    /** The convention, named in the file so a reader knows what the ticks mean. */
    tickOffset: BRIDGE_SAMPLE_TICK_OFFSET,
    /**
     * WHICH ANCHOR (E6 session three). A coyote window read off the visible descent
     * is a lower bound whose error is the rig's probe-vs-collider overhang, and a
     * reader has to be able to tell that from an exactly-anchored one. The sentence
     * carries its own fix, so the evidence teaches the operator what to declare.
     */
    ...(calibration.anchorSource === undefined ? {} : { anchorSource: calibration.anchorSource }),
    ...(metric === "coyoteTime" && args.seam.fields.grounded !== undefined
      ? { anchorField: args.seam.fields.grounded }
      : {}),
    /** Ticks charged to the ANCHOR side of the convention for this sweep. */
    anchorOffsetTicks: calibration.anchorOffsetTicks,
    /** Raw echo per trial: the gate re-derives the headline from THESE (L77). */
    trials,
    /** What the derivation read out of them (never the input to it). */
    observations: derivation.observations,
    boundaryTicks: derivation.boundaryTicks,
    firstFailedTicks: derivation.firstFailedTicks,
    ...(derivation.reason ? { derivationRefusal: derivation.reason } : {}),
  };
}

/** How a trial's press is PLACED, from what the calibration observed. */
export interface TrialPlanBounds {
  /**
   * Ticks removed when placing the press so the DERIVED offset comes out at `offset`:
   * the anchor half of the convention for THIS sweep's anchor. `BRIDGE_SAMPLE_TICK_OFFSET`
   * for a trajectory-read anchor, `BRIDGE_INJECTION_LATENCY_TICKS` for the grounded one.
   */
  anchorOffsetTicks: number;
  /**
   * Upper bound on a coyote trial's walk, derived from the OBSERVED ledge distance
   * plus the sweep's own margin. It is NOT `runLeg.ticks`: the run leg's runway is a
   * bound on ground the player may be driven across before it must still be standing,
   * and this walk's job is to reach the ledge the calibration already found.
   */
  maxWalkTicks?: number;
}

/**
 * The trial phases for one tick offset.
 *
 * The press phase is placed so the DERIVED offset comes out at `offset`. The
 * placement is a plan, not an assumption: the real offset is whatever the trial's
 * own echo says, which is why a drifting reference event weakens the sweep's
 * resolution but can never corrupt its arithmetic.
 */
export function trialPhases(
  metric: SweepMetric,
  seam: FeelSeam,
  referenceIndex: number,
  offset: number,
  bounds: TrialPlanBounds = { anchorOffsetTicks: BRIDGE_SAMPLE_TICK_OFFSET },
): { phases: KeyedPhase[]; pressPhaseIndex: number } | { refusal: string } {
  if (metric === "coyoteTime") {
    const pressIndex = referenceIndex + offset - bounds.anchorOffsetTicks;
    const walkTicks = pressIndex - SETTLE_TICKS;
    if (walkTicks < 1) {
      return {
        refusal:
          `the reference event lands at sample ${referenceIndex}, too early to place a press ${offset} tick(s) from it ` +
          "(the settle phase would have to be negative).",
      };
    }
    // THE OBSERVED LEDGE BINDS THE TRIALS. A press `offset` ticks after the ledge
    // needs `offset` more ticks of walking than the calibration did; past the ledge
    // distance the calibration measured plus the sweep's own range, the plan has left
    // the thing it is measuring. Refuse the trial rather than drive on: an offset the
    // level cannot host is a smaller sweep, and the derivation already refuses a sweep
    // that does not bracket.
    if (bounds.maxWalkTicks !== undefined && walkTicks > bounds.maxWalkTicks) {
      return {
        refusal:
          `placing the press ${offset} tick(s) after the ledge needs a ${walkTicks}-tick walk, past the ${bounds.maxWalkTicks}-tick ` +
          "bound the calibration's OBSERVED ledge distance plus this sweep's range allows. Accept the shorter sweep.",
      };
    }
    const move = runLegKey(seam);
    return {
      phases: [
        { keys: [], fixedTicks: SETTLE_TICKS },
        { keys: [move], fixedTicks: walkTicks },
        { keys: [move, seam.keys.jump], fixedTicks: 2 },
        { keys: [move], fixedTicks: COYOTE_TRIAL_TRAILING_TICKS },
      ],
      pressPhaseIndex: 2,
    };
  }
  const pressIndex = referenceIndex - offset - bounds.anchorOffsetTicks;
  const fallTicks = pressIndex - SETTLE_TICKS - 8;
  if (fallTicks < 1) {
    return {
      refusal:
        `the reference event lands at sample ${referenceIndex}, too early to place a press ${offset} tick(s) from it ` +
        "(the settle phase would have to be negative).",
    };
  }
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
      measure: locatorParam(seam.playerLocator),
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
    locator: locatorParam(seam.playerLocator),
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
        locator: locatorParam(seam.playerLocator),
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
  // The runway applies to the SEAM-driven horizontal drive too: a level whose safe
  // ground is leftward gets a negative moveX, not a shorter walk into the same hazard.
  const drive = runLegSign(seam);
  const data = await probe(
    send,
    seam,
    [
      { durationMs: (settleTicks * 1000) / captureFps, drivers: [driver(seam, seam.fields.moveX, 0)] },
      { durationMs: (SEAM_PROOF_TICKS * 1000) / captureFps, drivers: [driver(seam, seam.fields.moveX, drive)] },
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

  // NOTHING MOVED is ambiguous, so ask the scene before blaming the seam (E6). The
  // extra snapshot is only taken on that one refusal path, so the happy path costs
  // nothing, and an unanswerable snapshot leaves the seam sentence exactly as it was.
  let frozen: string | null = null;
  let frozenSnapshot: unknown = undefined;
  if (verdict.reasonKind === "no-motion") {
    try {
      frozenSnapshot = await send(
        "runtime.get_snapshot",
        {
          locator: locatorParam(seam.playerLocator),
          components: [seam.controllerComponent, "Rigidbody2D", "Rigidbody"],
          include_paths: ["enabled", "m_Enabled", "simulated"],
        },
        15000,
      );
      record("runtime.get_snapshot", { purpose: "no-motion diagnosis (controller/body alive?)" });
      frozen = diagnoseFrozenPlayer(frozenSnapshot, seam);
    } catch (error) {
      frozenSnapshot = { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const reason = frozen ?? verdict.reason;

  return {
    attempted: true,
    ok: verdict.ok,
    ...(reason ? { reason } : {}),
    ...(verdict.reasonKind ? { reasonKind: verdict.reasonKind } : {}),
    ...(frozenSnapshot === undefined ? {} : { noMotionDiagnosis: { blamedEndState: frozen !== null, snapshot: frozenSnapshot } }),
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
      unmeasuredAcceptedTargets: output.unmeasuredAcceptedTargets,
      outOfScopeAcceptedTargets: output.outOfScopeAcceptedTargets,
      ...(output.aborted ? { aborted: output.aborted } : {}),
    };
  } finally {
    await resolved.disconnect();
  }
}
