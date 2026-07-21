import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_GENRE_ID,
  defaultGenreId,
  genreFidelityCriteria,
  knownGenreIds,
  resolveFeelProfileModule,
  resolveGenrePack,
  scenarioPacks,
} from "../loomtide/genre-registry.js";
import { HERO_SHOT_FIDELITY_CRITERIA, VLM_REVIEW_CRITERION_IDS, fidelityCriteriaForGenre } from "../loomtide/doneness.js";
import { SHIPPED_PROFILE_IDS } from "../loomtide/genre-packs/platformer-2d/profiles.js";
import { unknownProfileMessage } from "../loomtide/genre-packs/platformer-2d/verify-profile.js";

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
  assert.deepEqual(knownGenreIds(), ["platformer-2d", "2d-shooter", "3d-shooter"]);
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
    assert.match(r.refusal, /not a registered genre/i);
  }
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
  // resolve, or an argument-less `loomtide plan` would crash with "unknown genre".
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
