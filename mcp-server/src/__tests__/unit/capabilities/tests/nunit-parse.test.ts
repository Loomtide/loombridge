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
  declaredSurfaceCrossCheck,
  deriveSummary,
  exitCodeIsUnexplained,
  gradeTestResults,
  isNUnitParseError,
  parseNUnitResults,
  rollupCrossCheck,
  summaryDisagreements,
  type DeclaredTestSurface,
  type NUnitRun,
  type TestsAttribution,
  type TestsProducerFacts,
} from "../../../../capabilities/tests/nunit-parse.js";

const FIXTURE = path.join(REPO_ROOT, "mcp-server/src/__tests__/fixtures/nunit/editmode-run.xml");

/**
 * H3: a bare XML nobody stamped, stated EXPLICITLY.
 *
 * Every one of these call sites used to pass no producer facts at all, and that omission was
 * indistinguishable from a caller that HAD facts and forgot them. It is now the named opt-in,
 * so the tests below are testing the document, and the attribution is never accidental.
 */
const BARE: TestsAttribution = { kind: "unattributed", why: "a synthetic document, nobody stamped it" };

/**
 * H4: no project surface, stated EXPLICITLY, for the same reason `BARE` is.
 *
 * The tests below are about the DOCUMENT and its mapping, so they hand the grader the honest
 * answer for a synthetic string with no project behind it. The surface check's own behaviour
 * (which is what closes the forged-pair exploit) is exercised in its own section at the foot of
 * this file, and end to end in `tests-grade-cli.test.ts` and `unified-tests-section.test.ts`.
 */
const NO_SURFACE: DeclaredTestSurface = {
  kind: "unknown",
  why: "a synthetic document with no project behind it",
};

/** Producer facts for a run this process is pretending to have spawned. */
function producer(facts: Partial<TestsProducerFacts> = {}): TestsAttribution {
  return { kind: "producer", exitCode: 0, compileErrors: 0, mutatedProject: false, ...facts };
}

/**
 * A verified stamped manifest. The `stamped` shape owes ALL FIVE facts, so this helper takes
 * overrides for the two under test and supplies honest values for the rest: a test that varies
 * the summary must not accidentally also be testing an unexplained exit code.
 */
function stamped(overrides: {
  manifestSummary?: { total: number; passed: number; failed: number; inconclusive: number; skipped: number };
  manifestAssemblies?: readonly string[];
  exitCode?: number;
  compileErrors?: number;
  mutatedProject?: boolean;
}): TestsAttribution {
  return {
    kind: "stamped",
    exitCode: 0,
    compileErrors: 0,
    mutatedProject: false,
    manifestSummary: { total: 1, passed: 1, failed: 0, inconclusive: 0, skipped: 0 },
    manifestAssemblies: ["A.dll"],
    ...overrides,
  };
}

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
  // subset, so the union rule (G3) has something true to agree with. Real Unity output
  // declares five of the six counts and NO `warnings`, which is why only declared keys are
  // compared: a rule that read an absent count as zero would be reading a fact this writer
  // never stated.
  //
  // F4: `testcasecount` is READ, and this is the evidence real Unity writes it. It is NOT in
  // `ROLLUP_COUNT_KEYS`, because it counts DISCOVERED cases rather than walked results, so it
  // can only ever be a note; before this it was read by nothing at all, and a document
  // declaring `testcasecount="500"` over one walked case printed "this green is quotable".
  assert.deepEqual(run.rollup, {
    declared: { total: 5, passed: 3, failed: 1, inconclusive: 0, skipped: 1 },
    malformed: [],
    testCaseCount: 5,
  });
  assert.equal("warnings" in run.rollup.declared, false, "real Unity output omits `warnings` entirely");

  // H2: EVERY suite in the real document declares its own roll-up, and every one of them
  // agrees with the cases beneath it. This is the false-failure guard for the suite-level
  // cross-check: it runs against REAL Unity bytes, not against a document written to pass it.
  for (const suite of run.suites) {
    assert.deepEqual(
      rollupCrossCheck(`suite '${suite.name}'`, suite.rollup, suite.walked),
      { refusals: [], notes: [] },
      `real Unity output must not trip the suite cross-check (suite '${suite.name}')`,
    );
  }
  // Non-vacuity: the suites really did declare counts, and the walk really did attribute
  // cases to them, so the loop above compared something.
  const assembly = run.suites.find((s) => s.name === "com.loomtide.loombridge.tests.dll");
  assert.deepEqual(assembly?.rollup.declared, { total: 4, passed: 2, failed: 1, inconclusive: 0, skipped: 1 });
  assert.deepEqual(assembly?.walked, { total: 4, passed: 2, failed: 1, inconclusive: 0, skipped: 1, warnings: 0 });

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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 0);
  assert.deepEqual(grade.reasons, []);
});

