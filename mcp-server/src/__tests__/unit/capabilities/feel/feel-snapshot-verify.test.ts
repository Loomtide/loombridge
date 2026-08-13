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

/*
 * A1: A NON-NUMERIC TOLERANCE MAKES EVERY METRIC MATCH FOREVER.
 *
 * `resolveTolerance` computes `applied = max(abs, relPct * |baseline|)`. `Math.max` returns
 * NaN if any argument is NaN, and every comparison against NaN is false, so
 * `|delta| > applied` was false for EVERY delta. The metric printed `ok` and the run exited 0.
 *
 * Two routes reached it, and neither needs an adversary:
 *
 *   ROUTE 1 (operator typo at approve):
 *     `--tolerances '{"perMetric":{"runSpeed":{"relPct":"5%"}}}'`
 *     `snapshot.ts` validated the perMetric KEYS against the candidate metrics and never
 *     looked at the values, so the string froze into `manifest.json` verbatim.
 *
 *   ROUTE 2 (one deleted key in the frozen manifest):
 *     remove `tolerancePolicy.defaultRelPct`. `loadSnapshotManifest` only checked
 *     `isRecord(parsed.tolerancePolicy)`, and the manifest carries no self-hash, so
 *     `verifySnapshotIntegrity` had nothing to catch it with.
 *
 * BEFORE, both routes, real approve + real `verify --snapshot` (offline `--measurements`):
 *
 *   [route1] approve exit: 0
 *   [route1] verify exit: 0 status: clean total: 3
 *   [route1] runSpeed row: {"id":"runSpeed","baseline":2.816090515407144,"current":99999,
 *            "delta":99996.1839094846,"tolerance":{"abs":0.05,"relPct":"5%","applied":null},
 *            "status":"match","confidence":"reported",
 *            "detail":"runSpeed: 2.816090515407144 -> 99999 (delta +99996.1839, tolerance NaN) ok."}
 *   [route2] approve exit: 0
 *   [route2] verify exit: 0 status: clean total: 3 integrity.ok: true
 *
 * (`applied: null` is JSON's rendering of NaN.)
 *
 * AFTER: route 1 is refused at the APPROVE door (exit 2, nothing freezes) and route 2 at the
 * READ door (`verifySnapshotIntegrity`, exit 2, `total: 0`).
 *
 * LITMUS, run 2026-08-13, in two passes because the fix is two layers deep.
 *
 * PASS 1, `tolerancePolicyRefusals` neutered to `return []` (the refusals), rebuilt, re-run:
 *
 *   ✖ MOAT (A1): a non-numeric tolerance must never reach exit 0: route 1, the approve door (4.131208ms)
 *     AssertionError [ERR_ASSERTION]: a tolerance that is not a number must never FREEZE
 *     0 !== 2
 *   ✖ MOAT (A1): a non-numeric tolerance must never reach exit 0: route 2, the manifest read door (8.564125ms)
 *     AssertionError [ERR_ASSERTION]: a manifest whose tolerance policy cannot grade anything must not grade everything green
 *     1 !== 2
 *   ℹ pass 10
 *   ℹ fail 2
 *
 * Route 2's `1 !== 2` rather than `0 !== 2` is the SECOND layer showing itself: with the
 * refusal gone, `compareSnapshot`'s fail-closed `!(|delta| <= applied + 1e-9)` still called
 * the NaN-tolerance metric a DRIFT, so the run landed on exit 1 instead of a false green.
 *
 * PASS 2, the fail-closed comparator ALSO reverted to `|delta| > applied + 1e-9`, which is
 * the code exactly as it shipped before this PR:
 *
 *   ✖ MOAT (A1): a non-numeric tolerance must never reach exit 0: route 1, the approve door (3.71ms)
 *     AssertionError [ERR_ASSERTION]: a tolerance that is not a number must never FREEZE
 *     0 !== 2
 *   ✖ MOAT (A1): a non-numeric tolerance must never reach exit 0: route 2, the manifest read door (8.19625ms)
 *     AssertionError [ERR_ASSERTION]: a manifest whose tolerance policy cannot grade anything must not grade everything green
 *     0 !== 2
 *   ℹ pass 10
 *   ℹ fail 2
 *
 * `0 !== 2` is a +99996 drift reaching exit 0. Both layers restored: 12 pass, 0 fail.
 */
