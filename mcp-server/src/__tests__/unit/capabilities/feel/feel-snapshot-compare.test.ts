import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSnapshot,
  exitCodeForSnapshotDrift,
  resolveTolerance,
  type SnapshotCompareStatus,
  type SnapshotContractBinding,
} from "../../../../capabilities/feel/snapshot-compare.js";
import {
  DEFAULT_SNAPSHOT_TOLERANCES,
  type FeelSnapshotManifest,
} from "../../../../capabilities/feel/snapshot-manifest.js";

function manifest(metrics: FeelSnapshotManifest["metrics"], over: Partial<FeelSnapshotManifest> = {}): FeelSnapshotManifest {
  return {
    schemaVersion: "1",
    kind: "feel-snapshot",
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    captureRuns: 1,
    captureContract: { sha256: "c".repeat(64), file: "capture-contract.json", interactions: 2, metrics: 3 },
    measurements: { sha256: "m".repeat(64), file: "measurements.json" },
    metrics,
    rederivation: { pass: Object.keys(metrics).length, total: Object.keys(metrics).length },
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    ...over,
  };
}

// ── tolerance math ───────────────────────────────────────────────────────────

test("resolveTolerance: applied is max(derivation floor, relPct * |baseline|)", () => {
  // trajectory floor 0.05; 5% of 9 = 0.45 wins.
  const run = resolveTolerance(DEFAULT_SNAPSHOT_TOLERANCES, "runSpeed", "trajectory", 9);
  assert.equal(run.applied, 0.45);
  // sync floor 100 wins over 5% of 40 = 2.
  const sync = resolveTolerance(DEFAULT_SNAPSHOT_TOLERANCES, "inputToSfxLatency", "sync", 40);
  assert.equal(sync.applied, 100);
  // unknown derivation: relPct only, no invented floor.
  const unknown = resolveTolerance(DEFAULT_SNAPSHOT_TOLERANCES, "weird", "somenewkind", 10);
  assert.equal(unknown.abs, 0);
  assert.equal(unknown.applied, 0.5);
});

test("resolveTolerance: frozen per-metric overrides win over defaults", () => {
  const policy = {
    ...DEFAULT_SNAPSHOT_TOLERANCES,
    perMetric: { jumpApex: { relPct: 0.01, abs: 0.001 } },
  };
  const t = resolveTolerance(policy, "jumpApex", "trajectory", 3);
  assert.equal(t.relPct, 0.01);
  assert.equal(t.abs, 0.001);
  assert.equal(t.applied, 0.03);
});

// ── compare ──────────────────────────────────────────────────────────────────

test("compareSnapshot: within-tolerance jitter matches; beyond-tolerance drifts", () => {
  const m = manifest({
    runSpeed: { value: 9, derivation: "trajectory", confidence: "verified" },
    inputToSfxLatency: { value: 40, derivation: "sync", confidence: "verified" },
  });
  const result = compareSnapshot(
    m,
    { metrics: { runSpeed: 9.3, inputToSfxLatency: 100 } }, // +0.3 within 0.45; +60 within the 100ms sync floor
    new Map(),
    new Set(["runSpeed"]),
  );
  assert.equal(result.status, "clean");
  assert.deepEqual(result.summary, { total: 2, match: 2, drift: 0, rejected: 0, missing: 0 });
  const run = result.metrics.find((x) => x.id === "runSpeed");
  assert.equal(run?.confidence, "verified");

  const drifted = compareSnapshot(m, { metrics: { runSpeed: 10.2, inputToSfxLatency: 40 } }, new Map(), new Set());
  assert.equal(drifted.status, "drift");
  const runDrift = drifted.metrics.find((x) => x.id === "runSpeed");
  assert.equal(runDrift?.status, "drift");
  assert.match(runDrift!.detail, /DRIFT/);
});

