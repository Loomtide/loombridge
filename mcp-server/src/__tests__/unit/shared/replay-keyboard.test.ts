/**
 * Replay Verification — simulated keyboard GAMEPLAY input (#1b).
 *
 * Covers the three replay layers the slice adds: the trace `Action`s
 * (`key-tap`/`key-hold`) through the parser, the engine's blocked-reason +
 * teardown handling, and the live driver's input-session lifecycle (open lazily
 * on the InputSystem backend, drive keys, close in teardown; blocked-degrade a
 * legacy-only project). The fixture/live proof is separate.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeResponse } from "../../../shared/types.js";
import {
  parseTrace,
  replay,
  UnityDriver,
  type Action,
  type BridgeSend,
  type ReplayDriver,
  type ReplayTrace,
} from "../../../capabilities/replay/index.js";

// ───────────────────────── parse ─────────────────────────

/** A minimal valid trace whose single segment carries the given actions. */
function traceWith(
  actions: unknown[],
  backend: "ui-events" | "input-system" = "input-system",
): unknown {
  return {
    schemaVersion: "0.1",
    id: "kbd",
    start: { scene: "Assets/Scenes/Move.unity", reset: "scene-load" },
    input: { backend },
    segments: [{ id: "s1", actions }],
    outcome: { expected: "success" },
  };
}

test("parse: key-tap and key-hold actions round-trip", () => {
  const trace = parseTrace(
    traceWith([
      { do: "key-tap", key: "Space" },
      { do: "key-hold", key: "D", durationMs: 800 },
    ]),
  );
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-tap", key: "Space" },
    { do: "key-hold", key: "D", durationMs: 800 },
  ]);
});

test("parse: input.backend input-system is accepted; an unknown backend is refused", () => {
  assert.doesNotThrow(() => parseTrace(traceWith([{ do: "key-tap", key: "A" }], "input-system")));
  assert.throws(
    () => parseTrace(traceWith([{ do: "key-tap", key: "A" }], "joystick" as never)),
    /input\.backend must be "ui-events" or "input-system"/,
  );
});

test("parse: key-hold clamps an over-long duration to the 10s cap", () => {
  const trace = parseTrace(traceWith([{ do: "key-hold", key: "D", durationMs: 999_999 }]));
  const action = trace.segments[0].actions[0] as Extract<Action, { do: "key-hold" }>;
  assert.equal(action.durationMs, 10_000);
});

test("parse: key-hold refuses a missing / non-positive / NaN duration", () => {
  for (const bad of [undefined, 0, -50, Number.NaN, "800"]) {
    assert.throws(
      () => parseTrace(traceWith([{ do: "key-hold", key: "D", durationMs: bad }])),
      /durationMs must be a positive number/,
      `durationMs=${String(bad)} should be refused`,
    );
  }
});

test("parse: a keyboard action with an empty/missing key is refused", () => {
  assert.throws(() => parseTrace(traceWith([{ do: "key-tap", key: "" }])), /key must be a non-empty string/);
  assert.throws(() => parseTrace(traceWith([{ do: "key-hold", durationMs: 100 }])), /key must be a non-empty string/);
});

// ───────────────────────── engine ─────────────────────────

/** A driver that passes everything, records whether teardown ran, and can fail/block a key. */
function fakeDriver(opts: { failKey?: string; blockKey?: string } = {}): ReplayDriver & {
  teardownCalls: number;
} {
  const state = { teardownCalls: 0 };
  const driver: ReplayDriver & { teardownCalls: number } = {
    get teardownCalls() {
      return state.teardownCalls;
    },
    async capabilityCheck() {
      return { supported: true };
    },
    async reset() {
      return { ok: true, tier: "scene-load" };
    },
    async dispatch(action: Action) {
      if (action.do === "key-tap" || action.do === "key-hold") {
        if (opts.blockKey === action.key) return { ok: false, blocked: true, detail: "no input system" };
        if (opts.failKey === action.key) return { ok: false, detail: "key rejected" };
      }
      return { ok: true };
    },
    async waitForAnchor() {
      return { reached: true };
    },
    async capture() {
      return {};
    },
    async evaluateAssertion() {
      return { pass: true };
    },
    async readConsole() {
      return { errorCount: 0, errors: [] };
    },
    async teardown() {
      state.teardownCalls++;
    },
  };
  return driver;
}

const keyboardTrace = (actions: Action[]): ReplayTrace =>
  parseTrace(traceWith(actions)) as ReplayTrace;

test("engine: teardown runs after a normal pass", async () => {
  const driver = fakeDriver();
  const report = await replay(keyboardTrace([{ do: "key-hold", key: "D", durationMs: 10 }]), driver);
  assert.equal(report.status, "pass");
  assert.equal(driver.teardownCalls, 1);
});

test("engine: teardown still runs when the driver throws mid-run", async () => {
  // A thrown harness error (e.g. a dead bridge) must not skip cleanup — teardown
  // is invoked in a `finally`, so the input session is released either way.
  const driver = fakeDriver();
  driver.readConsole = async () => {
    throw new Error("console exploded");
  };
  await assert.rejects(
    () => replay(keyboardTrace([{ do: "key-tap", key: "Space" }]), driver),
    /console exploded/,
  );
  assert.equal(driver.teardownCalls, 1);
});