test("MOAT (A1): a non-numeric tolerance must never reach exit 0: route 1, the approve door", async () => {
  const { root, ws } = await scaffold();
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");

  // THE TYPO. A percent sign where a fraction belongs.
  const tolerances = path.join(path.dirname(ws), "tolerances.json");
  await fs.writeFile(tolerances, JSON.stringify({ perMetric: { runSpeed: { relPct: "5%" } } }), "utf-8");
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--tolerances", tolerances]),
    2,
    "a tolerance that is not a number must never FREEZE",
  );
  // Nothing was frozen, so there is nothing to grade against, and the run cannot exit 0 here either.
  const mPath = await writeMeasurements(path.dirname(ws), { runSpeed: 99999 });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", mPath]), 2);

  // AND THE SAME REFUSAL FOR THE OTHER TOLERANCE KEYS, so the fix is not one special case.
  for (const bad of [
    { defaultRelPct: "5%" },
    { defaultAbsFloorByDerivation: { trajectory: "x" } },
    { perMetric: { runSpeed: { abs: Number.NaN } } },
    { perMetric: { runSpeed: { relPct: -0.1 } } },
    { perMetric: { runSpeed: { relPCT: 0.5 } } }, // a typo'd KEY silently vanished into the default
  ]) {
    await fs.writeFile(tolerances, JSON.stringify(bad), "utf-8");
    assert.equal(
      await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--tolerances", tolerances]),
      2,
      `approve must refuse ${JSON.stringify(bad)}`,
    );
  }
});

test("MOAT (A1): a non-numeric tolerance must never reach exit 0: route 2, the manifest read door", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);

  // CONTROL: the drift the attack exists to hide is caught while the policy is intact.
  const driftedPath = await writeMeasurements(path.dirname(ws), { ...baseline, runSpeed: 99999 });
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", driftedPath]), 1);

  // THE ATTACK: delete ONE key. The frozen measurements are untouched, so their sha256 still
  // matches and nothing else in the bundle looks edited.
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  delete doc.tolerancePolicy.defaultRelPct;
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", driftedPath]),
    2,
    "a manifest whose tolerance policy cannot grade anything must not grade everything green",
  );
  const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
  assert.equal(report.integrity.ok, false);
  assert.ok(
    report.integrity.failures.some((f: string) => f.includes("tolerancePolicy.defaultRelPct")),
    `the refusal must name the key: ${JSON.stringify(report.integrity.failures)}`,
  );
  assert.equal(report.summary.total, 0, "a refused snapshot grades nothing, so it certifies nothing");

  // The same for a poisoned VALUE rather than a deleted key, which is the shape route 1 would
  // have frozen before approve started refusing it.
  doc.tolerancePolicy.defaultRelPct = "5%";
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
  assert.equal(await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", driftedPath]), 2);
});

