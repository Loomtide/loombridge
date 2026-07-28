/**
 * The NUnit3 reader and the tier mapping (plan T6, amendments G3/G12/G13).
 *
 * Two things are under test and they fail in different ways:
 *
 *  1. THE PARSER, against a realistic document. A parser that silently drops test cases is
 *     the most dangerous failure this gate can have, because a document with the failing
 *     cases dropped reads as a clean green. So the fixture carries the awkward inputs on
 *     purpose (a literal '>' inside an attribute value, CDATA, entities) and the assertion
 *     is on the COUNTS, not on "it did not throw".
 *
 *  2. THE MAPPING, against adversarial documents. Every one of these is a shape where the
 *     cheerful reading and the honest reading differ: a suite that failed in TearDown while
 *     every case passed, a cancelled run, a run whose roll-up disagrees with its own case
 *     walk, an assembly nobody ran. The mapping's job is to refuse, not to average.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../../_support/paths.js";
import {
  decodeXmlEntities,
  deriveSummary,
  exitCodeIsUnexplained,
  gradeTestResults,
  isNUnitParseError,
  parseNUnitResults,
  summaryDisagreements,
  type NUnitRun,
} from "../../../../capabilities/tests/nunit-parse.js";

const FIXTURE = path.join(REPO_ROOT, "mcp-server/src/__tests__/fixtures/nunit/editmode-run.xml");

/** Parse or fail the test with the parser's own message (never `as` past an error). */
function parseOk(xml: string): NUnitRun {
  const parsed = parseNUnitResults(xml);
  if (isNUnitParseError(parsed)) assert.fail(`expected a parseable document, got: ${parsed.error}`);
  return parsed;
}

