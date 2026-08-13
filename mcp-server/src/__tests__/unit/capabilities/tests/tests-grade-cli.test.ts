/**
 * `loombridge tests grade --results <xml>` (amendment G2).
 *
 * This verb reads an XML the OPERATOR named. That is the whole difference between it and
 * the unified door: there, discovery chooses the input; here, whoever typed the command
 * does. So it is deliberately weaker than a verdict, and it says so on every single output
 * path, including the failures, so no crop of its output can be pasted as proof.
 *
 * The rule under test: a GREEN from this verb exits 0 only when the green is attributable
 * to something other than the person asking. Either the pair is stamped and verifying (the
 * producer vouches for the bytes), or GITHUB_ACTIONS is set (the runner produced the file
 * and cannot be talked into re-labelling a local artifact). A local green on an unstamped
 * file exits 2 and says how to produce quotable results, because "I ran the tests and they
 * passed" is exactly the self-graded claim this repo refuses.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GITHUB_ACTIONS_VALUE,
  GRADE_DIAGNOSTIC_BANNER,
  MISPLACED_REFUSAL,
  TAMPERED_REFUSAL,
  UNSTAMPED_REFUSAL,
  run as runTestsVerb,
} from "../../../../capabilities/tests/tests.js";
import {
  projectRootForTestResultsDir,
  sha256,
  testResultsDir,
  testResultsPath,
  testRunLogPath,
  writeTestResultsManifest,
  type TestResultsManifest,
} from "../../../../capabilities/tests/test-results-manifest.js";

const GREEN_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  '    <test-case id="3" name="b" fullname="N.F.b" result="Passed" />\n' +
  "  </test-suite>\n</test-run>\n";

const RED_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Failed" total="1" passed="0" failed="1" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Failed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Failed" label="Error">\n' +
  "      <failure><message>expected 3 but was 4</message></failure>\n" +
  "    </test-case>\n  </test-suite>\n</test-run>\n";

/** FXA: `Broken` is not NUnit's vocabulary, and `passed` is the right word in the wrong case. */
const UNKNOWN_RESULT_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Passed" total="3" passed="3" failed="0" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  '    <test-case id="3" name="b" fullname="N.F.b" result="Broken">\n' +
  "      <failure><message>NullReferenceException in the subject under test</message></failure>\n" +
  "    </test-case>\n" +
  '    <test-case id="4" name="c" fullname="N.F.c" result="passed" />\n' +
  "  </test-suite>\n</test-run>\n";

const LOG = "Unity Editor version:    6000.3.20f1 (0123456789ab)\n";

function manifestFor(root: string, xml: string, overrides: Partial<TestResultsManifest> = {}): TestResultsManifest {
  return {
    kind: "test-results",
    schemaVersion: "1",
    projectRoot: root,
    projectDeclaredEditorVersion: "6000.3.20f1",
    logReportedEditorVersion: "6000.3.20f1",
    resolvedEditorPath: "/fake/Unity",
    testPlatform: "EditMode",
    startedAt: "2026-07-27T09:12:03.000Z",
    finishedAt: "2026-07-27T09:12:09.000Z",
    exitCode: 0,
    compileErrors: 0,
    assemblies: ["Dev.Editor.Tests.dll"],
    resultsSha256: sha256(xml),
    logSha256: sha256(LOG),
    runId: null,
    command: ["/fake/Unity", "-batchmode"],
    summary: { total: 2, passed: 2, failed: 0, inconclusive: 0, skipped: 0 },
    mutatedProject: false,
    ...overrides,
  };
}

/** A project whose `.loombridge/tests/` holds a stamped, verifying pair. */
async function plantStamped(
  xml = GREEN_XML,
  overrides: Partial<TestResultsManifest> = {},
): Promise<{ root: string; results: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-grade-"));
  const dir = testResultsDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(testResultsPath(dir), xml, "utf-8");
  await fs.writeFile(testRunLogPath(dir), LOG, "utf-8");
  await writeTestResultsManifest(dir, manifestFor(root, xml, overrides));
  return { root, results: testResultsPath(dir) };
}

