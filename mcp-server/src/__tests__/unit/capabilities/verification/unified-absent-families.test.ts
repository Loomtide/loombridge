/**
 * WHAT VERIFY DID NOT CHECK, and why (the absent-family report).
 *
 * THE REPRODUCTION, observed live. A human ran `loombridge verify --live` on a real
 * project and got a verdict covering exactly one asset, a replay trace. They asked, quite
 * reasonably, "earlier we would see safe area issues etc. Which are not there in the report
 * now." Verify was behaving correctly: it grades the assets that exist, and that project has
 * no screen contract, so no safe-area, tap-target or required-object check ran. But NOTHING
 * IN THE OUTPUT SAID SO, and the three readings a human has to distinguish, "those passed",
 * "those do not exist here", and "those silently did not run", printed identically.
 *
 * These tests pin four things:
 *
 *  1. the reproduction: a trace-only project NAMES the five families it has no asset of,
 *     the screen contract among them, with the command that creates one;
 *  2. the derive-do-not-hand-list property: the enumeration comes from the catalog
 *     `discovery` itself is built from, so a seventh kind cannot be silently omitted;
 *  3. THE MOAT: gaps are informational. Status and exit are a function of what EXECUTED
 *     and what was discovered-but-not-run, and nothing else;
 *  4. the JSON report carries the same gaps stdout printed.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSET_KINDS,
  ASSET_KIND_CATALOG,
  absentAssetFamilies,
  type AssetKindEntry,
  type DiscoveredAssetKind,
} from "../../../../capabilities/verification/unified/discovery.js";
import { runUnifiedVerify } from "../../../../capabilities/verification/unified/orchestrator.js";
import {
  resolveUnifiedOutcome,
  unifiedVerifyReportPath,
  type UnifiedSectionName,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import { DEFAULT_DRIFT_FRACTION } from "../../../../capabilities/replay/visual-diff.js";
import { fileExists, loombridgePaths, standardReplayLayout } from "../../../../domain/state.js";

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

/**
 * THE HUMAN'S PROJECT: one approved trace and nothing else. No acceptance contract, no
 * roadmap, no declared tests, and an empty workspace, so five of the six known families
 * have no asset at all.
 */
