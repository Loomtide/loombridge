/**
 * Interleaved captures on the merged keyboard timeline.
 *
 * THE DEFECT. A human recorded 62 actions on a real Unity project. Six of them were key
 * edges, which routes the whole session through `observedEdgesToTrace` — one `recorded`
 * segment carrying the merged time-ordered timeline plus a single trailing `final` capture.
 * The 14 pointer gestures in that session produced ONE frame between them, so approving the
 * trace froze a baseline that guarded nothing about any of them.
 *
 * THE SHAPE. The timeline is NOT split into per-gesture segments: a boundary between a
 * `key-down` and its `key-up` would change what the run simulates. Instead a `capture`
 * ACTION sits at each gesture's own point inside the one segment, so held keys are
 * untouched.
 *
 * These tests exercise the real transform, the real parser, and the real engine. Nothing
 * here re-implements the behaviour it checks.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import {
  alignedSettleFrames,
  DEFAULT_ALIGNED_CAPTURE_FPS,
} from "../../../../capabilities/replay/aligned-capture.js";
import { preservesPendingGesture } from "../../../../capabilities/replay/gesture-recovery.js";
import {
  observedEdgesToTrace,
  parseTrace,
  replay,
  type Action,
  type Anchor,
  type Assertion,
  type ObservedClick,
  type ObservedKeyEdge,
  type ReplayDriver,
  type ReplayTrace,
} from "../../../../capabilities/replay/index.js";
import { scaleTraceSettles } from "../../../../capabilities/replay/trace.js";

const META = { id: "kb", scene: "Assets/Scenes/Game.unity" };
const edge = (key: string, e: "down" | "up", tMs: number): ObservedKeyEdge => ({ key, edge: e, tMs });
const tap = (path: string, tMs: number): ObservedClick => ({ tMs, locator: { path }, button: 0, kind: "ui" });

/** Every step the engine drove, in order: `dispatch <do>` / `capture <id>@<settleMs>`. */
interface Trail {
  steps: string[];
  driver: ReplayDriver;
}

function trailDriver(over: Partial<ReplayDriver> = {}): Trail {
  const steps: string[] = [];
  const driver: ReplayDriver = {
    async capabilityCheck() {
      return { supported: true };
    },
    async reset() {
      return { ok: true, tier: "scene-load" };
    },
    async dispatch(action: Action) {
      steps.push(
        action.do === "tap" || action.do === "world-tap"
          ? `${action.do} ${action.locator.path}`
          : action.do === "drag"
            ? `drag ${action.from.path}`
            : action.do === "key-down" || action.do === "key-up"
              ? `${action.do} ${action.key}`
              : action.do === "wait"
                ? `wait ${action.durationMs}`
                : action.do === "wait-for-visible"
                  ? `wait-for-visible ${action.locator.path}`
                  : action.do,
      );
      return { ok: true };
    },
    async waitForAnchor(_anchor: Anchor) {
      return { reached: true };
    },
    async capture(id: string, settleMs?: number) {
      steps.push(`capture ${id}@${settleMs}`);
      return { artifact: `${id}.png`, sha256: `sha-${id}` };
    },
    async evaluateAssertion(_a: Assertion) {
      return { pass: true };
    },
    async readConsole() {
      return { errorCount: 0, errors: [] };
    },
    ...over,
  };
  return { steps, driver };
}

// ───────────────────── one frame per gesture, plus the end state ─────────────────────

test("observedEdgesToTrace: every pointer gesture gets its own capture, plus the final one", async () => {
  // LITMUS: delete the `actions.push({ do: "capture", … })` that follows each gesture in
  // `observedEdgesToTrace` (i.e. restore the single trailing `final` capture). Observed:
  //   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  //   + actual - expected
  //   + []
  //   - [ 'step-1', 'step-2', 'step-3' ]
  // Restored, it passes.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 500), tap("/HUD/B", 1500), tap("/HUD/C", 2500)],
    [edge("D", "down", 0), edge("D", "up", 3000)],
    META,
  );
  assert.equal(trace.segments.length, 1, "one segment: a held key must not be split across a boundary");
  assert.deepEqual(
    trace.segments[0]!.actions.filter((a) => a.do === "capture").map((a) => (a as { id: string }).id),
    ["step-1", "step-2", "step-3"],
  );
  assert.deepEqual(
    trace.segments[0]!.captures?.map((c) => c.id),
    ["final"],
    "the end-state frame is kept, not replaced",
  );
  // Green by construction: the recorder can never emit a trace its own parser rejects.
  assert.doesNotThrow(() => parseTrace(trace as unknown));

  // And the engine really takes all four frames.
  const { steps, driver } = trailDriver();
  const report = await replay(trace, driver);
  assert.equal(report.status, "pass");
  assert.deepEqual(
    report.segments[0]!.captures.map((c) => c.id),
    ["step-1", "step-2", "step-3", "final"],
  );
  assert.equal(steps.filter((s) => s.startsWith("capture ")).length, 4);
});

