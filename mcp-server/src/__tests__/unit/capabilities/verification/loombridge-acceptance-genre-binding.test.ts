/**
 * ACCEPTANCE.json states the genre it grades: the binding that was missing entirely.
 *
 * THE DEFECT, reproduced verbatim on the branch that was supposed to have closed it. `plan`'s
 * genre-flip guard reads the genres a project already RECORDS from disk, and it read SLICES.json,
 * then FEEL_SPEC.json, then STATE.md. In the DESIGN phase there is no roadmap yet, so with
 * FEEL_SPEC.json and STATE.md deleted the guard had nothing left to compare and could not fire at
 * all: a platformer ACCEPTANCE.json (`win.rule: "all-fruit"`, no `verification` block, so every
 * platformer-shaped gate stays applicable) was stamped `graded` under `STATE.genre = 3d-shooter`.
 *
 * The reason it could happen is that NOTHING bound ACCEPTANCE.json to a genre: the artifact whose
 * CONTENTS ARE the grading was the one artifact that could not say what it graded. So `plan` stamps
 * `genre` into it at seed time, the flip guard reads it, and the doneness slice roll-up refuses when
 * it disagrees with the roadmap being certified.
 *
 * ABSENT IS NO CLAIM, never a default: a legacy or hand-authored contract carries no `genre` and the
 * older evidence sources decide exactly as before. A PRESENT disagreement is what refuses.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { evaluateSliceDoneness } from "../../../../capabilities/verification/doneness.js";
import { assertValidSlicePlan, SLICES_SCHEMA_VERSION } from "../../../../capabilities/verification/slices.js";
import { loombridgePaths, readState } from "../../../../domain/state.js";
import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";

/** Two registered genres, taken from the registry: the litmus forbids genre ids as literals here. */
const [GENRE_A, GENRE_B] = knownGenreIds();

async function silently<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    return { value: await fn(), err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

async function plannedProject(genre: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-acceptance-genre-"));
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.0f1\n", "utf-8");
  const { value } = await silently(() =>
    runPlan({ root, genre, genreExplicit: true, engine: "unity", force: false, allowMissingDesignTarget: true }),
  );
  assert.notEqual(value, 2, "fixture must plan");
  return root;
}

async function readAcceptance(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(loombridgePaths(root).acceptance, "utf-8")) as Record<string, unknown>;
}

/* ───────────────────────────────────────────────────── the stamp ──────────────────────────── */

test("plan stamps the genre into the contract it seeds, for a registered AND a free-form genre", async () => {
  for (const genre of [GENRE_A!, "fixture-unregistered-genre"]) {
    const root = await plannedProject(genre);
    try {
      assert.equal(
        (await readAcceptance(root)).genre,
        genre,
        `${genre}: the artifact that IS the grading must say which genre it grades`,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

/* ─────────────────────────────────────── the flip guard, with nothing else left ───────────── */

test("the flip guard fires in the DESIGN phase with FEEL_SPEC.json and STATE.md both deleted", async () => {
  // The exact reproduction. No roadmap exists yet (design phase), and the two files the old guard
  // fell back to are gone, so ACCEPTANCE.json's own stamp is the ONLY evidence left.
  const root = await plannedProject(GENRE_A!);
  try {
    const paths = loombridgePaths(root);
    await fs.rm(paths.feelSpec);
    await fs.rm(paths.state);
    assert.equal(await fs.stat(paths.slices).then(() => true, () => false), false, "no roadmap in the design phase");
    const before = await fs.readFile(paths.acceptance, "utf-8");

    const { value: code, err } = await silently(() =>
      runPlan({ root, genre: GENRE_B!, genreExplicit: true, engine: "unity", force: false, allowMissingDesignTarget: true }),
    );

    assert.equal(code, 2, "a half-applied genre change is a precondition failure, not a warning");
    assert.match(err, /NOT ready/);
    assert.match(err, new RegExp(GENRE_A!));
    assert.match(err, new RegExp(GENRE_B!));
    // On-disk outcome: STATE must not come back claiming the new genre over the old contract.
    assert.equal(await fs.readFile(paths.acceptance, "utf-8"), before, "the contract must be untouched");
    assert.equal(
      (await readState(paths))?.genre,
      undefined,
      "a refused run must not write a STATE that disagrees with the contract",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a contract with NO genre stamp is no claim: the older evidence still decides", async () => {
  // Back-compat, and the reason the field is optional. A legacy/hand-authored ACCEPTANCE.json says
  // nothing about its genre; stripping the stamp must restore exactly the pre-stamp behavior rather
  // than refuse everything.
  const root = await plannedProject(GENRE_A!);
  try {
    const paths = loombridgePaths(root);
    const contract = await readAcceptance(root);
    delete contract.genre;
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    await fs.rm(paths.feelSpec);
    await fs.rm(paths.state);

    const { value: code } = await silently(() =>
      runPlan({ root, genre: GENRE_B!, genreExplicit: true, engine: "unity", force: false, allowMissingDesignTarget: true }),
    );
    assert.notEqual(code, 2, "with no claim on disk there is nothing to contradict");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────── the certification end ────────────────────────────── */

/** A one-slice roadmap declaring `genre`, so the roll-up has something to certify. */
function roadmapFor(genre: string) {
  return assertValidSlicePlan({
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre,
    slices: [
      {
        id: "scene",
        title: "Scene",
        dependsOn: [],
        feelIntent: "a scene exists",
        acceptance: { gates: ["manifest"] },
        state: "pending" as const,
      },
    ],
  });
}

test("doneness REFUSES when ACCEPTANCE.json declares a genre the roadmap does not", async () => {
  const root = await plannedProject(GENRE_A!);
  try {
    const paths = loombridgePaths(root);
    const evaluation = await evaluateSliceDoneness(roadmapFor(GENRE_B!), paths);
    assert.equal(evaluation.ok, false);
    assert.ok(
      evaluation.coverageRefusals.some((r) => /ACCEPTANCE\.json declares genre/.test(r)),
      `expected an ACCEPTANCE-vs-roadmap refusal, got: ${evaluation.coverageRefusals.join(" | ")}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness does NOT invent a genre refusal when the two agree, or when the stamp is absent", async () => {
  // Non-vacuity in both directions: the refusal above must be caused by the DISAGREEMENT, not by the
  // check existing at all, and a legacy contract must not become uncertifiable.
  const root = await plannedProject(GENRE_A!);
  try {
    const paths = loombridgePaths(root);
    const agreeing = await evaluateSliceDoneness(roadmapFor(GENRE_A!), paths);
    assert.deepEqual(
      agreeing.coverageRefusals.filter((r) => /ACCEPTANCE\.json declares genre/.test(r)),
      [],
      "matching genres must produce no ACCEPTANCE refusal",
    );

    const contract = await readAcceptance(root);
    delete contract.genre;
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    const unstamped = await evaluateSliceDoneness(roadmapFor(GENRE_B!), paths);
    assert.deepEqual(
      unstamped.coverageRefusals.filter((r) => /ACCEPTANCE\.json declares genre/.test(r)),
      [],
      "an absent stamp is no claim, so there is nothing to contradict",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
