import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BridgeResponse } from "../../../shared/types.js";
import {
  UnityDriver,
  type BridgeSend,
  type Action,
  type Anchor,
  type Assertion,
} from "../../../capabilities/replay/index.js";

// ───────────────────────── fake bridge ─────────────────────────

type Handler = (params: Record<string, unknown>) => { data?: unknown; error?: string; code?: string };

interface Recorded {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

/** A recording fake `send`: returns canned data per command, records every call. */
function fakeBridge(handlers: Record<string, Handler> = {}): {
  send: BridgeSend;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const send: BridgeSend = async (command, params, timeoutMs) => {
    calls.push({ command, params, timeoutMs });
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

const driverOpts = { captureDir: ".loombridge/replays/test/actual", pollIntervalMs: 1 };
const tap = (path: string): Action => ({ do: "tap", locator: { path } });
const lastCall = (calls: Recorded[], command: string): Recorded | undefined =>
  [...calls].reverse().find((c) => c.command === command);

// ───────────────────────── capability ─────────────────────────

test("UnityDriver.capabilityCheck: ui-events supported, others blocked", async () => {
  const driver = new UnityDriver(fakeBridge().send, driverOpts);
  assert.deepEqual(await driver.capabilityCheck("ui-events"), { supported: true });
  assert.deepEqual(await driver.capabilityCheck("unity-input-system"), {
    supported: false,
    reason: "unsupported-input-backend",
  });
});

// ───────────────────────── reset ─────────────────────────

test("UnityDriver.reset: scene-load issues stop→open_scene→play→wait_for→set_run_in_background", async () => {
  const { send, calls } = fakeBridge({
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.wait_for": () => ({ data: { waited_ms: 5 } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.reset({ scene: "Assets/Scenes/Game.unity", reset: "scene-load" });

  assert.deepEqual(result, { ok: true, tier: "scene-load" });
  // The trailing set_run_in_background keeps the player loop ticking while the bridge drives
  // from the background (else MonoBehaviour.Update/coroutines freeze and game-code navigation
  // stalls); it runs AFTER play is confirmed so the runtime property sticks.
  assert.deepEqual(
    calls.map((c) => c.command),
    ["editor.stop", "editor.wait_for", "scene.open_scene", "editor.play", "editor.wait_for", "editor.set_run_in_background"],
  );
  assert.equal(lastCall(calls, "editor.set_run_in_background")!.params.enabled, true);
  const open = lastCall(calls, "scene.open_scene")!;
  assert.equal(open.params.path, "Assets/Scenes/Game.unity");
  assert.equal(open.params.mode, "Single");
  // open_scene must come after a wait for edit mode (it cannot run in Play Mode).
  const waits = calls.filter((c) => c.command === "editor.wait_for");
  assert.equal(waits[0].params.playMode, "stopped");
  assert.equal(waits[1].params.playMode, "playing");
});

test("UnityDriver.reset: a failing scene load → reset-unavailable", async () => {
  const { send } = fakeBridge({
    "scene.open_scene": () => ({ error: "scene not found" }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.reset({ scene: "Missing", reset: "scene-load" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reset-unavailable");
  // A blocked reset must say WHICH step failed — the bare enum sent users to a dead end.
  assert.ok(
    typeof result.detail === "string" && result.detail.length > 0,
    "a failed reset must carry a diagnostic detail",
  );
});

test("UnityDriver.reset: relaunch runs the full cycle and reports tier relaunch", async () => {
  const { send, calls } = fakeBridge({ "editor.wait_for": () => ({ data: {} }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({ scene: "Assets/Scenes/Game.unity", reset: "relaunch" });
  assert.deepEqual(result, { ok: true, tier: "relaunch" });
  assert.deepEqual(
    calls.map((c) => c.command),
    ["editor.stop", "editor.wait_for", "scene.open_scene", "editor.play", "editor.wait_for", "editor.set_run_in_background"],
  );
});

const visibleRects = { "ui.get_screen_rects": () => ({ data: { objects: [{ isVisible: true }] } }) };

test("UnityDriver.reset: a tap hook waits for its target, actuates, reports tier hook", async () => {
  const { send, calls } = fakeBridge({
    ...visibleRects,
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: { hook: { do: "tap", locator: { path: "/Replay" } } },
  });
  assert.deepEqual(result, { ok: true, tier: "hook" });
  const tap = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(tap.params.action, "click");
  assert.deepEqual(tap.params.locator, { path: "/Replay" });
});

test("UnityDriver.reset: a tap hook that does not actuate → reset-unavailable", async () => {
  const { send } = fakeBridge({ ...visibleRects, "ui.dispatch_pointer": () => ({ data: { actuated: false } }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: { hook: { do: "tap", locator: { path: "/Gone" } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reset-unavailable");
  // A blocked reset must say WHICH step failed — the bare enum sent users to a dead end.
  assert.ok(
    typeof result.detail === "string" && result.detail.length > 0,
    "a failed reset must carry a diagnostic detail",
  );
});

test("UnityDriver.reset: a tap hook target that never appears → reset-unavailable", async () => {
  const { send } = fakeBridge({
    "ui.get_screen_rects": () => ({ data: { objects: [{ isVisible: false, visibilityReason: "inactive" }] } }),
  });
  const driver = new UnityDriver(send, { ...driverOpts, defaultAnchorTimeoutMs: 0 });
  const result = await driver.reset({
    scene: "S",
    reset: { hook: { do: "tap", locator: { path: "/NeverShows" } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reset-unavailable");
  // A blocked reset must say WHICH step failed — the bare enum sent users to a dead end.
  assert.ok(
    typeof result.detail === "string" && result.detail.length > 0,
    "a failed reset must carry a diagnostic detail",
  );
});

test("UnityDriver.reset: a hook verify that isn't reached → reset-unavailable (no silent green)", async () => {
  const { send } = fakeBridge({
    "component.set_property": () => ({ data: {} }),
    "ui.get_screen_rects": () => ({ data: { objects: [{ isVisible: false, visibilityReason: "inactive" }] } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: {
      hook: {
        do: "set",
        locator: { path: "/GM" },
        component: "GameManager",
        property: "resetNow",
        verify: { locator: { path: "/HUD/StartScreen" }, timeoutMs: 0 },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reset-unavailable");
  // A blocked reset must say WHICH step failed — the bare enum sent users to a dead end.
  assert.ok(
    typeof result.detail === "string" && result.detail.length > 0,
    "a failed reset must carry a diagnostic detail",
  );
});

test("UnityDriver.reset: a hook verify that IS reached → ok, tier hook", async () => {
  const { send } = fakeBridge({ "component.set_property": () => ({ data: {} }), ...visibleRects });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: {
      hook: {
        do: "set",
        locator: { path: "/GM" },
        component: "GameManager",
        property: "resetNow",
        verify: { locator: { path: "/HUD/StartScreen" } },
      },
    },
  });
  assert.deepEqual(result, { ok: true, tier: "hook" });
});

test("UnityDriver.reset: a set hook calls component.set_property (value defaults true)", async () => {
  const { send, calls } = fakeBridge({ "component.set_property": () => ({ data: {} }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: { hook: { do: "set", locator: { path: "/GM" }, component: "GameManager", property: "resetNow" } },
  });
  assert.deepEqual(result, { ok: true, tier: "hook" });
  const set = lastCall(calls, "component.set_property")!;
  assert.equal(set.params.type_name, "GameManager");
  assert.equal(set.params.property_path, "resetNow");
  assert.equal(set.params.value, true);
});

test("UnityDriver.reset: a set hook passes a falsy value through (?? not ||)", async () => {
  const { send, calls } = fakeBridge({ "component.set_property": () => ({ data: {} }) });
  const driver = new UnityDriver(send, driverOpts);
  await driver.reset({
    scene: "S",
    reset: { hook: { do: "set", locator: { path: "/GM" }, component: "C", property: "p", value: false } },
  });
  assert.equal(lastCall(calls, "component.set_property")!.params.value, false);
});

test("UnityDriver.reset: a hook op error → reset-unavailable", async () => {
  const { send } = fakeBridge({ "component.set_property": () => ({ error: "NOT_FOUND: locator" }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.reset({
    scene: "S",
    reset: { hook: { do: "set", locator: { path: "/X" }, component: "C", property: "p" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reset-unavailable");
  // A blocked reset must say WHICH step failed — the bare enum sent users to a dead end.
  assert.ok(
    typeof result.detail === "string" && result.detail.length > 0,
    "a failed reset must carry a diagnostic detail",
  );
});

test("UnityDriver.reset: a transport failure rethrows (not dressed up as reset-unavailable)", async () => {
  const { send } = fakeBridge({
    "scene.open_scene": () => ({ error: "CONNECTION_LOST: socket closed" }),
  });
  const driver = new UnityDriver(send, driverOpts);

  await assert.rejects(
    () => driver.reset({ scene: "X", reset: "scene-load" }),
    /CONNECTION_LOST/,
  );
});

// ───────────────────────── dispatch ─────────────────────────

test("UnityDriver.dispatch tap: actuated → ok; maps to click", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  // `raw` carries the verbatim actuation evidence (additive; consumed by minigame capture).
  const tapResult = await driver.dispatch(tap("/Canvas/Start"));
  assert.equal(tapResult.ok, true);
  assert.equal(tapResult.raw?.actuated, true);
  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.action, "click");
  assert.deepEqual(call.params.locator, { path: "/Canvas/Start" });
});

test("UnityDriver.dispatch tap: extracts handlerTarget.path from the bridge's locator OBJECT + raycastHit bool", async () => {
  // The bridge returns handlerTarget as a locator object {scene,path,...} (the object whose
  // handler fired — a parent Button when a Label is tapped) and raycastHit as a boolean.
  // The driver must extract the path (not drop the object) so flow.json can corroborate.
  const { send } = fakeBridge({
    "ui.dispatch_pointer": () => ({
      data: {
        actuated: true,
        handlerTarget: { scene: "Demo", path: "/HUD/StartButton", instanceId: 42, globalObjectId: "g" },
        raycastHit: true,
        handlersFired: ["pointerDown", "pointerUp", "pointerClick"],
      },
    }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const r = await driver.dispatch(tap("/HUD/StartButton/Label"));
  assert.equal(r.ok, true);
  assert.equal(r.raw?.handlerTarget, "/HUD/StartButton", "handlerTarget.path is extracted, not dropped");
  assert.equal(r.raw?.raycastHit, true);
});

/**
 * S5: a world tap OPENS THE INPUT SESSION first. The session's backend applies the
 * focus-independent InputSystem overrides (and owns restoring them), which is what lets the
 * simulated pointer reach an unfocused Game View at all. Every world-tap fixture therefore
 * has to answer begin_session, exactly as the keyboard fixtures already did.
 */
const inputSession = {
  "input.begin_session": () => ({ data: { backend: "InputSystem", sessionId: "s-1", created: true } }),
};

const worldRect = (over: Record<string, unknown> = {}) => ({
  ...inputSession,
  "scene.get_screen_rects": () => ({
    data: { objects: [{ screenRect: { x: 100, y: 200, width: 40, height: 40 }, isOffScreen: false, ...over }] },
  }),
});

test("UnityDriver.dispatch world-tap: resolves the screen center → input.pointer_tap → ok", async () => {
  const { send, calls } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({ data: { dispatched: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruits/Apple" } });
  assert.deepEqual(result, { ok: true });
  const tap = lastCall(calls, "input.pointer_tap")!;
  assert.equal(tap.params.x, 120, "x = rect.x + width/2");
  assert.equal(tap.params.y, 220, "y = rect.y + height/2");
});

test("UnityDriver.dispatch world-tap: no screen bounds → fail (not blocked)", async () => {
  const { send } = fakeBridge({
    ...inputSession,
    "scene.get_screen_rects": () => ({ data: { objects: [{ screenRect: null }] } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Gone" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, undefined, "a missing target is a real failure, not a capability block");
});

test("UnityDriver.dispatch world-tap: off-screen → fail", async () => {
  const { send } = fakeBridge({ ...worldRect({ isOffScreen: true }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, undefined);
});

test("UnityDriver.dispatch world-tap: pointer unavailable → blocked (honest degradation)", async () => {
  const { send } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({
      error: "Simulated pointer unavailable — the Input System is not enabled (needs ENABLE_INPUT_SYSTEM).",
    }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
});

test("UnityDriver.dispatch world-tap: blocked keyed on the CODE even if the message is reworded", async () => {
  const { send } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({ error: "some totally different wording", code: "INPUT_BACKEND_UNAVAILABLE" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.blocked, true, "the stable code, not the prose, decides blocked");
});

// S5: FOCUS_REQUIRED is a HARNESS condition, not a game divergence. It used to map to a
// plain action failure, which reported "the game did not respond to a tap" when what really
// happened is that the Game View lost focus and the bridge honestly refused to pretend the
// tap landed. It is now BLOCKED with its own reason.
test("UnityDriver.dispatch world-tap: FOCUS_REQUIRED → blocked with reason focus-lost", async () => {
  const { send } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({ error: "input.pointer_tap needs Game-View focus", code: "FOCUS_REQUIRED" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.blockedReason, "focus-lost");
  assert.match(result.detail ?? "", /Game-View focus/);
});

test("UnityDriver.dispatch world-tap: a genuine op error is still a FAILURE, not blocked", async () => {
  const { send } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({ error: "NOT_FOUND: camera missing", code: "NOT_FOUND" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, undefined, "only a focus loss or a missing capability blocks");
});

test("UnityDriver.dispatch world-tap: the input SESSION is opened BEFORE the tap (S5)", async () => {
  const { send, calls } = fakeBridge({
    ...worldRect(),
    "input.pointer_tap": () => ({ data: { dispatched: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, true);
  const order = calls.map((c) => c.command);
  const sessionAt = order.indexOf("input.begin_session");
  const tapAt = order.indexOf("input.pointer_tap");
  assert.ok(sessionAt >= 0, "a world tap must open an input session");
  assert.ok(sessionAt < tapAt, `session must precede the tap (got ${order.join(", ")})`);
  assert.equal(lastCall(calls, "input.begin_session")!.params.backend, "InputSystem");
});

test("UnityDriver.dispatch world-tap: a legacy-only project blocks at the SESSION, and never taps", async () => {
  const { send, calls } = fakeBridge({
    ...worldRect(),
    "input.begin_session": () => ({
      error: "Input System backend requested but Unity Input System is not installed.",
      code: "INPUT_SYSTEM_NOT_INSTALLED",
    }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true, "a missing Input System is a capability gap, not a game defect");
  assert.equal(lastCall(calls, "input.pointer_tap"), undefined, "never tap through a session that failed to open");
});

test("UnityDriver.dispatch world-tap: pointer_tap not dispatched → fail (no silent success)", async () => {
  const { send } = fakeBridge({ ...worldRect(), "input.pointer_tap": () => ({ data: { dispatched: false } }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, undefined);
});

test("UnityDriver.dispatch world-tap: a degenerate (0-size) rect → fail, never taps", async () => {
  const { send, calls } = fakeBridge({ ...worldRect({ screenRect: { x: 5, y: 5, width: 0, height: 0 } }) });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Fruit" } });
  assert.equal(result.ok, false);
  assert.equal(lastCall(calls, "input.pointer_tap"), undefined, "must not tap a garbage point");
});

test("UnityDriver.dispatch world-tap: falls back to renderer bounds when there's no collider", async () => {
  const { send } = fakeBridge({
    ...inputSession,
    "scene.get_screen_rects": (params) =>
      params.boundsMode === "renderer"
        ? { data: { objects: [{ screenRect: { x: 10, y: 10, width: 20, height: 20 }, isOffScreen: false }] } }
        : { data: { objects: [{ screenRect: null }] } },
    "input.pointer_tap": () => ({ data: { dispatched: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "world-tap", locator: { path: "/Sprite" } });
  assert.deepEqual(result, { ok: true });
});

test("UnityDriver.dispatch tap: not actuated → ok:false (no silent success)", async () => {
  const { send } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: false, raycastHit: false } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch(tap("/Canvas/Ghost"));
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /not actuated/);
});

test("UnityDriver.dispatch: op-level error (renamed/removed element) → ok:false, not a throw", async () => {
  const { send } = fakeBridge({
    "ui.dispatch_pointer": () => ({ error: "NOT_FOUND: locator '/HUD/StartScreen/StartButtonGONE'" }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch(tap("/HUD/StartScreen/StartButtonGONE"));
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /NOT_FOUND/);
});

test("UnityDriver.dispatch: transport error rethrows (harness failure, not a divergence)", async () => {
  const { send } = fakeBridge({
    "ui.dispatch_pointer": () => ({ error: "CONNECTION_LOST: socket closed" }),
  });
  const driver = new UnityDriver(send, driverOpts);

  await assert.rejects(() => driver.dispatch(tap("/Canvas/Start")), /CONNECTION_LOST/);
});

test("UnityDriver.dispatch drag: maps from→locator, to→to_locator", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const drag: Action = { do: "drag", from: { path: "/Apple" }, to: { path: "/Basket" } };
  await driver.dispatch(drag);

  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.action, "drag");
  assert.deepEqual(call.params.locator, { path: "/Apple" });
  assert.deepEqual(call.params.to_locator, { path: "/Basket" });
  assert.equal(Object.prototype.hasOwnProperty.call(call.params, "travelPx"), false);
});

test("UnityDriver.dispatch drag: includes travelPx when supplied", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const drag: Action = {
    do: "drag",
    from: { path: "/Canvas/MixZone" },
    to: { path: "/Canvas/MixZone" },
    travelPx: 2600,
  };
  await driver.dispatch(drag);

  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.action, "drag");
  assert.deepEqual(call.params.locator, { path: "/Canvas/MixZone" });
  assert.deepEqual(call.params.to_locator, { path: "/Canvas/MixZone" });
  assert.equal(call.params.travelPx, 2600);
});

test("UnityDriver.dispatch drag with releaseNorm: denormalizes to to_x/to_y, drops to_locator", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
    // Live viewport the driver denormalizes against (fetched once, cached per drive).
    "ui.get_screen_rects": () => ({ data: { viewport: { width: 1920, height: 1080, aspect: 1920 / 1080 } } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const drag: Action = {
    do: "drag",
    from: { path: "/Canvas/Bowl" },
    to: { path: "/Canvas/Bowl" },
    travelPx: 4800,
    releaseNorm: { x: 0.5, y: 0.25 },
  };
  const result = await driver.dispatch(drag);
  assert.equal(result.ok, true);

  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.action, "drag");
  assert.deepEqual(call.params.locator, { path: "/Canvas/Bowl" });
  assert.equal(call.params.to_x, 0.5 * 1920, "to_x = releaseNorm.x * viewport.width");
  assert.equal(call.params.to_y, 0.25 * 1080, "to_y = releaseNorm.y * viewport.height");
  assert.equal(call.params.travelPx, 4800, "travelPx still rides along");
  assert.equal(Object.prototype.hasOwnProperty.call(call.params, "to_locator"), false, "no to_locator with a release point");
});

test("UnityDriver.dispatch drag with releaseNorm: caches the viewport (one get_screen_rects across many drags)", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
    "ui.get_screen_rects": () => ({ data: { viewport: { width: 800, height: 600 } } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/A" }, to: { path: "/A" }, releaseNorm: { x: 0.25, y: 0.5 } };
  await driver.dispatch(drag);
  await driver.dispatch(drag);
  const fetches = calls.filter((c) => c.command === "ui.get_screen_rects");
  assert.equal(fetches.length, 1, "viewport fetched once, then cached");
});

test("UnityDriver.reset invalidates the cached viewport (multi-aspect capture re-drives at new sizes)", async () => {
  // Multi-aspect capture REUSES one driver across devices: set_game_view_size → reset() →
  // drive, per device. The cached viewport must NOT survive a reset, or non-base devices
  // would denormalize releaseNorm against the base device's size and release at the wrong point.
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
    "ui.get_screen_rects": () => ({ data: { viewport: { width: 800, height: 600 } } }),
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.wait_for": () => ({ data: { waited_ms: 5 } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/A" }, to: { path: "/A" }, releaseNorm: { x: 0.25, y: 0.5 } };
  await driver.dispatch(drag);
  await driver.reset({ scene: "Assets/Scenes/Game.unity", reset: "scene-load" });
  await driver.dispatch(drag);
  const fetches = calls.filter((c) => c.command === "ui.get_screen_rects");
  assert.equal(fetches.length, 2, "viewport re-fetched after reset (cache invalidated per device drive)");
});

test("UnityDriver.dispatch drag WITHOUT releaseNorm: byte-identical to legacy (to_locator, no viewport fetch)", async () => {
  // Regression guard: a plain drag must dispatch EXACTLY as before — no to_x/to_y, no
  // ui.get_screen_rects call, params equal to the legacy { action, locator, to_locator }.
  const { send, calls } = fakeBridge({ "ui.dispatch_pointer": () => ({ data: { actuated: true } }) });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/Apple" }, to: { path: "/Basket" } };
  await driver.dispatch(drag);

  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.deepEqual(call.params, { action: "drag", locator: { path: "/Apple" }, to_locator: { path: "/Basket" } });
  assert.equal(calls.some((c) => c.command === "ui.get_screen_rects"), false, "no viewport fetch for a plain drag");
});

test("UnityDriver.dispatch drag rescales travelPx by deviceHeight/travelRefHeight (multi-aspect re-drive)", async () => {
  // travelPx is absolute screen px recorded at travelRefHeight; on a taller device the
  // same px under-shoots the on-canvas stir, so replay must scale it by deviceHeight/refHeight.
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
    "ui.get_screen_rects": () => ({ data: { viewport: { width: 2358, height: 1080 } } }), // a taller device
  });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/MixZone" }, to: { path: "/MixZone" }, travelPx: 3299, travelRefHeight: 720 };
  await driver.dispatch(drag);
  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.travelPx, 3299 * (1080 / 720), "travelPx scaled by deviceHeight/refHeight (=1.5×)");
});

test("UnityDriver.dispatch drag with travelPx but NO travelRefHeight: raw travel, no viewport fetch (legacy)", async () => {
  const { send, calls } = fakeBridge({ "ui.dispatch_pointer": () => ({ data: { actuated: true } }) });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/A" }, to: { path: "/B" }, travelPx: 1000 };
  await driver.dispatch(drag);
  const call = lastCall(calls, "ui.dispatch_pointer")!;
  assert.equal(call.params.travelPx, 1000, "raw travelPx when no refHeight");
  assert.equal(calls.some((c) => c.command === "ui.get_screen_rects"), false, "no viewport fetch without refHeight or releaseNorm");
});

test("UnityDriver.dispatch drag with releaseNorm: a viewport-fetch error → clean action failure (no silent (0,0))", async () => {
  const { send, calls } = fakeBridge({
    "ui.dispatch_pointer": () => ({ data: { actuated: true } }),
    "ui.get_screen_rects": () => ({ error: "NOT_READY: no viewport" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const drag: Action = { do: "drag", from: { path: "/A" }, to: { path: "/A" }, releaseNorm: { x: 0.5, y: 0.5 } };
  const result = await driver.dispatch(drag);
  assert.equal(result.ok, false);
  assert.equal(lastCall(calls, "ui.dispatch_pointer"), undefined, "never dispatches at a bogus (0,0) point");
});

test("UnityDriver.dispatch wait-for-visible: visible → ok; hidden+timeout → ok:false", async () => {
  const visible = new UnityDriver(
    fakeBridge({
      "ui.get_screen_rects": () => ({ data: { objects: [{ isVisible: true }] } }),
    }).send,
    driverOpts,
  );
  assert.deepEqual(
    await visible.dispatch({ do: "wait-for-visible", locator: { path: "/Modal" }, timeoutMs: 0 }),
    { ok: true },
  );

  const hidden = new UnityDriver(
    fakeBridge({
      "ui.get_screen_rects": () => ({
        data: { objects: [{ isVisible: false, visibilityReason: "off-screen" }] },
      }),
    }).send,
    driverOpts,
  );
  const result = await hidden.dispatch({ do: "wait-for-visible", locator: { path: "/Modal" }, timeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /off-screen/);
});

test("UnityDriver.dispatch wait-for-condition: maps to wait_for_condition (conditionParams + playing); passed → ok", async () => {
  const { send, calls } = fakeBridge({
    "runtime.wait_for_condition": () => ({ data: { passed: true, actual: "Pour" } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const action: Action = {
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    component: "ChefGameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
    timeoutMs: 2500,
  };
  assert.deepEqual(await driver.dispatch(action), { ok: true });
  const call = lastCall(calls, "runtime.wait_for_condition")!;
  assert.equal(call.params.property_path, "phase");
  assert.equal(call.params.component, "ChefGameManager");
  assert.equal(call.params.operator, "equals");
  assert.equal(call.params.expected, "Pour");
  assert.equal(call.params.playMode, "playing");
  assert.equal(call.params.timeoutMs, 2500);
  // op timeout = trace timeout + 5000 (mirrors the condition-anchor branch).
  assert.equal(call.timeoutMs, 7500);
});

test("UnityDriver.dispatch wait-for-condition: not passed → ok:false with the actual detail", async () => {
  const { send } = fakeBridge({
    "runtime.wait_for_condition": () => ({ data: { passed: false, actual: "Stir" } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
  });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /Stir/);
});

test("UnityDriver.dispatch wait-for-condition: op error → ok:false (clean fail, not blocked)", async () => {
  const { send } = fakeBridge({
    "runtime.wait_for_condition": () => ({ error: "component not found" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
  });
  assert.equal(result.ok, false);
  assert.equal((result as { blocked?: boolean }).blocked, undefined);
  assert.match(result.detail ?? "", /component not found/);
});

// ───────────────────────── anchors ─────────────────────────

test("UnityDriver.waitForAnchor ui-visible: reached when isVisible", async () => {
  const { send } = fakeBridge({
    "ui.get_screen_rects": () => ({ data: { objects: [{ isVisible: true }] } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const anchor: Anchor = { id: "a1", kind: "ui-visible", locator: { path: "/Reward" }, timeoutMs: 0 };
  assert.deepEqual(await driver.waitForAnchor(anchor), { reached: true });
});

test("UnityDriver.waitForAnchor ui-visible: surfaces the bridge per-object error as the reason", async () => {
  const { send } = fakeBridge({
    "ui.get_screen_rects": () => ({ data: { objects: [{ error: "Could not resolve locator" }] } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const anchor: Anchor = { id: "a", kind: "ui-visible", locator: { path: "/Gone" }, timeoutMs: 0 };
  const result = await driver.waitForAnchor(anchor);
  assert.equal(result.reached, false);
  assert.match(result.actual ?? "", /Could not resolve locator/);
});

test("UnityDriver.waitForAnchor condition: maps to wait_for_condition + passed", async () => {
  const { send, calls } = fakeBridge({
    "runtime.wait_for_condition": () => ({ data: { passed: true, actual: 5 } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const anchor: Anchor = {
    id: "a2",
    kind: "condition",
    locator: { path: "/GameManager" },
    component: "GameManager",
    property_path: "score",
    operator: "greater_than",
    expected: 0,
  };
  assert.deepEqual(await driver.waitForAnchor(anchor), { reached: true });
  const call = lastCall(calls, "runtime.wait_for_condition")!;
  assert.equal(call.params.property_path, "score");
  assert.equal(call.params.operator, "greater_than");
  assert.equal(call.params.playMode, "playing");
});

test("UnityDriver.confirmReached: parses contract locator and maps to wait_for_condition", async () => {
  const { send, calls } = fakeBridge({
    "runtime.wait_for_condition": () => ({ data: { passed: false, actual: "Stir" } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.confirmReached(
    {
      locator: "StarChef:/Canvas/ChefGameManager",
      component: "ChefGameManager",
      property_path: "phase",
      operator: "equals",
      expected: "Decorate",
      tolerance: 0.01,
    },
    2500,
  );

  assert.deepEqual(result, { reached: false, actual: "Stir" });
  const call = lastCall(calls, "runtime.wait_for_condition")!;
  assert.deepEqual(call.params.locator, { scene: "StarChef", path: "/Canvas/ChefGameManager" });
  assert.equal(call.params.component, "ChefGameManager");
  assert.equal(call.params.property_path, "phase");
  assert.equal(call.params.operator, "equals");
  assert.equal(call.params.expected, "Decorate");
  assert.equal(call.params.tolerance, 0.01);
  assert.equal(call.params.playMode, "playing");
  assert.equal(call.params.timeoutMs, 2500);
});

// ───────────────────────── capture / assert / console ─────────────────────────

test("UnityDriver.capture: decodes image_base64, writes the PNG, returns real sha256", async () => {
  const png = Buffer.from("fake-png-bytes\x00\x01\x02");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-cap-"));
  try {
    const { send, calls } = fakeBridge({
      "editor.screenshot": () => ({ data: { image_base64: png.toString("base64"), format: "png" } }),
    });
    const driver = new UnityDriver(send, { ...driverOpts, captureDir: tmpDir });

    const outcome = await driver.capture("first-gap");
    const expectedPath = path.join(tmpDir, "first-gap.png");
    assert.equal(outcome.artifact, expectedPath);
    assert.equal(outcome.sha256, createHash("sha256").update(png).digest("hex"));
    assert.deepEqual(await fs.readFile(expectedPath), png, "the actual PNG bytes are written");

    const call = lastCall(calls, "editor.screenshot")!;
    assert.equal(call.params.view, "game");
    assert.equal(call.params.format, "png");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("UnityDriver.capture: no image returned → no artifact (no phantom path)", async () => {
  const { send } = fakeBridge({ "editor.screenshot": () => ({ data: { width: 1 } }) });
  const driver = new UnityDriver(send, driverOpts);
  assert.deepEqual(await driver.capture("x"), {});
});

test("UnityDriver.evaluateAssertion: passed → pass; carries actual", async () => {
  const { send, calls } = fakeBridge({
    "runtime.assert_condition": () => ({ data: { passed: true, actual: true } }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const assertion: Assertion = {
    id: "win",
    locator: { path: "/GM" },
    component: "GameManager",
    property_path: "isWin",
    operator: "equals",
    expected: true,
  };
  assert.deepEqual(await driver.evaluateAssertion(assertion), { pass: true, actual: "true" });
  assert.equal(lastCall(calls, "runtime.assert_condition")!.params.property_path, "isWin");
});

test("UnityDriver.readConsole: counts lowercase 'error' (the bridge's real contract), ignores log/warning", async () => {
  // The bridge collapses LogType.Error/Exception/Assert → "error" (lowercase).
  // This fixture matches that contract so the test is not vacuous.
  const { send } = fakeBridge({
    "editor.console_logs": () => ({
      data: {
        logs: [
          { type: "log", message: "init" },
          { type: "error", message: "boom" },
          { type: "warning", message: "deprecated" },
          { type: "error", message: "kaboom" },
        ],
      },
    }),
  });
  const driver = new UnityDriver(send, driverOpts);
  assert.deepEqual(await driver.readConsole(), {
    errorCount: 2,
    errors: ["boom", "kaboom"],
  });
});
