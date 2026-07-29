/**
 * DECLARED PATHS NOTHING WALKS: the unified-verify filenames.
 *
 * This repo's most expensive failures are all the same shape: a path spelled in one
 * place and re-spelled in another, where a full green suite proves nothing because no
 * test walks the pair. A shipped release fetched an asset npm never produced; a doc
 * generator wrote to the wrong directory; a Unity `file:` dep never resolved.
 *
 * S1 adds three filenames with a writer and a reader on opposite sides:
 *   - `baseline-manifest.json` under a trace baseline dir (trace approve writes it,
 *     unified discovery reads it);
 *   - `verify.json` and `verify-screens.json` under `.loombridge/reports/`.
 *
 * The rule these tests enforce is not "the string is correct". A test asserting a
 * literal would drift with the code it guards. It is that each name has exactly ONE
 * spelling in the source, exported as a constant, and that every module touching the
 * file resolves it from that constant. A rename then moves both ends at once, or
 * fails to compile.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";
import {
  TRACE_BASELINE_MANIFEST,
  traceBaselineManifestPath,
} from "../../../capabilities/replay/trace-baseline-manifest.js";
import {
  UNIFIED_SCREENS_REPORT,
  UNIFIED_VERIFY_REPORT,
  unifiedScreensReportPath,
  unifiedVerifyReportPath,
} from "../../../capabilities/verification/unified/report.js";
import {
  TEST_RESULTS_DIRNAME,
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  TEST_RUN_LOG_FILE,
  testResultsDir,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
} from "../../../capabilities/tests/test-results-manifest.js";
import { LOOMBRIDGE_DIRNAME, loombridgePaths } from "../../../domain/state.js";

const SRC = path.join(PKG_ROOT, "src");

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

/**
 * THE SCAN. Both the real check and its LITMUS call this. A LITMUS that
 * re-implements the check inline proves nothing about the code that ships. `files`
 * is a parameter so the LITMUS can feed it a file with a hard-coded duplicate.
 */
export function filesHardCodingName(
  name: string,
  files: readonly string[],
  read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): string[] {
  const literal = new RegExp(`["'\`]${name.replace(/\./g, "\\.")}["'\`]`);
  return files
    .filter((f) => literal.test(read(f)))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();
}

const ALL = sourceFiles(SRC);

test("baseline-manifest.json has ONE spelling per owner, and the readers resolve it from the constant", () => {
  // Two DIFFERENT assets happen to share this basename in different directories (the
  // trace baseline and the screen-contract baseline). Each owns its own constant; what
  // must not exist is a third, anonymous copy of the string somewhere else.
  const owners = filesHardCodingName(TRACE_BASELINE_MANIFEST, ALL);
  assert.deepEqual(
    owners,
    ["capabilities/minigame/minigame-baseline.ts", "capabilities/replay/trace-baseline-manifest.ts"],
    "only the two declaring modules may spell this filename; every other module imports a constant",
  );

  // The writer's path helper and the reader's are the same function, so a rename of the
  // constant moves both ends at once.
  assert.equal(traceBaselineManifestPath("/b"), path.join("/b", TRACE_BASELINE_MANIFEST));
});

test("the unified report filenames are spelled once each, in the module that exports them", () => {
  assert.deepEqual(
    filesHardCodingName(UNIFIED_VERIFY_REPORT, ALL),
    ["capabilities/verification/unified/report.ts"],
  );
  assert.deepEqual(
    filesHardCodingName(UNIFIED_SCREENS_REPORT, ALL),
    ["capabilities/verification/unified/report.ts"],
  );
  assert.equal(unifiedVerifyReportPath("/r"), path.join("/r", UNIFIED_VERIFY_REPORT));
  assert.equal(unifiedScreensReportPath("/r"), path.join("/r", UNIFIED_SCREENS_REPORT));
});

test("the test-results filenames are spelled once each, in the module that exports them", () => {
  for (const name of [TEST_RESULTS_FILE, TEST_RESULTS_MANIFEST, TEST_RUN_LOG_FILE]) {
    assert.deepEqual(
      filesHardCodingName(name, ALL),
      ["capabilities/tests/test-results-manifest.ts"],
      `"${name}" must have exactly ONE spelling; every other module imports the constant`,
    );
  }
  assert.equal(testResultsPath("/d"), path.join("/d", TEST_RESULTS_FILE));
  assert.equal(testResultsManifestPath("/d"), path.join("/d", TEST_RESULTS_MANIFEST));
  assert.equal(testRunLogPath("/d"), path.join("/d", TEST_RUN_LOG_FILE));
});

