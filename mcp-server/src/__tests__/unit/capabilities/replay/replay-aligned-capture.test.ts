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
 *     every reason an anchor is untrustworthy is printed, not just the last one found;
 *  7. the WHOLE door composes: the trace verb, the manifest read, the live runner and the real
 *     driver, driven against a scripted bridge, actually SEND the aligned op (a pass-through
 *     nobody walks is how a report comes to stamp an aligned clock over wall-clock frames);
 *  8. the approve boundary refuses a run the harness could not complete, refuses an aligned
 *     report with no frame evidence, refuses anchor terms its own reader would refuse, and
 *     announces a capture-clock change in both directions;
 *  9. the printed verdict states the worst tier, never the engine's word for one layer of it.
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
  alignedFloorMs,
  alignedSettleFrames,
  physicsCadenceNote,
} from "../../../../capabilities/replay/aligned-capture.js";
import {
  applyVisualDiff,
  printSummary,
  replayExitCode,
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
        // `framesElapsed` rides on every fixture capture because an ALIGNED artifact without
        // it is now a harness fault by itself (BX5): the aligned stamp has to be bound to the
        // bridge's own frame count. The wall-clock fixtures carry it harmlessly (nothing reads
        // it there), so one fixture serves both and the BX5 rule gets its own dedicated tests.
        captures: [{ id: "cap", artifact: actual, sha256: sha256(png), framesElapsed: 15 }],
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
    // UNGRADED IS WRITTEN DOWN, not left absent. This assertion used to read `undefined`,
    // which is how the false green survived: a capture nothing compared was byte-identical
    // in the report to a capture the tool never considered.
    assert.equal(
      unaligned.segments[0]!.captures[0]!.visualStatus,
      "not-compared",
      "an untrusted anchor grades nothing, and SAYS SO",
    );

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
  // AX3: the help makes a BEHAVIOURAL claim about inheritance, and a claim in help text with
  // nothing walking it is a promise the tool can quietly stop keeping. The walker is the
  // COMPOSITION test above ("a baseline stamped with a capture clock makes the real driver
  // send the aligned op"), which stamps 30 fps into a manifest, types no flag, and asserts the
  // op really went out at 30. This assertion pins the sentence those two have to agree on.
  assert.match(out, /Default: the baseline's stamped capture clock, else aligned 60 fps\./);
  // AX4: the help ALSO makes the compatibility promise the fallback change rests on, and the
  // two COMPOSITION tests below are what walk it: a stamped wall-clock anchor keeps its clock,
  // and only an unanchored run moves. A promise in help text with nothing walking it is a
  // promise the tool can quietly stop keeping.
  assert.match(out, /A stamped baseline always wins, in both directions/);
});

test("the residual sentence names the two unaligned windows and refuses to call drift proof", () => {
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /action\s+round trips/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /anchor polling/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /NOT proof/);
  assert.match(ALIGNED_RESIDUAL_SENTENCE, /realtime|unseeded/);
});

// ═════════════ AX2/AX3: the COMPOSITION, driven end to end against a scripted bridge ═══════
//
// Everything above tests a layer. This drives the WHOLE door an operator uses:
//
//   trace run(argv) → replayOneTrace → resolveAlignedCaptureFps (reads the manifest on disk)
//                   → runLiveReplay → the REAL UnityDriver → a scripted bridge
//
// It exists because the aligned fps reached the driver through a pass-through nothing walked.
// Delete `alignedCaptureFps` from the object `run-live` builds and every layer test above
// still passes: the driver would take the wall-clock path on every real replay while the
// report kept stamping `alignedCaptureFps`, minting a FALSE ALIGNED ANCHOR from unaligned
// frames. The only way to catch that is to assert the op is really sent.

interface ScriptedClient {
  readonly isConnected: boolean;
  waitForReconnect(timeoutMs?: number): Promise<boolean>;
  connect(): Promise<unknown>;
  send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponse>;
  disconnect(): Promise<void>;
}

