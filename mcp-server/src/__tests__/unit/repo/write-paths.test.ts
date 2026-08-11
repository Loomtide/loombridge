/**
 * THE WRITE-PATH GUARD (ArtifactStorage S2, PR-A).
 *
 * `Docs/Design/ArtifactStorage.md` proposes collapsing the storage layout to `anchors/` +
 * `run/` behind a single `.gitignore` rule, and says the move is "enforceable rather than
 * documentary. A guard test asserts every write path in the codebase resolves under
 * `anchors/`, `tests/`, `design/`, a named contract file, or `run/`, and fails on anything
 * else." This file is that guard, landed BEFORE the move and asserting TODAY's layout.
 *
 * Landing it first is the whole point. A guard written alongside the move can only ever
 * describe the move; a guard that already pins the current layout turns the move into a
 * change to ONE derivation plus a migration, observable by a test that already exists. PR-B
 * narrows the allowed prefixes below and this file fails until every destination follows.
 *
 * WHAT THIS GUARD PROVES, AND WHAT IT DOES NOT.
 *
 * An earlier version of this header argued that because the project dirname is "spelled
 * exactly once, every project-local destination has to flow through `loombridgePaths()` to
 * exist, so walking that object walks all of them." THAT WAS FALSE, and believing it is
 * exactly how a migration ships that relocates the derived slots and strands the rest.
 * `filesHardCodingName` matches a whole quoted string EQUAL to the dirname, so it never saw
 * `".loombridge/registry"`, `.loombridge/handoff`, `.loombridge/genre-contract.json`,
 * `.loombridge/editor-allowlist.json`, `.loombridge/captures/`, `.loombridge/art/`, or the C#
 * `Path.Combine(projectRoot, ".loombridge", "verify")` that gates every `capture.invoke_static`.
 * All of those are real and shipped, and W1 to W4 were green over every one of them.
 *
 * SIX WALKS, none of which hand-lists what it checks. Each states its own narrow claim:
 *   W1  the dirname ALONE (a whole quoted `.loombridge`) is spelled twice, and both are
 *       declarations: the project dirname, and the independent home-root dirname that is not
 *       a project path at all. This bounds where a RENAME of the directory has to happen. It
 *       says NOTHING about what lives inside it: W5 is what covers that.
 *   W2  every field of `loombridgePaths()` is walked via `Object.entries`, so a field added
 *       tomorrow is classified automatically or the test fails.
 *   W3  the destinations that do NOT flow through `loombridgePaths()`, each resolved by
 *       calling the REAL function that produces it, classified or excepted with a reason.
 *   W4  the workspace carve-out (anchors that live outside the project) is closed at two
 *       members and shrinking.
 *   W5  THE INVENTORY. Every first path segment under `.loombridge/` spelled anywhere in the
 *       shipped TypeScript, the shell scripts, the Unity C# package, or the project template,
 *       classified against a declared table. This is the walk that sees the destinations W1 to
 *       W4 are structurally blind to, INCLUDING the non-TypeScript writers, and it is the list
 *       an S2 migration has to relocate.
 *   W6  THE COMPOSE-OFF-`dir` CENSUS. Every `.dir` read off a `LoombridgePaths` value outside
 *       `domain/state.ts`, found through the TypeScript TYPE CHECKER, with the composed
 *       destination resolved where the type system can resolve it and REFUSED where it cannot.
 *
 * `TOP_LEVEL_CHILDREN` IS NOT THE MIGRATION INVENTORY. It is the DERIVED subset: the direct
 * children `loombridgePaths()` itself produces. The inventory is the four tables W5 reads
 * together: `ALLOWED_SUBDIRS` + `TOP_LEVEL_CHILDREN` (derived), `UNDERIVED_CHILDREN` (real,
 * shipped, not derived), and `DOCUMENTED_ONLY_CHILDREN` (named in shipped source, written by
 * nothing today), plus `HOME_ROOT_CHILDREN`, which is the set that must NOT move.
 *
 * Every LITMUS below feeds a PLANTED input to the SAME exported predicate the real check
 * calls. An empty violation list is exactly what a defused predicate returns, so an empty
 * expectation on its own proves nothing. Each also records, verbatim, the failure observed
 * when the real source was broken and the suite re-run.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";
import { filesHardCodingName } from "./unified-verify-declared-paths.test.js";
import { gitignoreHides } from "./test-results-declarations.test.js";
import { stripCommentary } from "./layering.test.js";

import {
  LOOMBRIDGE_DIRNAME,
  RUN_GITIGNORE_BODY,
  loombridgePaths,
  type LoombridgePaths,
} from "../../../domain/state.js";
import { LOOMBRIDGE_HOME_DIRNAME } from "../../../domain/workspace-paths.js";
import { resolveTraceDirectory } from "../../../bridge/trace-directory.js";
import { UNITY_DRIVER_DEFAULT_CAPTURE_DIR } from "../../../capabilities/replay/unity-driver.js";
import {
  getSliceDiagnosticPath,
  getSliceFixtureDir,
  getSliceSignoffPath,
  getSliceVerdictPath,
  getSliceVerifyDir,
} from "../../../capabilities/verification/slices.js";
import { WORKSPACE_SCOPED_KINDS } from "../../../capabilities/verification/unified/discovery.js";
import { resolveSafeScreenshotOutputPath } from "../../../surfaces/index.js";

const SRC = path.join(PKG_ROOT, "src");
const TEMPLATE_GITIGNORE = path.join(REPO_ROOT, "templates", "create-loombridge-game", ".gitignore");

/** A synthetic project root. Nothing is written; every path here is derived, never touched. */
const ROOT = path.resolve("/synthetic-loombridge-project");
const PATHS = loombridgePaths(ROOT);