test("the realistic fixture (a real red) is tier 1, not a harness fault", () => {
  const run = parseOk(fs.readFileSync(FIXTURE, "utf-8"));
  // Unity exits 2 when tests failed; the walk accounts for that, so it is not "unexplained".
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ exitCode: 2 }) });
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /Cancelled/);
});

test("ADVERSARIAL: nested suites whose attributes disagree never outvote the case walk", () => {
  // Outer suites claim Passed and `passed="2" failed="0"`; a case three levels down failed.
  //
  // THIS ASSERTION MOVED WITH H2, and the move is the point. It used to read tier 1: the
  // walk won, so the failure was reported as a game defect and the lying roll-up cost the
  // document nothing. Now the contradiction is itself a refusal, which is what this module's
  // own docstring has always promised ("any DISAGREEMENT between them is itself a refusal").
  // Tier 2 is the honest word for a document that cannot be read as a verdict, and the
  // failure it does contain is still named, so nothing is hidden by the reclassification.
  //
  // A REAL red does NOT land here: the realistic-fixture test above grades tier 1 with real
  // Unity bytes, where every suite roll-up agrees with its own cases.
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.equal(grade.failures[0].fullname, "N.F.b", "the failure it DOES contain is still named");
  const reasons = grade.reasons.join(" | ");
  assert.match(reasons, /suite 'A\.dll' declares failed="0" but the walk beneath it found 1/);
  assert.match(reasons, /<test-run> declares failed="0" but the walk beneath it found 1/);
  assert.match(reasons, /1 test\(s\) failed: N\.F\.b/);
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /cases are missing from the document/);
});

test("ADVERSARIAL: total 0 is tier 2 (a run that checked nothing is not a pass)", () => {
  const run = parseOk(
    wrapRun("", 'id="2" result="Passed" total="0" passed="0" failed="0" inconclusive="0" skipped="0"'),
  );
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const invalidGrade = gradeTestResults({ run: invalid, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const inconclusiveGrade = gradeTestResults({ run: inconclusive, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const lenient = gradeTestResults({ run: parseOk(xml), strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(lenient.tier, 0);
  assert.match(lenient.notes.join(" "), /not gating without --strict/);

  const strict = gradeTestResults({ run: parseOk(xml), strict: true, surface: NO_SURFACE, attribution: BARE });
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
  assert.equal(gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ compileErrors: 3 }) }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ mutatedProject: true }) }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ exitCode: 3 }) }).tier, 2);
  assert.equal(gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ exitCode: 0 }) }).tier, 0);

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
    surface: NO_SURFACE,
    attribution: stamped({ manifestSummary: { total: 1, passed: 1, failed: 0, inconclusive: 0, skipped: 0 } }),
  });
  assert.equal(honest.tier, 0);

  const laundered = gradeTestResults({
    run,
    strict: false,
    surface: NO_SURFACE,
    attribution: stamped({ manifestSummary: { total: 9, passed: 9, failed: 0, inconclusive: 0, skipped: 0 } }),
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: stamped({ manifestAssemblies: ["A.dll", "B.dll"] }) });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /stamped but absent from the XML: B\.dll/);

  const extra = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: stamped({ manifestAssemblies: [] }) });
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

  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  const reasons = grade.reasons.join(" ");
  assert.match(reasons, /outside NUnit's vocabulary/);
  assert.match(reasons, /N\.F\.b result='Broken'/, "the refusal names the case AND the value it carried");
  assert.match(reasons, /N\.F\.c result='passed'/, "the vocabulary is case-sensitive: 'passed' is not 'Passed'");
});

