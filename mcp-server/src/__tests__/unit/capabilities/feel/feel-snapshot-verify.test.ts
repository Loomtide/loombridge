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

/*
 * F2 — SHRINKING THE FEEL DENOMINATOR (the mirror of the screens attack, F1).
 *
 * The test above proves a manifest metric that DISAGREES with the frozen measurements is
 * refused: `verifySnapshotIntegrity` walks `manifest.metrics` to the frozen values. It only
 * ever walked that way. A metric DELETED from `manifest.metrics` therefore had no value to
 * disagree with, and every count downstream is derived from what survived: `summary.total`
 * is `metrics.length` over `Object.entries(manifest.metrics)`, and the unified door reads
 * that number as `expected` AND as `performed`.
 *
 * Hiding a drift by deleting its metric was possible before comparison counting. What is
 * NEW is that the shrunken number is now the EVIDENCE for `anchored`: the report positively
 * certifies "2 of 2 compared, anchored: true" over an anchor a hand-edit shrank.
 *
 * Demonstrated end to end (real approve, real `verify --snapshot`, offline `--measurements`):
 *
 *   CONTROL:                            exit=0 clean  total=3  coverage={3,3}  anchored=true
 *   DRIFTED runSpeed (+1.0, tol 0.14):  exit=1 drift  total=3  coverage={3,3}  anchored=true
 *   ATTACK (runSpeed deleted, same drifted capture):
 *                                       exit=0 clean  total=2  coverage={2,2}  anchored=true
 *
 * The fix is the reverse walk: a metric present in the FROZEN measurements and absent from
 * `manifest.metrics` is a named refusal, not a smaller denominator. It is exact rather than
 * heuristic because `snapshot approve` freezes every measured metric
 * (`for (const [id, value] of Object.entries(measurements.metrics))`), so the two sets are
 * equal at approve time by construction, and the measurements file's own sha256 is checked
 * two blocks above. A metric that was never measured (a coverage gap) is in NEITHER set and
 * is untouched by this check.
 *
 * LITMUS, run 2026-08-12. The reverse walk removed from `verifySnapshotIntegrity`, rebuilt,
 * re-run:
 *
 *   ✖ MOAT (F2): deleting a metric from the manifest must not shrink the denominator (9.669459ms)
 *     AssertionError [ERR_ASSERTION]: a hand-shrunk anchor is a REFUSED anchor, never a smaller one
 *
 *     0 !== 2
 *
 *   ℹ pass 8
 *   ℹ fail 1
 *
 * `0 !== 2` is the drifted capture reaching exit 0 and reporting "clean". Restored: 9 pass,
 * 0 fail.
 */
test("MOAT (F2): deleting a metric from the manifest must not shrink the denominator", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);

  // CONTROL, then the drift the attack exists to hide: runSpeed baseline ~2.816, +1.0 is
  // far beyond max(0.05, 5%).
  const cleanPath = await writeMeasurements(path.dirname(ws), baseline);
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", cleanPath]), 0);
  const driftedPath = await writeMeasurements(path.dirname(ws), { ...baseline, runSpeed: baseline.runSpeed + 1 });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", driftedPath]), 1);
  assert.equal(JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8")).summary.total, 3);

  // THE ATTACK: delete the drifted metric from the manifest. The frozen measurements file
  // is untouched (its sha256 still matches), so nothing else in the bundle looks edited.
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  delete doc.metrics.runSpeed;
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", driftedPath]),
    2,
    "a hand-shrunk anchor is a REFUSED anchor, never a smaller one",
  );
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.integrity.ok, false);
  assert.ok(
    report.integrity.failures.some((f: string) => f.includes("runSpeed") && f.includes("frozen measurements")),
    `the refusal must name the deleted metric: ${JSON.stringify(report.integrity.failures)}`,
  );
  assert.equal(report.summary.total, 0, "a refused snapshot grades nothing, so it certifies nothing");
  assert.notEqual(report.status, "clean");
});

test("F2 false-failure check: a metric that was never measured is in neither set and is no refusal", async () => {
  // The reverse walk must not punish an HONEST partial snapshot. A coverage gap keeps the
  // metric out of `measurements.metrics` entirely, so it is absent from the manifest too,
  // and `--allow-partial` records the gap rather than inventing a frozen value. If this
  // ever reads as "a metric the manifest fails to declare", every partially-captured
  // project is permanently red.
  const { root, ws } = await scaffold();
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.mkdir(candidate, { recursive: true });
  const live = JSON.parse(await fs.readFile(path.join(LIVE_DIR, "feel.json"), "utf-8")) as Record<string, unknown>;
  delete live.jumpApex;
  await fs.writeFile(
    path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE),
    JSON.stringify({ ...live, captureCoverage: [{ metric: "jumpApex", status: "attempted-blocked", reason: "settle timeout" }] }, null, 2),
    "utf-8",
  );
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--allow-partial"]),
    0,
    "a recorded coverage gap is approvable with --allow-partial",
  );

  const manifest = JSON.parse(
    await fs.readFile(path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST), "utf-8"),
  );
  assert.ok(!("jumpApex" in manifest.metrics), "the unmeasured metric was never frozen");
  const mPath = await writeMeasurements(path.dirname(ws), {
    runSpeed: manifest.metrics.runSpeed.value,
    timeToApex: manifest.metrics.timeToApex.value,
  });
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]),
    0,
    "an honest partial snapshot still grades clean",
  );
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.integrity.ok, true);
  assert.equal(report.summary.total, 2);
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