function wrapRun(inner: string, runAttrs = 'id="2" result="Passed" total="1" passed="1" failed="0" inconclusive="0" skipped="0"'): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<test-run ${runAttrs}>\n${inner}\n</test-run>\n`;
}

/* -------------------------------------------------------------------------- */
/* The parser                                                                 */
/* -------------------------------------------------------------------------- */

test("the realistic EditMode fixture parses into the exact case set it declares", () => {
  const run = parseOk(fs.readFileSync(FIXTURE, "utf-8"));

  // These numbers are the TRIMMED REAL run (see the fixture header), not authored ones.
  // Unity writes "Failed(Child)" here, never the bare "Failed" the authored fixture claimed.
  assert.equal(run.result, "Failed(Child)");
  assert.equal(run.cases.length, 5, "every test-case must survive the walk");
  assert.deepEqual(deriveSummary(run), { total: 5, passed: 3, failed: 1, inconclusive: 0, skipped: 1 });

  // The roll-up the document declares agrees with the walk: recomputed for the trimmed
  // subset, so the union rule (G3) has something true to agree with.
  assert.deepEqual(run.runAttrSummary, {
    total: 5,
    passed: 3,
    failed: 1,
    inconclusive: 0,
    skipped: 1,
    warnings: 0,
  });

  assert.deepEqual(run.assemblies, [
    "com.loomtide.loombridge.tests.dll",
    "com.loomtide.loombridge.tests.inputspike.dll",
  ]);

  const failed = run.cases.filter((c) => c.result === "Failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].fullname, "UnityBridge.Tests.ComponentHandlerTests.SetProperty_ObjectReference_AssetPathStringAssignsAsset");
  // REAL SHAPE: Unity leaves `label` OFF a plain assertion failure. The authored fixture
  // asserted label="Error", which made `isRealFailure`'s undefined-label branch the one
  // path the fixture never exercised.
  assert.equal(failed[0].label, undefined);
  assert.match(failed[0].message ?? "", /Expected string length 10 but was 54/);
  // The CDATA message is multi-line and survives as such.
  assert.match(failed[0].message ?? "", /\n {2}Expected: "DummyAsset"\n/);

  // The `<failure>` message is the ONLY thing read as a verdict. The real case carries an
  // `<output>` CDATA sibling and a `<stack-trace>` CDATA, and neither may bleed into it:
  // absorbing `<output>` would let arbitrary test console noise become the failure text.
  assert.doesNotMatch(failed[0].message ?? "", /ShowWork/);
  assert.doesNotMatch(failed[0].message ?? "", /ComponentHandlerTests\.cs/);
});

test("a literal '>' inside an attribute value does not truncate the walk", () => {
  // SYNTHETIC ON PURPOSE. Real Unity output contains no attribute value with a literal '>'
  // (the 509-case run this fixture was trimmed from has zero), so pinning this hazard to the
  // fixture would mean inventing Unity output to test a parser bug. The hazard is real for a
  // hand-rolled scanner regardless: `/<[^>]*>/` splits in the wrong place here and swallows
  // every element after it, dropping cases silently. So it is tested against a document that
  // is honest about being made up.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Failed">' +
        '<test-case id="2" name="first" fullname="N.F.first" result="Passed">' +
        '<properties><property name="Description" value="ordering holds when index > 0 for siblings" /></properties>' +
        "</test-case>" +
        '<test-case id="3" name="afterTheAngleBracket" fullname="N.F.afterTheAngleBracket" result="Failed">' +
        "<failure><message>still here</message></failure>" +
        "</test-case>" +
        "</test-suite>",
      'id="2" result="Failed" total="2" passed="1" failed="1" inconclusive="0" skipped="0"',
    ),
  );
  const after = run.cases.map((c) => c.name);
  assert.deepEqual(after, ["first", "afterTheAngleBracket"], `cases after the '>' attribute were dropped: ${after.join(", ")}`);
  assert.equal(run.cases[1].message, "still here");
});

test("entity-encoded text is decoded once, and only once", () => {
  // SYNTHETIC for the same reason as above: the real run uses CDATA exclusively and contains
  // zero entity references, so the fixture cannot carry this hazard without being fabricated.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="skippedOne" fullname="N.F.skippedOne" result="Skipped" label="Ignored">' +
        "<reason><message>EntityId APIs require &gt;= 6000.5 &amp; a Hub install &lt;= 6000.9</message></reason>" +
        "</test-case>" +
        "</test-suite>",
      'id="2" result="Passed" total="1" passed="0" failed="0" inconclusive="0" skipped="1"',
    ),
  );
  const skipped = run.cases.find((c) => c.result === "Skipped");
  assert.equal(skipped?.message, "EntityId APIs require >= 6000.5 & a Hub install <= 6000.9");

  // Single pass: an escaped escape stays escaped rather than becoming markup.
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeXmlEntities("&unknownentity;"), "&unknownentity;");
});

test("the REAL fixture's skipped case carries its CDATA reason, on the case and on its parent", () => {
  // What the real document actually does with an [Ignore]d case, kept as a pinned fact
  // because it is the shape the whole tier mapping turns on (see the fixture header, item 4).
  const run = parseOk(fs.readFileSync(FIXTURE, "utf-8"));

  const skipped = run.cases.find((c) => c.result === "Skipped");
  assert.equal(skipped?.label, "Ignored");
  assert.match(skipped?.message ?? "", /URP .* is not installed in this project/);

  // The PARENT fixture is marked Skipped/Ignored by NUnit purely because a child was
  // ignored, while staying `runstate="Runnable"` and counting the case that really ran.
  const parent = run.suites.find((s) => s.name === "AssetHandlerTests");
  assert.equal(parent?.result, "Skipped");
  assert.equal(parent?.label, "Ignored");
  assert.equal(parent?.runstate, "Runnable", "the fixture did NOT opt out of running");
  assert.equal(parent?.message, "One or more child tests were ignored");
});

test("a truncated document is an error, never a partial green", () => {
  const full = fs.readFileSync(FIXTURE, "utf-8");
  // Cut mid-document, after the passing cases and before the failing one is closed.
  const cut = full.slice(0, full.indexOf("RefusesUnknownInstanceId") + 40);
  const parsed = parseNUnitResults(cut);
  assert.ok(isNUnitParseError(parsed), "a truncated file must not parse");
  assert.match(parsed.error, /truncated XML/);
});

test("an empty or non-NUnit document is an error, not an empty run", () => {
  for (const input of ["", "   ", "<html><body>nope</body></html>"]) {
    const parsed = parseNUnitResults(input);
    assert.ok(isNUnitParseError(parsed), `expected an error for ${JSON.stringify(input)}`);
  }
});

test("mismatched end tags are refused", () => {
  const parsed = parseNUnitResults(wrapRun("<test-suite name=\"A\" result=\"Passed\"></test-case>"));
  assert.ok(isNUnitParseError(parsed));
  assert.match(parsed.error, /closes </);
});

/* -------------------------------------------------------------------------- */
/* The mapping                                                                */
/* -------------------------------------------------------------------------- */

test("a clean run with everything passing is tier 0", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="ok" fullname="N.F.ok" result="Passed" />' +
        "</test-suite>",
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 0);
  assert.deepEqual(grade.reasons, []);
});

test("the realistic fixture (a real red) is tier 1, not a harness fault", () => {
  const run = parseOk(fs.readFileSync(FIXTURE, "utf-8"));
  // Unity exits 2 when tests failed; the walk accounts for that, so it is not "unexplained".
  const grade = gradeTestResults({ run, strict: false, exitCode: 2, compileErrors: 0, mutatedProject: false });
  assert.equal(grade.tier, 1, `expected a game defect, reasons: ${grade.reasons.join(" | ")}`);
  assert.equal(grade.failures.length, 1);
  assert.match(grade.reasons.join(" "), /1 test\(s\) failed/);
});

test("ADVERSARIAL: a suite-level TearDown failure with every case passing is tier 2 (G3)", () => {
  // The most laundering-prone shape in NUnit output. Every test-case says Passed, so a
  // case-walk-only reader calls this green; the fixture's TearDown actually threw and the
  // suite carries the failure. The union rule is what catches it.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Failed" site="TearDown">' +
        "<failure><message>OneTimeTearDown threw NullReferenceException</message></failure>" +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        '<test-case id="3" name="b" fullname="N.F.b" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Failed" total="2" passed="2" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.match(grade.reasons.join(" "), /suite-level failure with a clean test-case walk/);
  assert.match(grade.reasons.join(" "), /A\.dll/);
});

test("ADVERSARIAL: a run-level Cancelled is tier 2 even when every case passed", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Cancelled" total="1" passed="1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /Cancelled/);
});

test("ADVERSARIAL: nested suites whose attributes disagree do not outvote the case walk", () => {
  // Outer suites claim Passed; a case three levels down failed. The case walk wins and the
  // result is a defect (tier 1), not the cheerful roll-up's green.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed" total="2" passed="2" failed="0">' +
        '<test-suite type="TestSuite" id="2" name="N" result="Passed">' +
        '<test-suite type="TestFixture" id="3" name="F" result="Passed">' +
        '<test-case id="4" name="a" fullname="N.F.a" result="Passed" />' +
        '<test-case id="5" name="b" fullname="N.F.b" result="Failed" label="Error">' +
        "<failure><message>expected 3 but was 4</message></failure></test-case>" +
        "</test-suite></test-suite></test-suite>",
      'id="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 1, `reasons: ${grade.reasons.join(" | ")}`);
  assert.equal(grade.failures[0].fullname, "N.F.b");
});

test("ADVERSARIAL: a roll-up claiming failures the document no longer contains is tier 2", () => {
  // The stripped-cases forgery: delete the failing <test-case> elements and the walk is
  // clean, but the run attributes still remember them.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Failed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Failed" total="3" passed="1" failed="2" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /cases are missing from the document/);
});

test("ADVERSARIAL: total 0 is tier 2 (a run that checked nothing is not a pass)", () => {
  const run = parseOk(
    wrapRun("", 'id="2" result="Passed" total="0" passed="0" failed="0" inconclusive="0" skipped="0"'),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /zero test cases/);
});

test("ADVERSARIAL: an all-skipped run is tier 2 (checked-nothing precedent)", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Skipped">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Skipped" label="Ignored" />' +
        '<test-case id="3" name="b" fullname="N.F.b" result="Skipped" label="Ignored" />' +
        "</test-suite>",
      'id="2" result="Skipped" total="2" passed="0" failed="0" inconclusive="0" skipped="2"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /every one of the 2 test case\(s\) was skipped/);
});

test("ADVERSARIAL: a skipped or ignored SUITE is tier 2 even when the rest of the run is green (G13)", () => {
  // An [Ignore] on the fixture class removes a whole area from the suite. Individually
  // skipped cases stay a named subset; a whole fixture opting out does not.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-suite type="TestFixture" id="2" name="IgnoredFixture" result="Skipped" runstate="Ignored" />' +
        '<test-case id="3" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Passed" total="1" passed="1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.match(grade.reasons.join(" "), /skipped or ignored suite\(s\).*IgnoredFixture/s);
});

test("a skipped CASE subset stays tier 0 and is NAMED in the notes, never hidden", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        '<test-case id="3" name="b" fullname="N.F.b" result="Skipped" label="Ignored" />' +
        "</test-suite>",
      'id="2" result="Passed" total="2" passed="1" failed="0" inconclusive="0" skipped="1"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 0);
  assert.match(grade.notes.join(" "), /1 skipped case\(s\): N\.F\.b/);
});

test("a Failed case labelled Invalid is tier 2, and an Inconclusive case is tier 2", () => {
  const invalid = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Failed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Failed" label="Invalid" />' +
        "</test-suite>",
      'id="2" result="Failed" total="1" passed="0" failed="1" inconclusive="0" skipped="0"',
    ),
  );
  const invalidGrade = gradeTestResults({ run: invalid, strict: false });
  assert.equal(invalidGrade.tier, 2);
  assert.match(invalidGrade.reasons.join(" "), /label Invalid/);

  const inconclusive = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Inconclusive">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Inconclusive" />' +
        "</test-suite>",
      'id="2" result="Inconclusive" total="1" passed="0" failed="0" inconclusive="1" skipped="0"',
    ),
  );
  const inconclusiveGrade = gradeTestResults({ run: inconclusive, strict: false });
  assert.equal(inconclusiveGrade.tier, 2);
  assert.match(inconclusiveGrade.reasons.join(" "), /inconclusive case/);
});

test("a Warning is a note by default and a defect under --strict", () => {
  const xml = wrapRun(
    '<test-suite type="Assembly" id="1" name="A.dll" result="Warning">' +
      '<test-case id="2" name="a" fullname="N.F.a" result="Warning" />' +
      '<test-case id="3" name="b" fullname="N.F.b" result="Passed" />' +
      "</test-suite>",
    'id="2" result="Warning" total="2" passed="1" failed="0" inconclusive="0" skipped="0" warnings="1"',
  );
  const lenient = gradeTestResults({ run: parseOk(xml), strict: false });
  assert.equal(lenient.tier, 0);
  assert.match(lenient.notes.join(" "), /not gating without --strict/);

  const strict = gradeTestResults({ run: parseOk(xml), strict: true });
  assert.equal(strict.tier, 1);
  assert.match(strict.reasons.join(" "), /warning case\(s\) under --strict/);
});

test("compile errors, a mutated project, and an unexplained exit code each refuse (G4)", () => {
  const xml = wrapRun(
    '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
      '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
      "</test-suite>",
  );
  const run = parseOk(xml);
  assert.equal(gradeTestResults({ run, strict: false, compileErrors: 3 }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, mutatedProject: true }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, exitCode: 3 }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, exitCode: 0 }).tier, 0);

  // Unity's exit-code table: 2 means "tests failed". With failures in the walk that is
  // accounted for; without them it is a document that lost its failing cases.
  assert.equal(exitCodeIsUnexplained(2, 4), false);
  assert.equal(exitCodeIsUnexplained(2, 0), true);
  assert.equal(exitCodeIsUnexplained(0, 0), false);
  assert.equal(exitCodeIsUnexplained(1, 4), true);
});

test("a manifest summary that disagrees with the graded walk refuses (G12)", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
    ),
  );
  const honest = gradeTestResults({
    run,
    strict: false,
    manifestSummary: { total: 1, passed: 1, failed: 0, inconclusive: 0, skipped: 0 },
  });
  assert.equal(honest.tier, 0);

  const laundered = gradeTestResults({
    run,
    strict: false,
    manifestSummary: { total: 9, passed: 9, failed: 0, inconclusive: 0, skipped: 0 },
  });
  assert.equal(laundered.tier, 2);
  assert.match(laundered.reasons.join(" "), /manifest summary disagrees.*total 9 vs 1/s);

  assert.deepEqual(
    summaryDisagreements(
      { total: 1, passed: 1, failed: 0, inconclusive: 0, skipped: 0 },
      { total: 1, passed: 0, failed: 1, inconclusive: 0, skipped: 0 },
    ),
    ["passed 1 vs 0", "failed 0 vs 1"],
  );
});

test("an assembly stamped in the manifest but absent from the XML refuses (G4)", () => {
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
    ),
  );
  const grade = gradeTestResults({ run, strict: false, manifestAssemblies: ["A.dll", "B.dll"] });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /stamped but absent from the XML: B\.dll/);

  const extra = gradeTestResults({ run, strict: false, manifestAssemblies: [] });
  assert.equal(extra.tier, 2);
  assert.match(extra.reasons.join(" "), /in the XML but not stamped: A\.dll/);
});

/* -------------------------------------------------------------------------- */
/* FXA: a result word the mapping does not understand                         */
/* -------------------------------------------------------------------------- */

/**
 * THE F1 DOCUMENT, verbatim in shape.
 *
 * Two cases that no bucket in `deriveSummary` can hold: `result="Broken"` (a word NUnit never
 * writes, carrying a real failure message) and `result="passed"` (the right word in the wrong
 * case). Before FXA both were counted in `total` and graded by nothing at all, so this
 * document read as `4 test(s): 2 passed, 0 failed` and graded TIER 0: a failing case erased
 * by a typo, which is the cheapest false green in the whole gate.
 */
const UNKNOWN_RESULT_XML = wrapRun(
  '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
    '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
    '<test-case id="3" name="b" fullname="N.F.b" result="Broken">' +
    "<failure><message>NullReferenceException in the subject under test</message></failure>" +
    "</test-case>" +
    '<test-case id="4" name="c" fullname="N.F.c" result="passed" />' +
    '<test-case id="5" name="d" fullname="N.F.d" result="Passed" />' +
    "</test-suite>",
  'id="2" result="Passed" total="4" passed="4" failed="0" inconclusive="0" skipped="0"',
);

test("FXA: a case result outside NUnit's vocabulary is tier 2, and the case and value are NAMED", () => {
  const run = parseOk(UNKNOWN_RESULT_XML);
  // Non-vacuity: the parser really did keep all four cases, so the refusal below is about the
  // MAPPING and not about a document that failed to parse.
  assert.equal(run.cases.length, 4);

  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  const reasons = grade.reasons.join(" ");
  assert.match(reasons, /outside NUnit's vocabulary/);
  assert.match(reasons, /N\.F\.b result='Broken'/, "the refusal names the case AND the value it carried");
  assert.match(reasons, /N\.F\.c result='passed'/, "the vocabulary is case-sensitive: 'passed' is not 'Passed'");
});

test("FXA: bucket accounting refuses a walked total the five buckets cannot account for", () => {
  const run = parseOk(UNKNOWN_RESULT_XML);
  const grade = gradeTestResults({ run, strict: false });
  assert.match(
    grade.reasons.join(" "),
    /bucket accounting disagrees with the walk: 4 case\(s\) walked but 2 landed in a bucket/,
    "the second, independent rule: total and the buckets must add up",
  );

  // …and it does NOT fire on an honest document, including the one shape where the buckets
  // and `total` legitimately differ in NUnit's own counting: a Warning case.
  const warning = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Warning">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Warning" />' +
        '<test-case id="3" name="b" fullname="N.F.b" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Warning" total="2" passed="1" failed="0" inconclusive="0" skipped="0" warnings="1"',
    ),
  );
  const warningGrade = gradeTestResults({ run: warning, strict: false });
  assert.equal(warningGrade.tier, 0, `a Warning case must stay accountable: ${warningGrade.reasons.join(" | ")}`);
  assert.ok(!warningGrade.reasons.join(" ").includes("bucket accounting"));
});

test("FXI: a <test-run> with NO result attribute and a clean walk is tier 2, never a pass", () => {
  // The missing fixture. `run.result` is the empty string here, and the union rule (G3) must
  // read that as "this document declares no run-level verdict" and refuse. An `if (run.result
  // && ...)` guard would SKIP the comparison for exactly this input, which is CLAUDE.md's
  // falsy-skip anti-pattern: the one document shape with no roll-up to disagree with would be
  // the one shape that never gets checked.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" total="1" passed="1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  assert.equal(run.result, "", "the fixture really does carry no run-level result attribute");

  const grade = gradeTestResults({ run, strict: false });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.match(grade.reasons.join(" "), /test-run result is '\(absent\)'/);
});

test("a tier-2 run still LISTS its real failures; the reclassification hides nothing", () => {
  // Precedence check: tier 2 wins over tier 1 (a run that did not check what it claims is
  // not a game defect), but the defects it did find must remain visible in the output.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Failed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Failed" label="Error" />' +
        "</test-suite>",
      'id="2" result="Failed" total="1" passed="0" failed="1" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false, compileErrors: 7, exitCode: 2 });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /compile error line/);
  assert.match(grade.reasons.join(" "), /1 test\(s\) failed: N\.F\.a/);
  assert.equal(grade.failures.length, 1);
});
