/**
 * THE LOOP HAS NO SEPARATE REPLAY STEP, and this is what walks that claim.
 *
 * The documented loop is now four lines, two of which need a person:
 *
 *   loombridge record          a human demonstrates
 *   loombridge verify --live   drives the flow and captures the frames
 *   loombridge approve         a human freezes what that run captured
 *   loombridge verify --live   now graded
 *
 * It rests entirely on one fact: `verify --live` writes the SAME `<id>.report.json` that
 * `approve` promotes. That fact was true before this change and documented nowhere, which is
 * how the loop came to be taught as five commands with a `trace replay` in the middle.
 *
 * A CLAIM IN HELP TEXT WITH NOTHING WALKING IT is a claim the tool can quietly stop keeping,
 * and this one is invisible to every existing test: `replayTraceForVerify` returns the path,
 * `runApprove` recomputes it, and the two agreeing is a coincidence of two `path.join` calls
 * in different functions. Rename the report suffix in one of them and every other test still
 * passes while the documented loop silently breaks at step 3.
 *
 * WHAT THIS COVERS, and what it does not. It drives the seam `verify --live` really calls
 * (`replayTraceForVerify`, invoked by the unified orchestrator) against a scripted bridge,
 * then runs the REAL `approve` verb over whatever that left on disk. The one link it does not
 * walk is orchestrator -> `replayTraceForVerify`, which is a direct call whose returned
 * `reportJson` the orchestrator only reports; there is no live-editor seam through the
 * orchestrator to drive.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { replayTraceForVerify, run as runTrace } from "../../../../capabilities/replay/trace.js";
import { loadTraceBaselineManifest } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";

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

test("`verify --live` writes the very report `approve` promotes: the loop needs no `trace replay`", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-verify-feeds-approve-"));
  try {
    const layout = standardReplayLayout(root);
    await fs.mkdir(layout.replayTraces, { recursive: true });
    await fs.writeFile(
      path.join(layout.replayTraces, "demo.trace.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "demo",
        start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
        input: { backend: "ui-events" },
        segments: [{ id: "s1", actions: [], captures: [{ id: "cap", settleMs: 250 }] }],
        outcome: { expected: "success" },
      }),
    );

    // STEP 2 OF THE LOOP, at the exact seam the unified door calls. No `trace replay` runs
    // anywhere in this test, which is the whole point.
    const { value: replayed } = await captured(() =>
      replayTraceForVerify(layout, "demo", { strictVisual: false, clientFactory: scriptedClient(tinyPng()) }),
    );
    assert.equal(replayed.exitTier, 0, "the scripted drive must succeed, or step 3 proves nothing");

    // The file is really there, at the path the verb reported.
    const stat = await fs.stat(replayed.reportJson);
    assert.ok(stat.size > 0, "verify --live must leave a non-empty run report");

    // STEP 3 OF THE LOOP: the REAL approve verb, bare, resolving the run for itself exactly
    // as an operator would type it.
    const { value: exit, out } = await captured(() => runTrace(["approve", "--root", root]));
    assert.equal(exit, 0, out);
    assert.match(out, /approving the most recent run "demo"/, "bare approve resolved the run verify just wrote");
    assert.match(out, /that run holds 1 capture\(s\)/, "…and said what it was about to freeze");

    // THE BINDING: the anchor it minted names that report, so the two halves are provably the
    // same run rather than two files that happen to share a name.
    const manifest = await loadTraceBaselineManifest(path.join(layout.replayBaselines, "demo"));
    assert.ok(manifest !== null && !("error" in manifest), `no baseline manifest was stamped: ${JSON.stringify(manifest)}`);
    assert.equal(manifest!.traceId, "demo");
    assert.ok(manifest!.sourceReportSha256.length === 64, "the anchor cites the report it was frozen from");
    // And the approved frame is on disk, which is what "freeze" means.
    await fs.access(path.join(layout.replayBaselines, "demo", "cap.png"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, applied to the real source, rebuilt and re-run, then restored.
 *
 * BREAK — make `verify --live` write its report under a different name, exactly the way a
 * refactor would. `capabilities/replay/trace.ts`, `replayOneTrace`:
 *     -  const reportJson = path.join(paths.replayReports, `${id}.report.json`);
 *     +  const reportJson = path.join(paths.replayReports, `${id}.run-report.json`);
 *   OBSERVED VERBATIM:
 *     ✖ `verify --live` writes the very report `approve` promotes: the loop needs no `trace replay`
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] nothing to approve: no replay run in
 *       .loombridge/run/replays/reports/.
 *       2 !== 0
 *         expected: 0, operator: 'strictEqual'
 */
