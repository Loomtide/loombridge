/**
 * The trace baseline manifest: provenance for an approved pixel baseline.
 *
 * What is pinned here is the anchor question: WHEN was this approved and FROM WHAT,
 * and whether the answer survives contact with a tampered disk. The reader has three
 * outcomes on purpose (absent, malformed, valid) because collapsing "no manifest"
 * into "bad manifest" would make a legacy baseline look like tampering, and
 * collapsing "bad manifest" into "no manifest" would make tampering look like legacy.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import {
  TRACE_BASELINE_MANIFEST,
  isTraceBaselineManifestError,
  loadTraceBaselineManifest,
  traceBaselineManifestPath,
  verifyTraceBaseline,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import { traceShaOnDisk } from "../../../_support/replay-fixtures.js";

/** Stage a replayed-but-unapproved project: a trace, a report, and one capture PNG. */
async function stageReplayed(id = "demo"): Promise<{ root: string; layout: ReturnType<typeof standardReplayLayout> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-baseline-"));
  const layout = standardReplayLayout(root);
  await fs.mkdir(layout.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(layout.replayTraces, `${id}.trace.json`),
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "s", actions: [] }],
      outcome: { expected: "success" },
    }),
  );
  const actualDir = path.join(layout.replayReports, id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actualPng = path.join(actualDir, "cap.png");
  await fs.writeFile(actualPng, Buffer.from("approved-frame-bytes"));
  await fs.writeFile(
    path.join(layout.replayReports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      // The binding `approve` requires: this report is a run of THAT demonstration.
      traceSha256: await traceShaOnDisk(layout, id),
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
  return { root, layout };
}

test("approve → load round-trips: the manifest names when it was approved and what from", async () => {
  const { root, layout } = await stageReplayed();
  try {
    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    const baselineDir = path.join(layout.replayBaselines, "demo");

    const loaded = await loadTraceBaselineManifest(baselineDir);
    assert.ok(loaded && !isTraceBaselineManifestError(loaded));
    assert.equal(loaded.traceId, "demo");
    assert.equal(loaded.pngs.length, 1);

    const integrity = await verifyTraceBaseline(baselineDir, {
      tracePath: path.join(layout.replayTraces, "demo.trace.json"),
    });
    assert.equal(integrity.ok, true, integrity.failures.join("; "));
    assert.equal(integrity.unstamped, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve is idempotent: a second approve overwrites and still verifies", async () => {
  const { root, layout } = await stageReplayed();
  try {
    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    const baselineDir = path.join(layout.replayBaselines, "demo");
    const first = await loadTraceBaselineManifest(baselineDir);
    assert.ok(first && !isTraceBaselineManifestError(first));

    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    const second = await loadTraceBaselineManifest(baselineDir);
    assert.ok(second && !isTraceBaselineManifestError(second));
    assert.deepEqual(second.pngs, first.pngs, "the same frames re-approve to the same shas");
    assert.equal((await verifyTraceBaseline(baselineDir)).ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LITMUS: a tampered baseline PNG fails the sha cross-check, naming the frame", async () => {
  const { root, layout } = await stageReplayed();
  try {
    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    const baselineDir = path.join(layout.replayBaselines, "demo");
    assert.equal((await verifyTraceBaseline(baselineDir)).ok, true, "clean before tampering");

    // Repaint the approved frame on disk. The manifest still claims the old bytes.
    await fs.writeFile(path.join(baselineDir, "cap.png"), Buffer.from("different-frame-bytes"));

    const integrity = await verifyTraceBaseline(baselineDir);
    assert.equal(integrity.ok, false);
    assert.ok(
      integrity.failures.some((f) => f.includes("cap.png") && f.includes("sha256")),
      integrity.failures.join("; "),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an UNDECLARED baseline PNG is refused (an out-of-band frame must not become the anchor)", async () => {
  const { root, layout } = await stageReplayed();
  try {
    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    const baselineDir = path.join(layout.replayBaselines, "demo");
    await fs.writeFile(path.join(baselineDir, "smuggled.png"), Buffer.from("never approved"));

    const integrity = await verifyTraceBaseline(baselineDir);
    assert.equal(integrity.ok, false);
    assert.ok(integrity.failures.some((f) => f.includes("smuggled.png")), integrity.failures.join("; "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a baseline approved for a DIFFERENT trace fails the trace sha cross-check", async () => {
  const { root, layout } = await stageReplayed();
  try {
    assert.equal(await runTrace(["approve", "--id", "demo", "--root", root]), 0);
    // Edit the demonstration after approving: the frames no longer belong to it.
    const tracePath = path.join(layout.replayTraces, "demo.trace.json");
    const trace = JSON.parse(await fs.readFile(tracePath, "utf-8"));
    trace.segments.push({ id: "s2", actions: [] });
    await fs.writeFile(tracePath, JSON.stringify(trace));

    const integrity = await verifyTraceBaseline(path.join(layout.replayBaselines, "demo"), { tracePath });
    assert.equal(integrity.ok, false);
    assert.ok(
      integrity.failures.some((f) => /trace file sha256 mismatch/.test(f)),
      integrity.failures.join("; "),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an ABSENT manifest loads as null (legacy), and verify reports `unstamped`, not tampering", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-baseline-legacy-"));
  try {
    await fs.writeFile(path.join(dir, "cap.png"), Buffer.from("legacy frame"));
    assert.equal(await loadTraceBaselineManifest(dir), null);

    const integrity = await verifyTraceBaseline(dir);
    assert.equal(integrity.unstamped, true);
    assert.deepEqual(integrity.failures, [], "legacy is a provenance gap, never a tampering claim");
    assert.equal(integrity.ok, false, "but it is still not an anchor");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a MALFORMED manifest is a typed error marker, never a throw", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-baseline-bad-"));
  try {
    const cases: Array<[string, string]> = [
      ["not json at all {", "not valid JSON"],
      [JSON.stringify({ kind: "feel-snapshot", schemaVersion: "1" }), "kind"],
      [JSON.stringify({ kind: "trace-baseline", schemaVersion: "9" }), "schemaVersion"],
      [JSON.stringify({ kind: "trace-baseline", schemaVersion: "1" }), "traceId"],
      [
        JSON.stringify({
          kind: "trace-baseline",
          schemaVersion: "1",
          traceId: "d",
          traceSha256: "x",
          approvedAt: "t",
          sourceReportSha256: "y",
          pngs: [{ captureId: "cap" }],
        }),
        "pngs",
      ],
    ];
    for (const [body, expectMention] of cases) {
      await fs.writeFile(traceBaselineManifestPath(dir), body, "utf-8");
      const loaded = await loadTraceBaselineManifest(dir);
      assert.ok(loaded !== null && isTraceBaselineManifestError(loaded), `expected an error marker for ${body.slice(0, 40)}`);
      assert.ok(loaded.error.includes(expectMention), `${loaded.error} should mention ${expectMention}`);
      assert.ok(loaded.error.includes(TRACE_BASELINE_MANIFEST));

      // And the integrity helper surfaces it as a NAMED failure rather than unstamped.
      const integrity = await verifyTraceBaseline(dir);
      assert.equal(integrity.unstamped, false);
      assert.equal(integrity.ok, false);
      assert.deepEqual(integrity.failures, [loaded.error]);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
