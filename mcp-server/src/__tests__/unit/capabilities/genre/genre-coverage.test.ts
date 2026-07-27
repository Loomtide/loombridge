import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveGenreCoverage,
  promotedFidelityCriteria,
} from "../../../../capabilities/genre/genre-coverage.js";
import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";
import type { GenrePromotionReport } from "../../../../capabilities/genre/genre-contract/promote.js";

/**
 * A promotion report shaped like the one `plan --genre-contract` writes, with the two gap SOURCES
 * deliberately EMPTY. This is the adversarial input for the whole file: a contract author who declares
 * no slice gaps and marks every feel target `measurable-now` must still not be able to reach an empty
 * gap list, because an empty list would present a partially-graded build as a fully graded one.
 */
function reportWithNoAuthoredGaps(genreId: string): GenrePromotionReport {
  return {
    schemaVersion: "0.1.0",
    sourceGenreId: genreId,
    sourceConfidence: "candidate",
    generatedAcceptance: ".loombridge/ACCEPTANCE.json",
    generatedSlices: ".loombridge/SLICES.json",
    promotedCoreSlices: ["core"],
    deferredSlices: [],
    explicitGaps: {},
    measurability: [
      { target: "runSpeed", tag: "measurable-now", bucket: "coreVertical", calculator: "deriveRunSpeed" },
    ],
    refusalConditions: [],
    humanOracleChecks: [],
  } as unknown as GenrePromotionReport;
}

test("a REGISTERED genre is `graded` with no gaps — shipped behavior is unchanged", () => {
  for (const id of knownGenreIds()) {
    const resolved = deriveGenreCoverage({ genre: id, promotion: null });
    assert.equal(resolved.coverage, "graded", `${id} must be graded`);
    assert.equal(resolved.source, "registry");
    assert.deepEqual(resolved.gaps, []);
  }
});

test("a registered genre stays `graded` even with a promotion report present", () => {
  // Registration wins: a project that promoted a contract for a genre that has SINCE been registered
  // upgrades to the full claim without re-planning. That upgrade path is the point of the split.
  const id = knownGenreIds()[0]!;
  const resolved = deriveGenreCoverage({ genre: id, promotion: reportWithNoAuthoredGaps(id) });
  assert.equal(resolved.coverage, "graded");
  assert.equal(resolved.source, "registry");
});

test("an UNREGISTERED genre with a matching promotion report is `partially-graded`", () => {
  const resolved = deriveGenreCoverage({
    genre: "puzzle-hypercasual",
    promotion: reportWithNoAuthoredGaps("puzzle-hypercasual"),
  });
  assert.equal(resolved.coverage, "partially-graded");
  assert.equal(resolved.source, "genre-contract");
  assert.equal(resolved.genre, "puzzle-hypercasual");
});

test("LITMUS: the gap list is NON-EMPTY even when the contract authored no gaps at all", () => {
  // The suppression vector this closes: if gaps came only from the contract's own `explicitGaps` and
  // non-`measurable-now` measurability rows, an author could reach "partially-graded with nothing
  // missing" — a scoped claim that prints like an unscoped one. The first two entries are derived from
  // the ABSENCE of a registration, so no authoring choice can empty them.
  const report = reportWithNoAuthoredGaps("puzzle-hypercasual");
  assert.deepEqual(report.explicitGaps, {}, "fixture must author zero slice gaps");
  assert.ok(
    report.measurability.every((row) => row.tag === "measurable-now"),
    "fixture must author zero unmeasurable targets",
  );

  const resolved = deriveGenreCoverage({ genre: "puzzle-hypercasual", promotion: report });
  assert.ok(resolved.gaps.length >= 2, `expected structural gaps, got ${JSON.stringify(resolved.gaps)}`);
  assert.ok(resolved.gaps.some((g) => /no registered feel oracle/.test(g)));
  assert.ok(resolved.gaps.some((g) => /no hero-shot fidelity criteria/.test(g)));
});

test("declared fidelityCriteria removes ONLY the fidelity gap, never the feel-oracle gap", () => {
  const report = {
    ...reportWithNoAuthoredGaps("puzzle-hypercasual"),
    fidelityCriteria: ["composition-match"],
  };
  const resolved = deriveGenreCoverage({ genre: "puzzle-hypercasual", promotion: report });
  assert.ok(!resolved.gaps.some((g) => /no hero-shot fidelity criteria/.test(g)));
  // The feel-oracle gap is structural: declaring hero-shot criteria says nothing about feel grading,
  // so it must survive. If it did not, a contract could talk its way to an empty gap list.
  assert.ok(resolved.gaps.some((g) => /no registered feel oracle/.test(g)));
  assert.ok(resolved.gaps.length > 0);
});

