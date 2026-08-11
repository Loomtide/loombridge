/**
 * The test-results binding manifest: provenance for a stored Unity test run (plan T2,
 * amendments G4/G5/G7/G8/G9).
 *
 * `loombridge tests run` spawns a headless Unity, keeps the NUnit3 XML it produced, and
 * stamps this manifest beside it. Without the manifest the XML is a bag of bytes that
 * answers none of the questions a verdict has to answer about its evidence: WHICH bytes,
 * produced WHEN, on WHICH project root, by WHICH editor, under WHICH command line. A
 * hand-dropped `test-results.xml` therefore never grades, exactly as an unstamped trace
 * baseline never anchors.
 *
 * Same approve-once / freeze / refuse-drift grammar as `replay/trace-baseline-manifest.ts`
 * and `feel/snapshot-manifest.ts`: every integrity sha is recorded at write time and
 * RECOMPUTED at read time, so nothing in the manifest is trusted on its own word.
 *
 * WHAT IT PROVES, EXACTLY (G7 rewrote this sentence; the earlier draft overclaimed).
 * Binding proves the PROVENANCE OF BYTES: these results came out of this tool, at this
 * time, against this root, from this editor, under this command. `runId` additionally
 * SCOPES them to a build when a build was in flight. Staleness relative to source edits
 * remains UNPROVEN: nothing here notices that a `.cs` file changed after the run. That
 * limitation is documented rather than papered over, and it is the same one the unified
 * report already records for `runId`.
 *
 * THE SLOT IS COMMITTED (G5). Unlike `.loombridge/run/reports/`, `.loombridge/tests/` is meant
 * to be checked in: the stamped pair is evidence a reviewer can read without re-running a
 * multi-minute editor.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { projectBindingMatches, projectBindingPairError } from "../../shared/repo-identity.js";

import { LOOMBRIDGE_DIRNAME, TEST_RESULTS_DIRNAME, loombridgePaths } from "../../domain/state.js";
import type { TestsSummary } from "./nunit-parse.js";

/**
 * The `.loombridge/` subdirectory the stamped pair lives in. ONE constant, and it lives in
 * `domain/state.ts` because `LoombridgePaths` needs it too and the layering forbids domain
 * importing a capability. Re-exported here so a reader of this module still finds the whole
 * path vocabulary in one place, without a second spelling existing anywhere.
 */
export { TEST_RESULTS_DIRNAME };

/**
 * The portable-binding predicate lives in `shared/repo-identity.ts`: the feel snapshot
 * and the screen layout baseline gate on the SAME rule, and a second copy of a rule that
 * decides whether foreign evidence may grade this project is a second rule the day one
 * copy is edited. Re-exported so a reader of this module still finds the whole binding
 * vocabulary in one place, without a second implementation existing anywhere.
 */
export { projectBindingMatches };

/** The NUnit3 result document Unity's `-testResults` writes. */
export const TEST_RESULTS_FILE = "test-results.xml";

/** The binding manifest stamped beside it. */
export const TEST_RESULTS_MANIFEST = "test-results-manifest.json";

/** The Unity editor log for the run (`-logFile`), kept as the compile-error evidence. */
export const TEST_RUN_LOG_FILE = "test-run.log";

/**
 * `<root>/.loombridge/tests/`: the committed slot holding the stamped pair plus the log.
 *
 * DELEGATES to `loombridgePaths` rather than re-joining the segments, so the producer here
 * and the `LoombridgePaths.tests` slot the unified door reads are the SAME derivation, not
 * two that happen to agree today.
 */
export function testResultsDir(root: string): string {
  return loombridgePaths(root).tests;
}

export function testResultsPath(dir: string): string {
  return path.join(dir, TEST_RESULTS_FILE);
}

export function testResultsManifestPath(dir: string): string {
  return path.join(dir, TEST_RESULTS_MANIFEST);
}

export function testRunLogPath(dir: string): string {
  return path.join(dir, TEST_RUN_LOG_FILE);
}