test("the test-results DIRECTORY has one declaration, and both layers resolve the same path from it", () => {
  // The directory name is the one path constant that CROSSES A LAYER: `LoombridgePaths`
  // (domain) needs it, and the capability that writes into it needs it, and the layering is
  // one-directional so domain cannot import the capability. It therefore lives in
  // `domain/state.ts` and the capability re-exports it. What must not exist is a second,
  // independent spelling of the segment in either layer.
  //
  // Three other files quote the bare token, and NONE of them is spelling a path. They are
  // pinned by name so that a NEW file which starts quoting it has to come through this test
  // and justify itself:
  //   - `surfaces/cli.ts`                the VERB name, in the dispatch switch;
  //   - `unified/report.ts`              the SECTION name, in `UnifiedSectionName`;
  //   - `unified/orchestrator.ts`        that same section name, at the record/run call.
  // Different declarations that happen to share a word; a path is not one of them.
  assert.deepEqual(filesHardCodingName(TEST_RESULTS_DIRNAME, ALL), [
    "capabilities/verification/unified/orchestrator.ts",
    "capabilities/verification/unified/report.ts",
    "domain/state.ts",
    "surfaces/cli.ts",
  ]);

  // …and the check that actually protects the PATH: the composed relative directory must be
  // spelled nowhere in the source. Every module reaches it by joining the two constants, so
  // a literal `".loombridge/tests"` anywhere is by definition a second, drifting spelling.
  const composed = `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}`;
  assert.deepEqual(filesHardCodingName(composed, ALL), []);

  // LITMUS for that empty expectation: an empty result set is exactly what a defused scan
  // returns, so plant the duplicate and confirm the REAL scan sees it.
  const planted = path.join(SRC, "capabilities/tests/__planted__.ts");
  const read = (p: string): string =>
    p === planted ? `const dir = "${composed}";\nexport default dir;\n` : readFileSync(p, "utf-8");
  assert.ok(
    filesHardCodingName(composed, [...ALL, planted], read).includes("capabilities/tests/__planted__.ts"),
    "the scan missed a planted duplicate of the composed directory path",
  );

  // BOTH ENDS MOVE AT ONCE: the `LoombridgePaths` slot the unified door reads and the
  // capability's own resolver are the same path, derived from the same constants.
  assert.equal(loombridgePaths("/r").tests, path.join("/r", LOOMBRIDGE_DIRNAME, TEST_RESULTS_DIRNAME));
  assert.equal(testResultsDir("/r"), loombridgePaths("/r").tests);
});

/**
 * THE PROSE SITES. A declared path is not only a path two MODULES spell: the four places
 * below tell a human (or an agent) where the unified report lives, and prose is invisible
 * to a constant rename. Renaming `UNIFIED_VERIFY_REPORT` with the code alone leaves four
 * documents confidently naming a file nothing writes any more, which is the same
 * "declared path nothing walks" failure wearing different clothes.
 *
 * Each entry is (file, the constant-derived spelling it must contain).
 */
