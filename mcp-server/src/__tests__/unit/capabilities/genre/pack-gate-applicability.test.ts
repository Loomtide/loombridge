/**
 * Every shipped pack declares which platformer-shaped gates DO NOT apply to it (GenreGenericity S1).
 *
 * `isGateApplicable` is one line: a gate is skipped only when
 * `acceptance.verification.gates[gate] === "not_applicable"`. An OMITTED block therefore means
 * "every gate applies", so the `2d-shooter`, `3d-shooter`, and `3d-topdown-arena` templates, which
 * carried no `verification` block at all, were graded on parallax layers, platform tiers, tile
 * seams, reachability, and placement. Their slice-level gate lists happen to avoid those gates, so
 * `verify --slice` was clean and the hole was only reachable on a WHOLE-GAME verify: which is the
 * run `doneness` certifies from.
 *
 * The declared set mirrors `promote.ts`'s `verificationOverrides` rather than inventing a second
 * policy: one gate per contract section the template deliberately omits
 * (`platformer` / `reachability` / `placement` / `props`).
 *
 * AND THE PACK NOTES SAY SO, WHICH MADE THEM CHECKABLE. Those notes assert "the same rule promote.ts
 * applies to a promoted GenreContract, and the same set _generic declares", and that was FALSE:
 * `promote.ts` disabled five gates, omitting `prop-purpose`, which is pure 2D geometry with no
 * `props` section defaults, so a contract-planned 3D game was graded on props it never declared.
 * Three hand-maintained JSON lists plus one TypeScript array is four places to drift, so all four are
 * bound to the SAME exported constant below, with a litmus proving the binding fires.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { resolveGenrePack } from "../../../../capabilities/genre/genre-registry.js";
import { CONTRACT_OMITTED_SECTION_GATES } from "../../../../capabilities/genre/genre-contract/promote.js";
import { runGates } from "../../../../capabilities/verification/run-gates.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import { assertValidSlicePlan } from "../../../../capabilities/verification/slices.js";

/** The ONE list: what `promote.ts` marks inapplicable for a contract that omits those sections. */
const PLATFORMER_SHAPED = CONTRACT_OMITTED_SECTION_GATES;

const NON_PLATFORMER_PACKS = ["2d-shooter", "3d-shooter", "3d-topdown-arena"] as const;

/**
 * The genre-neutral fallback pack. Not in the registry (its `_` prefix keeps it out of
 * `knownGenreIds()`), so its template is addressed by path: the same path `plan.ts` seeds from.
 */
const GENERIC_ACCEPTANCE = path.join(
  PKG_ROOT,
  "src/capabilities/genre/genre-packs/_generic/acceptance.json",
);

/** The gate ids a template declares `not_applicable`, sorted. */
function disabledGates(acceptance: AcceptanceContract): string[] {
  return Object.entries(acceptance.verification?.gates ?? {})
    .filter(([, mode]) => mode === "not_applicable")
    .map(([gate]) => gate)
    .sort();
}

/** An inputs dir that exists but stages nothing, so any APPLICABLE gate degrades to `warn`. */
const EMPTY_INPUTS = PKG_ROOT;

function readAcceptance(genre: string): AcceptanceContract {
  const pack = resolveGenrePack(genre);
  assert.ok(pack, `${genre} must be registered`);
  return JSON.parse(readFileSync(pack.acceptanceTemplatePath, "utf-8")) as AcceptanceContract;
}

for (const genre of NON_PLATFORMER_PACKS) {
  test(`${genre}: the platformer-shaped gates are not_applicable on a WHOLE-GAME verify`, async () => {
    // Through the real runner, not by reading the JSON back: the JSON is only the input to
    // `isGateApplicable`, and asserting on it would pass even if the runner ignored the block.
    const report = await runGates({ acceptance: readAcceptance(genre), inputsDir: EMPTY_INPUTS });
    for (const gate of PLATFORMER_SHAPED) {
      assert.ok(gate in report.gates, `${genre}: gate "${gate}" missing from the whole-game report`);
      assert.equal(
        report.gates[gate],
        "not_applicable",
        `${genre}: gate "${gate}" is still applicable, so a whole-game verify grades this genre on ` +
          "content it never declared",
      );
    }
  });

  test(`${genre}: no slice requires a gate its own contract disabled`, async () => {
    // The mirror risk of the fix: marking a gate not_applicable that a slice's `acceptance.gates`
    // still demands makes that slice unreachable-green no matter what the developer builds.
    const pack = resolveGenrePack(genre)!;
    const acceptance = readAcceptance(genre);
    const disabled = disabledGates(acceptance);
    const plan = assertValidSlicePlan(JSON.parse(readFileSync(pack.sliceTemplatePath, "utf-8")));
    for (const slice of plan.slices) {
      for (const gate of slice.acceptance.gates) {
        assert.ok(
          !disabled.includes(gate),
          `${genre}: slice "${slice.id}" requires gate "${gate}", which the contract marks not_applicable`,
        );
      }
    }
  });
}

test("the shipped templates and promote.ts declare the SAME set, so the pack notes are true", () => {
  // The notes in those pack files say "the same rule promote.ts applies to a promoted GenreContract,
  // and the same set _generic declares". That sentence is the binding; this is the check that keeps
  // it honest, in the one direction that matters: a gate dropped from `promote.ts` leaves a
  // contract-planned game graded on a section it never declared.
  const want = [...PLATFORMER_SHAPED].sort();
  for (const genre of NON_PLATFORMER_PACKS) {
    assert.deepEqual(disabledGates(readAcceptance(genre)), want, `${genre}'s template drifted from promote.ts`);
  }
  assert.deepEqual(
    disabledGates(JSON.parse(readFileSync(GENERIC_ACCEPTANCE, "utf-8")) as AcceptanceContract),
    want,
    "_generic drifted from promote.ts",
  );
});

test("LITMUS: the declared-set binding fires on a template missing one gate", () => {
  // A set comparison that cannot fail certifies the drift it was written to catch. Prove it in both
  // directions, in memory.
  const want = [...PLATFORMER_SHAPED].sort();
  const shipped = disabledGates(readAcceptance(NON_PLATFORMER_PACKS[0]));
  assert.deepEqual(shipped, want, "the shipped template must already agree");
  assert.notDeepEqual(shipped.filter((g) => g !== "prop-purpose"), want, "a dropped gate must be caught");
  assert.notDeepEqual([...shipped, "console-clean"].sort(), want, "an extra gate must be caught");
  // The specific regression: `prop-purpose` must be in the list `promote.ts` exports, not only in
  // the JSON templates. If it were only in the JSON, a promoted contract would still be graded on it.
  assert.ok(
    (CONTRACT_OMITTED_SECTION_GATES as readonly string[]).includes("prop-purpose"),
    "promote.ts must disable prop-purpose for a contract with no `props` section",
  );
});

test("platformer-2d: the same gates STAY applicable (the block is a per-genre answer, not a blanket off-switch)", async () => {
  // The contrast that makes the assertions above mean something: these gates are the platformer's
  // real oracle, so a fix that disabled them everywhere would read as green here too.
  const report = await runGates({ acceptance: readAcceptance("platformer-2d"), inputsDir: EMPTY_INPUTS });
  for (const gate of PLATFORMER_SHAPED) {
    assert.ok(gate in report.gates, `platformer-2d: gate "${gate}" missing from the whole-game report`);
    assert.notEqual(
      report.gates[gate],
      "not_applicable",
      `platformer-2d must still be graded on "${gate}"`,
    );
  }
});
