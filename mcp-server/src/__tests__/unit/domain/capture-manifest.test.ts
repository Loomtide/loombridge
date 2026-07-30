/**
 * THE manifest-completeness predicate (H4's extraction).
 *
 * `capture`, `status` and both `doneness` paths ask the same question about a
 * minted `captureManifest`, and they used to ask it in three separately written
 * loops. These tests pin the ONE predicate's three answer classes (present,
 * missing, unsafe) and, at the end, a non-vacuous guard that the callers really
 * delegate to it rather than growing a fourth copy that could drift into a skip.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CAPTURE_REPORT_FILE, captureReportPath, checkCaptureManifest } from "../../../domain/capture-manifest.js";
import { REPO_ROOT } from "../../_support/paths.js";

async function tmpVerifyRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-manifest-"));
  await fs.mkdir(path.join(dir, "verify", "parallax"), { recursive: true });
  return path.join(dir, "verify");
}

test("checkCaptureManifest: an entry on disk is present and the manifest is complete", async () => {
  const verifyRoot = await tmpVerifyRoot();
  await fs.writeFile(path.join(verifyRoot, "parallax", "console.json"), "{}\n", "utf-8");

  const result = await checkCaptureManifest({
    manifest: ["parallax/console.json"],
    verifyRoot,
    scopeRoot: path.join(verifyRoot, "parallax"),
  });
  assert.deepEqual(result.present, ["parallax/console.json"]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unsafe, []);
  assert.equal(result.complete, true);
  await fs.rm(path.dirname(verifyRoot), { recursive: true, force: true });
});

test("checkCaptureManifest: an entry with no file is MISSING and the manifest is incomplete", async () => {
  const verifyRoot = await tmpVerifyRoot();
  const result = await checkCaptureManifest({
    manifest: ["parallax/console.json", "parallax/coverage.json"],
    verifyRoot,
    scopeRoot: path.join(verifyRoot, "parallax"),
  });
  assert.deepEqual(result.missing, ["parallax/console.json", "parallax/coverage.json"]);
  assert.equal(result.complete, false);
  await fs.rm(path.dirname(verifyRoot), { recursive: true, force: true });
});

test("checkCaptureManifest: a traversal entry is UNSAFE, never merely missing", async () => {
  // The classes are kept apart on purpose: a caller that only looks at `missing`
  // must not be able to see a traversal entry as an ordinary absent file.
  const verifyRoot = await tmpVerifyRoot();
  const result = await checkCaptureManifest({
    manifest: ["../../../etc/passwd", "/absolute/console.json"],
    verifyRoot,
  });
  assert.deepEqual(result.unsafe, ["../../../etc/passwd", "/absolute/console.json"]);
  assert.deepEqual(result.missing, []);
  assert.equal(result.complete, false);
  assert.ok(result.entries.every((e) => e.exists === false));
  await fs.rm(path.dirname(verifyRoot), { recursive: true, force: true });
});

test("checkCaptureManifest: a path-safe entry outside the SLICE scope is unsafe too", async () => {
  // `other-slice/console.json` is a perfectly normal relative path. It is still
  // out of bounds for a slice-scoped manifest, and it EXISTS on disk here, so a
  // scope check that fell back to "does the file exist" would pass it.
  const verifyRoot = await tmpVerifyRoot();
  await fs.mkdir(path.join(verifyRoot, "other-slice"), { recursive: true });
  await fs.writeFile(path.join(verifyRoot, "other-slice", "console.json"), "{}\n", "utf-8");

  const scoped = await checkCaptureManifest({
    manifest: ["other-slice/console.json"],
    verifyRoot,
    scopeRoot: path.join(verifyRoot, "parallax"),
  });
  assert.deepEqual(scoped.unsafe, ["other-slice/console.json"]);

  // Positive control: the SAME entry under a whole-game manifest (no scopeRoot)
  // is in bounds and present, so the refusal above is the scope rule firing and
  // not the entry being malformed.
  const wholeGame = await checkCaptureManifest({ manifest: ["other-slice/console.json"], verifyRoot });
  assert.deepEqual(wholeGame.unsafe, []);
  assert.deepEqual(wholeGame.present, ["other-slice/console.json"]);
  await fs.rm(path.dirname(verifyRoot), { recursive: true, force: true });
});

test("checkCaptureManifest: an empty manifest is complete (there is nothing declared to owe)", async () => {
  const verifyRoot = await tmpVerifyRoot();
  const result = await checkCaptureManifest({ manifest: [], verifyRoot });
  assert.equal(result.complete, true);
  await fs.rm(path.dirname(verifyRoot), { recursive: true, force: true });
});

test("captureReportPath: the report file name is declared once and resolved from the constant", () => {
  assert.equal(captureReportPath("/tmp/x"), path.join("/tmp/x", CAPTURE_REPORT_FILE));
  assert.equal(CAPTURE_REPORT_FILE, "capture-report.json");
});

test("every manifest-completeness caller DELEGATES to the shared predicate (no fourth copy)", async () => {
  // Non-vacuous by construction: the assertion below fails if any of these files
  // stops importing the predicate, which is exactly what re-growing a private
  // copy would look like. The LITMUS is to delete one import and watch it fail.
  const callers = [
    "mcp-server/src/capabilities/verification/capture.ts",
    "mcp-server/src/capabilities/verification/status-model.ts",
    "mcp-server/src/capabilities/verification/doneness.ts",
  ];
  for (const rel of callers) {
    const source = await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
    // A CALL, not merely the import: a file that keeps the import and answers the
    // question itself would satisfy a name-only match (observed while LITMUSing
    // this guard, which is why the pattern is anchored to the call site).
    assert.match(source, /checkCaptureManifest\(\{/, `${rel} must CALL the shared manifest predicate`);
    // The re-implementation shape it replaced: resolving a manifest entry against
    // the verify root and probing it directly.
    assert.equal(
      /for\s*\(const entry of (manifest|proof\.captureManifest)/.test(source),
      false,
      `${rel} appears to walk a captureManifest itself instead of delegating`,
    );
  }
});
