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
 * FOUR WALKS, none of which hand-lists what it checks:
 *   W1  the literal `.loombridge` has exactly TWO spellings in the whole source tree, and both
 *       are declarations: the project dirname, and the independent home-root dirname that is
 *       not a project path at all. That is what makes W2 exhaustive. With the PROJECT dirname
 *       spelled exactly once, every project-local destination has to flow through
 *       `loombridgePaths()` to exist, so walking that object walks all of them.
 *   W2  every field of `loombridgePaths()` is walked via `Object.entries`, so a field added
 *       tomorrow is classified automatically or the test fails.
 *   W3  the destinations that do NOT flow through `loombridgePaths()`, each resolved by
 *       calling the REAL function that produces it, classified or excepted with a reason.
 *   W4  the workspace carve-out (anchors that live outside the project) is closed at two
 *       members and shrinking.
 *
 * Every LITMUS below feeds a PLANTED input to the SAME exported predicate the real check
 * calls. An empty violation list is exactly what a defused predicate returns, so an empty
 * expectation on its own proves nothing. Each also records, verbatim, the failure observed
 * when the real source was broken and the suite re-run.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";
import { filesHardCodingName } from "./unified-verify-declared-paths.test.js";
import { gitignoreHides } from "./test-results-declarations.test.js";
import { stripCommentary } from "./layering.test.js";

import { LOOMBRIDGE_DIRNAME, loombridgePaths, type LoombridgePaths } from "../../../domain/state.js";
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

test("W1: the `.loombridge` literal has exactly two spellings, and both are declarations", () => {
  assert.deepEqual(
    filesHardCodingName(LOOMBRIDGE_DIRNAME, ALL, readCode),
    DIRNAME_DECLARING_MODULES,
    "every other module must compose from LOOMBRIDGE_DIRNAME / loombridgePaths(); a third spelling " +
      "is a project-local destination W2 cannot see",
  );
  // The two constants are independent declarations that happen to agree today. If a future
  // change makes them disagree this assertion is what tells the next reader that was on
  // purpose, rather than leaving a silent divergence.
  assert.equal(LOOMBRIDGE_DIRNAME, LOOMBRIDGE_HOME_DIRNAME);
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
 * The categories a destination under `.loombridge/` may fall into today, and whether the
 * shipped project template commits or ignores each.
 *
 * PR-B replaces this table with `anchors/`, `tests/`, `design/`, a contract file, and `run/`.
 * The `committed` column is where the RFC's finding is visible: `replays/` is IGNORED today
 * and holds both the recorded human demonstrations and the approved pixel baselines, which
 * is the RFC's mechanism 2 ("the one project-local anchor is gitignored by our own
 * template"). It is pinned here as TODAY'S FACT, not as an endorsement, so that the S2 move
 * changes an assertion a reviewer can read rather than changing nothing visible.
 */
const ALLOWED_SUBDIRS: ReadonlyMap<string, { category: string; committed: boolean }> = new Map([
  ["design", { category: "design", committed: true }],
  ["reports", { category: "reports", committed: false }],
  ["tests", { category: "tests", committed: true }],
  ["backups", { category: "backups", committed: false }],
  ["replays", { category: "replays", committed: false }],
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
 * Every direct child of `.loombridge/` the layout declares. Pinned so a NEW top-level file or
 * directory has to come through this guard and justify itself, instead of appearing in a
 * consumer's repo root as a surprise.
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
  "backups",
  "design",
  "replays",
  "reports",
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

test("W2: the direct children of `.loombridge/` are exactly the pinned set", () => {
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
  assert.equal(gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/reports`), true);
  assert.equal(gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/design`), false);
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
  [
    "screenshot-allowlist.captures",
    // Top-level `captures/` predates `.loombridge/` and is still admitted by the screenshot
    // allowlist. The RFC (S2 scope) names it as one of the two directories the template
    // `.gitignore` misses today. PR-B is where it stops being admitted, not PR-A.
    "top-level captures/ predates the .loombridge/ layout and is still an allowlisted screenshot " +
      "root; ArtifactStorage S2 folds it in, PR-A only pins that it is still there.",
  ],
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
    // The screenshot allowlist, probed by CALLING it: one entry per admitted root.
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

test("W3: the screenshot allowlist admits exactly the two project-root-relative roots it declares", () => {
  // Derived by calling the real function, so a widened allowlist fails here rather than
  // quietly admitting a new write target under the project root.
  assert.deepEqual(admittedScreenshotRoots(SCREENSHOT_PROBE_SEGMENTS, ROOT), [".loombridge", "captures"]);

  // NON-VACUITY: the probe must still REFUSE the two directories a screenshot must never
  // reach, or "admits exactly" above would be true of a function that admits everything.
  assert.deepEqual(admittedScreenshotRoots(["Assets", "ProjectSettings"], ROOT), []);
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
  // The other two exceptions carry weight too, by the same argument.
  assert.ok(problems.some((p) => p.startsWith("trace-directory.unbound ->")));
  assert.ok(problems.some((p) => p.startsWith("screenshot-allowlist.captures ->")));
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
