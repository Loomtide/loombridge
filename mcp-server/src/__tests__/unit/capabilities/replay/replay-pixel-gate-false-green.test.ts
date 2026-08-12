/**
 * THE PIXEL GATE MAY NOT BE SILENT ABOUT NOT HAVING RUN.
 *
 * THE OBSERVATION, on a real consumer project. `loombridge trace replay`, run right after a
 * successful `trace approve`, wrote a report whose fifteen capture objects carried exactly
 * four keys each:
 *
 *     { "id": "step-1", "artifact": "…/step-1.png", "sha256": "dedfa802…", "framesElapsed": 118 }
 *
 * No `visualStatus`, no `baseline`, no `diffFraction`, no `toleranceUsed`. Not one of them
 * set to `no-baseline`: ABSENT. Beside them, `"status": "pass"`, and beside THAT, the
 * rendered `kids-adventure.report.html` led with a green `PASS` badge over fifteen frames
 * that nothing had compared to anything. The approved baseline was present, complete, and
 * bound to the trace on disk. The run had refused to grade (its capture clock did not match
 * the anchor's) and exited 2, but the page a human opens said PASS and the report said
 * nothing at all about why the comparison had not happened.
 *
 * The three shapes that produced it, each pinned below:
 *
 *  1. THE SKIP WAS UNRECORDED. `applyVisualDiff` left every visual field absent when the
 *     anchor was untrusted, so "refused to grade" and "had nothing to grade" were the same
 *     bytes on disk. Now: `visualStatus: "not-compared"`, plus a run-level
 *     `visualHarnessFaultReason` naming the term that refused.
 *
 *  2. THE PAGE DID NOT STATE THE TIER. The console summary has led with HARNESS FAULT since
 *     the aligned slice (BX2); `renderReplayReportHtml` was never included in that wave and
 *     went on rendering `artifact.status`. Now the badge, the banner and every capture chip
 *     state the tier, and a capture with no verdict renders as "not compared" rather than as
 *     nothing at all.
 *
 *  3. NOTHING COUNTED THE COMPARISONS. The run-level "did anything get compared?" fact lived
 *     in a local `anyCompared` that reached the tolerance stamp and no verdict. A run that
 *     graded zero of three approved anchors exited 0, silently. Now the anchor's own
 *     `pngs.length` is the denominator, both numbers are on the report, and
 *     `replayExitCode` reads them.
 *
 * LITMUS is recorded per test: the real code path is broken, the failure observed VERBATIM,
 * and the line restored. A guard whose failure nobody has seen is a guard nobody has tested.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  applyVisualDiff,
  comparisonShortfall,
  replayExitCode,
  run as runTrace,
} from "../../../../capabilities/replay/trace.js";
import { renderReplayReportHtml, reportVerdict } from "../../../../capabilities/replay/report-html.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ───────────────────────── fixtures ─────────────────────────

type Handler = (params: Record<string, unknown>) => { data?: unknown };

/** A tiny valid PNG whose first pixel is `r`, so two of them can differ perceptually. */
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

/**
 * The live client the replay drives. This is the seam the whole door is walked through:
 * argv → the manifest read that resolves the clock → the driver → the report and the page.
 * A test that called `applyVisualDiff` alone would never see the badge the operator saw.
 */
function scriptedClient(png: Buffer): () => {
  isConnected: boolean;
  waitForReconnect: () => Promise<boolean>;
  connect: () => Promise<unknown>;
  send: (command: string, params: Record<string, unknown>) => Promise<BridgeResponse>;
  disconnect: () => Promise<void>;
} {
  const handlers: Record<string, Handler> = {
    "editor.wait_for": () => ({ data: { waited_ms: 1 } }),
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.console_logs": () => ({ data: { logs: [] } }),
    "editor.screenshot": () => ({ data: { image_base64: png.toString("base64"), format: "png" } }),
    "replay.settle_and_capture": () => ({
      data: {
        image_base64: png.toString("base64"),
        format: "png",
        framesElapsed: 15,
        settledMs: 250,
        realtimeDeadlineHit: false,
        fixedDeltaTime: 0.02,
      },
    }),
  };
  return () => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: async (command: string, params: Record<string, unknown>) => {
      const handler = handlers[command] ?? (() => ({ data: {} }));
      return {
        id: "t",
        timestamp: 0,
        status: "success",
        data: handler(params).data ?? {},
      } as unknown as BridgeResponse;
    },
    disconnect: async () => {},
  });
}

/** A trace with `captureIds.length` capture steps, written where the verb expects it. */
async function writeTrace(root: string, captureIds: string[]): Promise<void> {
  const paths = standardReplayLayout(root);
  await fs.mkdir(paths.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(paths.replayTraces, "demo.trace.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "demo",
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: captureIds.map((id) => ({ id, actions: [], captures: [{ id, settleMs: 250 }] })),
      outcome: { expected: "success" },
    }),
  );
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-false-green-"));
}

