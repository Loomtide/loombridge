/**
 * Replay Verification — observe-RECORD orchestration (`trace record`).
 *
 * Exercises `recordObservedTrace` over a fake `send`: the op sequence
 * (reset → observe_start → [human plays] → observe_stop → outcome reads), the
 * stop-signal ordering, the refuse-on-dead-observation guard, and the produced
 * trace (green by construction). The live connect/cleanup bootstrap is covered by
 * the live proof.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeResponse } from "../../../../shared/types.js";
import { parseTrace, type BridgeSend, type OutcomeSpec } from "../../../../capabilities/replay/index.js";
import { recordObservedTrace } from "../../../../capabilities/replay/observe-record-live.js";

type Handler = (params: Record<string, unknown>) => { data?: unknown; error?: string; code?: string };

interface Recorded {
  command: string;
  params: Record<string, unknown>;
}

function fakeBridge(handlers: Record<string, Handler> = {}): { send: BridgeSend; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const send: BridgeSend = async (command, params) => {
    calls.push({ command, params });
    const handler = handlers[command] ?? (() => ({ data: {} }));
    const result = handler(params);
    if (result.error !== undefined) {
      return resp({ status: "error", data: null, error: { code: result.code ?? "X", message: result.error } });
    }
    return resp({ status: "success", data: result.data ?? {} });
  };
  return { send, calls };
}

function resp(partial: Partial<BridgeResponse> & Pick<BridgeResponse, "status" | "data">): BridgeResponse {
  return { id: "t", timestamp: 0, ...partial };
}

const meta = { id: "demo", scene: "Assets/Scenes/Game.unity", title: "t", intent: "i" };

/** observe_stop returning the given clicks (observed:true). */
const stopWith = (clicks: unknown[]): Handler => () => ({ data: { clicks, observed: true } });

const oneClick = [{ tMs: 0, locator: { path: "/HUD/Start" }, button: 0, kind: "ui" }];

test("recordObservedTrace: reset → observe_start → observe_stop → trace (green by construction)", async () => {
  const { send, calls } = fakeBridge({ "input.observe_stop": stopWith(oneClick) });
  const { trace } = await recordObservedTrace(send, meta, { waitForStop: async () => {} });

  // The op spine: a full reset cycle (now ending with the run-in-background keepalive so the
  // player loop ticks while the bridge drives unfocused), a viewport read, then
  // observe_start, then observe_stop.
  //
  // `ui.get_screen_rects` lands BETWEEN the reset and the observation, and both sides of
  // that position are load-bearing. AFTER the reset, because the reset enters Play Mode and
  // the Game view is the surface every later capture is a screenshot of. BEFORE the
  // observation, so the round trip is not competing with the human's own input. What it
  // reads becomes `trace.viewport`, the size the demonstration was performed at.
  const commands = calls.map((c) => c.command);
  assert.deepEqual(commands, [
    "editor.stop",
    "editor.wait_for",
    "scene.open_scene",
    "editor.play",
    "editor.wait_for",
    "editor.set_run_in_background",
    "ui.get_screen_rects",
    "input.observe_start",
    "input.observe_stop",
  ]);
  assert.equal(calls.find((c) => c.command === "scene.open_scene")!.params.path, meta.scene);

  // AND A BRIDGE THAT CANNOT STATE A VIEWPORT STILL RECORDS. This fake answers every op
  // with `{}`, so the screen-rects read came back unusable: the field is simply absent, the
  // trace is otherwise unchanged, and the recording is NOT thrown away. A demonstration a
  // human performs once must never be lost to a provenance round trip.
  assert.equal(trace.viewport, undefined, "an unusable viewport is an absent field, never a refusal");

  // The trace is the parsed/validated transform of the observed click.
  assert.equal(trace.id, "demo");
  assert.equal(trace.input.backend, "ui-events");
  assert.equal(trace.segments.length, 1);
  assert.deepEqual(trace.segments[0].actions[1], { do: "tap", locator: { path: "/HUD/Start" } });
  assert.doesNotThrow(() => parseTrace(trace as unknown));
});

