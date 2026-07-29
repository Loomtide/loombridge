/**
 * DECLARED PATHS NOTHING WALKS: the two NON-SOURCE declarations the test-results gate
 * depends on.
 *
 * Both are the shape this repo keeps paying for. A `.gitignore` line and a workflow step are
 * invisible to a green TypeScript suite: 3000+ passing tests have shipped a broken `bin`
 * target, a doc generator writing to the wrong directory, and an unresolvable Unity `file:`
 * dependency, all because the declaration lived in a file no test opened.
 *
 *  1. `.loombridge/tests/` is COMMITTED evidence. If the project template ever starts
 *     ignoring it, the stamped results become local-only and the gate silently degrades to
 *     "whatever was on the last developer's machine". Nothing in the CLI would notice.
 *  2. The Unity workflow grades the GameCI artifacts with the SAME `tests grade` mapping the
 *     CLI uses (G10). Delete that step and CI keeps passing while its verdict and the CLI's
 *     drift apart, which is exactly the divergence the step exists to prevent.
 *
 * Both predicates are exported pure functions, and both LITMUS tests feed the REAL predicate
 * a broken input. A LITMUS that re-implements the check inline proves nothing about the code
 * that ships.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";
import { LOOMBRIDGE_DIRNAME, TEST_RESULTS_DIRNAME } from "../../../domain/state.js";
import {
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  TEST_RUN_LOG_FILE,
} from "../../../capabilities/tests/test-results-manifest.js";

const TEMPLATE_GITIGNORE = path.join(REPO_ROOT, "templates", "create-loombridge-game", ".gitignore");
const EDITMODE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "unity-editmode.yml");

/* -------------------------------------------------------------------------- */
/* G5: the template must not ignore the committed test-results slot           */
/* -------------------------------------------------------------------------- */

/**
 * Would this `.gitignore` hide `relPath`?
 *
 * A deliberately CONSERVATIVE reading of git's matching rules, because a false negative here
 * is a silently un-committed gate: an exact pattern, any PREFIX of the path (an ignored
 * parent hides its children), and a slash-free basename pattern (which git matches at any
 * depth). Trailing slashes and a leading `/` anchor are normalised away; `!` negations are
 * skipped, so a re-included path still reads as "not hidden".
 */
export function gitignoreHides(lines: readonly string[], relPath: string): boolean {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const pattern = line.replace(/^\//, "").replace(/\/+$/, "");
    if (pattern.length === 0) continue;
    if (prefixes.includes(pattern)) return true;
    if (!pattern.includes("/") && segments.includes(pattern)) return true;
  }
  return false;
}

const TESTS_RELPATH = `${LOOMBRIDGE_DIRNAME}/${TEST_RESULTS_DIRNAME}`;