test("engine: an interleaved capture lands AT its gesture, not bunched at the end, with the key still held", async () => {
  // LITMUS: in `engine.ts`, move the interleaved capture out of the action loop (collect the
  // capture actions and take them in step 3c alongside the trailing captures). Observed:
  //   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  //   + actual - expected
  //     [
  //       'key-down D',
  //       'wait 500',
  //       'wait-for-visible /HUD/A',
  //       'tap /HUD/A',
  //   -   'capture step-1@2000',
  //       'wait-for-visible /HUD/B',
  //       'tap /HUD/B',
  //   +   'key-up D',
  //   +   'capture step-1@2000',
  //       'capture step-2@1000',
  //   -   'key-up D',
  //       'capture final@400'
  //     ]
  // The frames bunch after the key-up: every one of them shows the state AFTER the hold
  // ended, and none shows the moment its id names. Restored, it passes.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 500), tap("/HUD/B", 2500)],
    [edge("D", "down", 0), edge("D", "up", 3500)],
    META,
  );
  const { steps, driver } = trailDriver();
  await replay(trace, driver);
  assert.deepEqual(steps, [
    "key-down D",
    "wait 500",
    "wait-for-visible /HUD/A",
    "tap /HUD/A",
    "capture step-1@2000",
    // The dwell was 2000ms and the settle spent all of it, so no wait remains here. The key
    // is STILL DOWN across the capture: nothing between the two key edges releases it.
    "wait-for-visible /HUD/B",
    "tap /HUD/B",
    "capture step-2@1000",
    "key-up D",
    "capture final@400",
  ]);
  const downAt = steps.indexOf("key-down D");
  const upAt = steps.indexOf("key-up D");
  assert.ok(downAt >= 0 && upAt > downAt, "the hold is still a single balanced down…up pair");
  assert.ok(
    steps.slice(downAt, upAt).filter((s) => s.startsWith("capture ")).length === 2,
    "both gesture captures happen INSIDE the hold",
  );
});

// ───────────────────── the settle is the human's own dwell ─────────────────────

test("observedEdgesToTrace: each capture settles for the HUMAN's dwell, not a constant", () => {
  // LITMUS: replace the computed `settleMs` with the flat `MIN_SETTLE_MS` the `final` capture
  // uses. Observed:
  //   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  //   + actual - expected
  //   + [ 400, 400, 400 ]
  //   - [ 250, 1800, 3000 ]
  // Restored, it passes. The three dwells are deliberately distinct, so a constant of ANY
  // value fails rather than only a wrong one.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 0), tap("/HUD/B", 250), tap("/HUD/C", 2050)],
    // The last gesture's dwell runs to the key-up 9000ms later, which the cap trims to 3000.
    [edge("D", "down", 0), edge("D", "up", 11_050)],
    META,
  );
  const settles = trace.segments[0]!.actions
    .filter((a) => a.do === "capture")
    .map((a) => (a as { settleMs?: number }).settleMs);
  assert.deepEqual(settles, [250, 1800, 3000]);
});

test("observedEdgesToTrace: the dwell is spent ONCE — the recorded timeline keeps its length", () => {
  // A settle that ADDED to the timeline would hold every key down longer than the human did,
  // and the run would simulate something the demonstration never did. The settle is therefore
  // deducted from the wait the same gap would otherwise have become.
  //
  // LITMUS: drop the `settleDebtMs` deduction from `flushWait` (i.e. go back to
  // `Math.min(pendingMs, MAX_WAIT_MS)`). Observed:
  //   AssertionError [ERR_ASSERTION]: the timeline must last exactly as long as the demonstration
  //   5500 !== 3000
  // Restored, it passes.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 500), tap("/HUD/B", 900)],
    [edge("D", "down", 0), edge("D", "up", 3000)],
    META,
  );
  const actions = trace.segments[0]!.actions;
  // The ACTION list is the human's 3000ms of play; the trailing `final` capture is a segment
  // capture, so it sits outside this sum, after the last key edge.
  const elapsed = actions.reduce((total, a) => {
    if (a.do === "wait") return total + a.durationMs;
    // A capture's settle is real elapsed time in the run, exactly like a wait.
    if (a.do === "capture") return total + (a.settleMs ?? 0);
    return total;
  }, 0);
  assert.equal(elapsed, 3000, "the timeline must last exactly as long as the demonstration");
});

