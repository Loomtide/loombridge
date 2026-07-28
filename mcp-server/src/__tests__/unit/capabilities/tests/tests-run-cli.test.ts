/**
 * `loombridge tests run` (plan T4, amendments G4/G7/G8/G9/G14).
 *
 * The producer is the only thing in Loombridge that launches a Unity editor, so the
 * spawner is an INJECTED SEAM and nothing here starts a real process, touches a real Unity
 * install, or writes to `~/.loombridge`. Every test plants a throwaway project in a temp
 * dir and hands `runTests` a spawner that writes whatever artifacts the scenario needs.
 *
 * Three properties carry the gate:
 *
 *  - THE REFUSALS HAPPEN BEFORE THE SPAWN and create nothing. A twenty-minute batchmode
 *    run that was never going to work should cost zero seconds and leave no directory a
 *    later reader could mistake for evidence.
 *  - THE ARGV IS PINNED. It is the declared command line the manifest records, and it is
 *    exactly the kind of "declared path nothing walks" this repo keeps getting burned by.
 *  - A FAILED RUN LEAVES NO MANIFEST. Spawn failure, timeout, unreadable results: each
 *    exits 2 with no stamped pair, and any partial XML is deleted, so the next reader sees
 *    "no results", never last week's.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../../../../surfaces/cli.js";
import {
  defaultEditorLocatorSeams,
  projectVersionPath,
} from "../../../../capabilities/tests/editor-locator.js";
import {
  TEST_RESULTS_FILE,
  isTestResultsManifestError,
  loadTestResultsManifest,
  sha256,
  testResultsDir,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
} from "../../../../capabilities/tests/test-results-manifest.js";
import {
  buildUnityTestArgs,
  countCompileErrors,
  defaultSpawnStdio,
  parseLogEditorVersion,
  run as runTestsVerb,
  type TestsSpawnRequest,
  type TestsSpawnResult,
  type TestsSpawner,
} from "../../../../capabilities/tests/tests.js";

const EDITOR = "/fake/Unity/Hub/Editor/6000.3.20f1/Unity.app/Contents/MacOS/Unity";
const VERSION = "6000.3.20f1";

const GREEN_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  '    <test-case id="3" name="b" fullname="N.F.b" result="Passed" />\n' +
  "  </test-suite>\n</test-run>\n";

const RED_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Failed" total="2" passed="1" failed="1" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Failed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  '    <test-case id="3" name="b" fullname="N.F.b" result="Failed" label="Error">\n' +
  "      <failure><message>expected 3 but was 4</message></failure>\n" +
  "    </test-case>\n  </test-suite>\n</test-run>\n";

const LOG = `Unity Editor version:    ${VERSION} (0123456789ab)\nRefreshing native plugins\nAll tests finished.\n`;

/** Seams that resolve exactly one fake editor and read the real (temp) filesystem. */
function locatorSeams() {
  // env is emptied deliberately: a developer's real UNITY_EDITOR must not steer a unit test.
  return defaultEditorLocatorSeams({ env: {}, isExecutable: (p) => p === EDITOR });
}

interface Project {
  root: string;
  dir: string;
}

/** A throwaway Unity-shaped project: ProjectVersion.txt + Assets/, nothing else. */
async function plantProject(opts: { version?: string; assets?: boolean } = {}): Promise<Project> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-tests-run-"));
  if (opts.version !== null) {
    await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await fs.writeFile(
      projectVersionPath(root),
      `m_EditorVersion: ${opts.version ?? VERSION}\nm_EditorVersionWithRevision: ${opts.version ?? VERSION} (abc)\n`,
      "utf-8",
    );
  }
  if (opts.assets !== false) await fs.mkdir(path.join(root, "Assets"), { recursive: true });
  return { root, dir: testResultsDir(root) };
}

