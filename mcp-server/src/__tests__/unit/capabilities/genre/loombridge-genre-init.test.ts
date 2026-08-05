/**
 * `loombridge genre init`: the scaffolder for the any-genre path.
 *
 * THE BAR THIS FILE ENFORCES: the generated contract passes the REAL `validateGenreContract`
 * unedited, for every genre class and every shipped hint-card pack. A generator whose output the
 * gate rejects is worse than no generator, and "it looked valid" is not evidence, so the actual
 * validator runs over the actual bytes written to disk, not over an in-memory approximation.
 *
 * It also walks the two DECLARED PATHS this feature introduces, because a path nothing walks is
 * this repo's most expensive failure shape:
 *  - the default output name, round-tripped through `resolveBriefBundle`, so `genre init` then
 *    `plan --brief .loombridge` cannot silently stop composing;
 *  - the hint-card packs on disk, by scaffolding from every one of them.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../../../../surfaces/cli.js";
import { resolveBriefBundle } from "../../../../domain/brief-bundle.js";
import { LOOMBRIDGE_DIRNAME } from "../../../../domain/state.js";
import { validateGenreContract } from "../../../../capabilities/genre/genre-contract/validator.js";
import { VLM_REVIEW_CRITERION_IDS } from "../../../../capabilities/verification/gates/vlm-criteria.js";
import { GENRE_CLASSES, type GenreContract } from "../../../../capabilities/genre/genre-contract/types.js";
import {
  hintCardGenreIds,
  isScaffoldError,
  scaffoldGenreContract,
} from "../../../../capabilities/genre/genre-contract/scaffold.js";
import { DEFAULT_CONTRACT_FILENAME } from "../../../../capabilities/genre/genre.js";
import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-genre-init-"));
}

/** Run the CLI, keeping stdout and stderr apart: warnings belong on stderr. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const outLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loombridgeCli(["node", "cli.js", ...argv]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

function assertValid(contract: unknown, label: string): void {
  const { valid, issues } = validateGenreContract(contract);
  assert.ok(
    valid,
    `${label}: the scaffolded contract must pass the real validator unedited: ` +
      issues.map((i) => `${i.path || "<root>"}: ${i.message} [${i.code}]`).join("; "),
  );
}

/* ------------------------------------------------------------------ the bar */

test("every genre class scaffolds a contract the REAL validator accepts", () => {
  for (const genreClass of GENRE_CLASSES) {
    const result = scaffoldGenreContract({ genreId: `fixture-${genreClass}`, genreClass });
    assert.ok(!isScaffoldError(result), `class ${genreClass}: ${isScaffoldError(result) ? result.error : ""}`);
    assertValid(result.contract, `class ${genreClass}`);
    assert.equal(result.contract.coreLoop.genreClass, genreClass);
  }
});

test("every shipped hint-card pack scaffolds a contract the REAL validator accepts", () => {
  const packs = hintCardGenreIds();
  // Non-vacuity: if the pack directory ever moved, this test would otherwise pass by iterating
  // nothing, the exact "declared path nothing walks" failure it exists to catch.
  assert.ok(packs.length > 0, "expected at least one hint-card pack on disk");
  for (const genreId of packs) {
    const result = scaffoldGenreContract({ genreId });
    assert.ok(!isScaffoldError(result), `pack ${genreId}: ${isScaffoldError(result) ? result.error : ""}`);
    assertValid(result.contract, `pack ${genreId}`);
    // Seeded, not skeletal: the pack's knowledge has to actually reach the contract.
    assert.ok(result.contract.tunables.length > 0, `${genreId}: no tunables seeded`);
    assert.ok(
      result.contract.measurabilityMap.length > 1,
      `${genreId}: measurability map looks like the bare skeleton, so the pack was not read`,
    );
  }
});

test("fidelityCriteria is present by default and every id is gradable", () => {
  for (const genreClass of GENRE_CLASSES) {
    const result = scaffoldGenreContract({ genreId: "fixture", genreClass });
    assert.ok(!isScaffoldError(result));
    const criteria = result.contract.fidelityCriteria;
    // Absent, `doneness` REFUSES any design-targeted build of this genre. It is the one optional
    // field whose omission costs the hero-shot half of the moat, so the default must carry it.
    assert.ok(criteria && criteria.length > 0, `class ${genreClass}: fidelityCriteria must be seeded`);
    for (const id of criteria!) {
      assert.ok(
        VLM_REVIEW_CRITERION_IDS.has(id),
        `class ${genreClass}: "${id}" is not a gradable criterion, so doneness would be unreachable-green`,
      );
    }
  }
});

