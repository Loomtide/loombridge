/**
 * `loombridge plan` REFUSES to guess the genre (GenreGenericity S1).
 *
 * The defect this closes: bare `plan` initialised `genre` to the registry default, which resolves
 * to a REGISTERED pack, so the "unregistered genre" warning never fired and the project got a full
 * `graded` coverage stamp over another genre's contract. Confirmed live on a project named
 * `ExtractionShooter`: `win.rule: "all-fruit"`, nine platformer feel metrics, a `platformer`
 * section, and no `verification.gates` block, so the platformer-shaped gates stayed applicable.
 * That is the only route in the system to a wrong `graded` claim; everything else that is
 * unsupported is loudly scoped.
 *
 * The guard has to hold WITHOUT breaking the four paths that legitimately need no `--genre`:
 * a re-plan (STATE already records the genre), `--genre-contract`, `--brief`, and the
 * single-registered-genre case the default was written for.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run, unstatedGenreRefusal } from "../../../../capabilities/verification/plan.js";
import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";
import { fileExists, loombridgePaths, readState } from "../../../../domain/state.js";

const EXAMPLE_CONTRACT = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-contract",
  "examples",
  "2d-shooter.contract.json",
);

async function unityRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-refusal-"));
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(
    path.join(root, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.0f1\n",
    "utf-8",
  );
  return root;
}

/** Run the CLI entry point capturing console.error + the exit code. */
async function runCli(args: string[]): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const code = await run(args);
    return { code, err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

// ── the refusal ──────────────────────────────────────────────────────────────

test("plan: bare `plan` in a fresh project REFUSES to guess the genre (exit 2)", async () => {
  const root = await unityRoot();
  try {
    assert.ok(knownGenreIds().length > 1, "this guard only binds while more than one pack ships");
    const { code, err } = await runCli(["--root", root, "--allow-missing-design-target"]);
    assert.equal(code, 2, "a missing required argument is a usage/precondition error, not a failed check");
    assert.match(err, /--genre is required/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: the refusal writes NOTHING (no half-scaffolded .loombridge/)", async () => {
  // A refusal that has already seeded ACCEPTANCE.json is not a refusal: the next bare `plan` would
  // read the genre back out of the STATE it just wrote and proceed with the guessed genre after all.
  const root = await unityRoot();
  try {
    await runCli(["--root", root, "--allow-missing-design-target"]);
    assert.equal(await fileExists(path.join(root, ".loombridge")), false, ".loombridge/ must not exist");
    const paths = loombridgePaths(root);
    for (const p of [paths.state, paths.acceptance, paths.slices, paths.feelSpec, paths.gameSpec]) {
      assert.equal(await fileExists(p), false, `${path.basename(p)} must not have been written`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: the refusal names every registered id and both escape hatches", async () => {
  const root = await unityRoot();
  try {
    const { err } = await runCli(["--root", root, "--allow-missing-design-target"]);
    // Built from `knownGenreIds()`, never a hard-coded list: registering a fifth pack must widen
    // the message on its own (and the genre-core LITMUS forbids the literals in `capabilities/`).
    for (const id of knownGenreIds()) {
      assert.ok(err.includes(id), `refusal must name the registered genre "${id}"`);
    }
    assert.match(err, /--genre <id>/);
    assert.match(err, /--genre-contract <path>/);
    assert.match(err, /--brief <path>/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── every path that legitimately needs no --genre ────────────────────────────

test("plan: an explicit --genre still plans", async () => {
  const root = await unityRoot();
  try {
    const { code, err } = await runCli([
      "--root", root,
      "--genre", "3d-topdown-arena",
      "--allow-missing-design-target",
    ]);
    assert.notEqual(code, 2, err);
    assert.doesNotMatch(err, /--genre is required/);
    const state = await readState(loombridgePaths(root));
    assert.equal(state?.genre, "3d-topdown-arena");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: a prior STATE.genre lets BARE `plan` proceed (the re-plan path does not regress)", async () => {
  // The whole point of the refusal is that a developer states the genre ONCE. If a re-plan needed
  // the flag again, every later `plan` in the slice loop would refuse and the loop would stop.
  const root = await unityRoot();
  try {
    await runCli(["--root", root, "--genre", "2d-shooter", "--allow-missing-design-target"]);
    const { code, err } = await runCli(["--root", root, "--allow-missing-design-target"]);
    assert.notEqual(code, 2, err);
    assert.doesNotMatch(err, /--genre is required/);
    const state = await readState(loombridgePaths(root));
    assert.equal(state?.genre, "2d-shooter", "the recorded genre wins, it is not reset to the default");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: --genre-contract supplies the genre, so no --genre is needed", async () => {
  const root = await unityRoot();
  try {
    const { code, err } = await runCli([
      "--root", root,
      "--genre-contract", EXAMPLE_CONTRACT,
      "--allow-missing-design-target",
    ]);
    assert.notEqual(code, 2, err);
    assert.doesNotMatch(err, /--genre is required/);
    assert.equal(await fileExists(loombridgePaths(root).genrePromotion), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: --brief supplies the genre, so no --genre is needed", async () => {
  const root = await unityRoot();
  try {
    const bundle = path.join(root, "design-docs");
    await fs.mkdir(bundle);
    await fs.copyFile(EXAMPLE_CONTRACT, path.join(bundle, "genre-contract.json"));
    const { code, err } = await runCli([
      "--root", root,
      "--brief", bundle,
      "--allow-missing-design-target",
    ]);
    assert.notEqual(code, 2, err);
    assert.doesNotMatch(err, /--genre is required/);
    assert.equal(await fileExists(loombridgePaths(root).genrePromotion), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the predicate itself ─────────────────────────────────────────────────────

test("unstatedGenreRefusal: a SINGLE registered genre still defaults silently", () => {
  // Back-compat: defaulting is only wrong because there is more than one thing to default TO.
  // The registered set is INJECTED rather than simulated by unregistering a real pack, which would
  // have weakened every other genre guard in the suite for the duration of this one assertion.
  assert.equal(
    unstatedGenreRefusal({
      genreExplicit: false,
      hasContractSource: false,
      stateGenre: undefined,
      known: ["only-one"],
    }),
    null,
    "with one pack registered the default IS the answer",
  );
  assert.equal(
    unstatedGenreRefusal({ genreExplicit: false, hasContractSource: false, stateGenre: undefined, known: [] }),
    null,
    "and an empty registry has nothing to name",
  );
});

test("unstatedGenreRefusal: refuses only when NOTHING states the genre", () => {
  const known = ["alpha", "beta"];
  const bare = { genreExplicit: false, hasContractSource: false, stateGenre: undefined, known };
  assert.ok(unstatedGenreRefusal(bare), "two packs + nothing stated ⇒ refuse");
  assert.equal(unstatedGenreRefusal({ ...bare, genreExplicit: true }), null);
  assert.equal(unstatedGenreRefusal({ ...bare, hasContractSource: true }), null);
  assert.equal(unstatedGenreRefusal({ ...bare, stateGenre: "alpha" }), null);
  // `unknown` is the placeholder a `target set` before any `plan` leaves behind. It reaches this
  // predicate as `undefined` (see `genreFromState`), never as a genre that satisfies it.
  assert.ok(unstatedGenreRefusal({ ...bare, stateGenre: undefined }));
});
