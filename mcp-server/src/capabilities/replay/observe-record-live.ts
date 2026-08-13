/**
 * Replay Verification — observe-a-human-session live RECORDER (the `trace record`
 * wiring).
 *
 * Composes the existing observe pieces into one flow: reset to a clean Play-Mode
 * start at the scene (so the human demonstrates from the SAME start replay will
 * reset to), start observing, wait for the human to signal they're done, stop and
 * collect the clicks, capture any declared outcomes WHILE Play Mode is still live,
 * and transform it all into a `ReplayTrace` (green by construction). Mirrors
 * `record-live`/`run-live` so the bridge wiring lives in one place; the caller
 * persists the trace (e.g. to `.loombridge/anchors/traces/<id>.trace.json`).
 *
 * `recordObservedTrace(send, …)` is the pure orchestration over a `BridgeSend`
 * (unit-testable against a fake send); `observeRecordLive(…)` adds the
 * connect/reconnect/cleanup bootstrap around it.
 */

import { UnityClient } from "../../bridge/unity-client.js";
import {
  observedClicksToTrace,
  observedEdgesToTrace,
  type ObserveTraceMeta,
  type OutcomeSpec,
} from "./observe.js";
import { captureOutcomes, observeLive, type ObserveNotice } from "./observe-live.js";
import { resilientSend, type ReconnectableClient } from "./resilient-send.js";
import { endLiveSession, type LiveSessionClient } from "./session.js";
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
  /**
   * Taps the observer dropped because the Game view was unfocused when they arrived, so
   * the editor swallowed them and the game never processed them (logged, never silent).
   * 0 from a bridge that predates the field.
   */
  droppedUnfocused: number;
  /**
   * Key edges dropped for being OS window-manager modifiers (Cmd/Meta/Win): window-manager input,
   * not gameplay (logged, never silent).
   */
  droppedOsModifier: number;
}

/**
 * Turn the RESOLVED scene path into the trace id, for a recording that was given no id.
 *
 * The recorder cannot do this itself: the id has to be unique against the traces
 * DIRECTORY, and that directory belongs to the CLI layout (`layoutFor(args)` in
 * `trace.ts`), not to the bridge wiring. So the filesystem concern stays with its owner
 * and only the derived name crosses back. Called at most once, and only when no id was
 * given, so an explicit `--id` never reaches it.
 */
export type ResolveTraceId = (scenePath: string) => string | Promise<string>;

/**
 * The client this flow needs: reconnect-capable for the resilient send, disconnectable
 * for the cleanup. Structural rather than the concrete `UnityClient` (the `run-live`
 * precedent) so a test can drive the WHOLE record verb against a scripted bridge instead
 * of routing around the live wiring. `UnityClient` satisfies it unchanged.
 */
export interface ObserveRecordClient extends ReconnectableClient, LiveSessionClient {}

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
  /** Derive the trace id from the resolved scene when `meta.id` is empty. See {@link ResolveTraceId}. */
  resolveId?: ResolveTraceId;
  /** Inject a client (tests); defaults to a fresh auto-discovering `UnityClient`. */
  client?: ObserveRecordClient;
  /**
   * Unity project to pin. Without it the client follows the shared
   * endpoint-discovery-latest.json pointer, which every running editor overwrites on its
   * heartbeat — so with two editors open the verb can drive the wrong project.
   */
  projectPathCanonical?: string;
  /**
   * Where to print the recorder's human-facing lines ("click the Unity window", "recording").
   * Injected rather than hardcoded to console so the CLI owns its prefix and a test can assert
   * the ORDER of what the human was told. Omitted ⇒ silent (the pre-existing behaviour).
   */
  onNotice?: ObserveNotice;
}

/**
 * Orchestrate one observe-recording over an already-connected `send`. Refuses an
 * empty/observation-died capture (via `observeLive.stop` + `observedClicksToTrace`)
 * rather than minting a hollow trace.
 */
