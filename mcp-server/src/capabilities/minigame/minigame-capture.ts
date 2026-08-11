/**
 * `loombridge minigame capture` — drive the recorded happy-path trace through the
 * live bridge and emit the verify capture pack, so Step 2 is ONE command, not a
 * hand-written script.
 *
 *   loombridge minigame capture --contract <p> --trace-root <dir> --captures <out> [--id <trace>] [--settle <ms>]
 *
 * It replays the trace from `minigame setup` step 1 (reusing the proven replay
 * driver — reset, dispatch, world-tap, wait-for-visible) and, at trace-anchored
 * checkpoints (see `planCaptureFromTrace`), snapshots each named state's triple:
 *   <state>.png            (editor.screenshot)
 *   <state>.ui-rects.json  (ui.get_screen_rects full-scene dump → capture shape)
 *   <state>.console.json   (editor.console_logs)
 * plus `flow.json` (the REAL per-transition actuation evidence for the flow gate).
 *
 * Honest-or-surface: a state the trace never reaches (e.g. `home_back` when the
 * recording never taps Home) is NOT faked — it's reported as not-captured, and the
 * downstream `verify` reports it as CAN'T VERIFY. It never mutates the Unity project
 * (only screenshots/introspects) and writes only into the external `--captures` dir.
 *
 * Exit codes:
 *   0  drive completed + pack written (warns on any unreached state)
 *   2  usage / contract or trace not loadable / input backend unsupported
 *   1  bridge connection or drive/runtime error
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { assertValidMinigameContract } from "./profiles/validator.js";
import {
  OUTCOME_GATEABLE_KINDS,
  resolveDevices,
  type DeviceSpec,
  type MinigameContract,
  type MinigameReachedCondition,
} from "./profiles/types.js";
import {
  assignObjectIds,
  buildFlowEvidence,
  computeFlowStall,
  objectIdFromPath,
  perDeviceKey,
  planCaptureFromTrace,
  planResponseStimulus,
  rawObjectPaths,
  requiredVisibleStatus,
  stripScene,
  summarizeChangedIds,
  toCaptureState,
  toResponseDoc,
  type CapturePlan,
  type RawScreenRects,
  type RecordedTransition,
  type StateCapturePlan,
} from "./minigame-capture-plan.js";
import { reorderStatesByTrace } from "./minigame-role-discover.js";
import { isDraftContract } from "./minigame-draft.js";
import {
  dispatchWaitWithGestureRecovery,
  isContinuousGesture,
  isRecoverableWait,
  preservesPendingGesture,
  type RecoverableWait,
} from "../replay/gesture-recovery.js";
import { changedObjectIds } from "./input-response.js";
import { captureBackgroundData } from "./minigame-background.js";
import { discoverBackgroundCandidates } from "./minigame-background-discover.js";
import type { BackgroundCandidates, MinigameCaptureState } from "./types.js";
import { BACKGROUND_COVERAGE_GATE, BACKGROUND_SEAM_GATE } from "./evaluators.js";
import { BACKGROUND_DATA_FILE } from "./run-minigame-gates.js";

/** Advisory background-discovery result, written every capture run (device-invariant like background.json). */
const BACKGROUND_CANDIDATES_FILE = "background-candidates.json";
import { ICON, unityConnectionHint } from "../../shared/cli-ui.js";
import { printNextStep } from "./minigame-next.js";
import type { FlowActuation, FlowStall } from "./flow-evidence.js";
import { UnityClient } from "../../bridge/unity-client.js";
import { resolveCliProjectPin } from "../setup/cli-project-pin.js";
import { resilientSend } from "../replay/resilient-send.js";
import { endLiveSession } from "../replay/session.js";
import { UnityDriver } from "../replay/unity-driver.js";
import type {
  CapabilityResult,
  CaptureOutcome,
  ConsoleOutcome,
  DispatchResult,
  ResetResult,
} from "../replay/driver.js";
import type { ResetSpec } from "../replay/types.js";
import { parseTrace } from "../replay/index.js";
import type { Action, ReplayTrace } from "../replay/types.js";
import { flatReplayLayout } from "../../domain/state.js";

const DEFAULT_REACHED_TIMEOUT_MS = 2500;

interface CaptureArgs {
  contractPath: string;
  traceRoot: string;
  capturesDir: string;
  traceId?: string;
  settleMs: number;
  /** Unity project to drive. Absent → inferred from cwd; see resolveCliProjectPin. */
  project?: string;
}

