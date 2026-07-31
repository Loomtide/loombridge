/**
 * THE PLAYABILITY OBSERVER (evidence arc E2 / stage 3; ledger L97, L98, L106, L122).
 *
 * `loombridge capture --slice <playability slice>` cannot DRIVE a level to
 * completion: reaching the goal of a game nobody has seen before is exactly the
 * game-specific intelligence the agent has and the CLI does not. So the CLI does
 * the other half, which is the half that decides the verdict: it OPENS an
 * observation window, tells the agent to drive, and writes `playability.json`
 * entirely from what the window recorded plus the probes it drove itself.
 *
 * The file it replaces was the moat's worst case. `es-assemble.mjs` wrote
 * `completable: true, completionMethod: "played", hazardKills: true,
 * collectibleIncrements: true, postWinInputLocked: true, postWinPlayerFrozen: true,
 * restartWorks: true` as hard-coded constants; the 14 KB evidence block recording
 * the real drive was never parsed by any gate; and `completionMethod`, the gate's
 * one anti-teleport control, was a string the assembler typed (L97/L98). An
 * eight-line hand-typed file produced the identical `playability=pass`.
 *
 * WHAT DECIDES `completionMethod` NOW. Not an op log: there is no op journal in the
 * bridge, and the agent drives from its OWN connection, so a CLI-side record of the
 * ops IT sent proves nothing (review H5). What a teleport cannot hide is the player
 * moving further in one frame than the game's own declared speeds allow. The
 * recorder samples every Update inside the game loop (polling over the wire is
 * disqualified: a round trip is tens of ms and a single-frame teleport lands between
 * two polls, review H6), and `domain/playability-observation.ts` walks the trace
 * against a bound derived from the contract's feel targets. Every violation is
 * recorded with its classification; an unexplained one means "assisted", never
 * "played".
 *
 * SESSION SHAPE (ordering is load-bearing):
 *   1. resolve the seam and the kinematic bound BEFORE play mode: a refusal here
 *      costs the operator nothing;
 *   2. play, input session, `observe.start` (which reads the spawn, the goal, the
 *      respawn point and the COLLECTIBLE COUNT out of the running scene);
 *   3. refuse a window whose win field is ALREADY TRUE at open (review H7);
 *   4. print the machine-readable drive-now line and poll `observe.status` cheaply;
 *   5. `observe.drain`, then the CLI drives the post-win probes ITSELF (freeze,
 *      input-lock, and a restart proven by a SECOND recorded window);
 *   6. derive, and refuse rather than write a file the buffers do not support;
 *   7. restore (end session, console, stop) in a `finally`.
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
import { resolvePlayabilitySeam, type PlayabilitySeam } from "../../domain/harness-seam.js";
import {
  derivePlayability,
  deriveKinematicBound,
  type KinematicBound,
  type ObservationBuffers,
  type ObservedPoint,
  type PlayabilityDerivation,
} from "../../domain/playability-observation.js";

/** The producer marker every file this recipe writes carries (stage 1 discipline). */
export const PLAYABILITY_PRODUCER = "loombridge-capture";

/** The recipe name stamped in `_provenance.recipe`; the gate keys the produced shape on it. */
export const PLAYABILITY_RECIPE = "playability";

/** Ticks each post-win probe drives. 30 at 60Hz is half a second of held input. */
const PROBE_TICKS = 30;

/** Capture rate for the post-win probes. Pinned, so the probes are deterministic. */
const PROBE_CAPTURE_FPS = 60;

/** Ticks the restart probe holds the restart key, then waits, before draining. */
const RESTART_TAP_TICKS = 4;
const RESTART_SETTLE_TICKS = 90;

/** How often the CLI polls `observe.status` while the agent drives. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Default drive window when the harness declares none: 10 minutes. */
const DEFAULT_DRIVE_TIMEOUT_SECONDS = 600;

export interface CapturePlayabilityArgs {
  outDir: string;
  contract: unknown;
  runId: string;
  project?: string;
  consoleCount?: number;
}

export interface CapturePlayabilityResult {
  playabilityPath: string;
  consolePath: string;
  completionMethod: string;
  sampleCount: number;
  driveSeconds: number;
  logCount: number;
}