test("compareSnapshot: a rejected current value drives drift and never compares clean", () => {
  const m = manifest({ jumpApex: { value: 3, derivation: "trajectory", confidence: "verified" } });
  // The current value is NUMERICALLY IDENTICAL to the baseline: without the §0
  // check it would read as a perfect match. Rejection must win.
  const result = compareSnapshot(
    m,
    { metrics: { jumpApex: 3 } },
    new Map([["jumpApex", "reported value != raw samples"]]),
    new Set(),
  );
  assert.equal(result.status, "drift");
  assert.equal(result.metrics[0].status, "rejected");
  assert.match(result.metrics[0].detail, /rejected by re-derivation/);
});

test("compareSnapshot: a baseline metric unmeasured now is missing -> incomplete, not a pass and not a regression", () => {
  const m = manifest({
    runSpeed: { value: 9, derivation: "trajectory", confidence: "verified" },
    jumpApex: { value: 3, derivation: "trajectory", confidence: "verified" },
  });
  const result = compareSnapshot(m, { metrics: { runSpeed: 9 } }, new Map(), new Set());
  assert.equal(result.status, "incomplete");
  const missing = result.metrics.find((x) => x.id === "jumpApex");
  assert.equal(missing?.status, "missing");
  assert.match(missing!.detail, /capture gap, not a regression/);
});

test("compareSnapshot: a current metric absent from the baseline is informational, never gating", () => {
  const m = manifest({ runSpeed: { value: 9, derivation: "trajectory", confidence: "verified" } });
  const result = compareSnapshot(m, { metrics: { runSpeed: 9, coyoteTime: 0.1 } }, new Map(), new Set());
  assert.equal(result.status, "clean");
  assert.deepEqual(result.newMetrics.map((n) => n.id), ["coyoteTime"]);
});

test("compareSnapshot: drift beats missing in the roll-up (a drifted metric cannot hide behind a gap)", () => {
  const m = manifest({
    runSpeed: { value: 9, derivation: "trajectory", confidence: "verified" },
    jumpApex: { value: 3, derivation: "trajectory", confidence: "verified" },
  });
  const result = compareSnapshot(m, { metrics: { runSpeed: 20 } }, new Map(), new Set());
  assert.equal(result.status, "drift");
});

// ── exit-code table (exhaustive over the D5 rows) ───────────────────────────

test("exitCodeForSnapshotDrift: the full refusal table", () => {
  const cases: Array<{
    status: SnapshotCompareStatus;
    binding: SnapshotContractBinding;
    integrityOk: boolean;
    strict: boolean;
    expect: number;
  }> = [
    { status: "clean", binding: "verified", integrityOk: true, strict: false, expect: 0 },
    { status: "clean", binding: "verified", integrityOk: true, strict: true, expect: 0 },
    { status: "drift", binding: "verified", integrityOk: true, strict: false, expect: 1 },
    { status: "incomplete", binding: "verified", integrityOk: true, strict: false, expect: 2 },
    // Integrity outranks everything, even a clean compare.
    { status: "clean", binding: "verified", integrityOk: false, strict: false, expect: 2 },
    { status: "drift", binding: "verified", integrityOk: false, strict: false, expect: 2 },
    // A contract-binding mismatch is apples-to-oranges: 2, never a drift verdict.
    { status: "clean", binding: "mismatch", integrityOk: true, strict: false, expect: 2 },
    { status: "drift", binding: "mismatch", integrityOk: true, strict: false, expect: 2 },
    // Offline measurements can't verify binding: clean is 0, but 1 under strict.
    { status: "clean", binding: "unverified", integrityOk: true, strict: false, expect: 0 },
    { status: "clean", binding: "unverified", integrityOk: true, strict: true, expect: 1 },
    { status: "drift", binding: "unverified", integrityOk: true, strict: false, expect: 1 },
    { status: "incomplete", binding: "unverified", integrityOk: true, strict: false, expect: 2 },
  ];
  for (const c of cases) {
    assert.equal(
      exitCodeForSnapshotDrift(
        { status: c.status, contractBinding: c.binding, integrity: { ok: c.integrityOk } },
        { strict: c.strict },
      ),
      c.expect,
      JSON.stringify(c),
    );
  }
});
