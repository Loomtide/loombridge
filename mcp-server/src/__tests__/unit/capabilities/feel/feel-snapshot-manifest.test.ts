import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SNAPSHOT_TOLERANCES,
  FEEL_SNAPSHOT_MANIFEST,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
  derivationsFromContract,
  loadSnapshotManifest,
  rederiveView,
  verifySnapshotIntegrity,
  writeSnapshotBundle,
  type FeelSnapshotManifest,
} from "../../../../capabilities/feel/snapshot-manifest.js";
import { loadMeasurements } from "../../../../capabilities/feel/measurements.js";
import { REPO_ROOT } from "../../../_support/paths.js";

// The REAL S5c-b live-capture artifacts: feel.json re-derives cleanly (verified),
// feel-tampered.json carries a hand-set jumpApex its own samples refute.
const LIVE_DIR = path.join(REPO_ROOT, "Docs", "Profiles", "artifacts", "s5cb-live-capture");

const CONTRACT_FIXTURE = {
  schemaVersion: "1",
  game: "fixture-game",
  subjects: [{ id: "player", locator: { path: "/Player" } }],
  interactions: [
    { id: "run", kind: "key-hold", key: "d" },
    { id: "jump", kind: "key-tap", key: "space" },
  ],
  metrics: [
    { metric: "runSpeed", interactionId: "run", derivation: "trajectory" },
    { metric: "jumpApex", interactionId: "jump", derivation: "trajectory" },
    { metric: "timeToApex", interactionId: "jump", derivation: "trajectory" },
  ],
};

async function stageCandidate(measurementsFile: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feel-snapshot-"));
  const candidate = path.join(dir, "candidate");
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, measurementsFile), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  return dir;
}

async function approveFixture(root: string): Promise<{ currentDir: string; manifest: FeelSnapshotManifest }> {
  const candidate = path.join(root, "candidate");
  const currentDir = path.join(root, "current");
  const measurements = await loadMeasurements(path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  const view = rederiveView(measurements);
  const derivations = derivationsFromContract(CONTRACT_FIXTURE);
  const metrics: FeelSnapshotManifest["metrics"] = {};
  for (const [id, value] of Object.entries(measurements.metrics)) {
    metrics[id] = {
      value,
      derivation: derivations.get(id),
      confidence: view.verified.has(id) ? "verified" : "reported",
    };
  }
  const manifest = await writeSnapshotBundle({
    candidateDir: candidate,
    currentDir,
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    note: "fixture approve",
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    metrics,
    rederivation: { pass: view.pass, total: view.total },
    game: "fixture-game",
    contractStats: { interactions: 2, metrics: 3 },
  });
  return { currentDir, manifest };
}

test("a pristine bundle round-trips: written, loadable, integrity ok, values verified", async () => {
  const root = await stageCandidate("feel.json");
  const { currentDir, manifest } = await approveFixture(root);

  assert.equal(manifest.kind, "feel-snapshot");
  assert.equal(manifest.metrics.runSpeed.confidence, "verified");
  assert.equal(manifest.metrics.runSpeed.derivation, "trajectory");

  const loaded = await loadSnapshotManifest(currentDir);
  assert.ok(loaded);
  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, true, integrity.failures.join("; "));
  assert.ok(integrity.measurements);
});

test("LITMUS: a hand-edited manifest metric value fails integrity, naming the metric", async () => {
  const root = await stageCandidate("feel.json");
  const { currentDir } = await approveFixture(root);
  const manifestPath = path.join(currentDir, FEEL_SNAPSHOT_MANIFEST);
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  doc.metrics.runSpeed.value = 9.0; // "the game runs at 9, trust me"
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.failures.some((f) => f.includes("'runSpeed'") && f.includes("!=")), integrity.failures.join("; "));
});

test("LITMUS: editing the frozen measurements after approve fails the sha check", async () => {
  const root = await stageCandidate("feel.json");
  const { currentDir } = await approveFixture(root);
  const mPath = path.join(currentDir, SNAPSHOT_MEASUREMENTS_FILE);
  const doc = JSON.parse(await fs.readFile(mPath, "utf-8"));
  doc.runSpeed = 9.0;
  await fs.writeFile(mPath, JSON.stringify(doc, null, 2), "utf-8");

  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.failures.some((f) => f.includes("measurements sha256 mismatch")), integrity.failures.join("; "));
});

