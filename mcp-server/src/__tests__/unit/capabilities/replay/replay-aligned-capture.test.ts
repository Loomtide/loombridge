/**
 * CAPTURE-ALIGNED REPLAY: the settle is a pinned bridge-side tick loop, not a sleep here.
 *
 * The failure this slice exists to remove: a wall-clock settle lets the game free-run for an
 * unknown number of frames between the sleep and the screenshot, so each run captures a
 * different animation phase and the pixel gate reads that skew as drift. What has to hold,
 * and is pinned here:
 *
 *  1. the settle-to-frames conversion happens ONCE, after `--speed` scaling (double scaling
 *     would settle for a quarter of the stated time at 4x and still claim the trace's own);
 *  2. the fps range is a REFUSAL, and the physics cadence is an ADVISORY that never refuses;
 *  3. aligned mode swaps ONLY the capture call, and the wall-clock path stays byte-identical;
 *  4. the driver states its own wire timeout, wide enough that the BRIDGE's deadline is the
 *     one that decides the outcome;
 *  5. a settle the editor could not deliver is a HARNESS FAULT with no frame, never drift;
 *  6. frames captured under different clock disciplines REFUSE comparison at grade time, and
 *     every reason an anchor is untrustworthy is printed, not just the last one found.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  ALIGNED_RESIDUAL_SENTENCE,
  DEFAULT_ALIGNED_CAPTURE_FPS,
  MAX_ALIGNED_CAPTURE_FPS,
  MIN_ALIGNED_CAPTURE_FPS,
  alignedCaptureFpsRefusal,
  alignedSettleFrames,
  physicsCadenceNote,
} from "../../../../capabilities/replay/aligned-capture.js";
import {
  applyVisualDiff,
  printSummary,
  run as runTrace,
  scaleTraceSettles,
} from "../../../../capabilities/replay/trace.js";
import {
  loadTraceBaselineManifest,
  sha256,
  traceBaselineManifestPath,
  writeTraceBaselineManifest,
  type TraceBaselineManifest,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import { UnityDriver, type BridgeSend } from "../../../../capabilities/replay/index.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ───────────────────────── fixtures ─────────────────────────

interface Recorded {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}
type Handler = (params: Record<string, unknown>) => { data?: unknown; error?: string; code?: string };

function fakeBridge(handlers: Record<string, Handler> = {}): { send: BridgeSend; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const send: BridgeSend = async (command, params, timeoutMs) => {
    calls.push({ command, params, timeoutMs });
    const handler = handlers[command] ?? (() => ({ data: {} }));
    const result = handler(params);
    if (result.error !== undefined) {
      return {
        id: "t",
        timestamp: 0,
        status: "error",
        data: null,
        error: { code: result.code ?? "X", message: result.error },
      } as unknown as BridgeResponse;
    }
    return { id: "t", timestamp: 0, status: "success", data: result.data ?? {} } as unknown as BridgeResponse;
  };
  return { send, calls };
}

const PNG_BYTES = Buffer.from("fake-png-bytes\x00\x01\x02");
const alignedOk = (over: Record<string, unknown> = {}) => ({
  "replay.settle_and_capture": () => ({
    data: {
      image_base64: PNG_BYTES.toString("base64"),
      format: "png",
      framesElapsed: 15,
      settledMs: 250,
      realtimeDeadlineHit: false,
      fixedDeltaTime: 0.02,
      ...over,
    },
  }),
});

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-aligned-"));
}

/** A tiny valid 1x1 PNG (same technique as the pacing/tolerance tests). */
function tinyPng(r: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, r, 0, 0, 255]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) | 0;
}

