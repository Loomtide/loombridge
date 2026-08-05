/**
 * `plan` on a CONTRACT project: the any-genre iteration loop, and the three ways it used to lie.
 *
 * A "contract project" is one planned from `--genre-contract` / `--brief` rather than a registered
 * pack. It is the path `loombridge genre init` exists to make easy, so it is the path a developer
 * re-runs most, and every failure below was reproduced by running the CLI on one:
 *
 *  1. RE-PROMOTION ERASED HUMAN SIGN-OFF. The approval-proof guard was computed only on a genre
 *     CHANGE, while the promoted path writes SLICES.json UNCONDITIONALLY. Re-promoting an edited
 *     contract under the SAME genreId: the ordinary loop: turned a slice with `state: "approved"`
 *     and a full proof block back into `pending`, with no refusal and no notice.
 *  2. THE SECOND BARE `plan` LIED THREE WAYS. It announced `ungraded` when `deriveGenreCoverage`
 *     reads GENRE_PROMOTION.json from disk and returns `partially-graded`, prescribed authoring the
 *     genre contract the developer had already authored, and claimed to be "seeding the GENERIC
 *     template" one line before reporting ACCEPTANCE.json as `kept (unchanged)`.
 *  3. `--genre <the contract's own genre> --force` DESTROYED THE CONTRACT AND MISDESCRIBED IT. It
 *     printed "removed stale GENRE_PROMOTION.json, and it described the PREVIOUS promoted genre, not X"
 *     when `sourceGenreId` IS X, while replacing the promoted ACCEPTANCE.json with a template,
 *     dropping `fidelityCriteria` (after which doneness refuses every design-targeted build), and
 *     leaving SLICES.json still carrying the contract's slices. It is reachable by combining two
 *     lines the flip refusal itself prints.
 *
 * Plus the fourth, which is upstream of all of them: `plan` accepted a contract still carrying the
 * scaffold's `REPLACE ME:` placeholders and produced a full plan, roadmap, GAME_SPEC.md and a
 * `partially-graded` stamp over fields nobody had written.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { readSlicePlan, writeSlicePlan } from "../../../../capabilities/verification/slices.js";
import { loombridgePaths } from "../../../../domain/state.js";
import {
  genreContractPlaceholderPaths,
  isScaffoldError,
  placeholderPrefix,
  scaffoldGenreContract,
} from "../../../../capabilities/genre/genre-contract/scaffold.js";

/** An id that is deliberately NOT registered: the whole point of the contract path. */
const GENRE_ID = "fixture-tower-defense";

async function planWithLog(args: Parameters<typeof runPlan>[0]): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    return { code: await runPlan(args), err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

/** Replace every scaffold placeholder with a written answer, exactly as an author would. */
function fillPlaceholders<T>(value: T): T {
  const marker = placeholderPrefix();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.startsWith(marker) ? "a real written answer" : node;
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value) as T;
}

function scaffoldedContract(genreId = GENRE_ID): Record<string, unknown> {
  const result = scaffoldGenreContract({ genreId, genreClass: "systems" });
  assert.ok(!isScaffoldError(result), isScaffoldError(result) ? result.error : "");
  return result.contract as unknown as Record<string, unknown>;
}

/** A temp Unity project with a FILLED contract written beside it (not yet planned). */
async function contractFixture(): Promise<{ root: string; contractPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-contract-project-"));
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.0f1\n", "utf-8");
  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, `${JSON.stringify(fillPlaceholders(scaffoldedContract()), null, 2)}\n`, "utf-8");
  return { root, contractPath };
}

/** The same fixture, already promoted once (the state every test below starts from). */
async function plannedContractProject(): Promise<{ root: string; contractPath: string }> {
  const fixture = await contractFixture();
  const { code, err } = await planWithLog({
    root: fixture.root,
    genre: GENRE_ID,
    genreExplicit: true,
    engine: "unity",
    force: false,
    genreContractPath: fixture.contractPath,
    allowMissingDesignTarget: true,
  });
  assert.notEqual(code, 2, `fixture must promote: ${err}`);
  const plan = await readSlicePlan(loombridgePaths(fixture.root));
  assert.ok(plan && plan.genre === GENRE_ID, "fixture must have the contract's roadmap on disk");
  return fixture;
}

/* ─────────────────────────────────────────── 1. re-promotion vs human sign-off ─────────────── */

