/**
 * The minimal NUnit3 result reader and the tier mapping (plan T6, amendments G3/G12/G13).
 *
 * Unity's Test Runner writes an NUnit3 XML result file. This module reads it and decides
 * what it MEANS, with two hard constraints:
 *
 *  - PURE. No filesystem, no process, no Unity. A caller hands it a string; it hands back
 *    either a parsed run or a typed error. It never throws, because both callers (the
 *    producer `tests run` and the offline grader) enumerate assets and must be able to
 *    mark ONE result broken and carry on.
 *  - HAND-ROLLED and small. No new dependency for a document shape this narrow. The
 *    scanner is a real scanner rather than a regex over `<[^>]*>`, because NUnit failure
 *    messages routinely contain `>` inside attribute values and CDATA sections, and a
 *    regex that mis-splits there silently drops test cases: the exact shape of a false
 *    green this gate exists to prevent.
 *
 * WHY THE WALK IS AUTHORITATIVE (G3). The `<test-run>` element carries a roll-up
 * (`result`, `total`, `passed`, `failed`, ...) and every enclosing `<test-suite>` carries
 * its own. Those are convenient and forgeable: a hand-edited file can say `result="Passed"`
 * while still containing failing cases, or claim failures it no longer contains. So the
 * verdict is the UNION of the two readings, and any DISAGREEMENT between them is itself a
 * refusal, never a tie broken in favour of the cheerful side.
 */

/* -------------------------------------------------------------------------- */
/* XML scanning                                                               */
/* -------------------------------------------------------------------------- */

/** A parse refusal. Returned, never thrown. */
export interface NUnitParseError {
  error: string;
}

export function isNUnitParseError<T extends object>(value: T | NUnitParseError): value is NUnitParseError {
  return "error" in value;
}

type XmlEvent =
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/**
 * Decode the five XML predefined entities plus numeric character references.
 *
 * Single pass on purpose: `&amp;lt;` must decode to the literal text `&lt;`, not to `<`.
 * A second pass would "helpfully" turn an escaped escape into markup, which is how an
 * assertion message quoting XML turns into a mangled test name.
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return whole;
    }
  });
}

const NAME_END = /[\s/>]/;
const ATTR_NAME_END = /[\s=/>]/;

/** Parse one start tag beginning at `<`. Returns the event and the index just past the tag. */
function parseStartTag(src: string, start: number): { event: XmlEvent; next: number } | NUnitParseError {
  const len = src.length;
  let i = start + 1;
  const nameStart = i;
  while (i < len && !NAME_END.test(src[i])) i += 1;
  if (i >= len) return { error: "truncated XML: unterminated start tag" };
  const name = src.slice(nameStart, i);
  if (name.length === 0) return { error: "malformed XML: start tag with no element name" };

  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < len && /\s/.test(src[i])) i += 1;
    if (i >= len) return { error: `truncated XML: unterminated <${name}> tag` };
    if (src[i] === ">") {
      return { event: { kind: "open", name, attrs, selfClosing: false }, next: i + 1 };
    }
    if (src[i] === "/") {
      if (src[i + 1] !== ">") return { error: `malformed XML: '/' not followed by '>' in <${name}>` };
      return { event: { kind: "open", name, attrs, selfClosing: true }, next: i + 2 };
    }
    const attrStart = i;
    while (i < len && !ATTR_NAME_END.test(src[i])) i += 1;
    if (i >= len) return { error: `truncated XML: unterminated <${name}> tag` };
    const attrName = src.slice(attrStart, i);
    if (attrName.length === 0) return { error: `malformed XML: unexpected '${src[i]}' in <${name}>` };
    while (i < len && /\s/.test(src[i])) i += 1;
    if (src[i] !== "=") {
      // A valueless attribute is not legal XML, but treating it as empty keeps a
      // slightly-off file readable instead of failing the whole run for a cosmetic reason.
      attrs[attrName] = "";
      continue;
    }
    i += 1;
    while (i < len && /\s/.test(src[i])) i += 1;
    const quote = src[i];
    if (quote !== '"' && quote !== "'") {
      return { error: `malformed XML: unquoted value for attribute '${attrName}' in <${name}>` };
    }
    const valueEnd = src.indexOf(quote, i + 1);
    if (valueEnd < 0) return { error: `truncated XML: unterminated value for attribute '${attrName}'` };
    attrs[attrName] = decodeXmlEntities(src.slice(i + 1, valueEnd));
    i = valueEnd + 1;
  }
}

