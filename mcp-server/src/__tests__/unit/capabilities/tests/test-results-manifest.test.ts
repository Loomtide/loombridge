/**
 * The test-results binding manifest (plan T2, amendments G4/G5/G7/G8/G9).
 *
 * The manifest exists so a stored `test-results.xml` can be traced to the run that
 * produced it. These tests are about the three states a caller must be able to tell apart,
 * because conflating any two of them produces a false green:
 *
 *   UNSTAMPED  no manifest at all. A hand-dropped XML. Not broken, never an anchor.
 *   BROKEN     a manifest that is present but does not verify (edited results, a manifest
 *              copied from another checkout, results deleted out from under it).
 *   OK         a verifying pair, whose shas were RECOMPUTED from disk rather than believed.
 *
 * The sha checks are the whole point, so they get a LITMUS: a manifest that is trusted on
 * its own word is a manifest that certifies whatever bytes happen to be sitting there.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TEST_RESULTS_DIRNAME,
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  TEST_RUN_LOG_FILE,
  isTestResultsManifestError,
  loadTestResultsManifest,
  sha256,
  testResultsDir,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
  verifyTestResults,
  writeTestResultsManifest,
  type TestResultsManifest,
} from "../../../../capabilities/tests/test-results-manifest.js";

const XML = '<?xml version="1.0"?><test-run id="2" result="Passed" total="1" passed="1" />\n';
const LOG = "Unity Editor version:    6000.3.20f1 (0123456789ab)\nAll tests finished.\n";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-test-results-"));
}

function manifestFor(root: string, overrides: Partial<TestResultsManifest> = {}): TestResultsManifest {
  return {
    kind: "test-results",
    schemaVersion: "1",
    projectRoot: root,
    projectDeclaredEditorVersion: "6000.3.20f1",
    logReportedEditorVersion: "6000.3.20f1",
    resolvedEditorPath: "/Applications/Unity/Hub/Editor/6000.3.20f1/Unity.app/Contents/MacOS/Unity",
    testPlatform: "EditMode",
    startedAt: "2026-07-27T09:12:03.000Z",
    finishedAt: "2026-07-27T09:12:09.000Z",
    exitCode: 0,
    compileErrors: 0,
    assemblies: ["A.dll"],
    resultsSha256: sha256(XML),
    logSha256: sha256(LOG),
    runId: null,
    command: ["/Applications/Unity/Hub/Editor/6000.3.20f1/Unity.app/Contents/MacOS/Unity", "-batchmode"],
    summary: { total: 1, passed: 1, failed: 0, inconclusive: 0, skipped: 0 },
    mutatedProject: false,
    ...overrides,
  };
}

/** Plant a complete, verifying pair (plus log) in a fresh results dir. */
async function plantPair(overrides: Partial<TestResultsManifest> = {}): Promise<{ root: string; dir: string }> {
  const root = await tmpDir();
  const dir = testResultsDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(testResultsPath(dir), XML, "utf-8");
  await fs.writeFile(testRunLogPath(dir), LOG, "utf-8");
  await writeTestResultsManifest(dir, manifestFor(root, overrides));
  return { root, dir };
}

test("the slot lives at .loombridge/tests/ and every filename has one spelling", () => {
  assert.equal(testResultsDir("/p"), path.join("/p", ".loombridge", TEST_RESULTS_DIRNAME));
  assert.equal(testResultsPath("/d"), path.join("/d", TEST_RESULTS_FILE));
  assert.equal(testResultsManifestPath("/d"), path.join("/d", TEST_RESULTS_MANIFEST));
  assert.equal(testRunLogPath("/d"), path.join("/d", TEST_RUN_LOG_FILE));
});