export async function recordObservedTrace(
  send: BridgeSend,
  meta: ObserveTraceMeta,
  options: {
    waitForStop: () => Promise<void>;
    outcomes?: OutcomeSpec[];
    resolveId?: ResolveTraceId;
    onNotice?: ObserveNotice;
  },
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
  // `--id` is OPTIONAL too, and it hangs off the SAME resolution: with no id given, the
  // caller's resolver names the trace after the scene that was actually resolved above.
  // Deriving it any earlier would mean either a second `scene.get_active` round trip or an
  // id that does not match what got recorded. Inert when an id was given (an explicit
  // `--id` never reaches the resolver, so its overwrite behaviour is untouched).
  if (!meta.id) {
    if (!options.resolveId) {
      throw new Error("record: no trace id was given and no id resolver was provided; pass --id <name>.");
    }
    meta = { ...meta, id: await options.resolveId(meta.scene) };
  }
  // Clean Play-Mode start at the scene: the human demonstrates from the same state
  // replay will reset to, so a mid-game recording can't drift from replay's start.
  const reset = await driver.reset({ scene: meta.scene, reset: "scene-load" });
  if (!reset.ok) {
    throw new Error(`record: reset failed (${reset.reason ?? "reset-unavailable"})`);
  }

  // THE SIZE THE HUMAN IS ABOUT TO DEMONSTRATE AT, written onto the trace (see
  // `ReplayTrace.viewport`). Read AFTER the reset, because the reset enters Play Mode and
  // the Game view is the surface every later capture is a screenshot of; read BEFORE the
  // observation starts, so the round trip is not competing with the human's own input.
  //
  // NEVER FATAL. `recordedViewport` returns null instead of throwing, and the field is
  // simply omitted: a demonstration a human performs once is not worth losing to a
  // screen-rects round trip, and the pixel gate re-derives the real sizes from the decoded
  // frames regardless. Absence is the same back-compatible state every older trace is in.
  const viewport = await driver.recordedViewport();
  if (viewport !== null) meta = { ...meta, viewport };
  else {
    options.onNotice?.(
      "note: the editor did not report a Game view size, so this trace records none. The pixel gate " +
        "still compares the real frames; only the up-front resolution note is unavailable.",
    );
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
  // The ORDER here is load-bearing for the human: observeLive announces "click the Unity window"
  // and does not return until the bridge has actually begun recording (or warned that it could
  // not), so `waitForStop` (which prints "press Enter to stop") can never be reached first.
  const session = await observeLive(
    send,
    startSignal,
    meta.autoDetectStateSignal === true,
    options.onNotice,
  ); // input.observe_start
  await options.waitForStop(); // the human plays, then signals done
  // `keyEdges` here has ALREADY had the OS window-manager modifiers (Cmd/Meta/Win) stripped, by
  // `observeLive.stop()`. That ordering is load-bearing: the transform choice below keys off
  // whether any key edge survived, so a pointer demonstration polluted by a Cmd press must reach
  // it with an EMPTY edge list and take the pointer path.
  const { clicks, keyEdges, droppedNoTarget, droppedUnfocused, droppedOsModifier } =
    await session.stop(); // observe_stop (refuses observed:false)
  // Outcomes are read while Play Mode is STILL live — captureOutcomes must run
  // before endLiveSession stops Play (runtime values are gone after the reload).
  const outcomes = await captureOutcomes(send, options.outcomes ?? []);
  // Keyboard gameplay → the timed-edge transform (concurrency + timing); a pure-click
  // session keeps the per-gesture transform (visual timeline + per-step captures).
  const trace =
    keyEdges.length > 0
      ? observedEdgesToTrace(clicks, keyEdges, meta, outcomes)
      : observedClicksToTrace(clicks, meta, outcomes);
  return { trace, droppedNoTarget, droppedUnfocused, droppedOsModifier };
}

/** Connect, record a human demonstration, and return the trace (caller persists it). */
export async function observeRecordLive(
  meta: ObserveTraceMeta,
  options: ObserveRecordOptions,
): Promise<ObserveRecordResult> {
  const client: ObserveRecordClient =
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
      resolveId: options.resolveId,
      onNotice: options.onNotice,
    });
  } finally {
    await endLiveSession(send, client);
  }
}
