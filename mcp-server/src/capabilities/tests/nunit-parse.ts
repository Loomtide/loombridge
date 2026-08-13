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
 *
 * AND THE UNION IS TAKEN AT EVERY LEVEL THAT DECLARES ONE (H2). The first cut of that rule
 * read ONE number of ONE element: `<test-run failed>`, and only when `<test-run total>` was
 * also present, because an absent `total` collapsed the whole roll-up to `null`. So dropping
 * a single attribute disabled the cross-check entirely, and `<test-run result="Passed"
 * passed="1" failed="3">` over one passing case graded tier 0. Now EVERY count a roll-up
 * declares is held against the cases actually walked beneath it, on `<test-run>` and on every
 * `<test-suite>`, so hiding a case means scrubbing the roll-up of every ancestor rather than
 * deleting one attribute. What is NOT declared is not invented: an older writer that omits
 * `total` is compared on the counts it does declare, which is the refuse-on-absent rule
 * pointed the only way it can honestly point at a document nobody stamped.
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

/* -------------------------------------------------------------------------- */
/* Roll-ups: what an element DECLARES, against what lies beneath it           */
/* -------------------------------------------------------------------------- */

/**
 * The six count attributes NUnit writes on a roll-up element that are COMPARABLE to the walk.
 *
 * CLOSED and ordered, so the refusal sentences read the same everywhere and a seventh
 * attribute is an RFC-level change rather than a quiet extra case.
 *
 * `testcasecount` IS WRITTEN BY REAL UNITY and is deliberately NOT in this set (F4). The set
 * above is comparable because every key is a count of cases the walk can recount by result
 * word. `testcasecount` is a different quantity: the number of test cases DISCOVERED in the
 * loaded assemblies, before any filter. A filtered or platform-excluded run legitimately
 * declares more discovered cases than it executed, so equality with the walk is not a fact
 * about an honest document and a refusal on it would red out ordinary runs. It is read
 * anyway, as {@link NUnitRollup.testCaseCount}, and reported as a NOTE: the earlier claim
 * that "there is no field to delete that buys silence at one level without contradicting the
 * level above it" was wrong about this field, and a document declaring `testcasecount="500"`
 * over one walked case used to print "this green is quotable" with nothing said about it.
 */
export const ROLLUP_COUNT_KEYS = ["total", "passed", "failed", "inconclusive", "skipped", "warnings"] as const;

export type RollupCountKey = (typeof ROLLUP_COUNT_KEYS)[number];

/** Counts one element DECLARED. A key ABSENT here was not declared, which is not zero. */
export type NUnitDeclaredCounts = Partial<Record<RollupCountKey, number>>;

/**
 * One element's declared roll-up.
 *
 * `malformed` is separate from `declared` on purpose: `total="lots"` is not the same fact as
 * no `total` at all. An unreadable count is a document nobody can cross-check, which is a
 * refusal, while an absent one is simply a count this writer did not emit.
 */
export interface NUnitRollup {
  declared: NUnitDeclaredCounts;
  malformed: RollupCountKey[];
  /**
   * `testcasecount`, the DISCOVERED population (F4). Not comparable for equality, see
   * {@link ROLLUP_COUNT_KEYS}; reported as a note when it disagrees with the walk.
   * `undefined` when absent, `"malformed"` when present and not a whole number.
   */
  testCaseCount?: number | "malformed";
}

/** The counts the WALK produces: one bucket per NUnit case result, plus the case total. */
export type NUnitWalkedCounts = Record<RollupCountKey, number>;

export function emptyWalkedCounts(): NUnitWalkedCounts {
  return { total: 0, passed: 0, failed: 0, inconclusive: 0, skipped: 0, warnings: 0 };
}

/** Add one walked case to a counter set. An unrecognized result lands in `total` only. */
function bumpWalkedCounts(counts: NUnitWalkedCounts, result: string): void {
  counts.total += 1;
  if (result === "Passed") counts.passed += 1;
  else if (result === "Failed") counts.failed += 1;
  else if (result === "Inconclusive") counts.inconclusive += 1;
  else if (result === "Skipped") counts.skipped += 1;
  else if (result === "Warning") counts.warnings += 1;
}