test("FXA: bucket accounting refuses a walked total the five buckets cannot account for", () => {
  const run = parseOk(UNKNOWN_RESULT_XML);
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
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
  const warningGrade = gradeTestResults({ run: warning, strict: false, surface: NO_SURFACE, attribution: BARE });
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

  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.match(grade.reasons.join(" "), /test-run result is '\(absent\)'/);
});

/* -------------------------------------------------------------------------- */
/* H2: the roll-up cross-check                                                */
/* -------------------------------------------------------------------------- */

test("H2: an absent count is not a claim of zero, and a declared one is compared both ways", () => {
  const walked = { total: 3, passed: 2, failed: 1, inconclusive: 0, skipped: 0, warnings: 0 };

  // Nothing declared: nothing to disagree with. This is the older-writer case, and it must
  // stay silent, or every NUnit writer that omits an attribute goes red.
  assert.deepEqual(rollupCrossCheck("<test-run>", { declared: {}, malformed: [] }, walked), {
    refusals: [],
    notes: [],
  });

  // Declared and honest: silent.
  assert.deepEqual(
    rollupCrossCheck("<test-run>", { declared: { total: 3, passed: 2, failed: 1 }, malformed: [] }, walked),
    { refusals: [], notes: [] },
  );

  // Over-claiming `total` is the hiding direction: cases were removed, the summary was not.
  assert.match(
    rollupCrossCheck("<test-run>", { declared: { total: 9 }, malformed: [] }, walked).refusals.join(" "),
    /declares total="9" but only 3 test case\(s\) are present/,
  );

  // UNDER-claiming `total` is the one direction with a documented writer convention (a
  // Warning case lands in `total` and in no other bucket), and it hides nothing, so it is a
  // NOTE. Making it a refusal is how this rule would red out a legitimate writer.
  const under = rollupCrossCheck("<test-run>", { declared: { total: 2 }, malformed: [] }, walked);
  assert.deepEqual(under.refusals, []);
  assert.match(under.notes.join(" "), /declares total="2" over 3 walked case\(s\)/);

  // The five per-result counts have no such hazard: each is a count of one NUnit result word,
  // and the walk counts it the same way. Both directions refuse.
  for (const [declared, direction] of [
    [{ failed: 4 }, "claiming failures the document no longer contains"],
    [{ failed: 0 }, "claiming fewer failures than the document contains"],
    [{ passed: 99 }, "claiming passes the document no longer contains"],
    [{ skipped: 1 }, "claiming a skip that is not there"],
    [{ warnings: 2 }, "claiming warnings that are not there"],
  ] as const) {
    assert.equal(
      rollupCrossCheck("<test-run>", { declared, malformed: [] }, walked).refusals.length,
      1,
      `${direction} must be a refusal`,
    );
  }
});

test("H2: a count that is not a whole number is MALFORMED, never coerced to zero", () => {
  // `Number.parseInt("lots")` is NaN and the old reader answered 0 for it, so a roll-up of
  // unreadable values agreed with an empty walk. "Unreadable" and "zero" are different facts.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" result="Passed" total="lots" passed="-1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  assert.deepEqual(run.rollup.malformed, ["total", "passed"]);
  assert.equal("total" in run.rollup.declared, false, "an unreadable count is not a declared count");

  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  assert.match(grade.reasons.join(" "), /declares total, passed as something other than a whole number/);
});

test("H2: a SUITE roll-up is held against its own subtree, so hiding a case costs every ancestor", () => {
  // The shrinking attack applied to this wave's own mechanism: delete the `<test-run>`
  // roll-up entirely and there is nothing left at the run level to disagree with. Each
  // enclosing suite still counts its own subtree, so the failing case it lost still names it.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed" total="2" passed="1" failed="1">' +
        '<test-suite type="TestFixture" id="2" name="F" result="Passed" total="2" passed="1" failed="1">' +
        '<test-case id="3" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite></test-suite>",
      // No counts at all on `<test-run>`: the run-level cross-check has nothing to say.
      'id="2" result="Passed"',
    ),
  );
  assert.deepEqual(run.rollup.declared, {}, "the run-level roll-up really was deleted");

  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.equal(grade.tier, 2, `reasons: ${grade.reasons.join(" | ")}`);
  const reasons = grade.reasons.join(" | ");
  assert.match(reasons, /suite 'A\.dll' declares total="2" but only 1 test case\(s\) are present/);
  assert.match(reasons, /suite 'F' declares failed="1" but the walk beneath it found 0/);
});

