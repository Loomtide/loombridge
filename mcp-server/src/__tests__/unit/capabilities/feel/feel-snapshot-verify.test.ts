import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runVerifyCli } from "../../../../capabilities/verification/verify.js";
import { run as runFeelCli } from "../../../../capabilities/feel/snapshot.js";
import { feelPaths } from "../../../../capabilities/feel/feel-workspace.js";
import {
  FEEL_SNAPSHOT_MANIFEST,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
} from "../../../../capabilities/feel/snapshot-manifest.js";
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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "feel-snapverify-"));
  const root = path.join(base, "game");
  const ws = path.join(base, "ws");
  await fs.mkdir(root, { recursive: true });
  return { root, ws };
}

/** Stage + approve a clean snapshot from the real live-capture artifact. */
async function approvedSnapshot(root: string, ws: string): Promise<Record<string, number>> {
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  assert.equal(await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws]), 0);
  const doc = JSON.parse(await fs.readFile(path.join(LIVE_DIR, "feel.json"), "utf-8"));
  return { runSpeed: doc.runSpeed, jumpApex: doc.jumpApex, timeToApex: doc.timeToApex };
}

async function writeMeasurements(dir: string, metrics: Record<string, number>, extra: Record<string, unknown> = {}): Promise<string> {
  const p = path.join(dir, "current-measurements.json");
  await fs.writeFile(p, JSON.stringify({ metrics, ...extra }, null, 2), "utf-8");
  return p;
}

// ── mode guards ──────────────────────────────────────────────────────────────

test("verify --snapshot: mutual exclusions refuse loudly (exit 2)", async () => {
  const { root, ws } = await scaffold();
  assert.equal(await runVerifyCli(["--snapshot", "--profile", "precision", "--root", root]), 2);
  assert.equal(await runVerifyCli(["--snapshot", "--slice", "x", "--root", root, "--workspace", ws]), 2);
  assert.equal(await runVerifyCli(["--snapshot", "--enforce-taste", "--root", root, "--workspace", ws]), 2);
  assert.equal(await runVerifyCli(["--snapshot", "--minigame", "--root", root]), 2);
  assert.equal(
    await runVerifyCli([
      "--snapshot", "--root", root, "--workspace", ws,
      "--capture-contract", path.join(ws, "c.json"),
      "--measurements", path.join(ws, "m.json"),
    ]),
    2,
  );
});

test("verify --snapshot: no approved snapshot is a refusal with guidance (exit 2)", async () => {
  const { root, ws } = await scaffold();
  const mPath = await writeMeasurements(path.dirname(ws), { runSpeed: 9 });
  await fs.mkdir(ws, { recursive: true });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]), 2);
});

// ── offline grading (--measurements; binding unverified) ─────────────────────

test("verify --snapshot offline: identical values are clean (exit 0), report written; --strict promotes the unverified binding to 1", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const mPath = await writeMeasurements(path.dirname(ws), baseline);

  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]), 0);

  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.kind, "feel-snapshot-drift");
  assert.equal(report.status, "clean");
  assert.equal(report.contractBinding, "unverified");
  assert.equal(report.summary.match, 3);
  assert.ok(typeof report.snapshot.manifestSha256 === "string" && report.snapshot.manifestSha256.length === 64);
  const md = await fs.readFile(feelPaths(ws).driftReport.replace(/\.json$/, ".md"), "utf-8");
  assert.match(md, /# Feel snapshot drift: CLEAN/);

  // The same clean compare is a 1 under --strict: an unverified binding must
  // not silently read as a fully bound green in CI.
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath, "--strict"]),
    1,
  );
});

test("verify --snapshot offline: a drifted kinematic exits 1 and names the metric", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  // runSpeed baseline ~2.816; +1.0 is far beyond max(0.05, 5%) tolerance.
  const mPath = await writeMeasurements(path.dirname(ws), { ...baseline, runSpeed: baseline.runSpeed + 1 });

  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]), 1);
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.status, "drift");
  const drifted = report.metrics.find((m: { id: string }) => m.id === "runSpeed");
  assert.equal(drifted.status, "drift");
  assert.match(report.nextAction, /re-approve|inspect/);
});

test("verify --snapshot offline: a baseline metric unmeasured now is a capture gap (exit 2), including a coverage-refused value", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);

  // Plainly absent.
  const missingPath = await writeMeasurements(path.dirname(ws), { runSpeed: baseline.runSpeed });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", missingPath]), 2);

  // Present but coverage says it was never actually measured: same refusal.
  const refusedPath = await writeMeasurements(path.dirname(ws), baseline, {
    captureCoverage: [{ metric: "jumpApex", status: "attempted-blocked", reason: "settle timeout" }],
  });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", refusedPath]), 2);
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.status, "incomplete");
});

test("verify --snapshot: a tampered manifest exits 2 and the report names the integrity failures", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  doc.metrics.runSpeed.value = 9.0;
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

  const mPath = await writeMeasurements(path.dirname(ws), baseline);
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]), 2);
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.integrity.ok, false);
  assert.ok(report.integrity.failures.length > 0);
  assert.match(report.nextAction, /re-capture and re-approve/i);
});

// ── contract binding (live path, refused before any capture) ─────────────────

test("verify --snapshot: an explicit --capture-contract that mismatches the frozen one refuses (exit 2)", async () => {
  const { root, ws } = await scaffold();
  await approvedSnapshot(root, ws);
  const otherContract = path.join(path.dirname(ws), "other-contract.json");
  await fs.writeFile(
    otherContract,
    JSON.stringify({ ...CONTRACT_FIXTURE, interactions: [{ id: "run", kind: "key-hold", key: "ArrowRight" }] }, null, 2),
    "utf-8",
  );
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--capture-contract", otherContract]),
    2,
  );
});