function recordingSpawner(
  behaviour: (request: TestsSpawnRequest) => Promise<TestsSpawnResult> | TestsSpawnResult,
): { spawner: TestsSpawner; calls: TestsSpawnRequest[] } {
  const calls: TestsSpawnRequest[] = [];
  const spawner: TestsSpawner = async (request) => {
    calls.push(request);
    return behaviour(request);
  };
  return { spawner, calls };
}

/** A spawner that behaves like a finished Unity run: writes the XML and the log. */
function writingSpawner(xml: string, exitCode: number, log = LOG) {
  return recordingSpawner(async (request) => {
    const results = request.args[request.args.indexOf("-testResults") + 1];
    await fs.writeFile(results, xml, "utf-8");
    await fs.writeFile(request.logPath, log, "utf-8");
    return { ok: true, exitCode, signal: null, timedOut: false };
  });
}

async function capture(
  args: string[],
  opts: { spawner?: TestsSpawner } = {},
): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const outLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...a: unknown[]) => {
    outLines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errLines.push(a.map(String).join(" "));
  };
  let code: number;
  try {
    code = await runTestsVerb(args, { spawner: opts.spawner, locatorSeams: locatorSeams() });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Pre-spawn refusals: exit 2, nothing spawned, nothing created               */
/* -------------------------------------------------------------------------- */

test("REFUSES a directory that is not a Unity project, before spawning anything", async () => {
  const project = await plantProject({ version: null as unknown as string });
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /not a Unity project/);
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(project.root, ".loombridge")), false, "a refusal must create nothing");
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("REFUSES a project with no Assets/ directory", async () => {
  const project = await plantProject({ assets: false });
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /no Assets\/ directory/);
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(project.root, ".loombridge")), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("REFUSES when Temp/UnityLockfile shows an editor already has the project open (G14)", async () => {
  const project = await plantProject();
  await fs.mkdir(path.join(project.root, "Temp"), { recursive: true });
  await fs.writeFile(path.join(project.root, "Temp", "UnityLockfile"), "", "utf-8");
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /UnityLockfile/);
    assert.match(err, /until the timeout expires/, "the refusal must say why waiting is pointless");
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("REFUSES an unresolvable editor, naming the version the project declares", async () => {
  const project = await plantProject({ version: "2022.3.62f1" });
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(["run", "--root", project.root], { spawner });
    assert.equal(code, 2);
    assert.match(err, /Unity 2022\.3\.62f1 not found/);
    assert.match(err, /UNITY_EDITOR=/);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("REFUSES --platform PlayMode with a clear not-yet message", async () => {
  const project = await plantProject();
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(
      ["run", "--root", project.root, "--unity", EDITOR, "--platform", "PlayMode"],
      { spawner },
    );
    assert.equal(code, 2);
    assert.match(err, /PlayMode/);
    assert.match(err, /EditMode only/);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("REFUSES a non-numeric --timeout-min instead of silently defaulting", async () => {
  const project = await plantProject();
  const { spawner, calls } = recordingSpawner(() => assert.fail("must not spawn"));
  try {
    const { code, err } = await capture(
      ["run", "--root", project.root, "--unity", EDITOR, "--timeout-min", "soon"],
      { spawner },
    );
    assert.equal(code, 2);
    assert.match(err, /--timeout-min must be a positive whole number/);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The pinned argv (G4)                                                       */
/* -------------------------------------------------------------------------- */

test("THE ARGV IS PINNED, and it contains NO -quit", async () => {
  const project = await plantProject();
  const { spawner, calls } = writingSpawner(GREEN_XML, 0);
  try {
    const { code } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].editorPath, EDITOR);
    assert.deepEqual(calls[0].args, [
      "-batchmode",
      "-nographics",
      "-projectPath",
      project.root,
      "-runTests",
      "-testPlatform",
      "EditMode",
      "-testResults",
      testResultsPath(project.dir),
      "-logFile",
      testRunLogPath(project.dir),
    ]);

    // -quit races Unity's own test-runner shutdown and can terminate the editor before the
    // results are written. An empty XML grades as "checked nothing", so the tidy-looking
    // flag is a path to a verdict built on no evidence.
    assert.ok(!calls[0].args.includes("-quit"), "-quit must never be passed alongside -runTests");

    // The manifest records the same argv, editor first: the declared command line is data.
    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.deepEqual(manifest.command, [EDITOR, ...calls[0].args]);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("--graphics opts OUT of the default -nographics, and only that", async () => {
  const project = await plantProject();
  const { spawner, calls } = writingSpawner(GREEN_XML, 0);
  try {
    await capture(["run", "--root", project.root, "--unity", EDITOR, "--graphics"], { spawner });
    assert.ok(!calls[0].args.includes("-nographics"));
    assert.deepEqual(
      calls[0].args,
      buildUnityTestArgs({
        root: project.root,
        resultsPath: testResultsPath(project.dir),
        logPath: testRunLogPath(project.dir),
        graphics: true,
      }),
    );
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("--timeout-min reaches the spawner in milliseconds (default 30 minutes)", async () => {
  const project = await plantProject();
  const first = writingSpawner(GREEN_XML, 0);
  const second = writingSpawner(GREEN_XML, 0);
  try {
    await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner: first.spawner });
    assert.equal(first.calls[0].timeoutMs, 30 * 60_000);
    await capture(["run", "--root", project.root, "--unity", EDITOR, "--timeout-min", "5"], {
      spawner: second.spawner,
    });
    assert.equal(second.calls[0].timeoutMs, 5 * 60_000);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("the default spawner never hands fd 1 to the child (shared/child-stdio.ts rule)", () => {
  const stdio = defaultSpawnStdio();
  assert.deepEqual(stdio, ["ignore", "ignore", "ignore"]);
  assert.ok(!stdio.includes("inherit" as never), "inherit would corrupt the test runner's result channel");
});

/* -------------------------------------------------------------------------- */
/* Success: the stamped pair                                                  */
/* -------------------------------------------------------------------------- */

test("a green run stamps a complete manifest and exits 0", async () => {
  const project = await plantProject();
  const { spawner } = writingSpawner(GREEN_XML, 0);
  try {
    const { code, out } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 0);
    assert.match(out, /2 test\(s\): 2 passed/);
    assert.match(out, /tier 0/);

    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.equal(manifest.kind, "test-results");
    assert.equal(manifest.schemaVersion, "1");
    assert.equal(manifest.projectRoot, project.root);
    assert.equal(manifest.projectDeclaredEditorVersion, VERSION);
    assert.equal(manifest.logReportedEditorVersion, VERSION, "the banner in the log, not the project's claim");
    assert.equal(manifest.resolvedEditorPath, EDITOR);
    assert.equal(manifest.testPlatform, "EditMode");
    assert.equal(manifest.exitCode, 0);
    assert.equal(manifest.compileErrors, 0);
    assert.deepEqual(manifest.assemblies, ["Dev.Editor.Tests.dll"]);
    assert.equal(manifest.resultsSha256, sha256(GREEN_XML));
    assert.equal(manifest.logSha256, sha256(LOG));
    assert.equal(manifest.runId, null, "no build in flight means null, not a fabricated id");
    assert.deepEqual(manifest.summary, { total: 2, passed: 2, failed: 0, inconclusive: 0, skipped: 0 });
    assert.equal(manifest.mutatedProject, false);
    assert.ok(Date.parse(manifest.startedAt) <= Date.parse(manifest.finishedAt));
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("a red run exits 1 and still stamps, so the failure is citable evidence", async () => {
  const project = await plantProject();
  // Unity exits 2 when tests failed; the walk accounts for it, so this stays a game defect.
  const { spawner } = writingSpawner(RED_XML, 2);
  try {
    const { code, out } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 1, out);
    assert.match(out, /FAIL N\.F\.b/);
    assert.match(out, /expected 3 but was 4/);
    assert.match(out, /tier 1/);

    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.deepEqual(manifest.summary, { total: 2, passed: 1, failed: 1, inconclusive: 0, skipped: 0 });
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("the manifest stamps STATE.currentBuild.runId when a build is in flight (G7)", async () => {
  const project = await plantProject();
  await fs.mkdir(path.join(project.root, ".loombridge"), { recursive: true });
  await fs.writeFile(
    path.join(project.root, ".loombridge", "STATE.md"),
    "# state\n\n<!-- loombridge-state: " +
      JSON.stringify({
        genre: "platformer",
        engine: "unity",
        phase: "built-unverified",
        currentBuild: { runId: "run-abc-123", startedAt: "2026-07-27T09:00:00.000Z" },
        updatedAt: "2026-07-27T09:00:00.000Z",
      }) +
      " -->\n",
    "utf-8",
  );
  const { spawner } = writingSpawner(GREEN_XML, 0);
  try {
    await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.equal(manifest.runId, "run-abc-123");
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("compile errors in the log are counted and refuse the run (G4)", async () => {
  const project = await plantProject();
  const log = `${LOG}Assets/Foo.cs(12,7): error CS0619: 'Object.GetInstanceID()' is obsolete\n`;
  const { spawner } = writingSpawner(GREEN_XML, 0, log);
  try {
    const { code, out } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2, out);
    assert.match(out, /compile error line/);

    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.equal(manifest.compileErrors, 1);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }

  assert.equal(countCompileErrors("a\nAssets/X.cs(1,1): error CS0103: x\nb\n"), 1);
  assert.equal(countCompileErrors("no compile problems here, just the words error CS in prose\n"), 0);
  assert.equal(parseLogEditorVersion(LOG), VERSION);
  assert.equal(parseLogEditorVersion("no banner at all"), null);
});

test("MUTATION GUARD: a run that rewrites ProjectVersion.txt says so loudly and refuses (T4/R12)", async () => {
  const project = await plantProject();
  const upgrading = recordingSpawner(async (request) => {
    const results = request.args[request.args.indexOf("-testResults") + 1];
    await fs.writeFile(results, GREEN_XML, "utf-8");
    await fs.writeFile(request.logPath, LOG, "utf-8");
    // Exactly what a near-miss editor does: it upgrades the project on open.
    await fs.writeFile(projectVersionPath(project.root), "m_EditorVersion: 6000.4.1f1\n", "utf-8");
    return { ok: true, exitCode: 0, signal: null, timedOut: false };
  });
  try {
    const { code, err, out } = await capture(["run", "--root", project.root, "--unity", EDITOR], {
      spawner: upgrading.spawner,
    });
    assert.equal(code, 2, `${out}\n${err}`);
    assert.match(err, /CHANGED/);
    assert.match(err, /ProjectVersion\.txt/);
    const manifest = await loadTestResultsManifest(project.dir);
    assert.ok(manifest !== null && !isTestResultsManifestError(manifest));
    assert.equal(manifest.mutatedProject, true, "the mutation must be recorded, not only printed");
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Harness faults: no manifest, no partial evidence (G9)                      */
/* -------------------------------------------------------------------------- */

test("a spawn failure writes NO manifest and exits 2", async () => {
  const project = await plantProject();
  const { spawner } = recordingSpawner(() => ({
    ok: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    error: "spawn ENOENT",
  }));
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /could not run Unity: spawn ENOENT/);
    assert.match(err, /no manifest was written/);
    assert.equal(await exists(testResultsManifestPath(project.dir)), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("a TIMEOUT deletes the partial XML, writes NO manifest, and exits 2", async () => {
  const project = await plantProject();
  const { spawner } = recordingSpawner(async (request) => {
    // A killed editor leaves a half-written results file behind.
    const results = request.args[request.args.indexOf("-testResults") + 1];
    await fs.writeFile(results, '<?xml version="1.0"?><test-run id="2" total="9"', "utf-8");
    return { ok: false, exitCode: null, signal: "SIGKILL", timedOut: true };
  });
  try {
    const { code, err } = await capture(
      ["run", "--root", project.root, "--unity", EDITOR, "--timeout-min", "1"],
      { spawner },
    );
    assert.equal(code, 2);
    assert.match(err, /did not finish within 1 min/);
    assert.match(err, new RegExp(`deleted the partial ${TEST_RESULTS_FILE}`));
    assert.equal(await exists(testResultsPath(project.dir)), false, "a partial XML must never survive");
    assert.equal(await exists(testResultsManifestPath(project.dir)), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("a licensing failure is named, and still produces no manifest", async () => {
  const project = await plantProject();
  const { spawner } = recordingSpawner(async (request) => {
    await fs.writeFile(request.logPath, "LICENSE SYSTEM [2026727 9:12:3] No valid license found\n", "utf-8");
    return { ok: true, exitCode: 1, signal: null, timedOut: false };
  });
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /wrote no test-results\.xml/);
    assert.match(err, /licensing/);
    assert.equal(await exists(testResultsManifestPath(project.dir)), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("unreadable results write NO manifest: unbindable bytes are not evidence", async () => {
  const project = await plantProject();
  const { spawner } = writingSpawner('<?xml version="1.0"?><test-run id="2" total="3"', 0);
  try {
    const { code, err } = await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner });
    assert.equal(code, 2);
    assert.match(err, /is unreadable: truncated XML/);
    assert.equal(await exists(testResultsManifestPath(project.dir)), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test("a failed run CLEARS the previous run's stamped pair; stale evidence never survives", async () => {
  const project = await plantProject();
  const green = writingSpawner(GREEN_XML, 0);
  try {
    assert.equal((await capture(["run", "--root", project.root, "--unity", EDITOR], { spawner: green.spawner })).code, 0);
    assert.equal(await exists(testResultsManifestPath(project.dir)), true);

    const failing = recordingSpawner(() => ({
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: "spawn EACCES",
    }));
    const { code } = await capture(["run", "--root", project.root, "--unity", EDITOR], {
      spawner: failing.spawner,
    });
    assert.equal(code, 2);
    assert.equal(
      await exists(testResultsManifestPath(project.dir)),
      false,
      "last run's manifest must not linger where a grader would read it as fresh",
    );
    assert.equal(await exists(testResultsPath(project.dir)), false);
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* CLI wiring                                                                 */
/* -------------------------------------------------------------------------- */

test("`loombridge tests` is dispatched and listed in the Verify group", async () => {
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  let helpCode: number;
  let usageCode: number;
  try {
    // Reaches the verb (its own usage), rather than falling through to "unknown command".
    helpCode = await loombridgeCli(["node", "cli.js", "tests", "--help"]);
    lines.length = 0;
    usageCode = await loombridgeCli(["node", "cli.js", "--help"]);
  } finally {
    console.log = origLog;
  }
  assert.equal(helpCode, 0);
  const usage = lines.join("\n");
  assert.equal(usageCode, 0);

  // One entry, in the Verify group, producer-first: what it PRODUCES is the reason to run it.
  const verifyGroup = usage.slice(usage.indexOf("Verify ("), usage.indexOf("Build loop ("));
  assert.match(verifyGroup, /^\s{2}tests\s{5}/m, "`tests` belongs to the Verify group");
  assert.match(verifyGroup, /STAMP the results/);
  assert.match(verifyGroup, /diagnostic/i, "the help must say `grade` is not a verdict");
  assert.equal(
    (usage.match(/^\s{2}tests\s/gm) ?? []).length,
    1,
    "one entry only; a verb listed twice is a group layout that has drifted",
  );
});