const PROSE_SITES: [string, string][] = [
  [path.join(PKG_ROOT, "src", "capabilities", "verification", "verify.ts"), `.loombridge/reports/${UNIFIED_VERIFY_REPORT}`],
  [path.join(PKG_ROOT, "src", "surfaces", "cli.ts"), `.loombridge/reports/${UNIFIED_VERIFY_REPORT}`],
  [path.join(REPO_ROOT, "commands", "loombridge", "verify.md"), `.loombridge/reports/${UNIFIED_VERIFY_REPORT}`],
  [path.join(REPO_ROOT, "Docs", "Design", "UnifiedVerify.md"), `.loombridge/reports/${UNIFIED_VERIFY_REPORT}`],
  // The verify-owned screens report is named in the two docs that describe the bare run.
  [path.join(REPO_ROOT, "commands", "loombridge", "verify.md"), `.loombridge/reports/${UNIFIED_SCREENS_REPORT}`],
  [path.join(REPO_ROOT, "Docs", "Design", "UnifiedVerify.md"), `.loombridge/reports/${UNIFIED_SCREENS_REPORT}`],
  // G11. The test-results trio is the newest declared path, and the prose that ROUTES an
  // agent to it is the half a constant rename cannot reach. `verify.md` is what an agent
  // opens to learn the gate exists; the CLI help and the RFC are where a human looks.
  [
    path.join(REPO_ROOT, "commands", "loombridge", "verify.md"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_FILE}`,
  ],
  [
    path.join(REPO_ROOT, "commands", "loombridge", "verify.md"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_MANIFEST}`,
  ],
  [
    path.join(REPO_ROOT, "Docs", "Design", "UnifiedVerify.md"),
    `${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_MANIFEST}`,
  ],
  // FXO. The run LOG was the one member of the trio no prose site pinned, so a rename of
  // `TEST_RUN_LOG_FILE` would have left the RFC and the project template naming a file nothing
  // writes. The template's `.gitignore` is the load-bearing one: its comment is the only place
  // that tells a human WHY the directory is committed, and a stale filename there is how the
  // exception gets "tidied up" by someone who cannot find the file it mentions.
  [
    path.join(REPO_ROOT, "Docs", "Design", "UnifiedVerify.md"),
    `${TEST_RESULTS_DIRNAME}/${TEST_RUN_LOG_FILE}`,
  ],
  [
    path.join(REPO_ROOT, "templates", "create-loombridge-game", ".gitignore"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/${TEST_RUN_LOG_FILE}`,
  ],
  [
    path.join(REPO_ROOT, "templates", "create-loombridge-game", ".gitignore"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_FILE}`,
  ],
  [
    path.join(REPO_ROOT, "templates", "create-loombridge-game", ".gitignore"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_MANIFEST}`,
  ],
  [
    path.join(PKG_ROOT, "src", "surfaces", "cli.ts"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/`,
  ],
  [
    path.join(PKG_ROOT, "src", "capabilities", "verification", "verify.ts"),
    `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}/`,
  ],
];

/**
 * THE PRODUCER STEP. The test-results asset is the only kind a user cannot produce from
 * inside `verify`: something has to run `loombridge tests run` first, and a plan row that
 * names the command is no help if the documents an agent actually reads never mention it.
 * These four sites are where that routing lives.
 */
const PRODUCER_SITES: string[] = [
  path.join(REPO_ROOT, "commands", "loombridge", "verify.md"),
  path.join(REPO_ROOT, "Docs", "Design", "UnifiedVerify.md"),
  path.join(PKG_ROOT, "src", "capabilities", "setup", "routing-doc.ts"),
  path.join(PKG_ROOT, "src", "capabilities", "verification", "unified", "discovery.ts"),
];

test("G11: every routing site names `loombridge tests run` as the producer step", () => {
  const missing = PRODUCER_SITES.filter((file) => !readFileSync(file, "utf-8").includes("loombridge tests run"));
  assert.deepEqual(
    missing.map((f) => path.relative(REPO_ROOT, f)),
    [],
    "an asset whose producer is a separate verb is unreachable when the prose does not name that verb",
  );
});

test("LITMUS: the producer-step walk really fires when a site stops naming the verb", () => {
  // The same predicate, fed a verb nothing names. If the sites still 'contain' it, the walk
  // above is decorative.
  const renamed = "loombridge tests execute";
  assert.deepEqual(
    PRODUCER_SITES.filter((file) => readFileSync(file, "utf-8").includes(renamed)),
    [],
  );
});

test("the user-facing prose names the report paths with the CONSTANT-derived spelling", () => {
  const missing: string[] = [];
  for (const [file, spelling] of PROSE_SITES) {
    if (!readFileSync(file, "utf-8").includes(spelling)) {
      missing.push(`${path.relative(REPO_ROOT, file)} does not name "${spelling}"`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a rename of the report constant left prose pointing at a file nothing writes; update these sites "
      + "(help text, CLI summary, command prose, RFC) with the code",
  );
});

test("LITMUS: the prose walk really fires when a site stops naming the path", () => {
  // Feed the same predicate a renamed constant. If the sites still 'contain' it, the walk
  // above is decorative.
  const renamed = `.loombridge/reports/${UNIFIED_VERIFY_REPORT.replace(".json", "-renamed.json")}`;
  const stillFound = PROSE_SITES.filter(([file]) => readFileSync(file, "utf-8").includes(renamed));
  assert.deepEqual(stillFound, [], "a renamed path must not be found in any prose site");
});

test("LITMUS: the scan really fires on a second, hard-coded copy of a declared name", () => {
  // Feed the SAME scan a fake module that re-spells the filename instead of importing
  // the constant. If this comes back empty the guard above is decorative.
  const planted = path.join(SRC, "capabilities/verification/unified/__planted__.ts");
  const read = (p: string): string =>
    p === planted
      ? `const target = "${UNIFIED_VERIFY_REPORT}";\nexport default target;\n`
      : readFileSync(p, "utf-8");

  const hits = filesHardCodingName(UNIFIED_VERIFY_REPORT, [...ALL, planted], read);
  assert.ok(
    hits.includes("capabilities/verification/unified/__planted__.ts"),
    `the scan missed a planted duplicate; it cannot be protecting anything: ${JSON.stringify(hits)}`,
  );

  // And the same scan is clean over the real tree for that planted path.
  assert.ok(!filesHardCodingName(UNIFIED_VERIFY_REPORT, ALL).includes("capabilities/verification/unified/__planted__.ts"));
});

test("LITMUS: the scan does NOT fire on a name that merely resembles a declared one", () => {
  // A scan that matched loosely would flag unrelated files and get relaxed into
  // uselessness. `verify.json` must not be found by a search for `verify-screens.json`.
  const planted = path.join(SRC, "capabilities/verification/unified/__lookalike__.ts");
  const read = (p: string): string =>
    p === planted ? `const x = "${UNIFIED_VERIFY_REPORT}";\nexport default x;\n` : readFileSync(p, "utf-8");

  assert.deepEqual(
    filesHardCodingName(UNIFIED_SCREENS_REPORT, [planted], read),
    [],
    "a lookalike filename must not be reported as a duplicate spelling",
  );
});