test("recordObservedTrace (no --scene): resolves the editor's active scene via scene.get_active and resets to it", async () => {
  const { send, calls } = fakeBridge({
    "scene.get_active": () => ({ data: { scene_name: "Home", scene_path: "Assets/Scenes/Home.unity", is_saved: true } }),
    "input.observe_stop": stopWith(oneClick),
  });
  // meta.scene is blank ⇒ the scene-agnostic resolution kicks in.
  const noScene = { id: "demo", scene: "", title: "t", intent: "i" };
  const { trace } = await recordObservedTrace(send, noScene, { waitForStop: async () => {} });

  // It asked the bridge for the active scene, then opened/reset to the RESOLVED path.
  assert.ok(calls.some((c) => c.command === "scene.get_active"), "queried the active scene");
  assert.equal(calls.find((c) => c.command === "scene.open_scene")!.params.path, "Assets/Scenes/Home.unity");
  // The trace's reset scene is the resolved asset path (so replay can re-open it).
  assert.equal(trace.start.scene, "Assets/Scenes/Home.unity");
});

test("recordObservedTrace (no --scene): an UNSAVED active scene refuses (can't verify) — never records a bare name", async () => {
  const { send, calls } = fakeBridge({
    "scene.get_active": () => ({ data: { scene_name: "Untitled", scene_path: null, is_saved: false } }),
  });
  await assert.rejects(
    recordObservedTrace(send, { id: "demo", scene: "", title: "t", intent: "i" }, { waitForStop: async () => {} }),
    /can't verify current scene|save\/open the intended entry scene/i,
  );
  // It refused BEFORE resetting/observing — no scene was opened, no observation started.
  assert.ok(!calls.some((c) => c.command === "scene.open_scene"), "no reset on refusal");
  assert.ok(!calls.some((c) => c.command === "input.observe_start"), "no observation on refusal");
});

test("recordObservedTrace (no --scene): a scene.get_active bridge error is a refusal — never records blind", async () => {
  const { send, calls } = fakeBridge({
    "scene.get_active": () => ({ error: "bridge not connected" }),
  });
  await assert.rejects(
    recordObservedTrace(send, { id: "demo", scene: "", title: "t", intent: "i" }, { waitForStop: async () => {} }),
    /can't verify current scene|bridge error/i,
  );
  assert.ok(!calls.some((c) => c.command === "scene.open_scene"), "no reset when the active scene can't be read");
});

test("recordObservedTrace (explicit --scene): never queries scene.get_active — back-compatible", async () => {
  const { send, calls } = fakeBridge({ "input.observe_stop": stopWith(oneClick) });
  await recordObservedTrace(send, meta, { waitForStop: async () => {} });
  assert.ok(!calls.some((c) => c.command === "scene.get_active"), "a valid --scene skips resolution entirely");
});

test("recordObservedTrace: surfaces the observer's dropped-inert-tap count", async () => {
  const { send } = fakeBridge({
    "input.observe_stop": () => ({ data: { clicks: oneClick, observed: true, droppedNoTarget: 2 } }),
  });
  const { trace, droppedNoTarget } = await recordObservedTrace(send, meta, { waitForStop: async () => {} });
  assert.equal(trace.segments.length, 1, "only the real tap is recorded");
  assert.equal(droppedNoTarget, 2, "the inert-tap count is reported, not silent");
});

test("recordObservedTrace: surfaces the unfocused-Game-view drop count (and 0 from an older bridge)", async () => {
  const withFocusDrops = fakeBridge({
    "input.observe_stop": () => ({
      data: { clicks: oneClick, observed: true, droppedNoTarget: 0, droppedUnfocused: 3 },
    }),
  });
  const reported = await recordObservedTrace(withFocusDrops.send, meta, { waitForStop: async () => {} });
  assert.equal(reported.trace.segments.length, 1, "only the taps the game actually received are recorded");
  assert.equal(reported.droppedUnfocused, 3, "swallowed taps are threaded to the CLI, not dropped silently");

  const olderBridge = fakeBridge({ "input.observe_stop": stopWith(oneClick) });
  const legacy = await recordObservedTrace(olderBridge.send, meta, { waitForStop: async () => {} });
  assert.equal(legacy.droppedUnfocused, 0, "a bridge without the field reports 0, never undefined");
});

