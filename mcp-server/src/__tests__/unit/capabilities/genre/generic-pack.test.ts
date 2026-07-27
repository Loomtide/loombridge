import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { knownGenreIds, resolveGenrePack } from "../../../../capabilities/genre/genre-registry.js";
import { assertValidAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import { assertValidSlicePlan } from "../../../../capabilities/verification/slices.js";

/**
 * The genre-neutral `_generic` pack — the seed a FREE-FORM `--genre <anything>` plans from
 * (CommandSurfaceRedesign W1/D).
 *
 * It is what turned `ungraded` from an unreachable residual state into something a real project can
 * be in, which is what makes D1's "an ungraded game may reach doneness" mean anything. That gives it
 * two obligations a normal pack does not have:
 *
 *  1. It must VALIDATE, or every free-form plan crashes at the seed instead of scaffolding.
 *  2. It must CLAIM NOTHING. A registered pack asserts genre truths on purpose; this one is handed to
 *     a developer whose genre we know nothing about, so any taste it smuggles in gets graded against
 *     a game that never agreed to it. That is the false-green the registry refusal originally existed
 *     to prevent, re-entering through the fallback.
 */

const GENERIC_DIR = path.join(PKG_ROOT, "src", "capabilities", "genre", "genre-packs", "_generic");

function readGeneric<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(GENERIC_DIR, file), "utf-8")) as T;
}

test("_generic validates as an acceptance contract and a slice plan", () => {
  // Not a formality: `plan` seeds this file directly, so an invalid one is a hard crash on the
  // free-form path and nothing else in this file would catch it.
  assert.doesNotThrow(() => assertValidAcceptanceContract(readGeneric("acceptance.json")));
  const plan = assertValidSlicePlan(readGeneric("slices.json"));
  assert.ok(plan.slices.length > 0, "the generic roadmap must have slices");
});

test("_generic is NOT a selectable genre", () => {
  // The underscore prefix is load-bearing. If `_generic` ever became registered it would be
  // plannable as a genre of its own AND would resolve to `graded` — a full Tier-1 claim backed by a
  // template that deliberately asserts nothing. It must stay a fallback, never an identity.
  assert.ok(!knownGenreIds().includes("_generic"), "_generic must not be a registered genre");
  assert.ok(!knownGenreIds().includes("generic"), "nor under its bare name");
  assert.equal(resolveGenrePack("_generic"), null);
  assert.equal(resolveGenrePack("generic"), null);
});

test("_generic asserts NO genre-specific taste", () => {
  const contract = readGeneric<Record<string, unknown>>("acceptance.json");

  // No genre-shaped contract sections. A platformer section here would have a free-form puzzle game
  // graded on platform tiers.
  assert.equal(contract.platformer, undefined);

  // NO feel targets. This is the sharpest one: a feel band is a number the feel gate enforces, so
  // inheriting one from a registered genre would fail a game for missing a target nobody set for it.
  assert.deepEqual(contract.feel, { extra: {} }, "the generic seed must declare zero feel targets");

  // The win rule is an obvious placeholder, not a plausible-looking default that could ship unnoticed.
  assert.match(String((contract.win as { rule?: string }).rule), /declared-by-project/);

  // Genre-shaped gates are explicitly not_applicable, so a free-form build is never asked for
  // captures it structurally cannot produce.
  const gates = (contract.verification as { gates?: Record<string, string> })?.gates ?? {};
  for (const gate of ["reachability", "placement", "platform-tiles", "tile-render", "parallax-motion"]) {
    assert.equal(gates[gate], "not_applicable", `${gate} must be N/A for an unknown genre`);
  }
});

test("_generic declares NO skill bindings", () => {
  // W2: 25 of 29 shipped bindings named skills that did not exist. No shipped skill covers an
  // unknown genre, so naming one here would be that exact fiction, reintroduced at the one entry
  // point built for developers with no pack at all.
  const plan = assertValidSlicePlan(readGeneric("slices.json"));
  const bound = plan.slices.filter((s) => s.skill !== undefined);
  assert.deepEqual(bound, [], `the generic pack must bind no skills, saw ${bound.map((s) => s.id).join(", ")}`);
});

test("_generic gates are a subset of what a genre-neutral build can actually produce", () => {
  // Every gate the generic roadmap requires must be one the acceptance contract has NOT marked
  // not_applicable — otherwise a slice demands proof its own contract disabled, and the free-form
  // project can never go green no matter what the developer builds.
  const contract = readGeneric<{ verification?: { gates?: Record<string, string> } }>("acceptance.json");
  const disabled = Object.entries(contract.verification?.gates ?? {})
    .filter(([, mode]) => mode === "not_applicable")
    .map(([gate]) => gate);

  const plan = assertValidSlicePlan(readGeneric("slices.json"));
  for (const slice of plan.slices) {
    for (const gate of slice.acceptance.gates) {
      assert.ok(
        !disabled.includes(gate),
        `slice "${slice.id}" requires gate "${gate}", which the generic contract marks not_applicable — unreachable green`,
      );
    }
  }
});