/** A bare XML nobody stamped: the hand-dropped case. */
async function plantBare(xml = GREEN_XML, name = "results.xml"): Promise<{ root: string; results: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-grade-bare-"));
  const results = path.join(root, name);
  await fs.writeFile(results, xml, "utf-8");
  return { root, results };
}

async function capture(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string; err: string; all: string }> {
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
    code = await runTestsVerb(args, { env });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const out = outLines.join("\n");
  const err = errLines.join("\n");
  return { code, out, err, all: `${out}\n${err}` };
}

test("a STAMPED, verifying green exits 0 and is marked quotable", async () => {
  const { root, results } = await plantStamped();
  try {
    const { code, out } = await capture(["grade", "--results", results]);
    assert.equal(code, 0, out);
    assert.match(out, /stamped and verifying: this green is quotable/);
    assert.match(out, /tier 0/);
    assert.ok(out.includes(GRADE_DIAGNOSTIC_BANNER), "even a quotable green stays labelled diagnostic");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an UNSTAMPED green exits 2 and says how to produce quotable results", async () => {
  const { root, results } = await plantBare();
  try {
    const { code, out, err } = await capture(["grade", "--results", results]);
    assert.equal(code, 2, "a self-chosen green file must never exit 0");
    // The mapping is still PRINTED: the operator asked what the file says and gets an answer.
    assert.match(out, /2 test\(s\): 2 passed/);
    assert.match(out, /tier 0/);
    assert.equal(err.includes(UNSTAMPED_REFUSAL), true);
    assert.match(err, /loombridge tests run/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GITHUB_ACTIONS attests an unstamped green, and only GITHUB_ACTIONS does", async () => {
  const { root, results } = await plantBare();
  try {
    const ci = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(ci.code, 0, ci.all);
    // FXF: the wording is an ENV-CLAIMED attestation, not a claim that provenance was
    // verified. Nothing here checks that this process is on a GitHub runner, and the line an
    // operator reads must not imply that it did.
    assert.match(ci.out, /GITHUB_ACTIONS=true: treating the file as runner-produced/);
    assert.match(ci.out, /env-claimed attestation, not verified provenance/);

    // A lookalike variable must not buy the same trust.
    const impostor = await capture(["grade", "--results", results], { CI: "true", GITHUB_ACTION: "true" });
    assert.equal(impostor.code, 2);
    assert.ok(impostor.err.includes(UNSTAMPED_REFUSAL));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FXF: GITHUB_ACTIONS must be the EXACT string GitHub sets; any other value attests nothing", async () => {
  // A truthiness test (`if (env.GITHUB_ACTIONS)`) hands the runner's trust root to anyone who
  // can export a variable, and `GITHUB_ACTIONS=0` or `=false` are things a local shell writes
  // while GitHub writes only "true". Each of these is a green file; none of them may exit 0.
  const { root, results } = await plantBare();
  try {
    for (const value of ["1", "0", "false", "TRUE", "true ", "yes", ""]) {
      const attempt = await capture(["grade", "--results", results], { GITHUB_ACTIONS: value });
      assert.equal(attempt.code, 2, `GITHUB_ACTIONS=${JSON.stringify(value)} must not attest anything`);
      assert.ok(attempt.err.includes(UNSTAMPED_REFUSAL));
    }
    // NON-VACUITY: the exact value still works, so the loop above is about the VALUE and not
    // about a path that stopped attesting altogether.
    assert.equal((await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE })).code, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* FXD: a stamped pair only vouches for the project it sits in                */
/* -------------------------------------------------------------------------- */

test("FXD: a stamped pair COPIED somewhere else is not quotable, and names the root it claims", async () => {
  // Every sha in the manifest survives a copy unchanged, because a copy preserves bytes. So
  // integrity alone proves "these are the bytes that were stamped" and never "and they belong
  // to this project". Without the location binding, `tests grade` would print "this green is
  // quotable" for a pair lifted out of a green checkout and dropped anywhere at all.
  const { root, results } = await plantStamped();
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-grade-moved-"));
  try {
    // Sanity: in its own project it IS quotable, so the refusal below is caused by the move.
    assert.equal((await capture(["grade", "--results", results])).code, 0);

    const dir = testResultsDir(root);
    const moved = path.join(elsewhere, "tests");
    await fs.mkdir(moved, { recursive: true });
    for (const name of await fs.readdir(dir)) {
      await fs.copyFile(path.join(dir, name), path.join(moved, name));
    }

    const { code, out, err } = await capture(["grade", "--results", testResultsPath(moved)]);
    assert.equal(code, 2, out);
    assert.ok(err.includes(MISPLACED_REFUSAL), err);
    assert.ok(out.includes(root), "the refusal prints the root the manifest CLAIMS");
    assert.ok(!out.includes("this green is quotable"), "a moved pair must never be called quotable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("FXD: a pair at the right SHAPE of path but the wrong project is refused too", async () => {
  // The sharper version: the copy lands at `<other>/.loombridge/tests/`, so the directory has
  // the declared shape and only the project differs. The manifest's own `projectRoot` is what
  // gives it away, held against the root the location implies.
  const { root } = await plantStamped();
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-grade-other-"));
  try {
    const from = testResultsDir(root);
    const to = testResultsDir(other);
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(from)) await fs.copyFile(path.join(from, name), path.join(to, name));

    const { code, out, err } = await capture(["grade", "--results", testResultsPath(to)]);
    assert.equal(code, 2, out);
    assert.ok(err.includes(MISPLACED_REFUSAL), err);
    assert.ok(out.includes(root), "the claimed root is printed");
    assert.ok(out.includes(other), "…beside the root the pair actually sits under");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("FXD: the results dir inverts to its project root, and refuses to invent one", () => {
  // The inverse of `testResultsDir`, re-derived forwards and compared, so the two directions
  // cannot drift. A directory that is not the declared slot yields null rather than a guess.
  const root = path.resolve("/proj/game");
  assert.equal(projectRootForTestResultsDir(testResultsDir(root)), root);
  assert.equal(projectRootForTestResultsDir("/proj/game/tests"), null, "no .loombridge parent");
  assert.equal(projectRootForTestResultsDir("/proj/game/.loombridge/reports"), null, "the wrong slot");
  assert.equal(projectRootForTestResultsDir("/proj/game/.loombridge"), null);
});

test("FXA: a case result outside NUnit's vocabulary refuses through `tests grade`", async () => {
  const { root, results } = await plantBare(UNKNOWN_RESULT_XML);
  try {
    // Even under the CI attestation, which is the most permissive path this verb has.
    const { code, out } = await capture(["grade", "--results", results], {
      GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE,
    });
    assert.equal(code, 2, out);
    assert.match(out, /outside NUnit's vocabulary/);
    assert.match(out, /N\.F\.b result='Broken'/);
    assert.match(out, /bucket accounting disagrees with the walk/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FXL: the help text names the exit-2 list and the GITHUB_ACTIONS exception exactly as implemented", async () => {
  const { out } = await capture(["--help"]);
  // Exit 1 includes the --strict Warning case…
  assert.match(out, /Exit 1: a real assertion failure, or a Warning case under --strict/);
  // …and the exit-2 list names every refusal a caller can actually hit, including the two FXA
  // rules, so the documented contract and the mapping cannot drift apart silently.
  for (const phrase of [
    "skipped or ignored SUITE",
    "inconclusive case",
    "outside NUnit's vocabulary",
    "bucket accounting",
    "MUTATED project",
    "cancelled run",
  ]) {
    assert.ok(out.includes(phrase), `the help never mentions "${phrase}"`);
  }
  // The CI exception is described with the EXACT value the code compares against.
  assert.ok(out.includes(`GITHUB_ACTIONS="${GITHUB_ACTIONS_VALUE}"`), out);
  assert.match(out, /that exact value, nothing else/);
  assert.match(out, /not at the project its manifest\s+claims/);
});

test("a red exits by the mapping whether stamped or not, and CI cannot launder it", async () => {
  const stamped = await plantStamped(RED_XML, {
    exitCode: 2,
    summary: { total: 1, passed: 0, failed: 1, inconclusive: 0, skipped: 0 },
  });
  const bare = await plantBare(RED_XML);
  try {
    const fromStamped = await capture(["grade", "--results", stamped.results]);
    assert.equal(fromStamped.code, 1, fromStamped.all);
    assert.match(fromStamped.out, /FAIL N\.F\.a/);

    const fromBare = await capture(["grade", "--results", bare.results], { GITHUB_ACTIONS: "true" });
    assert.equal(fromBare.code, 1, "GITHUB_ACTIONS attests a green; it does not convert a red");
  } finally {
    await fs.rm(stamped.root, { recursive: true, force: true });
    await fs.rm(bare.root, { recursive: true, force: true });
  }
});

test("a stamped pair whose manifest summary was hand-edited grades tier 2 (G12)", async () => {
  // Forging the manifest is the obvious attack once stamping is what buys exit 0. The
  // graded walk is re-derived from the bytes, so the forgery names itself.
  const { root, results } = await plantStamped(GREEN_XML, {
    summary: { total: 40, passed: 40, failed: 0, inconclusive: 0, skipped: 0 },
  });
  try {
    const { code, out } = await capture(["grade", "--results", results]);
    assert.equal(code, 2, out);
    assert.match(out, /manifest summary disagrees with the graded walk/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("H1: a stamped pair whose XML was edited after the run is REFUSED as tampering, not degraded", async () => {
  // THIS TEST'S OWN ASSERTION USED TO BE THE HOLE. It asserted the exit came from
  // `UNSTAMPED_REFUSAL`, which is to say it pinned the very degradation Finding A exploits:
  // a manifest that FAILS integrity fell through to the unstamped path, and the unstamped
  // path exits 0 under GITHUB_ACTIONS. The test passed only because it never set that
  // variable, so the suite proved the verdict was right in the one environment where the
  // exploit does not fire.
  const { root, results } = await plantStamped();
  try {
    await fs.writeFile(results, GREEN_XML.replace('name="b"', 'name="b_renamed"'), "utf-8");
    const { code, out, err } = await capture(["grade", "--results", results]);
    assert.match(out, /manifest present but not verifying/);
    assert.match(out, /sha256 mismatch/);
    assert.equal(code, 2);
    assert.ok(err.includes(TAMPERED_REFUSAL), err);
    assert.ok(
      !err.includes(UNSTAMPED_REFUSAL),
      "a manifest that is PRESENT and failing is not the same fact as no manifest at all",
    );

    // …AND UNDER THE CI ATTESTATION, which is the environment the original assertion never
    // visited and the only one in which this mattered.
    const ci = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(ci.code, 2, `GITHUB_ACTIONS must not launder a failing manifest: ${ci.all}`);
    assert.ok(ci.err.includes(TAMPERED_REFUSAL), ci.all);
    assert.ok(
      !ci.out.includes("treating the file as runner-produced"),
      "the attestation must not even be reached for a present-but-failing manifest",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("THE BANNER IS ON EVERY PATH, including the ones that never reach the mapping", async () => {
  const stamped = await plantStamped();
  const bare = await plantBare();
  const truncated = await plantBare('<?xml version="1.0"?><test-run id="2" total="3"', "cut.xml");
  try {
    const paths: Array<{ label: string; args: string[]; env?: NodeJS.ProcessEnv }> = [
      { label: "stamped green", args: ["grade", "--results", stamped.results] },
      { label: "unstamped green", args: ["grade", "--results", bare.results] },
      { label: "ci green", args: ["grade", "--results", bare.results], env: { GITHUB_ACTIONS: "1" } },
      { label: "missing file", args: ["grade", "--results", path.join(bare.root, "nope.xml")] },
      { label: "truncated", args: ["grade", "--results", truncated.results] },
    ];
    for (const scenario of paths) {
      const result = await capture(scenario.args, scenario.env ?? {});
      assert.ok(
        result.all.includes(GRADE_DIAGNOSTIC_BANNER),
        `the '${scenario.label}' path printed no diagnostic banner`,
      );
    }
  } finally {
    await fs.rm(stamped.root, { recursive: true, force: true });
    await fs.rm(bare.root, { recursive: true, force: true });
    await fs.rm(truncated.root, { recursive: true, force: true });
  }
});

test("a missing or unreadable results file exits 2, never 0", async () => {
  const { root, results } = await plantBare('<?xml version="1.0"?><test-run id="2" total="3"', "cut.xml");
  try {
    const missing = await capture(["grade", "--results", path.join(root, "absent.xml")], {
      GITHUB_ACTIONS: "true",
    });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /no results file at/);

    const truncated = await capture(["grade", "--results", results], { GITHUB_ACTIONS: "true" });
    assert.equal(truncated.code, 2);
    assert.match(truncated.err, /truncated XML/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grade without --results is a usage refusal, not a default guess", async () => {
  const { code, err } = await capture(["grade"]);
  assert.equal(code, 2);
  assert.match(err, /grade requires --results <xml>/);
});

/* -------------------------------------------------------------------------- */
/* H1: the audit's five-refusal manifest, reproduced end to end               */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK, VERBATIM. A manifest sitting in the declared slot beside a green XML, carrying
 * every single producer refusal this gate owns:
 *
 *   exitCode: 3            "the run itself failed"
 *   compileErrors: 42      "assemblies that did not compile ran no tests"
 *   mutatedProject: true   "the project is not the one that was measured"
 *   summary: 999 passed    the stamped-vs-graded cross-check (G12)
 *   assemblies: [wrong]    the assembly binding (G4)
 *
 * …plus `resultsSha256: "deadbeef"`, which is what made the other five invisible: the
 * integrity failure degraded the pair to "unstamped", the five facts became `undefined`, and
 * `undefined` skipped every one of the five checks. Observed before the fix, under
 * `GITHUB_ACTIONS=true`: `tier 0`, `EXIT 0`.
 */
async function plantFiveRefusalManifest(): Promise<{ root: string; results: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-grade-forged-"));
  const dir = testResultsDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(testResultsPath(dir), GREEN_XML, "utf-8");
  await fs.writeFile(testRunLogPath(dir), LOG, "utf-8");
  await writeTestResultsManifest(
    dir,
    manifestFor(root, GREEN_XML, {
      exitCode: 3,
      compileErrors: 42,
      mutatedProject: true,
      summary: { total: 999, passed: 999, failed: 0, inconclusive: 0, skipped: 0 },
      assemblies: ["NotTheAssemblyInTheXml.dll"],
      resultsSha256: "deadbeef",
    }),
  );
  return { root, results: testResultsPath(dir) };
}

/**
 * LITMUS, run against the REAL code path. `if (tampered !== null)` in `gradeStoredResults`
 * replaced by `if (false as boolean)`, which is exactly the pre-fix control flow (the failing
 * manifest falls through to the unstamped path). Both H1 tests fail; observed verbatim:
 *
 *   ✖ H1: a manifest carrying ALL FIVE producer refusals cannot reach exit 0, CI attestation included
 *     AssertionError [ERR_ASSERTION]: [loombridge tests] DIAGNOSTIC: not a verification verdict
 *     [loombridge tests] …/.loombridge/tests/test-results.xml
 *     [loombridge tests] manifest present but not verifying: test-results.xml sha256 mismatch: the
 *                        results were edited after the run that stamped them
 *     [loombridge tests] 2 test(s): 2 passed, 0 failed, 0 inconclusive, 0 skipped
 *     [loombridge tests]   attribution: NOT attributed to any run: manifest present but not verifying: …
 *     [loombridge tests] tier 0
 *
 *   ✖ H1: a stamped pair whose XML was edited after the run is REFUSED as tampering, not degraded
 *     AssertionError [ERR_ASSERTION]: [loombridge tests] unstamped input; run `loombridge tests run`
 *                                     to produce quotable results
 *
 *   ℹ tests 24 / ℹ pass 22 / ℹ fail 2
 *
 * Restored: `ℹ tests 24 / ℹ pass 24 / ℹ fail 0`.
 */
test("H1: a manifest carrying ALL FIVE producer refusals cannot reach exit 0, CI attestation included", async () => {
  const { root, results } = await plantFiveRefusalManifest();
  try {
    for (const env of [{}, { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE }]) {
      const label = JSON.stringify(env);
      const { code, out, err, all } = await capture(["grade", "--results", results], env);
      assert.equal(code, 2, `the five-refusal manifest exited ${code} under ${label}:\n${all}`);
      assert.ok(err.includes(TAMPERED_REFUSAL), all);
      assert.match(out, /sha256 mismatch/);
      assert.ok(!out.includes("this green is quotable"), "a forged pair is never quotable");
      assert.ok(
        !out.includes("treating the file as runner-produced"),
        "the CI attestation must not be reached for a present-but-failing manifest",
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LITMUS: the H1 refusal really is what stops it; restore the sha and the SAME pair is quotable", async () => {
  // Non-vacuity for the test above. If `plantFiveRefusalManifest` were simply unreadable, or
  // if `tests grade` had started refusing everything, the assertion would pass for the wrong
  // reason. So: the same directory, the same green XML, the same five forged facts, with ONLY
  // `resultsSha256` corrected. Integrity then passes, the pair grades as `stamped`, and the
  // five facts reach the grader as they always should have. Observed output of this half:
  //
  //   [loombridge tests]   attribution: producer facts from a verified stamped manifest
  //   [loombridge tests]   refusal: 42 compile error line(s) in the Unity log; assemblies that
  //                        did not compile ran no tests
  //   [loombridge tests]   refusal: the run MUTATED ProjectSettings/ProjectVersion.txt; …
  //   [loombridge tests]   refusal: Unity exited 3, which the test-case walk does not account for
  //   [loombridge tests]   refusal: manifest summary disagrees with the graded walk: total 999 vs 2; …
  //   [loombridge tests]   refusal: assembly set disagrees with the manifest; stamped but absent
  //                        from the XML: NotTheAssemblyInTheXml.dll; …
  //   [loombridge tests] tier 2
  const { root, results } = await plantFiveRefusalManifest();
  try {
    const dir = testResultsDir(root);
    await writeTestResultsManifest(
      dir,
      manifestFor(root, GREEN_XML, {
        exitCode: 3,
        compileErrors: 42,
        mutatedProject: true,
        summary: { total: 999, passed: 999, failed: 0, inconclusive: 0, skipped: 0 },
        assemblies: ["NotTheAssemblyInTheXml.dll"],
        // The ONE difference: the sha now matches the bytes on disk.
        resultsSha256: sha256(GREEN_XML),
      }),
    );
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 2, out);
    // Every one of the five now names itself, which is the proof they were REACHED. Before
    // H1 this same manifest produced `tier 0` and none of these lines.
    for (const refusal of [
      /42 compile error line\(s\)/,
      /MUTATED ProjectSettings/,
      /Unity exited 3/,
      /manifest summary disagrees with the graded walk: total 999 vs 2/,
      /stamped but absent from the XML: NotTheAssemblyInTheXml\.dll/,
    ]) {
      assert.match(out, refusal, `a producer refusal never reached the grader: ${refusal}`);
    }
    assert.match(out, /attribution: producer facts from a verified stamped manifest/);

    // And with the forgeries removed as well, the honest pair really is quotable, so the
    // refusals above are about the FORGERY and not about a verb that stopped exiting 0.
    await writeTestResultsManifest(dir, manifestFor(root, GREEN_XML));
    const honest = await capture(["grade", "--results", results]);
    assert.equal(honest.code, 0, honest.all);
    assert.match(honest.out, /this green is quotable/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* H2: the roll-up cross-check, through the real verb                        */
/* -------------------------------------------------------------------------- */

/** The audit's B1: omit ONE attribute (`total`) and the whole cross-check used to switch off. */
const NO_TOTAL_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Passed" passed="1" failed="3" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  "  </test-suite>\n</test-run>\n";

/** The audit's B2: only `failed` was ever compared, so inflate the two counts nobody read. */
const INFLATED_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<test-run id="2" result="Passed" total="500" passed="499" failed="0" inconclusive="0" skipped="0">\n' +
  '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
  '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
  "  </test-suite>\n</test-run>\n";

/**
 * LITMUS for the whole H2 rule, run against the REAL code path. `rollupCrossCheck` at the run
 * level replaced by the pre-fix predicate (`<test-run failed> > 0`, and only when `total` was
 * also declared), and the suite-level loop's result discarded with `void suiteRefusals`.
 * Five tests fail across the two files; observed verbatim:
 *
 *   ✖ ADVERSARIAL: nested suites whose attributes disagree never outvote the case walk
 *   ✖ H2: a count that is not a whole number is MALFORMED, never coerced to zero
 *   ✖ H2: a SUITE roll-up is held against its own subtree, so hiding a case costs every ancestor
 *   ✖ H2: a roll-up with no `total` still cross-checks, and `failed=3` over one passing case refuses
 *     AssertionError [ERR_ASSERTION]: [loombridge tests] DIAGNOSTIC: not a verification verdict
 *     [loombridge tests] …/results.xml
 *     [loombridge tests] no test-results-manifest.json beside …/results.xml
 *   ✖ H2: `total="500" passed="499"` over ONE walked case refuses on both counts
 *
 * Restored: `ℹ tests 108 / ℹ pass 108 / ℹ fail 0` across the tests capability suite.
 */
test("H2: a roll-up with no `total` still cross-checks, and `failed=3` over one passing case refuses", async () => {
  // Observed BEFORE the fix, under the most permissive path this verb has:
  //   [loombridge tests] 1 test(s): 1 passed, 0 failed, 0 inconclusive, 0 skipped
  //   [loombridge tests] tier 0
  //   EXIT 0
  const { root, results } = await plantBare(NO_TOTAL_XML);
  try {
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 2, out);
    assert.match(out, /<test-run> declares failed="3" but the walk beneath it found 0/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('H2: `total="500" passed="499"` over ONE walked case refuses on both counts', async () => {
  // Observed BEFORE the fix: `1 test(s): 1 passed`, `tier 0`, EXIT 0. Only `failed` was
  // compared, and `failed="0"` was honest, so 499 tests that do not exist cost nothing.
  const { root, results } = await plantBare(INFLATED_XML);
  try {
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 2, out);
    assert.match(out, /<test-run> declares total="500" but only 1 test case\(s\) are present/);
    assert.match(out, /<test-run> declares passed="499" but the walk beneath it found 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* H3: attribution is stated at every door, and the bare-XML flow survives    */
/* -------------------------------------------------------------------------- */

test("H3: a bare CI XML is UNATTRIBUTED, says so on every path, and CI still exits 0", async () => {
  // THE FALSE-FAILURE BAR. A genuine headless CI run produces exactly this: a GameCI NUnit3
  // artifact with no manifest, no log, and nothing that could attribute it to a producer. It
  // must stay green, or the moat fix gets relaxed the first Monday it reds out a real repo.
  const { root, results } = await plantBare();
  try {
    const ci = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(ci.code, 0, ci.all);
    // …and the gap is VISIBLE rather than absent: the reason is printed, not inferred from a
    // missing line. This is what the named opt-in buys over an omitted field.
    assert.match(ci.out, /attribution: NOT attributed to any run: no test-results-manifest\.json/);

    // The same file WITHOUT the runner's attestation is still a refusal.
    const local = await capture(["grade", "--results", results]);
    assert.equal(local.code, 2);
    assert.ok(local.err.includes(UNSTAMPED_REFUSAL));
    assert.match(local.out, /attribution: NOT attributed to any run/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("H3: a stamped, verifying pair grades as ATTRIBUTED and says which facts it used", async () => {
  const { root, results } = await plantStamped();
  try {
    const { code, out } = await capture(["grade", "--results", results]);
    assert.equal(code, 0, out);
    assert.match(out, /attribution: producer facts from a verified stamped manifest/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* FALSE-FAILURE BAR: legitimate documents that must NOT turn red             */
/* -------------------------------------------------------------------------- */

test("FALSE-FAILURE: an older writer that omits `total` entirely is graded on what it DOES declare", async () => {
  // Absence is not disagreement. A writer that never emits `total` (or `warnings`, which real
  // Unity output already omits) is compared on the counts it states, and an honest document
  // still exits 0 under the CI attestation. Refusing an absent count would have turned every
  // such writer red, which is the shape of fix that gets reverted.
  const noTotalButHonest =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<test-run id="2" result="Passed" passed="2" failed="0">\n' +
    '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
    '    <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
    '    <test-case id="3" name="b" fullname="N.F.b" result="Passed" />\n' +
    "  </test-suite>\n</test-run>\n";
  const { root, results } = await plantBare(noTotalButHonest);
  try {
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 0, out);
    assert.match(out, /tier 0/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FALSE-FAILURE: a suite that declares NO counts at all is not held to counts it never stated", async () => {
  const noSuiteCounts =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<test-run id="2" result="Passed" total="1" passed="1" failed="0" inconclusive="0" skipped="0">\n' +
    '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed">\n' +
    '    <test-suite type="TestFixture" id="9" name="F" result="Passed">\n' +
    '      <test-case id="2" name="a" fullname="N.F.a" result="Passed" />\n' +
    "    </test-suite>\n  </test-suite>\n</test-run>\n";
  const { root, results } = await plantBare(noSuiteCounts);
  try {
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 0, out);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FALSE-FAILURE: an all-skipped suite still refuses for the reason it always did, and no other", async () => {
  // The pre-existing "checked nothing" refusal must stay the reason. If the roll-up rule had
  // been written to read an absent count as zero, or `skipped` asymmetrically, this document
  // would have grown a second, wrong refusal on top of the right one.
  const allSkipped =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<test-run id="2" result="Skipped" total="2" passed="0" failed="0" inconclusive="0" skipped="2">\n' +
    '  <test-suite type="Assembly" id="1" name="Dev.Editor.Tests.dll" result="Passed" total="2" passed="0" failed="0" inconclusive="0" skipped="2">\n' +
    '    <test-case id="2" name="a" fullname="N.F.a" result="Skipped" label="Ignored" />\n' +
    '    <test-case id="3" name="b" fullname="N.F.b" result="Skipped" label="Ignored" />\n' +
    "  </test-suite>\n</test-run>\n";
  const { root, results } = await plantBare(allSkipped);
  try {
    const { code, out } = await capture(["grade", "--results", results], { GITHUB_ACTIONS: GITHUB_ACTIONS_VALUE });
    assert.equal(code, 2, out);
    assert.match(out, /every one of the 2 test case\(s\) was skipped/);
    assert.ok(!out.includes("the roll-up and the cases disagree"), out);
    assert.ok(!out.includes("cases are missing from the document"), out);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