test("recordObservedTrace: a session with key edges → the timed-edge transform", async () => {
  const { send } = fakeBridge({
    "input.observe_stop": () => ({
      data: {
        clicks: [],
        observed: true,
        keyEdges: [
          { key: "D", edge: "down", tMs: 0 },
          { key: "D", edge: "up", tMs: 600 },
        ],
      },
    }),
  });
  const { trace } = await recordObservedTrace(send, meta, { waitForStop: async () => {} });
  assert.equal(trace.input.backend, "input-system");
  assert.equal(trace.segments[0].id, "recorded");
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 600 },
    { do: "key-up", key: "D" },
  ]);
});

// --- OS window-manager modifier keys (Cmd / Meta / Win) -------------------------------------
//
// A real recording of a pointer-only cooking mini-game carried `key-down LeftMeta` x3,
// `key-down LeftWindows`, then the matching ups, at actions 52 to 58: the human pressed Cmd to
// bring the Game view into focus. Replaying those injects a HELD Cmd into the game, and — worse —
// their mere PRESENCE routed a pure pointer demonstration onto the merged keyboard timeline,
// costing it its per-gesture segments and per-gesture captures.
//
// LITMUS (observed, not asserted). Delete the `dropOsModifierKeyEdges(...)` call in
// `observe-live.ts` (`keyEdges: extractKeyEdges(response.data)`) and re-run this file. Both tests
// below fail on the REAL record path:
//
//   ✖ recordObservedTrace: a pointer demonstration polluted by a Cmd press takes the POINTER path
//     AssertionError [ERR_ASSERTION]: a Cmd press must not route a pointer demo onto the keyboard
//     timeline
//     'input-system' !== 'ui-events'
//   ✖ recordObservedTrace: Cmd/Meta/Win edges are dropped and COUNTED; Ctrl/Alt/Shift are kept
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//     + actual - expected
//       [
//     +   'LeftMeta',
//     +   'LeftCommand',
//     +   'LeftApple',
//     +   'leftwindows',
//         'LeftControl',
//         'LeftAlt',
//         'LeftShift',
//     +   'RightMeta',
//     +   'RightCommand',
//     +   'RightApple',
//     +   'RightWindows'
//       ]
//
//   ℹ pass 16 / ℹ fail 2

/** observe_stop returning clicks + raw key edges (observed:true). */
const stopWithKeys = (clicks: unknown[], keyEdges: unknown[]): Handler => () => ({
  data: { clicks, keyEdges, observed: true },
});

test("recordObservedTrace: a pointer demonstration polluted by a Cmd press takes the POINTER path", async () => {
  const clicks = [
    { tMs: 0, locator: { path: "/HUD/Start" }, button: 0, kind: "ui" },
    { tMs: 900, locator: { path: "/HUD/Next" }, button: 0, kind: "ui" },
  ];
  const { send } = fakeBridge({
    "input.observe_stop": stopWithKeys(clicks, [
      { key: "LeftMeta", edge: "down", tMs: 400 },
      { key: "LeftWindows", edge: "down", tMs: 402 },
      { key: "LeftMeta", edge: "up", tMs: 700 },
      { key: "LeftWindows", edge: "up", tMs: 701 },
    ]),
  });
  const { trace, droppedOsModifier } = await recordObservedTrace(send, meta, { waitForStop: async () => {} });

  // The pointer path: `ui-events`, one SEGMENT per gesture, each with its own capture.
  assert.equal(
    trace.input.backend,
    "ui-events",
    "a Cmd press must not route a pointer demo onto the keyboard timeline",
  );
  assert.deepEqual(trace.segments.map((s) => s.id), ["step-1", "step-2"]);
  assert.deepEqual(
    trace.segments.map((s) => (s.captures ?? []).map((c) => c.id)),
    [["step-1"], ["step-2"]],
    "per-gesture captures, which the merged keyboard timeline would not have produced here",
  );
  // No key action survived anywhere in the trace.
  const keyActions = trace.segments.flatMap((s) => s.actions.filter((a) => a.do.startsWith("key-")));
  assert.deepEqual(keyActions, []);
  assert.equal(droppedOsModifier, 4, "the dropped edges are counted for the CLI notice");
  assert.doesNotThrow(() => parseTrace(trace as unknown));
});

