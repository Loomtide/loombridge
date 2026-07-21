/**
 * Replay Verification — keyboard RECORDING (observe key edges → timed-edge trace).
 *
 * Covers the new actions (`key-down`/`key-up`/`wait`) through the parser, the
 * `extractKeyEdges` parser, the timed-edge transform (`observedEdgesToTrace` —
 * timing, CONCURRENCY interleaving, and a still-held key closed at stop), and the
 * live driver's dispatch of the three actions. The observer C# capture is
 * live-proven separately.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeResponse } from "../types.js";
import {
  extractKeyEdges,
  observedEdgesToTrace,
  parseTrace,
  UnityDriver,
  type Action,
  type BridgeSend,
  type ObservedKeyEdge,
} from "../loomtide/replay/index.js";

const meta = { id: "kbd-rec", scene: "Assets/Scenes/Platformer.unity", title: "t" };
const edge = (key: string, e: "down" | "up", tMs: number): ObservedKeyEdge => ({ key, edge: e, tMs });

// ───────────────────────── parse ─────────────────────────

function traceWith(actions: unknown[]): unknown {
  return {
    schemaVersion: "0.1",
    id: "k",
    start: { scene: "S.unity", reset: "scene-load" },
    input: { backend: "input-system" },
    segments: [{ id: "s", actions }],
    outcome: { expected: "success" },
  };
}

test("parse: key-down, key-up, wait round-trip", () => {
  const trace = parseTrace(
    traceWith([
      { do: "key-down", key: "D" },
      { do: "wait", durationMs: 500 },
      { do: "key-up", key: "D" },
    ]),
  );
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 500 },
    { do: "key-up", key: "D" },
  ]);
});

test("parse: wait refuses a non-positive duration; key-down/up refuse an empty key", () => {
  assert.throws(() => parseTrace(traceWith([{ do: "wait", durationMs: 0 }])), /durationMs must be a positive number/);
  assert.throws(() => parseTrace(traceWith([{ do: "wait" }])), /durationMs must be a positive number/);
  assert.throws(() => parseTrace(traceWith([{ do: "key-down", key: "" }])), /key must be a non-empty string/);
});

// ───────────────────────── extractKeyEdges ─────────────────────────

test("extractKeyEdges: parses edges; missing → []; malformed throws", () => {
  assert.deepEqual(extractKeyEdges({ keyEdges: [{ key: "D", edge: "down", tMs: 5 }] }), [
    { key: "D", edge: "down", tMs: 5 },
  ]);
  assert.deepEqual(extractKeyEdges({ clicks: [] }), []);
  assert.deepEqual(extractKeyEdges({}), []);
  assert.throws(() => extractKeyEdges({ keyEdges: [{ key: "D", edge: "sideways", tMs: 1 }] }), /malformed key edge/);
  assert.throws(() => extractKeyEdges({ keyEdges: [{ key: "D", tMs: 1 }] }), /malformed key edge/);
  assert.throws(() => extractKeyEdges({ keyEdges: [{ edge: "down", tMs: 1 }] }), /malformed key edge/);
});

// ───────────────────────── transform ─────────────────────────

test("observedEdgesToTrace: a hold becomes key-down · wait · key-up, green by construction", () => {
  const trace = observedEdgesToTrace([], [edge("D", "down", 0), edge("D", "up", 800)], meta);
  assert.equal(trace.input.backend, "input-system");
  assert.equal(trace.segments.length, 1);
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 800 },
    { do: "key-up", key: "D" },
  ]);
  // the final-state capture is present; the trace round-trips through the parser.
  assert.equal(trace.segments[0].captures?.[0].id, "final");
  assert.doesNotThrow(() => parseTrace(trace as unknown));
});

test("observedEdgesToTrace: CONCURRENT keys interleave (hold D while tapping Space)", () => {
  // D held 0→2000; Space tapped 1000→1100 DURING the hold.
  const trace = observedEdgesToTrace(
    [],
    [edge("D", "down", 0), edge("Space", "down", 1000), edge("Space", "up", 1100), edge("D", "up", 2000)],
    meta,
  );
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 1000 },
    { do: "key-down", key: "Space" },
    { do: "wait", durationMs: 100 },
    { do: "key-up", key: "Space" },
    { do: "wait", durationMs: 900 },
    { do: "key-up", key: "D" },
  ]);
});

test("observedEdgesToTrace: a key still held at stop is released with a trailing key-up", () => {
  const trace = observedEdgesToTrace([], [edge("RightArrow", "down", 0)], meta);
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "RightArrow" },
    { do: "key-up", key: "RightArrow" },
  ]);
});

test("observedEdgesToTrace: clicks and key edges merge on one timeline by tMs", () => {
  const click = { tMs: 500, locator: { path: "/HUD/Pause" }, button: 0, kind: "ui" as const };
  const trace = observedEdgesToTrace([click], [edge("D", "down", 0), edge("D", "up", 1000)], meta);
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 500 },
    { do: "wait-for-visible", locator: { path: "/HUD/Pause" }, timeoutMs: 4000 },
    { do: "tap", locator: { path: "/HUD/Pause" } },
    { do: "wait", durationMs: 500 },
    { do: "key-up", key: "D" },
  ]);
});

test("observedEdgesToTrace: no input at all is refused (no hollow trace)", () => {
  assert.throws(() => observedEdgesToTrace([], [], meta), /no input was recorded/);
});

test("observedEdgesToTrace: an unmatched up (no matching down) is DROPPED, not emitted", () => {
  // a lone up (e.g. a key held before observe_start) → no key-up in the trace.
  const lone = observedEdgesToTrace([], [edge("D", "up", 5)], meta);
  assert.equal(lone.segments[0].actions.filter((a) => a.do === "key-up").length, 0);
  // a duplicate up after a balanced press → the SECOND up is dropped.
  const dup = observedEdgesToTrace([], [edge("D", "down", 0), edge("D", "up", 5), edge("D", "up", 9)], meta);
  assert.deepEqual(dup.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "wait", durationMs: 5 },
    { do: "key-up", key: "D" },
  ]);
});

test("observedEdgesToTrace: equal-tMs edges sort down BEFORE up (never up-before-down)", () => {
  // even given up-before-down in the input, the same-instant pair emits down then up.
  const trace = observedEdgesToTrace([], [edge("D", "up", 100), edge("D", "down", 100)], meta);
  assert.deepEqual(trace.segments[0].actions, [
    { do: "key-down", key: "D" },
    { do: "key-up", key: "D" },
  ]);
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
const inputSystemOk: Record<string, Handler> = {
  "input.begin_session": () => ({ data: { backend: "InputSystem", created: true } }),
};
const driverOpts = { captureDir: ".loomtide/replays/test/actual", pollIntervalMs: 1 };

test("driver: key-down/key-up open a session and issue the matching ops", async () => {
  const { send, calls } = fakeBridge(inputSystemOk);
  const driver = new UnityDriver(send, driverOpts);
  assert.deepEqual(await driver.dispatch({ do: "key-down", key: "D" }), { ok: true });
  assert.deepEqual(await driver.dispatch({ do: "key-up", key: "D" }), { ok: true });
  await driver.teardown();
  assert.deepEqual(
    calls.map((c) => c.command),
    ["input.begin_session", "input.key_down", "input.key_up", "input.end_session"],
  );
});

test("driver: a held-key session is kept alive (input.keepalive pings under the 30s watchdog)", async () => {
  const { send, calls } = fakeBridge({
    "input.begin_session": () => ({ data: { backend: "InputSystem", sessionId: "sess-1", created: true } }),
  });
  const driver = new UnityDriver(send, { ...driverOpts, keepaliveIntervalMs: 20 });
  await driver.dispatch({ do: "key-down", key: "D" });
  await new Promise((r) => setTimeout(r, 70)); // ~3 keepalive intervals while D is held
  const pings = calls.filter((c) => c.command === "input.keepalive");
  assert.ok(pings.length >= 1, "the held-key session must be pinged before the 30s idle teardown");
  assert.equal(pings[0].params.sessionId, "sess-1");
  await driver.teardown();
  // teardown stops the heartbeat: no further pings after.
  const after = calls.filter((c) => c.command === "input.keepalive").length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.filter((c) => c.command === "input.keepalive").length, after, "teardown stops keepalive");
});

test("driver: wait is a pure delay — no session, no ops", async () => {
  const { send, calls } = fakeBridge(inputSystemOk);
  const driver = new UnityDriver(send, driverOpts);
  const t0 = Date.now();
  assert.deepEqual(await driver.dispatch({ do: "wait", durationMs: 20 }), { ok: true });
  assert.ok(Date.now() - t0 >= 18, "the wait actually delayed");
  assert.equal(calls.length, 0, "a wait must not touch the bridge or open a session");
});

test("driver: a key edge blocked-degrades on a legacy-only project (no silent pass)", async () => {
  const { send } = fakeBridge({
    "input.begin_session": () => ({ error: "Input System not installed", code: "INPUT_SYSTEM_NOT_INSTALLED" }),
  });
  const driver = new UnityDriver(send, driverOpts);
  const result = await driver.dispatch({ do: "key-down", key: "D" });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
});