/** A `UnityClient`-shaped fake over the same scripted-handler fixture used above. */
function scriptedClient(handlers: Record<string, Handler>): {
  factory: () => ScriptedClient;
  calls: Recorded[];
} {
  const { send, calls } = fakeBridge(handlers);
  const factory = (): ScriptedClient => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: (command, params, timeoutMs) => send(command, params, timeoutMs),
    disconnect: async () => {},
  });
  return { factory, calls };
}

/** A minimal replayable trace with ONE capture, written where the verb expects it. */
async function writeTrace(paths: ReturnType<typeof standardReplayLayout>, settleMs: number): Promise<string> {
  await fs.mkdir(paths.replayTraces, { recursive: true });
  const body = JSON.stringify({
    schemaVersion: "0.1",
    id: "demo",
    start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [{ id: "s1", actions: [], captures: [{ id: "cap", settleMs }] }],
    outcome: { expected: "success" },
  });
  await fs.writeFile(path.join(paths.replayTraces, "demo.trace.json"), body);
  return body;
}

/** The bridge answers a whole drive: reset, the capture, console health, teardown. */
function driveHandlers(png: Buffer, over: Record<string, unknown> = {}): Record<string, Handler> {
  return {
    "editor.wait_for": () => ({ data: { waited_ms: 1 } }),
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.console_logs": () => ({ data: { logs: [] } }),
    "editor.screenshot": () => ({ data: { image_base64: png.toString("base64"), format: "png" } }),
    "replay.settle_and_capture": () => ({
      data: {
        image_base64: png.toString("base64"),
        format: "png",
        framesElapsed: 8,
        settledMs: 266.667,
        realtimeDeadlineHit: false,
        fixedDeltaTime: 0.02,
        ...over,
      },
    }),
  };
}