/** Build an approved baseline + a matching actual capture, and return the artifact shell. */
async function approvedTrace(
  root: string,
  manifestExtra: Partial<TraceBaselineManifest>,
): Promise<{ paths: ReturnType<typeof standardReplayLayout>; actual: string; png: Buffer }> {
  const paths = standardReplayLayout(root);
  const baselineDir = path.join(paths.replayBaselines, "demo");
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.mkdir(paths.replayTraces, { recursive: true });
  const png = tinyPng(10);
  await fs.writeFile(path.join(baselineDir, "cap.png"), png);
  const traceBody = JSON.stringify({ id: "demo", segments: [] });
  await fs.writeFile(path.join(paths.replayTraces, "demo.trace.json"), traceBody);
  await writeTraceBaselineManifest(baselineDir, {
    kind: "trace-baseline",
    schemaVersion: "1",
    traceId: "demo",
    traceSha256: sha256(Buffer.from(traceBody)),
    approvedAt: "2026-07-29T00:00:00.000Z",
    sourceReportSha256: "0".repeat(64),
    pngs: [{ captureId: "cap", sha256: sha256(png) }],
    ...manifestExtra,
  });
  const actualDir = path.join(paths.replayReports, "demo", "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actual = path.join(actualDir, "cap.png");
  await fs.writeFile(actual, png);
  return { paths, actual, png };
}

function artifactWith(actual: string, png: Buffer, over: Partial<ReplayRunArtifact>): ReplayRunArtifact {
  return {
    traceId: "demo",
    status: "pass",
    resetTier: "scene",
    segments: [
      {
        id: "s1",
        status: "pass",
        anchorsReached: [],
        captures: [{ id: "cap", artifact: actual, sha256: sha256(png) }],
      },
    ],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    ...over,
  } as unknown as ReplayRunArtifact;
}

/** Capture stderr for a block (the CLI prints its refusals and advisories there). */
async function captured<T>(fn: () => Promise<T> | T): Promise<{ value: T; out: string }> {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += `${args.map(String).join(" ")}\n`;
  };
  try {
    const value = await fn();
    return { value, out };
  } finally {
    console.error = original;
  }
}

// ───────────────────────── 1. the conversion, once, after scaling ─────────────────────────

test("alignedSettleFrames: exact frame counts, and ONE conversion after scaleTraceSettles (speed 4, 60 fps)", () => {
  assert.equal(alignedSettleFrames(1000, 60), 60, "1000ms at 60 fps is 60 frames");
  assert.equal(alignedSettleFrames(250, 60), 15);
  assert.equal(alignedSettleFrames(16, 60), 1, "16ms rounds to one frame, never zero");
  assert.equal(alignedSettleFrames(0, 60), 1, "a zero settle still needs a frame to capture ON");
  assert.equal(alignedSettleFrames(undefined, 60), 1, "an absent settle is one pinned frame");
  assert.equal(alignedSettleFrames(500, 30), 15, "the rate is honoured, not assumed 60");

  // THE ORDER TEST. A trace settle of 1000ms replayed at --speed 4 scales to the 250ms floor
  // FIRST, and only then converts: 15 frames. Converting first (60 frames) and then dividing
  // by the speed would also reach 15 here by coincidence, so the case that discriminates is a
  // settle whose scaled value is FLOORED: 300ms/4 = 75 floors to 250 = 15 frames, while a
  // frames-then-speed order would give round(300*60/1000)/4 = 4.5 frames.
  const trace = { segments: [{ captures: [{ settleMs: 1000 }, { settleMs: 300 }] }] };
  const scaled = scaleTraceSettles(trace, 4);
  const frames = scaled.segments[0]!.captures!.map((c) => alignedSettleFrames(c.settleMs, 60));
  assert.deepEqual(frames, [15, 15], "both settles land on 15 frames THROUGH the floor, not around it");
});

// ───────────────────────── 2. the range refuses; the cadence advises ─────────────────────

test("alignedCaptureFpsRefusal: integer [10, 120], non-coercing, absent means wall-clock", () => {
  assert.equal(alignedCaptureFpsRefusal(undefined), null, "absent is the legacy wall-clock discipline");
  assert.equal(alignedCaptureFpsRefusal(MIN_ALIGNED_CAPTURE_FPS), null);
  assert.equal(alignedCaptureFpsRefusal(DEFAULT_ALIGNED_CAPTURE_FPS), null);
  assert.equal(alignedCaptureFpsRefusal(MAX_ALIGNED_CAPTURE_FPS), null);
  for (const bad of [
    0,
    9,
    121,
    59.94,
    -60,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "60",
    true,
    null,
  ]) {
    assert.notEqual(alignedCaptureFpsRefusal(bad as unknown), null, `${JSON.stringify(bad)} must refuse`);
  }
});