test("contract-authored gaps are ADDED to the structural ones", () => {
  const report = {
    ...reportWithNoAuthoredGaps("puzzle-hypercasual"),
    explicitGaps: { core: ["no automated check that the board is solvable"] },
    measurability: [
      { target: "chainSatisfaction", tag: "judgment-only", bucket: "coreVertical" },
      { target: "dropSpeed", tag: "needs-new-calculator", bucket: "coreVertical", calculator: "deriveDropSpeed" },
      { target: "runSpeed", tag: "measurable-now", bucket: "coreVertical", calculator: "deriveRunSpeed" },
    ],
  } as unknown as GenrePromotionReport;

  const { gaps } = deriveGenreCoverage({ genre: "puzzle-hypercasual", promotion: report });
  assert.ok(gaps.some((g) => /board is solvable/.test(g)));
  assert.ok(gaps.some((g) => /chainSatisfaction.*judgment-only/.test(g)));
  assert.ok(gaps.some((g) => /dropSpeed.*needs-new-calculator/.test(g)));
  // A `measurable-now` target binds to an implemented calculator, so it is NOT a gap.
  assert.ok(!gaps.some((g) => /runSpeed/.test(g)));
});

test("a promotion report for a DIFFERENT genre does not lend its coverage", () => {
  // The laundering shape: leave a valid report from an earlier genre in `.loombridge/`, flip
  // STATE.genre, and inherit a scoped-pass. The id must match or the report is not evidence.
  const resolved = deriveGenreCoverage({
    genre: "puzzle-hypercasual",
    promotion: reportWithNoAuthoredGaps("some-other-genre"),
  });
  assert.equal(resolved.coverage, "ungraded");
  assert.equal(resolved.source, "none");
});

test("REGRESSION: a mismatched promotion report REFUSES even when the claimed genre IS registered", () => {
  // THE CONFIRMED LAUNDERING ROUTE this ordering exists to close. Reproduced end-to-end before the
  // fix: plan a puzzle game from a contract, hand-edit `STATE.genre` to "platformer-2d", delete
  // SLICES.json to take the whole-game path, and `doneness` printed
  //   "OK — fresh + green"
  // as a FULL `graded` pass, graded against platformer feel and fidelity criteria, while
  // GENRE_PROMOTION.json on disk still read `sourceGenreId: "puzzle-hypercasual"`.
  //
  // The bug was pure ORDERING: the registry check ran first, so a mismatched report was treated as
  // irrelevant rather than as a contradiction, and the short-circuit awarded the higher claim.
  //
  // LITMUS: move the contradiction check below the registry check in deriveGenreCoverage and this
  // test fails with coverage "graded" — the exact false green. The `some-other-genre` case above
  // does NOT catch it, because that genre is unregistered and so never reaches the short-circuit.
  const registered = knownGenreIds()[0]!;
  const resolved = deriveGenreCoverage({
    genre: registered,
    promotion: reportWithNoAuthoredGaps("puzzle-hypercasual"),
  });
  assert.equal(resolved.coverage, "ungraded", "a registered genre must NOT out-rank a contradicting report");
  assert.equal(resolved.source, "none");
  assert.ok(resolved.gaps.some((g) => /CONTRADICTION/.test(g)), resolved.gaps.join(" | "));
  // Both sides of the contradiction must be named, or the developer cannot tell which file is wrong.
  assert.ok(resolved.gaps.some((g) => g.includes(registered) && g.includes("puzzle-hypercasual")));
});

test("no registration and no report is `ungraded` with a non-empty, actionable gap list", () => {
  const resolved = deriveGenreCoverage({ genre: "puzzle-hypercasual", promotion: null });
  assert.equal(resolved.coverage, "ungraded");
  assert.equal(resolved.source, "none");
  assert.ok(resolved.gaps.length > 0, "even a refusal must say what is missing");
  assert.match(resolved.gaps[0]!, /--genre-contract/);
});

test("every non-graded coverage carries a non-empty gap list (the D1 precondition)", () => {
  // The product decision was "an ungraded game may pass PROVIDED the gap list is mandatory and
  // non-empty". This asserts the precondition holds across every non-graded shape, so no caller has to
  // defend against an empty list.
  const cases = [
    deriveGenreCoverage({ genre: "x", promotion: null }),
    deriveGenreCoverage({ genre: "x", promotion: reportWithNoAuthoredGaps("x") }),
    deriveGenreCoverage({ genre: "x", promotion: reportWithNoAuthoredGaps("y") }),
  ];
  for (const resolved of cases) {
    if (resolved.coverage === "graded") continue;
    assert.ok(resolved.gaps.length > 0, `${resolved.coverage} must enumerate gaps`);
    assert.ok(resolved.gaps.every((g) => g.trim().length > 0));
  }
});

test("promotedFidelityCriteria: matching genre only, empty coerces to null", () => {
  const report = { ...reportWithNoAuthoredGaps("puzzle"), fidelityCriteria: ["composition-match"] };
  assert.deepEqual(promotedFidelityCriteria("puzzle", report), ["composition-match"]);
  // Wrong genre, absent report, and an empty list all resolve to null — the caller then refuses rather
  // than grading against an empty (vacuously passing) criteria set.
  assert.equal(promotedFidelityCriteria("other", report), null);
  assert.equal(promotedFidelityCriteria("puzzle", null), null);
  assert.equal(
    promotedFidelityCriteria("puzzle", { ...reportWithNoAuthoredGaps("puzzle"), fidelityCriteria: [] }),
    null,
  );
});
