/**
 * THE DRIFT CHARACTERIZATION SURVIVES THE ROUND TRIP THROUGH DISK.
 *
 * The two-run discriminator is not one function: it is a WRITE by run one and a READ by
 * run two, with `<id>.report.json` between them. Everything that already tests it tests
 * one half. `deriveMaskSuggestion` is called directly with two hand-built evidence arrays,
 * and the `applyVisualDiff` tests hand-write the predecessor report with
 * `JSON.stringify(artifact)` before grading again. Both prove the predicate. Neither
 * proves that the verb writes a report its own successor can read, which is the only
 * claim an operator running `trace replay` twice is relying on.
 *
 * That is the same "tests the predicate, not that the door calls it" shape an audit found
 * across eleven gates on 2026-08-12, and it is why this file drives the REAL `trace
 * replay` verb, twice, through the `clientFactory` seam: argv, the live driver, the
 * manifest read, `applyVisualDiff`, the report write, and then the next run's read of that
 * exact file. No hand-written predecessor anywhere.
 *
 * The live episode that prompted it, on KidsAdventure, was NOT a defect in the
 * discriminator: the "second run" turned out to be the first run's own terminal output,
 * re-read. The report on disk was never rewritten (mtime 07:37:48Z against a claimed
 * 07:44Z run), and a three-run replay of those exact artifacts through this seam produced
 * `first-run` then `identical` then `identical`. What the tool actually lacked was any way
 * for a human to tell those two situations apart, so this file also pins the two lines
 * that now make it answerable:
 *
 *  - `first-run` STATES THE FINDING it rests on ("no previous run recorded drift"), so an
 *    operator who has already re-run can tell that the tool never saw their run;
 *  - the report line carries the run's own `finishedAt`, so a scrollback paste and a fresh
 *    run are not the same text.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ───────────────────────── fixtures ─────────────────────────

const W = 64;
const H = 64;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** A white WxH PNG with `rects` painted black: a frame whose drift has a known shape. */
function pngWithRects(rects: readonly { x: number; y: number; w: number; h: number }[]): Buffer {
  const px = new Uint8Array(W * H * 4).fill(255);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const i = (y * W + x) * 4;
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
      }
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  let o = 0;
  for (let y = 0; y < H; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      raw[o++] = px[i]!;
      raw[o++] = px[i + 1]!;
      raw[o++] = px[i + 2]!;
      raw[o++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CLEAN = pngWithRects([]);

/**
 * The bridge the replay drives, answering a whole trace: reset, taps, anchors, captures.
 * `frameFor` is asked for the PNG of each capture as the run reaches it, so a test can
 * change what the "game" renders between runs without touching any file the verb owns.
 */
function scriptedClient(frameFor: (captureId: string) => Buffer): () => {
  isConnected: boolean;
  waitForReconnect: () => Promise<boolean>;
  connect: () => Promise<unknown>;
  send: (command: string, params: Record<string, unknown>) => Promise<BridgeResponse>;
  disconnect: () => Promise<void>;
} {
  return () => {
    // The capture ids in trace order, consumed one per settle: the driver asks for a frame
    // per capture step and the fixture answers in the same order the trace declares them.
    let next = 0;
    const order = ["a", "b"];
    const frame = (): Buffer => frameFor(order[next++ % order.length]!);
    const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
      "editor.wait_for": () => ({ waited_ms: 1 }),
      "editor.play": () => ({ play_mode: "playing" }),
      "editor.stop": () => ({}),
      "editor.set_run_in_background": () => ({}),
      "scene.open_scene": () => ({ opened: true }),
      "editor.console_logs": () => ({ logs: [] }),
      "ui.get_screen_rects": () => ({
        objects: [{ isVisible: true }],
        viewport: { width: W, height: H },
      }),
      "ui.dispatch_pointer": () => ({ actuated: true, raycastHit: true, handlersFired: ["click"] }),
      "runtime.wait_for_condition": () => ({ passed: true }),
      "editor.screenshot": () => ({ image_base64: frame().toString("base64"), format: "png" }),
      "replay.settle_and_capture": () => ({
        image_base64: frame().toString("base64"),
        format: "png",
        framesElapsed: 15,
        settledMs: 250,
        realtimeDeadlineHit: false,
        fixedDeltaTime: 0.02,
      }),
    };
    return {
      isConnected: true,
      waitForReconnect: async () => true,
      connect: async () => ({}),
      send: async (command: string, params: Record<string, unknown>) =>
        ({
          id: "t",
          timestamp: 0,
          status: "success",
          data: (handlers[command] ?? (() => ({})))(params) ?? {},
        }) as unknown as BridgeResponse,
      disconnect: async () => {},
    };
  };
}

/** A two-capture trace, written where the verb expects it. */
async function writeTrace(root: string): Promise<void> {
  const paths = standardReplayLayout(root);
  await fs.mkdir(paths.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(paths.replayTraces, "demo.trace.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "demo",
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: ["a", "b"].map((id) => ({
        id,
        actions: [{ do: "tap", locator: { path: "/Canvas/Button" } }],
        captures: [{ id, settleMs: 250 }],
      })),
      outcome: { expected: "success" },
    }),
  );
}