/** Every non-test `.ts` file under `src/` (the shipped source, not the suite). */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(abs, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

const ALL = sourceFiles(SRC);

/**
 * Read a source file with its comments removed, using the SAME stripper the layering guard
 * uses. A directory NAMED in prose ("the `.loombridge` and `captures` roots already admit…")
 * is documentation, not a second spelling, and firing on it would punish writing things down
 * (the layering test makes the identical argument). Stripping is what lets W1 pin the exact
 * set of DECLARING modules instead of a list padded with files that merely mention the name,
 * which would in turn let a real literal hide behind a pinned filename.
 */
const readCode = (p: string): string => stripCommentary(readFileSync(p, "utf-8"));

/* ══════════════════════════════════════════════════════════════════════════ */
/* W1. ONE SPELLING                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * The only modules allowed to spell the literal.
 *
 * `shared/loombridge-dirname.ts` rather than `domain/state.ts` because `bridge/` may not
 * import `domain/` (layering.test.ts) and `bridge/trace-directory.ts` needs the name;
 * `domain/state.ts` re-exports it, so every other importer is unchanged.
 *
 * `domain/workspace-paths.ts` is the SECOND, deliberate declaration: `~/.loombridge/` is the
 * machine-global root (frozen CLI runtime, cross-project workspaces), not the project-local
 * state dir. They share a value today because they share a brand. Renaming the project
 * directory must not relocate a user's installed runtime, so they are two constants.
 */
const DIRNAME_DECLARING_MODULES = ["domain/workspace-paths.ts", "shared/loombridge-dirname.ts"];

test("W1: the bare `.loombridge` dirname has exactly two spellings, and both are declarations", () => {
  assert.deepEqual(
    filesHardCodingName(LOOMBRIDGE_DIRNAME, ALL, readCode),
    DIRNAME_DECLARING_MODULES,
    "every other module must compose the DIRNAME from LOOMBRIDGE_DIRNAME / loombridgePaths(); a " +
      "third spelling is a rename this guard would not move",
  );
  // SCOPE, stated so it is not over-read: `filesHardCodingName` matches a whole quoted string
  // EQUAL to the dirname. `".loombridge/registry"` is a different string and does not appear
  // here. W5 is the walk that sees those, and it reads RAW text for exactly that reason.
  assert.ok(
    filesHardCodingName(LOOMBRIDGE_DIRNAME, [path.join(SRC, "__x__.ts")], () => `"${LOOMBRIDGE_DIRNAME}/registry"`)
      .length === 0,
    "if this ever starts matching a deeper path, W5's tables and W1's claim both have to be re-read",
  );
  // The two constants are two declarations of the same value, and this assertion is what
  // KEEPS them equal: `assert.equal` fails on divergence, so they are documented as
  // independent and tested as coupled on purpose. Splitting the value is a deliberate act
  // that changes this line, not something a rename can do silently in one of them.
  assert.equal(
    LOOMBRIDGE_DIRNAME,
    LOOMBRIDGE_HOME_DIRNAME,
    "the project dirname and the home-root dirname share a value today; changing one alone must " +
      "be a decision made HERE, because W5's project/home split is what keeps ~/.loombridge/runtime " +
      "from being migrated as if it were project state",
  );
});

test("W1 LITMUS: the real scan fires on a planted third spelling", () => {
  // OBSERVED. Put the literal back into `bridge/trace-directory.ts`, rebuild, re-run, and the
  // REAL check above fails, verbatim:
  //
  //   ✖ W1: the `.loombridge` literal has exactly two spellings, and both are declarations
  //     AssertionError [ERR_ASSERTION]: every other module must compose from LOOMBRIDGE_DIRNAME / loombridgePaths(); a third spelling is a project-local destination W2 cannot see
  //     + actual - expected
  //
  //       [
  //     +   'bridge/trace-directory.ts',
  //         'domain/workspace-paths.ts',
  //         'shared/loombridge-dirname.ts'
  //       ]
  //
  // The planted module is built the UGLY way on purpose. A literal
  // `const d = ".loombridge";` written out here is the shape a bulk rewriter "tidies"
  // (CLAUDE.md: one such pass silently defused the layering test's assembled specifier), so
  // the string is assembled from the constant and never appears in this file verbatim.
  const planted = path.join(SRC, "capabilities/verification/__planted_dirname__.ts");
  const plantedSource = `const d = ${JSON.stringify(LOOMBRIDGE_DIRNAME)};\nexport default d;\n`;
  const read = (p: string): string => (p === planted ? plantedSource : readCode(p));

  assert.ok(
    filesHardCodingName(LOOMBRIDGE_DIRNAME, [...ALL, planted], read).includes(
      "capabilities/verification/__planted_dirname__.ts",
    ),
    "the scan missed a planted third spelling; W2 cannot be exhaustive without this",
  );

  // …and the comment-stripping must not become a hole: the SAME literal inside a comment is
  // prose and must NOT be reported, or the pin above would drift into a list of filenames.
  // The planted text goes through the SAME `readCode` stripper the real files do; handing the
  // scanner an unstripped string here would be the LITMUS testing a code path that never runs.
  const commented = (p: string): string =>
    p === planted
      ? stripCommentary(`// a note about ${JSON.stringify(LOOMBRIDGE_DIRNAME)} and where it lives\n`)
      : readCode(p);
  assert.deepEqual(
    filesHardCodingName(LOOMBRIDGE_DIRNAME, [...ALL, planted], commented),
    DIRNAME_DECLARING_MODULES,
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* Classification: the allowed prefixes, as they stand TODAY                  */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * The categories a destination under `.loombridge/` may fall into, and whether the shipped
 * project template commits or ignores each.
 *
 * PR-B (ArtifactStorage S2) narrowed this from six ad-hoc directories to the tiered set the
 * RFC proposes. The `committed` column is the finding, inverted: `replays/` used to be
 * IGNORED and held both the recorded human demonstrations and the approved pixel baselines
 * (the RFC's mechanism 2, "the one project-local anchor is gitignored by our own template").
 * Those are now `anchors/`, committed, and `run/` is the ONLY ignored entry.
 *
 * THE FOUR COMMITTED NON-ANCHOR ENTRIES ARE NOT LEFTOVERS, and each is a decision the RFC
 * records rather than a directory nobody got round to moving:
 *
 *   `verify/`   the C# capture allowlist hard-codes `Path.Combine(projectRoot,
 *               ".loombridge", "verify")` and THROWS outside it, so moving it is a
 *               cross-language migration; and it is what lets a clone re-grade offline.
 *   `tests/`    stamped evidence a reviewer reads without an editor (pre-existing rule).
 *   `design/`   the approved hero shot.
 *   `registry/` imported asset packs: project INPUTS whose re-derivation may need a hosted
 *               catalog a clone or a CI runner cannot reach.
 */
const ALLOWED_SUBDIRS: ReadonlyMap<string, { category: string; committed: boolean }> = new Map([
  ["anchors", { category: "anchors", committed: true }],
  ["design", { category: "design", committed: true }],
  ["registry", { category: "registry", committed: true }],
  ["run", { category: "run", committed: false }],
  ["tests", { category: "tests", committed: true }],
  ["verify", { category: "verify", committed: true }],
]);

/** A named contract file sitting directly in `.loombridge/` (`ACCEPTANCE.json`, `STATE.md`, …). */
const CONTRACT_FILE = "contract-file";
/** The `.loombridge/` directory ITSELF, which is only ever an allowlist root, never a destination. */
const STATE_DIR = "state-dir";

const ALL_CATEGORIES: readonly string[] = [
  CONTRACT_FILE,
  STATE_DIR,
  ...[...ALLOWED_SUBDIRS.values()].map((v) => v.category),
];

/**
 * THE CLASSIFIER. Both real checks and every LITMUS call this one function.
 *
 * Returns the category a destination falls into, or `null` when it lands somewhere the
 * layout does not declare. `root` is a parameter so a LITMUS can classify a synthetic path.
 */
export function classifyDestination(root: string, destination: string): string | null {
  const dir = loombridgePaths(root).dir;
  const rel = path.relative(dir, destination);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside `.loombridge/`
  if (rel === "") return STATE_DIR;
  const segments = rel.split(path.sep);
  const known = ALLOWED_SUBDIRS.get(segments[0]!);
  if (known) return known.category;
  if (segments.length === 1 && path.extname(segments[0]!) !== "") return CONTRACT_FILE;
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* W2. EVERY DERIVED DESTINATION IS CLASSIFIED                                */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE WALK. `Object.entries` over the real paths object, never a hand-picked subset, so a
 * field added tomorrow is walked automatically and must be classified or this fails.
 *
 * `root` and `dir` are dropped by VALUE identity, not by field name: a future field aliasing
 * either of them is genuinely not a destination, while a field merely NAMED `root` would slip
 * a real destination past the walk.
 */
export function derivedDestinations(paths: LoombridgePaths): { field: string; value: string }[] {
  return Object.entries(paths)
    .filter(([, value]) => value !== paths.root && value !== paths.dir)
    .map(([field, value]) => ({ field, value }));
}

/** Every walked field whose destination the layout does not declare. */
export function unclassifiedDerivedDestinations(root: string, paths: LoombridgePaths): string[] {
  return derivedDestinations(paths)
    .filter(({ value }) => classifyDestination(root, value) === null)
    .map(({ field, value }) => `${field} -> ${value}`)
    .sort();
}

/**
 * Every direct child of `.loombridge/` that `loombridgePaths()` DERIVES.
 *
 * NOT the migration inventory, and reading it as one is the mistake this guard was rebuilt to
 * stop. `.loombridge/genre-contract.json` is a real direct child, written by `genre init` in a
 * real consumer project today, and it is deliberately absent from this list because
 * `loombridgePaths()` does not produce it. The complete direct-child set is W5's
 * `PROJECT_CHILDREN`; this array is the derived subset of it.
 */
const TOP_LEVEL_CHILDREN = [
  "ACCEPTANCE.json",
  "ADOPTION.json",
  "ASSET_MANIFEST.json",
  "FEEL_SPEC.json",
  "GAME_SPEC.md",
  "GENRE_PROMOTION.json",
  "SLICES.json",
  "STATE.md",
  "anchors",
  "design",
  "registry",
  "run",
  "tests",
  "verify",
];

test("W2: every derived destination lands in a declared part of the layout", () => {
  assert.deepEqual(
    unclassifiedDerivedDestinations(ROOT, PATHS),
    [],
    "a LoombridgePaths field resolves somewhere the layout does not declare; either it belongs " +
      "under an existing prefix or the layout (and this guard) has to grow to admit it",
  );
});

test("W2: the DERIVED direct children of `.loombridge/` are exactly the pinned set", () => {
  // Scoped in the title on purpose. The old title said "the direct children ... are exactly
  // the pinned set", which was false and green: `genre-contract.json` and
  // `editor-allowlist.json` are direct children this walk cannot reach, because the walk's
  // input is `loombridgePaths()` and neither is a field on it. W5 asserts the full set.
  const children = new Set(
    derivedDestinations(PATHS)
      .filter(({ value }) => path.dirname(value) === PATHS.dir)
      .map(({ value }) => path.basename(value)),
  );
  assert.deepEqual([...children].sort(), TOP_LEVEL_CHILDREN);
});

test("W2: the template's commit/ignore decision matches the layout's structural split", () => {
  // `gitignoreHides` is the same predicate the test-results guard uses, fed the same shipped
  // template. Walked, not hand-listed: the categories come from the classifier, so a new
  // subdirectory has to declare which half of the split it is in.
  const lines = readFileSync(TEMPLATE_GITIGNORE, "utf-8").split(/\r?\n/);
  const wrong: string[] = [];
  for (const [segment, { committed }] of ALLOWED_SUBDIRS) {
    const hidden = gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/${segment}`);
    if (hidden === committed) {
      wrong.push(`${LOOMBRIDGE_DIRNAME}/${segment} is ${hidden ? "ignored" : "committed"}, expected the opposite`);
    }
  }
  assert.deepEqual(wrong, [], "the shipped template and this guard disagree about what a team commits");

  // NON-VACUITY for the predicate itself: it must still report SOMETHING as hidden and
  // something as not, over the same real file, or the loop above would pass on a template
  // that ignores nothing.
  assert.equal(gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/run`), true);
  assert.equal(gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/design`), false);

  // THE WHOLE IGNORE CONTRIBUTION IS ONE RULE, and that is the claim the RFC makes to a
  // human ("if it is not under run/, it is meant to be committed"). Pinned by DERIVING the
  // Loombridge-relevant lines from the file rather than by re-typing them: a second rule
  // added here is a second thing a reader has to hold, and a second place the split can be
  // wrong.
  const loombridgeRules = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && l.includes(LOOMBRIDGE_DIRNAME));
  assert.deepEqual(loombridgeRules, [`${LOOMBRIDGE_DIRNAME}/run/*`, ".loombridge-fixtures/"]);
});

