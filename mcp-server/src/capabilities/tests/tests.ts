/**
 * `loombridge tests <run|grade>`: the Unity Test Runner gate's PRODUCER (plan T1, T4, T7).
 *
 * `tests run` is the only thing in Loombridge that launches a Unity editor to get test
 * results. It resolves the editor a project declares, spawns it headless
 * (`-batchmode -runTests -testPlatform EditMode`), keeps the NUnit3 XML, and STAMPS a
 * binding manifest beside it. The unified verify door is the CONSUMER: it grades those
 * stored bytes offline. Bare `verify` therefore never launches a multi-minute editor,
 * never takes the license seat, and never fights a domain reload.
 *
 * `tests grade` is DIAGNOSTIC (G2). It exists so CI can read an XML that GameCI produced,
 * and so a human can ask "what does this file say". It prints "DIAGNOSTIC: not a
 * verification verdict" on EVERY path, and it exits 0 only for a stamped, verifying pair
 * or under GITHUB_ACTIONS, where the trust root is the runner rather than the operator's
 * shell. A local green on an unstamped file exits 2 and says how to produce quotable
 * results, because "I ran the tests and they passed" is exactly the self-graded claim
 * this repo refuses.
 *
 * THE SPAWNER IS A SEAM. Every unit test drives `runTests` through an injected spawner and
 * never touches a real Unity install, a real project, or `~/.loombridge`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loombridgePaths, nowIso, readState } from "../../domain/state.js";
import { deriveRepoIdentity } from "../../shared/repo-identity.js";
import {
  defaultEditorLocatorSeams,
  isEditorLocatorError,
  projectVersionPath,
  readProjectEditorVersion,
  resolveUnityEditor,
  type EditorLocatorSeams,
} from "./editor-locator.js";
import {
  deriveSummary,
  gradeTestResults,
  isNUnitParseError,
  parseNUnitResults,
  type TestsGrade,
} from "./nunit-parse.js";
import {
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  projectBindingMatches,
  projectRootForTestResultsDir,
  sha256,
  testResultsDir,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
  verifyTestResults,
  writeTestResultsManifest,
  type TestResultsManifest,
} from "./test-results-manifest.js";

const TAG = "[loombridge tests]";

/** Printed on every `tests grade` path (G2): this verb is never a verdict. */
export const GRADE_DIAGNOSTIC_BANNER = "DIAGNOSTIC: not a verification verdict";

/** Printed when a local `tests grade` would otherwise pass on an unstamped file (G2). */
export const UNSTAMPED_REFUSAL =
  "unstamped input; run `loombridge tests run` to produce quotable results";

/**
 * Printed when a stamped pair verifies against itself but is not where its manifest says the
 * project is (FXD). A copy preserves every sha, so location is the only thing left to check.
 */
export const MISPLACED_REFUSAL = "results are not at the project they claim";

/**
 * Printed when a manifest is PRESENT in the declared slot and FAILS its own integrity (H1).
 *
 * Ordered with `MISPLACED_REFUSAL`, and for the same reason the comment on that check already
 * gives: a stamped pair that does not verify is a POSITIVE SIGNAL OF TAMPERING, not merely an
 * absence of provenance. A sha mismatch is the same class of signal as a moved pair and was
 * not ordered there, so the failure degraded to "unstamped" and the CI attestation exited 0
 * over it. The audit demonstrated the whole shape at once: a manifest declaring `exitCode: 3`,
 * `compileErrors: 42`, `mutatedProject: true`, a forged summary and a forged assembly list,
 * beside a green XML, with `resultsSha256` pointing at bytes that are not there. All five
 * producer refusals were on disk, none reached the grader, and the verb exited 0.
 *
 * CI IS UNAFFECTED: the workflow grades BARE GameCI XMLs, which have no manifest at all and
 * therefore take the unstamped path exactly as before. This refusal needs a manifest to exist
 * in the declared slot and to fail against its own bytes.
 */