test("H2: a suite's walk is its OWN subtree, not its siblings' (the accumulator is scoped)", () => {
  // If the open-suite stack were not popped on close, a fixture would keep collecting the
  // cases of every later sibling and its honest roll-up would start disagreeing. That is a
  // false-failure bug, and it would have looked exactly like a caught forgery.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed" total="2" passed="2">' +
        '<test-suite type="TestFixture" id="2" name="First" result="Passed" total="1" passed="1">' +
        '<test-case id="3" name="a" fullname="N.First.a" result="Passed" />' +
        "</test-suite>" +
        '<test-suite type="TestFixture" id="4" name="Second" result="Passed" total="1" passed="1">' +
        '<test-case id="5" name="b" fullname="N.Second.b" result="Passed" />' +
        "</test-suite>" +
        "</test-suite>",
      'id="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const first = run.suites.find((s) => s.name === "First");
  const second = run.suites.find((s) => s.name === "Second");
  assert.equal(first?.walked.total, 1, "the first fixture must not have absorbed its sibling's case");
  assert.equal(second?.walked.total, 1);
  assert.equal(run.suites.find((s) => s.name === "A.dll")?.walked.total, 2, "…while the parent sees both");

  assert.equal(gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE }).tier, 0);
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
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: producer({ compileErrors: 7, exitCode: 2 }) });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /compile error line/);
  assert.match(grade.reasons.join(" "), /1 test\(s\) failed: N\.F\.a/);
  assert.equal(grade.failures.length, 1);
});

/* -------------------------------------------------------------------------- */
/* H4: the declared test surface, the one fact from OUTSIDE the pair           */
/* -------------------------------------------------------------------------- */

const DECLARED: DeclaredTestSurface = {
  kind: "declared",
  assemblies: ["Game.Tests"],
  complete: true,
  how: "1 assembly name(s) from 1 Test-Runner asmdef(s) under Assets/",
};

/** A green document naming `assembly`, or naming none when it is null. */
function greenNaming(assembly: string | null): NUnitRun {
  const inner =
    assembly === null
      ? '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />'
      : `<test-suite type="Assembly" id="1" name="${assembly}" result="Passed">` +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>";
  return parseOk(wrapRun(inner));
}

test("H4: a green naming an assembly the project does NOT declare is tier 2, not a pass", () => {
  // THE EXPLOIT THIS CLOSES. Every other binding on this document reads bytes the forger
  // wrote, so a self-consistent forged pair satisfied all of them at once. The project's own
  // asmdefs are written by the game.
  const grade = gradeTestResults({
    run: greenNaming("Totally.Made.Up.dll"),
    strict: false,
    surface: DECLARED,
    attribution: BARE,
  });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /none of the 1 assembly\(ies\) in the results is one this project declares/);
  assert.match(grade.reasons.join(" "), /these results are not about this project/);
});

test("H4: DELETING the assembly suites is refused, or it would be the cheapest evasion of all", () => {
  // The screens and feel waves both closed "delete the denominator". Without this the whole
  // check is disarmed by removing one element, and `manifest.assemblies` agrees anyway,
  // because the producer derives that list from the same parse.
  const grade = gradeTestResults({ run: greenNaming(null), strict: false, surface: DECLARED, attribution: BARE });
  assert.equal(grade.tier, 2);
  assert.match(grade.reasons.join(" "), /declare no assembly suite at all/);
});

test("FALSE-FAILURE: a green naming a DECLARED assembly is tier 0 with no refusal", () => {
  const grade = gradeTestResults({
    run: greenNaming("Game.Tests.dll"),
    strict: false,
    surface: DECLARED,
    attribution: BARE,
  });
  assert.equal(grade.tier, 0, grade.reasons.join(" | "));
  assert.deepEqual(grade.reasons, []);
});

