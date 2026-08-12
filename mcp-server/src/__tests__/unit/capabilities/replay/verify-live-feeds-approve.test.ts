/**
 * THE TAUGHT LOOP, WALKED END TO END THROUGH THE ORCHESTRATOR.
 *
 * The documented loop is four lines, two of which need a person:
 *
 *   loombridge record          a human demonstrates
 *   loombridge verify   drives the flow and captures the frames
 *   loombridge approve         a human freezes what that run captured
 *   loombridge verify   now graded
 *
 * WHY THIS STARTS AT THE UNIFIED DOOR AND NOT AT `replayTraceForVerify`. The earlier version
 * of this file drove that seam directly and admitted in its own header that it did not walk
 * the orchestrator link. That link is exactly where the loop was broken: the orchestrator
 * dropped every `runnable === "no"` row into `notRun` BEFORE the flow section, without
 * consulting `--live`, and discovery classifies both of the states a human is in right after
 * recording that way (`non-anchor` with no baseline, `broken` after a re-record). So step 2
 * ran nothing and wrote no `<id>.report.json` for precisely the two cases the loop is for,
 * and a test that starts below the drop cannot see it.
 *
 * Reproduced against the PR head before the fix, both halves:
 *
 *  - FRESH PROJECT: `verify` printed "will not run: recorded, not approved: this
 *    `verify` run captures its frames" (a sentence that contradicts itself), wrote no
 *    report, and `approve` then refused and reprinted the same loop. A circular dead end.
 *  - RE-RECORDED ID: `verify` wrote nothing, and `approve` fell back to the most
 *    recent report on disk, which was the PREVIOUS demonstration's, and minted an anchor
 *    stamping the CURRENT trace's sha onto the OLD frames. Exit 0, and `verifyTraceBaseline`
 *    passed forever after.
 *
 * WHAT IS REAL HERE AND WHAT IS A DOUBLE. `runUnifiedVerify` is the real orchestrator,
 * `runApprove` is the real verb, discovery is real, and the frames are produced by the real
 * `replayTraceForVerify` against a scripted bridge. The ONE injected thing is the
 * `runFlowTrace` dep, which is re-assembled here exactly as `realDeps()` assembles it: that
 * is the only way to thread a scripted client into a path whose production form discovers a
 * live editor. The link under test (the orchestrator's decision about which rows reach that
 * seam) sits ABOVE the injection point, so the drop is still walked.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  replayComparisonCoverage,
  replayTraceForVerify,
  run as runTrace,
  shouldSuggestTolerance,
} from "../../../../capabilities/replay/trace.js";
import { loadTraceBaselineManifest } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import {
  runUnifiedVerify,
  type UnifiedSectionDeps,
} from "../../../../capabilities/verification/unified/orchestrator.js";
import { unifiedVerifyReportPath } from "../../../../capabilities/verification/unified/report.js";
import { loombridgePaths, standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import { REACHABLE_EDITOR } from "../../../_support/live-editor.js";

/** A 1x1 PNG, built rather than fixtured so the test carries no binary. */
function tinyPng(): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) >>> 0 : 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0x00, 0x20, 0x30, 0x40]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A `UnityClient`-shaped fake that answers a whole drive, aligned settle included. */
function scriptedClient(png: Buffer): () => {
  isConnected: boolean;
  waitForReconnect: () => Promise<boolean>;
  connect: () => Promise<unknown>;
  send: (command: string, params: Record<string, unknown>) => Promise<BridgeResponse>;
  disconnect: () => Promise<void>;
} {
  const handlers: Record<string, () => Record<string, unknown>> = {
    "editor.wait_for": () => ({ waited_ms: 1 }),
    "editor.play": () => ({ play_mode: "playing" }),
    "editor.console_logs": () => ({ logs: [] }),
    "editor.screenshot": () => ({ image_base64: png.toString("base64"), format: "png" }),
    "replay.settle_and_capture": () => ({
      image_base64: png.toString("base64"),
      format: "png",
      framesElapsed: 15,
      settledMs: 250,
      realtimeDeadlineHit: false,
      fixedDeltaTime: 0.02,
    }),
  };
  return () => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: async (command: string) => ({
      id: "t",
      timestamp: 0,
      status: "success",
      data: (handlers[command] ?? (() => ({})))(),
    }) as unknown as BridgeResponse,
    disconnect: async () => {},
  });
}