/**
 * The project root a results DIRECTORY implies, or `null` when the directory is not the
 * declared slot (FXD).
 *
 * The INVERSE of `testResultsDir`, and derived by inverting it rather than by counting `..`
 * segments (CLAUDE.md: a `..` count silently encodes how deep a file sits). It exists so a
 * caller handed a bare path (`tests grade --results <xml>`) can ask "which project would this
 * pair belong to, if it belongs to one at all", and then hold the manifest's own
 * `projectRoot` against that answer. Without it, a stamped pair copied into any directory on
 * disk verifies happily against itself: every sha still matches, because a copy preserves
 * bytes, and the only thing that changed is the one fact nothing was checking.
 */
export function projectRootForTestResultsDir(dir: string): string | null {
  const resolved = path.resolve(dir);
  if (path.basename(resolved) !== TEST_RESULTS_DIRNAME) return null;
  const loombridgeDir = path.dirname(resolved);
  if (path.basename(loombridgeDir) !== LOOMBRIDGE_DIRNAME) return null;
  const root = path.dirname(loombridgeDir);
  // Re-derive forwards and compare, so the two directions can never drift apart.
  return testResultsDir(root) === resolved ? root : null;
}

export interface TestResultsManifest {
  kind: "test-results";
  schemaVersion: "1";
  /** Absolute project root the run was launched against; re-checked at grade time. */
  projectRoot: string;
  /**
   * PORTABLE binding (optional; stamped when the project sits in a git working tree):
   * the repository identity (origin URL, else a stated basename fallback) plus the
   * project's path relative to the git toplevel. This is what lets a COMMITTED stamped
   * trio grade on a CI runner whose checkout path differs from the machine that
   * produced it, while a trio copied from a DIFFERENT repository still refuses.
   * Absent on legacy manifests and on non-git projects: those bind by absolute path
   * only, and re-running `loombridge tests run` re-stamps portably.
   */
  repoIdentity?: string;
  projectPath?: string;
  /** `m_EditorVersion` from `ProjectSettings/ProjectVersion.txt` (what the project ASKS for). */
  projectDeclaredEditorVersion: string;
  /**
   * The version banner parsed out of the Unity log (what actually RAN), or `null` when the
   * log had no recognizable banner. G8: the two are separate fields because they can
   * differ, and a claim in the docs may only be as strong as the field that backs it.
   */
  logReportedEditorVersion: string | null;
  /** The resolved editor executable (G8): which install produced these bytes. */
  resolvedEditorPath: string;
  testPlatform: "EditMode";
  startedAt: string;
  finishedAt: string;
  /** Unity's process exit code (0 passed, 2 tests failed, 3 run failed). */
  exitCode: number;
  /** Count of `error CS<n>` lines in the run log. Non-zero means assemblies did not build. */
  compileErrors: number;
  /** Assembly-suite names present in the XML; the grader refuses on a mismatch (G4). */
  assemblies: string[];
  resultsSha256: string;
  /** sha of the run log, or `null` when no log was produced. Verified only if it exists. */
  logSha256: string | null;
  /** `STATE.currentBuild.runId` at run time, else `null` (G7). */
  runId: string | null;
  /** The full spawned argv (editor first), so the declared command line is walkable data. */
  command: string[];
  /** Re-derived from the test-case walk, so the grader recomputes it identically (G12). */
  summary: TestsSummary;
  /** True when `ProjectVersion.txt` changed across the run: the project was upgraded. */
  mutatedProject: boolean;
}

/**
 * A manifest that exists but cannot be trusted. Returned, never thrown, so a caller
 * enumerating assets can mark ONE row broken and carry on: discovery must not abort the
 * whole plan because one asset on disk is malformed.
 */
export interface TestResultsManifestError {
  error: string;
}