test("FALSE-FAILURE: `none` and `unknown` surfaces NOTE the gap and never refuse", () => {
  // A project with no declared test surface, and a bare CI XML with no project at all, are
  // both supported inputs. Refusing them would turn the GameCI workflow and every
  // predefined-assembly project red, which is how a moat fix gets relaxed.
  for (const surface of [
    { kind: "none", why: "no Test-Runner asmdef" },
    { kind: "unknown", why: "no project was read" },
  ] as DeclaredTestSurface[]) {
    const grade = gradeTestResults({ run: greenNaming("Anything.dll"), strict: false, surface, attribution: BARE });
    assert.equal(grade.tier, 0, `${surface.kind}: ${grade.reasons.join(" | ")}`);
    assert.match(grade.notes.join(" "), /bound to nothing outside these results/);
  }
});

test("H4: an INCOMPLETE surface degrades the disjointness refusal to a note", () => {
  // A registry testable this checkout cannot resolve may be exactly where the named
  // assemblies live, so disjointness proves nothing there.
  const incomplete: DeclaredTestSurface = { ...DECLARED, complete: false, how: "1 testable(s) unresolved: com.x" };
  const grade = gradeTestResults({
    run: greenNaming("Totally.Made.Up.dll"),
    strict: false,
    surface: incomplete,
    attribution: BARE,
  });
  assert.equal(grade.tier, 0, grade.reasons.join(" | "));
  assert.match(grade.notes.join(" "), /declared surface is INCOMPLETE/);
});

test("H4: a DECLARED assembly absent from the walk is a NOTE, deliberately, and it is NAMED", () => {
  // The direction that would catch a whole failing assembly being hidden is also the direction
  // with real false-failure surface: a platform-excluded or test-free asmdef is a legitimate
  // absence. It is reported rather than gating, and the note says which reading is which.
  const surface: DeclaredTestSurface = { ...DECLARED, assemblies: ["Game.Tests", "Game.More.Tests"] };
  const grade = gradeTestResults({ run: greenNaming("Game.Tests.dll"), strict: false, surface, attribution: BARE });
  assert.equal(grade.tier, 0, grade.reasons.join(" | "));
  assert.match(grade.notes.join(" "), /contributed nothing to this run: Game\.More\.Tests/);
});

test("H4: the comparison strips `.dll` and ignores case, so an honest run is never red for spelling", () => {
  const check = declaredSurfaceCrossCheck(
    { kind: "declared", assemblies: ["Game.Tests"], complete: true, how: "x" },
    ["GAME.TESTS.DLL"],
  );
  assert.deepEqual(check.refusals, []);
});

/* -------------------------------------------------------------------------- */
/* F4: testcasecount is READ, and it is a note                                 */
/* -------------------------------------------------------------------------- */

test("F4: a document declaring testcasecount over the walked total is NOTED, never silent", () => {
  // Real Unity writes `testcasecount` on `<test-run>` and on every `<test-suite>`. It was in
  // no closed set and read by nothing, so `testcasecount="500"` over one walked case printed
  // "this green is quotable" with nothing said about the other 499.
  const run = parseOk(
    wrapRun(
      '<test-suite type="Assembly" id="1" name="A.dll" result="Passed">' +
        '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />' +
        "</test-suite>",
      'id="2" testcasecount="500" result="Passed" total="1" passed="1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  // NOT a refusal, on purpose: a filtered or platform-excluded run legitimately discovers more
  // cases than it executes, and a gate that reds those out is a gate that gets relaxed.
  assert.equal(grade.tier, 0, grade.reasons.join(" | "));
  assert.match(grade.notes.join(" "), /declares testcasecount="500" over 1 walked case\(s\)/);
});

test("F4: an HONEST testcasecount says nothing at all", () => {
  const run = parseOk(
    wrapRun(
      '<test-case id="2" name="a" fullname="N.F.a" result="Passed" />',
      'id="2" testcasecount="1" result="Passed" total="1" passed="1" failed="0" inconclusive="0" skipped="0"',
    ),
  );
  const grade = gradeTestResults({ run, strict: false, surface: NO_SURFACE, attribution: BARE });
  assert.ok(!grade.notes.join(" ").includes("testcasecount"), grade.notes.join(" | "));
});