test("A1 false-failure check: ordinary snapshots, ZERO tolerances, and --allow-partial all still grade", async () => {
  // The tolerance-policy refusal runs on every manifest read, so if it is even slightly wrong
  // every project with a frozen feel snapshot goes permanently red. Three shapes that MUST stay
  // green:
  //
  //  1. a snapshot approved with NO `--tolerances` at all (the overwhelmingly common case, and
  //     the only shape that existed before per-metric overrides);
  //  2. a deliberately EXACT metric: `abs: 0` / `relPct: 0` is a legitimate zero-width band, so
  //     the predicate is `>= 0`, not `> 0`;
  //  3. a legitimately partial snapshot (`--allow-partial`), whose policy is untouched by the
  //     coverage gap.
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const clean = await writeMeasurements(path.dirname(ws), baseline);
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", clean]),
    0,
    "a default-tolerance snapshot must still grade clean",
  );

  const zero = await scaffold();
  const zeroCandidate = feelPaths(zero.ws).snapshotCandidateDir;
  await fs.mkdir(zeroCandidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(zeroCandidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(zeroCandidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  const zeroTolerances = path.join(path.dirname(zero.ws), "zero-tolerances.json");
  await fs.writeFile(zeroTolerances, JSON.stringify({ perMetric: { runSpeed: { abs: 0, relPct: 0 } } }), "utf-8");
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", zero.root, "--workspace", zero.ws, "--tolerances", zeroTolerances]),
    0,
    "a zero-width tolerance band is a legitimate (strict) choice, not a broken policy",
  );
  const zeroBaseline = JSON.parse(await fs.readFile(path.join(LIVE_DIR, "feel.json"), "utf-8"));
  const zeroClean = await writeMeasurements(path.dirname(zero.ws), {
    runSpeed: zeroBaseline.runSpeed,
    jumpApex: zeroBaseline.jumpApex,
    timeToApex: zeroBaseline.timeToApex,
  });
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", zero.root, "--workspace", zero.ws, "--measurements", zeroClean]),
    0,
    "an exactly-matching capture under a zero tolerance must still be clean",
  );

  // APPROVE/READ PARITY, in the STRICT direction. `readTolerances` refused a top-level
  // `defaultRelPct` unless it was `> 0` while `tolerancePolicyRefusals` (the read door) accepts
  // `>= 0`, and the comment beside it claimed the two refuse identically. A zero band is a
  // legitimate, STRICTER choice, which is exactly the class of value a refusal must never touch:
  // the bounds belong on what LOOSENS the gate. It could not false-green, but a door pair that
  // disagrees is a door pair somebody will later "fix" in the wrong direction.
  const strictZero = await scaffold();
  const strictCandidate = feelPaths(strictZero.ws).snapshotCandidateDir;
  await fs.mkdir(strictCandidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(strictCandidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(strictCandidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  const strictTolerances = path.join(path.dirname(strictZero.ws), "strict.json");
  await fs.writeFile(strictTolerances, JSON.stringify({ defaultRelPct: 0 }), "utf-8");
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", strictZero.root, "--workspace", strictZero.ws, "--tolerances", strictTolerances]),
    0,
    "a zero DEFAULT relative band is as legitimate as a zero per-metric one, and both doors must say so",
  );
  const frozenStrict = JSON.parse(
    await fs.readFile(path.join(feelPaths(strictZero.ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST), "utf-8"),
  );
  assert.equal(
    frozenStrict.tolerancePolicy.defaultRelPct,
    0,
    "and the zero must FREEZE, not silently fall back to the 0.05 default the operator did not ask for",
  );
});

test("a tampered tolerancePolicy reads as a TAMPERED anchor, not as an absent one", async () => {
  // `loadSnapshotManifest` returns null for a manifest whose SHAPE is refused, and
  // `runVerifySnapshot` reported that as "no approved feel snapshot: nothing to grade", pointing
  // the operator at `feel snapshot capture` for a snapshot that is already on disk. The exit code
  // was right (2) and the narration was not: a hand-edited anchor read as an empty workspace.
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);
  const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  doc.tolerancePolicy = [];
  await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
  const measurements = await writeMeasurements(path.dirname(ws), baseline);

  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  let code: number;
  try {
    code = await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", measurements]);
  } finally {
    console.error = originalError;
  }
  const text = lines.join("\n");
  assert.equal(code, 2, "a tampered anchor is a harness-tier refusal, as it always was");
  assert.match(text, /present but REFUSED/, text);
  assert.doesNotMatch(text, /nothing to grade/, text);
});

/*
 * A2: THE TOLERANCE WAS BOUNDED FOR TYPE AND NEVER FOR MAGNITUDE.
 *
 * A1 (above) closed "the tolerance is not a number". The attack then moved one step to the
 * right: supply a number that is finite, non-negative, correctly typed, and so large that
 * nothing can ever fall outside it. `tolerancePolicyRefusals` accepted any finite `>= 0`, so
 * the SAME +99996 drift that exits 1 under the intact policy exited 0 under `1e6`, and
 * `integrity.ok` came back TRUE: the tampered anchor positively certified itself, which is
 * worse than the silence A1 removed.
 *
 * BEFORE, one approved snapshot, one drifted capture, four routes:
 *
 *   [control: intact policy, +99996 drift]                  exit 1
 *   [ATTACK: defaultRelPct = 1e6]                           exit 0  clean  integrity.ok: true
 *                                                           "runSpeed: … tolerance 1000000000 ok."
 *   [ATTACK: defaultAbsFloorByDerivation.trajectory = 1e9]  exit 0  clean  integrity.ok: true
 *   [ATTACK: perMetric.runSpeed.abs = MAX_VALUE]            exit 0  clean  integrity.ok: true
 *   [ATTACK via the approve door, no hand-edit at all:
 *     --tolerances '{"defaultRelPct":1e6}']                 approve exit 0, verify exit 0
 *
 * THE PRECEDENT IS IN THIS REPO AND POINTS THE OTHER WAY: the trace baseline caps
 * `driftTolerance` at `MAX_DRIFT_TOLERANCE` (0.02) inside `loadTraceBaselineManifest`, the one
 * reader every grader goes through, with the refusal naming the cap. This mirrors it.
 *
 * TWO BOUNDS, because one constant cannot bound both halves of `max(abs, relPct * |baseline|)`:
 *
 *  - `relPct` is DIMENSIONLESS, so a constant bounds it: `MAX_SNAPSHOT_REL_PCT`.
 *  - `abs` is in the metric's NATIVE UNIT (seconds, ms, world units), so no constant can bound
 *    it. It is bounded against the frozen BASELINE instead, which is recomputable from the
 *    bundle by the same reader: `applied <= max(MAX_SNAPSHOT_REL_PCT * |baseline|,
 *    shipped floor for the derivation)`. The shipped floor is a code constant, so the
 *    zero-baseline case (where the relative half is 0) still has a bound.
 *
 * LITMUS, run 2026-08-13. `toleranceMagnitudeRefusals` neutered to `return []` and the
 * `MAX_SNAPSHOT_REL_PCT` check removed from `tolerancePolicyRefusals`, rebuilt, re-run:
 *
 *   ✖ MOAT (A2): a tolerance so wide that nothing can fall outside it is not a tolerance (11.653625ms)
 *     AssertionError [ERR_ASSERTION]: a relPct of 1e6 makes every metric match forever
 *
 *     0 !== 2
 *
 *   ✖ MOAT (A2): the approve door refuses a vacuous tolerance before it can freeze (7.9865ms)
 *     AssertionError [ERR_ASSERTION]: approve must refuse {"defaultRelPct":1000000}
 *
 *     0 !== 2
 *
 *   ℹ pass 13
 *   ℹ fail 2
 *
 * `0 !== 2` is a +99996 drift reaching exit 0 with `integrity.ok: true`. Restored: 15 pass, 0 fail.
 */
test("MOAT (A2): a tolerance so wide that nothing can fall outside it is not a tolerance", async () => {
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const manifestPath = path.join(feelPaths(ws).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST);
  const drifted = await writeMeasurements(path.dirname(ws), { ...baseline, runSpeed: 99999 });
  const frozen = JSON.parse(await fs.readFile(manifestPath, "utf-8"));

  // CONTROL: the drift every attack below exists to hide.
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", drifted]),
    1,
    "the intact policy must catch a +99996 drift",
  );

  // Each attack edits ONE tolerance number. The frozen measurements are untouched, so their
  // sha256 still matches and every other integrity check stays green.
  const attacks: Array<{ label: string; mutate: (policy: Record<string, unknown>) => void; names: RegExp }> = [
    {
      label: "defaultRelPct = 1e6",
      mutate: (p) => { p.defaultRelPct = 1e6; },
      names: /tolerancePolicy\.defaultRelPct/,
    },
    {
      label: "defaultRelPct = 1e308",
      mutate: (p) => { p.defaultRelPct = 1e308; },
      names: /tolerancePolicy\.defaultRelPct/,
    },
    {
      label: "defaultAbsFloorByDerivation.trajectory = 1e9",
      mutate: (p) => { (p.defaultAbsFloorByDerivation as Record<string, number>).trajectory = 1e9; },
      names: /runSpeed/,
    },
    {
      label: "perMetric.runSpeed.abs = MAX_VALUE",
      mutate: (p) => { p.perMetric = { runSpeed: { abs: Number.MAX_VALUE } }; },
      names: /runSpeed/,
    },
  ];

  for (const attack of attacks) {
    const doc = JSON.parse(JSON.stringify(frozen));
    attack.mutate(doc.tolerancePolicy);
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
    assert.equal(
      await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", drifted]),
      2,
      `a ${attack.label} makes every metric match forever`,
    );
    const report = JSON.parse(await fs.readFile(feelPaths(ws).driftReport, "utf-8"));
    assert.equal(report.integrity.ok, false, `${attack.label}: a tampered anchor must never certify itself`);
    assert.ok(
      report.integrity.failures.some((f: string) => attack.names.test(f)),
      `${attack.label}: the refusal must name what is too wide: ${JSON.stringify(report.integrity.failures)}`,
    );
    assert.equal(report.summary.total, 0, `${attack.label}: a refused snapshot grades nothing`);
  }
});

test("MOAT (A2): the approve door refuses a vacuous tolerance before it can freeze", async () => {
  // The hand-edit above is the harder route. These reach the same place through the ORDINARY
  // door, with no editing of a frozen file at all.
  const { root, ws } = await scaffold();
  const candidate = feelPaths(ws).snapshotCandidateDir;
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  const tolerances = path.join(path.dirname(ws), "wide-tolerances.json");

  for (const bad of [
    { defaultRelPct: 1e6 },
    { defaultRelPct: 1 },
    { perMetric: { runSpeed: { relPct: 5 } } },
    { perMetric: { runSpeed: { abs: Number.MAX_VALUE } } },
    { defaultAbsFloorByDerivation: { trajectory: 1e9 } },
  ]) {
    await fs.writeFile(tolerances, JSON.stringify(bad), "utf-8");
    assert.equal(
      await runFeelCli(["snapshot", "approve", "--root", root, "--workspace", ws, "--tolerances", tolerances]),
      2,
      `approve must refuse ${JSON.stringify(bad)}`,
    );
  }
});

test("A2 false-failure check: the shipped defaults, a legitimately WIDE band, and a small baseline all still grade", async () => {
  // The magnitude cap runs on every manifest read, so a cap that is even slightly wrong turns a
  // legitimate project permanently red, and a cap that gets relaxed later is how the hole comes
  // back. Four shapes that MUST stay green:
  //
  //  1. the shipped default policy on the real live-capture baseline (`applied = max(shipped
  //     floor, 0.05|b|)` is inside `max(MAX_SNAPSHOT_REL_PCT |b|, shipped floor)` BY
  //     CONSTRUCTION, for every baseline value including zero. That is the argument for the
  //     shape of the bound, and this is the test of it);
  //  2. a project that legitimately needs a WIDE band: 40% relative on a jittery metric;
  //  3. a per-metric ABS override several times the shipped floor, on a metric whose baseline is
  //     large enough to justify it;
  //  4. a SMALL baseline (jumpApex 0.8, whose 5% relative band is under the shipped 0.05 floor),
  //     which is the case a naive `applied <= MAX * |baseline|` cap would have failed.
  const { root, ws } = await scaffold();
  const baseline = await approvedSnapshot(root, ws);
  const clean = await writeMeasurements(path.dirname(ws), baseline);
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", root, "--workspace", ws, "--measurements", clean]),
    0,
    "the shipped default policy must never trip its own cap",
  );

  const wide = await scaffold();
  const wideCandidate = feelPaths(wide.ws).snapshotCandidateDir;
  await fs.mkdir(wideCandidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(wideCandidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(wideCandidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");
  const wideTolerances = path.join(path.dirname(wide.ws), "wide.json");
  await fs.writeFile(
    wideTolerances,
    JSON.stringify({ defaultRelPct: 0.4, perMetric: { timeToApex: { abs: 4 } } }),
    "utf-8",
  );
  assert.equal(
    await runFeelCli(["snapshot", "approve", "--root", wide.root, "--workspace", wide.ws, "--tolerances", wideTolerances]),
    0,
    "a 40% band and a 4-unit floor on a 40.53 baseline are wide but not vacuous",
  );
  const wideClean = await writeMeasurements(path.dirname(wide.ws), baseline);
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", wide.root, "--workspace", wide.ws, "--measurements", wideClean]),
    0,
    "a legitimately wide snapshot must still grade",
  );
  // And it is still a gate: 40% of 2.816 is 1.126, so a +2 drift is still DRIFT.
  const wideDrift = await writeMeasurements(path.dirname(wide.ws), { ...baseline, runSpeed: baseline.runSpeed + 2 });
  assert.equal(
    await runVerifyCli(["--snapshot", "--root", wide.root, "--workspace", wide.ws, "--measurements", wideDrift]),
    1,
    "a wide band is still a band",
  );
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
