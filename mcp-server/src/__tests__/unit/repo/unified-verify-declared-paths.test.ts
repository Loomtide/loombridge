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
];

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