/** Capture stderr for a block (the CLI prints its refusals there). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { value: await fn(), out };
  } finally {
    console.error = original;
  }
}

async function readReport(root: string): Promise<ReplayRunArtifact> {
  const paths = standardReplayLayout(root);
  return JSON.parse(
    await fs.readFile(path.join(paths.replayReports, "demo.report.json"), "utf8"),
  ) as ReplayRunArtifact;
}

/** The page with its base64 payloads removed, so an assertion reads the prose, not the pixels. */
async function readPage(root: string): Promise<string> {
  const paths = standardReplayLayout(root);
  const html = await fs.readFile(path.join(paths.replayReports, "demo.report.html"), "utf8");
  return html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "[PNG]");
}

// ───────────── 1. the reproduction, through the whole door ─────────────

test("THE REPRODUCTION: a replay whose anchor refuses to grade is never a green page", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(tinyPng(10));
    await writeTrace(root, ["cap"]);

    // The operator's real sequence: a run under one capture clock, approved, then a run
    // under another. The refusal itself is correct and loud on stderr; what shipped wrong
    // is everything it left behind on disk.
    //
    // THE TWO CLOCKS ARE NOW 60 AND 30, not wall-clock and 60. The unanchored first replay
    // takes the default, and the default became capture-aligned 60; typing `--aligned-fps 60`
    // at the second replay would AGREE with the anchor and grade cleanly, which would leave
    // this reproduction asserting nothing. The mismatch, not the particular pair, is the
    // subject.
    assert.equal((await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }))).value, 0);
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--aligned-fps", "30"], { clientFactory: factory }),
    );

    assert.equal(exit, 2, "the tier was already right; the evidence was not");
    const report = await readReport(root);

    // (1) THE SKIP IS RECORDED. This is the assertion that fails on the shipped code: the
    // observed report's captures carried only {id, artifact, sha256, framesElapsed}.
    const capture = report.segments[0]!.captures[0]!;
    assert.equal(capture.visualStatus, "not-compared", "an ungraded capture SAYS it was not graded");
    assert.ok(
      report.visualHarnessFaultReason && report.visualHarnessFaultReason.length > 0,
      "the report itself names the term that refused, not only the terminal that ran it",
    );
    assert.match(report.visualHarnessFaultReason!, /capture clock|capture-aligned|phase-incomparable/);

    // (3) THE COMPARISONS ARE COUNTED, against the anchor's own declared denominator.
    assert.equal(report.comparisonsExpected, 1);
    assert.equal(report.comparisonsPerformed, 0);
    assert.equal(comparisonShortfall(report)?.performed, 0);

    // (2) THE PAGE STATES THE TIER. The badge is the false green itself.
    const page = await readPage(root);
    assert.match(page, /<span class="badge">HARNESS FAULT<\/span>/, "the page leads with the tier the run earned");
    assert.doesNotMatch(page, /<span class="badge">PASS<\/span>/, "…and never with the actuation's word alone");
    assert.match(page, /holds NO opinion about the frames it did not compare/);
    assert.match(page, /pixel gate: 0 of 1 approved frame\(s\) compared/);
    assert.match(page, /not-compared/, "and the figure itself carries the verdict");

    // The console line is unchanged in kind and now carries the reason with it.
    assert.match(out, /HARNESS FAULT \(exit 2\)/);
    assert.match(out, /reason: .*capture-aligned/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS for the assertions above. Each break was applied to the real source, the suite was
 * rebuilt and re-run, and the failure was copied verbatim from the runner.
 *
 * BREAK 1, `trace.ts`, restore the silent skip in `applyVisualDiff`:
 *     -        capture.visualStatus = "not-compared";
 *     +        // capture.visualStatus = "not-compared";
 *   OBSERVED:
 *     ✖ THE REPRODUCTION: a replay whose anchor refuses to grade is never a green page
 *       AssertionError [ERR_ASSERTION]: an ungraded capture SAYS it was not graded
 *       + actual - expected
 *       + undefined
 *       - 'not-compared'
 *
 * BREAK 2, `report-html.ts`, restore the status-only badge:
 *     -  <h1>${esc(artifact.traceId)} <span class="badge">${esc(verdict.badge)}${blocked}</span></h1>
 *     +  <h1>${esc(artifact.traceId)} <span class="badge">${esc(artifact.status.toUpperCase())}${blocked}</span></h1>
 *   OBSERVED:
 *     ✖ THE REPRODUCTION: a replay whose anchor refuses to grade is never a green page
 *       AssertionError [ERR_ASSERTION]: the page leads with the tier the run earned
 *       … expected: /<span class="badge">HARNESS FAULT<\/span>/
 *       operator: 'match'
 *
 * BREAK 3, `trace.ts`, stop counting the comparisons:
 *     -    artifact.comparisonsExpected = declaredAnchors.length;
 *     +    artifact.comparisonsExpected = undefined;
 *   OBSERVED:
 *     ✖ THE REPRODUCTION: a replay whose anchor refuses to grade is never a green page
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *       + actual - expected
 *       + undefined
 *       - 1
 */

// ───────────── 2. the zero-comparison run, in the exact shape that shipped ─────────────

test("A RUN THAT COMPARED NOTHING CANNOT EXIT 0, even with a perfect baseline on disk", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(tinyPng(10));
    await writeTrace(root, ["cap"]);
    // Aligned, because the observed report was: `framesElapsed` is part of the capture
    // shape this test claims to reproduce, and it exists only under a pinned settle.
    const aligned = ["--aligned-fps", "60"];
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root, ...aligned], { clientFactory: factory }));
    await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root, ...aligned], { clientFactory: factory }));

    // THE REPORT THAT SHIPPED, byte for byte in the part that matters: a capture with a
    // frame, a sha, a frame count, and NO visual verdict, under `status: "pass"`. Fed to
    // the exit-code function that decides what the process returns.
    const asShipped: ReplayRunArtifact = JSON.parse(JSON.stringify(await readReport(root)));
    const shipped = asShipped.segments[0]!.captures[0]!;
    delete shipped.visualStatus;
    delete shipped.baseline;
    delete shipped.diffFraction;
    delete shipped.toleranceUsed;
    delete asShipped.visualDrift;
    delete asShipped.visualHarnessFault;
    delete asShipped.visualHarnessFaultReason;
    asShipped.comparisonsPerformed = 0;
    assert.deepEqual(
      Object.keys(shipped).sort(),
      ["artifact", "framesElapsed", "id", "sha256"].sort(),
      "this is the observed capture object, and nothing else",
    );
    assert.equal(asShipped.status, "pass");

    // The verdict reads the coverage, so deleting the flag does not launder the run.
    assert.equal(replayExitCode(asShipped, false), 2, "a pass that compared nothing is not a pass");

    // AND THE ABSENT COUNTERPART IS A REFUSAL, NOT A SKIP: a report that declares an
    // expectation and carries no count of what it met reads as zero.
    delete asShipped.comparisonsPerformed;
    assert.equal(replayExitCode(asShipped, false), 2, "an absent numerator is zero, never 'assume it was met'");

    // The page rendered from that same report leads with the tier, not with `status`.
    assert.equal(reportVerdict(asShipped).badge, "HARNESS FAULT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts`, drop the coverage clause from `replayExitCode`:
 *     -  if (comparisonShortfall(artifact) !== null) return 2;
 *     +  // if (comparisonShortfall(artifact) !== null) return 2;
 *   OBSERVED:
 *     ✖ A RUN THAT COMPARED NOTHING CANNOT EXIT 0, even with a perfect baseline on disk
 *       AssertionError [ERR_ASSERTION]: a pass that compared nothing is not a pass
 *       + actual - expected
 *       + 0
 *       - 2
 */

// ───────────── 3. a PARTIAL comparison is a shortfall, and names the frames ─────────────

test("a run that grades SOME of the approved anchors is a harness fault that names the rest", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(tinyPng(10));
    await writeTrace(root, ["cap-1", "cap-2", "cap-3"]);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    // The FIRST replay ran before any anchor existed, so its report has no denominator to
    // state. The covered run is the one after approve.
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));

    // The report is complete and green at this point: three of three.
    const full = await readReport(root);
    assert.equal(full.comparisonsExpected, 3);
    assert.equal(full.comparisonsPerformed, 3);
    assert.equal(replayExitCode(full, false), 0, "the guard is not vacuous: a covered run still passes");

    // Now the run stops producing two of the three captures, which is what a trace edit, a
    // segment that never runs, or a capture step that quietly stops firing all look like.
    // Every capture the run DOES produce still matches its baseline perfectly.
    const artifact: ReplayRunArtifact = JSON.parse(JSON.stringify(full));
    artifact.segments = artifact.segments.slice(0, 1);
    for (const capture of artifact.segments.flatMap((s) => s.captures)) {
      delete capture.visualStatus;
      delete capture.baseline;
      delete capture.diffFraction;
      delete capture.toleranceUsed;
    }
    delete artifact.visualHarnessFault;
    delete artifact.comparisonsExpected;
    delete artifact.comparisonsPerformed;

    const { out } = await captured(async () => applyVisualDiff(standardReplayLayout(root), "demo", artifact));

    assert.equal(artifact.comparisonsExpected, 3, "the denominator is the ANCHOR's, not the run's");
    assert.equal(artifact.comparisonsPerformed, 1);
    assert.equal(artifact.visualHarnessFault, true, "one of three is no verdict about the other two");
    assert.equal(artifact.visualDrift, undefined, "…and never a game defect");
    assert.match(artifact.visualHarnessFaultReason!, /cap-2, cap-3 were never graded/);
    assert.match(out, /did NOT cover its anchor/);
    assert.match(out, /1 of 3 approved frame\(s\) were compared/);
    assert.equal(replayExitCode(artifact, false), 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts`, stop deriving the ungraded set:
 *     -  const ungradedAnchors = (declaredAnchors ?? []).filter((captureId) => !gradedCaptures.has(captureId));
 *     +  const ungradedAnchors: string[] = [];
 *   OBSERVED:
 *     ✖ a run that grades SOME of the approved anchors is a harness fault that names the rest
 *       AssertionError [ERR_ASSERTION]: one of three is no verdict about the other two
 *       + actual - expected
 *       + undefined
 *       - true
 */

// ───────────── 4. an unreadable anchor is visible, and never a bare pass ─────────────

test("an UNREADABLE baseline produces an explicit outcome on the report AND on the page", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(tinyPng(10));
    await writeTrace(root, ["cap"]);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));

    // Truncate the approved frame IN PLACE. Its sha no longer matches the manifest, so the
    // anchor is untrusted before a single pixel is read: an unresolvable baseline, which is
    // the class the observed run belonged to.
    const baseline = path.join(standardReplayLayout(root).replayBaselines, "demo", "cap.png");
    await fs.writeFile(baseline, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { value: exit } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 2, "never a pass");

    const report = await readReport(root);
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "not-compared");
    assert.match(report.visualHarnessFaultReason!, /sha256 mismatch|missing/);
    assert.equal(report.comparisonsPerformed, 0);

    const page = await readPage(root);
    assert.match(page, /<span class="badge">HARNESS FAULT<\/span>/);
    assert.match(page, /Reason: .*(sha256 mismatch|missing)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────────── 5. the renderer refuses an absent bound field ─────────────

test("renderReplayReportHtml: a capture with NO verdict renders as 'not compared', never as nothing", () => {
  // The pure-renderer half of the rule, and the one that protects against a future skip
  // path nobody has written yet: whatever leaves a capture ungraded, the page says so.
  const artifact = {
    traceId: "demo",
    status: "pass",
    resetTier: "scene",
    segments: [{ id: "s1", status: "pass", anchorsReached: [], captures: [{ id: "cap" }] }],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
  } as unknown as ReplayRunArtifact;

  const html = renderReplayReportHtml(artifact, [{ id: "cap", segment: "s1", base64: "AAAA" }]);
  assert.match(html, /not compared/, "an absent verdict is rendered, not skipped");

  // …and when the harness named a cause, the figure carries it.
  const withCause = renderReplayReportHtml(artifact, [
    { id: "cap", segment: "s1", base64: "AAAA", harnessFault: "the settle never completed" },
  ]);
  assert.match(withCause, /not compared: the settle never completed/);
});

/*
 * LITMUS. BREAK, `report-html.ts`, restore the falsy skip in `captureFigure`:
 *     -  } else if (c.visualStatus === undefined) {
 *     -    … "not compared" …
 *     -  } else {
 *     +  } else if (c.visualStatus) {
 *   OBSERVED:
 *     ✖ renderReplayReportHtml: a capture with NO verdict renders as 'not compared', never as nothing
 *       AssertionError [ERR_ASSERTION]: an absent verdict is rendered, not skipped
 *       … expected: /not compared/
 *       operator: 'match'
 */

// ───────────── 6. the anchor is bound to ITS demonstration at grade time ─────────────

test("editing an approved trace makes `trace replay` refuse, not grade the new demo on the old frames", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(tinyPng(10));
    await writeTrace(root, ["cap"]);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));

    // A DIFFERENT DEMONSTRATION under the same id. The frozen frames answer a question this
    // trace no longer asks. Unified `verify` has always refused this; the `trace replay`
    // door graded it `match` and exited 0, because its call site never handed
    // `verifyTraceBaseline` the trace path it had in hand.
    await writeTrace(root, ["cap", "cap-2"]);

    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 2, "the frames were approved for another demonstration");
    assert.match(out, /approved for a different demonstration/);
    const report = await readReport(root);
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "not-compared");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts`, drop the binding at the grade-time call site:
 *     -  const integrity = await verifyTraceBaseline(baselineDir, { tracePath });
 *     +  const integrity = await verifyTraceBaseline(baselineDir);
 *   OBSERVED:
 *     ✖ editing an approved trace makes `trace replay` refuse, not grade the new demo on the old frames
 *       AssertionError [ERR_ASSERTION]: the frames were approved for another demonstration
 *       + actual - expected
 *       + 0
 *       - 2
 */
