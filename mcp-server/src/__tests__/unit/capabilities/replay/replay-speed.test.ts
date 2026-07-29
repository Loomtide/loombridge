/**
 * `--speed`: paced replay whose pacing is PART OF THE ANCHOR.
 *
 * The three ways a pacing could quietly corrupt the pixel gate, each pinned here:
 *  1. scaled settles dropping below what the game needs to render (the floor);
 *  2. a baseline approved at one pacing graded against a replay at another
 *     (phase skew reads as drift, or hides real drift: the comparison must REFUSE);
 *  3. an out-of-range or hand-edited speed value coercing instead of refusing.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  applyVisualDiff,
  run as runTrace,
  scaleTraceSettles,
} from "../../../../capabilities/replay/trace.js";
import {
  MAX_REPLAY_SPEED,
  MIN_SCALED_SETTLE_MS,
  loadTraceBaselineManifest,
  replaySpeedRefusal,
  sha256,
  traceBaselineManifestPath,
  writeTraceBaselineManifest,
  type TraceBaselineManifest,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/index.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-speed-"));
}

/** A tiny valid 1x1 PNG (the same technique the drift-tolerance tests use). */
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
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

test("scaleTraceSettles divides settles and floors at MIN_SCALED_SETTLE_MS; speed 1 is identity", () => {
  const mk = () => ({
    segments: [
      { captures: [{ settleMs: 4000 }, { settleMs: 300 }] },
      { captures: [{ settleMs: undefined as number | undefined }] },
      { captures: undefined as { settleMs?: number }[] | undefined },
    ],
  });
  const scaled = scaleTraceSettles(mk(), 4);
  assert.equal(scaled.segments[0]!.captures![0]!.settleMs, 1000, "4000/4");
  assert.equal(
    scaled.segments[0]!.captures![1]!.settleMs,
    MIN_SCALED_SETTLE_MS,
    "300/4 = 75 floors at the minimum the game needs to render",
  );
  assert.equal(scaled.segments[1]!.captures![0]!.settleMs, undefined, "absent settles stay absent");

  const identity = scaleTraceSettles(mk(), 1);
  assert.equal(identity.segments[0]!.captures![0]!.settleMs, 4000, "speed 1 changes nothing");
});

test("replaySpeedRefusal: the range is [1, MAX_REPLAY_SPEED], non-coercing, absent is fine", () => {
  assert.equal(replaySpeedRefusal(undefined), null, "absent means 1 (legacy manifests)");
  assert.equal(replaySpeedRefusal(1), null);
  assert.equal(replaySpeedRefusal(MAX_REPLAY_SPEED), null);
  for (const bad of [0, 0.5, -1, MAX_REPLAY_SPEED + 1, Number.NaN, Number.POSITIVE_INFINITY, "4", null]) {
    assert.notEqual(replaySpeedRefusal(bad as unknown), null, `${JSON.stringify(bad)} must refuse`);
  }
});

test("--speed is refused on every subcommand except replay", async () => {
  for (const sub of ["record", "approve", "tolerance", "report", "replay-all"]) {
    const code = await runTrace([sub, "--id", "x", "--speed", "4"]);
    assert.equal(code, 2, `${sub} must refuse --speed`);
  }
  const bad = await runTrace(["replay", "--id", "x", "--speed", "9"]);
  assert.equal(bad, 2, "over-cap speed refuses at parse time");
});

test("a pacing mismatch REFUSES the pixel comparison as a harness fault, never grades it as drift", async () => {
  const root = await tmpRoot();
  try {
    const paths = standardReplayLayout(root);
    const baselineDir = path.join(paths.replayBaselines, "demo");
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.mkdir(paths.replayTraces, { recursive: true });

    const png = tinyPng(10);
    await fs.writeFile(path.join(baselineDir, "cap.png"), png);
    const traceBody = JSON.stringify({ id: "demo", segments: [] });
    await fs.writeFile(path.join(paths.replayTraces, "demo.trace.json"), traceBody);

    const manifest: TraceBaselineManifest = {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: "demo",
      traceSha256: sha256(Buffer.from(traceBody)),
      approvedAt: "2026-07-29T00:00:00.000Z",
      sourceReportSha256: "0".repeat(64),
      pngs: [{ captureId: "cap", sha256: sha256(png) }],
      replaySpeed: 4,
    };
    await writeTraceBaselineManifest(baselineDir, manifest);

    // The actual capture is byte-identical to the baseline: at MATCHED pacing this would
    // be a clean match, so any non-match verdict below is the pacing rule, nothing else.
    const actualDir = path.join(paths.replayReports, "demo", "actual");
    await fs.mkdir(actualDir, { recursive: true });
    const actual = path.join(actualDir, "cap.png");
    await fs.writeFile(actual, png);

    const artifact = {
      traceId: "demo",
      status: "pass",
      resetTier: "scene",
      segments: [{ id: "s1", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actual, sha256: sha256(png) }] }],
      assertions: [],
      console: { errors: 0, warnings: 0, lines: [] },
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      replaySpeed: 1,
    } as unknown as ReplayRunArtifact;

    await applyVisualDiff(paths, "demo", artifact);
    assert.equal(artifact.visualHarnessFault, true, "pacing mismatch is a harness fault");
    assert.notEqual(artifact.visualDrift, true, "…and NEVER drift");

    // Control: matched pacing grades cleanly (the identical PNG matches).
    const matched = { ...artifact, visualHarnessFault: undefined, replaySpeed: 4 } as unknown as ReplayRunArtifact;
    matched.segments[0]!.captures[0]!.visualStatus = undefined;
    await applyVisualDiff(paths, "demo", matched);
    assert.notEqual(matched.visualHarnessFault, true, "matched pacing is not a fault");
    assert.equal(matched.segments[0]!.captures[0]!.visualStatus, "match");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hand-edited out-of-range replaySpeed makes the manifest a typed error (read-side cap)", async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, "baseline");
    await fs.mkdir(dir, { recursive: true });
    const manifest: TraceBaselineManifest = {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: "t",
      traceSha256: "0".repeat(64),
      approvedAt: "2026-07-29T00:00:00.000Z",
      sourceReportSha256: "0".repeat(64),
      pngs: [],
    };
    await writeTraceBaselineManifest(dir, manifest);
    const rawPath = traceBaselineManifestPath(dir);
    const doc = JSON.parse(await fs.readFile(rawPath, "utf-8")) as Record<string, unknown>;
    doc.replaySpeed = 99;
    await fs.writeFile(rawPath, JSON.stringify(doc));
    const loaded = await loadTraceBaselineManifest(dir);
    assert.ok(loaded !== null && "error" in (loaded as object), "over-cap speed is a typed error, not a coercion");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