test("G5: the project template COMMITS the stamped test-results slot while reports/ stays ignored", () => {
  const lines = readFileSync(TEMPLATE_GITIGNORE, "utf-8").split(/\r?\n/);

  assert.equal(
    gitignoreHides(lines, TESTS_RELPATH),
    false,
    `${TESTS_RELPATH} is the gate's committed evidence; ignoring it makes the stamped results local-only`,
  );

  // NON-VACUITY. The same predicate over the same file must still report the heavy run
  // artifacts as ignored, or the assertion above would pass on a `.gitignore` that ignores
  // nothing at all (or on a predicate that always returns false).
  assert.equal(
    gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/reports`),
    true,
    "reports/ must stay ignored: it is large, machine-specific, and regenerated every run",
  );
  assert.equal(gitignoreHides(lines, `${LOOMBRIDGE_DIRNAME}/replays`), true);

  // And the file says WHY, so the next person editing it does not helpfully "tidy up" by
  // adding the missing line.
  assert.match(
    readFileSync(TEMPLATE_GITIGNORE, "utf-8"),
    /NOT ignored, on purpose/,
    "the exception must be documented in the file, not only in a test",
  );
});

test("LITMUS: a planted ignore line for the test-results dir really fails the guard", () => {
  const real = readFileSync(TEMPLATE_GITIGNORE, "utf-8").split(/\r?\n/);
  // Every spelling someone might plausibly add, fed to the REAL predicate.
  for (const planted of [
    `${TESTS_RELPATH}/`,
    `${TESTS_RELPATH}`,
    `/${TESTS_RELPATH}/`,
    `${LOOMBRIDGE_DIRNAME}/`,
    TEST_RESULTS_DIRNAME,
  ]) {
    assert.equal(
      gitignoreHides([...real, planted], TESTS_RELPATH),
      true,
      `the guard missed a planted "${planted}"; it cannot be protecting anything`,
    );
  }
  // …and a lookalike must NOT fire, or the guard would be relaxed into uselessness the
  // first time it flagged an unrelated line.
  assert.equal(gitignoreHides([...real, ".loombridge/tests-old/"], TESTS_RELPATH), false);
  assert.equal(gitignoreHides([...real, "# .loombridge/tests/"], TESTS_RELPATH), false, "a comment is not a rule");
});

/* -------------------------------------------------------------------------- */
/* G10: the CI grade step                                                     */
/* -------------------------------------------------------------------------- */

/** The artifacts glob the grade step must walk, derived from the GameCI step's own path. */
export const CI_RESULTS_GLOB = "unity-test-results/${{ matrix.label }}/*.xml";

/** The step's `name:` value, which is also how its block is located in the file. */
const GRADE_STEP_NAME = "Grade Unity test results";

/**
 * FXP: the `node ...` target the grade step invokes, DERIVED from the package's own `bin`
 * rather than re-spelled here.
 *
 * The exact "declared path nothing walks" shape this repo keeps paying for: the workflow says
 * `node mcp-server/dist/surfaces/cli.js`, and nothing in a green TypeScript suite notices when
 * the built entrypoint moves. One derivation, from `package.json`, so a moved `bin` fails this
 * guard instead of failing a CI job three weeks later.
 */
export function ciCliInvocationTarget(): string {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")) as {
    bin?: Record<string, string>;
  };
  const entry = pkg.bin?.loombridge;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("mcp-server/package.json declares no `bin.loombridge`; the workflow has nothing to call");
  }
  // The workflow runs from the repo root, so the path it types is the package dir + the bin.
  return `${path.basename(PKG_ROOT)}/${entry}`;
}

/**
 * FXG: the lines that make the grade loop keep the WORST tier across the graded XMLs.
 *
 * `node ... || status=$?` alone keeps the LAST non-zero one, so a harness fault (2) followed
 * by a plain red (1) reports 1: a game verdict standing in for "that part of the run could not
 * be trusted", which is the exact inversion CLAUDE.md forbids. These fragments are what the
 * worst-of arithmetic is made of, and the LITMUS below plants the last-wins form to prove the
 * guard fires on it.
 */
const WORST_STATUS_FRAGMENTS = ["rc=0", "|| rc=$?", '[ "$rc" -eq 2 ]', '[ "$status" -eq 0 ]', "status=$rc"];

/**
 * Everything wrong with the workflow's grading wiring, as named sentences. Empty means the
 * step is present, self-contained, walks the artifacts glob, and runs unconditionally.
 */
export function workflowGradeStepProblems(yaml: string): string[] {
  const problems: string[] = [];
  const lines = yaml.split(/\r?\n/);

  const start = lines.findIndex((l) => l.trim() === `- name: ${GRADE_STEP_NAME}`);
  if (start < 0) {
    problems.push(`no step named "${GRADE_STEP_NAME}": CI never grades the XML with the CLI's own mapping`);
    return problems;
  }
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().startsWith("- ") && line.length - line.trimStart().length === indent) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end).join("\n");

  if (!/^\s*if:\s*always\(\)\s*$/m.test(block)) {
    problems.push("the grade step is not `if: always()`: a red suite is exactly when grading must not be skipped");
  }
  if (!block.includes(CI_RESULTS_GLOB)) {
    problems.push(`the grade step does not walk ${CI_RESULTS_GLOB}: it grades nothing GameCI produced`);
  }
  if (!/tests grade --results/.test(block)) {
    problems.push("the grade step does not invoke `tests grade --results`: it is not the CLI's mapping");
  }
  // FXP: it must call the entrypoint the package actually declares, not a path that was
  // correct when it was typed.
  const target = ciCliInvocationTarget();
  if (!block.includes(`node ${target}`)) {
    problems.push(`the grade step does not run \`node ${target}\`: the declared bin and the workflow have drifted`);
  }
  // FXG: the loop keeps the WORST tier, never the last non-zero one.
  const missingWorst = WORST_STATUS_FRAGMENTS.filter((fragment) => !block.includes(fragment));
  if (missingWorst.length > 0) {
    problems.push(
      "the grade loop does not keep the WORST tier across the graded XMLs (2 beats 1 beats 0); " +
        `missing: ${missingWorst.join(", ")}`,
    );
  }
  // SELF-CONTAINED (G10): the runner has no Node toolchain and no built CLI by default, so
  // the step is inert without both. A workflow that "has the step" but never builds the
  // thing it calls is the same declared-path failure one layer down.
  if (!yaml.includes("actions/setup-node")) {
    problems.push("the job never sets up Node, so the grade step cannot run the CLI");
  }
  if (!/npm ci/.test(yaml) || !/npm run build/.test(yaml)) {
    problems.push("the job never builds the CLI (npm ci + npm run build in mcp-server)");
  }
  return problems;
}

test("G10: the Unity workflow grades the GameCI artifacts with the CLI's own mapping", () => {
  const yaml = readFileSync(EDITMODE_WORKFLOW, "utf-8");
  assert.deepEqual(
    workflowGradeStepProblems(yaml),
    [],
    "CI and `loombridge tests grade` must not be able to disagree about what an NUnit3 file means",
  );

  // The glob is the GameCI step's OWN output path, not a second guess at it. If the
  // artifactsPath ever moves, this assertion moves the grade step with it.
  assert.ok(
    yaml.includes(`artifactsPath: ${CI_RESULTS_GLOB.replace("/*.xml", "")}`),
    "the grade step's glob must be rooted at the GameCI action's artifactsPath",
  );
  // The step stays inside the license-gated job: a fork with no UNITY_LICENSE must keep
  // skipping gracefully rather than failing on a suite it could never have run.
  assert.match(yaml, /has_license == 'true'/);
});