test("engine: a key action the driver can't drive → blocked with keyboard reason", async () => {
  const driver = fakeDriver({ blockKey: "D" });
  const report = await replay(keyboardTrace([{ do: "key-hold", key: "D", durationMs: 10 }]), driver);
  assert.equal(report.status, "blocked");
  assert.equal(report.blockedReason, "keyboard-input-unsupported");
  assert.equal(driver.teardownCalls, 1);
});

test("engine: a key action that the game rejects → fail, divergence names the key", async () => {
  const driver = fakeDriver({ failKey: "Space" });
  const report = await replay(keyboardTrace([{ do: "key-tap", key: "Space" }]), driver);
  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "action-failed");
  assert.equal(report.firstDivergence?.expected, "key-tap Space");
});

// ───────────────────────── live driver ─────────────────────────

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

/** begin_session succeeds on the InputSystem backend (the gameplay-capable one). */
const inputSystemOk: Record<string, Handler> = {
  "input.begin_session": () => ({ data: { backend: "InputSystem", sessionId: "s", created: true } }),
};

const driverOpts = { captureDir: ".loombridge/run/replays/test/actual", pollIntervalMs: 1 };

test("driver.capabilityCheck: input-system is supported", async () => {
  const driver = new UnityDriver(fakeBridge().send, driverOpts);
  assert.deepEqual(await driver.capabilityCheck("input-system"), { supported: true });
});

test("driver: key-tap opens an InputSystem session then taps; teardown closes it", async () => {
  const { send, calls } = fakeBridge(inputSystemOk);
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch({ do: "key-tap", key: "Space" });
  assert.deepEqual(result, { ok: true });
  await driver.teardown();

  assert.deepEqual(
    calls.map((c) => c.command),
    ["input.begin_session", "input.key_tap", "input.end_session"],
  );
  assert.equal(calls[0].params.backend, "InputSystem");
  assert.equal(calls[1].params.key, "Space");
});

test("driver: key-hold issues key_down then key_up around the hold", async () => {
  const { send, calls } = fakeBridge(inputSystemOk);
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch({ do: "key-hold", key: "D", durationMs: 5 });
  assert.deepEqual(result, { ok: true });

  const keyCommands = calls.map((c) => c.command).filter((c) => c.startsWith("input.key"));
  assert.deepEqual(keyCommands, ["input.key_down", "input.key_up"]);
  assert.equal(calls.find((c) => c.command === "input.key_down")!.params.key, "D");
  assert.equal(calls.find((c) => c.command === "input.key_up")!.params.key, "D");
});

test("driver: the session is opened once across multiple key actions", async () => {
  const { send, calls } = fakeBridge(inputSystemOk);
  const driver = new UnityDriver(send, driverOpts);

  await driver.dispatch({ do: "key-tap", key: "Space" });
  await driver.dispatch({ do: "key-hold", key: "D", durationMs: 5 });
  await driver.teardown();

  assert.equal(calls.filter((c) => c.command === "input.begin_session").length, 1);
  assert.equal(calls.filter((c) => c.command === "input.end_session").length, 1);
});

test("driver: a reset invalidates the cached session so the next key re-opens one", async () => {
  // A reset is a Play-Mode reload that destroys the Unity session; a reused driver
  // must NOT skip begin_session on its stale "open" cache (else it drives a dead one).
  const { send, calls } = fakeBridge({
    ...inputSystemOk,
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.wait_for": () => ({ data: {} }),
  });
  const driver = new UnityDriver(send, driverOpts);

  await driver.dispatch({ do: "key-tap", key: "Space" });
  await driver.reset({ scene: "Assets/Scenes/Move.unity", reset: "scene-load" });
  await driver.dispatch({ do: "key-tap", key: "Space" });

  assert.equal(
    calls.filter((c) => c.command === "input.begin_session").length,
    2,
    "begin_session must run again after a reset wiped the session",
  );
});

test("driver: a missing Input System blocked-degrades the key action (no silent pass)", async () => {
  const { send, calls } = fakeBridge({
    "input.begin_session": () => ({
      error: "Input System backend requested but Unity Input System is not installed.",
      code: "INPUT_SYSTEM_NOT_INSTALLED",
    }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch({ do: "key-hold", key: "D", durationMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  // it must NOT have attempted to drive a key after the session failed.
  assert.equal(calls.some((c) => c.command.startsWith("input.key")), false);

  // a second key action degrades the same way without re-probing begin_session.
  await driver.dispatch({ do: "key-tap", key: "Space" });
  assert.equal(calls.filter((c) => c.command === "input.begin_session").length, 1);
  // teardown is a no-op when no session ever opened.
  await driver.teardown();
  assert.equal(calls.some((c) => c.command === "input.end_session"), false);
});

test("driver: a session that lands on a non-gameplay backend is blocked, not silently accepted", async () => {
  // begin_session returned EditorEvent (e.g. a pre-existing session) — it cannot
  // inject gameplay keys, so a key action must block rather than no-op into a pass.
  const { send } = fakeBridge({
    "input.begin_session": () => ({ data: { backend: "EditorEvent", created: false } }),
  });
  const driver = new UnityDriver(send, driverOpts);

  const result = await driver.dispatch({ do: "key-tap", key: "Space" });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
});