export const TAMPERED_REFUSAL = "a stamped pair that does not verify";

/**
 * The EXACT value GitHub sets for `GITHUB_ACTIONS` (FXF).
 *
 * Compared with `===`, never for truthiness. `GITHUB_ACTIONS=0`, `=false`, or `=yes` are not
 * things GitHub writes; they are things a local shell writes, and a truthy test would hand
 * the runner's trust root to anyone who can export a variable.
 */
export const GITHUB_ACTIONS_VALUE = "true";

/* -------------------------------------------------------------------------- */
/* The spawner seam                                                           */
/* -------------------------------------------------------------------------- */

export interface TestsSpawnRequest {
  editorPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Where Unity was told to write its log (`-logFile`); informational for the spawner. */
  logPath: string;
}

export interface TestsSpawnResult {
  /** The process ran to completion (it may still have exited non-zero). */
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  error?: string;
}

export type TestsSpawner = (request: TestsSpawnRequest) => Promise<TestsSpawnResult>;

/**
 * The child's stdio. NEVER "inherit" (shared/child-stdio.ts): under `node --test` fd 1 is
 * a V8-serialized result channel, and a grandchild writing raw bytes into it kills the
 * runner with a deserialization error that surfaces as a whole FILE failing with no
 * assertion. Unity writes everything to `-logFile` anyway, so all three streams are
 * ignored unconditionally, which satisfies the rule inside and outside the test runner.
 */
export function defaultSpawnStdio(): ["ignore", "ignore", "ignore"] {
  return ["ignore", "ignore", "ignore"];
}