test("recordObservedTrace: Cmd/Meta/Win edges are dropped and COUNTED; Ctrl/Alt/Shift are kept", async () => {
  // Every alias `KeyCode.ToString()` can print for the shared Meta/Command/Apple enum values, both
  // sides — and the three modifiers real games bind, which must survive untouched.
  const { send } = fakeBridge({
    "input.observe_stop": stopWithKeys(
      [],
      [
        { key: "LeftMeta", edge: "down", tMs: 0 },
        { key: "LeftCommand", edge: "down", tMs: 1 },
        { key: "LeftApple", edge: "down", tMs: 2 },
        { key: "leftwindows", edge: "down", tMs: 3 }, // case-insensitive
        { key: "LeftControl", edge: "down", tMs: 4 },
        { key: "LeftAlt", edge: "down", tMs: 5 },
        { key: "LeftShift", edge: "down", tMs: 6 },
        { key: "RightMeta", edge: "down", tMs: 7 },
        { key: "RightCommand", edge: "down", tMs: 8 },
        { key: "RightApple", edge: "down", tMs: 9 },
        { key: "RightWindows", edge: "down", tMs: 10 },
      ],
    ),
  });
  const { trace, droppedOsModifier } = await recordObservedTrace(send, meta, { waitForStop: async () => {} });

  // Only the three game-bindable modifiers reach the trace (each with its balanced trailing up).
  const pressed = trace.segments[0].actions.filter((a) => a.do === "key-down").map((a) => (a as { key: string }).key);
  assert.deepEqual(pressed, ["LeftControl", "LeftAlt", "LeftShift"]);
  assert.equal(droppedOsModifier, 8);
  // With real key edges surviving, this one DOES belong on the merged keyboard timeline.
  assert.equal(trace.input.backend, "input-system");
  assert.doesNotThrow(() => parseTrace(trace as unknown));
});

test("recordObservedTrace: waitForStop is awaited BEFORE observe_stop", async () => {
  const order: string[] = [];
  const { send } = fakeBridge({
    "input.observe_stop": (p) => {
      order.push("observe_stop");
      return stopWith(oneClick)(p);
    },
  });
  await recordObservedTrace(send, meta, {
    waitForStop: async () => {
      order.push("waitForStop");
    },
  });
  assert.deepEqual(order, ["waitForStop", "observe_stop"], "the human signals done, THEN we stop observing");
});

test("recordObservedTrace: a dead observation (observed:false) is refused, not minted", async () => {
  const { send } = fakeBridge({
    "input.observe_stop": () => ({ data: { clicks: [], observed: false } }),
  });
  await assert.rejects(
    () => recordObservedTrace(send, meta, { waitForStop: async () => {} }),
    /recorder was not live/,
  );
});

test("recordObservedTrace: an empty observation is refused (no hollow trace)", async () => {
  const { send } = fakeBridge({ "input.observe_stop": stopWith([]) });
  await assert.rejects(
    () => recordObservedTrace(send, meta, { waitForStop: async () => {} }),
    /no clicks were recorded/,
  );
});