test("COMPOSITION: a baseline stamped with a capture clock makes the real driver send the aligned op", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const png = tinyPng(10);
    const traceBody = await writeTrace(paths, 300);

    // The anchor carries BOTH terms this run has to inherit with no flag typed: 4x pacing and
    // a 30 fps capture clock. 300ms scaled by 4 is 75ms, floored to 250ms, which is 8 frames
    // at 30 fps (266.7ms of game time). Every one of those numbers is a different rule, and
    // the op the driver sends is where they all have to agree.
    const baselineDir = path.join(paths.replayBaselines, "demo");
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, "cap.png"), png);
    await writeTraceBaselineManifest(baselineDir, {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: "demo",
      traceSha256: sha256(Buffer.from(traceBody)),
      approvedAt: "2026-07-29T00:00:00.000Z",
      sourceReportSha256: "0".repeat(64),
      pngs: [{ captureId: "cap", sha256: sha256(png) }],
      replaySpeed: 4,
      alignedCaptureFps: 30,
    });

    const { factory, calls } = scriptedClient(driveHandlers(png));
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], { clientFactory: factory }),
    );
    assert.equal(exit, 0, out);

    const settle = calls.find((c) => c.command === "replay.settle_and_capture");
    assert.ok(settle, `the aligned op was never sent (calls: ${calls.map((c) => c.command).join(", ")})`);
    assert.equal(settle!.params.captureFps, 30, "the STAMPED clock, inherited with no flag typed (AX3)");
    assert.equal(settle!.params.settleFrames, 8, "250ms floor at 30 fps, converted ONCE after --speed scaling");
    assert.equal(
      calls.some((c) => c.command === "editor.screenshot"),
      false,
      "an aligned run must never fall back to the wall-clock screenshot",
    );

    // BX8: the floor is printed as the run EXPERIENCES it, not as the wall-clock constant.
    assert.match(out, /floor 8 frame\(s\) = 266\.7ms of game time at 30 fps/);

    // The report stamps what really happened, and the frames graded against the anchor.
    const report = JSON.parse(
      await fs.readFile(path.join(paths.replayReports, "demo.report.json"), "utf-8"),
    ) as ReplayRunArtifact;
    assert.equal(report.alignedCaptureFps, 30);
    assert.equal(report.replaySpeed, 4);
    assert.equal(report.segments[0]!.captures[0]!.framesElapsed, 8, "the bridge's own frame count rides into the report");
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "match");
    assert.notEqual(report.visualHarnessFault, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * ═══ AX4: THE FALLBACK IS ALIGNED, AND A STAMPED ANCHOR STILL WINS ═══════════════════════
 *
 * These two tests are a PAIR and only mean something together. The first says the default
 * moved; the second says it moved for exactly one case. Deleting either leaves a claim
 * nothing walks:
 *
 *   - without the first, the default could silently revert to wall-clock;
 *   - without the second, the default could be applied UNCONDITIONALLY, re-clocking every
 *     anchor a human already approved under wall-clock and turning each of their next
 *     replays into a phase-incomparable harness fault. That is the failure mode with a
 *     blast radius, so it is the one asserted against the real door rather than the unit.
 *
 * LITMUS, both directions, applied to `resolveAlignedCaptureFps` in `trace.ts`, rebuilt and
 * re-run each time, then restored.
 *
 * BREAK A — put the fallback back to wall-clock:
 *     -    if (stampedFps === "wall-clock") return {};
 *     -    return { fps: DEFAULT_ALIGNED_CAPTURE_FPS };
 *     +    return {};
 *   OBSERVED VERBATIM:
 *     ✖ COMPOSITION: with NO baseline at all the door now takes the ALIGNED path at 60
 *       AssertionError [ERR_ASSERTION]: the aligned op was never sent (calls: editor.stop,
 *       editor.wait_for, scene.open_scene, editor.play, editor.wait_for,
 *       editor.set_run_in_background, editor.screenshot, editor.console_logs, editor.stop,
 *       editor.wait_for)
 *         expected: true, operator: '=='
 *
 * BREAK B — apply the new default UNCONDITIONALLY, ignoring a stamped wall-clock:
 *     -    if (stampedFps === "wall-clock") return {};
 *        (leaving `return { fps: DEFAULT_ALIGNED_CAPTURE_FPS };` for both absences)
 *   OBSERVED VERBATIM:
 *     ✖ COMPOSITION: a baseline stamped WALL-CLOCK still replays wall-clock (existing anchors
 *       are untouched)
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] capture-aligned replay at 60 fps:
 *       each settle runs inside the bridge's pinned tick loop and the frame is taken on the
 *       frame the settle completes.
 *
 *       2 !== 0
 *         expected: 0, operator: 'strictEqual'
 *   Exit 2, not a wrong verdict: the re-clocked run is refused as phase-incomparable. That is
 *   the honest tier and still the wrong ANSWER, because the operator changed nothing.
 */