test("observedEdgesToTrace: a long human pause is capped, and the REMAINDER still becomes a wait", () => {
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 0)],
    [edge("D", "down", 0), edge("D", "up", 5000)],
    META,
  );
  const actions = trace.segments[0]!.actions;
  const capture = actions.find((a) => a.do === "capture") as { settleMs?: number };
  assert.equal(capture.settleMs, 3000, "capped at MAX_SETTLE_MS");
  const waits = actions.filter((a) => a.do === "wait").map((a) => (a as { durationMs: number }).durationMs);
  assert.deepEqual(waits, [2000], "the 5000ms gap minus the 3000ms settle");
});

// ───────────────────── the parser holds the id contract ─────────────────────

test("parseTrace: an interleaved capture id takes the same path-segment validation as any capture id", () => {
  // LITMUS: swap `requireId` for `requireString` in the `capture` case of `parseAction`.
  // Observed: `assert.throws` failed — "Missing expected exception", i.e. a capture action
  // named "../../evil" parsed cleanly and would have written its PNG outside the capture
  // directory. Restored, it throws.
  const mk = (id: string): unknown => ({
    schemaVersion: "0.1",
    id: "t",
    start: { scene: "S.unity", reset: "scene-load" },
    input: { backend: "input-system" },
    segments: [{ id: "recorded", actions: [{ do: "capture", id }] }],
    outcome: { expected: "success" },
  });
  assert.throws(() => parseTrace(mk("../../evil")), /must not contain path separators/);
  assert.throws(() => parseTrace(mk("a/b")), /must not contain path separators/);
  assert.doesNotThrow(() => parseTrace(mk("step-1")));
});

test("parseTrace: a segment that interleaves captures REFUSES duplicate capture ids", () => {
  // Two captures sharing an id means the second PNG overwrites the first and one approved
  // baseline silently grades two different moments.
  //
  // LITMUS: delete the duplicate-id loop in `parseSegment`. Observed: "Missing expected
  // exception (TraceParseError)" on both cases below. Restored, both throw.
  const mk = (extra: unknown[]): unknown => ({
    schemaVersion: "0.1",
    id: "t",
    start: { scene: "S.unity", reset: "scene-load" },
    input: { backend: "input-system" },
    segments: [
      {
        id: "recorded",
        actions: [{ do: "capture", id: "step-1" }, ...extra],
        captures: [{ id: "final" }],
      },
    ],
    outcome: { expected: "success" },
  });
  assert.throws(() => parseTrace(mk([{ do: "capture", id: "step-1" }])), /duplicate capture id/);
  assert.throws(() => parseTrace(mk([{ do: "capture", id: "final" }])), /duplicate capture id/);
  assert.doesNotThrow(() => parseTrace(mk([{ do: "capture", id: "step-2" }])));
});

test("preservesPendingGesture: a capture keeps a pending continuous gesture re-drivable", () => {
  // A capture is not an input, so it cannot be what advanced a later phase gate. Clearing on
  // it would mean per-gesture captures silently switched gesture recovery off for the trace.
  //
  // LITMUS: remove the `action.do === "capture"` clause. Observed:
  //   AssertionError [ERR_ASSERTION]: false == true
  // Restored, it passes. The default-deny rule is still checked below.
  assert.equal(preservesPendingGesture({ do: "capture", id: "step-1" }), true);
  assert.equal(preservesPendingGesture({ do: "tap", locator: { path: "/A" } }), false);
  assert.equal(preservesPendingGesture({ do: "key-down", key: "D" }), false);
});

// ───────────────────── --speed and --aligned still work ─────────────────────

test("scaleTraceSettles: --speed scales an INTERLEAVED capture's settle, not just a trailing one", () => {
  // LITMUS: remove the `for (const action of segment.actions ?? [])` loop. Observed:
  //   AssertionError [ERR_ASSERTION]: 4000 !== 1000
  //   the interleaved settle must divide by --speed too
  // Restored, it passes. Without it a `--speed 4` run would hold every interleaved settle at
  // its recorded length while the report stamped `replaySpeed: 4`.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 0)],
    [edge("D", "down", 0), edge("D", "up", 8000)],
    META,
  );
  // Widen the recorded settle past the scaling floor so the division is visible.
  const capture = trace.segments[0]!.actions.find((a) => a.do === "capture") as { settleMs?: number };
  capture.settleMs = 4000;
  scaleTraceSettles(trace, 4);
  assert.equal(capture.settleMs, 1000, "the interleaved settle must divide by --speed too");
  assert.equal(trace.segments[0]!.captures![0]!.settleMs, 250, "…and the trailing one still does");
});

