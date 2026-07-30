import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { assertValidAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import { assertValidSlicePlan } from "../../../../capabilities/verification/slices.js";

import {
  DEFAULT_GENRE_ID,
  defaultGenreId,
  genreFidelityCriteria,
  knownGenreIds,
  resolveFeelProfileModule,
  resolveGenrePack,
  scenarioPacks,
} from "../../../../capabilities/genre/genre-registry.js";
import { HERO_SHOT_FIDELITY_CRITERIA, VLM_REVIEW_CRITERION_IDS, fidelityCriteriaForGenre } from "../../../../capabilities/verification/doneness.js";
import { SHIPPED_PROFILE_IDS } from "../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js";
import { unknownProfileMessage } from "../../../../capabilities/genre/genre-packs/platformer-2d/verify-profile.js";

test("genre registry resolves platformer-2d to real template paths", () => {
  const pack = resolveGenrePack("platformer-2d");
  assert.ok(pack, "platformer-2d must be registered");
  assert.equal(pack!.id, "platformer-2d");
  // The resolved template paths must point at files that actually exist (the JSON lives under src/).
  assert.ok(existsSync(pack!.acceptanceTemplatePath), `acceptance template missing: ${pack!.acceptanceTemplatePath}`);
  assert.ok(existsSync(pack!.sliceTemplatePath), `slice template missing: ${pack!.sliceTemplatePath}`);
});

test("genre registry REFUSES an unknown genre (no default-to-platformer)", () => {
  assert.equal(resolveGenrePack("does-not-exist"), null);
  assert.equal(resolveGenrePack(""), null);
  // A prototype key must not resolve (hasOwnProperty guard).
  assert.equal(resolveGenrePack("toString"), null);
  assert.equal(resolveGenrePack("constructor"), null);
});

test("knownGenreIds lists exactly the registered genres", () => {
  assert.deepEqual(knownGenreIds(), ["platformer-2d", "2d-shooter", "3d-shooter", "3d-topdown-arena"]);
});

test("EVERY registered genre's templates exist AND parse through their own validators", () => {
  // THE BLIND SPOT THIS CLOSES: the per-genre tests above hand-write an existsSync pair each, so a
  // FOURTH registration got no path check at all — a declared path nothing walks, which is this repo's
  // most expensive recurring failure. Existence is also not enough: a registration pointing at a file
  // that exists but does not validate fails at `loombridge plan` runtime, not here. So walk the whole
  // registry and run each template through the validator that will consume it.
  //
  // LITMUS: point any registration's sliceTemplatePath at its acceptance.json (a real, existing file)
  // and this test fails on the SlicePlan validator; an existsSync-only check would pass.
  const ids = knownGenreIds();
  assert.ok(ids.length > 0, "expected at least one registered genre");
  for (const id of ids) {
    const pack = resolveGenrePack(id)!;
    assert.ok(existsSync(pack.acceptanceTemplatePath), `${id}: acceptance template missing: ${pack.acceptanceTemplatePath}`);
    assert.ok(existsSync(pack.sliceTemplatePath), `${id}: slice template missing: ${pack.sliceTemplatePath}`);

    assert.doesNotThrow(
      () => assertValidAcceptanceContract(JSON.parse(readFileSync(pack.acceptanceTemplatePath, "utf-8"))),
      `${id}: acceptance template does not validate as an acceptance contract`,
    );
    const plan = assertValidSlicePlan(JSON.parse(readFileSync(pack.sliceTemplatePath, "utf-8")));
    assert.ok(plan.slices.length > 0, `${id}: slice template has no slices`);
  }
});

test("every pack slice that grades feel.json also runs feel-rederive (L48)", () => {
  // The ledger case: platformer-2d's `player-feel` listed feel, feel-provenance,
  // physics-timestep and console-clean, so a 103KB evidence file full of real
  // trajectory samples was graded on its four HEADLINE numbers and the one gate
  // that binds those numbers to the samples never ran. A slice that grades the
  // headline without the binding is exactly the moat hole, so pin the pairing for
  // every pack, not just the one that got caught.
  //
  // LITMUS: remove "feel-rederive" from platformer-2d/slices.json and this fails.
  const bindingGates = ["feel", "feel-provenance"];
  let checked = 0;
  for (const id of knownGenreIds()) {
    const pack = resolveGenrePack(id)!;
    const plan = assertValidSlicePlan(JSON.parse(readFileSync(pack.sliceTemplatePath, "utf-8")));
    for (const slice of plan.slices) {
      const gates = slice.acceptance.gates;
      if (!bindingGates.some((g) => gates.includes(g))) continue;
      checked += 1;
      assert.ok(
        gates.includes("feel-rederive"),
        `${id}/${slice.id} grades feel evidence (${gates.join(", ")}) without feel-rederive: the reported numbers are never bound to the samples they claim to come from`,
      );
    }
  }
  assert.ok(checked > 0, "expected at least one feel-grading slice across the registered packs");
});

test("3d-topdown-arena is registered — the pack shipped complete but unreachable", () => {
  // It shipped with a validating acceptance contract (whose own note calls itself a seed for
  // `plan --genre 3d-topdown-arena`) and an 11-slice DAG, but no registration, so the front door could
  // not reach it. The template walk above covers the files; this pins the registration itself.
  const pack = resolveGenrePack("3d-topdown-arena");
  assert.ok(pack, "3d-topdown-arena must be registered");
  const criteria = genreFidelityCriteria("3d-topdown-arena") ?? [];
  assert.ok(criteria.length > 0);
  // Arena-shaped, not platformer-shaped.
  assert.ok(!criteria.includes("platform-tiers"));
  assert.ok(!criteria.includes("parallax-present"));
  // No feel profile and no scenario pack yet — must not leak into the scenario-pack auto-selection.
  assert.equal(pack!.loadFeelProfileModule, undefined);
  assert.ok(!scenarioPacks().some((p) => p.gameKind === "3d-topdown-arena"));
});

test("2d-shooter is registered with valid, existing templates and shooter-specific fidelity", () => {
  const pack = resolveGenrePack("2d-shooter");
  assert.ok(pack, "2d-shooter must be registered");
  assert.ok(existsSync(pack!.acceptanceTemplatePath), `shooter acceptance template missing: ${pack!.acceptanceTemplatePath}`);
  assert.ok(existsSync(pack!.sliceTemplatePath), `shooter slice template missing: ${pack!.sliceTemplatePath}`);
  // Shooter fidelity criteria are shooter-shaped (no platformer parallax/platform-tier checks).
  assert.ok((genreFidelityCriteria("2d-shooter") ?? []).length > 0);
  assert.ok(!(genreFidelityCriteria("2d-shooter") ?? []).includes("platform-tiers"));
});

test("3d-shooter is registered with valid, existing templates and 3D-shooter-shaped fidelity", () => {
  const pack = resolveGenrePack("3d-shooter");
  assert.ok(pack, "3d-shooter must be registered");
  assert.ok(existsSync(pack!.acceptanceTemplatePath), `3d-shooter acceptance template missing: ${pack!.acceptanceTemplatePath}`);
  assert.ok(existsSync(pack!.sliceTemplatePath), `3d-shooter slice template missing: ${pack!.sliceTemplatePath}`);
  // Fidelity criteria are structural (no platformer parallax/platform-tier checks), non-empty, and
  // every id is in the VLM allow-list (the EVERY-genre cross-table test below enforces the last part).
  const criteria = genreFidelityCriteria("3d-shooter") ?? [];
  assert.ok(criteria.length > 0);
  assert.ok(!criteria.includes("platform-tiers"));
  assert.ok(!criteria.includes("parallax-present"));
  // The 3D seed ships no verify-first feel profile and no bundled scenario pack yet (both await the
  // first live 3D capture), so it must not leak into the scenario-pack list.
  assert.equal(pack!.loadFeelProfileModule, undefined);
  assert.ok(!scenarioPacks().some((p) => p.gameKind === "3d-shooter"));
});

test("genreFidelityCriteria is registry-sourced, non-empty, and matches the platformer doneness default", () => {
  // Drift guard: doneness keeps a robust literal default; the registry must carry the same set so
  // the genre-dispatched path is byte-identical for platformer-2d.
  assert.deepEqual(genreFidelityCriteria("platformer-2d"), [...HERO_SHOT_FIDELITY_CRITERIA]);
  // Refuse-don't-default: an unregistered genre yields null (caller falls back / refuses), never an
  // empty set that would vacuously pass the structural fidelity check.
  assert.equal(genreFidelityCriteria("2d-shooter-unregistered"), null);
  assert.ok((genreFidelityCriteria("platformer-2d") ?? []).length > 0);
});

test("fidelityCriteriaForGenre REFUSES an unregistered genre — doneness never defaults to platformer", () => {
  // A registered genre resolves its criteria...
  const platformer = fidelityCriteriaForGenre("platformer-2d");
  assert.ok("criteria" in platformer);
  assert.deepEqual(platformer.criteria, [...HERO_SHOT_FIDELITY_CRITERIA]);
  const shooter = fidelityCriteriaForGenre("2d-shooter");
  assert.ok("criteria" in shooter);
  // ...but an unknown/unregistered genre is a REFUSAL (the "unknown genre is refused, not defaulted"
  // invariant): a stale/hand-edited state.genre must not certify a design-targeted build against the
  // platformer criteria.
  for (const bogus of ["unknown", "fps-3d-unregistered", ""]) {
    const r = fidelityCriteriaForGenre(bogus);
    assert.ok("refusal" in r, `genre "${bogus}" must refuse, not resolve`);
    assert.match(r.refusal, /refusing/i);
    // The invariant, not the wording: the refusal must say it is NOT falling back to platformer.
    assert.match(r.refusal, /never defaulted to platformer/i);
  }
  // A promotion report is now a second source of criteria, but ONLY for the genre it names and only
  // when it declares them — it must not become a way for any genre to borrow criteria.
  const promotion = {
    sourceGenreId: "puzzle-hypercasual",
    fidelityCriteria: ["composition-match"],
  } as never;
  const declared = fidelityCriteriaForGenre("puzzle-hypercasual", promotion);
  assert.ok("criteria" in declared, "a contract-declared criteria set must resolve");
  assert.deepEqual([...declared.criteria], ["composition-match"]);
  // ...but the SAME report does nothing for a different genre.
  assert.ok("refusal" in fidelityCriteriaForGenre("some-other-genre", promotion));
});

test("fidelityCriteriaForGenre RE-VALIDATES contract-declared criteria at gate time", () => {
  // GENRE_PROMOTION.json lives inside the project and is editable, so `plan`-time validation of the
  // source contract is NOT a trust boundary. An ungradable id must REFUSE — never be silently dropped,
  // which would shrink the set the build has to satisfy and make doneness easier to reach.
  const forged = {
    sourceGenreId: "puzzle-hypercasual",
    fidelityCriteria: ["composition-match", "looks-great-honestly"],
  } as never;
  const r = fidelityCriteriaForGenre("puzzle-hypercasual", forged);
  assert.ok("refusal" in r, "an ungradable declared criterion must refuse");
  assert.match(r.refusal, /looks-great-honestly/);
  // LITMUS: if the re-validation were dropped and the bad id merely filtered out, the call would
  // resolve to ["composition-match"] and this assertion would fail.
  assert.ok(!("criteria" in r));

  // An EMPTY declared list is not "no requirement" — it coerces to no-criteria and refuses, so it can
  // never make the structural fidelity check pass vacuously.
  const empty = { sourceGenreId: "puzzle-hypercasual", fidelityCriteria: [] } as never;
  assert.ok("refusal" in fidelityCriteriaForGenre("puzzle-hypercasual", empty));
});

test("EVERY registered genre's fidelityCriteria are GRADABLE by the VLM review-shape validator", () => {
  // The moat contract: doneness REQUIRES each fidelity criterion to appear in vlm-review.json with a
  // pass, but validateVlmReviewFindingsShape rejects any criterion id outside VLM_REVIEW_CRITERION_IDS.
  // A registered criterion absent from that allow-list makes the genre's doneness UNREACHABLE-green.
  for (const id of knownGenreIds()) {
    for (const criterion of resolveGenrePack(id)!.fidelityCriteria) {
      assert.ok(
        VLM_REVIEW_CRITERION_IDS.has(criterion),
        `genre "${id}" fidelity criterion "${criterion}" is not in VLM_REVIEW_CRITERION_IDS — doneness would be unreachable-green`,
      );
    }
  }
});

test("scenarioPacks resolves the platformer bundled pack + a working match predicate", () => {
  // capture-runner selects from this list instead of hard-coding a platformer pack.
  const packs = scenarioPacks();
  const platformer = packs.find((p) => p.id === "platformer-2d-basic");
  assert.ok(platformer, "platformer-2d must declare its bundled scenario pack");
  assert.equal(platformer!.gameKind, "platformer-2d");
  assert.equal(platformer!.fileName, "platformer-2d-basic.json");
  // The predicate matches a contract carrying a `platformer` gate-tuning section, and only that.
  assert.equal(platformer!.matches({ platformer: {} } as never), true);
  assert.equal(platformer!.matches({} as never), false);
});

test("the default genre is a registered genre (plan carries no genre literal)", () => {
  // plan.ts resolves its omitted-`--genre` default through defaultGenreId(); that value must always
  // resolve, or an argument-less `loombridge plan` would crash with "unknown genre".
  assert.equal(defaultGenreId(), DEFAULT_GENRE_ID);
  assert.ok(resolveGenrePack(defaultGenreId()), "default genre must be registered");
  assert.ok(knownGenreIds().includes(defaultGenreId()));
});

test("resolveFeelProfileModule resolves the verify-first runner for a shipped platformer profile", async () => {
  for (const id of SHIPPED_PROFILE_IDS) {
    const resolved = await resolveFeelProfileModule(id);
    assert.ok("module" in resolved, `profile "${id}" must resolve to a feel-profile module`);
    assert.equal(typeof resolved.module.runVerifyProfile, "function");
    assert.deepEqual([...resolved.module.SHIPPED_PROFILE_IDS], [...SHIPPED_PROFILE_IDS]);
  }
});

test("resolveFeelProfileModule REFUSES an unknown profile with the pack's own message (byte-identical)", async () => {
  // Decoupling must not change the verify-first UX: the registry-routed refusal is exactly the
  // message the direct `unknownProfileMessage` import produced before, so `verify --profile bogus`
  // prints the same guidance and exits 2.
  for (const bogus of ["bogus", "", "Precision"]) {
    const resolved = await resolveFeelProfileModule(bogus);
    assert.ok("unknownMessage" in resolved, `profile "${bogus}" must not resolve to a module`);
    assert.equal(resolved.unknownMessage, unknownProfileMessage(bogus));
  }
});

test("EVERY registered genre carries a non-empty fidelityCriteria (no vacuous fidelity pass)", () => {
  // Forward guard for Phase 2+: a pack registered with an empty criteria set must never reach the
  // moat as a free pass. genreFidelityCriteria coerces empty → null (→ caller falls back), and this
  // asserts no shipped registration relies on that coercion.
  for (const id of knownGenreIds()) {
    const pack = resolveGenrePack(id)!;
    assert.ok(pack.fidelityCriteria.length > 0, `genre "${id}" must declare ≥1 fidelity criterion`);
    assert.deepEqual(genreFidelityCriteria(id), pack.fidelityCriteria);
  }
});