/**
 * `realDeps().runFlowTrace`, re-assembled with the scripted bridge threaded in. Every field
 * is derived the way production derives it, so a test double cannot answer a question the
 * real adapter would answer differently.
 */
function liveFlowDeps(png: Buffer, seen: string[]): Partial<UnifiedSectionDeps> {
  return {
    // The scripted client stands in for the editor the LIVE preflight probes for, so the
    // probe has to answer the same way, or the run refuses before it reaches this seam.
    ...REACHABLE_EDITOR,
    async runFlowTrace(layout, id, opts) {
      seen.push(id);
      const { artifact, exitTier, drift, htmlPath, maskSuggestion } = await replayTraceForVerify(layout, id, {
        ...opts,
        clientFactory: scriptedClient(png),
      });
      return {
        status: artifact.status,
        exitTier,
        htmlPath,
        ...drift,
        // Derived from the artifact exactly as `realDeps` derives it, so this walk of the
        // whole composition cannot answer the coverage question differently.
        comparisons: replayComparisonCoverage(artifact),
        suggestTolerance: shouldSuggestTolerance(artifact),
        ...(maskSuggestion ? { maskSuggestion } : {}),
      };
    },
  };
}

/** The recorded demonstration, as `loombridge record` would leave it on disk. */
function traceBody(captureIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: "0.1",
    id: "demo",
    start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [{ id: "s1", actions: [], captures: captureIds.map((id) => ({ id, settleMs: 250 })) }],
    outcome: { expected: "success" },
  });
}

async function record(root: string, captureIds: readonly string[]): Promise<string> {
  const layout = standardReplayLayout(root);
  await fs.mkdir(layout.replayTraces, { recursive: true });
  const body = traceBody(captureIds);
  await fs.writeFile(path.join(layout.replayTraces, "demo.trace.json"), body);
  return createHash("sha256").update(Buffer.from(body)).digest("hex");
}

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => { out += `${args.map(String).join(" ")}\n`; };
  try {
    return { value: await fn(), out };
  } finally {
    console.error = original;
  }
}

async function readUnified(root: string): Promise<{
  status: string;
  exit: number;
  notRun: { kind: string; id: string; why: string }[];
  sections: Record<string, { exit: number; anchored: boolean } | undefined>;
}> {
  const raw = await fs.readFile(unifiedVerifyReportPath(loombridgePaths(root).reports), "utf-8");
  return JSON.parse(raw) as never;
}