/** Count a set of walked cases. Used for `<test-run>`; suites accumulate as they close. */
export function countCases(cases: readonly NUnitCase[]): NUnitWalkedCounts {
  const counts = emptyWalkedCounts();
  for (const testCase of cases) bumpWalkedCounts(counts, testCase.result);
  return counts;
}

/**
 * Read the declared roll-up off one element's attributes.
 *
 * A count must be a non-negative whole number. Anything else is MALFORMED rather than
 * silently coerced: `intAttr` answers 0 for a non-numeric value, and a roll-up that reads as
 * all-zeros is a roll-up that agrees with an empty walk, which is the quietest way for a
 * hand-edited document to disarm the cross-check below.
 */
export function readRollup(attrs: Record<string, string>): NUnitRollup {
  const declared: NUnitDeclaredCounts = {};
  const malformed: RollupCountKey[] = [];
  for (const key of ROLLUP_COUNT_KEYS) {
    const raw = attrs[key];
    if (raw === undefined || raw.length === 0) continue;
    if (!/^\d+$/.test(raw.trim())) {
      malformed.push(key);
      continue;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) malformed.push(key);
    else declared[key] = parsed;
  }
  const rawCount = attrs.testcasecount;
  let testCaseCount: number | "malformed" | undefined;
  if (rawCount !== undefined && rawCount.length > 0) {
    testCaseCount = /^\d+$/.test(rawCount.trim()) ? Number.parseInt(rawCount.trim(), 10) : "malformed";
  }
  return { declared, malformed, ...(testCaseCount !== undefined ? { testCaseCount } : {}) };
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
  /**
   * The suite's own executed-count roll-up (passed + failed + inconclusive), when the
   * document declares the attributes. NUnit propagates a child's Ignored label onto a
   * PARENT fixture (`result="Skipped" label="Ignored"`) even when that fixture ran almost
   * every case, so the opt-out rule (G13) must not read result/runstate alone: a suite is
   * an opt-out only when it EXECUTED NOTHING. Observed live on the repo's own suite: a
   * `runstate="Runnable"` fixture with 51 of 53 cases passed still carried
   * `result="Skipped" label="Ignored"` from its two `[Ignore]`d children.
   */
  executed?: number;
  /** What THIS suite element declares about its subtree (H2). Advisory: the walk decides. */
  rollup: NUnitRollup;
  /** What the walk actually found BENEATH it: every `<test-case>` in its subtree. */
  walked: NUnitWalkedCounts;
}

export interface NUnitRun {
  /** Raw `<test-run>` attributes, for anything a caller wants that is not modelled. */
  attrs: Record<string, string>;
  /** `<test-run result>`; "" when the document did not declare one. */
  result: string;
  /**
   * What `<test-run>` declares about the whole document (H2).
   *
   * NOT collapsed to `null` when one attribute is missing. The earlier shape
   * (`runAttrSummary: … | null`, null whenever `total` was absent) made deleting ONE
   * attribute delete the entire cross-check, and the grader's own union rule then had
   * nothing to compare. Only the keys the document declares are compared; the rest are
   * absent facts, not zeroes.
   */
  rollup: NUnitRollup;
  suites: NUnitSuite[];
  cases: NUnitCase[];
  /** Assembly-level suite names, sorted and deduped (the manifest binds against these). */
  assemblies: string[];
}