test("omitting fidelityCriteria is loud, never silent", () => {
  const result = scaffoldGenreContract({
    genreId: "fixture",
    genreClass: "twitch",
    includeFidelityCriteria: false,
  });
  assert.ok(!isScaffoldError(result));
  assert.equal(result.contract.fidelityCriteria, undefined);
  assertValid(result.contract, "no-fidelity");
  assert.ok(
    result.warnings.some((w) => /doneness/i.test(w) && /REFUSE/i.test(w)),
    `omission must warn about the doneness refusal it buys; got: ${result.warnings.join(" | ")}`,
  );
});

/* ------------------------------------------------------------------ refusals */

test("the genre class is never guessed: no pack and no --class refuses", () => {
  const result = scaffoldGenreContract({ genreId: "no-such-pack-genre" });
  assert.ok(isScaffoldError(result));
  assert.match(result.error, /genre class/i);
  assert.match(result.error, new RegExp(GENRE_CLASSES.join("\\|")));
});

test("a --class that contradicts the pack refuses instead of silently overriding it", () => {
  const genreId = hintCardGenreIds()[0]!;
  const packClass = (scaffoldGenreContract({ genreId }) as { contract: GenreContract }).contract.coreLoop
    .genreClass;
  const other = GENRE_CLASSES.find((c) => c !== packClass)!;
  const result = scaffoldGenreContract({ genreId, genreClass: other });
  assert.ok(isScaffoldError(result), "a contradicting class must refuse");
  assert.match(result.error, new RegExp(genreId));
});

test("an unknown genre class refuses and names the closed set", () => {
  const result = scaffoldGenreContract({ genreId: "fixture", genreClass: "arcade" });
  assert.ok(isScaffoldError(result));
  assert.match(result.error, /arcade/);
});

/* ------------------------------------------------------------------ the registered-id collision */

test("scaffolding under a REGISTERED genre id warns loudly and names the tradeoff", () => {
  // `2d-shooter` and `3d-shooter` are BOTH registered packs AND hint-card packs, so
  // `genre init --genre <a shooter>` is the most natural "customise the shooter" invocation: and
  // the one that silently does not do what it says. Planning from the result resolves coverage from
  // the REGISTRY (`graded`, not `partially-graded`) and `doneness` grades the hero shot against the
  // PACK's fidelityCriteria, discarding the contract's own. It succeeded with no notice at all.
  const collisions = knownGenreIds().filter((id) => hintCardGenreIds().includes(id));
  assert.ok(collisions.length > 0, "expected at least one id that is both registered and hint-carded");

  for (const genreId of collisions) {
    const result = scaffoldGenreContract({ genreId });
    assert.ok(!isScaffoldError(result), `${genreId}: a registered id must still scaffold, not refuse`);
    assert.equal(result.registeredPack, true, `${genreId}: the collision must be reported to the caller`);
    const warning = result.warnings.find((w) => /ALREADY a REGISTERED genre pack/.test(w));
    assert.ok(warning, `${genreId}: no collision warning; got ${result.warnings.join(" | ")}`);
    // Naming the tradeoff, not merely the fact: both halves of what silently changes.
    assert.match(warning!, /`graded`/, `${genreId}: the warning must say which claim is actually stamped`);
    assert.match(warning!, /fidelityCriteria/, `${genreId}: the warning must say whose criteria win`);
  }
});

test("an UNREGISTERED id scaffolds with no collision warning (the warning is a per-id answer)", () => {
  // Non-vacuity: a warning that fired on every scaffold would train the author to ignore it.
  const result = scaffoldGenreContract({ genreId: "definitely-not-a-registered-genre", genreClass: "systems" });
  assert.ok(!isScaffoldError(result));
  assert.equal(result.registeredPack, false);
  assert.deepEqual(result.warnings.filter((w) => /ALREADY a REGISTERED/.test(w)), []);
});

