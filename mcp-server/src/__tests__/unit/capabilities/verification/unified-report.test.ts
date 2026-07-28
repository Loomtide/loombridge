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
  notRunFor,
  reportSha256,
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

test("resolveUnifiedOutcome: everything executed and passed with nothing skipped is pass/0", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }, { section: "screens", exit: 0 }], notRun: [] }),
    { status: "pass", exit: 0 },
  );
});

test("resolveUnifiedOutcome: a live-only skip is PARTIAL at exit 0, the one non-execution an operator chose", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [LIVE_SKIPPED] }),
    { status: "partial", exit: 0 },
  );
});

test("resolveUnifiedOutcome: any OTHER non-execution is partial at the harness tier: an unmeasured anchor is not a pass", () => {
  for (const notRun of [NON_ANCHOR, DRAFT, BROKEN]) {
    assert.deepEqual(
      resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [notRun] }),
      { status: "partial", exit: 2 },
      `${notRun.why} must not round up to a green exit`,
    );
  }
  // Mixed: one deliberate skip cannot launder an unmeasured anchor into exit 0.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [LIVE_SKIPPED, NON_ANCHOR] }),
    { status: "partial", exit: 2 },
  );
});

test("resolveUnifiedOutcome: an executed game defect is fail; an executed harness fault is harness-fault", () => {
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 1 }], notRun: [] }),
    { status: "fail", exit: 1 },
  );
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "flow", exit: 2 }], notRun: [] }),
    { status: "harness-fault", exit: 2 },
  );
  // 2 dominates 1 in both the word and the tier: once part of the run could not be
  // trusted, the run is not a clean game verdict in either direction.
  assert.deepEqual(
    resolveUnifiedOutcome({
      executed: [{ section: "contract", exit: 1 }, { section: "flow", exit: 2 }],
      notRun: [],
    }),
    { status: "harness-fault", exit: 2 },
  );
  // A game defect keeps its tier even when nothing else ran; a skipped anchor raises
  // the exit but never demotes the fail into a pass.
  assert.deepEqual(
    resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 1 }], notRun: [NON_ANCHOR] }),
    { status: "fail", exit: 2 },
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
