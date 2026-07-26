/**
 * Replay Verification — observe-a-human-session live RECORDER (the `record
 * --observe` wiring).
 *
 * Composes the existing observe pieces into one flow: reset to a clean Play-Mode
 * start at the scene (so the human demonstrates from the SAME start replay will
 * reset to), start observing, wait for the human to signal they're done, stop and
 * collect the clicks, capture any declared outcomes WHILE Play Mode is still live,
 * and transform it all into a `ReplayTrace` (green by construction). Mirrors
 * `record-live`/`run-live` so the bridge wiring lives in one place; the caller
 * persists the trace (e.g. to `.loombridge/replays/traces/<id>.trace.json`).
 *
 * `recordObservedTrace(send, …)` is the pure orchestration over a `BridgeSend`
 * (unit-testable against a fake send); `observeRecordLive(…)` adds the
 * connect/reconnect/cleanup bootstrap around it.
 */

import { UnityClient } from "../../unity-client.js";
import {
  observedClicksToTrace,
  observedEdgesToTrace,
  type ObserveTraceMeta,
  type OutcomeSpec,
} from "./observe.js";
import { captureOutcomes, observeLive } from "./observe-live.js";
import { resilientSend } from "./resilient-send.js";
import { endLiveSession } from "./session.js";
import type { ReplayTrace } from "./types.js";
import { UnityDriver, type BridgeSend } from "./unity-driver.js";
import { isScenePath } from "../minigame/profiles/types.js";
import { resolveActiveEntryScene, type SceneQueryDriver } from "../minigame/minigame-scene-gating.js";

/** Adapt a raw `BridgeSend` to the `SceneQueryDriver` the entry-scene resolver needs (it only does
 *  `scene.get_active`). Mirrors `UnityDriver.op`'s success/error split without exposing the private op. */
function sceneQueryFromSend(send: BridgeSend): SceneQueryDriver {
  return {
    op: async (command, params) => {
      try {
        const resp = await send(command, params);
        if (resp.status === "error") return { error: resp.error?.message ?? "bridge error" };
        return { data: (resp.data ?? {}) as Record<string, unknown> };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export interface ObserveRecordResult {
  trace: ReplayTrace;
  /** uGUI taps the observer dropped for hitting no interactive element (logged, never silent). */
  droppedNoTarget: number;
}

export interface ObserveRecordOptions {
  /**
   * Resolves when the human signals the demonstration is done (→ stop observing).
   * Injected so the live wiring is testable: the CLI passes an Enter-read (or a
   * timed sleep); tests pass a controlled resolver.
   */
  waitForStop: () => Promise<void>;
  /**
   * Outcome specs to pin as end-state assertions, read at stop (the trust layer).
   * Omitted ⇒ flow-only (verify the UI flow ran, not the resulting game state).
   */
  outcomes?: OutcomeSpec[];
  /** Inject a client (tests); defaults to a fresh auto-discovering `UnityClient`. */
  client?: UnityClient;
  /**
   * Unity project to pin. Without it the client follows the shared
   * endpoint-discovery-latest.json pointer, which every running editor overwrites on its
   * heartbeat — so with two editors open the verb can drive the wrong project.
   */
  projectPathCanonical?: string;
}

/**
 * Orchestrate one observe-recording over an already-connected `send`. Refuses an
 * empty/observation-died capture (via `observeLive.stop` + `observedClicksToTrace`)
 * rather than minting a hollow trace.
 */
export async function recordObservedTrace(
  send: BridgeSend,
  meta: ObserveTraceMeta,
  options: { waitForStop: () => Promise<void>; outcomes?: OutcomeSpec[] },
): Promise<ObserveRecordResult> {
  const driver = new UnityDriver(send);
  // The recorded trace is a `ui-events` (action) trace — gate the backend the same
  // way replay does rather than assume it.
  const capability = await driver.capabilityCheck("ui-events");
  if (!capability.supported) {
    throw new Error(`record: input backend unsupported (${capability.reason ?? "unsupported"})`);
  }
  // Scene-agnostic (D5): when no `--scene` was given, RESOLVE the editor's current scene to a saved
  // asset path and record/reset from it — or refuse (can't verify the current scene). Inert for the
  // normal path: a caller that passed a valid `--scene` skips this entirely (back-compatible).
  if (!isScenePath(meta.scene)) {
    const resolution = await resolveActiveEntryScene(sceneQueryFromSend(send));
    if (!resolution.ok) {
      throw new Error(`record: ${resolution.message}`);
    }
    meta = { ...meta, scene: resolution.scene };
  }
  // Clean Play-Mode start at the scene: the human demonstrates from the same state
  // replay will reset to, so a mid-game recording can't drift from replay's start.
  const reset = await driver.reset({ scene: meta.scene, reset: "scene-load" });
  if (!reset.ok) {
    throw new Error(`record: reset failed (${reset.reason ?? "reset-unavailable"})`);
  }

  // If the recording declared a state signal, pass it to observe_start so the
  // observer SAMPLES that field per gesture (the value lands on each click as
  // `click.stateSignal`, which the transform turns into a `wait-for-condition`
  // gate). Absent ⇒ observe_start receives `{}` (no behaviour change).
  const startSignal =
    meta.stateSignal && meta.stateSignal.component
      ? {
          path: meta.stateSignal.locator.path,
          component: meta.stateSignal.component,
          property: meta.stateSignal.property,
        }
      : undefined;
  // Phase 2 / D1-B: auto-detect each scene's signal live (per-scene gates without a declared signal).
  const session = await observeLive(send, startSignal, meta.autoDetectStateSignal === true); // input.observe_start
  await options.waitForStop(); // the human plays, then signals done
  const { clicks, keyEdges, droppedNoTarget } = await session.stop(); // observe_stop (refuses observed:false)
  // Outcomes are read while Play Mode is STILL live — captureOutcomes must run
  // before endLiveSession stops Play (runtime values are gone after the reload).
  const outcomes = await captureOutcomes(send, options.outcomes ?? []);
  // Keyboard gameplay → the timed-edge transform (concurrency + timing); a pure-click
  // session keeps the per-gesture transform (visual timeline + per-step captures).
  const trace =
    keyEdges.length > 0
      ? observedEdgesToTrace(clicks, keyEdges, meta, outcomes)
      : observedClicksToTrace(clicks, meta, outcomes);
  return { trace, droppedNoTarget };
}

/** Connect, record a human demonstration, and return the trace (caller persists it). */
export async function observeRecordLive(
  meta: ObserveTraceMeta,
  options: ObserveRecordOptions,
): Promise<ObserveRecordResult> {
  const client =
    options.client
    ?? new UnityClient(
      options.projectPathCanonical
        ? { targetIdentity: { projectPathCanonical: options.projectPathCanonical } }
        : {},
    );
  await client.connect();
  const send = resilientSend(client);
  try {
    return await recordObservedTrace(send, meta, {
      waitForStop: options.waitForStop,
      outcomes: options.outcomes,
    });
  } finally {
    await endLiveSession(send, client);
  }
}