/** The one wire primitive the session needs; a scripted fake satisfies it in tests. */
export type PlayabilitySend = (
  command: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export interface PlayabilitySessionOptions {
  send: PlayabilitySend;
  contract: unknown;
  runId: string;
  editorSessionId?: string;
  unityRouting?: UnityRoutingMetadata;
  now?: () => string;
  /** Monotonic clock for the drive deadline; injectable so tests do not wait. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  consoleCount?: number;
  pollIntervalMs?: number;
  /** Ring size override, in samples. */
  capacity?: number;
}

export interface PlayabilitySessionOutput {
  playability: Record<string, unknown>;
  console: Record<string, unknown>;
  derivation: PlayabilityDerivation;
  /** Wall time the agent spent driving, from window open to the observed win. */
  driveSeconds: number;
  logCount: number;
}

// ── small readers over the op responses ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pointOf(value: unknown): ObservedPoint | undefined {
  if (!isRecord(value)) return undefined;
  const x = num(value.x);
  const y = num(value.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y, ...(num(value.z) === undefined ? {} : { z: num(value.z) as number }) };
}

/**
 * A hierarchy locator, split into the `{ scene, path }` shape the bridge resolves.
 * The contract writes locators as `Scene:/Path/To/Object`; passing that whole
 * string as `path` makes the resolver hunt for a root object literally named
 * "Scene:".
 */
// locatorParam moved to domain/harness-seam.ts (E6 F1): one splitter beside the templates.
import { locatorParam } from "../../domain/harness-seam.js";
export { locatorParam };

/** Parallel-array buffers out of a drain response, with nothing coerced. */
export function buffersFromDrain(data: unknown): ObservationBuffers | null {
  const samples = isRecord(data) ? data.samples : undefined;
  if (!isRecord(samples)) return null;
  const numbers = (key: string): number[] =>
    Array.isArray(samples[key]) ? (samples[key] as unknown[]).map((v) => (typeof v === "number" ? v : Number.NaN)) : [];
  const nullable = (key: string): (number | null)[] =>
    Array.isArray(samples[key])
      ? (samples[key] as unknown[]).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
      : [];
  const flags = (key: string): (boolean | null)[] =>
    Array.isArray(samples[key]) ? (samples[key] as unknown[]).map((v) => (typeof v === "boolean" ? v : null)) : [];

  const tMs = numbers("tMs");
  return {
    tMs,
    frame: numbers("frame"),
    fixedTick: numbers("fixedTick"),
    x: numbers("x"),
    y: numbers("y"),
    z: numbers("z"),
    win: flags("win"),
    score: nullable("score"),
    lives: nullable("lives"),
  };
}

