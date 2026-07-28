/**
 * The unified `verify` outcome rules: the two decisions that produce the exit code
 * the whole product rests on. Both are pure, so they are pinned exhaustively here
 * rather than inferred from an end-to-end run.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  UNIFIED_SCREENS_REPORT,
  UNIFIED_VERIFY_REPORT,
  fingerprintReport,
  notRunFor,
  reportPathFor,
  reportSha256,
  reportWasWritten,
  resolveUnifiedOutcome,
  unifiedScreensReportPath,
  unifiedVerifyReportPath,
  worstExitTier,
  writeUnifiedVerifyReport,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import type { DiscoveredAsset } from "../../../../capabilities/verification/unified/discovery.js";

test("worstExitTier: 2 beats 1 beats 0, in any order", () => {
  assert.equal(worstExitTier([]), 0);
  assert.equal(worstExitTier([0]), 0);
  assert.equal(worstExitTier([0, 0, 0]), 0);
  assert.equal(worstExitTier([0, 1]), 1);
  assert.equal(worstExitTier([1, 0]), 1);
  assert.equal(worstExitTier([1, 1]), 1);
  assert.equal(worstExitTier([0, 2]), 2);
  assert.equal(worstExitTier([2, 0]), 2);
  assert.equal(worstExitTier([1, 2]), 2, "a harness fault dominates a game defect");
  assert.equal(worstExitTier([2, 1]), 2);
  assert.equal(worstExitTier([2, 2, 1, 0]), 2);
});

/**
 * An executed section that DID compare a frozen, human-approved anchor.
 *
 * Written as a helper rather than inlined because `anchored` is now load-bearing (G1): a
 * table of literals would let a future edit flip one to `false` and read as noise, when in
 * fact it changes the run's status word.
 */
function anchoredSection(section: "contract" | "screens" | "flow" | "feel" | "tests", exit: number) {
  return { section, exit, anchored: true } as const;
}
/** An executed section that compared NOTHING a human froze (a contract with no approved
 *  design target, a stamped test run, a screens section whose baseline was not used). */
function unanchoredSection(section: "contract" | "screens" | "flow" | "feel" | "tests", exit: number) {
  return { section, exit, anchored: false } as const;
}

const LIVE_SKIPPED = { kind: "trace", id: "kq", reason: "needs --live", why: "live-only-skipped" } as const;
const NON_ANCHOR = { kind: "trace", id: "kq2", reason: "recorded, not approved", why: "non-anchor" } as const;
const DRAFT = { kind: "screen-contract", id: "sc", reason: "contract draft", why: "draft" } as const;
const BROKEN = { kind: "feel-snapshot", id: "current", reason: "tampered", why: "broken" } as const;

test("resolveUnifiedOutcome: ZERO executed is nothing-checked and exit 2, whatever was discovered", () => {
  assert.deepEqual(resolveUnifiedOutcome({ executed: [], notRun: [] }), {
    status: "nothing-checked",
    exit: 2,
  });
  assert.deepEqual(resolveUnifiedOutcome({ executed: [], notRun: [LIVE_SKIPPED] }), {
    status: "nothing-checked",
    exit: 2,
  });
  assert.deepEqual(resolveUnifiedOutcome({ executed: [], notRun: [DRAFT] }), {
    status: "nothing-checked",
    exit: 2,
  });
});

test("resolveUnifiedOutcome: everything executed, passed, and ANCHORED with nothing skipped is pass/0", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("contract", 0), anchoredSection("screens", 0)], notRun: [] }),
    { status: "pass", exit: 0 },
  );
});

test("G1: an all-green run with an UNANCHORED executed section is PARTIAL, never pass", () => {
  // THE DELIBERATE FLIP. Before G1 this returned `pass`, and that word was the last place a
  // self-graded result could still print as a full pass: a contract graded with no approved
  // design target, or a stamped test run (which has no human-approve step and never will),
  // is a real deterministic green measured against nothing a human ever froze.
  //
  // FXH then changed the EXIT for the zero-anchored case (see the test below), so the two
  // single-section rows here are `partial` at exit 2. A MIXED run keeps exit 0: it really did
  // compare something a human approved, and the unanchored extra is named rather than fatal.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("contract", 0)], notRun: [] }),
    { status: "partial", exit: 2 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 0)], notRun: [] }),
    { status: "partial", exit: 2 },
    "the tests section is PERMANENTLY unanchored, so a green suite alone can never read as a pass",
  );
  // One anchored section does not cover for an unanchored one: the rule is EVERY section.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("screens", 0), unanchoredSection("tests", 0)],
      notRun: [],
    }),
    { status: "partial", exit: 0 },
  );
  // …and the anchored-only version of the same run really is a pass, so the flip above is
  // caused by `anchored` and nothing else.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("screens", 0), anchoredSection("tests", 0)],
      notRun: [],
    }),
    { status: "pass", exit: 0 },
  );
});