test("roundtrip: a written manifest reads back identically and verifies", async () => {
  const { root, dir } = await plantPair();
  try {
    const loaded = await loadTestResultsManifest(dir);
    assert.ok(loaded !== null && !isTestResultsManifestError(loaded));
    assert.deepEqual(loaded, manifestFor(root));

    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.ok, true, integrity.failures.join("; "));
    assert.equal(integrity.unstamped, false);
    assert.equal(integrity.resultsBytes?.toString("utf-8"), XML);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LEGACY: no manifest at all is UNSTAMPED, not broken", async () => {
  const root = await tmpDir();
  try {
    const dir = testResultsDir(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(testResultsPath(dir), XML, "utf-8");

    assert.equal(await loadTestResultsManifest(dir), null);
    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.unstamped, true);
    assert.equal(integrity.ok, false);
    assert.deepEqual(integrity.failures, [], "unstamped is not a list of failures; it is a different state");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TAMPER: editing the results after the run breaks the sha binding", async () => {
  const { root, dir } = await plantPair();
  try {
    await fs.writeFile(testResultsPath(dir), XML.replace('passed="1"', 'passed="99"'), "utf-8");
    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.ok, false);
    assert.match(integrity.failures.join(" "), /sha256 mismatch/);
    assert.match(integrity.failures.join(" "), /edited after the run/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TAMPER: editing the run log breaks its binding too, when the log is still there", async () => {
  const { root, dir } = await plantPair();
  try {
    await fs.writeFile(testRunLogPath(dir), `${LOG}error CS0103: nothing to see here\n`, "utf-8");
    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.ok, false);
    assert.match(integrity.failures.join(" "), new RegExp(`${TEST_RUN_LOG_FILE} sha256 mismatch`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a DELETED log is not tampering; a log with no stamped sha is", async () => {
  const { root, dir } = await plantPair();
  try {
    await fs.rm(testRunLogPath(dir));
    const withoutLog = await verifyTestResults(dir, { root });
    assert.equal(withoutLog.ok, true, withoutLog.failures.join("; "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const second = await plantPair({ logSha256: null });
  try {
    const integrity = await verifyTestResults(second.dir, { root: second.root });
    assert.equal(integrity.ok, false);
    assert.match(integrity.failures.join(" "), /stamped no logSha256/);
  } finally {
    await fs.rm(second.root, { recursive: true, force: true });
  }
});

test("BROKEN (G9): a manifest whose results file is gone is broken, not unstamped", async () => {
  const { root, dir } = await plantPair();
  try {
    await fs.rm(testResultsPath(dir));
    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.unstamped, false, "deleting the evidence must not read as 'never produced'");
    assert.equal(integrity.ok, false);
    assert.match(integrity.failures.join(" "), new RegExp(`${TEST_RESULTS_FILE} is missing`));
    assert.match(integrity.failures.join(" "), /re-run `loombridge tests run`/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("BROKEN: a manifest carried over from another checkout does not vouch for this root", async () => {
  const { root, dir } = await plantPair({ projectRoot: "/somewhere/else" });
  try {
    const integrity = await verifyTestResults(dir, { root });
    assert.equal(integrity.ok, false);
    assert.match(integrity.failures.join(" "), /projectRoot is \/somewhere\/else/);

    // Without a root to check against, the projectRoot binding simply does not run: the
    // caller chose not to assert it. Everything else still verifies.
    const unbound = await verifyTestResults(dir);
    assert.equal(unbound.ok, true, unbound.failures.join("; "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the reader REFUSES a manifest missing any bound field, rather than skipping the check", async () => {
  // CLAUDE.md's anti-pattern: a falsy field that silently skips the binding it was there to
  // enforce. Every removal below must produce a named error, never a partially-trusted read.
  const root = await tmpDir();
  try {
    const dir = testResultsDir(root);
    await fs.mkdir(dir, { recursive: true });
    const full = manifestFor(root) as unknown as Record<string, unknown>;

    for (const field of [
      "projectRoot",
      "projectDeclaredEditorVersion",
      "resolvedEditorPath",
      "startedAt",
      "finishedAt",
      "resultsSha256",
      "testPlatform",
      "exitCode",
      "compileErrors",
      "mutatedProject",
      "assemblies",
      "command",
      "summary",
    ]) {
      const damaged = { ...full };
      delete damaged[field];
      await fs.writeFile(testResultsManifestPath(dir), JSON.stringify(damaged), "utf-8");
      const loaded = await loadTestResultsManifest(dir);
      assert.ok(
        loaded !== null && isTestResultsManifestError(loaded),
        `a manifest with no '${field}' must be refused, not accepted`,
      );
    }

    // ...and a summary missing one COUNT is refused too, or G12's comparison silently passes.
    const noPassed = { ...full, summary: { total: 1, failed: 0, inconclusive: 0, skipped: 0 } };
    await fs.writeFile(testResultsManifestPath(dir), JSON.stringify(noPassed), "utf-8");
    const loaded = await loadTestResultsManifest(dir);
    assert.ok(loaded !== null && isTestResultsManifestError(loaded));
    assert.match(loaded.error, /summary is missing a numeric 'passed'/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a malformed or foreign manifest is a typed error, never a throw", async () => {
  const root = await tmpDir();
  try {
    const dir = testResultsDir(root);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(testResultsManifestPath(dir), "{not json", "utf-8");
    const badJson = await loadTestResultsManifest(dir);
    assert.ok(badJson !== null && isTestResultsManifestError(badJson));
    assert.match(badJson.error, /not valid JSON/);

    await fs.writeFile(testResultsManifestPath(dir), JSON.stringify({ kind: "trace-baseline" }), "utf-8");
    const wrongKind = await loadTestResultsManifest(dir);
    assert.ok(wrongKind !== null && isTestResultsManifestError(wrongKind));
    assert.match(wrongKind.error, /kind is 'trace-baseline'/);

    await fs.writeFile(
      testResultsManifestPath(dir),
      JSON.stringify({ ...manifestFor(root), schemaVersion: "2" }),
      "utf-8",
    );
    const wrongVersion = await loadTestResultsManifest(dir);
    assert.ok(wrongVersion !== null && isTestResultsManifestError(wrongVersion));
    assert.match(wrongVersion.error, /schemaVersion is '2'/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runId and logReportedEditorVersion are nullable but type-checked (G7, G8)", async () => {
  const { root, dir } = await plantPair({ runId: "run-2026-07-27-abc", logReportedEditorVersion: null });
  try {
    const loaded = await loadTestResultsManifest(dir);
    assert.ok(loaded !== null && !isTestResultsManifestError(loaded));
    assert.equal(loaded.runId, "run-2026-07-27-abc");
    assert.equal(loaded.logReportedEditorVersion, null);

    await fs.writeFile(
      testResultsManifestPath(dir),
      JSON.stringify({ ...manifestFor(root), runId: 42 }),
      "utf-8",
    );
    const badRunId = await loadTestResultsManifest(dir);
    assert.ok(badRunId !== null && isTestResultsManifestError(badRunId));
    assert.match(badRunId.error, /'runId' must be a string or null/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