test("COMPOSITION: with NO baseline at all the door now takes the ALIGNED path at 60", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const png = tinyPng(10);
    await writeTrace(paths, 5);

    const { factory, calls } = scriptedClient(driveHandlers(png));
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], { clientFactory: factory }),
    );
    assert.equal(exit, 0, out);

    const settle = calls.find((c) => c.command === "replay.settle_and_capture");
    assert.ok(settle, `the aligned op was never sent (calls: ${calls.map((c) => c.command).join(", ")})`);
    assert.equal(settle!.params.captureFps, DEFAULT_ALIGNED_CAPTURE_FPS, "the default clock, with no flag typed");
    assert.equal(
      calls.some((c) => c.command === "editor.screenshot"),
      false,
      "the default is aligned now, so nothing falls back to the wall-clock screenshot",
    );
    const report = JSON.parse(
      await fs.readFile(path.join(paths.replayReports, "demo.report.json"), "utf-8"),
    ) as ReplayRunArtifact;
    assert.equal(report.alignedCaptureFps, DEFAULT_ALIGNED_CAPTURE_FPS, "the run stamps the clock it really used");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("COMPOSITION: a baseline stamped WALL-CLOCK still replays wall-clock (existing anchors are untouched)", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const png = tinyPng(10);
    const traceBody = await writeTrace(paths, 5);

    // An anchor exactly as it exists on every project approved before the fallback changed:
    // a real manifest with NO `alignedCaptureFps`. A manifest that EXISTS pins a discipline
    // even when the field is absent — absent means wall-clock, which is a real answer and
    // not "no opinion" — and that distinction is the whole compatibility guarantee.
    const baselineDir = path.join(paths.replayBaselines, "demo");
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, "cap.png"), png);
    await writeTraceBaselineManifest(baselineDir, {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: "demo",
      traceSha256: sha256(Buffer.from(traceBody)),
      approvedAt: "2026-07-29T00:00:00.000Z",
      sourceReportSha256: "0".repeat(64),
      pngs: [{ captureId: "cap", sha256: sha256(png) }],
    });

    const { factory, calls } = scriptedClient(driveHandlers(png));
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], { clientFactory: factory }),
    );
    assert.equal(exit, 0, out);

    assert.equal(
      calls.some((c) => c.command === "replay.settle_and_capture"),
      false,
      "a wall-clock anchor must never be silently re-clocked by the new default",
    );
    assert.ok(calls.some((c) => c.command === "editor.screenshot"), "the legacy capture path is what it asked for");
    const report = JSON.parse(
      await fs.readFile(path.join(paths.replayReports, "demo.report.json"), "utf-8"),
    ) as ReplayRunArtifact;
    assert.equal(report.alignedCaptureFps, undefined, "absence is the wall-clock discipline, and stays absent");
    // …and because both sides agree, the pixel gate really RAN. A silently re-clocked run
    // would have been refused as phase-incomparable, which is the observable damage.
    assert.notEqual(report.visualHarnessFault, true, out);
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "match");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("COMPOSITION: --aligned-fps on the command line reaches the op too", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const png = tinyPng(10);
    await writeTrace(paths, 1000);

    const { factory, calls } = scriptedClient(driveHandlers(png));
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html", "--aligned-fps", "120"], {
        clientFactory: factory,
      }),
    );
    assert.equal(exit, 0, out);
    const settle = calls.find((c) => c.command === "replay.settle_and_capture");
    assert.ok(settle, "the explicit flag must reach the driver");
    assert.equal(settle!.params.captureFps, 120);
    assert.equal(settle!.params.settleFrames, 120, "1000ms at 120 fps");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX3: a lost connection is a HARNESS fault at this verb, never exit 1 ════════

test("a connection lost MID-RUN exits 2 with the connection hint, never the game-defect path", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    await writeTrace(paths, 100);
    // The exact shape `unity-client` throws when the socket drops with ops in flight: a plain
    // Error with no `UnityConnectionError` name, which is why it used to fall through to
    // `fatal` and exit 1 (a harness fault reported as a game defect).
    const factory = () => ({
      isConnected: true,
      waitForReconnect: async () => true,
      connect: async (): Promise<unknown> => {
        throw new Error("CONNECTION_LOST: code=1006 reason=");
      },
      send: async (): Promise<BridgeResponse> => {
        throw new Error("CONNECTION_LOST: code=1006 reason=");
      },
      disconnect: async () => {},
    });

    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], { clientFactory: factory }),
    );
    assert.equal(exit, 2, `a lost connection is the harness tier (got ${exit}): ${out}`);
    assert.match(out, /Lost the connection to Unity mid-run/);
    assert.doesNotMatch(out, /fatal:/, "it must not reach the generic fatal path");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX1: the approve boundary refuses a run the harness could not complete ══════

