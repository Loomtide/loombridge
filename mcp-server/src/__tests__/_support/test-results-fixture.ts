/**
 * The stamped test-results PLANTER: the fixture every consumer-side test of the
 * `test-results` asset kind builds on.
 *
 * It plants exactly what `loombridge tests run` leaves behind (`.loombridge/tests/` holding
 * the NUnit3 XML, the run log, and the binding manifest), and it stamps the manifest USING
 * THE PRODUCTION FUNCTIONS (`sha256`, `deriveSummary`, `parseNUnitResults`,
 * `writeTestResultsManifest`, `loombridgePaths`). Hand-computing a sha or a summary here
 * would mean the fixture and the grader could drift apart and every test would still pass:
 * the planter would be asserting its own arithmetic rather than the product's.
 *
 * The `tamper` seam is how the adversarial cases are built: a hand-edited manifest is
 * written through the same writer, so nothing about the forgery is special-cased.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { deriveSummary, isNUnitParseError, parseNUnitResults } from "../../capabilities/tests/nunit-parse.js";
import {
  sha256,
  testResultsDir,
  testResultsPath,
  testRunLogPath,
  writeTestResultsManifest,
  type TestResultsManifest,
} from "../../capabilities/tests/test-results-manifest.js";
import { PKG_ROOT } from "./paths.js";

/** The committed realistic EditMode fixture: 6 cases, 1 real failure, 1 skipped case. */
export const NUNIT_FIXTURE = path.join(PKG_ROOT, "src", "__tests__", "fixtures", "nunit", "editmode-run.xml");

export async function readNUnitFixture(): Promise<string> {
  return fs.readFile(NUNIT_FIXTURE, "utf-8");
}

/** An all-green EditMode run: two cases, one assembly, nothing skipped or ignored. */
export function greenNUnitXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
    '<test-run id="2" testcasecount="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0" asserts="0">',
    '  <test-suite type="TestSuite" id="1000" name="EditMode" fullname="EditMode" runstate="Runnable" result="Passed">',
    '    <test-suite type="Assembly" id="1001" name="Green.Tests.dll" fullname="/x/Green.Tests.dll" runstate="Runnable" result="Passed">',
    '      <test-suite type="TestFixture" id="1002" name="GreenTests" fullname="Green.GreenTests" runstate="Runnable" result="Passed">',
    '        <test-case id="1003" name="A" fullname="Green.GreenTests.A" runstate="Runnable" result="Passed" />',
    '        <test-case id="1004" name="B" fullname="Green.GreenTests.B" runstate="Runnable" result="Passed" />',
    "      </test-suite>",
    "    </test-suite>",
    "  </test-suite>",
    "</test-run>",
  ].join("\n");
}

export interface PlantTestResultsOpts {
  /** The NUnit3 document to plant. Defaults to the committed realistic fixture. */
  xml?: string;
  /** Unity's process exit code. Defaults to 2 when the walk found a failure, else 0. */
  exitCode?: number;
  /** `STATE.currentBuild.runId` as it stood when the run happened (G7). Default `null`. */
  runId?: string | null;
  /** Log text. Defaults to a banner-carrying, compile-error-free log. */
  log?: string;
  /** Mutate the manifest AFTER it is derived and BEFORE it is written (the forgery seam). */
  tamper?: (manifest: TestResultsManifest) => void;
  /** Delete the XML after stamping (G9: a manifest with no results is BROKEN, not absent). */
  omitResults?: boolean;
  /** Write the XML but NO manifest (the hand-dropped, unstamped case). */
  omitManifest?: boolean;
  /** Stamp `projectRoot` as some other checkout, so the ownership binding has something to catch. */
  projectRootOverride?: string;
  /**
   * Stamp the PORTABLE binding pair (F4: the producer stamps these when the project sits
   * in a git tree; door tests plant them to prove the portable rule is LIVE at each
   * door, not just in the predicate's own unit tests).
   *
   * The two are INDEPENDENT on purpose. Coupling them (a `projectPath` that only appeared
   * alongside a `repoIdentity`) made a HALF-stamped manifest unplantable, which is why
   * deleting the loader's `projectBindingPairError` call survived the whole suite: no test
   * could build the input the check exists for.
   */
  repoIdentity?: string;
  projectPath?: string;
}

/** Plant `.loombridge/tests/` for `root` exactly as `tests run` would. Returns that dir. */
export async function plantTestResults(root: string, opts: PlantTestResultsOpts = {}): Promise<string> {
  const xml = opts.xml ?? (await readNUnitFixture());
  const parsed = parseNUnitResults(xml);
  if (isNUnitParseError(parsed)) throw new Error(`fixture XML does not parse: ${parsed.error}`);
  const summary = deriveSummary(parsed);

  const dir = testResultsDir(root);
  await fs.mkdir(dir, { recursive: true });
  const resultsBytes = Buffer.from(xml, "utf-8");
  await fs.writeFile(testResultsPath(dir), resultsBytes);

  const log = opts.log ?? "Unity Editor version: 6000.3.20f1\nBatchmode finished.\n";
  const logBytes = Buffer.from(log, "utf-8");
  await fs.writeFile(testRunLogPath(dir), logBytes);

  if (!opts.omitManifest) {
    const manifest: TestResultsManifest = {
      kind: "test-results",
      schemaVersion: "1",
      projectRoot: opts.projectRootOverride ?? path.resolve(root),
      ...(opts.repoIdentity !== undefined ? { repoIdentity: opts.repoIdentity } : {}),
      ...(opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {}),
      projectDeclaredEditorVersion: "6000.3.20f1",
      logReportedEditorVersion: "6000.3.20f1",
      resolvedEditorPath: "/Applications/Unity/Hub/Editor/6000.3.20f1/Unity.app/Contents/MacOS/Unity",
      testPlatform: "EditMode",
      startedAt: "2026-07-28T09:12:03.000Z",
      finishedAt: "2026-07-28T09:12:09.000Z",
      exitCode: opts.exitCode ?? (summary.failed > 0 ? 2 : 0),
      compileErrors: 0,
      assemblies: parsed.assemblies,
      resultsSha256: sha256(resultsBytes),
      logSha256: sha256(logBytes),
      runId: opts.runId ?? null,
      command: ["/Applications/Unity/Hub/Editor/6000.3.20f1/Unity.app/Contents/MacOS/Unity", "-batchmode"],
      summary,
      mutatedProject: false,
    };
    opts.tamper?.(manifest);
    await writeTestResultsManifest(dir, manifest);
  }

  if (opts.omitResults) await fs.rm(testResultsPath(dir), { force: true });
  return dir;
}