test("`genre init` on a registered id does NOT close by promising partially-graded", async () => {
  const root = await tmpRoot();
  try {
    const genreId = knownGenreIds().find((id) => hintCardGenreIds().includes(id))!;
    const { code, out, err } = await capture(["genre", "init", "--genre", genreId, "--root", root]);
    assert.equal(code, 0);
    assert.match(err, /ALREADY a REGISTERED genre pack/, "the warning belongs on stderr");
    // The closing line is the last thing an author reads, and it used to contradict the warning.
    assert.doesNotMatch(out, /verifies as[\s\S]{0,40}`partially-graded`/);
    assert.match(out, /`graded`/, "it must state the claim this genre actually earns");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ --out over a directory */

test("--force over a DIRECTORY refuses cleanly instead of throwing EISDIR", async () => {
  const root = await tmpRoot();
  try {
    const out = path.join(root, "a-directory");
    await fs.mkdir(out, { recursive: true });
    const { code, err } = await capture([
      "genre", "init", "--genre", "temp-genre", "--class", "systems", "--out", out, "--force",
    ]);
    assert.equal(code, 2, "an unhandled EISDIR stack trace reads as a crash, not as a usage error");
    assert.match(err, /DIRECTORY/);
    assert.doesNotMatch(err, /EISDIR/, "the raw errno must not be the user-facing message");
    assert.equal((await fs.stat(out)).isDirectory(), true, "the directory must be left alone");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the CLI + the declared path */

test("`genre init` writes the name `plan --brief <dir>` resolves, and the file validates", async () => {
  const root = await tmpRoot();
  try {
    const { code, out } = await capture(["genre", "init", "--genre", "temp-genre", "--class", "systems", "--root", root]);
    assert.equal(code, 0, "a first scaffold must succeed");

    const written = path.join(root, LOOMBRIDGE_DIRNAME, DEFAULT_CONTRACT_FILENAME);
    const parsed = JSON.parse(await fs.readFile(written, "utf-8"));
    assertValid(parsed, "cli output");
    assert.match(out, /wrote/);

    // The composition the default path exists for: `plan --brief .loombridge` must find THIS file.
    // Both halves are walked, so renaming either one fails here instead of at a partner's shell.
    const resolved = resolveBriefBundle(path.join(root, LOOMBRIDGE_DIRNAME));
    assert.ok(!("error" in resolved), `--brief must resolve the scaffold: ${JSON.stringify(resolved)}`);
    assert.equal(resolved.genreContractPath, written);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an existing contract is never overwritten without --force", async () => {
  const root = await tmpRoot();
  try {
    const written = path.join(root, LOOMBRIDGE_DIRNAME, DEFAULT_CONTRACT_FILENAME);
    await capture(["genre", "init", "--genre", "temp-genre", "--class", "systems", "--root", root]);
    await fs.writeFile(written, '{"hand":"authored"}\n', "utf-8");

    const refused = await capture(["genre", "init", "--genre", "temp-genre", "--class", "systems", "--root", root]);
    assert.equal(refused.code, 2, "a second scaffold must refuse");
    assert.match(refused.err, /--force/);
    assert.equal(
      await fs.readFile(written, "utf-8"),
      '{"hand":"authored"}\n',
      "the refusal must leave the authored file byte-identical",
    );

    const forced = await capture([
      "genre", "init", "--genre", "temp-genre", "--class", "systems", "--root", root, "--force",
    ]);
    assert.equal(forced.code, 0);
    assertValid(JSON.parse(await fs.readFile(written, "utf-8")), "forced output");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("`genre init` refuses without --genre, and `genre` alone is a usage error", async () => {
  const noGenre = await capture(["genre", "init"]);
  assert.equal(noGenre.code, 2);
  assert.match(noGenre.err, /--genre/);

  const bare = await capture(["genre"]);
  assert.equal(bare.code, 2, "a verb with a required subcommand must not report success");

  const help = await capture(["genre", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /genre init/);
});

test("--out writes exactly where asked, and --root is not consulted", async () => {
  const root = await tmpRoot();
  try {
    const out = path.join(root, "docs", "brief.json");
    const { code } = await capture([
      "genre", "init", "--genre", "temp-genre", "--class", "twitch", "--out", out, "--root", root,
    ]);
    assert.equal(code, 0);
    assertValid(JSON.parse(await fs.readFile(out, "utf-8")), "--out output");
    assert.equal(
      await fs.stat(path.join(root, LOOMBRIDGE_DIRNAME, DEFAULT_CONTRACT_FILENAME)).then(() => true, () => false),
      false,
      "--out must not also write the default path",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
