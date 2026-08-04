/**
 * The `tests` SECTION of the unified front door, driven the way a user drives it.
 *
 * The producer/consumer split (T1) means this door never launches Unity: `loombridge tests
 * run` produced the bytes, and everything here is a pure function of what it left on disk.
 * So the risks worth testing are not "does the parser work" (covered where the parser
 * lives) but the three ways a stored artifact could buy a green it did not earn:
 *
 *  1. a hand-authored or hand-edited pair grading as if a real editor produced it;
 *  2. a genuinely green suite printing as a full `pass`, when nothing a human approved was
 *     ever compared (G1);
 *  3. `--report` overwriting the stamped evidence the next run would have graded.
 *
 * Each case asserts the triple that matters together: what the plan SAID, what executed,
 * and what the process exited with.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { run as runVerifyCli } from "../../../../capabilities/verification/verify.js";
import { onRampLines } from "../../../../capabilities/verification/unified/orchestrator.js";
import {
  unifiedVerifyReportPath,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import {
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  TEST_RUN_LOG_FILE,
  sha256,
  testResultsPath,
} from "../../../../capabilities/tests/test-results-manifest.js";
import { loombridgePaths } from "../../../../domain/state.js";
import { greenNUnitXml, plantTestResults } from "../../../_support/test-results-fixture.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Run a verb with BOTH streams captured (the plan prints to stderr; nothing may leak). */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  const sink = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  console.error = sink;
  console.log = sink;
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = origError;
    console.log = origLog;
  }
}

async function readUnified(root: string): Promise<UnifiedVerifyReport> {
  return JSON.parse(
    await fs.readFile(unifiedVerifyReportPath(loombridgePaths(root).reports), "utf-8"),
  ) as UnifiedVerifyReport;
}