function parseArgs(argv: string[]): CaptureArgs | { error: string } {
  let contractPath: string | undefined;
  let traceRoot: string | undefined;
  let capturesDir: string | undefined;
  let traceId: string | undefined;
  let settleMs = 500;
  let project: string | undefined;
  const take = (i: number, name: string): string | { error: string } => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let v: string | { error: string };
    switch (arg) {
      case "--contract":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        contractPath = path.resolve(v);
        break;
      case "--trace-root":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        traceRoot = path.resolve(v);
        break;
      case "--captures":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        capturesDir = path.resolve(v);
        break;
      case "--id":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        traceId = v;
        break;
      case "--project":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        project = path.resolve(v);
        break;
      case "--settle":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        settleMs = Number(v);
        if (!Number.isFinite(settleMs) || settleMs < 0) return { error: "--settle must be a non-negative number of ms" };
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  if (!contractPath) return { error: "--contract <path> is required" };
  if (!traceRoot) return { error: "--trace-root <dir> is required" };
  if (!capturesDir) return { error: "--captures <dir> is required" };
  return { contractPath, traceRoot, capturesDir, traceId, settleMs, project };
}

async function loadContract(contractPath: string): Promise<MinigameContract> {
  return assertValidMinigameContract(JSON.parse(await fs.readFile(contractPath, "utf-8")));
}

/** A scan-bootstrapped DRAFT (not yet finalized) — safe to reorder its states (propose-only). The
 *  scan writes `description: "DRAFT: …"`; finalize rewrites it, so this won't touch a finalized contract. */
async function loadTrace(traceRoot: string, traceId: string): Promise<ReplayTrace> {
  const file = path.join(flatReplayLayout(traceRoot).replayTraces, `${traceId}.trace.json`);
  return parseTrace(JSON.parse(await fs.readFile(file, "utf-8")));
}

/** A uGUI EventSystem dispatch (the only kind that carries flow actuation evidence). */
function isUiDispatch(action: Action): boolean {
  return action.do === "tap" || action.do === "drag";
}

function actionTargetPath(action: Action): string | undefined {
  if (action.do === "tap") return action.locator?.path;
  if (action.do === "drag") return action.to?.path;
  return undefined;
}

/** The element a gesture begins on — for a drag, the dragged object (`from`); for a tap, the tapped element. */
function actionSourcePath(action: Action): string | undefined {
  if (action.do === "tap") return action.locator?.path;
  if (action.do === "drag") return action.from?.path;
  return undefined;
}

/**
 * Drive the trace and write the pack. Split out so the (untestable here) live wiring
 * is one focused function; the planning/transform/flow logic is pure + unit-tested.
 */
/** What capture observed for the input-response liveness, surfaced as an honest suggestion. */
interface ResponseObservation {
  stateId: string;
  tap?: string;
  changed: string[];
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Plan checkpoints indexed by their position in the drive (built once, reused per device). */
export interface CheckpointIndex {
  initial: StateCapturePlan[];
  final: StateCapturePlan[];
  before: Map<number, StateCapturePlan[]>;
  after: Map<number, StateCapturePlan[]>;
  /** Visibility-windowed states (slice 2): the loop snapshots each at the first step in its
   *  `[trigger.start, trigger.end]` window where ALL its requiredInFrame objects are co-visible. */
  windows: StateCapturePlan[];
}

export function indexCheckpoints(plan: CapturePlan): CheckpointIndex {
  const initial: StateCapturePlan[] = [];
  const final: StateCapturePlan[] = [];
  const before = new Map<number, StateCapturePlan[]>();
  const after = new Map<number, StateCapturePlan[]>();
  const windows: StateCapturePlan[] = [];
  const pushAt = (m: Map<number, StateCapturePlan[]>, i: number, sp: StateCapturePlan): void => {
    const list = m.get(i) ?? [];
    list.push(sp);
    m.set(i, list);
  };
  for (const sp of plan.states) {
    if (sp.trigger.kind === "initial") initial.push(sp);
    else if (sp.trigger.kind === "final") final.push(sp);
    else if (sp.trigger.kind === "before-action") pushAt(before, sp.trigger.index, sp);
    else if (sp.trigger.kind === "after-action") pushAt(after, sp.trigger.index, sp);
    else if (sp.trigger.kind === "window") windows.push(sp);
  }
  return { initial, final, before, after, windows };
}

/**
 * The subset of `UnityDriver` that `driveDeviceOnce` calls — declared structurally so the
 * per-device drive logic (ordering, base-only vs per-device artifact decisions) is unit-
 * testable against a fake without a live bridge.
 */
export interface CaptureDriver {
  capabilityCheck(backend: string): Promise<CapabilityResult>;
  reset(start: { scene: string; reset: ResetSpec }): Promise<ResetResult>;
  dispatch(action: Action): Promise<DispatchResult>;
  confirmReached(cond: MinigameReachedCondition, timeoutMs: number): Promise<{ reached: boolean; actual?: string }>;
  capture(id: string, settleMs?: number): Promise<CaptureOutcome>;
  dumpScreenRects(): Promise<Record<string, unknown>>;
  readConsole(): Promise<ConsoleOutcome>;
}

/** Everything one device's drive contributes to the run-wide buffers (written at the end). */
export interface DriveAccumulators {
  /** Raw dumps keyed by `<state>@<device>` (every drive) AND `<state>` (base drive only). */
  rawByState: Map<string, RawScreenRects>;
  /** Console health per LOGICAL state — device-invariant, populated on the base drive only. */
  consoleByState: Map<string, { errorCount: number; errors: string[] }>;
  /** Logical states captured, in drive order — populated on the base drive only. */
  captured: string[];
  /** Logical states whose declared reached condition timed out — base drive only. */
  notReached: { stateId: string; reason: string }[];
  /** Window states captured at their last-chance step with only SOME requiredInFrame objects
   *  visible (the rest never co-visible during the window) — base drive only. Surfaced honestly:
   *  the screen IS captured, but these required objects were never simultaneously on screen. */
  partial: { stateId: string; missing: string[]; sequential: string[] }[];
  /** Per-transition actuation evidence — base drive only (flow is device-invariant). */
  transitions: RecordedTransition[];
  /** EVERY base-drive ui dispatch in drive order (transition-independent), for stall detection. */
  dispatches: FlowActuation[];
  /** input-response before/after dumps — base drive only (the stimulus is device-invariant). */
  respBefore?: RawScreenRects;
  respAfter?: RawScreenRects;
}

/**
 * Drive the trace ONCE at one device's aspect and capture its states. The Game View
 * size is set BEFORE this runs (while stopped), so `reset()`'s play-mode entry lands at
 * the correct layout — we never resize mid-play (the live-proven fix; a mid-play resize
 * doesn't relayout before the dump in the tight capture loop). On the BASE device we ALSO
 * capture the device-INVARIANT evidence — the legacy `<state>` artifacts, flow transitions,
 * console, and the input-response — exactly once; non-base devices only add their per-device
 * `<state>@<device>` rects + .png so flow.json isn't overwritten N× and the response isn't
 * re-randomized. Returns `{ blocked }` (capability/reset) without mutating the accumulators.
 */
export async function driveDeviceOnce(
  driver: CaptureDriver,
  contract: MinigameContract,
  trace: ReplayTrace,
  plan: CapturePlan,
  checkpoints: CheckpointIndex,
  capturesDir: string,
  settleMs: number,
  device: DeviceSpec,
  isBase: boolean,
  acc: DriveAccumulators,
): Promise<{ blocked: string } | { ok: true }> {
  const cap = await driver.capabilityCheck(trace.input?.backend ?? "ui-events");
  if (!cap.supported) return { blocked: cap.reason ?? "unsupported-input-backend" };

  // reset() does editor.stop → open_scene → play; play-mode entry happens at the size set
  // by the caller while stopped, so this device's layout is correct from the first frame.
  const reset = await driver.reset({ scene: trace.start.scene, reset: trace.start.reset });
  if (!reset.ok) return { blocked: reset.reason ?? "reset-unavailable" };

  // Window states (slice 2) are captured at the first step where ALL their requiredInFrame
  // objects are co-visible. Build the id→locator map once (scene-stripped) for the scan, and
  // track which window states this device has already shot so we don't re-capture them.
  const objLocatorById = new Map(
    (contract.requiredInFrame ?? []).map((o) => [o.id, o.locator]),
  );
  const capturedWindows = new Set<string>();
  // DISTINCTIVE (advancement-proving) required objects per state = its requiredInFrame minus every id
  // already required by an EARLIER screen in the happy path. Reaching a screen is judged by these: when
  // a replay STALLS on an earlier screen (a gesture didn't reproduce on some device/aspect), only that
  // earlier screen's objects (incl. shared chrome like a Home button) stay visible — so "≥1 required
  // visible" mislabels the stuck frame as this screen and emits false "X off-screen" GAME fails. An
  // object shared only with a LATER screen (e.g. a topping shown on decorate AND the reward screen)
  // still PROVES advancement, so we subtract PRIOR screens only, not all other states. A screen whose
  // objects are all inherited from earlier (distinctive empty) falls back to the legacy "≥1 required".
  const distinctiveByState = new Map<string, Set<string>>();
  {
    // Path-ambiguity guard (multi-scene): two scenes can hold objects that share a scene-stripped
    // path (e.g. `/Canvas/HomeButton` under both Home and StarChef). `requiredVisibleStatus` matches
    // by stripped path, so such an object can't PROVE which screen is on-screen — drop it from every
    // distinctive set so a stalled cross-scene frame is never screenshotted and mislabeled as a
    // screen it didn't actually reach. (Single-scene: locators are distinct → this set is empty.)
    const strippedCounts = new Map<string, number>();
    for (const o of contract.requiredInFrame ?? []) {
      const sp = stripScene(o.locator);
      strippedCounts.set(sp, (strippedCounts.get(sp) ?? 0) + 1);
    }
    const pathAmbiguous = new Set(
      (contract.requiredInFrame ?? []).filter((o) => (strippedCounts.get(stripScene(o.locator)) ?? 0) > 1).map((o) => o.id),
    );
    const reqById = new Map(contract.states.map((s) => [s.id, new Set(s.requiredInFrame ?? [])]));
    const order = contract.interactionFlow?.happyPath?.length ? contract.interactionFlow.happyPath : contract.states.map((s) => s.id);
    const prior = new Set<string>();
    for (const id of order) {
      const req = reqById.get(id) ?? new Set<string>();
      distinctiveByState.set(id, new Set([...req].filter((x) => !prior.has(x) && !pathAmbiguous.has(x))));
      for (const x of req) prior.add(x);
    }
    // Any state not in the happy path keeps its full required set (no prior-order info to subtract).
    for (const s of contract.states) if (!distinctiveByState.has(s.id)) distinctiveByState.set(s.id, new Set(s.requiredInFrame ?? []));
  }
  // Per windowed state, the union of required objects seen visible at ANY probe frame in its window.
  // Lets us tell a "sequential" missing object (seen earlier, e.g. cook's spray before pour) from one
  // that never appeared at all — the former is a contract-granularity gap (split the state), not a fail.
  const windowSeen = new Map<string, Set<string>>();

  let bucket: FlowActuation[] = [];
  // The most recent continuous (scrub/stir) gesture — re-driven by `dispatchConditionWithGestureRecovery`
  // when the next phase gate fails (closed-loop recovery for under-reproduced gestures on extreme aspects).
  let lastGesture: Action | undefined;
  // Track the previous logical state for transitions; on the base drive this mirrors
  // `acc.captured`, on non-base drives `acc.captured` is already populated so we keep a
  // local counter to know when (on base) a transition should be recorded.
  const captureState = async (sp: StateCapturePlan): Promise<void> => {
    if (sp.reached) {
      const timeoutMs = sp.reached.timeoutMs ?? DEFAULT_REACHED_TIMEOUT_MS;
      const reached = await driver.confirmReached(sp.reached, timeoutMs);
      if (!reached.reached) {
        if (isBase) {
          acc.notReached.push({
            stateId: sp.stateId,
            reason: `the game never reached this screen (${describeReachedCondition(sp.reached)} not met${reached.actual ? `; actual ${reached.actual}` : ""})`,
          });
        }
        return;
      }
    }

    // Reachability guard for the `final` capture (the terminal screen). Unlike a window state — already
    // gated by the window scan's distinctive-object logic — a `final` capture otherwise screenshots
    // whatever is on screen at the end of the drive. If the replay STALLED before reaching it, that end
    // frame is an earlier screen; capturing it would mislabel the stuck frame as the final state and
    // emit false "X off-screen" GAME fails. So if the final state has DISTINCTIVE objects
    // (advancement-proving — not inherited from an earlier screen) and NONE are visible, mark notReached
    // instead of screenshotting. (`initial` can't stall before the first screen; `before`/`after` are
    // anchored to their own actions — only `final` floats to wherever the drive ended.)
    if (sp.trigger?.kind === "final") {
      const distinctive = distinctiveByState.get(sp.stateId) ?? new Set<string>();
      if (distinctive.size > 0) {
        const probe = (await driver.dumpScreenRects()) as RawScreenRects;
        if (requiredVisibleStatus([...distinctive], objLocatorById, probe).visible === 0) {
          if (isBase) {
            acc.notReached.push({
              stateId: sp.stateId,
              reason:
                "the game never showed this screen — none of its distinctive objects were visible (the recorded input likely didn't advance the game on this device/aspect)",
            });
          }
          return;
        }
      }
    }

    // <state>@<device>.png — REQUIRE a real screenshot (a missing artifact is a harness
    // failure surfaced loudly via exit 1, never a silent green). The game is already in
    // this state (the trace's taps run between captureState calls); just snapshot it.
    const key = perDeviceKey(sp.stateId, device.id);
    const shot = await driver.capture(key, settleMs);
    if (!shot.artifact) {
      throw new Error(
        `state '${sp.stateId}' @ device '${device.id}': screenshot was not written ` +
          "(editor.screenshot returned no image) — refusing to emit a capture pack that " +
          "claims this screen without its .png.",
      );
    }
    acc.rawByState.set(key, (await driver.dumpScreenRects()) as RawScreenRects);

    if (isBase) {
      // The BASE device backs the legacy single-aspect artifacts (`<state>.png` + the
      // `<state>` rects key) the current verify still reads — copy/mirror them so the
      // existing gates stay green until Phase 4 teaches verify the per-device keys.
      await fs.copyFile(shot.artifact, path.join(capturesDir, `${sp.stateId}.png`));
      acc.rawByState.set(sp.stateId, acc.rawByState.get(key) as RawScreenRects);

      // Device-INVARIANT bookkeeping (flow transitions, console) — recorded once, on base.
      if (acc.captured.length > 0) {
        acc.transitions.push({ from: acc.captured[acc.captured.length - 1], to: sp.stateId, actuations: bucket });
      }
      bucket = [];
      const con = await driver.readConsole();
      acc.consoleByState.set(sp.stateId, { errorCount: con.errorCount, errors: con.errors });
      acc.captured.push(sp.stateId);
    }
  };

  // input-response liveness: snapshot BEFORE/AFTER the first gameplay tap — but only on the
  // BASE drive. The stimulus is device-invariant and re-driving it per device would re-
  // randomize the before/after (a non-deterministic game), so capture it exactly once.
  const stimulus = isBase ? planResponseStimulus(contract, plan) : null;

  for (const sp of checkpoints.initial) await captureState(sp);

  for (let i = 0; i < plan.flatActions.length; i += 1) {
    const action = plan.flatActions[i];
    for (const sp of checkpoints.before.get(i) ?? []) await captureState(sp);

    // Visibility-windowed capture (slice 2): at the START of iteration `i` the game reflects
    // action `i-1`'s effect and action `i`'s gesture hasn't run yet — so the screen for action
    // `i` is still showing (decorate's doneButton placed at `i-1` is visible; mix's ingredients
    // are visible before the first ingredient drag). For each window state whose `[start,end]`
    // covers `i`, probe the rects and shoot at the first step where ALL requiredInFrame objects
    // are co-visible. At the last step (`end`) we take the best-effort frame, but NEVER a frame
    // with zero required objects visible (that would mislabel a different screen).
    for (const ws of checkpoints.windows) {
      if (ws.trigger.kind !== "window") continue;
      if (capturedWindows.has(ws.stateId)) continue;
      if (i < ws.trigger.start || i > ws.trigger.end) continue;
      const required = ws.requiredInFrame ?? [];
      const rects = (await driver.dumpScreenRects()) as RawScreenRects;
      const status = requiredVisibleStatus(required, objLocatorById, rects);
      // Accumulate which required objects have been visible at SOME point in this window.
      const seen = windowSeen.get(ws.stateId) ?? new Set<string>();
      for (const id of required) if (!status.missing.includes(id)) seen.add(id);
      windowSeen.set(ws.stateId, seen);
      if (status.total > 0 && status.visible === status.total) {
        await captureState(ws);
        capturedWindows.add(ws.stateId);
      } else if (i === ws.trigger.end) {
        // Last chance for this window — decide honestly. "Reached" requires a DISTINCTIVE (screen-
        // specific) object to have appeared at SOME frame; otherwise only shared chrome was ever
        // visible, meaning the replay stalled before this screen (do NOT screenshot a stuck frame and
        // mislabel it — that emits false "X off-screen" game fails). Fall back to "≥1 required" only
        // when the state has no distinctive object at all (its required are all shared chrome).
        const distinctive = distinctiveByState.get(ws.stateId) ?? new Set<string>();
        const reached = distinctive.size > 0 ? [...distinctive].some((id) => seen.has(id)) : status.visible >= 1;
        if (reached && status.visible >= 1) {
          await captureState(ws); // best-effort: SOME required objects are visible here
          // A missing object seen EARLIER in the window is sequential (a sub-screen), not absent —
          // the gate downgrades those to can't-verify (split the state), never a game fail.
          if (isBase) acc.partial.push({ stateId: ws.stateId, missing: status.missing, sequential: status.missing.filter((id) => seen.has(id)) });
        } else if (isBase) {
          // Never reached: its distinctive objects never appeared (only shared chrome did, or nothing).
          // NEVER screenshot this frame — that mislabels another screen as this one → false game fails.
          acc.notReached.push({
            stateId: ws.stateId,
            reason:
              distinctive.size > 0
                ? "the game never showed this screen — only chrome shared with other screens was visible during its window (the recorded input likely didn't advance the game on this device/aspect)"
                : "the game never showed this screen (none of its required objects were ever visible during its window)",
          });
        }
        capturedWindows.add(ws.stateId); // resolved (captured-partial or notReached) — don't retry
      }
    }

    if (stimulus && i === stimulus.stimulusIndex) {
      acc.respBefore = (await driver.dumpScreenRects()) as RawScreenRects;
    }
    // A WAIT that can only be cleared by the game advancing — the `wait-for-condition` phase gate AND
    // the `wait-for-visible` the recorder emits just before it — is driven with adaptive gesture
    // recovery: if it fails, the preceding continuous gesture (a stir/scrub) is re-driven with
    // escalating travel until the wait clears or a bounded budget is spent. This is what keeps a
    // gesture-driven game from stalling on an extreme aspect where the open-loop scrub under-delivers
    // (the android-tall stir). The visibility wait is included because the recorder emits it FIRST,
    // so it is where an under-reproduced stir actually kills the drive.
    const res = isRecoverableWait(action)
      ? await dispatchWaitWithGestureRecovery(driver, action, lastGesture, {
          onRetry: (attempt, travelPx) =>
            console.error(
              `[loombridge minigame] capture: ${describeRecoverableWait(action)} not met on ${device.id} — re-driving the gesture (attempt ${attempt}, travel ${Math.round(travelPx)}px).`,
            ),
        })
      : await driver.dispatch(action);
    // Track the re-drivable gesture with an ADJACENCY guard: a continuous gesture arms it; a discrete
    // input (tap/key/position-drag) between it and a gate CLEARS it (that input advances the gate, not
    // the earlier scrub) so a tap-advanced gate can't falsely recover a stale gesture; only the waits
    // preserve it.
    if (isContinuousGesture(action)) lastGesture = action;
    else if (!preservesPendingGesture(action)) lastGesture = undefined;
    if (stimulus && i === stimulus.stimulusIndex) {
      if (settleMs > 0) await delay(settleMs);
      acc.respAfter = (await driver.dumpScreenRects()) as RawScreenRects;
    }
    if (isBase && isUiDispatch(action) && res.raw) {
      const rec: FlowActuation = {
        actuated: res.raw.actuated,
        handlerTarget: res.raw.handlerTarget,
        raycastHit: res.raw.raycastHit,
        handlersFired: res.raw.handlersFired,
        target: actionTargetPath(action),
        // A drag fires beginDrag/drag/endDrag on the SOURCE (not a pointerClick on the drop target),
        // so the flow gate corroborates against `source` + a drag signal for these.
        kind: action.do === "drag" ? "drag" : "tap",
        source: actionSourcePath(action),
      };
      bucket.push(rec);
      // The flat drive-order record feeds stall detection: a trailing all-dead run means the
      // game stopped consuming input mid-flow (per-transition buckets can't see that shape).
      acc.dispatches.push(rec);
    }
    for (const sp of checkpoints.after.get(i) ?? []) await captureState(sp);
  }

  for (const sp of checkpoints.final) await captureState(sp);
  return { ok: true };
}

async function captureLive(
  contract: MinigameContract,
  trace: ReplayTrace,
  plan: CapturePlan,
  capturesDir: string,
  settleMs: number,
  projectPathCanonical: string | undefined,
): Promise<{ captured: string[]; notReached: { stateId: string; reason: string }[]; partial: { stateId: string; missing: string[]; sequential: string[] }[]; response?: ResponseObservation; candidates?: BackgroundCandidates; stall?: FlowStall } | { blocked: string }> {
  await fs.mkdir(capturesDir, { recursive: true });
  // Pin the editor explicitly: an unpinned client follows endpoint-discovery-latest.json,
  // which every running editor overwrites on its heartbeat, so with two editors open a
  // capture can drive the wrong game and file the pack under the intended one.
  const client = new UnityClient(
    projectPathCanonical ? { targetIdentity: { projectPathCanonical } } : {},
  );
  await client.connect();
  const send = resilientSend(client);
  const driver = new UnityDriver(send, { captureDir: capturesDir });

  // Multi-aspect capture: RE-DRIVE the whole trace once per device. The device loop is the
  // OUTERMOST level — for each device we set the Game View size while STOPPED, then drive
  // (reset enters play at that size, so the layout is correct from the first frame). We never
  // resize mid-play (live-proven unreliable: a mid-play resize doesn't relayout before the dump
  // in the capture's tight loop, so every device captured a stale ~16:9 layout). `devices[0]`
  // is the BASE — its drive also produces the LEGACY single-aspect artifacts (`<state>.png`/
  // .ui-rects.json) + flow.json + the input-response, all device-invariant, captured ONCE.
  // The original Game View size is read from the FIRST resize's `previous*` and restored in the
  // `finally` so capture leaves the editor as it found it.
  const devices: DeviceSpec[] = resolveDevices(contract);
  let originalSize: { width: number; height: number } | undefined;
  const setGameViewSize = async (width: number, height: number): Promise<{ previousWidth?: number; previousHeight?: number }> => {
    const res = await send("editor.set_game_view_size", { width, height });
    // Honest-or-stop: a failed resize (op absent on an old bridge, no Game View, reflection
    // mismatch) must crash the capture LOUDLY — never silently fall through and write a
    // "multi-aspect" pack whose per-device frames are all the SAME aspect (a fake green).
    if (res.status === "error") {
      throw new Error(
        `editor.set_game_view_size ${width}x${height} failed: ${res.error?.message ?? "unknown bridge error"} ` +
          "— refusing to emit a multi-aspect capture pack whose per-device frames would all be one aspect.",
      );
    }
    const data = (res.data ?? {}) as { previousWidth?: number; previousHeight?: number };
    return data;
  };

  try {
    const checkpoints = indexCheckpoints(plan);
    // Buffer every device's dumps + the base drive's invariant evidence, then write all the
    // JSON at the END: object ids are resolved run-wide (`assignObjectIds`) across EVERY
    // per-device dump so a leaf-name collision disambiguates to the SAME id in every device
    // AND state, and a drive that aborts mid-way leaves no half-written pack masquerading as
    // complete.
    const acc: DriveAccumulators = {
      rawByState: new Map(),
      consoleByState: new Map(),
      captured: [],
      notReached: [],
      partial: [],
      transitions: [],
      dispatches: [],
    };

    for (const [di, device] of devices.entries()) {
      const isBase = di === 0;
      // Set the size BEFORE the drive, while STOPPED — the driveDeviceOnce reset() below
      // does stop→open→play, so entering play at this size yields the correct layout.
      const prev = await setGameViewSize(device.width, device.height);
      if (
        originalSize === undefined &&
        typeof prev.previousWidth === "number" &&
        typeof prev.previousHeight === "number"
      ) {
        originalSize = { width: prev.previousWidth, height: prev.previousHeight };
      }

      const driven = await driveDeviceOnce(
        driver,
        contract,
        trace,
        plan,
        checkpoints,
        capturesDir,
        settleMs,
        device,
        isBase,
        acc,
      );
      // A blocked drive (capability/reset) is never a passing or failing game — surface it
      // (the base block is the canonical signal; a non-base block would be the same cause).
      if ("blocked" in driven) return { blocked: driven.blocked };
    }

    const { rawByState, consoleByState, captured, notReached, partial, transitions, respBefore, respAfter } = acc;

    // Resolve collision-free ids across EVERY captured dump (per-device + the base `<state>`
    // mirrors + the response before/after dumps), so an object's id is consistent across
    // devices AND states AND the response evidence.
    const responseDumps = [respBefore, respAfter].filter((d): d is RawScreenRects => d !== undefined);
    const allPaths = [...rawByState.values(), ...responseDumps].flatMap(rawObjectPaths);
    const idMap = assignObjectIds(allPaths);
    const idFor = (objectPath: string): string => idMap.get(objectPath) ?? objectIdFromPath(objectPath);

    // Sequential sub-screen marker per state (G8): objects seen during the window but never in the
    // captured frame → stamped onto each capture so the gates downgrade them to can't-verify (split
    // the state), never a false game fail. Only the genuinely-sequential subset (seen-earlier) is sent.
    const sequentialByState = new Map<string, string[]>(
      partial.filter((p) => p.sequential.length > 0).map((p) => [p.stateId, p.sequential]),
    );
    const withSequential = (stateId: string, cs: MinigameCaptureState): MinigameCaptureState => {
      const seq = sequentialByState.get(stateId);
      return seq ? { ...cs, sequential: { missing: seq } } : cs;
    };

    // Per-device `<state>@<device>.ui-rects.json` — one for every device dump.
    for (const stateId of captured) {
      for (const device of devices) {
        const key = perDeviceKey(stateId, device.id);
        const raw = rawByState.get(key);
        if (!raw) continue;
        await fs.writeFile(
          path.join(capturesDir, `${key}.ui-rects.json`),
          `${JSON.stringify(withSequential(stateId, toCaptureState(key, raw, idFor)), null, 2)}\n`,
          "utf-8",
        );
      }
    }

    // Legacy single-aspect `<state>.ui-rects.json` + `<state>.console.json` (base device) —
    // still read by the current verify until Phase 4.
    for (const stateId of captured) {
      await fs.writeFile(
        path.join(capturesDir, `${stateId}.ui-rects.json`),
        `${JSON.stringify(withSequential(stateId, toCaptureState(stateId, rawByState.get(stateId) as RawScreenRects, idFor)), null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(capturesDir, `${stateId}.console.json`),
        `${JSON.stringify(consoleByState.get(stateId), null, 2)}\n`,
        "utf-8",
      );
    }

    // flow.json: honest per-transition actuation evidence (from the BASE drive only),
    // plus the stall marker when the drive ended in a run of dead dispatches.
    const stall = computeFlowStall(acc.dispatches);
    await fs.writeFile(
      path.join(capturesDir, "flow.json"),
      `${JSON.stringify(buildFlowEvidence(transitions, stall), null, 2)}\n`,
      "utf-8",
    );

    // <state>.response.json — input-response before/after evidence (BASE drive, when a
    // gameplay tap was driven).
    let response: ResponseObservation | undefined;
    const stimulus = planResponseStimulus(contract, plan);
    if (stimulus && respBefore && respAfter) {
      const doc = toResponseDoc(respBefore, respAfter, stimulus.stimulusTarget, idFor);
      await fs.writeFile(
        path.join(capturesDir, `${stimulus.stateId}.response.json`),
        `${JSON.stringify(doc, null, 2)}\n`,
        "utf-8",
      );
      response = { stateId: stimulus.stateId, tap: stimulus.stimulusTarget, changed: changedObjectIds(doc.before.objects, doc.after.objects) };
    }

    // background.json (Phase 5+) — ONE scene-level, device-INVARIANT world-geometry pack
    // for the background coverage + seam gates. Captured once here (world geometry is the
    // same at every aspect; the evaluator derives the per-aspect view rect). Honest-or-stop:
    // `captureBackgroundData` THROWS on any unreadable camera/layer, which aborts the
    // capture loudly (exit 1) rather than writing a partial pack that would read as covered.
    if (contract.checks.deterministic.includes(BACKGROUND_COVERAGE_GATE) || contract.checks.deterministic.includes(BACKGROUND_SEAM_GATE)) {
      const background = await captureBackgroundData(send, contract);
      await fs.writeFile(
        path.join(capturesDir, BACKGROUND_DATA_FILE),
        `${JSON.stringify(background, null, 2)}\n`,
        "utf-8",
      );
    }

    // background-candidates.json — ADVISORY discovery, run EVERY capture (device-invariant, like
    // background.json). It powers the "suggest-and-confirm" block printed when the gate isn't yet
    // bound. Defensively wrapped: discovery NEVER aborts the capture — the gate is the deterministic
    // surface, this is only a suggestion, so a discovery failure must not change the exit code.
    let candidates: BackgroundCandidates | undefined;
    try {
      candidates = await discoverBackgroundCandidates(send, contract);
      await fs.writeFile(
        path.join(capturesDir, BACKGROUND_CANDIDATES_FILE),
        `${JSON.stringify(candidates, null, 2)}\n`,
        "utf-8",
      );
    } catch (error) {
      // Discovery is ADVISORY — a failure must never fail the capture (the gate is the deterministic surface).
      console.error(`[loombridge minigame] capture: background discovery skipped (${message(error)}).`);
      candidates = undefined;
    }

    return { captured, notReached, partial, response, candidates, stall };
  } finally {
    // Restore the editor's original Game View size so capture leaves it as it found it.
    // Best-effort: a failed restore must not mask the real result (or a teardown error).
    if (originalSize) {
      try {
        await setGameViewSize(originalSize.width, originalSize.height);
      } catch {
        /* best-effort — a dead bridge / reload is surfaced by the drive itself */
      }
    }
    await endLiveSession(send, client);
  }
}

export async function runCapture(argv: string[], root: string = process.cwd()): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[loombridge minigame] capture: ${parsed.error}.`);
    printUsage();
    return 2;
  }

  let contract: MinigameContract;
  try {
    contract = await loadContract(parsed.contractPath);
  } catch (error) {
    console.error(`[loombridge minigame] capture: could not load contract ${parsed.contractPath}: ${message(error)}`);
    return 2;
  }

  const traceId = parsed.traceId ?? `${contract.id}-happy-path`;
  let trace: ReplayTrace;
  try {
    trace = await loadTrace(parsed.traceRoot, traceId);
  } catch (error) {
    console.error(
      `[loombridge minigame] capture: could not load trace '${traceId}' under ${rel(root, parsed.traceRoot)}: ${message(error)} ` +
        "(record one first with `loombridge trace record`).",
    );
    return 2;
  }

  // G5: the bootstrap scan froze the state order by static hierarchy (possibly backwards). Now that
  // a trace exists, re-derive the PLAYED order from it so the flow tier grades the real transitions
  // (mix→cook→…), not phantom ones (decorate→mix). Only for a DRAFT (propose-only), and only persist
  // when the order actually changed. A pure permutation — never changes what each screen verifies.
  if (isDraftContract(contract)) {
    const reordered = reorderStatesByTrace(contract, trace);
    if (reordered !== contract) {
      contract = reordered;
      try {
        await fs.writeFile(parsed.contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
        console.error(
          `[loombridge minigame] capture: reordered states to the demonstrated play order → ${contract.interactionFlow.happyPath.join(" → ")}.`,
        );
      } catch {
        // Best-effort persist; the in-memory reorder still drives this capture + flow evidence.
      }
    }
  }

  const plan = planCaptureFromTrace(contract, trace);

  let result: { captured: string[]; notReached: { stateId: string; reason: string }[]; partial: { stateId: string; missing: string[]; sequential: string[] }[]; response?: ResponseObservation; candidates?: BackgroundCandidates; stall?: FlowStall } | { blocked: string };
  try {
    result = await captureLive(
      contract,
      trace,
      plan,
      parsed.capturesDir,
      parsed.settleMs,
      resolveCliProjectPin({ project: parsed.project, root }),
    );
  } catch (error) {
    const hint = unityConnectionHint(error);
    console.error(hint ? hint.join("\n") : `[loombridge minigame] capture: drive failed: ${message(error)}`);
    return 1;
  }

  if ("blocked" in result) {
    console.error(
      `[loombridge minigame] capture: could not drive the game — ${result.blocked}. ` +
        "Nothing was captured (a blocked drive is never a passing or failing game).",
    );
    return 2;
  }

  const summaryPlan: CapturePlan = {
    ...plan,
    unreached: [...plan.unreached, ...result.notReached],
  };

  console.log(
    buildCaptureSummary(
      result.captured,
      summaryPlan,
      parsed.capturesDir,
      parsed.contractPath,
      root,
      result.response,
      resolveDevices(contract),
      result.candidates,
      contract.checks.deterministic.includes(BACKGROUND_COVERAGE_GATE),
      result.partial,
      result.stall,
    ).join("\n"),
  );
  // The guided footer only makes sense on the STANDARD workspace layout (<ws>/captures) the
  // resolver assumes; with a custom --captures it would inspect the wrong dir and mislead.
  const ws = path.dirname(parsed.contractPath);
  if (path.resolve(parsed.capturesDir) === path.resolve(ws, "captures")) await printNextStep(ws);
  return 0;
}

/** The human summary (pure): captured states, unreached states, the next command. */
export function buildCaptureSummary(
  captured: string[],
  plan: CapturePlan,
  capturesDir: string,
  contractPath: string,
  root: string,
  response?: ResponseObservation,
  devices?: DeviceSpec[],
  candidates?: BackgroundCandidates,
  backgroundAlreadyBound: boolean = false,
  partial?: { stateId: string; missing: string[] }[],
  stall?: FlowStall,
): string[] {
  // Multi-aspect: each state is captured at every device. Note the per-device breadth in the
  // header (e.g. "× 3 devices") and the per-device artifact stems, while keeping the legacy
  // single-aspect artifacts in the listing (still read by verify until Phase 4).
  const deviceCount = devices && devices.length > 0 ? devices.length : 1;
  const deviceNote = deviceCount > 1 ? ` × ${deviceCount} devices` : "";
  const lines = [
    `${ICON.capture} Captured ${captured.length} screen(s)${deviceNote} → ${rel(root, capturesDir)}`,
    ...captured.map((s) => {
      const perDevice =
        devices && devices.length > 0
          ? `, ${devices.map((d) => `${s}@${d.id}.png`).join(", ")}`
          : "";
      return `   ${ICON.pass} ${s}  (${s}.png, ${s}.ui-rects.json, ${s}.console.json${perDevice})`;
    }),
  ];
  const gated = plan.unreached.filter((u) => u.outcomeGated);
  const traceGap = plan.unreached.filter((u) => !u.outcomeGated);
  if (gated.length > 0) {
    lines.push("", `${ICON.gated} Not captured · outcome-gated (by design; a read-only verifier can't drive these on a non-deterministic game):`);
    for (const u of gated) lines.push(`   ${ICON.gated} ${u.stateId} — ${u.reason}`);
    lines.push("   (verify reports these as not asserted / outcome-gated — never a failure.)");
  }
  // Flow stall: the drive's trailing dispatches all reported actuated=false, so the game most
  // likely stopped consuming input at the named gesture, and everything "captured" after that
  // point is really the stalled frame. Surfaced loudly so the developer doesn't chase phantom
  // per-screen findings from mislabeled captures.
  if (stall) {
    lines.push(
      "",
      `${ICON.warn} Flow stall: the last ${stall.deadCount} of ${stall.totalDispatches} input dispatches all reported actuated=false, starting at the ${stall.kind ?? "tap"} on '${stall.target ?? "<unknown>"}'.`,
      "   The game most likely stopped consuming input there (the usual cause: a gesture racing the",
      "   game's phase gate or an activation animation, so \"visible\" was not yet \"consumable\").",
      "   Screens captured after that point show the STALLED frame, not the later states.",
      "   Fix: re-record with a state signal (--auto-state-signal, or declare \"stateSignal\" in the",
      "   contract) so capture phase-aligns each gesture, then re-run capture.",
    );
  }
  if (traceGap.length > 0) {
    lines.push("", `${ICON.cantVerify} Not captured — your recorded trace never reaches these screens (fix the recording, don't fake it):`);
    for (const u of traceGap) lines.push(`   ${ICON.fail} ${u.stateId} — ${u.reason}`);
    lines.push("   (verify will report these as CAN'T VERIFY until the trace reaches them.)");
    // Only suggest gating screens of an OUTCOME-GATEABLE kind (a win/loss/return). NEVER
    // suggest gating start/active — an unreached deterministic screen is a recording gap to
    // FIX, not a gating candidate (suggesting it would advise silently un-verifying the game).
    const kindOf = new Map(plan.states.map((s) => [s.stateId, s.kind]));
    const gateableGap = traceGap.filter((u) => OUTCOME_GATEABLE_KINDS.has(kindOf.get(u.stateId) ?? ""));
    if (gateableGap.length > 0) {
      lines.push(
        `  If one of these is gated by gameplay OUTCOME a read-only replay can't drive (a win behind`,
        `  correct answers / RNG), mark it instead of faking it:`,
        `     loombridge minigame finalize --contract ${rel(root, contractPath)} --captures ${rel(root, capturesDir)} --outcome-gated ${gateableGap.map((u) => u.stateId).join(",")}`,
      );
    }
  }
  // Visibility-windowed PARTIAL captures (slice 2) — the screen WAS captured (its best-effort
  // frame), but some `requiredInFrame` objects were never simultaneously visible during its
  // window. Surfaced honestly so a never-co-visible required object isn't silently dropped (it
  // will still be reported by the required-in-frame gate against the captured frame).
  if (partial && partial.length > 0) {
    lines.push("", `${ICON.warn} Captured, but these required objects were never simultaneously visible during their screen's window:`);
    for (const p of partial) lines.push(`   ${ICON.warn} ${p.stateId} — missing: ${p.missing.join(", ")}`);
  }
  // Input-response (liveness) — capture observed the before/after of a gameplay tap and
  // SUGGESTS a declaration. Honest-by-construction: it never auto-asserts; the developer
  // confirms by running the command, declaring what response THEY expect (the gate then
  // re-derives it on every capture). The suggested `observe` is what changed THIS run —
  // trim it to the meaningful response (e.g. the question/feedback, not an incidental tick).
  if (response && response.changed.length > 0) {
    // Compact same-named bursts (confetti×44) so the suggestion is readable, WITHOUT dropping a
    // signal: every base keeps a representative in the command; large groups are noted as "1 of N".
    const { suggested, collapsed } = summarizeChangedIds(response.changed);
    const tapId = response.tap ? objectIdFromPath(response.tap) : "<gameplay-control>";
    const shown = suggested.slice(0, 8);
    const moreNote = suggested.length > shown.length ? ` (+${suggested.length - shown.length} more not shown)` : "";
    lines.push(
      "",
      `${ICON.input} Liveness — tapping the gameplay control on '${response.stateId}' changed: ${shown.join(", ")}${moreNote}.`,
    );
    if (collapsed.length > 0) {
      lines.push(
        `   (collapsed: ${collapsed.map((c) => `${c.count}×'${c.base}…' shown as ${c.rep}`).join(", ")} — keep only if THAT is the response.)`,
      );
    }
    lines.push(
      "   This is a SUGGESTION, not a result. Declaring it makes a PERSISTENT claim re-checked on",
      "   EVERY future capture — KEEP only what SHOULD change on any answer (e.g. the question /",
      "   a feedback element), and DROP incidental diffs, or a later regression could still pass:",
      `      loombridge minigame finalize --contract ${rel(root, contractPath)} --captures ${rel(root, capturesDir)} --input-response ${response.stateId}:${tapId}:${shown.join(",")}`,
    );
  } else if (response) {
    lines.push(
      "",
      `${ICON.warn} Liveness — tapping the gameplay control on '${response.stateId}' changed nothing observable in the UI.`,
      "   If the game SHOULD respond, that may be a real liveness issue (or the response isn't a uGUI change).",
    );
  }
  // Background geometry (coverage + visible seam) — discovery walked the scene and SUGGESTS a binding.
  // Honest-by-construction: printed ONLY when the gate isn't already bound (when it is, capture
  // wrote a real background.json and the deterministic gate is the surface — no nag). The dev
  // confirms by running finalize; nothing is auto-enabled here. (Advisory warnings live in the
  // background-candidates.json for the curious — a no-background game is never nagged.)
  if (!backgroundAlreadyBound && candidates) {
    if (candidates.camera && candidates.recommended.length > 0) {
      const camName = candidates.camera.name;
      const layerNames = candidates.recommended.map((r) => r.name).join(", ");
      const perDevice = candidates.coverageByDevice
        .map((d) => {
          const pct = Math.round(d.fraction * 100);
          const gap = d.fraction < 1 && d.gapEdges.length > 0 ? ` (gap ${d.gapEdges.join(", ")})` : "";
          return `${d.label} ${pct}%${gap}`;
        })
        .join(", ");
      lines.push(
        "",
        `${ICON.drift} Background — found ${candidates.recommended.length} full-frame layer(s) covering ${camName}'s view (${layerNames}).`,
        `   Coverage: ${perDevice}.`,
      );
      // Honesty/reframe: when the recommended set doesn't fully cover a device, enabling the gate
      // will FAIL there until the background ART covers the frame — that's the gate doing its job,
      // NOT a reason to suppress the suggestion (the gap is a real defect the gate should catch).
      const gapDevices = candidates.coverageByDevice.filter((d) => d.fraction < 1);
      if (gapDevices.length > 0) {
        const labels = gapDevices.map((d) => d.label).join(", ");
        lines.push(
          `   ${ICON.warn} These layers leave a gap on ${labels} — enabling the gate will FAIL until the background art covers the frame (that is the check doing its job).`,
        );
      }
      if (candidates.excluded.length > 0) {
        const names = candidates.excluded.map((e) => e.name);
        const shown = names.slice(0, 6);
        const moreNote = names.length > shown.length ? `, +${names.length - shown.length} more` : "";
        lines.push(`   Decorative excluded: ${shown.join(", ")}${moreNote}.`);
      }
      lines.push(
        "   This is a SUGGESTION, not a result. Accept to enable the background coverage + seam gates:",
        `      loombridge minigame finalize --contract ${rel(root, contractPath)} --captures ${rel(root, capturesDir)} --background auto`,
      );
    } else if (candidates.cameras.length > 1) {
      // Ambiguous camera — can't pick one, so just tell the dev how to disambiguate.
      lines.push(
        "",
        `${ICON.drift} Background — ${candidates.cameras.length} orthographic cameras found; pass --background-camera <locator> to enable the coverage + seam gates (${candidates.cameras.map((c) => c.locator).join(", ")}).`,
      );
    }
    // Else (no camera + ≤1 ortho, or no recommended layers): print NOTHING — a game with no
    // background should not be nagged. The discovery warnings are in the JSON for the curious.
  }
  // The single next command is printed by `printNextStep` (the shared resolver footer).
  return lines;
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge minigame capture --contract <path> --trace-root <dir> --captures <out> [--id <trace>] [--settle <ms>]",
      "",
      "Drive the recorded happy-path trace through the live bridge and write the verify",
      "capture pack (<state>.png / .ui-rects.json / .console.json + flow.json), labelling",
      "each named state from the trace's own anchors. Read-only on the game; writes only",
      "into --captures.",
      "",
      "  --contract <path>   The mini-game contract (for its states / happy path).",
      "  --trace-root <dir>  Workspace holding traces/<id>.trace.json (from `trace record --flat`).",
      "  --captures <out>    Output capture-pack directory.",
      "  --id <trace>        Trace id (default: <contract-id>-happy-path).",
      "  --settle <ms>       Settle delay before each screenshot (default 500).",
      "",
      "Exit: 0 captured (warns on unreached states) · 2 usage / contract|trace load / blocked drive · 1 bridge/runtime error.",
    ].join("\n"),
  );
}

function rel(root: string, target: string): string {
  const r = path.relative(root, target);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : target;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeReachedCondition(cond: MinigameReachedCondition): string {
  return `${cond.locator}.${cond.property_path} ${cond.operator} ${JSON.stringify(cond.expected)}`;
}

/** Name the wait a gesture re-drive is trying to clear, for the retry notice. */
function describeRecoverableWait(action: RecoverableWait): string {
  return action.do === "wait-for-condition"
    ? `phase gate '${String(action.expected)}'`
    : `visibility gate '${action.locator.path}'`;
}