export function isTestResultsManifestError(
  value: TestResultsManifest | TestResultsManifestError | null,
): value is TestResultsManifestError {
  return value !== null && "error" in value;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write (or overwrite) the manifest for a results dir. `tests run` is the only writer. */
export async function writeTestResultsManifest(dir: string, manifest: TestResultsManifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(testResultsManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Read + shape-check the manifest in `dir`.
 *
 * Three outcomes, deliberately distinct: `null` when there is no manifest at all
 * (UNSTAMPED results, which are a non-anchor row and not a defect), a typed error marker
 * when one is present but unreadable/malformed (BROKEN: evidence that cannot be read is a
 * refusal, never a skip), and the manifest itself when it is well-shaped. Never throws.
 *
 * Every bound field is REQUIRED here. A missing field must not fall through to a check
 * that then does not run: CLAUDE.md's anti-pattern is precisely `if (x.field && ...)`,
 * where a falsy field skips the binding it was supposed to enforce.
 */
export async function loadTestResultsManifest(
  dir: string,
): Promise<TestResultsManifest | TestResultsManifestError | null> {
  let raw: string;
  try {
    raw = await fs.readFile(testResultsManifestPath(dir), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { error: `unreadable ${TEST_RESULTS_MANIFEST}: ${message(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${TEST_RESULTS_MANIFEST} is not valid JSON: ${message(error)}` };
  }
  if (!isRecord(parsed)) return { error: `${TEST_RESULTS_MANIFEST} is not a JSON object` };
  if (parsed.kind !== "test-results") {
    return { error: `${TEST_RESULTS_MANIFEST} kind is '${String(parsed.kind)}', expected 'test-results'` };
  }
  if (parsed.schemaVersion !== "1") {
    return { error: `${TEST_RESULTS_MANIFEST} schemaVersion is '${String(parsed.schemaVersion)}', expected '1'` };
  }
  for (const field of [
    "projectRoot",
    "projectDeclaredEditorVersion",
    "resolvedEditorPath",
    "startedAt",
    "finishedAt",
    "resultsSha256",
  ] as const) {
    if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
      return { error: `${TEST_RESULTS_MANIFEST} is missing a usable '${field}'` };
    }
  }
  if (parsed.testPlatform !== "EditMode") {
    return { error: `${TEST_RESULTS_MANIFEST} testPlatform is '${String(parsed.testPlatform)}', expected 'EditMode'` };
  }
  for (const field of ["exitCode", "compileErrors"] as const) {
    if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field] as number)) {
      return { error: `${TEST_RESULTS_MANIFEST} is missing a numeric '${field}'` };
    }
  }
  if (typeof parsed.mutatedProject !== "boolean") {
    return { error: `${TEST_RESULTS_MANIFEST} is missing a boolean 'mutatedProject'` };
  }
  if (!isStringArray(parsed.assemblies)) {
    return { error: `${TEST_RESULTS_MANIFEST} 'assemblies' is not an array of strings` };
  }
  if (!isStringArray(parsed.command) || parsed.command.length === 0) {
    return { error: `${TEST_RESULTS_MANIFEST} 'command' is not a non-empty array of strings` };
  }
  // The portable binding pair: optional (legacy and non-git manifests), refused when it
  // is half-stamped. One shared rule, so the three stamped artifacts cannot diverge.
  const pairError = projectBindingPairError(parsed);
  if (pairError !== null) return { error: `${TEST_RESULTS_MANIFEST} ${pairError}` };
  if (parsed.logSha256 !== null && typeof parsed.logSha256 !== "string") {
    return { error: `${TEST_RESULTS_MANIFEST} 'logSha256' must be a string or null` };
  }
  if (parsed.runId !== null && typeof parsed.runId !== "string") {
    return { error: `${TEST_RESULTS_MANIFEST} 'runId' must be a string or null` };
  }
  if (parsed.logReportedEditorVersion !== null && typeof parsed.logReportedEditorVersion !== "string") {
    return { error: `${TEST_RESULTS_MANIFEST} 'logReportedEditorVersion' must be a string or null` };
  }
  if (!isRecord(parsed.summary)) return { error: `${TEST_RESULTS_MANIFEST} 'summary' is not an object` };
  for (const field of ["total", "passed", "failed", "inconclusive", "skipped"] as const) {
    if (typeof parsed.summary[field] !== "number" || !Number.isFinite(parsed.summary[field] as number)) {
      return { error: `${TEST_RESULTS_MANIFEST} summary is missing a numeric '${field}'` };
    }
  }
  return parsed as unknown as TestResultsManifest;
}

