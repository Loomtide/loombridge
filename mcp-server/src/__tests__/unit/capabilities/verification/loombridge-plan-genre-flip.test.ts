/**
 * `plan --genre <other>`: a genre change moves the WHOLE contract, or it does not happen.
 *
 * Two halves of one failure, closed by one detection point (GenreGenericity S1 + its follow-up).
 *
 * WITH `--force`: `--force` re-seeded ACCEPTANCE.json + FEEL_SPEC.json from the new genre, but on
 * the non-promoted path SLICES.json is written only in `mode === "design"`, which an existing
 * roadmap suppresses. A genre change therefore left a stale slice DAG still DECLARING the old
 * genre, and the contradiction surfaced much later as a `doneness` roll-up refusal about a genre
 * disagreement: a half-changed project that looks changed. RFC open question 2 is decided here:
 * REWRITE with a loud notice, EXCEPT refuse when a slice already carries an approval proof. An
 * approved slice is human-signed evidence, so letting a genre flip drop it would make `--force` a
 * cheaper `reopen` with no audit trail.
 *
 * WITHOUT `--force`: nothing is re-seeded at all, so the flip wrote the new genre into STATE.md and
 * left the old genre's contract untouched beside it. Reproduced live: `plan --genre 3d-shooter` on
 * a platformer-2d project printed no genre notice, kept `win.rule: "all-fruit"`, and recorded
 * `Genre: 3d-shooter`, and because `3d-shooter` is a registered pack, coverage still stamps
 * `graded`, so the build is graded against another genre's gates. `plan` REFUSES that and names
 * `--force`, because silently applying it would destroy a contract on one mistyped flag.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run, runPlan } from "../../../../capabilities/verification/plan.js";
import { setDesignTarget } from "../../../../capabilities/verification/design.js";
import { readSlicePlan, writeSlicePlan } from "../../../../capabilities/verification/slices.js";
import { loombridgePaths, readState, writeState } from "../../../../domain/state.js";
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

/** Same capture, through the CLI entry point (so a BARE `plan` with no flags can be exercised). */
async function cliWithLog(args: string[]): Promise<{ code: number; err: string }> {
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

/** Mark the temp dir as a Unity project so the CLI's engine auto-detection resolves without --engine. */
async function markUnity(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.0f1\n", "utf-8");
}

/**
 * A project planned as `platformer-2d` with a real, scaffolded roadmap: design target approved +
 * frozen and asset manifest approved, so `plan` reaches the design→roadmap pivot and writes
 * SLICES.json through the normal path (no hand-written DAG).
 */
async function plannedPlatformer(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-flip-"));
  await markUnity(root);
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

/** The bytes of every artifact a genre change would have to move, for an untouched-on-refusal check. */
async function contractBytes(root: string): Promise<Record<string, string | null>> {
  const paths = loombridgePaths(root);
  const out: Record<string, string | null> = {};
  for (const [key, p] of Object.entries({
    acceptance: paths.acceptance,
    feelSpec: paths.feelSpec,
    slices: paths.slices,
  })) {
    out[key] = await fs.readFile(p, "utf-8").catch(() => null);
  }
  return out;
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

// ── the NO-`--force` half: STATE and the contract never end up disagreeing ───────────────────────

test("plan --genre <other> WITHOUT --force: REFUSES, and STATE still agrees with the contract", async () => {
  // The exact live reproduction: a design-phase project (no roadmap yet), replanned at another
  // registered genre with no flags but `--genre`. Before the guard this printed no genre notice at
  // all and left STATE claiming 3d-shooter over a platformer contract.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-noforce-"));
  await markUnity(root);
  try {
    const paths = loombridgePaths(root);
    await cliWithLog(["--root", root, "--genre", "platformer-2d", "--allow-missing-design-target"]);
    const before = await contractBytes(root);

    const { code, err } = await cliWithLog(["--root", root, "--genre", "3d-shooter", "--allow-missing-design-target"]);

    assert.equal(code, 2, "a half-applied genre change is a precondition failure, not a warning");
    assert.match(err, /NOT ready/);
    assert.match(err, /platformer-2d/);
    assert.match(err, /3d-shooter/);
    assert.match(err, /--force/, "the refusal must name the flag that applies the change fully");

    // The ON-DISK outcome, not just the exit code: the whole point is that nothing is half-changed.
    assert.deepEqual(await contractBytes(root), before, "no contract artifact may be rewritten");
    assert.equal(
      (await readState(paths))?.genre,
      "platformer-2d",
      "STATE must keep the genre its contract describes; recording the new one is the desync",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan --genre <other> WITHOUT --force: refuses with a scaffolded roadmap too, touching nothing", async () => {
  const root = await plannedPlatformer();
  try {
    const before = await contractBytes(root);
    assert.ok(before.slices, "fixture must have a roadmap on disk for this to bind");

    const { code, err } = await planWithLog({
      root,
      genre: "3d-topdown-arena",
      genreExplicit: true,
      engine: "unity",
      force: false,
    });

    assert.equal(code, 2, err);
    assert.doesNotMatch(err, /REWROTE/, "a no-force run rewrites nothing, loudly or otherwise");
    assert.deepEqual(await contractBytes(root), before);
    assert.equal((await readState(loombridgePaths(root)))?.genre, "platformer-2d");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan: an ALREADY desynced project refuses on a bare re-plan, and is repaired by naming the contract's genre", async () => {
  // The detection reads the CONTRACT from disk, not STATE.md. STATE is the file the desync
  // corrupts: if it were the source of truth, a project already carrying a mismatched STATE (one
  // written before this guard existed, or hand-edited) would resolve its genre FROM the corrupt
  // value, agree with itself, and sail through with a `graded` claim over the wrong contract.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-desync-"));
  await markUnity(root);
  try {
    const paths = loombridgePaths(root);
    await cliWithLog(["--root", root, "--genre", "platformer-2d", "--allow-missing-design-target"]);
    // Reproduce the pre-guard damage directly: STATE claims one genre, the contract describes another.
    await writeState(paths, { ...(await readState(paths))!, genre: "3d-shooter" });

    const bare = await cliWithLog(["--root", root, "--allow-missing-design-target"]);
    assert.equal(bare.code, 2, "a bare re-plan must not confirm a genre STATE alone claims");
    assert.match(bare.err, /platformer-2d/);

    // The repair the refusal names: re-run at the genre the contract on disk actually describes.
    const repair = await cliWithLog(["--root", root, "--genre", "platformer-2d", "--allow-missing-design-target"]);
    assert.notEqual(repair.code, 2, repair.err);
    assert.equal((await readState(paths))?.genre, "platformer-2d", "STATE must be written back into agreement");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("when the artifacts disagree, the refusal offers EVERY recorded genre, not an arbitrary one", async () => {
  // The suggestion used to be `--genre "${staleGenres[0]}"`: one arbitrary pick from a list it had
  // just printed as multiple. Following it re-runs at whichever genre happened to sort first, which
  // is the same coin-flip the refusal exists to avoid making.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-multi-"));
  await markUnity(root);
  try {
    const paths = loombridgePaths(root);
    await cliWithLog(["--root", root, "--genre", "platformer-2d", "--allow-missing-design-target"]);
    // Two artifacts, two DIFFERENT recorded genres: ACCEPTANCE.json keeps its stamp, FEEL_SPEC.json
    // is edited to another. This is the shape a partly-applied older flip leaves behind.
    const feel = JSON.parse(await fs.readFile(paths.feelSpec, "utf-8")) as Record<string, unknown>;
    feel.genre = "3d-topdown-arena";
    await fs.writeFile(paths.feelSpec, `${JSON.stringify(feel, null, 2)}\n`, "utf-8");

    const { code, err } = await cliWithLog([
      "--root", root, "--genre", "3d-shooter", "--allow-missing-design-target",
    ]);
    assert.equal(code, 2, err);
    assert.match(err, /planned as "platformer-2d", "3d-topdown-arena"/, "both recorded genres must be listed");
    // …and BOTH must be offered as the keep-what-is-on-disk exit.
    assert.match(err, /--genre "platformer-2d"/);
    assert.match(err, /--genre "3d-topdown-arena"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan re-run at the SAME genre (and BARE, with no flags at all) stays frictionless", async () => {
  // The regression that would hurt most. `plan` is re-run constantly through the slice loop with no
  // flags; if the genre-change guard fired on an UNCHANGED genre, every one of those runs would
  // refuse and the loop would stop dead.
  const root = await plannedPlatformer();
  try {
    const before = await contractBytes(root);

    const same = await planWithLog({ root, genre: "platformer-2d", genreExplicit: true, engine: "unity", force: false });
    assert.notEqual(same.code, 2, same.err);
    assert.doesNotMatch(same.err, /NOT ready: this project is planned as/);

    const bare = await cliWithLog(["--root", root]);
    assert.notEqual(bare.code, 2, bare.err);
    assert.doesNotMatch(bare.err, /NOT ready: this project is planned as/);

    assert.deepEqual(await contractBytes(root), before, "a no-op re-plan must not rewrite the contract");
    assert.equal((await readState(loombridgePaths(root)))?.genre, "platformer-2d");
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
