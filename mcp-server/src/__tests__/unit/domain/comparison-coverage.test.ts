/**
 * THE COUNTING CONTRACT: expected vs performed, and the refusal that reads them.
 *
 * This predicate is the whole of the "compared nothing" guarantee for four gates (the
 * replay pixel gate, the screen contract, the feel snapshot and the evidence ledger), so
 * every property it is supposed to have is pinned here rather than in one caller's tests.
 *
 * The threat model is a HAND-EDITED or TRUNCATED report, not a buggy one. Each test below
 * is one edit an author could make to a report to try to pass, and the answer must be the
 * same in all of them: the numbers decide.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  anchoredByComparison,
  comparisonShortfall,
  comparisonShortfallSentence,
  COMPARISON_SHORTFALL_EXIT,
} from "../../../domain/comparison-coverage.js";

test("a full comparison is no shortfall, and it IS an anchor", () => {
  assert.equal(comparisonShortfall({ expected: 15, performed: 15 }), null);
  assert.equal(anchoredByComparison({ expected: 15, performed: 15 }), true);
  // More than promised is still not a shortfall (an extra comparison cannot hurt).
  assert.equal(comparisonShortfall({ expected: 3, performed: 4 }), null);
});

test("a PARTIAL comparison is a shortfall, and it is NOT an anchor", () => {
  // The case the replay gate shipped: fifteen approved frames, a green badge, nothing
  // compared. One frame graded out of three is the same bug with a smaller number.
  assert.deepEqual(comparisonShortfall({ expected: 3, performed: 1, ungraded: ["mid", "end"] }), {
    expected: 3,
    performed: 1,
    ungraded: ["mid", "end"],
  });
  assert.equal(anchoredByComparison({ expected: 3, performed: 1 }), false);
});

test("an ABSENT numerator reads as ZERO, never as `assume it was met`", () => {
  // THE LAUNDERING EDIT. Delete the field that says how many comparisons happened and a
  // "skip when absent" predicate reports no problem at all.
  assert.deepEqual(comparisonShortfall({ expected: 4 }), { expected: 4, performed: 0, ungraded: [] });
  assert.equal(anchoredByComparison({ expected: 4 }), false);
  assert.deepEqual(comparisonShortfall({ expected: 4, performed: undefined }), {
    expected: 4,
    performed: 0,
    ungraded: [],
  });
});

test("an absent DENOMINATOR is `no anchor`, which is not the same statement as `compared nothing`", () => {
  // No approved set exists to fall short of (no baseline yet, a legacy unstamped anchor).
  // That is never a shortfall, and it is never an anchor either: silence is not evidence.
  assert.equal(comparisonShortfall({}), null);
  assert.equal(comparisonShortfall({ performed: 0 }), null);
  assert.equal(comparisonShortfall(undefined), null);
  assert.equal(comparisonShortfall(null), null);
  assert.equal(anchoredByComparison({}), false);
  assert.equal(anchoredByComparison({ performed: 7 }), false);
  assert.equal(anchoredByComparison(undefined), false);
});

test("a ZERO denominator is not an anchor (nothing was promised, so nothing was proved)", () => {
  assert.equal(comparisonShortfall({ expected: 0, performed: 0 }), null);
  assert.equal(anchoredByComparison({ expected: 0, performed: 0 }), false);
});

test("a NON-FINITE count cannot buy an anchor", () => {
  // `NaN`/`Infinity` survive `JSON.parse` of a hand-edited document via `1e999`, and a
  // bare `performed > expected` comparison answers "no shortfall" for NaN.
  assert.deepEqual(comparisonShortfall({ expected: 3, performed: Number.NaN }), {
    expected: 3,
    performed: 0,
    ungraded: [],
  });
  assert.equal(anchoredByComparison({ expected: Number.POSITIVE_INFINITY, performed: 1 }), false);
  assert.equal(anchoredByComparison({ expected: Number.NaN, performed: Number.NaN }), false);
});

/*
 * THE PROPERTY PR #80 WAS EXPLICIT ABOUT: the verdict is read from the NUMBERS, never
 * from a boolean beside them.
 *
 * A gate that also raises a `harnessFault` flag writes both in the same statement, so in
 * a report this tool produced they always agree. The numbers matter for a report it did
 * NOT produce: deleting the flag from a hand-edited document must not launder anything.
 */
test("MOAT: deleting a boolean flag from a report cannot launder a shortfall", () => {
  const asWritten = {
    visualHarnessFault: true,
    visualHarnessFaultReason: "3 approved frames, 0 compared",
    comparisonsExpected: 3,
    comparisonsPerformed: 0,
  };
  const coverageOf = (r: { comparisonsExpected?: number; comparisonsPerformed?: number }) => ({
    expected: r.comparisonsExpected,
    performed: r.comparisonsPerformed,
  });
  assert.notEqual(comparisonShortfall(coverageOf(asWritten)), null, "control: the shortfall is visible");

  const laundered: Record<string, unknown> = { ...asWritten };
  delete laundered.visualHarnessFault;
  delete laundered.visualHarnessFaultReason;
  assert.notEqual(
    comparisonShortfall(coverageOf(laundered as typeof asWritten)),
    null,
    "the flags are gone and the shortfall is STILL there: the denominator is what refuses",
  );
  assert.equal(anchoredByComparison(coverageOf(laundered as typeof asWritten)), false);
});

test("the refusal NAMES the ungraded items, and states the harness tier", () => {
  const sentence = comparisonShortfallSentence({
    label: 'trace "happy-path"',
    subject: "approved frame",
    shortfall: { expected: 3, performed: 1, ungraded: ["mid", "end"] },
  });
  assert.match(sentence, /trace "happy-path"/);
  assert.match(sentence, /declares 3 approved frame\(s\) but this run compared 1/);
  assert.match(sentence, /mid, end were never compared/, "per item, not just a count");
  assert.match(sentence, /harness tier 2/, "a gate that could not run is never a game defect");
  assert.equal(COMPARISON_SHORTFALL_EXIT, 2);
});

test("the refusal still counts when the gate can only count, not name", () => {
  // A caller that has the two numbers and no ids must still produce a refusal, or the
  // "name the items" requirement would become a reason to say nothing.
  const sentence = comparisonShortfallSentence({
    label: "slice core",
    subject: "declared evidence file",
    shortfall: { expected: 4, performed: 0, ungraded: [] },
  });
  assert.match(sentence, /declares 4 declared evidence file\(s\) but this run compared 0/);
  assert.doesNotMatch(sentence, /never compared/, "no invented item names");
});

test("one ungraded item reads `was`, several read `were`", () => {
  assert.match(
    comparisonShortfallSentence({ label: "x", subject: "state", shortfall: { expected: 2, performed: 1, ungraded: ["start"] } }),
    /start was never compared/,
  );
  assert.match(
    comparisonShortfallSentence({ label: "x", subject: "state", shortfall: { expected: 3, performed: 1, ungraded: ["a", "b"] } }),
    /a, b were never compared/,
  );
});