test("--aligned: an interleaved settle converts to frames exactly like a trailing one", async () => {
  // The alignment lives in the DRIVER's `capture` seam, which the engine calls for an
  // interleaved capture and a trailing one alike, so a settle mid-timeline is pinned to the
  // same clock. This checks the settle really reaches that seam with its own value.
  const trace = observedEdgesToTrace(
    [tap("/HUD/A", 0), tap("/HUD/B", 1000)],
    [edge("D", "down", 0), edge("D", "up", 2000)],
    META,
  );
  const { steps, driver } = trailDriver();
  await replay(trace, driver);
  const settles = steps
    .filter((s) => s.startsWith("capture "))
    .map((s) => Number(s.split("@")[1]));
  assert.deepEqual(settles, [1000, 1000, 400]);
  assert.deepEqual(
    settles.map((ms) => alignedSettleFrames(ms, DEFAULT_ALIGNED_CAPTURE_FPS)),
    [60, 60, 24],
    "60 fps: 1000ms is 60 frames, the 400ms final settle is 24",
  );
});

// ───────────────────── back-compat: a pre-change trace is untouched ─────────────────────

/**
 * A merged KEYBOARD trace exactly as the recorder emitted it BEFORE this change: one
 * `recorded` segment carrying the whole timeline, and a single trailing `final` capture at
 * the flat 400ms settle.
 *
 * CONSTRUCTED, not found. The repository ships no keyboard trace fixture, so this is built
 * from the documented pre-change shape (and cross-checked against the transform's own output
 * at the previous commit). The pointer case below uses a REAL pre-change file instead.
 */
const PRE_CHANGE_KEYBOARD_TRACE: unknown = {
  schemaVersion: "0.1",
  id: "pre-change-keyboard",
  start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
  input: { backend: "input-system" },
  segments: [
    {
      id: "recorded",
      actions: [
        { do: "key-down", key: "D" },
        { do: "wait", durationMs: 500 },
        { do: "wait-for-visible", locator: { path: "/HUD/Pause" }, timeoutMs: 4000 },
        { do: "tap", locator: { path: "/HUD/Pause" } },
        { do: "wait", durationMs: 500 },
        { do: "key-up", key: "D" },
      ],
      captures: [{ id: "final", settleMs: 400 }],
    },
  ],
  outcome: { expected: "success" },
};

test("back-compat: a pre-change KEYBOARD trace parses and replays exactly as it did", async () => {
  const trace = parseTrace(PRE_CHANGE_KEYBOARD_TRACE);
  assert.equal(
    trace.segments[0]!.actions.some((a) => a.do === "capture"),
    false,
    "this fixture must carry NONE of the new vocabulary, or it proves nothing",
  );
  const { steps, driver } = trailDriver();
  const report = await replay(trace, driver);
  // The exact drive, unchanged: one frame, at the end, at the settle the trace declares.
  assert.deepEqual(steps, [
    "key-down D",
    "wait 500",
    "wait-for-visible /HUD/Pause",
    "tap /HUD/Pause",
    "wait 500",
    "key-up D",
    "capture final@400",
  ]);
  assert.equal(report.status, "pass");
  assert.equal(report.resetTier, "scene-load");
  assert.deepEqual(report.segments, [
    {
      id: "recorded",
      status: "pass",
      anchorsReached: [],
      captures: [{ id: "final", artifact: "final.png", sha256: "sha-final" }],
    },
  ]);
  // The BASELINE KEY is the capture id: an approved `final.png` still matches `final`.
  assert.deepEqual(report.segments[0]!.captures.map((c) => c.id), ["final"]);
});

test("back-compat: the shipped pre-change POINTER trace replays unchanged (real file, not a mock)", async () => {
  // `examples/replay/count-the-fruits-start.trace.json` has been in the repository since the
  // initial import and is not touched by this branch, so it is a genuine pre-change input.
  const file = path.join(PKG_ROOT, "examples", "replay", "count-the-fruits-start.trace.json");
  const trace = parseTrace(JSON.parse(await fs.readFile(file, "utf8")));
  assert.equal(
    trace.segments.some((s) => s.actions.some((a) => a.do === "capture")),
    false,
    "a pre-change trace carries none of the new vocabulary",
  );
  const { steps, driver } = trailDriver();
  const report = await replay(trace, driver);
  assert.deepEqual(steps, ["tap /HUD/StartScreen/StartButton", "capture question@undefined"]);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.segments[0]!.anchorsReached, ["question-shown"]);
  assert.deepEqual(report.segments[0]!.captures.map((c) => c.id), ["question"]);
});

test("back-compat: --speed on a pre-change trace changes only what it always changed", () => {
  const trace = parseTrace(PRE_CHANGE_KEYBOARD_TRACE) as ReplayTrace;
  const before = JSON.stringify(trace);
  scaleTraceSettles(trace, 1);
  assert.equal(JSON.stringify(trace), before, "speed 1 is still the identity");
  scaleTraceSettles(trace, 4);
  assert.equal(trace.segments[0]!.captures![0]!.settleMs, 250, "400/4 floors at the minimum");
  assert.deepEqual(
    trace.segments[0]!.actions.map((a) => a.do),
    ["key-down", "wait", "wait-for-visible", "tap", "wait", "key-up"],
    "no action was rewritten",
  );
});