test("recordObservedTrace: outcomes are captured (after stop, while Play is live) and pinned", async () => {
  const order: string[] = [];
  const { send, calls } = fakeBridge({
    "input.observe_stop": (p) => {
      order.push("observe_stop");
      return stopWith(oneClick)(p);
    },
    "runtime.assert_condition": () => {
      order.push("assert_condition");
      return { data: { actual: "3 / 5" } };
    },
  });
  const outcomes: OutcomeSpec[] = [
    { id: "score", locator: { path: "/HUD/Score" }, component: "Text", property_path: "m_Text" },
  ];
  const { trace } = await recordObservedTrace(send, meta, { waitForStop: async () => {}, outcomes });

  // Outcome read happens AFTER observe_stop (Play Mode still live), before cleanup.
  assert.deepEqual(order, ["observe_stop", "assert_condition"]);
  assert.equal(trace.assertions?.length, 1);
  assert.equal(trace.assertions![0].id, "score");
  assert.equal(trace.assertions![0].expected, "3 / 5");
  // a displayed UI-Text outcome is gated on visibility (can't read a scene default).
  assert.equal(trace.assertions![0].reachedWhenVisible, true);
  assert.ok(calls.some((c) => c.command === "runtime.assert_condition"));
});

test("recordObservedTrace: a failed reset aborts before observing", async () => {
  const { send, calls } = fakeBridge({
    "scene.open_scene": () => ({ error: "scene not found", code: "NOT_FOUND" }),
  });
  await assert.rejects(() => recordObservedTrace(send, meta, { waitForStop: async () => {} }), /reset failed/);
  assert.equal(calls.some((c) => c.command === "input.observe_start"), false, "never started observing");
});

// --- Phase 2 / D1-B: auto-detect flag + per-gesture signal spec from the bridge ---------------------

test("recordObservedTrace (--auto-state-signal): passes autoDetectStateSignal to observe_start", async () => {
  const { send, calls } = fakeBridge({ "input.observe_stop": stopWith(oneClick) });
  const autoMeta = { ...meta, autoDetectStateSignal: true };
  await recordObservedTrace(send, autoMeta, { waitForStop: async () => {} });
  const start = calls.find((c) => c.command === "input.observe_start")!;
  assert.equal(start.params.autoDetectStateSignal, true);
  // Auto-detect mode does not also send a declared stateSignal (the two modes are exclusive).
  assert.equal("stateSignal" in start.params, false);
});

test("recordObservedTrace (no auto-detect): observe_start carries no autoDetectStateSignal (back-compat)", async () => {
  const { send, calls } = fakeBridge({ "input.observe_stop": stopWith(oneClick) });
  await recordObservedTrace(send, meta, { waitForStop: async () => {} });
  const start = calls.find((c) => c.command === "input.observe_start")!;
  assert.equal("autoDetectStateSignal" in start.params, false);
});

test("recordObservedTrace: a bridge-supplied per-gesture stateSignalSpec becomes that gesture's gate", async () => {
  // The observer (auto-detect) attaches the scene's detected spec + sampled value per click; the
  // transform must bake them into a wait-for-condition gate (slice 2a consumes click.stateSignalSpec).
  const click = {
    tMs: 0,
    locator: { path: "/Canvas/Bowl", scene: "StarChef" },
    button: 0,
    kind: "ui",
    stateSignal: "Mix",
    stateSignalSpec: { locator: { path: "/Canvas/GM" }, component: "ChefGameManager", property: "phase" },
  };
  const { send } = fakeBridge({ "input.observe_stop": stopWith([click]) });
  const { trace } = await recordObservedTrace(send, { ...meta, autoDetectStateSignal: true }, { waitForStop: async () => {} });
  const gate = trace.segments[0].actions.find((a) => a.do === "wait-for-condition");
  assert.ok(gate, "the per-gesture spec produced a gate");
  assert.equal(gate && gate.do === "wait-for-condition" && gate.component, "ChefGameManager");
  assert.equal(gate && gate.do === "wait-for-condition" && gate.expected, "Mix");
});