/** Trajectory samples out of a `capture_input_motion` response. */
function trajectoryOf(data: unknown): { tMs: number; x: number; y: number }[] {
  const raw = isRecord(data) ? data.samples : undefined;
  if (!Array.isArray(raw)) return [];
  const out: { tMs: number; x: number; y: number }[] = [];
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

// ── the session ─────────────────────────────────────────────────────────────

/**
 * Drive the whole observation session over `send` and return the documents to
 * write. Every wire interaction goes through `send`, so the unit suite runs the
 * real recipe against a scripted bridge with no editor in the room.
 */
export async function runPlayabilitySession(
  options: PlayabilitySessionOptions,
): Promise<PlayabilitySessionOutput> {
  const { send } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const consoleCount = options.consoleCount ?? 200;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const resolution = resolvePlayabilitySeam(options.contract);
  if (!resolution.ok) throw new Error(resolution.refusal);
  const seam = resolution.seam;

  const boundResolution = deriveKinematicBound(options.contract);
  if (!boundResolution.ok) throw new Error(boundResolution.refusal);
  const bound: KinematicBound = boundResolution.bound;

  if (!options.editorSessionId) {
    // The session id is the only thing binding this evidence to the editor session
    // that recorded it (the co-temporality hole, ledger L106: three files from three
    // play sessions, one runId, nothing noticed).
    throw new Error(
      "REFUSED: the bridge handshake supplied no editorSessionId, so the produced playability.json could not be bound to the editor session that recorded it.",
    );
  }

  const capturedAt = now();
  const opLog: Record<string, unknown>[] = [];
  const record = (op: string, detail: Record<string, unknown>): void => {
    opLog.push({ op, ...detail });
  };
  let logs: unknown[] = [];

  let open: Record<string, unknown> = {};
  let drain: Record<string, unknown> = {};
  let buffers: ObservationBuffers | null = null;
  let probeEvidence: Record<string, unknown> = {};
  let derivation: PlayabilityDerivation | null = null;
  let driveSeconds = 0;

  try {
    await send("editor.play", {}, 30000);
    await send("editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    await send("input.begin_session", { backend: "InputSystem" }, 15000);

    // ── 1. open the window; the bridge reads the scene ONCE, here ────────────
    const started = await send("observe.start", startParams(seam, options.capacity), 30000);
    open = isRecord(started) ? started : {};
    record("observe.start", { sessionId: open.sessionId, capacity: open.capacity });

    if (open.alreadyRecording === true) {
      throw new Error(
        "REFUSED: a recording window was ALREADY open on this editor, so this run cannot know what state the game was in when it opened " +
          `(session ${String(open.sessionId)}). Drain it (observe.drain) or leave and re-enter play mode, then re-run capture.`,
      );
    }
    if (open.started !== true) {
      throw new Error(
        `REFUSED: observe.start did not open a recording window (started=${String(open.started)}), so there is nothing to observe.`,
      );
    }

    const initial = isRecord(open.initial) ? open.initial : {};
    if (initial.win === true) {
      throw new Error(
        "REFUSED: the win field was ALREADY TRUE when the observation window opened, so nothing this window records can show the level " +
          "being completed (review H7). Stop play, re-enter, and re-run capture so the window opens on an unwon game.",
      );
    }
    if (initial.win !== false) {
      throw new Error(
        `REFUSED: the win field read ${JSON.stringify(initial.win)} at window open rather than a boolean, so the recorder could not read it. ` +
          `Check harness.playability.fields.win ("${seam.fields.win}") against ${seam.stateComponent}.`,
      );
    }

    // ── 2. hand the drive to the agent ───────────────────────────────────────
    const timeoutSeconds = seam.driveTimeoutSeconds ?? DEFAULT_DRIVE_TIMEOUT_SECONDS;
    const startedAtMs = clock();
    const deadlineMs = startedAtMs + timeoutSeconds * 1000;
    // MACHINE-READABLE, on one line, because an agent reads this from a shell
    // transcript. The window is open and the recorder is sampling: whatever drives
    // the game next, over any connection, is what the evidence will describe.
    log(
      `[loombridge capture] playability: DRIVE NOW ${JSON.stringify({
        sessionId: open.sessionId,
        editorSessionId: options.editorSessionId,
        winField: `${seam.stateComponent}.${seam.fields.win}`,
        timeoutSeconds,
        pollIntervalMs,
        instruction:
          "Play the level to completion from your own bridge connection. Do NOT stop play mode and do NOT teleport the player: " +
          "every frame is being recorded and a super-kinematic step that is not the game's own respawn is reported as an assisted completion.",
      })}`,
    );

    // ── 3. poll CHEAPLY until the win is observed ────────────────────────────
    let sawWin = false;
    let lastStatus: Record<string, unknown> = {};
    for (;;) {
      const status = await send("observe.status", {}, 15000);
      lastStatus = isRecord(status) ? status : {};
      const latest = isRecord(lastStatus.latest) ? lastStatus.latest : {};
      if (lastStatus.recording !== true) {
        throw new Error(
          "REFUSED: the recorder stopped before a win was observed (play mode exited, or a domain reload wiped it). " +
            "The recorder does not survive either, by design, so the window is gone: re-enter play and re-run capture.",
        );
      }
      if (latest.win === true) {
        sawWin = true;
        break;
      }
      if (clock() >= deadlineMs) break;
      await sleep(pollIntervalMs);
    }
    driveSeconds = (clock() - startedAtMs) / 1000;

    // ── 4. drain (destructive) ───────────────────────────────────────────────
    const drained = await send("observe.drain", {}, 60000);
    drain = isRecord(drained) ? drained : {};
    record("observe.drain", { sampleCount: drain.sampleCount, droppedSamples: drain.droppedSamples });
    if (drain.wasRecording !== true) {
      throw new Error(
        "REFUSED: observe.drain reports the recorder was not live at drain time, so the buffer it returned is not a window this run recorded.",
      );
    }
    buffers = buffersFromDrain(drain);
    if (buffers === null) {
      throw new Error("REFUSED: observe.drain returned no sample buffers, so there is nothing to derive a verdict from.");
    }
    if (!sawWin) {
      throw new Error(
        `REFUSED: no win was observed within ${timeoutSeconds}s (${buffers.tMs.length} sample(s) recorded). ` +
          "The window is drained and the recorder stopped; nothing was written. Re-run capture and complete the level inside the window, " +
          "or raise harness.playability.driveTimeoutSeconds.",
      );
    }

    // ── 5. the post-win probes, driven by the CLI itself ─────────────────────
    probeEvidence = await runPostWinProbes(send, seam, record, options.capacity);
    log(`[loombridge capture] playability: post-win probes done (freeze, input-lock, restart).`);
  } finally {
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

  // ── 6. derive, and refuse rather than write an unsupported file ───────────
  const context = {
    winRule: seam.winRule,
    contractWinRule: contractWinRule(options.contract),
    collectibleTotal: num(open.collectibleTotal) ?? 0,
    spawn: pointOf(open.spawn) ?? { x: 0, y: 0 },
    ...(pointOf(open.respawn) ? { respawn: pointOf(open.respawn) as ObservedPoint } : {}),
    ...(pointOf(open.goal) ? { goal: pointOf(open.goal) as ObservedPoint } : {}),
    ...(seam.goalRadiusU === undefined ? {} : { goalRadiusU: seam.goalRadiusU }),
    droppedSamples: num(drain.droppedSamples) ?? 0,
    bound,
  };
  const probeInput = {
    ...(Array.isArray(probeEvidence.freezeSamples) ? { freezeSamples: probeEvidence.freezeSamples as { tMs: number; x: number; y: number }[] } : {}),
    ...(Array.isArray(probeEvidence.inputLockSamples) ? { inputLockSamples: probeEvidence.inputLockSamples as { tMs: number; x: number; y: number }[] } : {}),
    ...(probeEvidence.restartBuffers ? { restartBuffers: probeEvidence.restartBuffers as ObservationBuffers } : {}),
  };
  derivation = derivePlayability(buffers as ObservationBuffers, context, probeInput);
  if (derivation.refusals.length > 0) {
    throw new Error(
      `REFUSED: the recorded window does not support a playability verdict, so no file was written:\n  - ${derivation.refusals.join("\n  - ")}`,
    );
  }

  const provenance = {
    writer: PLAYABILITY_PRODUCER,
    recipe: PLAYABILITY_RECIPE,
    capturedAt,
    capturedInPlayMode: true,
    runId: options.runId,
    editorSessionId: options.editorSessionId,
    ...(options.unityRouting ? { unityRouting: options.unityRouting } : {}),
    seam,
    /**
     * THE OBSERVATION. Every field the gate re-derives from lives here: the raw
     * buffers, the values the BRIDGE read from the scene at open, the recorder's
     * own accounting, and the probe traces. The gate re-runs `derivePlayability`
     * over exactly this and refuses any headline it does not reproduce.
     */
    observation: {
      sessionId: open.sessionId,
      recorderEditorSessionId: open.editorSessionId,
      driveSeconds: Math.round(driveSeconds * 1000) / 1000,
      open: {
        startedAtUtc: open.startedAtUtc,
        capacity: open.capacity,
        fixedTimestep: open.fixedTimestep,
        spawn: open.spawn,
        goal: open.goal,
        respawn: open.respawn,
        initial: open.initial,
        collectibleTotal: open.collectibleTotal,
        collectibleInactive: open.collectibleInactive,
        collectiblePaths: open.collectiblePaths,
      },
      accounting: {
        wasRecording: drain.wasRecording,
        sampleCount: drain.sampleCount,
        totalSampled: drain.totalSampled,
        droppedSamples: drain.droppedSamples,
        capacity: drain.capacity,
        elapsedMs: drain.elapsedMs,
        effectiveSampleRateHz: drain.effectiveSampleRateHz,
        fixedTickCount: drain.fixedTickCount,
        unreadableFields: drain.unreadableFields,
      },
      context: {
        winRule: context.winRule,
        contractWinRule: context.contractWinRule,
        goalRadiusU: seam.goalRadiusU,
        bound,
      },
      buffers,
      probes: probeEvidence,
      derived: derivation.observation,
    },
    ops: opLog,
  };

  const playability: Record<string, unknown> = {
    ...derivation.headline,
    _provenance: provenance,
  };

  return {
    playability,
    console: { logs, _provenance: provenance },
    derivation,
    driveSeconds: Math.round(driveSeconds * 1000) / 1000,
    logCount: logs.length,
  };
}

/** The `observe.start` parameters, straight off the resolved seam. */
function startParams(seam: PlayabilitySeam, capacity: number | undefined): Record<string, unknown> {
  return {
    playerPath: seam.playerLocator,
    statePath: seam.stateLocator,
    stateComponent: seam.stateComponent,
    winField: seam.fields.win,
    scoreField: seam.fields.score,
    livesField: seam.fields.lives,
    ...(seam.collectibles?.namePattern ? { collectibleNamePattern: seam.collectibles.namePattern } : {}),
    ...(seam.collectibles?.tag ? { collectibleTag: seam.collectibles.tag } : {}),
    ...(seam.goalLocator ? { goalPath: seam.goalLocator } : {}),
    ...(seam.respawnLocator ? { respawnPath: seam.respawnLocator } : {}),
    ...(capacity === undefined ? {} : { capacity }),
  };
}

/** `acceptance.win.rule`, the string the gate compares `winRuleObserved` against. */
function contractWinRule(contract: unknown): string {
  if (!isRecord(contract)) return "";
  const win = contract.win;
  return isRecord(win) && typeof win.rule === "string" ? win.rule : "";
}

/**
 * The three post-win probes, all driven by the CLI over its OWN connection, all
 * measured from op echoes:
 *
 *   FREEZE      a window with NO keys held. A modal end state should leave the
 *               player where it is; a player still falling behind the overlay
 *               shows up as displacement.
 *   INPUT LOCK  the same window with the movement key HELD. Displacement here
 *               means gameplay input still reaches the controller behind the
 *               overlay.
 *   RESTART     a SECOND recorded window: tap the restart key, settle, drain. The
 *               evidence is the recorded state, not an assertion: the win field
 *               must be back to false and the score no higher than it opened.
 */
async function runPostWinProbes(
  send: PlayabilitySend,
  seam: PlayabilitySeam,
  record: (op: string, detail: Record<string, unknown>) => void,
  capacity: number | undefined,
): Promise<Record<string, unknown>> {
  const measure = locatorParam(seam.playerLocator);

  const freeze = await send(
    "runtime.capture_input_motion",
    {
      measure,
      phases: [{ keys: [], fixedTicks: PROBE_TICKS }],
      captureFps: PROBE_CAPTURE_FPS,
      includeSamples: true,
    },
    60000,
  );
  record("runtime.capture_input_motion", { leg: "post-win freeze probe" });

  const inputLock = await send(
    "runtime.capture_input_motion",
    {
      measure,
      phases: [{ keys: [seam.keys.moveRight], fixedTicks: PROBE_TICKS }],
      captureFps: PROBE_CAPTURE_FPS,
      includeSamples: true,
    },
    60000,
  );
  record("runtime.capture_input_motion", { leg: "post-win input-lock probe", keys: [seam.keys.moveRight] });

  const evidence: Record<string, unknown> = {
    freezeSamples: trajectoryOf(freeze),
    inputLockSamples: trajectoryOf(inputLock),
    freezeEcho: isRecord(freeze) ? { sampleCount: freeze.sampleCount, durationMs: freeze.durationMs, phases: freeze.phases } : {},
    inputLockEcho: isRecord(inputLock)
      ? { sampleCount: inputLock.sampleCount, durationMs: inputLock.durationMs, phases: inputLock.phases }
      : {},
  };

  if (!seam.keys.restart) {
    evidence.restartOmitted =
      "harness.playability.keys.restart is not declared, so the restart affordance was not exercised. " +
      "A modal end state refuses this at seam-resolution time; a continuous end state does not grade restartWorks.";
    return evidence;
  }

  const restartOpen = await send("observe.start", startParams(seam, capacity), 30000);
  record("observe.start", { leg: "restart probe", sessionId: isRecord(restartOpen) ? restartOpen.sessionId : undefined });
  await send(
    "runtime.capture_input_motion",
    {
      measure,
      phases: [
        { keys: [seam.keys.restart], fixedTicks: RESTART_TAP_TICKS },
        { keys: [], fixedTicks: RESTART_SETTLE_TICKS },
      ],
      captureFps: PROBE_CAPTURE_FPS,
      includeSamples: false,
    },
    60000,
  );
  record("runtime.capture_input_motion", { leg: "restart tap", keys: [seam.keys.restart] });
  const restartDrain = await send("observe.drain", {}, 60000);
  record("observe.drain", { leg: "restart probe" });

  evidence.restartOpen = isRecord(restartOpen) ? { sessionId: restartOpen.sessionId, initial: restartOpen.initial } : {};
  evidence.restartAccounting = isRecord(restartDrain)
    ? {
        wasRecording: restartDrain.wasRecording,
        sampleCount: restartDrain.sampleCount,
        droppedSamples: restartDrain.droppedSamples,
        elapsedMs: restartDrain.elapsedMs,
      }
    : {};
  const restartBuffers = buffersFromDrain(restartDrain);
  if (restartBuffers !== null) evidence.restartBuffers = restartBuffers;
  return evidence;
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

/** Observe playability evidence into `outDir` against the live editor. */
export async function capturePlayabilityEvidence(
  args: CapturePlayabilityArgs,
): Promise<CapturePlayabilityResult> {
  const playabilityPath = path.join(args.outDir, "playability.json");
  const consolePath = path.join(args.outDir, "console.json");

  // Both refusals land BEFORE play mode is entered: neither answer changes with a
  // running editor, and the operator gets the JSON to add instead of a game that
  // entered play for nothing.
  const resolution = resolvePlayabilitySeam(args.contract);
  if (!resolution.ok) throw new Error(resolution.refusal);
  const boundResolution = deriveKinematicBound(args.contract);
  if (!boundResolution.ok) throw new Error(boundResolution.refusal);

  const resolved = createUnityClientForCli({ ...(args.project ? { project: args.project } : {}) });
  const client = resolved.client;
  const send: PlayabilitySend = async (command, params = {}, timeoutMs) => {
    await ensureConnected(client);
    try {
      return responseData(await client.send(command, params, timeoutMs), command);
    } catch (error) {
      // `observe.drain` is DESTRUCTIVE: a retry after a lost response returns an
      // empty window from a stopped recorder and the minutes of play are gone
      // (NON_IDEMPOTENT_OPS carries the same rule for the replay driver).
      if (!isConnectionLoss(error) || command === "observe.drain") throw error;
      await ensureConnected(client);
      return responseData(await client.send(command, params, timeoutMs), command);
    }
  };

  try {
    await client.connect();
    const routing = buildUnityRoutingMetadata(resolved);
    const output = await runPlayabilitySession({
      send,
      contract: args.contract,
      runId: args.runId,
      ...(routing.editorSessionId ? { editorSessionId: routing.editorSessionId } : {}),
      unityRouting: routing,
      ...(args.consoleCount === undefined ? {} : { consoleCount: args.consoleCount }),
      log: (message) => console.error(message),
    });
    await writeJson(playabilityPath, output.playability);
    await writeJson(consolePath, output.console);
    return {
      playabilityPath,
      consolePath,
      completionMethod: output.derivation.headline.completionMethod,
      sampleCount: output.derivation.observation.sampleCount,
      driveSeconds: output.driveSeconds,
      logCount: output.logCount,
    };
  } finally {
    await resolved.disconnect();
  }
}
