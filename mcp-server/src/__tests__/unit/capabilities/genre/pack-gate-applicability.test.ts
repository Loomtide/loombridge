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
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { resolveGenrePack } from "../../../../capabilities/genre/genre-registry.js";
import { runGates } from "../../../../capabilities/verification/run-gates.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import { assertValidSlicePlan } from "../../../../capabilities/verification/slices.js";

/** The gates `promote.ts` marks inapplicable for a non-platformer contract, plus `prop-purpose`. */
const PLATFORMER_SHAPED = [
  "platform-tiles",
  "tile-render",
  "parallax-motion",
  "reachability",
  "placement",
  "prop-purpose",
] as const;

const NON_PLATFORMER_PACKS = ["2d-shooter", "3d-shooter", "3d-topdown-arena"] as const;

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
    const disabled = Object.entries(acceptance.verification?.gates ?? {})
      .filter(([, mode]) => mode === "not_applicable")
      .map(([gate]) => gate);
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