test("re-promoting the SAME genre contract REFUSES when a slice carries an approval proof", async () => {
  const { root, contractPath } = await plannedContractProject();
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

    // Edit the contract and re-promote it: the normal iteration loop, at the SAME genreId.
    const edited = JSON.parse(await fs.readFile(contractPath, "utf-8")) as Record<string, unknown>;
    (edited.artDirection as Record<string, unknown>).style = "a second pass at the art direction";
    await fs.writeFile(contractPath, `${JSON.stringify(edited, null, 2)}\n`, "utf-8");

    const { code, err } = await planWithLog({
      root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: true,
      genreContractPath: contractPath,
      allowMissingDesignTarget: true,
    });

    assert.equal(code, 2, "discarding human sign-off is a precondition failure, not a warning");
    assert.match(err, /approval proof/);
    assert.match(err, new RegExp(plan.slices[0]!.id));
    assert.match(err, /loombridge reopen/, "the refusal must name the sanctioned withdrawal");
    // Refused BEFORE any write: the reproduction was the approval coming back `pending`.
    assert.equal(await fs.readFile(paths.slices, "utf-8"), slicesBefore, "SLICES.json untouched");
    assert.equal(await fs.readFile(paths.acceptance, "utf-8"), acceptanceBefore, "ACCEPTANCE.json untouched");
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "approved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("re-promoting the SAME genre contract with NO approvals still works (the loop is not blocked)", async () => {
  // The mirror risk: a guard that fired on every re-promotion would break the iteration loop the
  // any-genre path exists to make easy.
  const { root, contractPath } = await plannedContractProject();
  try {
    const { code, err } = await planWithLog({
      root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: true,
      genreContractPath: contractPath,
      allowMissingDesignTarget: true,
    });
    assert.notEqual(code, 2, err);
    assert.doesNotMatch(err, /approval proof/);
    assert.equal((await readSlicePlan(loombridgePaths(root)))!.genre, GENRE_ID);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────── 2. the second bare `plan` ──────────────────────── */

test("a second BARE plan on a contract project reports partially-graded, not `ungraded`", async () => {
  const { root } = await plannedContractProject();
  try {
    // Bare: no --genre, no contract. The genre comes from STATE, exactly as a re-plan does.
    const { code, err } = await planWithLog({
      root,
      genre: "platformer-2d", // the parse-time default; a bare run must never reach it
      genreExplicit: false,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.notEqual(code, 2, err);
    assert.match(err, /partially-graded/, "the CLI must narrate the coverage the gates will derive");
    assert.match(err, /GENRE_PROMOTION\.json/, "it must name the artifact it read");
    assert.doesNotMatch(err, /verify as `ungraded`/, "the gates return partially-graded, so saying ungraded is a lie");
    assert.doesNotMatch(
      err,
      /seeding the GENERIC template/,
      "nothing is seeded on this run: the next line reports ACCEPTANCE.json as kept",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────── 3. --force at the contract's own genre ─────────── */

test("plan --genre <the contract's own genre> --force REFUSES instead of quietly de-promoting", async () => {
  const { root } = await plannedContractProject();
  try {
    const paths = loombridgePaths(root);
    const before = {
      acceptance: await fs.readFile(paths.acceptance, "utf-8"),
      slices: await fs.readFile(paths.slices, "utf-8"),
      promotion: await fs.readFile(paths.genrePromotion, "utf-8"),
    };

    const { code, err } = await planWithLog({
      root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: true,
      allowMissingDesignTarget: true,
    });

    assert.equal(code, 2, "destroying a promoted contract is a precondition failure");
    assert.match(err, /NOT ready/);
    assert.match(err, /fidelityCriteria/, "the refusal must name what would be lost");
    assert.match(err, /--brief <dir> --force/, "it must point at the re-promotion that does work");
    // The false reason is gone: `sourceGenreId` IS this genre, so nothing here is "the previous genre".
    assert.doesNotMatch(err, /previous promoted genre/);
    assert.equal(await fs.readFile(paths.acceptance, "utf-8"), before.acceptance, "ACCEPTANCE.json untouched");
    assert.equal(await fs.readFile(paths.slices, "utf-8"), before.slices, "SLICES.json untouched");
    assert.equal(await fs.readFile(paths.genrePromotion, "utf-8"), before.promotion, "the report is not removed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the escape hatch the refusal names works: delete the report, then --force seeds the template", async () => {
  // A refusal that cannot be gotten past is a wall, not a guard. The sanctioned abandon-the-contract
  // path has to actually be reachable.
  const { root } = await plannedContractProject();
  try {
    const paths = loombridgePaths(root);
    await fs.rm(paths.genrePromotion);
    const { code, err } = await planWithLog({
      root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: true,
      allowMissingDesignTarget: true,
    });
    assert.notEqual(code, 2, err);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────── 4. the unwritten contract ──────────────────────── */

test("plan REFUSES a contract still carrying the scaffold's placeholders, before writing anything", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-placeholder-"));
  try {
    await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.0f1\n", "utf-8");
    const contractPath = path.join(root, "contract.json");
    // The RAW scaffold: the exact bytes `loombridge genre init` writes.
    await fs.writeFile(contractPath, `${JSON.stringify(scaffoldedContract(), null, 2)}\n`, "utf-8");

    const { code, err } = await planWithLog({
      root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: false,
      genreContractPath: contractPath,
      allowMissingDesignTarget: true,
    });

    assert.equal(code, 2, "planning on unwritten fields is a precondition failure");
    assert.match(err, new RegExp(placeholderPrefix()));
    assert.match(err, /coreLoop\.description/, "the refusal must name the fields, not just the count");
    assert.match(err, /artDirection\.style/);
    // Refused BEFORE `ensureScaffold`: a refusal that already wrote half a `.loombridge/` is not one.
    const paths = loombridgePaths(root);
    for (const p of [paths.acceptance, paths.slices, paths.genrePromotion, paths.gameSpec]) {
      assert.equal(
        await fs.stat(p).then(() => true, () => false),
        false,
        `${path.basename(p)} must not exist after a refusal`,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the SAME contract with its placeholders written plans normally", async () => {
  // Non-vacuity for the refusal above: it has to be the placeholders that block, not the fixture.
  const { root } = await plannedContractProject();
  await fs.rm(root, { recursive: true, force: true });
});

/* ─────────────────────────────────────────── 5. what the promoter invented ──────────────────── */

test("promotion NAMES the pixel-art defaults it invented, because GAME_SPEC.md states them as fact", async () => {
  // A GenreContract has no field for a win rule, a font, a palette or a native resolution, so all
  // four come from a pixel-art 2D template, and GAME_SPEC.md then prints the win rule as the
  // game's objective with nothing marking it as an assumption.
  const fixture = await contractFixture();
  try {
    const { code, err } = await planWithLog({
      root: fixture.root,
      genre: GENRE_ID,
      genreExplicit: true,
      engine: "unity",
      force: false,
      genreContractPath: fixture.contractPath,
      allowMissingDesignTarget: true,
    });
    assert.notEqual(code, 2, err);
    assert.match(err, /DEFAULTS/);
    for (const field of ["win.rule", "fonts", "palette", "nativeResolution"]) {
      assert.ok(err.includes(field), `the defaults line must name ${field}; got:\n${err}`);
    }
    // And it must name the file it says prints them as fact, so the reader can go look.
    assert.match(err, /GAME_SPEC\.md/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("LITMUS: the placeholder detector fires on a scaffold and NOT on written prose", () => {
  // A draft detector that finds nothing passes forever, and one that is not anchored at the start of
  // the value flags a real art-direction phrase that merely mentions the words. Both directions,
  // proved in memory: the same discipline `minigame-draft.ts` carries for `DRAFT:`/`TODO:`.
  const marker = placeholderPrefix();
  assert.ok(marker.length > 0, "the template must define a placeholder marker");

  const raw = scaffoldedContract();
  const found = genreContractPlaceholderPaths(raw);
  assert.ok(found.length > 0, "the raw scaffold must be detected as unwritten");
  assert.ok(found.includes("coreLoop.description"), `expected coreLoop.description, got ${found.join(", ")}`);

  assert.deepEqual(genreContractPlaceholderPaths(fillPlaceholders(raw)), [], "a written contract must be clean");
  assert.deepEqual(
    genreContractPlaceholderPaths({ artDirection: { style: `a style that mentions "${marker}" mid-sentence` } }),
    [],
    "the marker must be anchored at the START of the value",
  );
  assert.deepEqual(genreContractPlaceholderPaths({ artDirection: { style: `${marker}: write me` } }), [
    "artDirection.style",
  ]);
});