/**
 * Tokenize an XML document into open/close/text events.
 *
 * Truncation is detected HERE and reported as an error rather than yielding a partial
 * document: a run whose XML was cut off mid-write (killed editor, full disk) must grade
 * as unreadable, never as "the cases I happened to see all passed".
 */
export function scanXml(src: string): { events: XmlEvent[] } | NUnitParseError {
  const events: XmlEvent[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      events.push({ kind: "text", text: decodeXmlEntities(src.slice(i)) });
      break;
    }
    if (lt > i) events.push({ kind: "text", text: decodeXmlEntities(src.slice(i, lt)) });

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) return { error: "truncated XML: unterminated comment" };
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) return { error: "truncated XML: unterminated CDATA section" };
      // CDATA is literal by definition: entities inside it are NOT decoded.
      events.push({ kind: "text", text: src.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) return { error: "truncated XML: unterminated processing instruction" };
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) return { error: "truncated XML: unterminated declaration" };
      i = end + 1;
      continue;
    }
    if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) return { error: "truncated XML: unterminated end tag" };
      events.push({ kind: "close", name: src.slice(lt + 2, end).trim() });
      i = end + 1;
      continue;
    }
    const tag = parseStartTag(src, lt);
    if (isNUnitParseError(tag)) return tag;
    events.push(tag.event);
    i = tag.next;
  }
  return { events };
}

/* -------------------------------------------------------------------------- */
/* The NUnit3 shape                                                           */
/* -------------------------------------------------------------------------- */

/** One `<test-case>`: the authoritative unit of "did a check run and what did it say". */
export interface NUnitCase {
  id?: string;
  name: string;
  fullname: string;
  classname?: string;
  /** "Passed" | "Failed" | "Skipped" | "Inconclusive" | "Warning" (NUnit's vocabulary). */
  result: string;
  /** Qualifier on a non-Passed result: "Error", "Invalid", "Cancelled", "Ignored", ... */
  label?: string;
  /** Where the result came from: "SetUp", "TearDown", "Child", "Parent". */
  site?: string;
  /** `<failure><message>` or `<reason><message>` text, undecorated. Callers cap it. */
  message?: string;
}

/** One `<test-suite>`: an assembly, a namespace, or a fixture. */
export interface NUnitSuite {
  /** "Assembly" | "TestSuite" | "TestFixture" | "ParameterizedMethod" ... */
  type?: string;
  id?: string;
  name: string;
  fullname: string;
  result: string;
  label?: string;
  site?: string;
  /** "Runnable" | "Ignored" | "Explicit" | "NotRunnable". */
  runstate?: string;
  message?: string;
}

/** The `<test-run>` roll-up, when the document declares one. Advisory: the walk decides. */
export interface NUnitRunAttrSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  skipped: number;
  warnings: number;
}

export interface NUnitRun {
  /** Raw `<test-run>` attributes, for anything a caller wants that is not modelled. */
  attrs: Record<string, string>;
  /** `<test-run result>`; "" when the document did not declare one. */
  result: string;
  /** The declared roll-up, or `null` when `<test-run>` carried no `total`. */
  runAttrSummary: NUnitRunAttrSummary | null;
  suites: NUnitSuite[];
  cases: NUnitCase[];
  /** Assembly-level suite names, sorted and deduped (the manifest binds against these). */
  assemblies: string[];
}