/** A workspace with an approved baseline plus a report on disk, ready for `approve`. */
async function approvable(
  root: string,
  reportOver: Partial<ReplayRunArtifact>,
  captureOver: Record<string, unknown> = {},
): Promise<{ paths: ReturnType<typeof standardReplayLayout>; baselineDir: string }> {
  const paths = standardReplayLayout(root);
  const png = tinyPng(10);
  const actual = path.join(paths.replayReports, "demo", "actual", "cap.png");
  await fs.mkdir(path.dirname(actual), { recursive: true });
  await fs.writeFile(actual, png);
  await writeTrace(paths, 100);
  const artifact = artifactWith(actual, png, reportOver);
  Object.assign(artifact.segments[0]!.captures[0]!, captureOver);
  await fs.mkdir(paths.replayReports, { recursive: true });
  await fs.writeFile(
    path.join(paths.replayReports, "demo.report.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return { paths, baselineDir: path.join(paths.replayBaselines, "demo") };
}

test("approve REFUSES a run with a capture-level harness fault, and prunes nothing (BX1)", async () => {
  const root = await tmpRoot();
  try {
    const { paths, baselineDir } = await approvable(root, {}, {
      artifact: undefined,
      harnessFault: "aligned settle failed for capture \"cap\": wall-clock budget",
    });
    // A previously approved frame for the SAME capture id. The refusal has to leave it alone:
    // the whole failure this closes is approve dropping the faulted capture, pruning its
    // baseline, and leaving the trace permanently green over a frame nobody grades.
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, "cap.png"), tinyPng(7));

    const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));

    assert.equal(exit, 2, "a harness fault is the harness tier, never a promotion");
    assert.match(out, /cannot approve "demo": the latest run carries a HARNESS FAULT/);
    assert.match(out, /cap \(aligned settle failed/, "the faulted capture and its cause are named");
    assert.deepEqual(
      (await fs.readdir(baselineDir)).sort(),
      ["cap.png"],
      "the previously approved frame survives an approve that refused",
    );
    assert.deepEqual(await fs.readFile(path.join(baselineDir, "cap.png")), tinyPng(7), "…unchanged");
    assert.equal(
      await fs.access(path.join(baselineDir, "baseline-manifest.json")).then(() => true, () => false),
      false,
      "a refused approve writes no manifest",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve ALLOWS a refused-comparison run, loudly: it is the mismatch escape (BX1)", async () => {
  const root = await tmpRoot();
  try {
    // `visualHarnessFault` with no per-capture fault and no unreadable capture is a run
    // whose COMPARISON was refused (a clock or pacing mismatch, a broken anchor): every
    // frame decodes and every settle completed. Approving from exactly this report is the
    // escape the mismatch refusal names; refusing it here locked the operator out of
    // re-anchoring entirely (found live: a wall-clock baseline could never migrate to an
    // aligned clock, and the pacing escape from the ratchet wave died with it). The consent
    // is the loud part: the note states the new anchor is minted WITHOUT any comparison.
    await approvable(root, { visualHarnessFault: true });
    const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(exit, 0, out);
    assert.match(out, /pixel comparison was REFUSED at grade time/);
    assert.match(out, /WITHOUT any comparison against the previous baseline/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve ANNOUNCES a capture-clock change in BOTH directions (BX1)", async () => {
  const root = await tmpRoot();
  try {
    const { paths } = await approvable(root, { alignedCaptureFps: 60 });
    const reportPath = path.join(paths.replayReports, "demo.report.json");
    const rewrite = async (fps?: number): Promise<void> => {
      const doc = JSON.parse(await fs.readFile(reportPath, "utf-8")) as ReplayRunArtifact;
      if (fps === undefined) delete doc.alignedCaptureFps;
      else doc.alignedCaptureFps = fps;
      await fs.writeFile(reportPath, `${JSON.stringify(doc, null, 2)}\n`);
    };

    // First approval: there was no anchor, so there is no CHANGE to consent to.
    const first = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(first.value, 0, first.out);
    assert.doesNotMatch(first.out, /capture clock changes/, "the first stamp is not a change");

    // Aligned → wall-clock: the anchor stops asking for a pinned settle, which silently
    // changes what every later replay must do. Never silent.
    await rewrite(undefined);
    const dropped = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(dropped.value, 0, dropped.out);
    assert.match(dropped.out, /the anchor's capture clock changes: a capture-aligned settle at 60 fps to a wall-clock settle/);

    // Wall-clock → aligned: the other direction says so too.
    await rewrite(30);
    const gained = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(gained.value, 0, gained.out);
    assert.match(gained.out, /the anchor's capture clock changes: a wall-clock settle \(unaligned\) to a capture-aligned settle at 30 fps/);

    // And an UNCHANGED clock says nothing: a consent line printed every time is noise, and
    // noise is what a reader learns to skip.
    const same = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(same.value, 0, same.out);
    assert.doesNotMatch(same.out, /capture clock changes/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX4: the WRITE side refuses what the read side would ════════════════════════

test("approve REFUSES a report carrying an anchor term the reader would refuse (BX4)", async () => {
  for (const [field, value, pattern] of [
    ["alignedCaptureFps", 999, /alignedCaptureFps/],
    ["alignedCaptureFps", 59.94, /alignedCaptureFps/],
    ["replaySpeed", 99, /replaySpeed/],
  ] as const) {
    const root = await tmpRoot();
    try {
      const { paths } = await approvable(root, {});
      const reportPath = path.join(paths.replayReports, "demo.report.json");
      const doc = JSON.parse(await fs.readFile(reportPath, "utf-8")) as Record<string, unknown>;
      doc[field] = value;
      await fs.writeFile(reportPath, JSON.stringify(doc, null, 2));

      const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
      assert.equal(exit, 2, `${field}=${value} must refuse the approval, not mint the anchor`);
      assert.match(out, /not a value an anchor can hold/);
      assert.match(out, pattern);
      assert.equal(
        await fs.access(path.join(paths.replayBaselines, "demo", "baseline-manifest.json")).then(() => true, () => false),
        false,
        "nothing is written when the terms are refused",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("the unreadable-manifest re-stamp note names EVERY dropped term, not just the tolerance (BX4)", async () => {
  const root = await tmpRoot();
  try {
    const { baselineDir } = await approvable(root, {});
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, "baseline-manifest.json"), "{ not json");

    const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(exit, 0, out);
    assert.match(out, /is unreadable/);
    assert.match(out, /NOTHING is carried forward/);
    for (const term of [/drift\s+tolerance/, /mask/, /pacing/, /capture\s+clock/]) {
      assert.match(out, term, `the note must name what is being lost: ${term}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX5: the aligned stamp is bound to frame evidence ═══════════════════════════

test("an ALIGNED capture with no framesElapsed is a HARNESS FAULT at grade time, never graded (BX5)", async () => {
  const root = await tmpRoot();
  try {
    const { paths, actual, png } = await approvedTrace(root, { alignedCaptureFps: 60 });
    const artifact = artifactWith(actual, png, { alignedCaptureFps: 60 });
    delete artifact.segments[0]!.captures[0]!.framesElapsed;

    const { out } = await captured(() => applyVisualDiff(paths, "demo", artifact));
    assert.equal(artifact.visualHarnessFault, true, "an unevidenced aligned stamp is tier 2");
    assert.notEqual(artifact.visualDrift, true, "…and never drift");
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, undefined, "it is not graded at all");
    assert.match(out, /carries no framesElapsed/);

    // Non-positive is the same absence wearing a number.
    const zero = artifactWith(actual, png, { alignedCaptureFps: 60 });
    zero.segments[0]!.captures[0]!.framesElapsed = 0;
    await captured(() => applyVisualDiff(paths, "demo", zero));
    assert.equal(zero.visualHarnessFault, true);

    // Control: a WALL-CLOCK run has no aligned claim to evidence, and grades exactly as before.
    const wall = await approvedTrace(root, {});
    const unaligned = artifactWith(wall.actual, wall.png, {});
    delete unaligned.segments[0]!.captures[0]!.framesElapsed;
    await captured(() => applyVisualDiff(wall.paths, "demo", unaligned));
    assert.notEqual(unaligned.visualHarnessFault, true);
    assert.equal(unaligned.segments[0]!.captures[0]!.visualStatus, "match");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve REFUSES an aligned report whose captures carry no frame evidence (BX5)", async () => {
  const root = await tmpRoot();
  try {
    const { paths } = await approvable(root, { alignedCaptureFps: 60 }, { framesElapsed: undefined });
    const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(exit, 2);
    assert.match(out, /claims a capture-aligned clock \(60 fps\) but 1 capture\(s\) carry no frame evidence/);
    assert.equal(
      await fs.access(path.join(paths.replayBaselines, "demo", "baseline-manifest.json")).then(() => true, () => false),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX2: the printed verdict reflects the worst tier ════════════════════════════

test("printSummary headlines a HARNESS FAULT instead of the engine's PASS (BX2)", async () => {
  const root = await tmpRoot();
  try {
    const { actual, png } = await approvedTrace(root, {});
    const artifact = artifactWith(actual, png, { visualHarnessFault: true });

    const { out } = await captured(() => {
      printSummary(root, "demo", artifact, path.join(root, "r.json"), undefined, false);
      return 0;
    });
    assert.match(out, /demo: HARNESS FAULT \(exit 2\): actuation pass/);
    assert.doesNotMatch(out, /demo: PASS/, "a bare PASS above a non-zero exit teaches the reader to trust the word");
    // The exit the headline claims is the one the tiering function really returns.
    assert.equal(replayExitCode(artifact, false), 2);

    // Control: a clean run reads exactly as it always did.
    const clean = artifactWith(actual, png, {});
    const plain = await captured(() => {
      printSummary(root, "demo", clean, path.join(root, "r.json"), undefined, false);
      return 0;
    });
    assert.match(plain.out, /demo: PASS/);
    assert.doesNotMatch(plain.out, /HARNESS FAULT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ═════════════ BX8: the cadence note stops contradicting itself ════════════════════════════

test("physicsCadenceNote: a hand-typed fixedDeltaTime reads as the whole step it plainly is (BX8)", () => {
  // 0.0166667 is what a human types for 1/60. At an absolute 1e-6 epsilon this was 0.999998
  // steps per frame: "uneven", no whole multiple inside 120 frames, and the note printed
  // "physics steps 1.000 times per frame ... which never lands on a whole frame".
  assert.equal(physicsCadenceNote(60, 0.0166667), null, "1.000 steps per frame is a whole step");
  assert.equal(physicsCadenceNote(30, 0.0333333), null);
  assert.equal(physicsCadenceNote(120, 0.00833333), null);

  // And the tolerance stays a tolerance: the real uneven case is three orders of magnitude
  // outside it and still reports its exact cadence.
  const note = physicsCadenceNote(60, 0.02);
  assert.match(note ?? "", /physics steps 5 times every 6 frame/);
  // Nothing may reach the self-contradicting fallback while claiming a whole rate.
  for (const [fps, step] of [[60, 0.0166667], [50, 0.02], [30, 0.0333333]] as const) {
    const text = physicsCadenceNote(fps, step);
    assert.doesNotMatch(text ?? "", /1\.000 times per frame.*never lands/);
  }
});

test("alignedFloorMs: the floor is quantized to the frame, and equals the constant when it divides (BX8)", () => {
  assert.equal(alignedFloorMs(250, 60), 250, "250ms is exactly 15 frames at 60 fps");
  assert.equal(alignedFloorMs(250, 24), 250, "…and exactly 6 frames at 24 fps");
  assert.equal(Math.round(alignedFloorMs(250, 30) * 10) / 10, 266.7, "8 frames at 30 fps is 266.7ms, not 250");
  assert.equal(Math.round(alignedFloorMs(250, 90) * 10) / 10, 255.6);
});