test("LITMUS: the workflow guard really fires on a planted removal", () => {
  const yaml = readFileSync(EDITMODE_WORKFLOW, "utf-8");
  assert.deepEqual(workflowGradeStepProblems(yaml), [], "clean before planting, so the LITMUS has something to break");

  // 1. The whole step deleted.
  const noStep = yaml.replace(`- name: ${GRADE_STEP_NAME}`, "- name: Something else entirely");
  assert.ok(
    workflowGradeStepProblems(noStep).some((p) => p.includes("no step named")),
    "a removed grade step must fail the guard",
  );

  // 2. The glob quietly re-pointed at a directory GameCI does not write.
  const wrongGlob = yaml.replace(CI_RESULTS_GLOB, "results/*.xml");
  assert.ok(
    workflowGradeStepProblems(wrongGlob).some((p) => p.includes("does not walk")),
    "a re-pointed glob must fail the guard",
  );

  // 3. `if: always()` dropped from the grade step, so a red suite skips its own grading.
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${GRADE_STEP_NAME}`);
  const conditional = [...lines.slice(0, start + 1), ...lines.slice(start + 2)].join("\n");
  assert.ok(
    workflowGradeStepProblems(conditional).some((p) => p.includes("if: always()")),
    "a conditional grade step must fail the guard",
  );

  // 4. The build removed, leaving a step that calls a CLI that was never compiled.
  const noBuild = yaml.replace(/npm run build/g, "echo skip");
  assert.ok(
    workflowGradeStepProblems(noBuild).some((p) => p.includes("never builds the CLI")),
    "a step that calls an unbuilt CLI must fail the guard",
  );

  // 5. FXP: the node target quietly re-pointed at a path the package does not declare. This
  //    is the declared-path failure one layer down: the step exists, is unconditional, walks
  //    the right glob, and calls a file that was never built.
  const movedBin = yaml.replace(`node ${ciCliInvocationTarget()}`, "node mcp-server/dist/cli.js");
  assert.ok(
    workflowGradeStepProblems(movedBin).some((p) => p.includes("declared bin and the workflow have drifted")),
    "a node target that does not match package.json bin must fail the guard",
  );

  // 6. FXG: the loop reverted to last-non-zero-wins, which reports a game verdict (1) for a
  //    run whose first XML was a harness fault (2).
  const lastWins = yaml
    .replace(/\n\s+rc=0\n/, "\n")
    .replace("|| rc=$?", "|| status=$?")
    .replace(/\n\s+if \[ "\$rc" -ne 0 \][\s\S]*?\n\s+fi\n/, "\n");
  assert.ok(
    workflowGradeStepProblems(lastWins).some((p) => p.includes("WORST tier")),
    `a last-non-zero-wins loop must fail the guard; got: ${JSON.stringify(workflowGradeStepProblems(lastWins))}`,
  );
});

test("FXP: the CI invocation target is derived from the package's own bin, and it exists in the tree", () => {
  const target = ciCliInvocationTarget();
  // The derivation is real: the file it names is the one `npm run build` produces, and the
  // path is relative to the REPO root because that is where the workflow runs.
  assert.equal(target, `${path.basename(PKG_ROOT)}/${"dist/surfaces/cli.js"}`);
  assert.ok(
    readFileSync(EDITMODE_WORKFLOW, "utf-8").includes(`node ${target}`),
    "the workflow must call the derived target",
  );
});

test("Docs/Licensing-and-CI.md: the machine-checkable claims hold", () => {
  // The doc makes assertions a rename or workflow edit would silently falsify: the
  // committed slot's name, the grade command it tells CI to run, and the license-gated
  // workflow it describes. Walk them against the constants and the workflow text, the
  // same discipline as the declared-path guard (a doc naming a file nothing writes is
  // this repo's signature failure shape, in prose form).
  const doc = readFileSync(path.join(REPO_ROOT, "Docs", "Licensing-and-CI.md"), "utf-8");
  assert.ok(
    doc.includes(`.loombridge/${TEST_RESULTS_DIRNAME}/`),
    "the doc names the committed slot by the constant-derived spelling",
  );
  for (const file of [TEST_RESULTS_FILE, TEST_RESULTS_MANIFEST, TEST_RUN_LOG_FILE]) {
    assert.ok(doc.includes(file), `the doc names ${file}`);
  }
  assert.ok(
    doc.includes(`loombridge tests grade --results .loombridge/${TEST_RESULTS_DIRNAME}/${TEST_RESULTS_FILE}`),
    "the CI snippet is the real command against the real path",
  );
  const workflow = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "unity-editmode.yml"), "utf-8");
  assert.ok(workflow.includes("tests grade --results"), "the tier-3 workflow really runs the grade step the doc describes");
  assert.ok(workflow.includes("UNITY_LICENSE"), "…and really is license-gated as the doc claims");
});