test("FXH: exit 0 requires AT LEAST ONE anchored executed section; zero anchored is exit 2", () => {
  // THE VACUITY FIX. G1 narrowed the status WORD and left the exit at 0, and the exit is the
  // only part of this an agent reads. A project whose single asset is self-produced (a stamped
  // test run, a contract with no approved design target) could therefore still exit 0 having
  // compared nothing any human ever froze. Every row below asserts the EXIT as well as the
  // word, so an `allAnchored = true` defusal fails on both.
  for (const executed of [
    [unanchoredSection("tests", 0)],
    [unanchoredSection("contract", 0)],
    [unanchoredSection("contract", 0), unanchoredSection("tests", 0)],
    [unanchoredSection("contract", 0), unanchoredSection("screens", 0), unanchoredSection("tests", 0)],
  ]) {
    assert.deepEqual(
      resolveUnifiedOutcome({ executed, notRun: [] }),
      { status: "partial", exit: 2 },
      `zero anchored sections must never exit 0: ${executed.map((e) => e.section).join("+")}`,
    );
  }

  // Even the operator's own `--live` omission cannot lift a zero-anchored run to 0: that
  // allowance exists for a run that measured something approved and skipped the rest.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 0)], notRun: [LIVE_SKIPPED] }),
    { status: "partial", exit: 2 },
  );

  // THE MOAT CEILING for a tests-only forgery. Even a perfectly forged stamped pair that
  // grades tier 0 buys `partial` at exit 2, never a green run.
  assert.equal(resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 0)], notRun: [] }).exit, 2);

  // NON-VACUITY, in both directions: ONE anchored green section restores exit 0 (with the
  // unanchored extras named), and an all-anchored run is still a pass.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("flow", 0), unanchoredSection("tests", 0)],
      notRun: [],
    }),
    { status: "partial", exit: 0 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("flow", 0), unanchoredSection("tests", 0)],
      notRun: [LIVE_SKIPPED],
    }),
    { status: "partial", exit: 0 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("flow", 0)], notRun: [] }),
    { status: "pass", exit: 0 },
  );

  // A red is still a red: FXH only ever narrows the GREEN exit, it never re-tiers a defect.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 1)], notRun: [] }),
    { status: "fail", exit: 1 },
  );
});

test("resolveUnifiedOutcome: a live-only skip is PARTIAL at exit 0, the one non-execution an operator chose", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("contract", 0)], notRun: [LIVE_SKIPPED] }),
    { status: "partial", exit: 0 },
  );
});

test("resolveUnifiedOutcome: any OTHER non-execution is partial at the harness tier: an unmeasured anchor is not a pass", () => {
  for (const notRun of [NON_ANCHOR, DRAFT, BROKEN]) {
    assert.deepEqual(
      resolveUnifiedOutcome({ executed: [anchoredSection("contract", 0)], notRun: [notRun] }),
      { status: "partial", exit: 2 },
      `${notRun.why} must not round up to a green exit`,
    );
  }
  // Mixed: one deliberate skip cannot launder an unmeasured anchor into exit 0.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("contract", 0)], notRun: [LIVE_SKIPPED, NON_ANCHOR] }),
    { status: "partial", exit: 2 },
  );
});

test("resolveUnifiedOutcome: an executed game defect is fail; an executed harness fault is harness-fault", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("contract", 1)], notRun: [] }),
    { status: "fail", exit: 1 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [anchoredSection("flow", 2)], notRun: [] }),
    { status: "harness-fault", exit: 2 },
  );
  // 2 dominates 1 in both the word and the tier: once part of the run could not be
  // trusted, the run is not a clean game verdict in either direction.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("contract", 1), anchoredSection("flow", 2)],
      notRun: [],
    }),
    { status: "harness-fault", exit: 2 },
  );
  // An UNANCHORED red is still a red, not a partial: G1 only ever narrows the green word.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 1)], notRun: [] }),
    { status: "fail", exit: 1 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [unanchoredSection("tests", 2)], notRun: [] }),
    { status: "harness-fault", exit: 2 },
  );
});

test("resolveUnifiedOutcome: a FOUND GAME DEFECT stays at exit 1, however much went unmeasured", () => {
  // The pin that changed on purpose. An earlier cut raised a `fail` to exit 2 whenever an
  // anchor could not be measured, which quietly broke the one promise the exit codes make:
  // 2 is never a game verdict. A `fail` at 2 is a game defect wearing the harness tier's
  // clothes, and that is exactly the shape an agent misreads as "flaky harness, re-run it".
  for (const notRun of [[NON_ANCHOR], [DRAFT], [BROKEN], [LIVE_SKIPPED], [LIVE_SKIPPED, BROKEN]]) {
    assert.deepEqual(
      resolveUnifiedOutcome({ executed: [anchoredSection("contract", 1)], notRun }),
      { status: "fail", exit: 1 },
      `a defect must not be re-tiered by ${notRun.map((n) => n.why).join("+")}`,
    );
  }
  // The unmeasured anchors do not vanish: they are still every row of `notRun`, which the
  // summary line names. Coverage honesty lives there, not in the exit code of a real defect.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [anchoredSection("contract", 1), anchoredSection("screens", 2)],
      notRun: [],
    }),
    { status: "harness-fault", exit: 2 },
    "an executed harness fault still dominates: that part of the run could not be trusted",
  );
});

