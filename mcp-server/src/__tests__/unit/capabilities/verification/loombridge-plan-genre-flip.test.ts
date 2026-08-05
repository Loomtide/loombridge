/**
 * `plan --genre <other> --force`: the roadmap moves with the contract (GenreGenericity S1).
 *
 * The asymmetry this closes: `--force` re-seeded ACCEPTANCE.json + FEEL_SPEC.json from the new
 * genre, but on the non-promoted path SLICES.json is written only in `mode === "design"`, which an
 * existing roadmap suppresses. A genre change therefore left a stale slice DAG still DECLARING the
 * old genre, and the contradiction surfaced much later as a `doneness` roll-up refusal about a
 * genre disagreement: a half-changed project that looks changed.
 *
 * RFC open question 2 is decided here: REWRITE with a loud notice, EXCEPT refuse when a slice
 * already carries an approval proof. An approved slice is human-signed evidence, so letting a
 * genre flip drop it would make `--force` a cheaper `reopen` with no audit trail.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { setDesignTarget } from "../../../../capabilities/verification/design.js";
import { readSlicePlan, writeSlicePlan } from "../../../../capabilities/verification/slices.js";
import { loombridgePaths } from "../../../../domain/state.js";
import { writeApprovedAssetManifestForDesign } from "../../../helpers/asset-manifest-fixture.js";

/** Capture console.error while running a plan. */
async function planWithLog(args: Parameters<typeof runPlan>[0]): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const code = await runPlan(args);
    return { code, err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

/**
 * A project planned as `platformer-2d` with a real, scaffolded roadmap: design target approved +
 * frozen and asset manifest approved, so `plan` reaches the design→roadmap pivot and writes
 * SLICES.json through the normal path (no hand-written DAG).
 */
async function plannedPlatformer(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-flip-"));
  const img = path.join(root, "src-hero.png");
  await fs.writeFile(img, "hero-pixels-v1", "utf-8");
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  await planWithLog({ root, genre: "platformer-2d", genreExplicit: true, engine: "unity", force: false });
  const plan = await readSlicePlan(loombridgePaths(root));
  assert.ok(plan, "fixture must have a scaffolded roadmap");
  assert.equal(plan.genre, "platformer-2d");
  return root;
}

test("plan --genre <other> --force: REWRITES SLICES.json for the new genre, loudly", async () => {
  const root = await plannedPlatformer();
  try {
    const paths = loombridgePaths(root);
    const before = (await readSlicePlan(paths))!;

    const { code, err } = await planWithLog({
      root,
      genre: "3d-topdown-arena",
      genreExplicit: true,
      engine: "unity",
      force: true,
    });
    assert.notEqual(code, 2, err);

    const after = (await readSlicePlan(paths))!;
    assert.equal(after.genre, "3d-topdown-arena", "the roadmap must declare the genre the contract now is");
    assert.notDeepEqual(
      after.slices.map((s) => s.id),
      before.slices.map((s) => s.id),
      "the new genre's slice ids must replace the old genre's",
    );
    // LOUD: a rewrite the operator cannot see is the same silent half-change, mirrored.
    assert.match(err, /REWROTE/);
    assert.match(err, /platformer-2d/);
    assert.match(err, /3d-topdown-arena/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan --genre <other> --force: REFUSES when a slice carries an approval proof", async () => {
  const root = await plannedPlatformer();
  try {
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths))!;
    // Sign one slice off exactly as the `plan --go` approval seam does.
    await writeSlicePlan(paths, {
      ...plan,
      slices: plan.slices.map((slice, i) =>
        i === 0
          ? {
              ...slice,
              state: "approved" as const,
              proof: { ...slice.proof, checkpointId: "ckpt-1", approvedAt: "2026-08-01T00:00:00.000Z" },
            }
          : slice,
      ),
    });
    const slicesBefore = await fs.readFile(paths.slices, "utf-8");
    const acceptanceBefore = await fs.readFile(paths.acceptance, "utf-8");

    const { code, err } = await planWithLog({
      root,
      genre: "3d-topdown-arena",
      genreExplicit: true,
      engine: "unity",
      force: true,
    });

    assert.equal(code, 2, "discarding human sign-off is a precondition failure, not a warning");
    assert.match(err, /approval proof/);
    assert.match(err, new RegExp(plan.slices[0]!.id));
    assert.match(err, /loombridge reopen/, "the refusal must name the sanctioned withdrawal");
    // Refused BEFORE any write: a refusal that already re-seeded the contract leaves the project in
    // the exact half-changed state this whole guard exists to prevent.
    assert.equal(await fs.readFile(paths.slices, "utf-8"), slicesBefore, "SLICES.json untouched");
    assert.equal(await fs.readFile(paths.acceptance, "utf-8"), acceptanceBefore, "ACCEPTANCE.json untouched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan --force at the SAME genre leaves the roadmap alone", async () => {
  // The rewrite is bound to a genre CHANGE. A plain `--force` re-seed (the flag's original job) must
  // not blow away a roadmap the developer has been building against for hours.
  const root = await plannedPlatformer();
  try {
    const paths = loombridgePaths(root);
    const before = await fs.readFile(paths.slices, "utf-8");
    const { err } = await planWithLog({
      root,
      genre: "platformer-2d",
      genreExplicit: true,
      engine: "unity",
      force: true,
    });
    assert.doesNotMatch(err, /REWROTE/);
    assert.equal(await fs.readFile(paths.slices, "utf-8"), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