function optAttr(attrs: Record<string, string>, key: string): string | undefined {
  const raw = attrs[key];
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * The suite's own executed-count roll-up: passed + failed + inconclusive, when declared.
 * Returns undefined when NONE of the three attributes is present (an undeclared roll-up is
 * not the same fact as an executed count of zero, and the opt-out rule treats the two
 * differently: absent stays conservative).
 */
function suiteExecutedCount(attrs: Record<string, string>): number | undefined {
  const parts = ["passed", "failed", "inconclusive"].map((k) => attrs[k]);
  if (parts.every((v) => v === undefined || v.length === 0)) return undefined;
  return parts.reduce((sum, v) => {
    const n = Number(v ?? "0");
    return sum + (Number.isFinite(n) && n >= 0 ? n : 0);
  }, 0);
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
  // The suites currently OPEN, innermost last. Every finished case is attributed to all of
  // them, which is what gives each suite its subtree walk to hold its own roll-up against.
  const openSuites: NUnitSuite[] = [];
  const suites: NUnitSuite[] = [];
  const cases: NUnitCase[] = [];
  let runAttrs: Record<string, string> | null = null;
  let collecting: string[] | null = null;

  const finishCase = (node: NUnitCase): void => {
    cases.push(node);
    for (const suite of openSuites) bumpWalkedCounts(suite.walked, node.result);
  };

  const finishNode = (entry: OpenNode): void => {
    if (entry.kind === "case") finishCase(entry.node);
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
        if (event.selfClosing) finishCase(node);
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
          executed: suiteExecutedCount(event.attrs),
          rollup: readRollup(event.attrs),
          walked: emptyWalkedCounts(),
        };
        if (event.selfClosing) suites.push(node);
        else {
          openNodes.push({ kind: "suite", node });
          openSuites.push(node);
        }
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
      // Pop the open-suite stack BEFORE finishing, so a suite stops collecting the cases of
      // its LATER siblings. Its own subtree has already been attributed to it by `finishCase`.
      if (entry !== undefined && entry.kind === "suite" && openSuites[openSuites.length - 1] === entry.node) {
        openSuites.pop();
      }
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
    rollup: readRollup(runAttrs),
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
  const { total, passed, failed, inconclusive, skipped } = countCases(run.cases);
  return { total, passed, failed, inconclusive, skipped };
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
/* The union rule (G3/H2): a roll-up against the cases beneath it             */
/* -------------------------------------------------------------------------- */

/**
 * `total` is compared ASYMMETRICALLY, and only `total`.
 *
 * The hiding direction is a roll-up that counts MORE cases than the document contains:
 * cases were removed and the summary was not, which is the forgery this rule exists for.
 * The other direction (the document contains more cases than the roll-up counts) hides
 * nothing, because the walk grades every case it can see, and it is the one direction this
 * file already documents a real writer convention for: `deriveSummary` records that a
 * Warning case lands in `total` and in none of the other buckets, so a writer that leaves
 * warnings out of `total` under-counts legitimately. It is reported as a NOTE.
 *
 * The five per-result counts have no such convention hazard: each is a count of cases
 * carrying one of NUnit's five result words, which the walk counts the same way. They are
 * compared for EQUALITY in both directions, which is what "any disagreement is a refusal"
 * means.
 */
export interface RollupCrossCheck {
  /** Named disagreements. A tier-2 refusal each: the document contradicts itself. */
  refusals: string[];
  /** True but non-gating observations (the safe direction of a `total` mismatch). */
  notes: string[];
}

/**
 * Hold one element's declared roll-up against the cases actually walked beneath it.
 *
 * `label` names the element ("<test-run>", "suite 'Foo.dll'"), because a refusal that does
 * not say WHICH roll-up disagreed tells an operator a document is broken and nothing about
 * where. Only DECLARED keys are compared: an absent count is a fact the writer did not
 * state, not a claim of zero, and inventing one would red out every older NUnit writer.
 */
export function rollupCrossCheck(
  label: string,
  rollup: NUnitRollup,
  walked: NUnitWalkedCounts,
): RollupCrossCheck {
  const refusals: string[] = [];
  const notes: string[] = [];

  if (rollup.malformed.length > 0) {
    refusals.push(
      `${label} declares ${rollup.malformed.join(", ")} as something other than a whole number; ` +
        "a roll-up nobody can read cannot be held against the walk",
    );
  }

  for (const key of ROLLUP_COUNT_KEYS) {
    const declared = rollup.declared[key];
    if (declared === undefined) continue;
    const actual = walked[key];
    if (declared === actual) continue;
    if (key === "total") {
      if (declared > actual) {
        refusals.push(
          `${label} declares total="${declared}" but only ${actual} test case(s) are present ` +
            "beneath it; cases are missing from the document",
        );
      } else {
        notes.push(`${label} declares total="${declared}" over ${actual} walked case(s) (writer convention)`);
      }
      continue;
    }
    refusals.push(
      `${label} declares ${key}="${declared}" but the walk beneath it found ${actual}; ` +
        "the roll-up and the cases disagree",
    );
  }

  // F4: `testcasecount` is the DISCOVERED population, not a recount of the walk, so it is
  // reported and never gating. A filtered run legitimately discovers more than it executes;
  // what it may not do is declare 500 discovered cases over one walked case and have the
  // report say nothing at all about the other 499.
  if (rollup.testCaseCount === "malformed") {
    notes.push(`${label} declares testcasecount as something other than a whole number`);
  } else if (rollup.testCaseCount !== undefined && rollup.testCaseCount !== walked.total) {
    notes.push(
      `${label} declares testcasecount="${rollup.testCaseCount}" over ${walked.total} walked case(s) ` +
        "(discovered population, not a recount of the walk; a filtered run differs legitimately)",
    );
  }

  return { refusals, notes };
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
  /**
   * Did any producer fact bind this walk to a run? See {@link TestsAttribution}.
   *
   * NOT a tier. A bare CI XML grades honestly and can reach tier 0; what it cannot do is be
   * QUOTED, and `tests grade` (the one door whose output says "this green is quotable") reads
   * THIS to decide, rather than re-deriving its own idea of "was this attributable" from the
   * integrity result beside it. It had no reader at all when it shipped, while this docstring
   * claimed one (F5): a field nothing reads is a claim nothing keeps true. The other two doors
   * do not need it, and for opposite reasons that are worth stating: `tests run` IS the
   * producer, and `verify` is permanently `anchored: false`, so it never quotes a green at all.
   */
  attributed: boolean;
  /** The one-line statement of where the producer facts came from, printed on every path. */
  attribution: string;
}

/**
 * The producer facts every stamped run carries. All three, never a subset.
 *
 * They are the three refusals that are invisible in the XML: Unity's exit code, the
 * compile-error lines in its log, and whether the run upgraded the project underneath
 * itself. Nothing in the result document mentions any of them.
 */
export interface TestsProducerFacts {
  /** Unity's process exit code (0 passed, 2 tests failed, 3 the run itself failed). */
  exitCode: number;
  /** Count of `error CS<n>` lines in the run log. */
  compileErrors: number;
  /** True when `ProjectSettings/ProjectVersion.txt` changed across the run. */
  mutatedProject: boolean;
}

/**
 * WHERE THE PRODUCER FACTS CAME FROM, stated by every caller (H3).
 *
 * The five producer bindings used to be five INDEPENDENT optional fields, each guarded by
 * `if (input.X !== undefined && ...)`. That is CLAUDE.md's refuse-on-absent anti-pattern
 * with the refusal delegated to the call sites, and this file's own comment (the one above
 * the FXA rules) argues against exactly that: "a rule enforced by one door is a rule the
 * other doors do not have". It was not theoretical. `tests grade` degraded a manifest that
 * FAILED INTEGRITY into the unstamped path, which silently turned all five fields into
 * `undefined`, and a manifest carrying `exitCode: 3`, `compileErrors: 42`,
 * `mutatedProject: true`, a forged summary and a forged assembly list reached exit 0 under
 * the CI attestation with none of its five refusals ever evaluated.
 *
 * So attribution is now a REQUIRED, DISCRIMINATED input. A caller must say which of three
 * things it is, the compiler will not let it omit the facts a `stamped` or `producer` input
 * owes, and the bare-XML case is an EXPLICIT, NAMED opt-in that carries the reason it is
 * unattributed instead of being the shape an absent field falls into.
 *
 * `unattributed` is a supported input, not a defect: CI grades the bare NUnit3 XML GameCI
 * produced, and refusing it at the grader would turn a legitimate workflow red, which is how
 * a moat fix gets relaxed later. What it costs is the right to be QUOTED: `grade.attributed`
 * is false, every door prints the reason, and only `GITHUB_ACTIONS` (the runner as trust
 * root) lets such a green exit 0.
 */
export type TestsAttribution =
  /** `tests run`: this process spawned the editor, so it IS the producer of these facts. */
  | ({ kind: "producer" } & TestsProducerFacts)
  /**
   * An offline grader reading a stamped pair whose integrity was ALREADY verified. It owes
   * the producer facts AND the two stamped cross-checks, because a caller holding a verified
   * manifest has no honest reason to withhold either.
   */
  | ({ kind: "stamped" } & TestsProducerFacts & {
        /** The manifest's stamped summary, re-derived and compared here (G12). */
        manifestSummary: TestsSummary;
        /** The manifest's stamped assembly list, compared against the XML's (G4). */
        manifestAssemblies: readonly string[];
      })
  /** A bare XML nobody stamped. `why` is printed, so the gap is visible rather than absent. */
  | { kind: "unattributed"; why: string };

/* -------------------------------------------------------------------------- */
/* The one fact from OUTSIDE the pair (H4)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The project's own declared test surface, as the grader sees it.
 *
 * WHY IT IS A REQUIRED INPUT. Every binding the previous wave added reads bytes the graded
 * run wrote: the sha binds the XML to the manifest, the manifest's summary and assembly list
 * are re-derived from that same XML, and the roll-up cross-check walks one byte stream. A
 * self-consistent forged pair therefore satisfied all of them at once, and the reviewer
 * flipped the test-results section of `verify` from `fail`/exit 1 to `pass (unanchored)`/exit 0 with no Unity
 * involved. The honest close needs a fact the forger does not author, and this is it:
 * `Packages/manifest.json` `testables` and the Test-Runner `.asmdef` files are written by the
 * GAME, not by the run, and they name the assemblies a real run can possibly produce.
 *
 * It is REQUIRED rather than optional for the reason H3 is: an optional field is a field the
 * next door forgets, and `undefined` then reads exactly like "checked and fine". Every caller
 * must say which of the three answers it has, and `unknown` carries the reason it has none.
 *
 * THE PRODUCER (`tests run`) SUPPLIES IT TOO, even though it spawned the editor itself. Not
 * because the check can catch that door lying (it cannot: the XML came from Unity), but
 * because the stamp it writes is what every later door reads, so a run whose results do not
 * match the project's own asmdefs should say so at the moment it stamps them rather than three
 * doors downstream.
 */
export type DeclaredTestSurface =
  /** The project names these assemblies. `complete` is false when a testable was unresolvable. */
  | { kind: "declared"; assemblies: readonly string[]; complete: boolean; how: string }
  /** A project WAS read and declares no test assembly this checkout can enumerate. */
  | { kind: "none"; why: string }
  /** There is no project to read (a bare XML at an operator-named path). */
  | { kind: "unknown"; why: string };

/** Normalize an assembly name for comparison: Unity writes `<name>.dll` in the XML. */
function assemblyKey(name: string): string {
  const trimmed = name.trim();
  const bare = trimmed.toLowerCase().endsWith(".dll") ? trimmed.slice(0, -4) : trimmed;
  // Case-insensitive: the XML name comes from a filesystem path on platforms that do not
  // preserve case, and a case difference is not a different assembly.
  return bare.toLowerCase();
}

/**
 * Hold the XML's assembly set against the project's declared test surface (H4).
 *
 * THE REFUSAL / NOTE SPLIT, decided deliberately, because a gate that reds out ordinary
 * projects is a gate that gets relaxed and the hole comes back:
 *
 *  - REFUSAL, "the walk names NO assembly at all". Without an assembly suite there is nothing
 *    for the declared surface to constrain, and deleting the suites is strictly the cheapest
 *    evasion of everything below (it is the same "delete the denominator" shape the screens and
 *    feel waves closed). Real Unity always writes `<test-suite type="Assembly">`; the committed
 *    real fixture carries two.
 *  - REFUSAL, "no assembly the walk names is one this project declares", but ONLY on a
 *    COMPLETE surface. Disjointness means the results are about some other project's
 *    assemblies. On an INCOMPLETE surface (a `testables` entry this checkout could not resolve,
 *    e.g. a registry package on a clone with no `Library/`) the assemblies it names may be
 *    exactly the ones we could not enumerate, so it degrades to a note.
 *  - NOTE, "the project declares an assembly the walk does not contain". This is the direction
 *    that would catch a WHOLE FAILING ASSEMBLY being hidden, and it is the direction with real
 *    false-failure surface: a test asmdef excluded by platform, or holding no `[Test]` at all,
 *    is a legitimate absence, and this repo's own known-open said so before the check existed.
 *    Naming it in the report is what a note is for; failing on it would teach operators to
 *    ignore this gate.
 *  - NOTE, "the walk names an assembly the project does not declare". Predefined assemblies
 *    (`Assembly-CSharp-Editor`) and an unresolvable testable's assemblies both land here
 *    honestly.
 *  - NOTE and nothing else for `none` / `unknown`. A project with no declared test surface, and
 *    a bare CI XML with no project at all, are supported inputs; refusing them would turn the
 *    GameCI workflow and every asmdef-free project red. The note says, in the report, that
 *    nothing outside the pair constrained this verdict, which is the honest sentence.
 */
export function declaredSurfaceCrossCheck(
  surface: DeclaredTestSurface,
  runAssemblies: readonly string[],
): RollupCrossCheck {
  const refusals: string[] = [];
  const notes: string[] = [];

  if (surface.kind !== "declared") {
    notes.push(
      "the assembly set is bound to nothing outside these results " +
        `(${surface.kind === "none" ? "no declared test surface" : "no project surface was read"}: ${surface.why})`,
    );
    return { refusals, notes };
  }

  if (runAssemblies.length === 0) {
    refusals.push(
      "the results declare no assembly suite at all, so the project's declared test surface " +
        `(${surface.how}) constrains nothing; a real Unity run names every assembly it ran`,
    );
    return { refusals, notes };
  }

  const declaredKeys = new Map(surface.assemblies.map((a) => [assemblyKey(a), a]));
  const walkedKeys = new Map(runAssemblies.map((a) => [assemblyKey(a), a]));
  const matched = [...walkedKeys.keys()].filter((k) => declaredKeys.has(k));
  const undeclared = [...walkedKeys.entries()].filter(([k]) => !declaredKeys.has(k)).map(([, a]) => a);
  const unwalked = [...declaredKeys.entries()].filter(([k]) => !walkedKeys.has(k)).map(([, a]) => a);

  if (matched.length === 0) {
    const sentence =
      `none of the ${runAssemblies.length} assembly(ies) in the results is one this project declares ` +
      `(results: ${nameList(runAssemblies)}; declared: ${nameList(surface.assemblies)})`;
    if (surface.complete) refusals.push(`${sentence}; these results are not about this project`);
    else notes.push(`${sentence}, but the declared surface is INCOMPLETE (${surface.how}), so this is not gating`);
    return { refusals, notes };
  }

  if (unwalked.length > 0) {
    notes.push(
      `${unwalked.length} declared test assembly(ies) contributed nothing to this run: ${nameList(unwalked)} ` +
        "(a platform-excluded or test-free asmdef is a legitimate absence; a hidden failing assembly is not)",
    );
  }
  if (undeclared.length > 0) {
    notes.push(
      `${undeclared.length} assembly(ies) in the results are not in this project's declared surface: ` +
        `${nameList(undeclared)} (a predefined assembly or an unresolved testable lands here honestly)`,
    );
  }
  return { refusals, notes };
}

export interface TestsGradeInput {
  run: NUnitRun;
  /** `--strict`: a Warning becomes a defect instead of a note. */
  strict: boolean;
  /** REQUIRED. Which of the three inputs this is, and the facts that shape owes. */
  attribution: TestsAttribution;
  /** REQUIRED. The project's own declared test surface: see {@link DeclaredTestSurface}. */
  surface: DeclaredTestSurface;
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

/**
 * NUnit3's EXACT vocabulary for a `<test-case result>` (FXA).
 *
 * Case-sensitive and closed on purpose. Every bucket in `deriveSummary` matches one of these
 * five strings, so a value outside the set (a typo, a lowercase `passed`, a future NUnit
 * word, a hand-edited `Broken`) falls into NO bucket: it inflates `total` while contributing
 * to nothing, and the run reads as "cases that are neither passed nor failed", which is the
 * quietest possible way to make a failing case disappear. The mapping refuses instead of
 * guessing what an unrecognized word was supposed to mean.
 */
export const RECOGNIZED_CASE_RESULTS = ["Passed", "Failed", "Warning", "Inconclusive", "Skipped"] as const;

const RECOGNIZED_CASE_RESULT_SET: ReadonlySet<string> = new Set<string>(RECOGNIZED_CASE_RESULTS);

/** Is this `<test-case result>` one of the five words NUnit actually writes? */
export function isRecognizedCaseResult(result: string): boolean {
  return RECOGNIZED_CASE_RESULT_SET.has(result);
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
  const { run, strict, attribution, surface } = input;
  const summary = deriveSummary(run);
  const attributed = attribution.kind !== "unattributed";
  const attributionLine =
    attribution.kind === "producer"
      ? "producer facts from the run this process spawned"
      : attribution.kind === "stamped"
        ? "producer facts from a verified stamped manifest"
        : `NOT attributed to any run: ${attribution.why}`;

  const realFailures = run.cases.filter(isRealFailure);
  const invalidFailures = run.cases.filter((c) => c.result === "Failed" && !isRealFailure(c));
  const inconclusiveCases = run.cases.filter((c) => c.result === "Inconclusive");
  const skippedCases = run.cases.filter((c) => c.result === "Skipped");
  const warningCases = run.cases.filter((c) => c.result === "Warning");
  const suiteFailures = run.suites.filter((s) => s.result === "Failed");
  // G13, corrected by the live final test: a suite is an OPT-OUT only when it EXECUTED
  // NOTHING. NUnit propagates a child's Ignored label onto a parent fixture
  // (result="Skipped" label="Ignored") even when that fixture is runstate="Runnable" and
  // ran nearly every case; reading result/runstate alone graded the repo's own suite
  // (51 of 53 cases passed, 2 [Ignore]d) as a tier-2 harness fault, which inverted
  // "a harness fault is never a game defect" in the other direction and would have pinned
  // the gate permanently red for a benign reason. A suite with declared executed counts
  // greater than zero contributed real verdicts; its skipped children are already the
  // named case-level subset. A suite that declares NO counts keeps the conservative
  // reading (opt-out), which is the refuse-on-absent direction.
  const skippedSuites = run.suites.filter(
    (s) => (s.result === "Skipped" || s.runstate === "Ignored") && (s.executed ?? 0) === 0,
  );

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

  // --- FXA: is every case's result a word this mapping actually understands? ---
  // These two rules live HERE, in `gradeTestResults`, rather than at one call site, so every
  // consumer (`tests run`, `tests grade`, the unified tests section) inherits them from the
  // same function. A rule enforced by one door is a rule the other doors do not have.
  const unknownResultCases = run.cases.filter((c) => !isRecognizedCaseResult(c.result));
  if (unknownResultCases.length > 0) {
    refusals.push(
      `${unknownResultCases.length} case(s) carry a result outside NUnit's vocabulary ` +
        `(${RECOGNIZED_CASE_RESULTS.join(", ")}): ` +
        nameList(unknownResultCases.map((c) => `${c.fullname} result='${c.result}'`)),
    );
  }
  // BUCKET ACCOUNTING. `total` is the number of `<test-case>` elements walked; the five
  // buckets below are the only places a case can land. If they do not add up, some case was
  // counted in the total and graded by nothing, which is exactly how a failing case hides.
  const bucketed = summary.passed + summary.failed + summary.inconclusive + summary.skipped + warningCases.length;
  if (bucketed !== summary.total) {
    refusals.push(
      `bucket accounting disagrees with the walk: ${summary.total} case(s) walked but ` +
        `${bucketed} landed in a bucket (passed ${summary.passed}, failed ${summary.failed}, ` +
        `inconclusive ${summary.inconclusive}, skipped ${summary.skipped}, warning ${warningCases.length})`,
    );
  }

  // --- trust: did this run check what it claims to have checked? ---
  if (run.result === "Cancelled") {
    refusals.push("the test run was Cancelled; the results are partial by construction");
  }
  // H3: the three producer facts are read from the DISCRIMINATED attribution, so there is no
  // shape of this input in which they are silently absent. An `unattributed` bare XML is the
  // one input that carries none, and it says so in `grade.attribution` rather than by omission.
  if (attribution.kind !== "unattributed") {
    if (attribution.compileErrors > 0) {
      refusals.push(
        `${attribution.compileErrors} compile error line(s) in the Unity log; assemblies that did not compile ran no tests`,
      );
    }
    if (attribution.mutatedProject) {
      refusals.push("the run MUTATED ProjectSettings/ProjectVersion.txt; the project is not the one that was measured");
    }
    if (exitCodeIsUnexplained(attribution.exitCode, realFailures.length)) {
      refusals.push(`Unity exited ${attribution.exitCode}, which the test-case walk does not account for`);
    }
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

  // --- the union rule (G3/H2): EVERY declared roll-up against the cases beneath it ---
  //
  // Unconditional, not gated on `realFailures.length === 0`. The roll-up cross-check answers
  // "does this document contradict itself", which is a question about the EVIDENCE and is
  // just as answerable on a red run; gating it on a clean walk would mean a document that
  // hides four of five failures is only checked while it hides all five.
  const runCheck = rollupCrossCheck("<test-run>", run.rollup, countCases(run.cases));
  refusals.push(...runCheck.refusals);
  notes.push(...runCheck.notes);
  // Every `<test-suite>` that declares counts is held against ITS OWN subtree, so removing a
  // case means scrubbing the roll-up of every ancestor rather than deleting one attribute.
  // Capped, because a single deleted case disagrees with each of its ancestors and an
  // uncapped list would bury the sentence an operator needs.
  const suiteRefusals: string[] = [];
  const suiteNotes: string[] = [];
  for (const suite of run.suites) {
    const check = rollupCrossCheck(`suite '${suite.name}'`, suite.rollup, suite.walked);
    suiteRefusals.push(...check.refusals);
    suiteNotes.push(...check.notes);
  }
  if (suiteRefusals.length > 0) refusals.push(...suiteRefusals.slice(0, 5));
  // Capped for the same reason: one edited case disagrees with every ancestor, and an
  // uncapped list would bury the sentence an operator needs.
  if (suiteNotes.length > 0) notes.push(...suiteNotes.slice(0, 5));

  // --- H4: the one fact from OUTSIDE the pair ---
  //
  // Unconditional on the attribution kind, and deliberately so. The forged pair the reviewer
  // demonstrated was `stamped`, but a bare XML dropped at a project's declared slot reaches
  // the CI attestation, so scoping this to `stamped` would leave the cheaper door open. Every
  // caller states its surface; the ones that have none say so and get a note.
  const surfaceCheck = declaredSurfaceCrossCheck(surface, run.assemblies);
  refusals.push(...surfaceCheck.refusals);
  notes.push(...surfaceCheck.notes);

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
  }

  // --- stamped-vs-graded bindings (G12, G4) ---
  // Reached for a `stamped` attribution ONLY, and for a stamped attribution ALWAYS: the two
  // fields are required by that shape of the input, so there is no path on which a caller
  // holding a verified manifest grades without them.
  if (attribution.kind === "stamped") {
    const diffs = summaryDisagreements(attribution.manifestSummary, summary);
    if (diffs.length > 0) {
      refusals.push(`manifest summary disagrees with the graded walk: ${diffs.join("; ")}`);
    }
    const stamped = new Set(attribution.manifestAssemblies);
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

  const shape = (tier: TestsTier): TestsGrade => ({
    tier,
    summary,
    reasons,
    notes,
    failures,
    skippedCases: skippedNames,
    warningCases: warningNames,
    attributed,
    attribution: attributionLine,
  });

  if (refusals.length > 0) {
    reasons.push(...refusals);
    if (failureLine !== null) reasons.push(failureLine);
    return shape(2);
  }

  if (realFailures.length > 0) {
    reasons.push(failureLine as string);
    return shape(1);
  }

  if (skippedNames.length > 0) {
    // Named, never hidden: a shrinking suite must be visible in the passing output.
    notes.push(`${skippedNames.length} skipped case(s): ${nameList(skippedNames)}`);
  }
  if (warningNames.length > 0) {
    if (strict) {
      reasons.push(`${warningNames.length} warning case(s) under --strict: ${nameList(warningNames)}`);
      return shape(1);
    }
    notes.push(`${warningNames.length} warning case(s) (not gating without --strict): ${nameList(warningNames)}`);
  }

  return shape(0);
}