function intAttr(attrs: Record<string, string>, key: string): number {
  const raw = attrs[key];
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optAttr(attrs: Record<string, string>, key: string): string | undefined {
  const raw = attrs[key];
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/** A node currently open on the element stack that can own a `<failure>`/`<reason>` message. */
type OpenNode = { kind: "case"; node: NUnitCase } | { kind: "suite"; node: NUnitSuite };

/**
 * Parse an NUnit3 result document.
 *
 * Returns a typed error for a truncated/malformed document or one with no `<test-run>`
 * root. An empty string is an error too, not an empty run: "no bytes" and "a run that
 * executed nothing" are different facts and only one of them is about the game.
 */
export function parseNUnitResults(xml: string): NUnitRun | NUnitParseError {
  const scanned = scanXml(xml);
  if (isNUnitParseError(scanned)) return scanned;

  const elementStack: string[] = [];
  const openNodes: OpenNode[] = [];
  const suites: NUnitSuite[] = [];
  const cases: NUnitCase[] = [];
  let runAttrs: Record<string, string> | null = null;
  let collecting: string[] | null = null;

  const finishNode = (entry: OpenNode): void => {
    if (entry.kind === "case") cases.push(entry.node);
    else suites.push(entry.node);
  };

  for (const event of scanned.events) {
    if (event.kind === "text") {
      if (collecting !== null) collecting.push(event.text);
      continue;
    }

    if (event.kind === "open") {
      if (event.name === "test-run" && runAttrs === null) runAttrs = event.attrs;

      if (event.name === "test-case") {
        const node: NUnitCase = {
          id: optAttr(event.attrs, "id"),
          name: event.attrs.name ?? "",
          fullname: event.attrs.fullname ?? event.attrs.name ?? "",
          classname: optAttr(event.attrs, "classname"),
          result: event.attrs.result ?? "",
          label: optAttr(event.attrs, "label"),
          site: optAttr(event.attrs, "site"),
        };
        if (event.selfClosing) cases.push(node);
        else openNodes.push({ kind: "case", node });
      } else if (event.name === "test-suite") {
        const node: NUnitSuite = {
          type: optAttr(event.attrs, "type"),
          id: optAttr(event.attrs, "id"),
          name: event.attrs.name ?? "",
          fullname: event.attrs.fullname ?? event.attrs.name ?? "",
          result: event.attrs.result ?? "",
          label: optAttr(event.attrs, "label"),
          site: optAttr(event.attrs, "site"),
          runstate: optAttr(event.attrs, "runstate"),
        };
        if (event.selfClosing) suites.push(node);
        else openNodes.push({ kind: "suite", node });
      } else if (event.name === "message" && !event.selfClosing) {
        // Only a message that belongs to a failure/reason block is a diagnosis; NUnit also
        // emits <message> under <output> and <properties>, which are not verdict text.
        const parent = elementStack[elementStack.length - 1];
        if (parent === "failure" || parent === "reason") collecting = [];
      }

      if (!event.selfClosing) elementStack.push(event.name);
      continue;
    }

    // close
    const expected = elementStack.pop();
    if (expected === undefined) return { error: `malformed XML: </${event.name}> with no open element` };
    if (expected !== event.name) {
      return { error: `malformed XML: </${event.name}> closes <${expected}>` };
    }
    if (event.name === "message" && collecting !== null) {
      const text = collecting.join("").trim();
      collecting = null;
      const owner = openNodes[openNodes.length - 1];
      if (owner !== undefined && owner.node.message === undefined && text.length > 0) {
        owner.node.message = text;
      }
    }
    if (event.name === "test-case" || event.name === "test-suite") {
      const entry = openNodes.pop();
      if (entry !== undefined) finishNode(entry);
    }
  }

  if (elementStack.length > 0) {
    return { error: `truncated XML: unclosed <${elementStack[elementStack.length - 1]}>` };
  }
  if (runAttrs === null) return { error: "not an NUnit3 result document: no <test-run> element" };

  const assemblyNames = new Set<string>();
  for (const suite of suites) {
    if (suite.type === "Assembly" || suite.name.toLowerCase().endsWith(".dll")) assemblyNames.add(suite.name);
  }

  return {
    attrs: runAttrs,
    result: runAttrs.result ?? "",
    runAttrSummary:
      runAttrs.total === undefined
        ? null
        : {
            total: intAttr(runAttrs, "total"),
            passed: intAttr(runAttrs, "passed"),
            failed: intAttr(runAttrs, "failed"),
            inconclusive: intAttr(runAttrs, "inconclusive"),
            skipped: intAttr(runAttrs, "skipped"),
            warnings: intAttr(runAttrs, "warnings"),
          },
    suites,
    cases,
    assemblies: [...assemblyNames].sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* Summary re-derivation (G12)                                                */
/* -------------------------------------------------------------------------- */

/** The five counts the manifest stamps and the grader re-derives. */
export interface TestsSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  skipped: number;
}

/**
 * Re-derive the summary FROM THE WALK (G12).
 *
 * This, not the `<test-run>` roll-up, is what the producer stamps into the manifest and
 * what the grader recomputes, so "manifest summary" and "graded summary" are the same
 * function of the same bytes. Stamping the roll-up instead would make the comparison a
 * lottery over NUnit counting conventions (a Warning case is in `total` but in none of
 * the other four), and a gate that reds out on a convention teaches people to ignore it.
 *
 * `total` is the number of `<test-case>` elements. A Warning case therefore contributes to
 * `total` and to none of the other counts, exactly as NUnit does it.
 */
export function deriveSummary(run: NUnitRun): TestsSummary {
  const summary: TestsSummary = { total: run.cases.length, passed: 0, failed: 0, inconclusive: 0, skipped: 0 };
  for (const testCase of run.cases) {
    if (testCase.result === "Passed") summary.passed += 1;
    else if (testCase.result === "Failed") summary.failed += 1;
    else if (testCase.result === "Inconclusive") summary.inconclusive += 1;
    else if (testCase.result === "Skipped") summary.skipped += 1;
  }
  return summary;
}

/** Named per-field differences between two summaries; empty when they agree. */
export function summaryDisagreements(expected: TestsSummary, actual: TestsSummary): string[] {
  const out: string[] = [];
  for (const key of ["total", "passed", "failed", "inconclusive", "skipped"] as const) {
    if (expected[key] !== actual[key]) out.push(`${key} ${expected[key]} vs ${actual[key]}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The tier mapping                                                           */
/* -------------------------------------------------------------------------- */

export type TestsTier = 0 | 1 | 2;

export interface TestsFailureDetail {
  fullname: string;
  label?: string;
  message?: string;
}

export interface TestsGrade {
  tier: TestsTier;
  summary: TestsSummary;
  /** Why this tier. Every refusal is named; nothing is decided silently. */
  reasons: string[];
  /** True but non-gating observations (a skipped subset, a non-strict warning). */
  notes: string[];
  failures: TestsFailureDetail[];
  skippedCases: string[];
  warningCases: string[];
}

export interface TestsGradeInput {
  run: NUnitRun;
  /** `--strict`: a Warning becomes a defect instead of a note. */
  strict: boolean;
  /** Producer-stamped facts. Absent when an operator named a bare XML (`tests grade`). */
  exitCode?: number;
  compileErrors?: number;
  mutatedProject?: boolean;
  /** The manifest's stamped summary, re-derived and compared here (G12). */
  manifestSummary?: TestsSummary;
  /** The manifest's stamped assembly list, compared against the XML's (G4). */
  manifestAssemblies?: readonly string[];
}

/**
 * Unity's `-runTests` exit codes: 0 tests passed, 2 tests failed, 3 the run itself failed.
 *
 * A blanket "exitCode != 0 is tier 2" would reclassify EVERY genuine red as a harness
 * fault, which is the amendment's intent inverted: it would mean this gate can never
 * report a real assertion defect. So the rule is "an exit code the walk cannot account
 * for", which still refuses an unexplained 1/3/134 and still refuses a `2` from a file
 * that contains no failing case (the stripped-cases forgery).
 */
export function exitCodeIsUnexplained(exitCode: number, realFailureCount: number): boolean {
  if (exitCode === 0) return false;
  if (exitCode === 2 && realFailureCount > 0) return false;
  return true;
}

/** A Failed case that is a real assertion defect (no label, or label "Error"). */
function isRealFailure(testCase: NUnitCase): boolean {
  if (testCase.result !== "Failed") return false;
  return testCase.label === undefined || testCase.label === "Error";
}

function nameList(values: readonly string[], cap = 5): string {
  const shown = values.slice(0, cap).join(", ");
  return values.length > cap ? `${shown}, +${values.length - cap} more` : shown;
}

/**
 * Map a parsed run to a tier.
 *
 * PRECEDENCE, and why: TIER 2 conditions are evaluated FIRST and win. Tier 2 means "this
 * result cannot be read as a verdict"; tier 1 means "read as a verdict, it is a red".
 * When a run both failed tests AND did not check what it claims (compile errors, an
 * ignored fixture, a mutated project, a cancelled run), the honest report is that the
 * result is untrustworthy, and CLAUDE.md's rule is explicit: a harness fault is never a
 * game defect. Reporting tier 1 there would let "3 tests fail" stand in for "half the
 * assemblies never compiled". Every real failure is still listed in `failures` and named
 * in `reasons`, so nothing is hidden by the reclassification, and both tiers are non-zero
 * exits either way.
 *
 * A plain red run (tests ran, some failed, nothing else wrong) has no tier-2 condition and
 * grades tier 1, which is the case the gate exists for.
 */
export function gradeTestResults(input: TestsGradeInput): TestsGrade {
  const { run, strict } = input;
  const summary = deriveSummary(run);

  const realFailures = run.cases.filter(isRealFailure);
  const invalidFailures = run.cases.filter((c) => c.result === "Failed" && !isRealFailure(c));
  const inconclusiveCases = run.cases.filter((c) => c.result === "Inconclusive");
  const skippedCases = run.cases.filter((c) => c.result === "Skipped");
  const warningCases = run.cases.filter((c) => c.result === "Warning");
  const suiteFailures = run.suites.filter((s) => s.result === "Failed");
  const skippedSuites = run.suites.filter((s) => s.result === "Skipped" || s.runstate === "Ignored");

  const failures: TestsFailureDetail[] = [...realFailures, ...invalidFailures].map((c) => ({
    fullname: c.fullname,
    label: c.label,
    message: c.message,
  }));
  const skippedNames = skippedCases.map((c) => c.fullname);
  const warningNames = warningCases.map((c) => c.fullname);

  const reasons: string[] = [];
  const notes: string[] = [];
  const refusals: string[] = [];

  // --- trust: did this run check what it claims to have checked? ---
  if (run.result === "Cancelled") {
    refusals.push("the test run was Cancelled; the results are partial by construction");
  }
  if (input.compileErrors !== undefined && input.compileErrors > 0) {
    refusals.push(
      `${input.compileErrors} compile error line(s) in the Unity log; assemblies that did not compile ran no tests`,
    );
  }
  if (input.mutatedProject === true) {
    refusals.push("the run MUTATED ProjectSettings/ProjectVersion.txt; the project is not the one that was measured");
  }
  if (input.exitCode !== undefined && exitCodeIsUnexplained(input.exitCode, realFailures.length)) {
    refusals.push(`Unity exited ${input.exitCode}, which the test-case walk does not account for`);
  }
  if (summary.total === 0) {
    refusals.push("the run contains zero test cases; it checked nothing");
  } else if (summary.skipped === summary.total) {
    refusals.push(`every one of the ${summary.total} test case(s) was skipped; the run checked nothing`);
  }
  if (skippedSuites.length > 0) {
    // G13: an individually skipped CASE is a named subset; a skipped/ignored SUITE means a
    // whole fixture or assembly silently opted out of being checked.
    refusals.push(`${skippedSuites.length} skipped or ignored suite(s): ${nameList(skippedSuites.map((s) => s.name))}`);
  }
  if (invalidFailures.length > 0) {
    refusals.push(
      `${invalidFailures.length} case(s) failed with label ` +
        `${nameList([...new Set(invalidFailures.map((c) => c.label ?? "?"))])}: ` +
        `${nameList(invalidFailures.map((c) => c.fullname))}`,
    );
  }
  if (inconclusiveCases.length > 0) {
    refusals.push(`${inconclusiveCases.length} inconclusive case(s): ${nameList(inconclusiveCases.map((c) => c.fullname))}`);
  }

  // --- the union rule (G3): the roll-up and the walk must agree ---
  if (realFailures.length === 0) {
    if (suiteFailures.length > 0) {
      refusals.push(
        `suite-level failure with a clean test-case walk (${nameList(
          suiteFailures.map((s) => `${s.name}${s.site ? ` site=${s.site}` : ""}`),
        )}); a TearDown/OneTimeSetUp fault is not a passing suite`,
      );
    }
    if (run.result !== "Passed" && run.result !== "Warning") {
      refusals.push(`test-run result is '${run.result || "(absent)"}' but the test-case walk found no failure`);
    }
    if (run.runAttrSummary !== null && run.runAttrSummary.failed > 0) {
      refusals.push(
        `<test-run failed="${run.runAttrSummary.failed}"> but the test-case walk found no failure; ` +
          "cases are missing from the document",
      );
    }
  }

  // --- stamped-vs-graded bindings (G12, G4) ---
  if (input.manifestSummary !== undefined) {
    const diffs = summaryDisagreements(input.manifestSummary, summary);
    if (diffs.length > 0) {
      refusals.push(`manifest summary disagrees with the graded walk: ${diffs.join("; ")}`);
    }
  }
  if (input.manifestAssemblies !== undefined) {
    const stamped = new Set(input.manifestAssemblies);
    const walked = new Set(run.assemblies);
    const missing = [...stamped].filter((a) => !walked.has(a)).sort();
    const extra = [...walked].filter((a) => !stamped.has(a)).sort();
    if (missing.length > 0 || extra.length > 0) {
      refusals.push(
        "assembly set disagrees with the manifest" +
          (missing.length > 0 ? `; stamped but absent from the XML: ${nameList(missing)}` : "") +
          (extra.length > 0 ? `; in the XML but not stamped: ${nameList(extra)}` : ""),
      );
    }
  }

  const failureLine =
    realFailures.length > 0
      ? `${realFailures.length} test(s) failed: ${nameList(realFailures.map((c) => c.fullname))}`
      : null;

  if (refusals.length > 0) {
    reasons.push(...refusals);
    if (failureLine !== null) reasons.push(failureLine);
    return { tier: 2, summary, reasons, notes, failures, skippedCases: skippedNames, warningCases: warningNames };
  }

  if (realFailures.length > 0) {
    reasons.push(failureLine as string);
    return { tier: 1, summary, reasons, notes, failures, skippedCases: skippedNames, warningCases: warningNames };
  }

  if (skippedNames.length > 0) {
    // Named, never hidden: a shrinking suite must be visible in the passing output.
    notes.push(`${skippedNames.length} skipped case(s): ${nameList(skippedNames)}`);
  }
  if (warningNames.length > 0) {
    if (strict) {
      reasons.push(`${warningNames.length} warning case(s) under --strict: ${nameList(warningNames)}`);
      return { tier: 1, summary, reasons, notes, failures, skippedCases: skippedNames, warningCases: warningNames };
    }
    notes.push(`${warningNames.length} warning case(s) (not gating without --strict): ${nameList(warningNames)}`);
  }

  return { tier: 0, summary, reasons, notes, failures, skippedCases: skippedNames, warningCases: warningNames };
}