/** A planned project with the one captured input that makes a contract gate really grade. */
async function plannedProject(prefix: string): Promise<string> {
  const root = await tmpDir(prefix);
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);
  await fs.mkdir(paths.verifyInputs, { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
  return root;
}

// ── the red path: the gate exists for this ───────────────────────────────────

test("a stamped RED suite grades OFFLINE, tier 1, and the run reports `fail` at exit 1", async () => {
  // The committed EditMode fixture is a real red: 6 cases, one genuine assertion failure,
  // one skipped case. Unity exits 2 on genuine test failures, so the stamped exitCode is 2
  // and `exitCodeIsUnexplained` accounts for it: this must be an HONEST TIER 1, not a
  // harness fault. A blanket "non-zero exit is tier 2" here would mean the gate could never
  // report an assertion defect at all.
  const root = await tmpDir("tests-section-red-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root);
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const text = lines.join("\n");

    assert.equal(result, 1, "a failing suite is a GAME DEFECT (tier 1), never the harness tier");
    assert.match(text, /test-results 'editmode': will run \(offline\)/, "the plan says it grades offline");
    // Counts and names are the REAL trimmed fixture's (a genuine failing case from the
    // live 6000.3.20f1 run), not authored values: the fixture swap made this test's red a
    // red Unity actually produced.
    assert.match(text, /5 test\(s\): 3 passed, 1 failed/, "the section prints the counts it derived");
    assert.match(text, /SetProperty_ObjectReference_AssetPathStringAssignsAsset/, "…and names the failing case");

    const report = await readUnified(root);
    assert.equal(report.sections.tests?.exit, 1);
    assert.equal(report.sections.tests?.status, "fail");
    assert.equal(report.status, "fail");
    assert.equal(report.exit, 1);
    // T6: the per-failure detail is carried, not just the worst tier.
    assert.deepEqual(
      report.sections.tests?.assets?.map((a) => a.id),
      ["UnityBridge.Tests.ComponentHandlerTests.SetProperty_ObjectReference_AssetPathStringAssignsAsset"],
    );
    assert.match(String(report.sections.tests?.assets?.[0]?.note), /Expected string length 10 but was 54/);
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

// ── G1: a green suite is never a `pass` ──────────────────────────────────────

test("G1/FXH: a FORGED all-green pair is `partial` at EXIT 2; a tests-only run can never be green", async () => {
  // The attack this closes. A green NUnit3 document is trivially authorable, and its
  // manifest can be stamped so every sha and every cross-check agrees, which is exactly
  // what the planter does here, using the production writer. Integrity is therefore NOT the
  // thing standing in the way, and that is the point: binding proves provenance of bytes,
  // never that a human approved anything.
  //
  // DELIBERATE FLIP (FXH). This asserted exit 0 under G1 alone, which left the forgery's
  // ceiling at "a run that exits 0 but is called partial", and the exit is the part an agent
  // reads. With zero anchored executed sections the run now exits 2, so the moat ceiling for
  // a perfect tests-only forgery is a NON-ZERO exit.
  const root = await tmpDir("tests-section-forged-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0 });
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const text = lines.join("\n");

    const report = await readUnified(root);
    assert.equal(report.sections.tests?.exit, 0, "the suite really is green: the cap is about anchoring, not the tier");
    assert.equal(report.sections.tests?.anchored, false, "PERMANENTLY unanchored (R8)");
    assert.deepEqual(report.unanchoredSections, ["tests"]);
    assert.deepEqual(report.anchoredSections, []);
    assert.equal(report.status, "partial", "a green measured against nothing a human froze is not a pass");
    assert.equal(report.exit, 2, "FXH: nothing human-approved was compared, so the run cannot exit 0");
    assert.equal(result, 2);

    assert.notEqual(report.status as string, "pass");
    assert.ok(!text.includes("status=pass"), `the run must never print a pass:\n${text}`);
    assert.match(text, /no frozen anchor compared/, "the per-section marker says it");
    assert.match(text, /PARTIAL: no frozen human approval was compared in: tests/, "and so does the summary");
    assert.match(
      text,
      /REFUSED: nothing human-approved was compared; a self-produced green cannot exit 0 \(exit 2\)/,
      "FXH: the summary explains the exit, not only the word",
    );
    // FXQ: the section's own line carries the qualification in the STATUS WORD, which is the
    // part that gets quoted, while the JSON keeps the engine's plain word for consumers.
    assert.match(text, /tests: pass \(unanchored\)/);
    assert.equal(report.sections.tests?.status, "pass", "the JSON status word is unchanged");
    // FXC: the build scope of the graded evidence is readable from the report itself.
    assert.equal(report.sections.tests?.runId, null);
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("V7: `--only tests` NEVER exits 0: a red suite is 1, a GREEN one is 2 (the documented CI claim)", async () => {
  // The help text, `verify.md` and the RFC all used `--only tests` as THE example of a CI
  // step, and it is the one selection that can never produce the exit a CI step is looking
  // for: the tests section is permanently unanchored, so FXH caps a green tests-only run at 2
  // while a red one short-circuits at 1. The example moved to `--only screens` and the two
  // exits are now stated out loud, so they are pinned here rather than left as prose.
  const workspace = await tmpDir("tests-section-ws-");
  const red = await tmpDir("tests-only-red-");
  const green = await tmpDir("tests-only-green-");
  try {
    await plantTestResults(red); // the committed fixture: one genuine assertion failure
    const redRun = await captured(() => runVerifyCli(["--root", red, "--workspace", workspace, "--only", "tests"]));
    assert.equal(redRun.result, 1, "a real assertion failure is a GAME DEFECT, whatever else was scoped out");

    await plantTestResults(green, { xml: greenNUnitXml(), exitCode: 0 });
    const greenRun = await captured(() => runVerifyCli(["--root", green, "--workspace", workspace, "--only", "tests"]));
    assert.equal(greenRun.result, 2, "a GREEN tests-only run compared nothing human-approved, so it cannot exit 0");
    assert.match(
      greenRun.lines.join("\n"),
      /nothing human-approved was compared; a self-produced green cannot exit 0/,
    );
  } finally {
    for (const d of [workspace, red, green]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("doneness needs ZERO code change: it is keyed on the report's `exit`, and FXH only ADDS refusals", async () => {
  // `doneness` consumes the unified report as a REFUSE-ONLY input keyed on `exit`: a non-zero
  // exit ADDS a refusal reason and a zero exit adds nothing at all. FXH only ever turns a 0
  // into a 2, which is the refuse-only direction, so no code in `doneness` changes and no
  // project can be certified by this that could not be certified before. Asserted here rather
  // than trusted: the two documents are read by different modules, and only the field they
  // share keeps them agreeing.
  const root = await tmpDir("tests-section-doneness-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0 });
    await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const report = await readUnified(root);
    assert.equal(report.status, "partial", "the word narrowed…");
    assert.equal(report.exit, 2, "…and the field doneness reads went NON-ZERO, which only adds a refusal");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

// ── the not-runnable rows never execute ──────────────────────────────────────

test("an UNSTAMPED XML is a non-anchor: the section never runs and the run is not a pass", async () => {
  const root = await plannedProject("tests-section-unstamped-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root, { xml: greenNUnitXml(), omitManifest: true });
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "an unmeasurable row keeps the exit at the harness tier");
    assert.match(lines.join("\n"), /unstamped results/);

    const report = await readUnified(root);
    assert.equal(report.sections.tests, undefined, "a non-anchor row must never be executed");
    assert.equal(report.notRun.find((n) => n.kind === "test-results")?.why, "non-anchor");
    assert.equal(report.status, "partial");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("a manifest with NO results XML is broken: tier 2, and the section never runs", async () => {
  const root = await plannedProject("tests-section-noxml-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root, { omitResults: true });
    const { result } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2);

    const report = await readUnified(root);
    assert.equal(report.sections.tests, undefined);
    assert.equal(report.notRun.find((n) => n.kind === "test-results")?.why, "broken");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("G7/FXC: results not scoped to the build in flight are broken; the section never grades them", async () => {
  const root = await plannedProject("tests-section-runid-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    const paths = loombridgePaths(root);
    // A build in flight, and results stamped under a previous one.
    const state = JSON.parse(
      (await fs.readFile(paths.state, "utf-8")).match(/<!--\s*loombridge-state:\s*([\s\S]*?)-->/)![1]!.trim(),
    );
    state.currentBuild = { runId: "run-B", startedAt: "2026-07-28T00:00:00.000Z" };
    await fs.writeFile(
      paths.state,
      (await fs.readFile(paths.state, "utf-8")).replace(
        /<!--\s*loombridge-state:[\s\S]*?-->/,
        `<!-- loombridge-state: ${JSON.stringify(state)} -->`,
      ),
      "utf-8",
    );
    await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0, runId: "run-A" });

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "evidence about another build is a harness fault, never a game verdict");
    assert.match(lines.join("\n"), /results are not scoped to the build in flight/);

    const report = await readUnified(root);
    assert.equal(report.sections.tests, undefined, "a green suite from the wrong run must not grade");
    assert.equal(report.notRun.find((n) => n.kind === "test-results")?.why, "broken");

    // FXC: an UNSCOPED manifest is refused the same way while a build is in flight. The old
    // rule compared only when both ids were non-null, so `runId: null` passed by having
    // nothing to compare, which made "stamped before this build" indistinguishable from
    // "stamped for this build".
    await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0, runId: null });
    const unscoped = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(unscoped.result, 2, "an unscoped manifest is not evidence about the build in flight");
    assert.match(unscoped.lines.join("\n"), /results are not scoped to the build in flight/);
    assert.equal((await readUnified(root)).sections.tests, undefined);
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("G6: a project that DECLARES tests but never ran them cannot reach a pass by deleting the evidence", async () => {
  const root = await plannedProject("tests-section-declared-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await fs.mkdir(path.join(root, "Packages"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Packages", "manifest.json"),
      JSON.stringify({ dependencies: {}, testables: ["com.loomtide.loombridge"] }, null, 2),
      "utf-8",
    );

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2);
    assert.match(lines.join("\n"), /tests declared, no stamped results: run `loombridge tests run`/);

    const report = await readUnified(root);
    assert.equal(report.notRun.find((n) => n.kind === "test-results")?.why, "non-anchor");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

// ── the grade-time cross-checks (G4/G12) ─────────────────────────────────────

test("G12: a manifest summary that disagrees with the graded walk is refused at the harness tier", async () => {
  // The forgery this catches: leave the XML alone (so every sha still verifies) and edit the
  // manifest's summary to claim the run was clean. The grader re-derives the summary with
  // the SAME function the producer stamped with, so any disagreement means one of the two
  // was hand-written.
  const root = await tmpDir("tests-section-summary-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    await plantTestResults(root, {
      tamper: (manifest) => {
        manifest.summary = { total: 6, passed: 6, failed: 0, inconclusive: 0, skipped: 0 };
      },
    });
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "a self-contradicting manifest is untrustworthy evidence, not a red");
    assert.match(lines.join("\n"), /manifest summary disagrees with the graded walk/);

    const report = await readUnified(root);
    assert.equal(report.sections.tests?.exit, 2);
    assert.equal(report.status, "harness-fault");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("G4: compileErrors, mutatedProject, an unexplained exit, and an assembly mismatch each refuse at tier 2", async () => {
  // Four independent producer-stamped facts, each of which means "this run did not check
  // what it claims to have checked". A green XML is planted every time, so the ONLY thing
  // that can move the tier is the stamped fact under test.
  const cases: [string, Parameters<typeof plantTestResults>[1], RegExp][] = [
    ["compileErrors", { tamper: (m) => void (m.compileErrors = 3) }, /compile error line/],
    ["mutatedProject", { tamper: (m) => void (m.mutatedProject = true) }, /MUTATED ProjectSettings/],
    ["unexplained exit", { exitCode: 3 }, /Unity exited 3/],
    [
      "assembly mismatch",
      { tamper: (m) => void (m.assemblies = [...m.assemblies, "Never.Ran.Tests.dll"]) },
      /assembly set disagrees with the manifest/,
    ],
  ];
  for (const [label, opts, expected] of cases) {
    const root = await tmpDir(`tests-section-g4-${label.replace(/\W+/g, "-")}-`);
    const workspace = await tmpDir("tests-section-ws-");
    try {
      await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0, ...opts });
      const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
      assert.equal(result, 2, `${label}: a run that checked nothing is never a pass`);
      assert.match(lines.join("\n"), expected, label);
      assert.equal((await readUnified(root)).sections.tests?.exit, 2, label);
    } finally {
      for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
    }
  }
});

test("G12/F13: an XML edited AFTER stamping never reaches the grader", async () => {
  const root = await tmpDir("tests-section-edited-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    const dir = await plantTestResults(root);
    const before = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    // THE LITMUS, stated as the signal under test rather than as an exit code.
    // What has to be true before the edit is that the grader REACHED the bytes and said
    // nothing about a sha; that is the only thing the `after` half can then break. Pinning
    // this to `exit === 1` tied the litmus to the tier mapping, and the swap to a trimmed
    // REAL fixture moved that tier for a reason with nothing to do with tampering (the
    // ignored-fixture roll-up). A litmus that moves with an unrelated rule is a litmus that
    // gets "fixed" by deleting it.
    assert.doesNotMatch(before.lines.join("\n"), /sha256 mismatch/, "nothing has been tampered with yet");
    assert.notEqual(
      (await readUnified(root)).sections.tests,
      undefined,
      "the section must RUN before the edit, so the LITMUS has something to break",
    );

    // "The failing case is gone now." The bytes no longer hash to what was stamped.
    await fs.writeFile(testResultsPath(dir), greenNUnitXml(), "utf-8");
    const after = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(after.result, 2, "an edited results file is a refusal, never a silently re-graded run");
    assert.match(after.lines.join("\n"), /sha256 mismatch/);
    assert.equal((await readUnified(root)).sections.tests, undefined, "the section never ran on the edited bytes");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("an UNREADABLE results XML is the harness tier, never a pass over the cases it happened to see", async () => {
  const root = await tmpDir("tests-section-truncated-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    // Truncated mid-document, then RE-STAMPED (the sha is recomputed over the truncated
    // bytes with the production hasher) so integrity passes cleanly and the ONLY thing left
    // to catch it is the parser's own refusal at grade time. A killed editor or a full disk
    // produces exactly this: a file that is honestly what the manifest says it is, and
    // still unreadable.
    const dir = await plantTestResults(root, { xml: greenNUnitXml(), exitCode: 0 });
    const truncated = Buffer.from(greenNUnitXml().slice(0, greenNUnitXml().indexOf("<test-case") + 40), "utf-8");
    await fs.writeFile(testResultsPath(dir), truncated);
    const manifestPath = path.join(dir, TEST_RESULTS_MANIFEST);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.resultsSha256 = sha256(truncated);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2);
    assert.match(lines.join("\n"), /is unreadable/);
    assert.equal((await readUnified(root)).sections.tests?.exit, 2);
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

// ── --report may not target the stamped evidence ─────────────────────────────

test("--report is REFUSED for every file in the stamped test-results directory", async () => {
  const root = await tmpDir("tests-section-report-");
  const workspace = await tmpDir("tests-section-ws-");
  try {
    const dir = await plantTestResults(root);
    const relDir = path.relative(root, dir).split(path.sep).join("/");
    const before = await fs.readFile(testResultsPath(dir), "utf-8");

    for (const name of [TEST_RESULTS_FILE, TEST_RESULTS_MANIFEST, TEST_RUN_LOG_FILE, "anything-else.json"]) {
      const { result, lines } = await captured(() =>
        runVerifyCli(["--root", root, "--workspace", workspace, "--report", `${relDir}/${name}`]),
      );
      assert.equal(result, 2, `${name}: the stamped pair is evidence, never a report destination`);
      assert.match(lines.join("\n"), /REFUSED: --report/, name);
      assert.ok(!lines.join("\n").includes("plan for "), `${name}: the refusal comes BEFORE the plan, so nothing ran`);
    }
    assert.equal(await fs.readFile(testResultsPath(dir), "utf-8"), before, "the evidence is byte-identical");
  } finally {
    for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

// ── G15: the on-ramp is unchanged ────────────────────────────────────────────

test("G15: the on-ramp text does NOT name the tests asset", () => {
  // The on-ramp is the ONE place that names a human actor: the recording session IS the
  // approval moment, and it is what the whole human-anchor story hangs from. `tests run` is
  // self-serve and anchored to nothing, so adding it here would quietly convert a
  // human-anchor on-ramp into a self-serve one and hand an agent a way to satisfy the empty
  // project without a human ever playing the game.
  const text = onRampLines("/proj").join("\n");
  assert.ok(!text.includes("tests run"), `the on-ramp must not offer a self-serve asset:\n${text}`);
  assert.ok(!text.includes("test-results"), text);
  assert.match(text, /a HUMAN plays it/, "…and it still names the human actor, so this guard is not vacuous");
});

// ── portable binding at the DOORS (F4: the rule must be live, not merely defined) ──

test("PORTABLE: a committed trio grades at a moved checkout of the SAME repo; a foreign repo refuses", async () => {
  // The tier-2 CI story from Docs/Licensing-and-CI.md, driven through the REAL unified
  // door: the stamp carries the repo identity, the "CI checkout" lives at a different
  // absolute path with a different remote SPELLING of the same repository, and the trio
  // is copied over exactly as a git checkout would materialize it.
  const devRoot = await tmpDir("tests-portable-dev-");
  const ciRoot = await tmpDir("tests-portable-ci-");
  const foreignRoot = await tmpDir("tests-portable-foreign-");
  const workspace = await tmpDir("tests-portable-ws-");
  try {
    const plantGit = async (root: string, origin: string) => {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".git", "config"),
        `[remote "origin"]\n\turl = ${origin}\n`,
      );
    };
    await plantGit(devRoot, "git@github.com:Loomtide/portable-game.git");
    await plantGit(ciRoot, "https://github.com/Loomtide/portable-game");
    await plantGit(foreignRoot, "https://github.com/Loomtide/another-game");

    // Stamp at the dev checkout, with the portable identity the producer would derive.
    await plantTestResults(devRoot, {
      repoIdentity: "github.com/Loomtide/portable-game",
      projectPath: ".",
    });
    // "Commit + checkout": the trio materializes at the other roots byte-identically.
    for (const target of [ciRoot, foreignRoot]) {
      await fs.cp(loombridgePaths(devRoot).tests, loombridgePaths(target).tests, { recursive: true });
    }

    // Same repo, moved checkout: the row is runnable and the section grades.
    const ci = await captured(() => runVerifyCli(["--root", ciRoot, "--workspace", workspace]));
    assert.match(ci.lines.join("\n"), /test-results 'editmode': will run \(offline\)/, "portable match is LIVE at the door");
    assert.equal((await readUnified(ciRoot)).sections.tests?.exit, 1, "the real red grades as a real red in CI");

    // Different repo: refused, with the stamped identity named.
    const foreign = await captured(() => runVerifyCli(["--root", foreignRoot, "--workspace", workspace]));
    const text = foreign.lines.join("\n");
    assert.match(text, /BROKEN, will not run/);
    assert.match(text, /github\.com\/Loomtide\/portable-game/, "the refusal names the stamped identity");
    assert.equal(foreign.result, 2);
  } finally {
    for (const d of [devRoot, ciRoot, foreignRoot, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("LITMUS: a HALF-stamped test-results manifest is BROKEN at the door, in either direction", async () => {
  // `loadTestResultsManifest` calls `projectBindingPairError`, and deleting that call used
  // to survive the whole suite: the fixture hard-coupled the two fields, so no test could
  // plant the input the check exists for. A repoIdentity with no projectPath claims EVERY
  // position inside the repo, which is wider than the stamp ever asserted.
  for (const half of [
    { repoIdentity: "github.com/Loomtide/portable-game" },
    { projectPath: "." },
  ] as const) {
    const root = await tmpDir("tests-halfpair-");
    const workspace = await tmpDir("tests-halfpair-ws-");
    try {
      await plantTestResults(root, { xml: greenNUnitXml(), ...half });
      const run = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
      const text = run.lines.join("\n");
      assert.match(text, /BROKEN, will not run/, `${JSON.stringify(half)} must not grade: ${text}`);
      assert.match(text, /stamped together/, "the refusal names the half pair rather than a generic parse error");
      assert.equal(run.result, 2, "a refused stamp is a harness-tier refusal, never a pass");
    } finally {
      for (const d of [root, workspace]) await fs.rm(d, { recursive: true, force: true });
    }
  }
});