test("notRunFor reads the machine class off the row, never re-parses its prose", () => {
  const row: DiscoveredAsset = {
    kind: "trace",
    id: "kq",
    runnable: "no",
    reason: "contract draft: this sentence is deliberately misleading",
    notRunClass: "broken",
    paths: { asset: "/x" },
  };
  assert.equal(notRunFor(row).why, "broken", "the class wins over any wording in `reason`");

  // A row with no class at all falls back to the conservative non-anchor (tier 2).
  const classless: DiscoveredAsset = { kind: "trace", id: "k", runnable: "no", paths: { asset: "/x" } };
  assert.equal(notRunFor(classless).why, "non-anchor");
  assert.equal(notRunFor(classless).reason, "not runnable");
});

test("reportSha256 binds a section to the exact bytes it summarized; an unreadable path is null, never omitted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-report-"));
  try {
    const file = path.join(dir, "build-verdict.json");
    await fs.writeFile(file, '{"status":"pass"}\n', "utf-8");
    const first = await reportSha256(file);
    assert.match(String(first), /^[0-9a-f]{64}$/);

    await fs.writeFile(file, '{"status":"fail"}\n', "utf-8");
    assert.notEqual(await reportSha256(file), first, "editing the per-asset report changes the binding");

    assert.equal(await reportSha256(path.join(dir, "nope.json")), null);
    assert.equal(await reportSha256(undefined), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reportWasWritten: only a report THIS run produced may be stamped (M5)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-report-"));
  try {
    const file = path.join(dir, "report.json");

    // Absent before AND after: nothing was produced, so nothing may be stamped.
    const absent = await fingerprintReport(file);
    assert.equal(reportWasWritten(absent, await fingerprintReport(file)), false);

    // Written for the first time.
    await fs.writeFile(file, '{"status":"pass"}\n', "utf-8");
    assert.equal(reportWasWritten(absent, await fingerprintReport(file)), true);

    // THE ATTACK: a prior good report on disk, and an engine that refuses before writing.
    // The fingerprint is unchanged, so the previous run's sha must not be stamped as this
    // run's evidence.
    const prior = await fingerprintReport(file);
    assert.equal(reportWasWritten(prior, await fingerprintReport(file)), false);

    // A rewrite with different content is detected.
    await fs.writeFile(file, '{"status":"fail"}\n', "utf-8");
    assert.equal(reportWasWritten(prior, await fingerprintReport(file)), true);

    // And a file that vanished cannot be stamped either.
    await fs.rm(file);
    assert.equal(reportWasWritten(prior, await fingerprintReport(file)), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reportPathFor: an ESCAPING relative path is stored absolute, never as `../..`", () => {
  const root = path.resolve("/proj/game");
  assert.equal(reportPathFor(root, path.join(root, ".loombridge", "reports", "x.json")),
    path.join(".loombridge", "reports", "x.json"));

  // The workspace assets live OUTSIDE the project by design. A `../../..` string means
  // nothing without knowing the cwd it will be resolved against, so it is stored absolute.
  const outside = path.resolve("/home/u/.loombridge/projects/game/feel/drift.json");
  assert.equal(reportPathFor(root, outside), outside);
  assert.equal(reportPathFor(root, undefined), undefined);
});

test("the report path helpers are the ONLY spelling of the two declared filenames", async () => {
  assert.equal(unifiedVerifyReportPath("/r"), path.join("/r", UNIFIED_VERIFY_REPORT));
  assert.equal(unifiedScreensReportPath("/r"), path.join("/r", UNIFIED_SCREENS_REPORT));
  assert.notEqual(UNIFIED_VERIFY_REPORT, UNIFIED_SCREENS_REPORT);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-report-"));
  try {
    const report: UnifiedVerifyReport = {
      kind: "unified-verify",
      schemaVersion: "1",
      producedAt: "2026-07-28T00:00:00.000Z",
      root: "/r",
      runId: null,
      live: false,
      plan: [],
      notRun: [],
      sections: {},
      anchoredSections: [],
      unanchoredSections: [],
      status: "nothing-checked",
      exit: 2,
      notes: [],
    };
    const out = unifiedVerifyReportPath(path.join(dir, "reports"));
    await writeUnifiedVerifyReport(out, report);
    assert.deepEqual(JSON.parse(await fs.readFile(out, "utf-8")), report, "written and read back through one constant");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