test("the ownership stamp: a new approval records the PROJECT root, and a legacy manifest without it still verifies", async () => {
  // The snapshot lives in an external workspace derived from the project's BASENAME,
  // so two checkouts can resolve to the same workspace. The stamp is what lets a
  // reader refuse project B being graded against project A's frozen feel.
  const root = await stageCandidate("feel.json");
  const candidate = path.join(root, "candidate");
  const currentDir = path.join(root, "stamped");
  const measurements = await loadMeasurements(path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  const view = rederiveView(measurements);
  const metrics: FeelSnapshotManifest["metrics"] = {};
  for (const [id, value] of Object.entries(measurements.metrics)) {
    metrics[id] = { value, confidence: view.verified.has(id) ? "verified" : "reported" };
  }
  const written = await writeSnapshotBundle({
    candidateDir: candidate,
    currentDir,
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    metrics,
    rederivation: { pass: view.pass, total: view.total },
    projectRoot: "/projects/knights-quest",
    contractStats: { interactions: 2, metrics: 3 },
  });
  assert.equal(written.projectRoot, "/projects/knights-quest");
  const loaded = await loadSnapshotManifest(currentDir);
  assert.equal(loaded?.projectRoot, "/projects/knights-quest");
  assert.equal((await verifySnapshotIntegrity(currentDir)).ok, true);

  // Schema tolerance: the legacy shape (no stamp) must still load AND verify. An
  // unstamped snapshot is a provenance gap for the caller, never tampering here.
  const legacyDir = path.join(root, "legacy");
  await writeSnapshotBundle({
    candidateDir: candidate,
    currentDir: legacyDir,
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    metrics,
    rederivation: { pass: view.pass, total: view.total },
    contractStats: { interactions: 2, metrics: 3 },
  });
  const legacy = await loadSnapshotManifest(legacyDir);
  assert.ok(legacy, "a legacy manifest still loads");
  assert.equal(legacy.projectRoot, undefined);
  const integrity = await verifySnapshotIntegrity(legacyDir);
  assert.equal(integrity.ok, true, integrity.failures.join("; "));
});

test("LITMUS: swapping the frozen capture contract fails the sha check (binding is to HOW it was measured)", async () => {
  const root = await stageCandidate("feel.json");
  const { currentDir } = await approveFixture(root);
  const swapped = { ...CONTRACT_FIXTURE, interactions: [{ id: "run", kind: "key-hold", key: "ArrowRight" }] };
  await fs.writeFile(path.join(currentDir, SNAPSHOT_CONTRACT_FILE), JSON.stringify(swapped, null, 2), "utf-8");

  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.failures.some((f) => f.includes("capture contract sha256 mismatch")), integrity.failures.join("; "));
});

test("LITMUS: a baseline whose own samples refute a value fails its own re-derivation (doctored baseline)", async () => {
  // feel-tampered.json: jumpApex hand-set to 3.0, samples re-derive ~0.8. Even
  // with a manifest consistent with the FILE (sha and values match), the frozen
  // evidence itself is untrustworthy and integrity must refuse.
  const root = await stageCandidate("feel-tampered.json");
  const { currentDir, manifest } = await approveFixture(root);
  // The doctored value freezes only as "reported" (rederiveView distrusts it);
  // force the manifest to claim what a forger would claim.
  assert.equal(manifest.metrics.jumpApex.confidence, "reported");

  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, false);
  assert.ok(
    integrity.failures.some((f) => f.includes("fails its own re-derivation") && f.includes("'jumpApex'")),
    integrity.failures.join("; "),
  );
});

test("LITMUS: a manifest claiming 'verified' for a value the samples do not re-derive is refused", async () => {
  const root = await stageCandidate("feel.json");
  const { currentDir } = await approveFixture(root);
  const manifestPath = path.join(currentDir, FEEL_SNAPSHOT_MANIFEST);
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  // Add a metric the frozen measurements do not carry at all.
  doc.metrics.coyoteTime = { value: 0.1, derivation: "bisection", confidence: "verified" };
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

  const integrity = await verifySnapshotIntegrity(currentDir);
  assert.equal(integrity.ok, false);
  assert.ok(
    integrity.failures.some((f) => f.includes("'coyoteTime'") && f.includes("no value in the frozen measurements")),
    integrity.failures.join("; "),
  );
});

test("loadSnapshotManifest refuses a wrong kind, empty metrics, and unreadable JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feel-snapshot-shape-"));
  assert.equal(await loadSnapshotManifest(dir), null); // absent

  const manifestPath = path.join(dir, FEEL_SNAPSHOT_MANIFEST);
  await fs.writeFile(manifestPath, "not json", "utf-8");
  assert.equal(await loadSnapshotManifest(dir), null);

  await fs.writeFile(manifestPath, JSON.stringify({ kind: "minigame-baseline", schemaVersion: "1" }), "utf-8");
  assert.equal(await loadSnapshotManifest(dir), null);

  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      kind: "feel-snapshot",
      schemaVersion: "1",
      metrics: {},
      measurements: { sha256: "x" },
      captureContract: { sha256: "y" },
      approvedAt: "t",
      capturedAt: "t",
      tolerancePolicy: {},
    }),
    "utf-8",
  );
  assert.equal(await loadSnapshotManifest(dir), null, "empty metrics must not load");
});

test("derivationsFromContract maps metric ids and tolerates junk", () => {
  const map = derivationsFromContract(CONTRACT_FIXTURE);
  assert.equal(map.get("runSpeed"), "trajectory");
  assert.equal(derivationsFromContract(null).size, 0);
  assert.equal(derivationsFromContract({ metrics: "nope" }).size, 0);
  assert.equal(derivationsFromContract({ metrics: [{ metric: 5, derivation: "x" }, "junk"] }).size, 0);
});