test("the LOOP walks end to end through the orchestrator: record → verify → approve → graded verify", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-loop-fresh-"));
  try {
    const layout = standardReplayLayout(root);
    const png = tinyPng();
    await record(root, ["cap"]);

    // ── STEP 2: `verify` on a project whose only asset is a fresh recording.
    const seen: string[] = [];
    const step2 = await captured(() =>
      runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(png, seen) }),
    );
    assert.deepEqual(seen, ["demo"], "the unified door must actually drive the recorded trace");

    // CAPTURING IS NOT MEASURING. The row stays exactly as unmeasured as it was: no flow
    // section, its own non-anchor tier in `notRun`, and a run that cannot exit 0.
    assert.equal(step2.value, 2, step2.out);
    const report2 = await readUnified(root);
    assert.equal(report2.status, "nothing-checked");
    assert.equal(report2.exit, 2);
    assert.equal(report2.sections.flow, undefined, "an unanchored capture never becomes a graded section");
    assert.deepEqual(report2.notRun.map((n) => [n.id, n.why]), [["demo", "non-anchor"]]);
    assert.match(step2.out, /NOT GRADED/, "the plan says which half happened and which did not");

    // …and the one thing the loop needs from step 2 is on disk.
    const reportJson = path.join(layout.replayReports, "demo.report.json");
    assert.ok((await fs.stat(reportJson)).size > 0, "step 2 must leave the run report `approve` promotes");

    // ── STEP 3: the REAL approve verb, bare, resolving the run for itself.
    const step3 = await captured(() => runTrace(["approve", "--root", root]));
    assert.equal(step3.value, 0, step3.out);
    assert.match(step3.out, /approving the most recent run "demo"/);
    const manifest = await loadTraceBaselineManifest(path.join(layout.replayBaselines, "demo"));
    assert.ok(manifest !== null && !("error" in manifest), `no anchor was stamped: ${JSON.stringify(manifest)}`);
    await fs.access(path.join(layout.replayBaselines, "demo", "cap.png"));

    // ── STEP 4: the same command, now graded against the frozen frames.
    const step4 = await captured(() =>
      runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(png, []) }),
    );
    assert.equal(step4.value, 0, step4.out);
    const report4 = await readUnified(root);
    assert.equal(report4.status, "pass");
    assert.equal(report4.sections.flow?.anchored, true, "step 4 compared a frozen human approval");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("RE-RECORDING an anchored id never approves the PREVIOUS demonstration's report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-loop-rerecord-"));
  try {
    const layout = standardReplayLayout(root);
    const png = tinyPng();
    const baselineDir = path.join(layout.replayBaselines, "demo");

    // A project already through the loop once: one capture, frozen.
    await record(root, ["cap"]);
    await captured(() => runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(png, []) }));
    assert.equal((await captured(() => runTrace(["approve", "--root", root]))).value, 0);
    const first = await loadTraceBaselineManifest(baselineDir);
    assert.ok(first !== null && !("error" in first));

    // The human RE-RECORDS the flow: same id, a different demonstration (two captures now).
    const reRecordedSha = await record(root, ["cap", "cap2"]);

    // THE ATTACK, and it is just "skip step 2": the only report on disk is the PREVIOUS
    // demonstration's run. Approving it would stamp the new trace's sha onto old frames.
    const stale = await captured(() => runTrace(["approve", "--root", root]));
    assert.equal(stale.value, 2, stale.out);
    assert.match(stale.out, /is a run of a DIFFERENT demonstration/);
    const untouched = await loadTraceBaselineManifest(baselineDir);
    assert.ok(untouched !== null && !("error" in untouched));
    assert.equal(untouched.approvedAt, first.approvedAt, "a refused approve leaves the previous anchor alone");
    assert.deepEqual(untouched.pngs.map((p) => p.captureId), ["cap"]);

    // ── The loop as documented: step 2 re-drives the BROKEN row for frames, and step 3 then
    // re-anchors from a run of the demonstration that is actually on disk.
    const seen: string[] = [];
    const step2 = await captured(() =>
      runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(png, seen) }),
    );
    assert.deepEqual(seen, ["demo"], "a re-recorded (BROKEN) row is still driven for its frames");
    assert.equal(step2.value, 2, "…and still measures nothing: the anchor it had cannot be trusted");
    assert.deepEqual((await readUnified(root)).notRun.map((n) => [n.id, n.why]), [["demo", "broken"]]);

    const step3 = await captured(() => runTrace(["approve", "--root", root]));
    assert.equal(step3.value, 0, step3.out);
    const reAnchored = await loadTraceBaselineManifest(baselineDir);
    assert.ok(reAnchored !== null && !("error" in reAnchored));
    assert.equal(reAnchored.traceSha256, reRecordedSha, "the anchor names the demonstration on disk");
    assert.deepEqual(
      reAnchored.pngs.map((p) => p.captureId),
      ["cap", "cap2"],
      "…and holds the frames THAT demonstration produced, not the previous one's",
    );

    const step4 = await captured(() =>
      runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(png, []) }),
    );
    assert.equal(step4.value, 0, step4.out);
    assert.equal((await readUnified(root)).sections.flow?.anchored, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve REFUSES a report that does not say which demonstration it came from", async () => {
  // Refuse-not-skip, on the bound field itself. A report with no `traceSha256` predates the
  // binding or was hand-written; either way nothing joins those frames to a demonstration,
  // and `if (sha && sha !== ours)` would let DELETING a field buy an approval.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-loop-unbound-"));
  try {
    const layout = standardReplayLayout(root);
    await record(root, ["cap"]);
    await captured(() =>
      runUnifiedVerify({ root, strict: false, live: true, deps: liveFlowDeps(tinyPng(), []) }),
    );

    const reportJson = path.join(layout.replayReports, "demo.report.json");
    const artifact = JSON.parse(await fs.readFile(reportJson, "utf-8")) as Record<string, unknown>;
    delete artifact.traceSha256;
    await fs.writeFile(reportJson, `${JSON.stringify(artifact, null, 2)}\n`);

    const { value: exit, out } = await captured(() => runTrace(["approve", "--root", root]));
    assert.equal(exit, 2, out);
    assert.match(out, /does not record WHICH demonstration it was produced from/);
    await assert.rejects(fs.access(layout.replayBaselines), "nothing was frozen");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, each performed on the REAL source, rebuilt and re-run, then restored.
 *
 * BREAK 1: restore the drop that broke step 2.
 * `capabilities/verification/unified/orchestrator.ts`, `runUnifiedVerify`:
 *     -  const captureOnlyTraces = assets.filter((a) => a.kind === "trace" && willCaptureOnly(a, opts.live, only));
 *     +  const captureOnlyTraces: DiscoveredAsset[] = [];
 *   OBSERVED VERBATIM (all three fail; the drop is upstream of every one of them):
 *     ✖ the LOOP walks end to end through the orchestrator: record → verify → approve → graded verify
 *       AssertionError [ERR_ASSERTION]: the unified door must actually drive the recorded trace
 *       + actual - expected
 *
 *       + []
 *       - [
 *       -   'demo'
 *       - ]
 *     ✖ RE-RECORDING an anchored id never approves the PREVIOUS demonstration's report
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *
 *       2 !== 0
 *     ✖ approve REFUSES a report that does not say which demonstration it came from
 *       Error: ENOENT: no such file or directory, open
 *       '/var/folders/…/T/loombridge-loop-unbound-jNcLrW/.loombridge/run/replays/reports/demo.report.json'
 *
 * BREAK 2: remove the report-to-trace binding, keeping everything else.
 * `capabilities/replay/trace.ts`, `runApprove`:
 *     -  if (reportTraceSha256 !== traceSha256) { … return 2; }
 *     +  // LITMUS: mismatch check removed.
 *   OBSERVED VERBATIM:
 *     ✖ RE-RECORDING an anchored id never approves the PREVIOUS demonstration's report
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] no --id given, approving the most recent run "demo".
 *       [loombridge trace]   that run holds 1 capture(s), and approving freezes them as the approved baseline for "demo".
 *       [loombridge trace] approved 1 baseline(s) → .loombridge/anchors/baselines/demo
 *       [loombridge trace] stamped .loombridge/anchors/baselines/demo/baseline-manifest.json: approvedAt
 *       2026-08-12T14:05:48.263Z, bound to trace bc7bd44815e0…
 *
 *
 *       0 !== 2
 *   The WRONG ANCHOR is minted at exit 0: ONE frame (`cap`, the previous demonstration's),
 *   stamped under the re-recorded trace's sha `bc7bd44815e0`. The other two tests stayed
 *   GREEN, which is the point of having all three: the capture and the binding are separate
 *   promises and each fails on its own.
 *
 * BREAK 3: treat an ABSENT binding as "nothing to check", the classic skip.
 * `capabilities/replay/trace.ts`, `runApprove`:
 *     -  if (typeof reportTraceSha256 !== "string") { … return 2; }
 *     -  if (reportTraceSha256 !== traceSha256) {
 *     +  if (reportTraceSha256 !== undefined && reportTraceSha256 !== traceSha256) {
 *   OBSERVED VERBATIM:
 *     ✖ approve REFUSES a report that does not say which demonstration it came from
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] no --id given, approving the most recent run "demo".
 *       [loombridge trace]   that run holds 1 capture(s), and approving freezes them as the approved baseline for "demo".
 *       [loombridge trace] approved 1 baseline(s) → .loombridge/anchors/baselines/demo
 *       [loombridge trace] stamped .loombridge/anchors/baselines/demo/baseline-manifest.json: approvedAt
 *       2026-08-12T14:06:21.471Z, bound to trace 8dd202b6179c…
 *
 *
 *       0 !== 2
 *   (the mismatch test stayed GREEN: deleting one field is all it takes, which is why the
 *   absent case is a refusal and not a skip.)
 */