/** The real spawner. Only `runTests` without an injected seam ever reaches it. */
export const spawnUnityTests: TestsSpawner = async (request) => {
  const { spawn } = await import("node:child_process");
  return new Promise<TestsSpawnResult>((resolve) => {
    let child;
    try {
      child = spawn(request.editorPath, request.args, { cwd: request.cwd, stdio: defaultSpawnStdio() });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, signal: null, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut, exitCode: code, signal, timedOut });
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Log reading                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compile-error lines in the Unity log.
 *
 * A count of LINES, not of distinct errors: Unity repeats each diagnostic in its compile
 * output and again in a summary. The number is a signal ("assemblies did not build"), and
 * the grader only ever asks whether it is greater than zero. Anchored on `error CS<digit>`
 * so prose mentioning "error CS" cannot inflate it.
 */
export function countCompileErrors(log: string): number {
  let count = 0;
  for (const line of log.split(/\r?\n/)) {
    if (/\berror CS\d/.test(line)) count += 1;
  }
  return count;
}

/**
 * The editor version banner Unity writes near the top of its log (G8): what actually RAN,
 * as opposed to what the project declares. Three shapes across the supported editor range;
 * `null` when none matches, which is recorded as `null` rather than guessed.
 */
export function parseLogEditorVersion(log: string): string | null {
  const patterns = [/^Unity Editor version:\s*(\S+)/m, /^Unity version\s*:\s*(\S+)/m, /\bVersion is '([^'\s]+)/];
  for (const pattern of patterns) {
    const match = pattern.exec(log);
    if (match) return match[1];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* CLI parsing                                                                */
/* -------------------------------------------------------------------------- */

interface RunArgs {
  sub: "run";
  root: string;
  unity?: string;
  platform: string;
  timeoutMin: number;
  graphics: boolean;
  strict: boolean;
}

interface GradeArgs {
  sub: "grade";
  results: string;
  strict: boolean;
}

type ParsedArgs = RunArgs | GradeArgs | { help: true; usageError?: boolean };

function usage(): void {
  console.log(
    [
      "Usage: loombridge tests <run|grade> [options]",
      "",
      "Run this project's Unity EditMode tests headless and STAMP the results, so a",
      "verdict can cite them without anyone re-running an editor. `verify` grades the",
      "stored pair offline; it never launches Unity itself.",
      "",
      "Subcommands:",
      "  run     Resolve the editor the project declares, run EditMode tests in batchmode,",
      "          and write .loombridge/tests/ (results + binding manifest + log).",
      "  grade   DIAGNOSTIC: read an operator-named NUnit3 XML and print the mapping.",
      "          Never a verification verdict.",
      "",
      "Options (run):",
      "  --root <dir>        Unity project root (default: cwd)",
      "  --unity <path>      Editor executable or Unity.app to use (overrides UNITY_EDITOR)",
      "  --platform <name>   EditMode only in this wave; PlayMode is refused",
      "  --timeout-min <n>   Kill the editor after n minutes (default: 30)",
      "  --graphics          Opt OUT of the default -nographics (deterministic headless)",
      "  --strict            Warning results count as failures",
      "",
      "Options (grade):",
      "  --results <xml>     The NUnit3 result file to read (required)",
      "  --strict            Warning results count as failures",
      "",
      "Exit 0: every test case executed and passed.",
      "Exit 1: a real assertion failure, or a Warning case under --strict.",
      "Exit 2: a result that cannot be read as a verdict. Refusal before spawning",
      "  (PlayMode, no ProjectVersion.txt, no Assets/, Temp/UnityLockfile, unresolvable",
      "  editor, a value-less or non-numeric flag); a spawn, timeout or license fault;",
      "  unreadable or missing results; a run that checked nothing (zero cases, or every",
      "  case skipped); compile errors in the log; a MUTATED project; a cancelled run; a",
      "  skipped or ignored SUITE that EXECUTED NOTHING (a fixture that ran cases but",
      "  carries a propagated Ignored label from skipped children is not an opt-out);",
      "  an inconclusive case; a case",
      "  result outside NUnit's vocabulary (Passed, Failed, Warning, Inconclusive,",
      "  Skipped); bucket accounting that disagrees with the walked total; a Unity exit",
      "  code the test-case walk cannot account for; a roll-up that disagrees with the",
      "  cases beneath it, on <test-run> or on any <test-suite> that declares counts",
      "  (only DECLARED counts are compared, so a writer that omits total is fine).",
      "",
      "`grade` additionally exits 2 on a GREEN it cannot attribute to anyone but the",
      "caller: unstamped input, a stamped pair that is not at the project its manifest",
      "claims, or a stamped pair that does not verify against its own bytes.",
      `The one exception is the environment variable GITHUB_ACTIONS="${GITHUB_ACTIONS_VALUE}"`,
      "(that exact value, nothing else), where the runner chose and produced the file.",
      "That exception attests an UNSTAMPED file only: it never launders a manifest that",
      "is present and failing.",
    ].join("\n"),
  );
}

export function parseTestsArgs(args: string[]): ParsedArgs {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") return { help: true };
  if (sub !== "run" && sub !== "grade") {
    console.error(`${TAG} unknown subcommand "${sub}". Known: run, grade.`);
    return { help: true, usageError: true };
  }

  let root = process.cwd();
  let unity: string | undefined;
  let platform = "EditMode";
  let timeoutMinRaw = "30";
  let graphics = false;
  let strict = false;
  let results: string | undefined;

  // FXM: a value flag with no value is a USAGE ERROR, never a silent default. `--root` with
  // nothing after it used to keep cwd, and `--unity`/`--results` used to take "", so a
  // mistyped command ran against a different project (or an empty path) while looking like it
  // had been told exactly what to do. `--timeout-min` already refused; the rest now match it.
  const valueFor = (flag: string, index: number): string | null => {
    const value = args[index];
    if (value === undefined) {
      console.error(`${TAG} ${flag} requires a value.`);
      return null;
    }
    return value;
  };
  let usageError = false;

  for (let i = 1; i < args.length && !usageError; i += 1) {
    const arg = args[i];
    if (arg === "--root" || arg === "--unity" || arg === "--platform" || arg === "--timeout-min" || arg === "--results") {
      const value = valueFor(arg, (i += 1));
      if (value === null) {
        usageError = true;
        break;
      }
      if (arg === "--root") root = path.resolve(value);
      else if (arg === "--unity") unity = value;
      else if (arg === "--platform") platform = value;
      else if (arg === "--timeout-min") timeoutMinRaw = value;
      else results = path.resolve(value);
    } else if (arg === "--graphics") graphics = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`${TAG} unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  if (usageError) return { help: true, usageError: true };

  if (sub === "grade") {
    if (results === undefined) {
      console.error(`${TAG} grade requires --results <xml>.`);
      return { help: true, usageError: true };
    }
    return { sub: "grade", results, strict };
  }

  const timeoutMin = Number.parseInt(timeoutMinRaw, 10);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || String(timeoutMin) !== timeoutMinRaw.trim()) {
    console.error(`${TAG} --timeout-min must be a positive whole number of minutes (got "${timeoutMinRaw}").`);
    return { help: true, usageError: true };
  }
  return { sub: "run", root, unity, platform, timeoutMin, graphics, strict };
}

/* -------------------------------------------------------------------------- */
/* `tests run`                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The pinned argv (G4).
 *
 * Every flag here is load-bearing and a guard test asserts this exact list:
 *  - `-batchmode` no editor window, no interactive prompts;
 *  - `-nographics` by default, because deterministic headless is the whole point; the
 *    EditMode suite is written to be nographics-safe and `--graphics` opts out;
 *  - `-projectPath` the root, so cwd cannot silently redirect the run;
 *  - `-runTests -testPlatform EditMode` the run itself;
 *  - `-testResults` / `-logFile` the two artifacts the manifest binds.
 *
 * There is deliberately NO `-quit`. Unity's `-runTests` quits on its own once the run is
 * finished; adding `-quit` alongside it races the test runner and can terminate the editor
 * before results are written, which produces an empty or truncated XML. An empty XML is
 * "checked nothing", so the flag that looks like tidy housekeeping is in fact a path to a
 * verdict built on no evidence.
 */
export function buildUnityTestArgs(opts: {
  root: string;
  resultsPath: string;
  logPath: string;
  graphics: boolean;
}): string[] {
  return [
    "-batchmode",
    ...(opts.graphics ? [] : ["-nographics"]),
    "-projectPath",
    opts.root,
    "-runTests",
    "-testPlatform",
    "EditMode",
    "-testResults",
    opts.resultsPath,
    "-logFile",
    opts.logPath,
  ];
}

export interface TestsRunOpts {
  spawner?: TestsSpawner;
  locatorSeams?: EditorLocatorSeams;
}

/**
 * The spawner a run will actually use (FXJ).
 *
 * Extracted from `runTests` so a test can assert BY REFERENCE that the PRODUCTION default is
 * the real `spawnUnityTests` and not some convenient stub. Every unit test injects a seam, so
 * without this the one code path that ships (`opts.spawner` absent) is the only one nothing
 * ever looks at: a stubbed default would leave the whole suite green while `tests run` never
 * launched an editor again.
 */
export function resolveTestsSpawner(opts: TestsRunOpts): TestsSpawner {
  return opts.spawner ?? spawnUnityTests;
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}

function printGrade(grade: TestsGrade): void {
  const s = grade.summary;
  console.log(
    `${TAG} ${s.total} test(s): ${s.passed} passed, ${s.failed} failed, ` +
      `${s.inconclusive} inconclusive, ${s.skipped} skipped`,
  );
  // H3: where the producer facts came from, on EVERY path. An unattributed walk printed the
  // same five numbers as a stamped one, so the one fact distinguishing them was invisible.
  console.log(`${TAG}   attribution: ${grade.attribution}`);
  for (const reason of grade.reasons) console.log(`${TAG}   refusal: ${reason}`);
  for (const note of grade.notes) console.log(`${TAG}   note: ${note}`);
  for (const failure of grade.failures.slice(0, 10)) {
    const excerpt = failure.message ? `: ${failure.message.split(/\r?\n/)[0].slice(0, 200)}` : "";
    console.log(`${TAG}   FAIL ${failure.fullname}${failure.label ? ` [${failure.label}]` : ""}${excerpt}`);
  }
  if (grade.failures.length > 10) console.log(`${TAG}   ... ${grade.failures.length - 10} more failure(s)`);
  console.log(`${TAG} tier ${grade.tier}`);
}

export async function runTests(cli: RunArgs, opts: TestsRunOpts = {}): Promise<number> {
  const seams = opts.locatorSeams ?? defaultEditorLocatorSeams();
  const spawner = resolveTestsSpawner(opts);
  const root = path.resolve(cli.root);

  // --- pre-spawn refusals. Every one of these creates NOTHING (T4/R13). ---
  if (cli.platform !== "EditMode") {
    console.error(
      `${TAG} --platform ${cli.platform} is not supported yet; this wave runs EditMode only. ` +
        "PlayMode needs a domain-reload-safe harness and is recorded as out of scope.",
    );
    return 2;
  }
  const version = readProjectEditorVersion(root, seams);
  if (isEditorLocatorError(version)) {
    console.error(`${TAG} ${version.error}`);
    return 2;
  }
  if (!(await isDirectory(path.join(root, "Assets")))) {
    console.error(`${TAG} ${root} has no Assets/ directory; refusing to run tests against a non-project.`);
    return 2;
  }
  const lockfile = path.join(root, "Temp", "UnityLockfile");
  if (await pathExists(lockfile)) {
    console.error(
      `${TAG} ${lockfile} exists: an editor already has this project open. Close it and re-run, ` +
        "or the batchmode run will block on the project lock until the timeout expires.",
    );
    return 2;
  }
  const editor = resolveUnityEditor({ version: version.version, override: cli.unity }, seams);
  if (isEditorLocatorError(editor)) {
    console.error(`${TAG} ${editor.error}`);
    return 2;
  }

  const dir = testResultsDir(root);
  const resultsPath = testResultsPath(dir);
  const logPath = testRunLogPath(dir);
  await fs.mkdir(dir, { recursive: true });

  // Clear the previous run's evidence BEFORE spawning (FXB, stated precisely).
  //
  // The rule is about a run that SPAWNS: once an editor has been launched against this
  // project, the previous pair is no longer the newest thing anyone tried, so a run that then
  // fails must leave "no stamped results" rather than last week's pair sitting where a grader
  // will read it as fresh. Everything above this line is a PRE-SPAWN refusal and deletes
  // nothing at all: a plan-first refusal changes the project in no way, and the previous pair
  // remains exactly as trustworthy as its own `finishedAt` says it is. The two behaviours are
  // deliberate and different, and a test pins each.
  await fs.rm(resultsPath, { force: true });
  await fs.rm(testResultsManifestPath(dir), { force: true });
  await fs.rm(logPath, { force: true });

  // Mutation guard (T4/R12): the sha of the file that declares the project's editor.
  const versionFile = projectVersionPath(root);
  const versionShaBefore = sha256((await readFileOrNull(versionFile)) ?? Buffer.alloc(0));

  const args = buildUnityTestArgs({ root, resultsPath, logPath, graphics: cli.graphics });
  const command = [editor.path, ...args];
  console.log(`${TAG} editor ${editor.path} (${version.version}, resolved from ${editor.source})`);
  console.log(`${TAG} running EditMode tests in ${root} (timeout ${cli.timeoutMin} min)`);

  const startedAt = nowIso();
  const spawned = await spawner({
    editorPath: editor.path,
    args,
    cwd: root,
    timeoutMs: cli.timeoutMin * 60_000,
    logPath,
  });
  const finishedAt = nowIso();

  const logBytes = await readFileOrNull(logPath);
  const logText = logBytes === null ? "" : logBytes.toString("utf-8");

  // --- harness faults: NO manifest, partial XML deleted, exit 2 (G9). ---
  if (!spawned.ok || spawned.timedOut) {
    const partial = await pathExists(resultsPath);
    if (partial) {
      await fs.rm(resultsPath, { force: true });
      console.error(`${TAG} deleted the partial ${TEST_RESULTS_FILE} left by the interrupted run.`);
    }
    if (spawned.timedOut) {
      console.error(`${TAG} Unity did not finish within ${cli.timeoutMin} min; the editor was killed.`);
    } else {
      console.error(`${TAG} could not run Unity: ${spawned.error ?? "the process failed to start"}`);
    }
    if (/license|Batchmode quit|LICENSE SYSTEM/i.test(logText)) {
      console.error(`${TAG} the log mentions licensing; a batchmode run needs an activated seat.`);
    }
    console.error(`${TAG} no manifest was written; there are no stamped results. Log: ${logPath}`);
    return 2;
  }

  const resultsBytes = await readFileOrNull(resultsPath);
  if (resultsBytes === null) {
    console.error(
      `${TAG} Unity exited ${spawned.exitCode} but wrote no ${TEST_RESULTS_FILE}; nothing to bind. Log: ${logPath}`,
    );
    if (/license|LICENSE SYSTEM/i.test(logText)) {
      console.error(`${TAG} the log mentions licensing; a batchmode run needs an activated seat.`);
    }
    return 2;
  }

  const parsed = parseNUnitResults(resultsBytes.toString("utf-8"));
  if (isNUnitParseError(parsed)) {
    console.error(`${TAG} ${TEST_RESULTS_FILE} is unreadable: ${parsed.error}`);
    console.error(`${TAG} no manifest was written; unreadable results cannot be bound. Log: ${logPath}`);
    return 2;
  }

  const versionShaAfter = sha256((await readFileOrNull(versionFile)) ?? Buffer.alloc(0));
  const mutatedProject = versionShaBefore !== versionShaAfter;
  if (mutatedProject) {
    console.error(
      `${TAG} WARNING: this run CHANGED ${versionFile}. The editor upgraded the project. ` +
        "The results are stamped mutatedProject: true and will not certify.",
    );
  }

  const compileErrors = countCompileErrors(logText);
  let runId: string | null = null;
  try {
    const state = await readState(loombridgePaths(root));
    runId = state?.currentBuild?.runId ?? null;
  } catch {
    runId = null;
  }

  const grade = gradeTestResults({
    run: parsed,
    strict: cli.strict,
    // H3: this process spawned the editor, so the three facts come from the run itself. It
    // does not claim `stamped`: the summary and assembly cross-checks would be this function
    // comparing `deriveSummary(parsed)` against itself, which is a check that cannot fail.
    attribution: {
      kind: "producer",
      exitCode: spawned.exitCode ?? -1,
      compileErrors,
      mutatedProject,
    },
  });

  const manifest: TestResultsManifest = {
    kind: "test-results",
    schemaVersion: "1",
    projectRoot: root,
    // Portable binding when derivable (git working tree): lets the committed trio grade
    // on any checkout of the same repo, while a different repo's trio still refuses.
    ...(deriveRepoIdentity(root) ?? {}),
    projectDeclaredEditorVersion: version.version,
    logReportedEditorVersion: parseLogEditorVersion(logText),
    resolvedEditorPath: editor.path,
    testPlatform: "EditMode",
    startedAt,
    finishedAt,
    exitCode: spawned.exitCode ?? -1,
    compileErrors,
    assemblies: parsed.assemblies,
    resultsSha256: sha256(resultsBytes),
    logSha256: logBytes === null ? null : sha256(logBytes),
    runId,
    command,
    summary: deriveSummary(parsed),
    mutatedProject,
  };
  await writeTestResultsManifest(dir, manifest);

  console.log(`${TAG} stamped ${testResultsManifestPath(dir)}`);
  printGrade(grade);
  if (grade.tier === 0) console.log(`${TAG} results are stamped; \`loombridge verify\` grades them offline.`);
  return grade.tier;
}

/* -------------------------------------------------------------------------- */
/* `tests grade`                                                              */
/* -------------------------------------------------------------------------- */

export interface TestsGradeOpts {
  /** Injectable environment so the GITHUB_ACTIONS attestation path is testable. */
  env?: NodeJS.ProcessEnv;
}

export async function gradeStoredResults(cli: GradeArgs, opts: TestsGradeOpts = {}): Promise<number> {
  const env = opts.env ?? process.env;
  // G2: printed FIRST and on every path, including the failure paths, so no output of this
  // verb can be quoted as a verdict by cropping the tail.
  console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);

  const bytes = await readFileOrNull(cli.results);
  if (bytes === null) {
    console.error(`${TAG} no results file at ${cli.results}.`);
    return 2;
  }
  const parsed = parseNUnitResults(bytes.toString("utf-8"));
  if (isNUnitParseError(parsed)) {
    console.error(`${TAG} ${cli.results} is unreadable: ${parsed.error}`);
    return 2;
  }

  // Is this file the stamped half of a verifying pair? Only then can a green be quoted.
  //
  // FXD: "verifying" now includes WHERE the pair sits. Every sha in the manifest survives a
  // copy unchanged, so integrity alone says only "these bytes are the bytes that were
  // stamped", never "and they belong to this project". The pair must therefore live at the
  // declared slot of the very root its own manifest names; anything else is a stamped pair
  // that has been moved, and the quotable wording is refused for it. `projectRootForTestResultsDir`
  // inverts `testResultsDir`, so the two directions cannot drift.
  const dir = path.dirname(cli.results);
  const stampedResults = testResultsPath(dir);
  let stamped = false;
  let stampedNote = `no ${TEST_RESULTS_MANIFEST} beside ${cli.results}`;
  let misplaced: string | null = null;
  let tampered: string | null = null;
  let integrityManifest: TestResultsManifest | undefined;
  if (path.resolve(stampedResults) === path.resolve(cli.results)) {
    const impliedRoot = projectRootForTestResultsDir(dir);
    const integrity = await verifyTestResults(dir);
    const claimedRoot = integrity.manifest?.projectRoot;
    if (integrity.unstamped) {
      stampedNote = `no ${TEST_RESULTS_MANIFEST} in ${dir}`;
    } else if (!integrity.ok) {
      // H1. A manifest that is PRESENT and does not verify is evidence of tampering, and it
      // is refused HERE rather than degraded to the unstamped path, where the CI attestation
      // would have exited 0 over it. See TAMPERED_REFUSAL for the demonstrated attack.
      tampered = `${TAMPERED_REFUSAL}: ${integrity.failures.join("; ")}`;
      stampedNote = `manifest present but not verifying: ${integrity.failures.join("; ")}`;
    } else if (impliedRoot === null) {
      misplaced =
        `${MISPLACED_REFUSAL}: the manifest claims projectRoot ${claimedRoot}, but this pair does not sit ` +
        `in that project's declared results directory (${testResultsDir(String(claimedRoot))})`;
      stampedNote = misplaced;
    } else if (!projectBindingMatches(integrity.manifest!, impliedRoot)) {
      // The PORTABLE rule (same repo, same position, any checkout path) or the absolute
      // rule may satisfy this; a pair from a genuinely different project satisfies
      // neither. This is what lets a committed trio grade quotably on a CI runner.
      misplaced =
        `${MISPLACED_REFUSAL}: the manifest claims projectRoot ${claimedRoot}` +
        (integrity.manifest?.repoIdentity !== undefined
          ? ` (repo ${integrity.manifest.repoIdentity} at ${integrity.manifest.projectPath ?? "."})`
          : "") +
        `, but this pair sits under ${impliedRoot}`;
      stampedNote = misplaced;
    } else {
      stamped = true;
      integrityManifest = integrity.manifest;
      stampedNote = `stamped by ${integrity.manifest?.resolvedEditorPath ?? "an unknown editor"} at ${
        integrity.manifest?.finishedAt ?? "an unknown time"
      }`;
    }
  }

  // H3: which of the three inputs this is, stated once. A manifest reaches the grader ONLY
  // through the `stamped` shape, which owes all five producer facts; anything else is the
  // named `unattributed` opt-in carrying the reason. There is no longer a shape of this call
  // in which a manifest exists and its facts silently arrive as `undefined`.
  const grade = gradeTestResults({
    run: parsed,
    strict: cli.strict,
    attribution:
      integrityManifest !== undefined
        ? {
            kind: "stamped",
            exitCode: integrityManifest.exitCode,
            compileErrors: integrityManifest.compileErrors,
            mutatedProject: integrityManifest.mutatedProject,
            manifestSummary: integrityManifest.summary,
            manifestAssemblies: integrityManifest.assemblies,
          }
        : { kind: "unattributed", why: stampedNote },
  });

  console.log(`${TAG} ${cli.results}`);
  console.log(`${TAG} ${stampedNote}`);
  printGrade(grade);

  if (grade.tier !== 0) {
    console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
    return grade.tier;
  }

  if (stamped) {
    console.log(`${TAG} stamped and verifying: this green is quotable.`);
    console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
    return 0;
  }
  if (tampered !== null) {
    // H1, ordered with `misplaced` and BEFORE the CI attestation, for the same reason: a
    // stamped pair that fails its own integrity is a positive signal of tampering rather than
    // an absence of provenance. Degrading it to "unstamped" is what let a manifest carrying
    // five refusals exit 0 under GITHUB_ACTIONS with none of them evaluated.
    console.error(`${TAG} ${tampered}`);
    console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
    return 2;
  }
  if (misplaced !== null) {
    // Checked BEFORE the CI attestation on purpose. A stamped pair that has been moved is a
    // positive signal of tampering, not merely an absence of provenance, and CI grades bare
    // GameCI XMLs (the unstamped path), so nothing this workflow actually does is affected.
    console.error(`${TAG} ${misplaced}`);
    console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
    return 2;
  }
  if (env.GITHUB_ACTIONS === GITHUB_ACTIONS_VALUE) {
    // CI attestation: the trust root here is the runner, which chose the file, ran the
    // editor, and cannot be talked into re-labelling a local artifact. That is the ONLY
    // reason an unstamped green exits 0, and it is recorded in the plan (G2).
    //
    // FXF: the claim is what it is, and no more. Nothing here VERIFIES that this process is
    // on a GitHub runner; an environment variable is a statement the environment makes, and
    // the wording says so rather than implying provenance was checked.
    console.log(
      `${TAG} GITHUB_ACTIONS=${GITHUB_ACTIONS_VALUE}: treating the file as runner-produced ` +
        "(env-claimed attestation, not verified provenance)",
    );
    console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
    return 0;
  }
  console.error(`${TAG} ${UNSTAMPED_REFUSAL}`);
  console.log(`${TAG} ${GRADE_DIAGNOSTIC_BANNER}`);
  return 2;
}

export async function run(args: string[], opts: TestsRunOpts & TestsGradeOpts = {}): Promise<number> {
  const parsed = parseTestsArgs(args);
  if ("help" in parsed) {
    usage();
    return parsed.usageError ? 2 : 0;
  }
  if (parsed.sub === "grade") return gradeStoredResults(parsed, opts);
  return runTests(parsed, opts);
}