test("physicsCadenceNote is ADVISORY: null when the step divides evenly, a stated cadence when it does not", () => {
  // 50 fps against a 0.02 step: exactly one physics step per frame. Nothing to say.
  assert.equal(physicsCadenceNote(50, 0.02), null);
  assert.equal(physicsCadenceNote(25, 0.02), null, "two whole steps per frame is still even");

  // 60 fps against 0.02 is the common real case: 5 steps every 6 frames.
  const note = physicsCadenceNote(60, 0.02);
  assert.ok(note, "an uneven cadence must be reported");
  assert.match(note!, /physics steps 5 times every 6 frame/);
  assert.match(note!, /feel-sensitive traces may differ from the recording/);
  // It is a NOTE, not a refusal: no refusal vocabulary, and the caller has nothing to catch.
  assert.doesNotMatch(note!, /refus|must|error/i);

  // Garbage in is silence, never a fabricated cadence.
  assert.equal(physicsCadenceNote(60, 0), null);
  assert.equal(physicsCadenceNote(0, 0.02), null);
});

// ───────────────────────── 3 to 5. the driver seam ─────────────────────────

test("aligned mode swaps ONLY the capture: one settle_and_capture, no sleep, no editor.screenshot", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aligned-cap-"));
  try {
    const { send, calls } = fakeBridge(alignedOk());
    const driver = new UnityDriver(send, { captureDir: tmpDir, alignedCaptureFps: 60 });

    const started = Date.now();
    const outcome = await driver.capture("cap", 2000);
    const elapsed = Date.now() - started;

    assert.equal(outcome.artifact, path.join(tmpDir, "cap.png"));
    assert.deepEqual(await fs.readFile(outcome.artifact!), PNG_BYTES);
    assert.equal(outcome.framesElapsed, 15, "the bridge's own frame count rides into the report");
    assert.equal(outcome.harnessFault, undefined);
    assert.deepEqual(
      calls.map((c) => c.command),
      ["replay.settle_and_capture"],
      "exactly one call: no editor.screenshot, no second round trip",
    );
    assert.ok(elapsed < 1500, `the 2000ms settle must NOT be slept here (took ${elapsed}ms)`);

    const call = calls[0]!;
    assert.equal(call.params.settleFrames, 120, "2000ms at 60 fps");
    assert.equal(call.params.captureFps, 60);
    assert.equal(call.params.format, "png");
    assert.equal(call.params.view, "game");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("the driver STATES its own wire timeout, wider than the bridge's own deadline", async () => {
  const { send, calls } = fakeBridge(alignedOk());
  const driver = new UnityDriver(send, { captureDir: await tmpRoot(), alignedCaptureFps: 60 });
  await driver.capture("cap", 1000);

  const call = calls[0]!;
  const settleFrames = call.params.settleFrames as number;
  const expected = (settleFrames / 60) * 1000 + 15000;
  assert.equal(call.timeoutMs, expected, "settleFrames/fps*1000 + 15000, stated at the call");
  // THE ORDERING THAT MATTERS: the bridge's deadline is the settle plus 8s, so this timer
  // must be looser. If it fired first, a measurable harness fault would arrive as an
  // anonymous transport timeout and the run would lose the reason.
  const bridgeDeadlineMs = (settleFrames / 60) * 1000 + 8000;
  assert.ok(call.timeoutMs! > bridgeDeadlineMs, "the bridge must be the one that decides");
});

test("WALL-CLOCK PARITY: with no alignedCaptureFps the capture path is byte-for-byte the old one", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wallclock-cap-"));
  try {
    const { send, calls } = fakeBridge({
      "editor.screenshot": () => ({ data: { image_base64: PNG_BYTES.toString("base64"), format: "png" } }),
      ...alignedOk(),
    });
    const driver = new UnityDriver(send, { captureDir: tmpDir });

    const outcome = await driver.capture("cap", 5);

    assert.deepEqual(
      calls.map((c) => c.command),
      ["editor.screenshot"],
      "the legacy path must never reach the aligned op",
    );
    assert.deepEqual(calls[0]!.params, { view: "game", format: "png" });
    assert.equal(calls[0]!.timeoutMs, 15000);
    assert.equal(outcome.artifact, path.join(tmpDir, "cap.png"));
    assert.equal(outcome.framesElapsed, undefined, "no aligned evidence on an unaligned run");
    assert.equal(outcome.harnessFault, undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("a settle the editor could not deliver is a HARNESS FAULT with no artifact, never drift", async () => {
  const { send } = fakeBridge({
    "replay.settle_and_capture": () => ({
      error:
        "replay.settle_and_capture hit its wall-clock budget (10s, spent 10.1s) after 40 of 120 settle frames " +
        "at 60 fps: HARNESS FAULT (capture tier)",
      code: "TIMEOUT",
    }),
  });
  const driver = new UnityDriver(send, { captureDir: await tmpRoot(), alignedCaptureFps: 60 });

  const outcome = await driver.capture("cap", 2000);
  assert.equal(outcome.artifact, undefined, "no frame is reported for a settle that did not complete");
  assert.equal(outcome.sha256, undefined);
  assert.match(outcome.harnessFault ?? "", /aligned settle failed for capture "cap"/);
  assert.match(outcome.harnessFault ?? "", /HARNESS FAULT/);
});

test("an aligned response with no image is a harness fault, not a silent empty capture", async () => {
  const { send } = fakeBridge({ "replay.settle_and_capture": () => ({ data: { framesElapsed: 15 } }) });
  const driver = new UnityDriver(send, { captureDir: await tmpRoot(), alignedCaptureFps: 60 });
  const outcome = await driver.capture("cap", 100);
  assert.equal(outcome.artifact, undefined);
  assert.match(outcome.harnessFault ?? "", /returned no image/);
});

test("the physics cadence advisory prints ONCE per drive, from the project's real fixedDeltaTime", async () => {
  const tmpDir = await tmpRoot();
  const { send } = fakeBridge(alignedOk({ fixedDeltaTime: 0.02 }));
  const driver = new UnityDriver(send, { captureDir: tmpDir, alignedCaptureFps: 60 });

  const { out } = await captured(async () => {
    await driver.capture("a", 250);
    await driver.capture("b", 250);
  });
  const occurrences = out.split("physics steps").length - 1;
  assert.equal(occurrences, 1, `the advisory is per drive, not per capture (saw ${occurrences})`);
  assert.match(out, /physics steps 5 times every 6 frame/);
});

test("an EVEN cadence prints nothing at all (the advisory is not noise)", async () => {
  const { send } = fakeBridge(alignedOk({ fixedDeltaTime: 0.02 }));
  const driver = new UnityDriver(send, { captureDir: await tmpRoot(), alignedCaptureFps: 50 });
  const { out } = await captured(() => driver.capture("a", 200));
  assert.doesNotMatch(out, /physics steps/);
});

// ───────────────────────── 6. the anchor: stamp, refuse, accumulate ─────────────────────

test("a CLOCK DISCIPLINE mismatch refuses the pixel comparison as a harness fault, never drift", async () => {
  const root = await tmpRoot();
  try {
    const { paths, actual, png } = await approvedTrace(root, { alignedCaptureFps: 60 });

    // Byte-identical frames: at a MATCHED clock this is a clean match, so any non-match
    // below is the discipline rule and nothing else.
    const unaligned = artifactWith(actual, png, {});
    await captured(() => applyVisualDiff(paths, "demo", unaligned));
    assert.equal(unaligned.visualHarnessFault, true, "wall-clock run vs aligned anchor is a harness fault");
    assert.notEqual(unaligned.visualDrift, true, "…and NEVER drift");
    assert.equal(unaligned.segments[0]!.captures[0]!.visualStatus, undefined, "an untrusted anchor grades nothing");

    // A different FPS is just as incomparable as no alignment at all.
    const wrongFps = artifactWith(actual, png, { alignedCaptureFps: 30 });
    await captured(() => applyVisualDiff(paths, "demo", wrongFps));
    assert.equal(wrongFps.visualHarnessFault, true);

    // Control: the matching discipline grades cleanly.
    const matched = artifactWith(actual, png, { alignedCaptureFps: 60 });
    await captured(() => applyVisualDiff(paths, "demo", matched));
    assert.notEqual(matched.visualHarnessFault, true);
    assert.equal(matched.segments[0]!.captures[0]!.visualStatus, "match");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an ALIGNED run against a WALL-CLOCK anchor refuses too (the absence is a value, not a gap)", async () => {
  const root = await tmpRoot();
  try {
    const { paths, actual, png } = await approvedTrace(root, {});
    const aligned = artifactWith(actual, png, { alignedCaptureFps: 60 });
    const { out } = await captured(() => applyVisualDiff(paths, "demo", aligned));
    assert.equal(aligned.visualHarnessFault, true);
    assert.match(out, /a wall-clock settle \(unaligned\)/);
    assert.match(out, /a capture-aligned settle at 60 fps/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baselineFault ACCUMULATES: two independent faults are both printed, not just the last one found", async () => {
  const root = await tmpRoot();
  try {
    const { paths, actual, png } = await approvedTrace(root, {
      replaySpeed: 4,
      alignedCaptureFps: 60,
    });
    // The run mismatches BOTH terms. Before the accumulation fix the pacing message
    // overwrote everything found earlier, so an operator fixed one fault, re-ran, and met
    // the next one it had never mentioned.
    const artifact = artifactWith(actual, png, { replaySpeed: 1 });
    const { out } = await captured(() => applyVisualDiff(paths, "demo", artifact));
    assert.equal(artifact.visualHarnessFault, true);
    assert.match(out, /approved at 4x pacing/, "the pacing fault is reported");
    assert.match(out, /different capture clocks/, "and so is the clock fault, in the same sentence");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hand-edited out-of-range alignedCaptureFps makes the manifest a typed error (read-side cap)", async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, "baseline");
    await fs.mkdir(dir, { recursive: true });
    await writeTraceBaselineManifest(dir, {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: "t",
      traceSha256: "0".repeat(64),
      approvedAt: "2026-07-29T00:00:00.000Z",
      sourceReportSha256: "0".repeat(64),
      pngs: [],
    });
    const rawPath = traceBaselineManifestPath(dir);
    for (const bogus of [999, 0, "60", 59.94]) {
      const doc = JSON.parse(await fs.readFile(rawPath, "utf-8")) as Record<string, unknown>;
      doc.alignedCaptureFps = bogus;
      await fs.writeFile(rawPath, JSON.stringify(doc));
      const loaded = await loadTraceBaselineManifest(dir);
      assert.ok(
        loaded !== null && "error" in (loaded as object),
        `${JSON.stringify(bogus)} must be a typed error, not a coercion`,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a capture-step HARNESS FAULT tiers the RUN, and is never graded as drift", async () => {
  const root = await tmpRoot();
  try {
    const { paths, actual, png } = await approvedTrace(root, {});
    const artifact = artifactWith(actual, png, {});
    // The settle never completed, so this capture has no frame: the driver stamped the
    // reason instead. Without the tier this event would vanish (a capture with no artifact
    // is skipped) and the run would come out green with one fewer comparison.
    artifact.segments[0]!.captures[0]!.artifact = undefined;
    artifact.segments[0]!.captures[0]!.harnessFault = "aligned settle failed: wall-clock budget";

    const { out } = await captured(() => applyVisualDiff(paths, "demo", artifact));
    assert.equal(artifact.visualHarnessFault, true, "a capture gap is tier 2, not a pass");
    assert.notEqual(artifact.visualDrift, true, "…and never drift");
    assert.match(out, /HARNESS FAULT \(no comparable frame, not drift\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve RE-DERIVES the capture clock from the report, so re-anchoring works in both directions", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const png = tinyPng(10);
    const actual = path.join(paths.replayReports, "demo", "actual", "cap.png");
    await fs.mkdir(path.dirname(actual), { recursive: true });
    await fs.writeFile(actual, png);
    await fs.mkdir(paths.replayTraces, { recursive: true });
    await fs.writeFile(
      path.join(paths.replayTraces, "demo.trace.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "demo",
        start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
        input: { backend: "ui-events" },
        segments: [{ id: "s", actions: [] }],
        outcome: { expected: "success" },
      }),
    );
    const writeReport = async (alignedCaptureFps?: number): Promise<void> => {
      await fs.mkdir(paths.replayReports, { recursive: true });
      await fs.writeFile(
        path.join(paths.replayReports, "demo.report.json"),
        `${JSON.stringify(artifactWith(actual, png, alignedCaptureFps === undefined ? {} : { alignedCaptureFps }), null, 2)}\n`,
      );
    };
    const manifest = async (): Promise<TraceBaselineManifest> => {
      const loaded = await loadTraceBaselineManifest(path.join(paths.replayBaselines, "demo"));
      assert.ok(loaded !== null && !("error" in loaded), JSON.stringify(loaded));
      return loaded as TraceBaselineManifest;
    };

    // Approve a run captured under an aligned clock: the anchor records that clock.
    await writeReport(60);
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    assert.equal((await manifest()).alignedCaptureFps, 60);

    // Approve a WALL-CLOCK run over it: the field is dropped, not carried. Carrying it would
    // mislabel these frames and leave no way back to the unaligned discipline.
    await writeReport(undefined);
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    assert.equal((await manifest()).alignedCaptureFps, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an ALIGNED run that still drifts PRINTS the residual, through the real summary block", async () => {
  const root = await tmpRoot();
  try {
    const { actual, png } = await approvedTrace(root, {});
    const drifted = artifactWith(actual, png, { alignedCaptureFps: 60, visualDrift: true });
    drifted.segments[0]!.captures[0]!.visualStatus = "drift";
    drifted.segments[0]!.captures[0]!.diffFraction = 0.013;

    const { out } = await captured(() => {
      printSummary(root, "demo", drifted, path.join(root, "r.json"), undefined, true);
      return 0;
    });
    assert.match(out, /pixel-drift regression/);
    assert.match(out, /aligned replay still drifts/, "the residual rides with the number that invites the wrong conclusion");
    assert.match(out, /NOT proof/);

    // And it does NOT appear for a WALL-CLOCK run: nothing was aligned, so there is no
    // "still" to qualify, and printing it there would be a claim about a run that never
    // made one.
    const wall = artifactWith(actual, png, { visualDrift: true });
    wall.segments[0]!.captures[0]!.visualStatus = "drift";
    wall.segments[0]!.captures[0]!.diffFraction = 0.013;
    const plain = await captured(() => {
      printSummary(root, "demo", wall, path.join(root, "r.json"), undefined, true);
      return 0;
    });
    assert.doesNotMatch(plain.out, /aligned replay still drifts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────────────────── the CLI flags ─────────────────────────

test("--aligned / --aligned-fps are replay-only, and the range refuses at parse time", async () => {
  for (const sub of ["record", "approve", "tolerance", "report", "replay-all", "mask"]) {
    const { value } = await captured(() => runTrace([sub, "--id", "x", "--aligned"]));
    assert.equal(value, 2, `${sub} must refuse --aligned`);
  }
  for (const bad of ["9", "121", "59.94", "sixty"]) {
    const { value } = await captured(() => runTrace(["replay", "--id", "x", "--aligned-fps", bad]));
    assert.equal(value, 2, `--aligned-fps ${bad} must refuse at parse time`);
  }
});

test("the help states what alignment covers AND what it does not", async () => {
  const { value, out } = await captured(() => runTrace(["--help"]));
  assert.equal(value, 0);
  assert.match(out, /--aligned\b/);
  assert.match(out, /--aligned-fps <n>/);
  assert.match(out, /same GAME\s+TIME every run/);
  // The honest residual is in the help, not only in the failure path.
  assert.match(out, /Alignment covers the SETTLE/);
  assert.match(out, /action round trips, anchor polling, unseeded randomness/);
});

test("the residual sentence names the two unaligned windows and refuses to call drift proof", () => {
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /action\s+round trips/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /anchor polling/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /NOT proof/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /realtime|unseeded/);
});
