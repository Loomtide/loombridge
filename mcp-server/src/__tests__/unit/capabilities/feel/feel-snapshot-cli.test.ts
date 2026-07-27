import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runFeelCli } from "../../../../capabilities/feel/snapshot.js";
import {
  FEEL_SNAPSHOT_MANIFEST,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
  loadSnapshotManifest,
  verifySnapshotIntegrity,
} from "../../../../capabilities/feel/snapshot-manifest.js";
import { feelPaths } from "../../../../capabilities/feel/feel-workspace.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const LIVE_DIR = path.join(REPO_ROOT, "Docs", "Profiles", "artifacts", "s5cb-live-capture");

const CONTRACT_FIXTURE = {
  schemaVersion: "1",
  game: "fixture-game",
  subjects: [{ id: "player", locator: { path: "/Player" } }],
  interactions: [{ id: "run", kind: "key-hold", key: "d" }],
  metrics: [
    { metric: "runSpeed", interactionId: "run", derivation: "trajectory" },
    { metric: "jumpApex", interactionId: "run", derivation: "trajectory" },
    { metric: "timeToApex", interactionId: "run", derivation: "trajectory" },
  ],
};

async function scaffold(): Promise<{ root: string; ws: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "feel-cli-"));
  const root = path.join(base, "game");
  const ws = path.join(base, "ws");
  await fs.mkdir(root, { recursive: true });
  return { root, ws };
}

async function stageCandidate(ws: string, measurementsFile: string, extra?: (doc: any) => void): Promise<void> {
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.mkdir(candidate, { recursive: true });
  const doc = JSON.parse(await fs.readFile(path.join(LIVE_DIR, measurementsFile), "utf-8"));
  if (extra) extra(doc);
  await fs.writeFile(path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE), JSON.stringify(doc, null, 2), "utf-8");
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
}

// ── usage / parse ────────────────────────────────────────────────────────────

test("feel: unknown subcommand and unknown flags are usage errors (exit 2); --help exits 0", async () => {
  assert.equal(await runFeelCli(["nonsense"]), 2);
  assert.equal(await runFeelCli(["snapshot", "explode"]), 2);
  const { root, ws } = await scaffold();
  assert.equal(await runFeelCli(["snapshot", "status", "--root", root, "--workspace", ws, "--frobnicate"]), 2);
  assert.equal(await runFeelCli(["--help"]), 0);
  assert.equal(await runFeelCli(["snapshot", "--help"]), 0);
});

test("feel snapshot capture: a missing capture contract is a setup fault (exit 2)", async () => {
  const { root, ws } = await scaffold();
  assert.equal(await runFeelCli(["snapshot", "capture", "--root", root, "--workspace", ws]), 2);
});

test("feel snapshot capture: a bridge/harness fault exits 2, and stages nothing approvable", async () => {
  const { root, ws } = await scaffold();
  const paths = feelPaths(ws);
  await fs.mkdir(path.dirname(paths.captureContract), { recursive: true });
  await fs.writeFile(paths.captureContract, JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  const code = await runFeelCli(["snapshot", "capture", "--root", root, "--workspace", ws], {
    clientFactory: () => {
      throw new Error("no editor here");
    },
  });
  assert.equal(code, 2);
  // The failed capture must not leave an approvable candidate behind.
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 2);
});

// ── approve ──────────────────────────────────────────────────────────────────

test("feel snapshot approve: no candidate exits 2 with guidance", async () => {
  const { root, ws } = await scaffold();
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 2);
});

test("feel snapshot approve: a clean candidate freezes; status and integrity read ok", async () => {
  const { root, ws } = await scaffold();
  await stageCandidate(ws, "feel.json");
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--note", "feels right"]),
    0,
  );
  const currentDir = feelPaths(ws).snapshotCurrentDir;
  const manifest = await loadSnapshotManifest(currentDir);
  assert.ok(manifest);
  assert.equal(manifest.note, "feels right");
  assert.equal(manifest.metrics.runSpeed.confidence, "verified");
  assert.equal(manifest.metrics.runSpeed.derivation, "trajectory");
  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, true, integrity.failures.join("; "));
  assert.equal(await runFeelCli(["snapshot", "status", "--root", root, "--workspace", ws]), 0);
});

test("feel snapshot approve: REFUSES a candidate whose value fails its own re-derivation (exit 1)", async () => {
  const { root, ws } = await scaffold();
  await stageCandidate(ws, "feel-tampered.json");
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 1);
  // Nothing frozen.
  assert.equal(await loadSnapshotManifest(feelPaths(ws).snapshotCurrentDir), null);
});

test("feel snapshot approve: coverage gaps refuse without --allow-partial, freeze-with-record under it", async () => {
  const { root, ws } = await scaffold();
  await stageCandidate(ws, "feel.json", (doc) => {
    doc.captureCoverage = [
      { metric: "runSpeed", status: "measured" },
      { metric: "coyoteTime", status: "attempted-blocked", reason: "probe missing" },
    ];
  });
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 1);
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--allow-partial"]), 0);
  const manifest = await loadSnapshotManifest(feelPaths(ws).snapshotCurrentDir);
  assert.ok(manifest?.coverageGaps?.some((c) => c.metric === "coyoteTime"));
});

test("feel snapshot approve: --tolerances overriding an unknown metric is a usage error; valid overrides freeze", async () => {
  const { root, ws } = await scaffold();
  await stageCandidate(ws, "feel.json");
  const badTol = path.join(ws, "bad-tol.json");
  await fs.writeFile(badTol, JSON.stringify({ perMetric: { warpFactor: { relPct: 0.5 } } }), "utf-8");
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--tolerances", badTol]), 2);

  const goodTol = path.join(ws, "tol.json");
  await fs.writeFile(goodTol, JSON.stringify({ defaultRelPct: 0.1, perMetric: { runSpeed: { abs: 0.5 } } }), "utf-8");
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--tolerances", goodTol]), 0);
  const manifest = await loadSnapshotManifest(feelPaths(ws).snapshotCurrentDir);
  assert.equal(manifest?.tolerancePolicy.defaultRelPct, 0.1);
  assert.equal(manifest?.tolerancePolicy.perMetric?.runSpeed.abs, 0.5);
});

test("feel snapshot approve: a hand-edited candidate-report cannot launder an approve (cleanliness is recomputed)", async () => {
  const { root, ws } = await scaffold();
  await stageCandidate(ws, "feel-tampered.json");
  // Forge a glowing candidate report beside the dirty measurements.
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.writeFile(
    path.join(candidate, "candidate-report.json"),
    JSON.stringify({ kind: "feel-snapshot-candidate", capturedAt: "2026-07-28T00:00:00.000Z", rederivation: { pass: 3, total: 3 }, distrusted: [], coverageGaps: [], warnings: [] }),
    "utf-8",
  );
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 1);
});

// ── status ───────────────────────────────────────────────────────────────────

test("feel snapshot status: absent is guidance (exit 0); tampered is NOT READY (exit 2)", async () => {
  const { root, ws } = await scaffold();
  assert.equal(await runFeelCli(["snapshot", "status", "--root", root, "--workspace", ws]), 0);

  await stageCandidate(ws, "feel.json");
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 0);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  doc.metrics.runSpeed.value = 99;
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
  assert.equal(await runFeelCli(["snapshot", "status", "--root", root, "--workspace", ws]), 2);
});

test("feel snapshot: a workspace inside the project is refused", async () => {
  const { root } = await scaffold();
  assert.equal(
    await runFeelCli(["snapshot", "status", "--root", root, "--workspace", path.join(root, "ws")]),
    2,
  );
});