test("M2: the run tier's own .gitignore is `*` PLUS `!.gitignore`, proved with real git", () => {
  // OBSERVED FAILURE THIS PINS. With a bare `*`, the marker matches its own pattern, so
  // `git add .` stages NOTHING under `run/` including the marker itself: the file never
  // reaches a clone, and a clone therefore does not ignore the run tier at all. The
  // structural guarantee silently does nothing, and nothing in the suite notices, because
  // every assertion about the file's CONTENT still passes.
  //
  // Run against real `git`, not against `gitignoreHides`: the question is what git does,
  // and a hand-written model of git's rules is exactly the wrong thing to answer it with.
  //
  // LITMUS, OBSERVED. Drop `!.gitignore` from `RUN_GITIGNORE_BODY` and from the shipped
  // template file, rebuild, re-run, and the REAL check below fails, verbatim:
  //
  //   ✖ M2: the run tier's own .gitignore is `*` PLUS `!.gitignore`, proved with real git
  //     AssertionError [ERR_ASSERTION]: the run-tier marker was not staged; git staged [".gitignore",".loombridge/anchors/traces/a.trace.json"]
  //
  // Note what that staged list contains and what it does not: the anchors made it, and the
  // marker did not. On a fresh clone that project's run tier would not be ignored at all.
  const root = mkdtempSync(path.join(os.tmpdir(), "loombridge-runignore-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  try {
    mkdirSync(path.join(root, LOOMBRIDGE_DIRNAME, "run", "reports"), { recursive: true });
    writeFileSync(path.join(root, ".gitignore"), readFileSync(TEMPLATE_GITIGNORE, "utf-8"));
    writeFileSync(path.join(root, LOOMBRIDGE_DIRNAME, "run", ".gitignore"), RUN_GITIGNORE_BODY);
    writeFileSync(path.join(root, LOOMBRIDGE_DIRNAME, "run", "reports", "verify.json"), "{}\n");
    mkdirSync(path.join(root, LOOMBRIDGE_DIRNAME, "anchors", "traces"), { recursive: true });
    writeFileSync(path.join(root, LOOMBRIDGE_DIRNAME, "anchors", "traces", "a.trace.json"), "{}\n");
    git("init", "-q", ".");
    git("config", "user.email", "guard@example.com");
    git("config", "user.name", "guard");
    git("add", ".");
    const staged = git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

    // The marker is COMMITTED, so it travels to a clone.
    assert.ok(
      staged.includes(`${LOOMBRIDGE_DIRNAME}/run/.gitignore`),
      `the run-tier marker was not staged; git staged ${JSON.stringify(staged)}`,
    );
    // …and it is the ONLY thing under `run/` that is.
    assert.deepEqual(
      staged.filter((f) => f.startsWith(`${LOOMBRIDGE_DIRNAME}/run/`)),
      [`${LOOMBRIDGE_DIRNAME}/run/.gitignore`],
    );
    // …while the anchors are staged, which is the other half of the split.
    assert.ok(staged.includes(`${LOOMBRIDGE_DIRNAME}/anchors/traces/a.trace.json`));

    // LITMUS, run against the SAME real git: strip the `!.gitignore` line and the marker
    // stops being staged. Without this the assertion above could pass for reasons that
    // have nothing to do with the negation.
    writeFileSync(path.join(root, LOOMBRIDGE_DIRNAME, "run", ".gitignore"), "*\n");
    // `reset` (unstage everything) rather than `rm --cached`: with no HEAD commit the
    // latter refuses on a file whose staged content differs from the working tree, which
    // would make this LITMUS fail for a reason that has nothing to do with the negation.
    git("reset", "-q");
    git("add", ".");
    const bare = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
    assert.equal(
      bare.includes(`${LOOMBRIDGE_DIRNAME}/run/.gitignore`),
      false,
      "a bare `*` must hide the marker itself; if this stages, the negation is not what makes it committable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M2: the template ships the run-tier marker, byte-identical to the constant the CLI writes", () => {
  // TWO WRITERS, ONE BODY. `ensureRunGitignore` writes it into an existing project and the
  // template ships it in a new one; a template that drifted from the constant would give a
  // `create-loombridge-game` project a different rule from a migrated one, and the
  // difference would only show up as an anchor somebody could not find in a clone.
  assert.equal(
    readFileSync(path.join(REPO_ROOT, "templates", "create-loombridge-game", LOOMBRIDGE_DIRNAME, "run", ".gitignore"), "utf-8"),
    RUN_GITIGNORE_BODY,
  );
});

test("W2 LITMUS: the classifier fires on a destination under an undeclared subdirectory", () => {
  // OBSERVED. Add a real `scratch: path.join(dir, "scratch", "notes.json")` field to
  // `LoombridgePaths` + `loombridgePaths()`, rebuild, re-run, and the REAL check above fails,
  // verbatim:
  //
  //   ✖ W2: every derived destination lands in a declared part of the layout
  //     AssertionError [ERR_ASSERTION]: a LoombridgePaths field resolves somewhere the layout does not declare; either it belongs under an existing prefix or the layout (and this guard) has to grow to admit it
  //     + actual - expected
  //
  //     + [
  //     +   'scratch -> /synthetic-loombridge-project/.loombridge/scratch/notes.json'
  //     + ]
  //     - []
  //
  // Note what did NOT have to change for that to be caught: this file. The walk is
  // `Object.entries` over the real object, so the new field was picked up on its own.
  //
  // The same predicate, fed a synthetic paths object. Built by spreading the REAL one so the
  // planted field is the only difference.
  const planted = {
    ...PATHS,
    scratch: path.join(PATHS.dir, "scratch", "notes.json"),
  } as unknown as LoombridgePaths;

  assert.deepEqual(unclassifiedDerivedDestinations(ROOT, planted), [
    `scratch -> ${path.join(PATHS.dir, "scratch", "notes.json")}`,
  ]);

  // …and a destination that escapes `.loombridge/` entirely is reported too, not silently
  // treated as "not our problem".
  const escaped = { ...PATHS, stray: path.join(ROOT, "Assets", "leak.json") } as unknown as LoombridgePaths;
  assert.deepEqual(unclassifiedDerivedDestinations(ROOT, escaped), [
    `stray -> ${path.join(ROOT, "Assets", "leak.json")}`,
  ]);
});

test("W2 LITMUS: `root` and `dir` are dropped by VALUE, not by field name", () => {
  // The first draft of this test asserted the opposite and the guard caught it, which is the
  // best evidence available that the walk is live: a field named `root` IS dropped, because
  // `paths.root` is read off the object under test, so whatever value that field holds is by
  // definition the root of that object.
  //
  // What the value rule actually buys is the RENAME case. Move the root out of the field
  // called `root` and a name-based exclusion would still skip it by looking for the missing
  // name; the value rule finds nothing to exclude, so the renamed field is WALKED and its
  // (unclassifiable) value is reported instead of vanishing.
  const renamed: Record<string, unknown> = { ...PATHS, projectRoot: PATHS.root };
  delete renamed.root;
  assert.ok(
    unclassifiedDerivedDestinations(ROOT, renamed as unknown as LoombridgePaths).some((v) =>
      v.startsWith("projectRoot -> "),
    ),
    "a renamed root field must surface, not silently drop out of the walk",
  );

  // The other half of value identity: a SECOND field holding the state dir is the same
  // destination under a new name, not a new one, so it is correctly dropped.
  const aliased = { ...PATHS, alias: PATHS.dir } as unknown as LoombridgePaths;
  assert.equal(
    derivedDestinations(aliased).map((d) => d.field).includes("alias"),
    false,
    "a field whose value IS the state dir is the same destination, not a new one",
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* W3. THE NON-DERIVED WRITERS                                                */
/* ══════════════════════════════════════════════════════════════════════════ */

/** One project-root-derived destination that does NOT come from a `loombridgePaths()` field. */
export interface WriteDestination {
  /** Stable label, also the key an exception is keyed by. */
  label: string;
  /** The destination, produced by calling the REAL function, never re-typed here. */
  value: string;
}

/**
 * The EXCEPTIONS, each with the reason it can never be classified. Keyed by label so a
 * renamed writer loses its exception and has to earn a new one.
 */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "slices.getSliceFixtureDir",
    // PERMANENT, with a hard technical reason: `snapshotSliceFixture` runs
    // `fs.cp(paths.dir, <fixture>/loombridge, { recursive: true })`, and Node REFUSES to copy
    // a directory into a subdirectory of itself (`ERR_FS_CP_EINVAL`). Moving
    // `.loombridge-fixtures/` inside `.loombridge/` therefore breaks every sliced build the
    // first time a slice checkpoints. Do not "tidy" this into the state dir.
    ".loombridge-fixtures/ must live OUTSIDE .loombridge/: snapshotSliceFixture copies the whole " +
      "state dir into it, and Node refuses to copy a directory into a subdirectory of itself " +
      "(ERR_FS_CP_EINVAL). It can never move inside.",
  ],
  [
    "trace-directory.unbound",
    // Not project-root-derived at all: with no bound Unity project there is no project to own
    // the traces, and writing into the caller's cwd is the defect that module exists to fix.
    "with no bound project the MCP trace dir is os.tmpdir()/loombridge/traces, deliberately NOT " +
      "cwd-relative; there is no project root to classify it against.",
  ],
  // `screenshot-allowlist.captures` USED TO BE EXCEPTED HERE, and PR-A recorded that S2
  // would fold it in. It did: `resolveSafeScreenshotOutputPath` no longer admits a
  // top-level `captures/`, so there is no destination left to except. The exception is
  // deleted rather than kept-and-loosened, which is what the stale-exception LITMUS below
  // exists to force.
]);

/**
 * THE PREDICATE. Returns one sentence per destination that is neither classified nor
 * excepted, PLUS one per exception that has become classifiable (so the list cannot rot into
 * a set of blanket permissions nobody re-reads).
 *
 * `exceptions` is a parameter so the LITMUS can run it EMPTY and prove the exception carries
 * weight rather than the predicate being blind.
 */
export function unclassifiedWriteDestinations(
  entries: readonly WriteDestination[],
  root: string,
  exceptions: ReadonlyMap<string, string> = EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  for (const { label, value } of entries) {
    const category = classifyDestination(root, value);
    if (category === null && !exceptions.has(label)) {
      problems.push(`${label} -> ${value} lands outside every declared prefix`);
    }
    if (category !== null && exceptions.has(label)) {
      problems.push(`${label} -> ${value} classifies as ${category}; its exception is stale, remove it`);
    }
  }
  return problems.sort();
}

/**
 * The candidate first segments the screenshot allowlist is PROBED with: every first segment
 * the layout produces, plus the non-derived roots and two directories that must be refused.
 * Which of these is admitted is decided by CALLING the real function, never asserted here.
 */
const SCREENSHOT_PROBE_SEGMENTS = [
  ...new Set([
    LOOMBRIDGE_DIRNAME,
    ...derivedDestinations(PATHS).map(({ value }) => path.relative(ROOT, value).split(path.sep)[0]!),
    "captures",
    "Assets",
    "ProjectSettings",
  ]),
].sort();

/** The project-root-relative roots `resolveSafeScreenshotOutputPath` actually admits. */
export function admittedScreenshotRoots(
  segments: readonly string[],
  root: string,
  resolve: (requested: string, cwd: string) => string = resolveSafeScreenshotOutputPath,
): string[] {
  return segments
    .filter((segment) => {
      try {
        resolve(`${segment}/probe.png`, root);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * THE NON-DERIVED WRITERS, each produced by calling the real function. Nothing in this array
 * is a re-typed path: a writer that moves moves its entry with it.
 */
function nonDerivedDestinations(): WriteDestination[] {
  return [
    // The MCP op-trace directory, resolved through the real function for a bound project.
    { label: "trace-directory.bound", value: resolveTraceDirectory({ kind: "strict", target: ROOT }, {}) },
    { label: "trace-directory.cwd", value: resolveTraceDirectory({ kind: "cwd", target: ROOT }, {}) },
    { label: "trace-directory.unbound", value: resolveTraceDirectory({ kind: "none" }, {}) },
    // The replay driver's cwd-relative capture fallback (POSIX separators on the wire).
    { label: "unity-driver.captureDir", value: path.resolve(ROOT, UNITY_DRIVER_DEFAULT_CAPTURE_DIR) },
    // The per-slice family. `getSliceFixtureDir` is the one that lands outside `.loombridge/`.
    { label: "slices.getSliceVerdictPath", value: getSliceVerdictPath(PATHS, "slice-a") },
    { label: "slices.getSliceDiagnosticPath", value: getSliceDiagnosticPath(PATHS, "slice-a") },
    { label: "slices.getSliceVerifyDir", value: getSliceVerifyDir(PATHS, "slice-a") },
    { label: "slices.getSliceSignoffPath", value: getSliceSignoffPath(PATHS, "slice-a", ".png") },
    { label: "slices.getSliceFixtureDir", value: getSliceFixtureDir(PATHS, "slice-a") },
    // The screenshot allowlist, probed by CALLING it: one entry per admitted ROOT.
    //
    // READ THE SCOPE. These entries are the allowlist's ROOTS, not its destinations.
    // `<root>/.loombridge` classifies as `state-dir` trivially, and that says nothing about
    // where a screenshot actually lands: the two paths the op registry advertises,
    // `.loombridge/captures/start.png` and `.loombridge/art/gameplay-geometry.json`, both
    // classify `null`, and neither is a `LoombridgePaths` field. W5 is what inventories them
    // (`captures` and `art` are `UNDERIVED_CHILDREN` there). Do not read a green W3 as
    // "screenshots land in a declared slot".
    ...admittedScreenshotRoots(SCREENSHOT_PROBE_SEGMENTS, ROOT).map((segment) => ({
      label: `screenshot-allowlist.${segment === LOOMBRIDGE_DIRNAME ? "state-dir" : segment}`,
      value: path.resolve(ROOT, segment),
    })),
  ];
}

test("W3: every non-derived writer is classified, or excepted with a stated reason", () => {
  assert.deepEqual(
    unclassifiedWriteDestinations(nonDerivedDestinations(), ROOT),
    [],
    "a writer that does not flow through loombridgePaths() lands outside the declared layout; " +
      "route it through a slot, or add an EXCEPTION with the technical reason it cannot move",
  );
});

test("W3: the screenshot allowlist admits exactly ONE project-root-relative root", () => {
  // Derived by calling the real function, so a widened allowlist fails here rather than
  // quietly admitting a new write target under the project root.
  //
  // ONE, not two: ArtifactStorage S2 removed the top-level `captures/` root. It predated
  // `.loombridge/`, sat outside the state dir, was ignored by the template for reasons
  // nobody could restate, and gave every screenshot a second home that no tier owned. The
  // advertised destination is `.loombridge/run/captures/`, inside the state dir and
  // structurally ignored by the run tier's own marker.
  assert.deepEqual(admittedScreenshotRoots(SCREENSHOT_PROBE_SEGMENTS, ROOT), [".loombridge"]);

  // NON-VACUITY: the probe must still REFUSE the directories a screenshot must never
  // reach, or "admits exactly" above would be true of a function that admits everything.
  assert.deepEqual(admittedScreenshotRoots(["Assets", "ProjectSettings", "captures"], ROOT), []);
});

test("W3 LITMUS: an EMPTY exceptions list reports `.loombridge-fixtures/`", () => {
  // OBSERVED. Change `resolveTraceDirectory` to return
  // `path.join(binding.target, "loombridge-traces")`, rebuild, re-run, and the REAL check
  // above fails, verbatim:
  //
  //   ✖ W3: every non-derived writer is classified, or excepted with a stated reason
  //     AssertionError [ERR_ASSERTION]: a writer that does not flow through loombridgePaths() lands outside the declared layout; route it through a slot, or add an EXCEPTION with the technical reason it cannot move
  //     + actual - expected
  //
  //     + [
  //     +   'trace-directory.bound -> /synthetic-loombridge-project/loombridge-traces lands outside every declared prefix',
  //     +   'trace-directory.cwd -> /synthetic-loombridge-project/loombridge-traces lands outside every declared prefix'
  //     + ]
  //     - []
  //
  // That is the PR-B rehearsal: a writer whose destination leaves the declared layout is
  // named, with the field and the resolved path, by a check that was already there.
  //
  // And the exception's own weight: with NO exceptions the predicate must report the fixture
  // dir. If it did not, the entry in EXCEPTIONS would be decoration and the guard would be
  // blind to that whole destination.
  const problems = unclassifiedWriteDestinations(nonDerivedDestinations(), ROOT, new Map());
  assert.ok(
    problems.some((p) => p.startsWith("slices.getSliceFixtureDir ->") && p.includes("outside every declared prefix")),
    `an empty exceptions list must report the fixture dir; got ${JSON.stringify(problems)}`,
  );
  // The other exception carries weight too, by the same argument.
  assert.ok(problems.some((p) => p.startsWith("trace-directory.unbound ->")));
  // …and the exception list is exactly the two that remain, so a third cannot be added
  // without a reader noticing here.
  assert.deepEqual([...EXCEPTIONS.keys()].sort(), ["slices.getSliceFixtureDir", "trace-directory.unbound"]);
});

test("W3 LITMUS: a stale exception is reported, so the list cannot rot into blanket permission", () => {
  // Except a destination that DOES classify. An exceptions list nobody re-reads is how a
  // guard turns into a formality.
  const stale = new Map([...EXCEPTIONS, ["slices.getSliceVerifyDir", "no longer true"]]);
  assert.ok(
    unclassifiedWriteDestinations(nonDerivedDestinations(), ROOT, stale).some((p) =>
      p.includes("its exception is stale, remove it"),
    ),
  );
});

test("W3: the fixture dir's reason is recorded in the CODE, not only in a review thread", () => {
  // The reason is load-bearing: someone WILL try to tidy `.loombridge-fixtures/` into
  // `.loombridge/`, and it breaks every sliced build the first time a slice checkpoints.
  const reason = EXCEPTIONS.get("slices.getSliceFixtureDir") ?? "";
  assert.match(reason, /ERR_FS_CP_EINVAL/);
  assert.match(reason, /subdirectory of itself/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* W4. THE WORKSPACE CARVE-OUT IS CLOSED AND SHRINKING                        */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * The anchors that still live OUTSIDE the project, under `~/.loombridge/projects/<id>/`.
 *
 * This is the RFC's mechanism 1: a path unreachable from the repo, so a fresh clone reads
 * zero rows. S3 (`migrate-workspace` plus the default flip) empties this set. Until then the
 * guard pins its exact membership, so a THIRD kind cannot join the carve-out quietly.
 */
const EXPECTED_WORKSPACE_SCOPED = ["feel-snapshot", "screen-contract"];

/** THE PREDICATE. Empty means the carve-out is exactly the two kinds S3 will remove. */
export function workspaceCarveOutProblems(kinds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (kinds.size !== EXPECTED_WORKSPACE_SCOPED.length) {
    problems.push(`the workspace carve-out holds ${kinds.size} kinds, expected ${EXPECTED_WORKSPACE_SCOPED.length}`);
  }
  const members = [...kinds].sort();
  if (JSON.stringify(members) !== JSON.stringify(EXPECTED_WORKSPACE_SCOPED)) {
    problems.push(`the workspace carve-out members are ${JSON.stringify(members)}`);
  }
  return problems;
}

test("W4: the workspace carve-out is closed at the two kinds S3 removes", () => {
  assert.deepEqual(
    workspaceCarveOutProblems(WORKSPACE_SCOPED_KINDS),
    [],
    "an anchor that lives outside the project cannot be committed, so it cannot be a team gate " +
      "(ArtifactStorage mechanism 1). This set only ever shrinks; S3 empties it.",
  );
});

test("W4 LITMUS: the predicate fires on a three-member set", () => {
  // OBSERVED. Add `"trace"` (a real `DiscoveredAssetKind`, so the break typechecks) to
  // WORKSPACE_SCOPED_KINDS in `discovery.ts`, rebuild, re-run, and the REAL check above
  // fails, verbatim:
  //
  //   ✖ W4: the workspace carve-out is closed at the two kinds S3 removes
  //     AssertionError [ERR_ASSERTION]: an anchor that lives outside the project cannot be committed, so it cannot be a team gate (ArtifactStorage mechanism 1). This set only ever shrinks; S3 empties it.
  //     + actual - expected
  //
  //     + [
  //     +   'the workspace carve-out holds 3 kinds, expected 2',
  //     +   'the workspace carve-out members are ["feel-snapshot","screen-contract","trace"]'
  //     + ]
  //     - []
  const grown = new Set([...WORKSPACE_SCOPED_KINDS, "tile-render"]);
  assert.equal(workspaceCarveOutProblems(grown).length, 2);
  // …and a set that is the right SIZE but the wrong members is caught too, or "shrinking"
  // would be the only thing enforced.
  assert.ok(workspaceCarveOutProblems(new Set(["feel-snapshot", "tile-render"])).length > 0);
  // Shrinking (what S3 does) is a failure HERE on purpose: the expectation moves with the
  // code, in the same commit, rather than the guard silently tolerating either state.
  assert.ok(workspaceCarveOutProblems(new Set(["feel-snapshot"])).length > 0);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* W5. THE INVENTORY: EVERY `.loombridge/<segment>` SPELLED ANYWHERE          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * W1 to W4 all start from TypeScript that imports `loombridgePaths()`. Everything else is
 * invisible to them, and "everything else" is where this repo's most expensive failures live
 * (CLAUDE.md, "the recurring blind spot: declared paths nothing walks"). Three of the
 * destinations below are not TypeScript at all:
 *
 *   - `scripts/prepare-project-assets.sh` creates `.loombridge/handoff/` in a CONSUMER project.
 *   - `Editor/Handlers/CaptureHandler.cs` hard-codes `Path.Combine(projectRoot, ".loombridge",
 *     "verify")` as the C# write allowlist and THROWS `INVALID_PARAMS` outside it. Move
 *     `verify/` in TypeScript alone and every `capture.invoke_static` starts refusing while
 *     the whole Node suite stays green.
 *   - `Editor/Core/EditorInvokeAllowlist.cs` reads `.loombridge/editor-allowlist.json` on
 *     every invoke.
 *
 * So W5 scans TEXT, across file types, for the first path segment after the dirname, and
 * requires each segment to be classified. It reads RAW bytes, NOT `readCode`: a segment named
 * in a comment or in a `--help` string is still something an S2 move has to relocate or
 * restate, and resting this walk on the comment stripper would inherit whatever that stripper
 * gets wrong.
 */
interface PrefixHit {
  /** Repo-relative file the spelling was found in. */
  file: string;
  /** The FIRST path segment after `.loombridge/`. */
  segment: string;
  /** `home` for `~/.loombridge/...` (machine-global), `project` for project-local state. */
  scope: "home" | "project";
}

const SEGMENT_CHARS = "[A-Za-z0-9_.-]+";
const DIRNAME_RE_SOURCE = LOOMBRIDGE_DIRNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `com.loomtide.loombridge/Editor/...` ends in the dirname's characters but is the UPM package
 * id, not the state dir. The lookbehind rejects it: a real path segment is never preceded by a
 * word character.
 */
const PREFIX_RE = new RegExp(`(?<![A-Za-z0-9_-])${DIRNAME_RE_SOURCE}/(${SEGMENT_CHARS})`, "g");

/**
 * The SPLIT spelling: `Path.Combine(projectRoot, ".loombridge", "verify")` in C# and
 * `path.join(root, ".loombridge", "x")` in TypeScript never produce the `/` a plain scan looks
 * for. Normalising them into the joined form first is what stops the C# capture allowlist
 * being invisible to a check whose whole purpose is to see it.
 */
const SPLIT_JOIN_RE = new RegExp(`["']${DIRNAME_RE_SOURCE}["']\\s*,\\s*["'](${SEGMENT_CHARS})["']`, "g");

/**
 * THE TEMPLATE-LITERAL SPELLING: `` `${LOOMBRIDGE_DIRNAME}/anchors/traces/` ``.
 *
 * Composing off the CONSTANT is what W1 demands of every module, and it produces a string
 * with no `.loombridge` text in it at all, so a plain scan is blind to precisely the code
 * that is doing the right thing. The migration's whole remap table
 * (`capabilities/migrate/legacy-layout.ts`) is written this way, and every legacy path it
 * names is a path an S2 move had to relocate: the one table W5 most needs to see was the
 * one it could not. Normalised into the joined form first, exactly like the split C#/`path.join`
 * spelling above and for the same reason.
 */
const CONST_JOIN_RE = new RegExp(`\\$\\{LOOMBRIDGE_DIRNAME\\}/(${SEGMENT_CHARS})`, "g");

/**
 * `~/.loombridge`, `$HOME/.loombridge`, `${HOME}/.loombridge`, `%USERPROFILE%\.loombridge`.
 *
 * The separator is part of the pattern, not part of the match: the scan's match starts at the
 * dirname, so the text immediately before it ends with the `/` (or `\`) that follows the home
 * marker. Dropping that from the regex classified `~/.loombridge/runtime` as PROJECT state,
 * which is the exact confusion `LOOMBRIDGE_HOME_DIRNAME` exists to prevent.
 */
const HOME_PREFIX_RE = /(?:~|\$\{?HOME\}?|%USERPROFILE%)[/\\]$/;

/** THE SCAN. `files` is a parameter so a LITMUS can feed it a planted file. */
export function scanPrefixHits(files: readonly { file: string; text: string }[]): PrefixHit[] {
  const hits: PrefixHit[] = [];
  for (const { file, text } of files) {
    const normalized = text
      .replace(SPLIT_JOIN_RE, `${LOOMBRIDGE_DIRNAME}/$1`)
      .replace(CONST_JOIN_RE, `${LOOMBRIDGE_DIRNAME}/$1`);
    for (const match of normalized.matchAll(PREFIX_RE)) {
      // Trailing sentence punctuation is prose, not part of the name: `.loombridge/SLICES.json.`
      // at the end of a sentence names `SLICES.json`.
      const segment = match[1]!.replace(/[.-]+$/, "");
      // `.loombridge/.` and `.loombridge/../x` are relative-path plumbing, not children.
      if (segment === "" || segment === "." || segment === "..") continue;
      const before = normalized.slice(Math.max(0, match.index - 12), match.index);
      hits.push({ file, segment, scope: HOME_PREFIX_RE.test(before) ? "home" : "project" });
    }
  }
  return hits;
}

/**
 * THE MIGRATION INVENTORY, part 2: direct children of `.loombridge/` that are REAL and SHIPPED
 * but are NOT produced by `loombridgePaths()`, so W2 is structurally blind to every one. Each
 * entry names what writes or reads it, because that is what an S2 move has to go change.
 */
const UNDERIVED_CHILDREN: ReadonlyMap<string, string> = new Map([
  [
    "editor-allowlist.json",
    "packages/com.loomtide.loombridge/Editor/Core/EditorInvokeAllowlist.cs ConfigRelativePath, " +
      "read FRESH on every editor.invoke. C#, so no TypeScript walk can see it: moving it " +
      "without moving the C# constant refuses every allowlisted invoke. DOES NOT MOVE " +
      "(ArtifactStorage S2): human-authored config, and a committed named top-level file is " +
      "exactly what it should be.",
  ],
  [
    "genre-contract.json",
    "capabilities/genre/genre.ts runInit default out path (LOOMBRIDGE_DIRNAME + " +
      "DEFAULT_CONTRACT_FILENAME). A real direct child in real consumer projects today, and the " +
      "reason TOP_LEVEL_CHILDREN must not be read as the inventory. DOES NOT MOVE " +
      "(ArtifactStorage S2): already a correct committed named top-level file; it was simply " +
      "missing from the pin.",
  ],
]);

/**
 * THE PRE-S2 SEGMENTS: still SPELLED in the shipped tree, written by NOTHING.
 *
 * Every one of them is named by `capabilities/migrate/legacy-layout.ts` (the remap table
 * and the refusal prose) or by the migration verb, because moving a project off them is
 * the whole job. Declared as their own category rather than folded into
 * `DOCUMENTED_ONLY_CHILDREN`, because the two say different things: a documented-only
 * child is a slot nobody has built yet, a legacy child is a slot that was real and now has
 * a tombstone on it.
 *
 * A migration that finished is one where this table can eventually be deleted. Deleting it
 * EARLY is the failure it guards against: the remap rules would go with it, and a project
 * that had not migrated would silently present as having no anchors.
 */
const LEGACY_CHILDREN: ReadonlyMap<string, string> = new Map([
  [
    "replays",
    "the pre-S2 replay root. `traces/` and `baselines/` were ANCHORS living in a directory " +
      "the shipped template ignored (the RFC's mechanism 2); `reports/` was run output. " +
      "migrate-layout splits them and leaves a TOMBSTONE here so an older CLI reports a " +
      "broken anchor instead of asking a human to re-record.",
  ],
  ["reports", "pre-S2 verification reports; now run/reports/. Named by the remap table."],
  ["backups", "pre-S2 bridge install backups; now run/backups/. Named by the remap table."],
  [
    "captures",
    "pre-S2 ad-hoc screenshots; now run/captures/. Still scanned by " +
      "domain/contract-presence.ts as the hand-created false-green shape, because a project " +
      "that predates the move still has the directory.",
  ],
  ["art", "pre-S2 art/geometry snapshots; now run/art/. Named by the remap table."],
  ["handoff", "pre-S2 asset-prepare handoff; now run/handoff/. Named by the remap table."],
]);

/**
 * Named in shipped source but written by NOTHING today. Classified rather than dropped: a
 * segment silently omitted from the tables is indistinguishable from one nobody noticed, and
 * the point of the inventory is that every spelling has an owner and a decision.
 */
const DOCUMENTED_ONLY_CHILDREN: ReadonlyMap<string, string> = new Map([
  [
    "games",
    "capabilities/minigame/profiles/profiles.ts names '.loombridge/games/<id>.json' as the S6b+ " +
      "per-project contract slot. ASPIRATIONAL: nothing writes it. A migration owes it a decision " +
      "(adopt the new layout or delete the note), not a relocation.",
  ],
  // `traces` USED TO BE HERE, as the note in `domain/state.ts` recording that
  // `.loombridge/traces/` was scaffolded and DEAD. The note survives; the top-level
  // SPELLING does not, because the demonstrations now live at `.loombridge/anchors/traces/`
  // and a `.loombridge/traces/` in the same paragraph would read as a live second slot.
  // Its removal is enforced by the both-directions test below, not by anyone remembering.
]);

/**
 * `~/.loombridge/<segment>`: the MACHINE-GLOBAL root. This set must NOT move when the project
 * layout moves, which is the entire reason `LOOMBRIDGE_HOME_DIRNAME` is a separate constant
 * (W1). Listing it explicitly is what stops a bulk relocation treating a user's installed
 * runtime as project state.
 */
const HOME_ROOT_CHILDREN: ReadonlyMap<string, string> = new Map([
  ["asset-layer", "scripts/loombridge-install-locally.sh freezes profiles + registry + fixtures here."],
  [
    "projects",
    "domain/workspace-paths.ts workspacesRoot(): the cross-project verification workspaces " +
      "(feel snapshots, mini-game contracts). ArtifactStorage S3 EMPTIES this, which is a " +
      "different move from S2 and must not be folded into it.",
  ],
  ["runtime", "the frozen CLI runtime the `loombridge` bin execs. Renaming project state must never touch it."],
]);

/** Every project-local segment the tree spells: derived + underived + documented + legacy. */
const PROJECT_CHILDREN: ReadonlySet<string> = new Set([
  ...ALLOWED_SUBDIRS.keys(),
  ...TOP_LEVEL_CHILDREN,
  ...UNDERIVED_CHILDREN.keys(),
  ...DOCUMENTED_ONLY_CHILDREN.keys(),
  ...LEGACY_CHILDREN.keys(),
]);

/**
 * THE PREDICATE. One sentence per segment that no table declares. `projectChildren` and
 * `homeChildren` are parameters so a LITMUS can run the REAL scan against the DERIVED-ONLY
 * tables and prove what those tables miss.
 */
export function unclassifiedPrefixHits(
  hits: readonly PrefixHit[],
  projectChildren: ReadonlySet<string>,
  homeChildren: ReadonlySet<string>,
): string[] {
  const problems = new Map<string, string>();
  for (const hit of hits) {
    const declared = hit.scope === "home" ? homeChildren : projectChildren;
    if (declared.has(hit.segment)) continue;
    const key = `${hit.scope} ${LOOMBRIDGE_DIRNAME}/${hit.segment}`;
    if (!problems.has(key)) problems.set(key, `${key} (first spelled in ${hit.file})`);
  }
  return [...problems.values()].sort();
}

/**
 * The trees W5 reads, and which files in each count.
 *
 * SCOPE, stated so the inventory is not over-claimed. `Docs/`, `commands/`, `.skills/`,
 * `demos/` and `unity-dev-project/` are NOT scanned. Measured rather than assumed: scanning
 * them today adds exactly two segments, `.loombridge/run/` and `.loombridge/minigame/`, and
 * both come from `Docs/Design/ArtifactStorage.md`, where `run/` is the layout S2 PROPOSES and
 * `minigame/` is labelled "fictional" in the sentence that uses it. Pinning a proposal as a
 * today-fact would make the inventory lie in the other direction. Prose that names a path is
 * still prose an S2 move has to restate, and this guard does not cover it.
 */
const SCANNED_TREES: readonly { root: string; include: (rel: string) => boolean }[] = [
  // The shipped server source. Tests are excluded: a test that hard-codes a moved path FAILS
  // when the layout moves, so the suite guards itself. Shipped source has no such feedback,
  // which is precisely why it needs this walk.
  { root: path.join(PKG_ROOT, "src"), include: (rel) => rel.endsWith(".ts") && !rel.split("/").includes("__tests__") },
  { root: path.join(REPO_ROOT, "scripts"), include: () => true },
  // C# only, and not the EditMode suite, for the same self-guarding reason as above.
  { root: path.join(REPO_ROOT, "packages"), include: (rel) => rel.endsWith(".cs") && !rel.split("/").includes("Tests") },
  { root: path.join(REPO_ROOT, "templates"), include: () => true },
];

function filesUnder(root: string, include: (rel: string) => boolean, base = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const abs = path.join(root, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      filesUnder(abs, include, base, acc);
    } else if (include(path.relative(base, abs).split(path.sep).join("/"))) {
      acc.push(abs);
    }
  }
  return acc;
}

/** Every scanned file, as `{ file, text }`, read raw. */
function scannedFiles(): { file: string; text: string }[] {
  return SCANNED_TREES.flatMap(({ root, include }) =>
    filesUnder(root, include).map((abs) => ({
      file: path.relative(REPO_ROOT, abs).split(path.sep).join("/"),
      text: readFileSync(abs, "utf-8"),
    })),
  );
}

const PREFIX_HITS = scanPrefixHits(scannedFiles());

test("W5: every `.loombridge/<segment>` spelled anywhere in the shipped tree is classified", () => {
  assert.deepEqual(
    unclassifiedPrefixHits(PREFIX_HITS, PROJECT_CHILDREN, new Set(HOME_ROOT_CHILDREN.keys())),
    [],
    "a path segment under .loombridge/ exists in the shipped tree that no table declares. Add it " +
      "to ALLOWED_SUBDIRS/TOP_LEVEL_CHILDREN (derived), UNDERIVED_CHILDREN (real but not derived), " +
      "DOCUMENTED_ONLY_CHILDREN (named, never written), or HOME_ROOT_CHILDREN (machine-global, does " +
      "not move), and say what an S2 migration owes it",
  );
});

test("W5: the inventory is exactly the declared tables, in both directions", () => {
  // Both directions on purpose. A NEW segment fails the check above; a segment that no longer
  // exists fails HERE, so a table cannot rot into a list of paths nobody writes any more. The
  // observed side is derived from the scan, never re-typed.
  const observed = { project: new Set<string>(), home: new Set<string>() };
  for (const hit of PREFIX_HITS) observed[hit.scope].add(hit.segment);

  assert.deepEqual([...observed.project].sort(), [...PROJECT_CHILDREN].sort());
  assert.deepEqual([...observed.home].sort(), [...HOME_ROOT_CHILDREN.keys()].sort());

  // NON-VACUITY: the scan must have read a real, multi-language corpus. A scan that opened
  // nothing returns no hits and passes every emptiness assertion above it.
  const languages = new Set(PREFIX_HITS.map((h) => path.extname(h.file) || path.basename(h.file)));
  assert.ok(languages.has(".ts"), `no TypeScript hit; scanned extensions were ${JSON.stringify([...languages])}`);
  assert.ok(languages.has(".cs"), `no C# hit; scanned extensions were ${JSON.stringify([...languages])}`);
  assert.ok(languages.has(".sh"), `no shell hit; scanned extensions were ${JSON.stringify([...languages])}`);
  assert.ok(
    PREFIX_HITS.some((h) => h.file.startsWith("templates/")),
    "no template hit; the shipped project skeleton was not scanned",
  );
});

test("W5 LITMUS: against the DERIVED tables alone, the scan reports the nine it was blind to", () => {
  // This is the finding, run as an assertion rather than written down as a claim. Feed the
  // REAL scan the tables W1 to W4 rest on (`loombridgePaths()`'s own children and nothing
  // else), and it names every destination those walks cannot see. Each of these is live in the
  // shipped tree right now.
  const derivedOnly = new Set([...ALLOWED_SUBDIRS.keys(), ...TOP_LEVEL_CHILDREN]);
  assert.deepEqual(
    unclassifiedPrefixHits(PREFIX_HITS, derivedOnly, new Set(HOME_ROOT_CHILDREN.keys())).map((p) => p.split(" (")[0]),
    [
      // The six PRE-S2 segments, every one of them named by the migration's remap table
      // and by nothing else. That the derived tables cannot see them is the whole reason
      // an S2 migration needed an inventory rather than a walk of `loombridgePaths()`.
      "project .loombridge/art",
      "project .loombridge/backups",
      "project .loombridge/captures",
      "project .loombridge/handoff",
      "project .loombridge/replays",
      "project .loombridge/reports",
      // …plus the two committed named files no field produces, and the one aspirational
      // slot nothing writes.
      "project .loombridge/editor-allowlist.json",
      "project .loombridge/games",
      "project .loombridge/genre-contract.json",
    ].sort(),
    "the derived layout is NOT the inventory; if this list shrank, check whether the destination " +
      "was really routed through loombridgePaths() or merely stopped being spelled",
  );

  // …and with NO home table the machine-global root is reported too, which is what proves
  // HOME_ROOT_CHILDREN carries weight rather than being decoration.
  assert.deepEqual(
    unclassifiedPrefixHits(PREFIX_HITS, PROJECT_CHILDREN, new Set()).map((p) => p.split(" (")[0]),
    ["home .loombridge/asset-layer", "home .loombridge/projects", "home .loombridge/runtime"],
  );
});

test("W5 LITMUS: the scan fires on a planted destination, in each language it claims to read", () => {
  // OBSERVED. Add to `capabilities/verification/capture.ts`, verbatim:
  //
  //   const dest = path.join(root, ".loombridge/orphaned-anchors", `${id}.json`);
  //   await fs.mkdir(path.dirname(dest), { recursive: true });
  //   await fs.writeFile(dest, "{}\n", "utf-8");
  //
  // rebuild, re-run, and the REAL check above fails, verbatim:
  //
  //   ✖ W5: every `.loombridge/<segment>` spelled anywhere in the shipped tree is classified
  //     AssertionError [ERR_ASSERTION]: a path segment under .loombridge/ exists in the shipped tree that no table declares. Add it to ALLOWED_SUBDIRS/TOP_LEVEL_CHILDREN (derived), UNDERIVED_CHILDREN (real but not derived), DOCUMENTED_ONLY_CHILDREN (named, never written), or HOME_ROOT_CHILDREN (machine-global, does not move), and say what an S2 migration owes it
  //     + actual - expected
  //
  //     + [
  //     +   'project .loombridge/orphaned-anchors (first spelled in mcp-server/src/capabilities/verification/capture.ts)'
  //     + ]
  //     - []
  //
  // (`W5: the inventory is exactly the declared tables` and the derived-tables LITMUS fail
  // alongside it, for the same reason: the observed set grew by one.)
  //
  // W1 TO W4 STAYED GREEN THROUGH THAT: 51 of 54 passed and the only three failures were
  // W5's. That is the measurement behind this file's rewritten header. The same planted
  // module on the previous revision of this guard passed every check it had.
  //
  // The planted strings are ASSEMBLED from the constant rather than written out, for the reason
  // CLAUDE.md records: a bulk rewriter "tidied" the layering guard's literal specifier and
  // silently defused it.
  const D = LOOMBRIDGE_DIRNAME;
  const planted = [
    // TypeScript, joined spelling.
    { file: "mcp-server/src/capabilities/x.ts", text: `const dest = path.join(root, "${D}/orphaned-anchors");` },
    // C#, SPLIT spelling: the shape CaptureHandler.cs uses, which a plain `/` scan cannot see.
    { file: "packages/x/Editor/X.cs", text: `var p = Path.Combine(projectRoot, "${D}", "orphaned-anchors");` },
    // Shell, the shape prepare-project-assets.sh uses.
    { file: "scripts/x.sh", text: `HANDOFF_DIR="$PROJECT/${D}/orphaned-anchors"` },
    // Template config.
    { file: "templates/create-loombridge-game/.gitignore", text: `${D}/orphaned-anchors/` },
  ];
  for (const file of planted) {
    assert.deepEqual(
      unclassifiedPrefixHits(scanPrefixHits([file]), PROJECT_CHILDREN, new Set(HOME_ROOT_CHILDREN.keys())),
      [`project ${D}/orphaned-anchors (first spelled in ${file.file})`],
      `the scan missed a planted destination in ${file.file}`,
    );
  }

  // The home/project SPLIT has to be live too, or every machine-global path would be graded
  // against the project tables (and would pass, since `runtime` is not a project child).
  const home = scanPrefixHits([{ file: "scripts/x.sh", text: `cp -R "$X" ~/${D}/orphaned-anchors/` }]);
  assert.deepEqual(home.map((h) => h.scope), ["home"]);
  assert.deepEqual(
    unclassifiedPrefixHits(home, PROJECT_CHILDREN, new Set(HOME_ROOT_CHILDREN.keys())),
    [`home ${D}/orphaned-anchors (first spelled in scripts/x.sh)`],
  );

  // …and the UPM package id must NOT be read as a state-dir path, or the inventory would fill
  // with `Editor`, `Runtime`, `Tests` and stop meaning anything.
  assert.deepEqual(scanPrefixHits([{ file: "scripts/x.sh", text: "packages/com.loomtide.loombridge/Editor/x.cs" }]), []);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* W6. THE COMPOSE-OFF-`dir` CENSUS                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * W5 sees a destination only when its FIRST SEGMENT is spelled. `assets.ts` writes
 * `.loombridge/registry/<packId>.json` through
 * `path.join(loombridgePaths(root).dir, "registry")`, and the writing expression spells no
 * `.loombridge/registry` literal at all: W5 catches `registry` today only because a nearby
 * `console.error` happens to print the joined path. That is luck, not a guard. W6 is the check
 * that does not depend on the luck.
 *
 * HOW RELIABLE IS THIS? Precisely, because a check that LOOKS like it covers composition and
 * does not is worse than none:
 *
 *   RELIABLE: WHICH SITES EXIST. The receiver is identified by the TypeScript TYPE CHECKER,
 *     not by a name pattern. `input.before.dir` in `capabilities/telemetry/report.ts` is a
 *     different type and is correctly out of scope; a `LoombridgePaths` held in a variable
 *     under any name is in scope. A `.dir` use added anywhere in non-test source fails the pin
 *     below until someone classifies it.
 *   RELIABLE: THE COMPOSED SEGMENT, WHEN THE TYPE SYSTEM KNOWS IT. A string literal
 *     (`"registry"`) and an `as const` union (`CAPTURE_DIR_NAMES` yields `"verify" | "captures"`)
 *     both resolve, and both exist today.
 *   REFUSED, NEVER SKIPPED: a `path.join(dir, x)` whose `x` is not literal-typed is reported
 *     as `composes:UNRESOLVABLE` and fails unless it is excepted with a stated reason. This is
 *     the §"refuse when a bound field is absent" rule applied to a scan.
 *   NOT COVERED, SAID PLAINLY: the value ESCAPING under an alias. `const d = paths.dir` followed
 *     by `path.join(d, computeName())` in another function is classified `escapes` here and this
 *     guard cannot follow it. Following an alias needs dataflow analysis, not a syntactic walk.
 *     What W6 does instead is make every escape VISIBLE and require a reason for it, so the two
 *     that exist are decisions rather than blind spots. If a third appears, the honest fix is to
 *     route the destination back through a `LoombridgePaths` FIELD so W2 walks it, not to grow
 *     this scan into a dataflow engine.
 */
interface DirUseSite {
  /** `src/`-relative module. */
  file: string;
  /** `composes:<segments>` | `composes:UNRESOLVABLE` | `root-arg` | `escapes`. */
  kind: string;
  /** What the value is handed to, so a changed call site fails the pin. */
  callee: string;
  /** First path segments this site composes, empty for the non-composing kinds. */
  segments: string[];
}

const TS_PROGRAM_OPTIONS: ts.CompilerOptions = (() => {
  const configPath = path.join(PKG_ROOT, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, PKG_ROOT);
  return { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false };
})();

/**
 * A program over the shipped source, optionally with ONE planted module. The planted file is
 * served by a wrapping compiler host rather than written to disk, so the LITMUS cannot leave a
 * stray file behind, and it sits at a real path inside `src/` so its relative import of
 * `domain/state.js` resolves through the same module resolution the real code uses.
 */
function sourceProgram(planted?: { file: string; text: string }): ts.Program {
  const roots = [...ALL, ...(planted ? [planted.file] : [])];
  const host = ts.createCompilerHost(TS_PROGRAM_OPTIONS, true);
  if (planted) {
    // The originals are captured BEFORE the overrides are installed. Reading them off `host`
    // inside the override is a self-call that recurses until the stack dies.
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    const baseGetSourceFile = host.getSourceFile.bind(host);
    const isPlanted = (f: string): boolean => path.resolve(f) === path.resolve(planted.file);
    host.fileExists = (f) => isPlanted(f) || baseFileExists(f);
    host.readFile = (f) => (isPlanted(f) ? planted.text : baseReadFile(f));
    host.getSourceFile = (f, languageVersion, onError, shouldCreate) =>
      isPlanted(f)
        ? ts.createSourceFile(f, planted.text, languageVersion, true, ts.ScriptKind.TS)
        : baseGetSourceFile(f, languageVersion, onError, shouldCreate);
  }
  return ts.createProgram(roots, TS_PROGRAM_OPTIONS, host);
}

/** Every string value a type can be, or `null` when the type system does not know. */
function literalStrings(type: ts.Type): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  const values: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteral()) return null;
    values.push(part.value);
  }
  return values.length > 0 ? values : null;
}

function calleeName(node: ts.Node): string {
  if (ts.isCallExpression(node)) {
    const target = node.expression;
    if (ts.isPropertyAccessExpression(target)) return `${target.expression.getText()}.${target.name.text}`;
    return target.getText();
  }
  return ts.SyntaxKind[node.kind]!;
}

/**
 * THE CENSUS. Both the real check and its LITMUS call this. `program` is a parameter so the
 * LITMUS can hand it a program carrying a planted module.
 */
export function collectDirUseSites(program: ts.Program, roots: readonly string[]): DirUseSite[] {
  const checker = program.getTypeChecker();
  const wanted = new Set(roots.map((f) => path.resolve(f)));
  const sites: DirUseSite[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(sourceFile.fileName))) continue;
    const rel = path.relative(SRC, sourceFile.fileName).split(path.sep).join("/");
    // `domain/state.ts` is where `dir` is DECLARED; every other reader is what this walks.
    if (rel === "domain/state.ts") continue;

    const visit = (node: ts.Node): void => {
      // A destructured `dir` leaves no property access to follow, so it is REFUSED rather than
      // missed: there is no such binding today, and this is what keeps that true.
      if (ts.isObjectBindingPattern(node)) {
        const typeName = checker.typeToString(checker.getTypeAtLocation(node));
        const bindsDir = node.elements.some((el) => (el.propertyName ?? el.name).getText() === "dir");
        if (typeName.includes("LoombridgePaths") && bindsDir) {
          sites.push({ file: rel, kind: "escapes", callee: "ObjectBindingPattern", segments: [] });
        }
      }

      if (ts.isPropertyAccessExpression(node) && node.name.text === "dir") {
        const receiver = checker.typeToString(checker.getTypeAtLocation(node.expression));
        if (receiver.includes("LoombridgePaths")) {
          const parent = node.parent;
          let kind = "escapes";
          let segments: string[] = [];
          if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node)) {
            const composer =
              ts.isPropertyAccessExpression(parent.expression) &&
              (parent.expression.name.text === "join" || parent.expression.name.text === "resolve");
            const rest = parent.arguments.slice(parent.arguments.findIndex((a) => a === node) + 1);
            if (!composer || rest.length === 0) {
              kind = "root-arg";
            } else {
              const values = literalStrings(checker.getTypeAtLocation(rest[0]!));
              if (values === null) kind = "composes:UNRESOLVABLE";
              else {
                segments = [...new Set(values.map((v) => v.split("/")[0]!))].sort();
                kind = `composes:${segments.join(",")}`;
              }
            }
          }
          sites.push({ file: rel, kind, callee: calleeName(parent), segments });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

/** Stable one-line form, pinned below. No line numbers: those churn on unrelated edits. */
const formatDirUse = (s: DirUseSite): string => `${s.file} ${s.kind} via ${s.callee}`;

/**
 * Every `.dir` read outside `domain/state.ts`, pinned. A NEW site, a MOVED site, or a site
 * whose call target changed all fail here and have to be classified by a human, which is the
 * part of W6 that genuinely cannot drift.
 */
const EXPECTED_DIR_USES = [
  "capabilities/assets/asset-manifest.ts root-arg via fs.mkdir",
  "capabilities/verification/slices.ts root-arg via fs.cp",
  "capabilities/verification/slices.ts root-arg via fs.mkdir",
  // The false-green scan, and the one site that still composes off `.dir`. It reads
  // `run/captures` AND the legacy top-level `captures`, because a project that predates
  // ArtifactStorage S2 still has the old directory and a hand-created one there is exactly
  // the same false green it always was.
  "domain/contract-presence.ts composes:captures,run,verify via path.join",
  "domain/contract-presence.ts root-arg via fileExists",
  "surfaces/index.ts escapes via ArrayLiteralExpression",
];
// `capabilities/assets/assets.ts composes:registry via path.join` USED TO BE HERE. S2
// routed the registry through a `LoombridgePaths` FIELD, which is the fix W6's own header
// recommends for a composed destination ("route it back through a field so W2 walks it,
// not grow this scan into a dataflow engine"). One fewer composition, one more walked slot.

/** Sites whose destination this scan CANNOT resolve, each with the reason it is acceptable. */
const DIR_USE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "surfaces/index.ts escapes via ArrayLiteralExpression",
    "resolveSafeScreenshotOutputPath's `allowedRoots`: the state dir is a CONTAINMENT root here, " +
      "compared with path.relative, never composed into a destination. What lands under it is " +
      "decided by the caller's requested path, so there is nothing for a static scan to resolve. " +
      "The destinations that actually occur (.loombridge/captures/, .loombridge/art/) are " +
      "inventoried by W5 as UNDERIVED_CHILDREN instead.",
  ],
]);

const DIR_USES = collectDirUseSites(sourceProgram(), ALL);

/** Sites that are neither resolvable nor excepted, plus exceptions that have gone stale. */
export function unresolvedDirUses(
  sites: readonly DirUseSite[],
  exceptions: ReadonlyMap<string, string> = DIR_USE_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  for (const site of sites) {
    const key = formatDirUse(site);
    const opaque = site.kind === "escapes" || site.kind === "composes:UNRESOLVABLE";
    if (opaque && !exceptions.has(key)) {
      problems.push(`${key}: the composed destination cannot be resolved statically and has no stated reason`);
    }
    if (!opaque && exceptions.has(key)) {
      problems.push(`${key}: resolves fine now; its exception is stale, remove it`);
    }
  }
  return problems.sort();
}

test("W6: every `.dir` read off a LoombridgePaths is the pinned, classified set", () => {
  assert.deepEqual(
    DIR_USES.map(formatDirUse).sort(),
    EXPECTED_DIR_USES,
    "a LoombridgePaths `.dir` site was added, moved, or re-pointed. Every one of these composes or " +
      "consumes a project-local destination that no LoombridgePaths FIELD names, so it has to be " +
      "read and classified rather than absorbed",
  );

  // NON-VACUITY: the checker must really have been consulted. `capabilities/telemetry/report.ts`
  // reads `input.before.dir`, a `.dir` on a DIFFERENT type, and a name-based scan would list
  // it. Its absence is what proves this walks types, not identifiers.
  assert.equal(
    DIR_USES.some((s) => s.file.startsWith("capabilities/telemetry/")),
    false,
    "a non-LoombridgePaths `.dir` leaked into the census; the receiver test is matching names, not types",
  );
});

test("W6: every destination composed off `.dir` lands on a classified segment", () => {
  // The segments come from the type checker, not from a literal in this file, so a writer that
  // starts composing a new subdirectory fails here even though it spells no `.loombridge/...`
  // path anywhere. That is the hole `assets.ts` sat in.
  const composed = DIR_USES.flatMap((s) => s.segments.map((segment) => ({ file: s.file, segment, scope: "project" as const })));
  assert.ok(composed.length > 0, "no composed segment was resolved at all; the resolver is not running");
  assert.deepEqual(
    unclassifiedPrefixHits(composed, PROJECT_CHILDREN, new Set(HOME_ROOT_CHILDREN.keys())),
    [],
    "a destination composed off .loombridge/ is not in the inventory",
  );
});

test("W6: an unresolvable site is refused unless a reason is recorded", () => {
  assert.deepEqual(unresolvedDirUses(DIR_USES), []);

  // The exception's weight: with NO exceptions the predicate must report the allowlist root.
  assert.deepEqual(unresolvedDirUses(DIR_USES, new Map()), [
    "surfaces/index.ts escapes via ArrayLiteralExpression: the composed destination cannot be " +
      "resolved statically and has no stated reason",
  ]);

  // …and a stale exception is reported, so the list cannot rot into blanket permission. The
  // stale key is taken from a real RESOLVED site rather than re-typed, so this litmus cannot
  // quietly stop testing anything when that site moves.
  const resolved = DIR_USES.find((s) => !DIR_USE_EXCEPTIONS.has(formatDirUse(s)));
  assert.ok(resolved, "no resolved site to stale-except; the census returned only opaque sites");
  const stale = new Map([...DIR_USE_EXCEPTIONS, [formatDirUse(resolved), "no longer true"]]);
  assert.ok(unresolvedDirUses(DIR_USES, stale).some((p) => p.includes("its exception is stale")));
});

test("W6 LITMUS: the census fires on a planted composition that spells no path literal", () => {
  // OBSERVED. Change `writeImportedRegistryPacks` in `capabilities/assets/assets.ts` to compose
  // `path.join(loombridgePaths(root).dir, "orphaned-anchors")`, rebuild, re-run, and the REAL
  // checks above fail, verbatim:
  //
  //   ✖ W6: every `.dir` read off a LoombridgePaths is the pinned, classified set
  //     AssertionError [ERR_ASSERTION]: a LoombridgePaths `.dir` site was added, moved, or re-pointed. Every one of these composes or consumes a project-local destination that no LoombridgePaths FIELD names, so it has to be read and classified rather than absorbed
  //     + actual - expected
  //
  //       [
  //         'capabilities/assets/asset-manifest.ts root-arg via fs.mkdir',
  //     +   'capabilities/assets/assets.ts composes:orphaned-anchors via path.join',
  //     -   'capabilities/assets/assets.ts composes:registry via path.join',
  //         'capabilities/verification/slices.ts root-arg via fs.cp',
  //         'capabilities/verification/slices.ts root-arg via fs.mkdir',
  //         'domain/contract-presence.ts composes:captures,verify via path.join',
  //         'domain/contract-presence.ts root-arg via fileExists',
  //         'surfaces/index.ts escapes via ArrayLiteralExpression'
  //
  //   ✖ W6: every destination composed off `.dir` lands on a classified segment
  //     AssertionError [ERR_ASSERTION]: a destination composed off .loombridge/ is not in the inventory
  //     + actual - expected
  //
  //     + [
  //     +   'project .loombridge/orphaned-anchors (first spelled in capabilities/assets/assets.ts)'
  //     + ]
  //     - []
  //
  // W5 STAYED GREEN THROUGH THAT, which is the argument for W6 existing at all. The only
  // `.loombridge/registry` text in that module is a `console.error` progress line, and the
  // break did not touch it: the inventory still read `registry`, still did not read
  // `orphaned-anchors`, and the real write destination had moved. A check that finds a
  // destination through a nearby log message is finding it by luck.
  //
  // The planted module is served in-memory by a wrapping compiler host, so nothing is written
  // to the source tree. The segment is assembled from a variable rather than written inline for
  // the reason CLAUDE.md records about defused self-tests.
  const file = path.join(SRC, "capabilities", "verification", "__planted_dir_use__.ts");
  const segment = ["orphaned", "anchors"].join("-");
  const text = [
    `import path from "node:path";`,
    `import { loombridgePaths } from "../../domain/state.js";`,
    `export function plantedWriter(root: string): string {`,
    `  return path.join(loombridgePaths(root).dir, "${segment}", "x.json");`,
    `}`,
  ].join("\n");

  const sites = collectDirUseSites(sourceProgram({ file, text }), [...ALL, file]);
  const planted = sites.filter((s) => s.file === "capabilities/verification/__planted_dir_use__.ts");
  assert.deepEqual(
    planted.map(formatDirUse),
    [`capabilities/verification/__planted_dir_use__.ts composes:${segment} via path.join`],
    "the census missed a composition off .dir; without this, `registry` was only ever found by luck",
  );
  assert.deepEqual(
    unclassifiedPrefixHits(
      planted.flatMap((s) => s.segments.map((seg) => ({ file: s.file, segment: seg, scope: "project" as const }))),
      PROJECT_CHILDREN,
      new Set(HOME_ROOT_CHILDREN.keys()),
    ),
    [`project ${LOOMBRIDGE_DIRNAME}/${segment} (first spelled in capabilities/verification/__planted_dir_use__.ts)`],
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* NON-VACUITY FOR THE WHOLE FILE                                             */
/* ══════════════════════════════════════════════════════════════════════════ */

test("NON-VACUITY: the walks really walked something, and every category has a member", () => {
  const fieldCount = Object.keys(PATHS).length;
  const walked = [
    ...derivedDestinations(PATHS).map(({ field, value }) => ({ label: field, value })),
    ...nonDerivedDestinations(),
  ];

  // A guard that walked zero paths and passed is the exact failure this file exists to
  // prevent. The floor is the number of LoombridgePaths fields: W2 alone contributes
  // (fields - 2) and W3 adds the rest.
  assert.ok(
    walked.length >= fieldCount,
    `walked only ${walked.length} destinations for ${fieldCount} declared fields`,
  );
  assert.ok(fieldCount >= 20, `LoombridgePaths shrank to ${fieldCount} fields; the floor moved`);

  // Every allowed category has at least one real member. A category with none is either dead
  // (the `traces` slot this PR deleted was exactly that) or a hole in the classifier that a
  // planted path could slip through unnoticed.
  const populated = new Set(
    walked.map(({ value }) => classifyDestination(ROOT, value)).filter((c): c is string => c !== null),
  );
  assert.deepEqual(
    ALL_CATEGORIES.filter((c) => !populated.has(c)),
    [],
    "an allowed category with no destination is either dead layout or an unreachable branch",
  );

  // …and the classifier is not simply returning a category for everything.
  assert.equal(classifyDestination(ROOT, path.join(ROOT, "Assets", "Scenes", "Game.unity")), null);
  assert.equal(classifyDestination(ROOT, path.join(os.homedir(), "elsewhere.json")), null);
});