async function captured(fn: () => Promise<number>): Promise<{ exit: number; out: string }> {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { exit: await fn(), out };
  } finally {
    console.error = original;
  }
}

/** The whole verb, argv in, report on disk out. Nothing about the run is stubbed but Unity. */
async function replay(root: string, frameFor: (captureId: string) => Buffer): Promise<{ exit: number; out: string }> {
  return captured(() =>
    runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], {
      clientFactory: scriptedClient(frameFor),
    }),
  );
}

async function readReport(root: string): Promise<ReplayRunArtifact> {
  return JSON.parse(
    await fs.readFile(path.join(standardReplayLayout(root).replayReports, "demo.report.json"), "utf8"),
  ) as ReplayRunArtifact;
}

/**
 * A project with an approved all-clean baseline, frozen through the REAL `replay` +
 * `approve` verbs, so the anchor under test is one the tool itself produced.
 */
async function approvedProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drift-char-"));
  await writeTrace(root);
  const first = await replay(root, () => CLEAN);
  assert.equal(first.exit, 0, first.out);
  const approved = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
  assert.equal(approved.exit, 0, approved.out);
  return root;
}

const DRIFT_A = pngWithRects([{ x: 4, y: 4, w: 10, h: 10 }]);
const DRIFT_B = pngWithRects([{ x: 44, y: 44, w: 10, h: 10 }]);

// ───────────── 1. THE DELIVERABLE: two real runs, and the second characterizes ─────────────

/*
 * LITMUS, run 2026-08-12. BREAK, `trace.ts`, cut the predecessor read that feeds the
 * discriminator (the exact plumbing failure this test exists to catch):
 *     -  const previousEvidence = await readPreviousDriftEvidence(paths, id);
 *     +  const previousEvidence: CaptureDriftEvidence[] = []; void readPreviousDriftEvidence;
 *   OBSERVED (3 of the 5 tests in this file failed; this one first):
 *     ✖ TWO REAL RUNS: the second run characterizes the drift and never asks for another
 *       AssertionError [ERR_ASSERTION]: the predecessor report is on disk and it drifted;
 *       claiming "no previous run recorded drift" over it is a false statement about the
 *       evidence
 *         actual: 'first-run',
 *         expected: 'first-run',
 *         operator: 'notStrictEqual'
 *
 * Restored, all five pass. Note which tests did NOT fail: the two that never read a
 * predecessor. That is the shape of the hole this file fills.
 */