export interface TestResultsIntegrityResult {
  ok: boolean;
  /** Named refusals; empty iff ok. */
  failures: string[];
  manifest?: TestResultsManifest;
  /** True when there is no manifest at all: UNSTAMPED, not broken. */
  unstamped: boolean;
  /** The XML bytes, present only when they were read successfully. */
  resultsBytes?: Buffer;
}

/**
 * Verify a stored test-results pair end to end, recomputing every sha from disk.
 *
 *  - the XML the manifest binds must EXIST. A manifest without its results is BROKEN, not
 *    unstamped (G9): deleting the evidence must not silence the gate, and it must not
 *    look like "no results were ever produced" either.
 *  - the XML bytes must still hash to `resultsSha256`, so a hand-edited results file is a
 *    refusal rather than a silently re-graded run.
 *  - with `root`, `projectRoot` must resolve to the same directory, so a manifest copied
 *    from another checkout cannot vouch for this one.
 *  - the log is verified ONLY when it still exists. It is large and disposable; its
 *    absence is not tampering, but its presence with the wrong bytes is.
 */
export async function verifyTestResults(
  dir: string,
  opts: { root?: string } = {},
): Promise<TestResultsIntegrityResult> {
  const loaded = await loadTestResultsManifest(dir);
  if (loaded === null) return { ok: false, failures: [], unstamped: true };
  if (isTestResultsManifestError(loaded)) return { ok: false, failures: [loaded.error], unstamped: false };

  const failures: string[] = [];
  let resultsBytes: Buffer | undefined;
  try {
    resultsBytes = await fs.readFile(testResultsPath(dir));
  } catch {
    failures.push(
      `${TEST_RESULTS_MANIFEST} is present but ${TEST_RESULTS_FILE} is missing from ${dir}; ` +
        "re-run `loombridge tests run`",
    );
  }
  if (resultsBytes !== undefined && sha256(resultsBytes) !== loaded.resultsSha256) {
    failures.push(`${TEST_RESULTS_FILE} sha256 mismatch: the results were edited after the run that stamped them`);
  }

  if (opts.root !== undefined && !projectBindingMatches(loaded, opts.root)) {
    const portable =
      loaded.repoIdentity !== undefined
        ? ` (stamped repo ${loaded.repoIdentity} at ${loaded.projectPath ?? "."})`
        : " (no portable stamp: a manifest from before portable binding, or a non-git project; re-run `loombridge tests run` to re-stamp)";
    failures.push(
      `${TEST_RESULTS_MANIFEST} projectRoot is ${loaded.projectRoot}, but these results were graded against ` +
        `${path.resolve(opts.root)}${portable}`,
    );
  }

  const logPath = testRunLogPath(dir);
  let logBytes: Buffer | undefined;
  try {
    logBytes = await fs.readFile(logPath);
  } catch {
    // Absent log: not a failure. Documented above.
  }
  if (logBytes !== undefined) {
    if (loaded.logSha256 === null) {
      failures.push(`${TEST_RUN_LOG_FILE} exists but the manifest stamped no logSha256`);
    } else if (sha256(logBytes) !== loaded.logSha256) {
      failures.push(`${TEST_RUN_LOG_FILE} sha256 mismatch: the run log was edited after the run that stamped it`);
    }
  }

  return { ok: failures.length === 0, failures, manifest: loaded, unstamped: false, resultsBytes };
}
