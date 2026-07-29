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

test("a stamped pair whose XML was edited after the run is NOT treated as stamped", async () => {
  const { root, results } = await plantStamped();
  try {
    await fs.writeFile(results, GREEN_XML.replace('name="b"', 'name="b_renamed"'), "utf-8");
    const { code, out, err } = await capture(["grade", "--results", results]);
    assert.match(out, /manifest present but not verifying/);
    assert.match(out, /sha256 mismatch/);
    // The mapping itself is still green (the edit was cosmetic), so the exit comes from the
    // unstamped rule: an unverifiable manifest buys exactly nothing.
    assert.equal(code, 2);
    assert.ok(err.includes(UNSTAMPED_REFUSAL));
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