test("TWO REAL RUNS: the second run characterizes the drift and never asks for another", async () => {
  const root = await approvedProject();
  try {
    // RUN 1 drifts. Nothing has ever drifted before, so the honest verdict is `first-run`
    // and the honest advice is "run it again": that half must keep working.
    const one = await replay(root, () => DRIFT_A);
    const reportOne = await readReport(root);
    assert.equal(reportOne.maskSuggestion?.kind, "first-run", one.out);
    assert.match(one.out, /re-run the replay once more to characterize/);

    // RUN 2 drifts IDENTICALLY, and the only thing carrying run one's evidence into it is
    // the report run one wrote. This is the assertion the shipped tests never made: they
    // wrote that report themselves.
    const two = await replay(root, () => DRIFT_A);
    const reportTwo = await readReport(root);
    assert.notEqual(
      reportTwo.maskSuggestion?.kind,
      "first-run",
      'the predecessor report is on disk and it drifted; claiming "no previous run recorded drift" ' +
        "over it is a false statement about the evidence",
    );
    assert.deepEqual(reportTwo.maskSuggestion, {
      kind: "identical",
      captures: ["a", "b"],
      exact: true,
    });

    // …and the advice the operator was already following is NOT repeated.
    assert.doesNotMatch(
      two.out,
      /re-run the replay once more/,
      "the operator has already made the run the tool asked for; asking again is the loop",
    );
    assert.match(two.out, /the drift is IDENTICAL across two runs/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────── 2. the genuine first run keeps its verdict, and now states its basis ─────────────

/*
 * LITMUS, run 2026-08-12. BREAK, `visual-diff.ts`, restore the unfalsifiable line as it
 * shipped:
 *     -      return [ "no previous run recorded drift for this trace, …" ];
 *     +      return ["re-run replay once more to characterize the drift before masking."];
 *   OBSERVED:
 *     ✖ A GENUINE first run says `first-run`, and the line NAMES the finding it rests on
 *       AssertionError [ERR_ASSERTION]: an instruction with no stated basis is what an
 *       operator cannot check against their own history
 *         expected: /no previous run recorded drift for this trace/,
 *         operator: 'match'
 *
 * Restored, it passes.
 */
test("A GENUINE first run says `first-run`, and the line NAMES the finding it rests on", async () => {
  const root = await approvedProject();
  try {
    const one = await replay(root, () => DRIFT_A);
    assert.deepEqual((await readReport(root)).maskSuggestion, { kind: "first-run" });
    // The instruction alone is unfalsifiable: an operator who HAS re-run reads the same
    // sentence and cannot tell whether the tool ignored their run or never saw it. The
    // finding is what makes it checkable.
    assert.match(
      one.out,
      /no previous run recorded drift for this trace/,
      "an instruction with no stated basis is what an operator cannot check against their own history",
    );
    assert.match(one.out, /re-run the replay once more to characterize the drift before masking/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────── 3. drift that lands somewhere else is `moved`, through the same door ─────────────

/*
 * LITMUS, run 2026-08-12. BREAK, `visual-diff.ts`, collapse `moved` back into `first-run`:
 *     -    if (priorDrifted.length === 0) return { kind: "first-run" };
 *     +    return { kind: "first-run" };
 *   OBSERVED:
 *     ✖ TWO REAL RUNS: drift that lands somewhere else is `moved`, not another re-run request
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *       + actual - expected
 *         {
 *       +   kind: 'first-run'
 *       -   currentCaptures: [ 'b' ],
 *       -   kind: 'moved',
 *       -   previousCaptures: [ 'a' ]
 *         }
 *
 * Restored, it passes.
 */
test("TWO REAL RUNS: drift that lands somewhere else is `moved`, not another re-run request", async () => {
  const root = await approvedProject();
  try {
    // Run one drifts in capture `a` only, run two in capture `b` only: two complete,
    // readable reports whose drift simply moved.
    await replay(root, (id) => (id === "a" ? DRIFT_A : CLEAN));
    const two = await replay(root, (id) => (id === "b" ? DRIFT_A : CLEAN));

    assert.deepEqual((await readReport(root)).maskSuggestion, {
      kind: "moved",
      previousCaptures: ["a"],
      currentCaptures: ["b"],
    });
    assert.doesNotMatch(two.out, /re-run the replay once more/);
    assert.match(two.out, /the previous run WAS compared, and none of its drift recurs here/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────── 4. an unreadable predecessor fingerprint is `uncomparable`, never `first-run` ─────────────

/*
 * LITMUS, run 2026-08-12. BREAK, `visual-diff.ts`, fold the flag back into `first-run` as
 * it shipped:
 *     -    if (uncomparable.length > 0) return { kind: "uncomparable", captures: … };
 *     +    if (uncomparable.length > 0) return { kind: "first-run" };
 *   OBSERVED:
 *     ✖ A MANGLED predecessor fingerprint is `uncomparable`, and never claims there was no
 *       previous run
 *       AssertionError [ERR_ASSERTION]: the predecessor drifted on this very capture, so
 *       "no previous run recorded drift" is false
 *       + actual - expected
 *       + 'first-run'
 *       - 'uncomparable'
 *         operator: 'strictEqual'
 *
 * Restored, it passes.
 */
test("A MANGLED predecessor fingerprint is `uncomparable`, and never claims there was no previous run", async () => {
  const root = await approvedProject();
  try {
    await replay(root, () => DRIFT_A);

    // The report is a file an operator can edit, and this is the threat model the grid
    // validator exists for: a fingerprint that is no longer a fingerprint. Everything else
    // about the predecessor still says, plainly, that it drifted.
    const reportPath = path.join(standardReplayLayout(root).replayReports, "demo.report.json");
    const edited = JSON.parse(await fs.readFile(reportPath, "utf8")) as ReplayRunArtifact;
    for (const capture of edited.segments.flatMap((s) => s.captures)) {
      if (capture.visualStatus === "drift") {
        capture.driftGrid = [1, 2, 3];
        delete capture.driftDiffSha;
      }
    }
    await fs.writeFile(reportPath, `${JSON.stringify(edited, null, 2)}\n`);

    const two = await replay(root, () => DRIFT_A);
    const suggestion = (await readReport(root)).maskSuggestion;
    assert.equal(
      suggestion?.kind,
      "uncomparable",
      'the predecessor drifted on this very capture, so "no previous run recorded drift" is false',
    );
    assert.deepEqual(suggestion, { kind: "uncomparable", captures: ["a", "b"] });

    // The advice is still "run it again", because that is genuinely the next step, and it
    // now says WHY rather than borrowing the first-run claim.
    assert.match(two.out, /a previous run DID record drift on a, b/);
    assert.doesNotMatch(
      two.out,
      /no previous run recorded drift/,
      "an unreadable fingerprint leaves the question open; it does not make the predecessor disappear",
    );
    // And it never mints a rect off evidence it could not read. (The tolerance route below
    // it carries its own `--set`, which is why this names the MASK command specifically.)
    assert.doesNotMatch(two.out, /trace mask /);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────── 5. the output names WHICH run it belongs to ─────────────

/*
 * LITMUS, run 2026-08-12. BREAK, `trace.ts`, restore the unstamped report line:
 *     -    `[loombridge trace] report → ${…} (run finished ${artifact.finishedAt})`,
 *     +    `[loombridge trace] report → ${path.relative(root, reportJson)}`,
 *   OBSERVED:
 *     ✖ TWO CONSECUTIVE RUNS ARE DISTINGUISHABLE IN THE OUTPUT (a scrollback paste is not a
 *       fresh run)
 *       AssertionError [ERR_ASSERTION]: the summary must name the run it belongs to
 *       + actual - expected
 *       + undefined
 *       - '2026-08-12T08:08:10.930Z'
 *
 * Restored, it passes.
 */
test("TWO CONSECUTIVE RUNS ARE DISTINGUISHABLE IN THE OUTPUT (a scrollback paste is not a fresh run)", async () => {
  const root = await approvedProject();
  try {
    // The live misdiagnosis: two replays of an unchanged project print byte-identical
    // summaries, so re-reading run one's output is indistinguishable from making run two,
    // and "did you re-run?" cannot be answered from the text. It cost an investigation
    // that concluded the discriminator had regressed when it had not.
    const one = await replay(root, () => DRIFT_A);
    const stampOne = (await readReport(root)).finishedAt;
    const two = await replay(root, () => DRIFT_A);
    const stampTwo = (await readReport(root)).finishedAt;

    const stampOf = (out: string): string | undefined => /\(run finished ([^)]+)\)/.exec(out)?.[1];
    assert.equal(stampOf(one.out), stampOne, "the summary must name the run it belongs to");
    assert.equal(stampOf(two.out), stampTwo);
    assert.notEqual(stampOne, stampTwo, "two runs are two runs");
    // The stamp is the report's OWN field, so the line and the file on disk can be
    // compared: that is what makes "is this the run I just made?" answerable at all.
    assert.match(one.out, new RegExp(`report → .*demo\\.report\\.json \\(run finished ${stampOne}\\)`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