async function traceOnlyProject(): Promise<{ root: string; workspace: string }> {
  const root = await tmpDir("absent-families-");
  const workspace = await tmpDir("absent-families-ws-");
  const layout = standardReplayLayout(root);
  const id = "happy-path";
  await fs.mkdir(layout.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(layout.replayTraces, `${id}.trace.json`),
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "s", actions: [] }],
      outcome: { expected: "success" },
    }),
  );
  const actualDir = path.join(layout.replayReports, id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actualPng = path.join(actualDir, "cap.png");
  await fs.writeFile(actualPng, Buffer.from(`frame-${id}`));
  await fs.writeFile(
    path.join(layout.replayReports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
  // The REAL approve verb stamps the baseline manifest, so the trace row is a genuine
  // human-approved anchor rather than a hand-written one.
  const approved = await captured(() => runTrace(["approve", "--id", id, "--root", root]));
  assert.equal(approved.result, 0, `approve ${id}:\n${approved.lines.join("\n")}`);
  return { root, workspace };
}

/** The flow seam's clean return (a live replay needs an editor; only the engine is a double). */
function cleanFlow(): {
  status: string;
  exitTier: number;
  suggestTolerance: boolean;
  htmlPath: string;
  driftCaptures: number;
  maxDiffFraction: number;
  toleranceUsed: number;
} {
  return {
    status: "pass",
    exitTier: 0,
    suggestTolerance: false,
    htmlPath: "",
    driftCaptures: 0,
    maxDiffFraction: 0,
    toleranceUsed: DEFAULT_DRIFT_FRACTION,
  };
}

async function readUnified(root: string): Promise<UnifiedVerifyReport> {
  const file = unifiedVerifyReportPath(loombridgePaths(root).reports);
  return JSON.parse(await fs.readFile(file, "utf-8")) as UnifiedVerifyReport;
}

/*
 * LITMUS, run 2026-08-11. The absent-family loop deleted from `planLines` (the real
 * production path, driven through `runUnifiedVerify`, not re-implemented here):
 *
 *   ✖ the REPRODUCTION: a trace-only project NAMES the families it has no asset of
 *     AssertionError [ERR_ASSERTION]: the screen-contract family must be named, with what
 *     it would have covered:
 *     [loombridge verify] plan for /var/folders/…/T/absent-families-cAXWGa (offline + live):
 *     [loombridge verify]   trace 'happy-path': will run (live); approved 2026-08-11T13:17:50.182Z (recorded from replay report 3e0b5026da08)
 *     [loombridge verify] flow: pass (no report produced this run, exit 0) [happy-path=pass]
 *     [loombridge verify] NOT CHECKED (no asset of this kind exists here, …): contract, feel-snapshot, screen-contract, test-results, slice-plan
 *
 * (that run also failed the workspace-scoped and empty-project cases below, 3 of 6). The
 * plan is exactly what it was before this change: one trace, and silence about the rest.
 * Restored, it passes.
 */
test("the REPRODUCTION: a trace-only project NAMES the families it has no asset of", async () => {
  const { root, workspace } = await traceOnlyProject();
  try {
    const { lines } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: { async runFlowTrace() { return cleanFlow(); } },
      }),
    );
    const out = lines.join("\n");

    // THE ONE THE HUMAN ASKED ABOUT. The safe-area / tap-target / required-object checks
    // live in the screen-contract family (`MINIGAME_GATE_EVALUATORS`), so the line that
    // explains their absence has to name them.
    assert.ok(
      /screen-contract: NO ASSET, nothing in this family was checked/.test(out) &&
        /safe area, tap-target size, required objects in frame/.test(out),
      `the screen-contract family must be named, with what it would have covered:\n${out}`,
    );
    // …and the NEXT ACTION, so "why is this missing" is answerable without reading docs.
    assert.match(out, /create one: loombridge minigame init --id <kebab>/);

    // Every OTHER known family is named too, derived from the closed inventory rather than
    // re-listed here: a seventh kind must land in this assertion without anyone editing it.
    for (const kind of ASSET_KINDS.filter((k) => k !== "trace")) {
      assert.match(out, new RegExp(`${kind}: NO ASSET, nothing in this family was checked`), kind);
    }
    // The one that DOES exist is a plan row, never a gap.
    assert.ok(!/ {3}trace: NO ASSET/.test(out), "a family with an asset is never reported as absent");

    // The summary roll-up names them again, in one compact line, so a reader who scrolled
    // past the plan still sees what this verdict is silent about.
    assert.ok(
      out.includes(
        "NOT CHECKED (no asset of this kind exists here, so this verdict says nothing about them; " +
          `see the plan above to create one): ${ASSET_KINDS.filter((k) => k !== "trace").join(", ")}`,
      ),
      `the summary must roll the gaps up in one line:\n${out}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/*
 * LITMUS, run 2026-08-11. The `searchedIn` clause dropped from the `planLines` gap line
 * (`const where = ""`), leaving the JSON half intact so only the printed half breaks:
 *
 *   ✖ a workspace-scoped family NAMES the directory it was looked for in (6.724ms)
 *     AssertionError [ERR_ASSERTION]: feel-snapshot
 *       at TestContext.<anonymous> (…/unified-absent-families.test.ts:225:14)
 *
 * (1 of 6 failed, so the surfacing itself was still working: only the WHERE was gone.)
 * Restored, it passes.
 */
test("a workspace-scoped family NAMES the directory it was looked for in", async () => {
  const { root, workspace } = await traceOnlyProject();
  try {
    const { lines } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: { async runFlowTrace() { return cleanFlow(); } },
      }),
    );
    const out = lines.join("\n");
    // The workspace id is derived from the project's FOLDER NAME, so a screen contract
    // created under a different `--id` is invisible here. Naming the directory that was
    // searched is what turns "there is no screen contract" into "there is no screen
    // contract HERE", which is the sentence an operator can act on.
    for (const kind of ["feel-snapshot", "screen-contract"]) {
      assert.match(
        out,
        new RegExp(`${kind}: NO ASSET, nothing in this family was checked, searched ${workspace}`),
        kind,
      );
    }
    // The in-project families never claim to have been looked for somewhere else. Anchored
    // on the line's leading indent, because `screen-contract` ends in `contract`.
    assert.ok(
      !/ {3}contract: NO ASSET[^\n]*searched/.test(out),
      "an in-project family carries no searched-in directory",
    );

    const report = await readUnified(root);
    const screens = report.absentFamilies.find((f) => f.kind === "screen-contract");
    assert.equal(screens?.searchedIn, workspace, "the machine-readable half carries it too");
    assert.equal(
      report.absentFamilies.find((f) => f.kind === "contract")?.searchedIn,
      undefined,
      "…and omits it where there is nothing to name",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/*
 * LITMUS, run 2026-08-11, in two halves at once, which is the only honest way to prove this
 * property: a SEVENTH kind (`genre-oracle`) added to `ASSET_KIND_CATALOG`, the source of
 * truth, AND `absentAssetFamilies` re-pointed at a hand-written list of the original six
 * (`catalog.filter((e) => handList.includes(e.kind))`), which is the shape this test forbids:
 *
 *   ✖ DERIVE, DO NOT HAND-LIST: every kind in the catalog is enumerated (1.624917ms)
 *     AssertionError [ERR_ASSERTION]: the absence report enumerates the closed inventory itself
 *     + actual - expected
 *       [
 *         'contract',
 *         'trace',
 *         'feel-snapshot',
 *         'screen-contract',
 *         'test-results',
 *     -   'genre-oracle',
 *         'slice-plan'
 *       ]
 *
 * Both restored, it passes.
 *
 * THE OTHER DIRECTION, run separately and honestly: the seventh kind added to the catalog
 * ALONE, with the walk left in place. This test passed, both halves, with NO edit to any
 * reporting code (the compiler does demand the new kind be given a section in
 * `SECTION_FOR_KIND`, which is the point of that Record being exhaustive; that is wiring,
 * not reporting). The absence report picked the new family up on its own, in catalog order,
 * carrying the entry's own prose.
 */
test("DERIVE, DO NOT HAND-LIST: every kind in the catalog is enumerated", () => {
  // Against the REAL catalog: a project with nothing at all has every known family absent,
  // in catalog order. If a seventh kind is added to `ASSET_KIND_CATALOG` and the enumeration
  // is a copy of the list rather than a walk of it, this fails on the next kind added.
  assert.deepEqual(
    absentAssetFamilies([]).map((f) => f.kind),
    [...ASSET_KINDS],
    "the absence report enumerates the closed inventory itself",
  );

  // …and the same property proved DIRECTLY, by handing in a catalog that already has a
  // seventh kind. Nothing in the reporting code is edited to make this pass: the entry's
  // own prose is what the report carries.
  const seventh = {
    kind: "genre-oracle" as DiscoveredAssetKind,
    covers: "a frozen genre oracle",
    nextAction: "loombridge oracle init",
  } satisfies AssetKindEntry;
  const withSeventh = absentAssetFamilies([], {}, [...ASSET_KIND_CATALOG, seventh]);
  assert.deepEqual(withSeventh.map((f) => f.kind), [...ASSET_KINDS, "genre-oracle"]);
  assert.deepEqual(
    withSeventh[withSeventh.length - 1],
    { kind: "genre-oracle", covers: "a frozen genre oracle", nextAction: "loombridge oracle init" },
    "the new kind's own prose reaches the report unedited",
  );

  // A family WITH an asset is never reported absent, whatever else is missing.
  assert.deepEqual(
    absentAssetFamilies([{ kind: "trace" }]).map((f) => f.kind),
    ASSET_KINDS.filter((k) => k !== "trace"),
  );
});

/*
 * THE MOAT. Gaps are informational: naming a family that was never here is the opposite of
 * covering it, and the report must not let a reader (or a refactor) conclude otherwise.
 *
 * The assertion is not "the numbers look right"; it RE-DERIVES the outcome from the two
 * inputs the rule is allowed to read (what executed, what was discovered-but-not-run) and
 * asserts the report agrees. If `absentFamilies` ever became an input to
 * `resolveUnifiedOutcome`, this recomputation would disagree with the recorded verdict.
 *
 * LITMUS, run 2026-08-11. `resolveUnifiedOutcome` given an extra
 * `notRun: report.absentFamilies.map(f => ({...f, why: "non-anchor"}))` inside the
 * orchestrator, i.e. gaps folded into the calculus:
 *
 *   ✖ THE MOAT: one passing asset + five absent families keeps today's status and exit
 *     AssertionError [ERR_ASSERTION]: a run whose only asset passed against a frozen
 *     anchor is still a pass
 *     + actual - expected
 *     + 'partial'
 *     - 'pass'
 *
 * Restored, it passes.
 */
test("THE MOAT: one passing asset + five absent families keeps today's status and exit", async () => {
  const { root, workspace } = await traceOnlyProject();
  try {
    const { result } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: { async runFlowTrace() { return cleanFlow(); } },
      }),
    );
    const report = await readUnified(root);

    // Non-vacuous: this really is the "one asset, every other family absent" case (five of
    // them today; derived, so a seventh kind widens the case instead of breaking the test).
    assert.equal(report.plan.length, 1);
    assert.equal(report.absentFamilies.length, ASSET_KINDS.length - 1);
    assert.ok(report.absentFamilies.length >= 5);

    assert.equal(report.status, "pass", "a run whose only asset passed against a frozen anchor is still a pass");
    assert.equal(report.exit, 0);
    assert.equal(result, 0, "…and the process exit is the report's");

    // The binding: the verdict is a function of executed + notRun ONLY.
    const executed = (Object.entries(report.sections) as [UnifiedSectionName, { exit: number; anchored: boolean }][])
      .map(([section, s]) => ({ section, exit: s.exit, anchored: s.anchored }));
    assert.deepEqual(
      resolveUnifiedOutcome({ executed, notRun: report.notRun, scoped: report.only !== null }),
      { status: report.status, exit: report.exit },
      "absent families are not an input to the outcome rule, in either direction",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/*
 * The other half of the moat: the zero-asset refusal is untouched. "Nothing was checked" is
 * the strongest thing this door says, and listing the six commands that would create an
 * asset must not soften it into an informational run.
 *
 * LITMUS, run 2026-08-11. The `if (assets.length === 0) { ...; return 2; }` block in
 * `runUnifiedVerify` changed to `return 0`:
 *
 *   ✖ THE MOAT: a project with NOTHING still refuses at exit 2, and writes no report
 *     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *     0 !== 2
 *
 * Restored, it passes.
 */
test("THE MOAT: a project with NOTHING still refuses at exit 2, and writes no report", async () => {
  const root = await tmpDir("absent-families-empty-");
  const workspace = await tmpDir("absent-families-empty-ws-");
  try {
    const { result, lines } = await captured(() =>
      runUnifiedVerify({ root, strict: false, live: false, workspace }),
    );
    const out = lines.join("\n");
    assert.equal(result, 2);
    assert.match(out, /REFUSED: no verification assets found under/);
    assert.match(out, /a run that checked nothing is not a pass \(exit 2\)\. No report was written\./);
    assert.equal(
      await fileExists(unifiedVerifyReportPath(loombridgePaths(root).reports)),
      false,
      "the on-ramp still writes nothing at all",
    );
    // The gaps are still named (they are the whole story here), in the plan, before the
    // refusal. They add information; they take none away.
    for (const kind of ASSET_KINDS) {
      assert.match(out, new RegExp(`${kind}: NO ASSET, nothing in this family was checked`), kind);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/*
 * LITMUS, run 2026-08-11. `absentFamilies: absent` deleted from the report object in
 * `runUnifiedVerify`, with the field made optional so it still typechecks (i.e. the exact
 * "stdout says it, the JSON does not" divergence this pins):
 *
 *   ✖ the JSON report carries the SAME gaps stdout printed (6.795959ms)
 *     AssertionError [ERR_ASSERTION]: the summary must print a NOT CHECKED line:
 *     [loombridge verify] plan for /var/folders/…/T/absent-families-197uIp (offline + live):
 *     [loombridge verify]   trace 'happy-path': will run (live); approved 2026-08-11T13:18:46.525Z …
 *     [loombridge verify]   contract: NO ASSET, nothing in this family was checked …
 *
 * i.e. the plan still printed the gaps while the report carried none, which is the exact
 * divergence a CI consumer would have been left with. Restored, it passes.
 */
test("the JSON report carries the SAME gaps stdout printed", async () => {
  const { root, workspace } = await traceOnlyProject();
  try {
    const { lines } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: { async runFlowTrace() { return cleanFlow(); } },
      }),
    );
    const report = await readUnified(root);

    // Same kinds, same order, as the summary line printed. Parsed back OUT of the printed
    // line rather than re-listed here, so the two cannot drift apart in this test either.
    const printed = lines
      .map((l) => /NOT CHECKED \(no asset of this kind exists here[^)]*\): (.+)$/.exec(l))
      .find((m): m is RegExpExecArray => m !== null);
    assert.ok(printed, `the summary must print a NOT CHECKED line:\n${lines.join("\n")}`);
    assert.deepEqual(
      report.absentFamilies.map((f) => f.kind),
      printed[1].split(", "),
      "the CI consumer sees exactly what the human saw",
    );
    // …and the JSON carries the actionable half too, not just the names.
    for (const family of report.absentFamilies) {
      assert.ok(family.covers.length > 0, `${family.kind} covers`);
      assert.ok(family.nextAction.startsWith("loombridge "), `${family.kind} nextAction`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
