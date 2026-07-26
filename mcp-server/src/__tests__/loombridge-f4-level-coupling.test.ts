import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  feelEnvelope,
  evaluateReachability,
  evaluateReachabilityEnvelope,
  type ReachabilityLayout,
  type FeelEnvelopeBudget,
} from "../capabilities/verification/gates/index.js";
import {
  envelopeFromProfile,
  evaluateProfileReachability,
  PROFILE_REACHABILITY_VERTICAL_MARGIN_U,
} from "../capabilities/genre/genre-packs/platformer-2d/reachability-profile.js";
import {
  buildProfileReport,
  computeProfileReachability,
  headlineFor,
} from "../capabilities/genre/genre-packs/platformer-2d/verify-profile.js";
import { loadProfile } from "../capabilities/genre/genre-packs/platformer-2d/profiles.js";
import { run as runVerifyCli } from "../capabilities/verification/verify.js";
import type {
  PlatformerFeelProfile,
  ProfileMetricTarget,
} from "../capabilities/genre/genre-packs/platformer-2d/types.js";

// ---------------------------------------------------------------------------
// Synthetic profile builder — lets a test pin EXACTLY the solve bands the F4
// envelope reads (jumpApex/timeToApex/runSpeed/dashDistance) without re-tuning a
// shipped profile. Bands are nominal (the F4 envelope uses .target only).
// ---------------------------------------------------------------------------

function band(target: number, unit: ProfileMetricTarget["unit"]): ProfileMetricTarget {
  return { target, unit, band: { percent: 15 } };
}

function makeProfile(opts: {
  id?: string;
  jumpApex?: number;
  timeToApex?: number;
  runSpeed?: number;
  dashDistance?: number;
  omitJumpApex?: boolean;
}): PlatformerFeelProfile {
  const metrics: Record<string, ProfileMetricTarget> = {};
  if (!opts.omitJumpApex) metrics.jumpApex = band(opts.jumpApex ?? 3, "u");
  metrics.timeToApex = band(opts.timeToApex ?? 300, "ms");
  metrics.runSpeed = band(opts.runSpeed ?? 8, "u/s");
  if (opts.dashDistance !== undefined) metrics.dashDistance = band(opts.dashDistance, "u");
  return {
    schemaVersion: "1",
    id: opts.id ?? "synthetic",
    title: "Synthetic",
    summary: "test profile",
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — feelEnvelope extraction parity (build mode UNCHANGED)
// ---------------------------------------------------------------------------

test("F4 feelEnvelope: derives airtime (2×timeToApex) and hReach (dash + run·airtime)", () => {
  const budget: FeelEnvelopeBudget = {
    jumpApex: 3,
    dashDist: 4,
    runSpeed: 9,
    timeToApexMs: 280,
    vMargin: 0.5,
  };
  const env = feelEnvelope(budget);
  assert.equal(env.jumpApex, 3);
  assert.equal(env.vMargin, 0.5);
  assert.ok(Math.abs(env.airtimeS - 0.56) < 1e-9, `airtime ${env.airtimeS}`);
  // hReach = dash 4 + runSpeed 9 * airtime 0.56 = 9.04
  assert.ok(Math.abs(env.hReach - 9.04) < 1e-9, `hReach ${env.hReach}`);
});

test("F4 feelEnvelope: an explicit hReachOverride wins over the derived reach", () => {
  const env = feelEnvelope({
    jumpApex: 2.2,
    dashDist: 4,
    runSpeed: 9,
    timeToApexMs: 280,
    vMargin: 0.5,
    hReachOverride: 1.25,
  });
  assert.equal(env.hReach, 1.25);
});

test("F4 build-mode reachability UNCHANGED: evaluateReachability == evaluateReachabilityEnvelope(feelEnvelope(acceptance budget))", () => {
  // Reconstruct the documented build-mode budget (the fallbacks the gate applies),
  // then prove the public build-mode entry produces the SAME verdict as routing the
  // identical budget through the extracted feelEnvelope + envelope evaluator. This is
  // the regression guard: the refactor must not change build-mode behavior.
  const acceptance = {
    feel: {
      jumpApex: { target: 2.2 },
      runSpeed: { target: 6 },
      timeToApex: { target: 325 },
    },
  } as unknown as Parameters<typeof evaluateReachability>[1];

  const layout: ReachabilityLayout = {
    platforms: [
      { name: "Ground", topY: 0, minX: -2, maxX: 10 },
      { name: "Ledge", topY: 4, minX: 4, maxX: 8 },
    ],
    collectibles: [
      { name: "Low", x: 3, y: 2 },
      { name: "High", x: 6, y: 9 },
    ],
  };

  const viaPublic = evaluateReachability(layout, acceptance);
  const budget: FeelEnvelopeBudget = {
    jumpApex: 2.2,
    dashDist: 0,
    runSpeed: 6,
    timeToApexMs: 325,
    vMargin: 0.5,
  };
  const viaEnvelope = evaluateReachabilityEnvelope(layout, feelEnvelope(budget));

  assert.deepEqual(viaPublic, viaEnvelope);
  // and the verdict is meaningful (one reachable, one not)
  assert.equal(viaPublic.verdict, "fail");
});

// ---------------------------------------------------------------------------
// Phase 2 — envelopeFromProfile (+ refuse a missing solve band)
// ---------------------------------------------------------------------------

test("F4 envelopeFromProfile: derives the SAME envelope feelEnvelope would from the profile's bands", () => {
  const profile = makeProfile({ jumpApex: 3, timeToApex: 280, runSpeed: 9, dashDistance: 4 });
  const env = envelopeFromProfile(profile);
  const expected = feelEnvelope({
    jumpApex: 3,
    dashDist: 4,
    runSpeed: 9,
    timeToApexMs: 280,
    vMargin: PROFILE_REACHABILITY_VERTICAL_MARGIN_U,
  });
  assert.deepEqual(env, expected);
});

test("F4 envelopeFromProfile: a profile with NO dash band contributes 0 dash (hReach = run·airtime)", () => {
  const profile = makeProfile({ jumpApex: 3.8, timeToApex: 420, runSpeed: 7 });
  const env = envelopeFromProfile(profile);
  assert.equal(env.dashDist, 0);
  // airtime = 0.84, hReach = 0 + 7*0.84 = 5.88
  assert.ok(Math.abs(env.hReach - 5.88) < 1e-9, `hReach ${env.hReach}`);
});

test("F4 envelopeFromProfile: REFUSES a profile missing a solve band (jumpApex)", () => {
  const profile = makeProfile({ omitJumpApex: true, timeToApex: 300, runSpeed: 8 });
  assert.throws(() => envelopeFromProfile(profile), /required solve band 'jumpApex'/);
});

test("F4 envelopeFromProfile: REFUSES a non-positive solve band (runSpeed 0)", () => {
  const profile = makeProfile({ jumpApex: 3, timeToApex: 300, runSpeed: 0 });
  assert.throws(() => envelopeFromProfile(profile), /required solve band 'runSpeed'/);
});

// ---------------------------------------------------------------------------
// Phase 3 — evaluateProfileReachability + computeProfileReachability
// ---------------------------------------------------------------------------

const SWAP_LAYOUT: ReachabilityLayout = {
  platforms: [{ name: "Ground", topY: 0, minX: -2, maxX: 10 }],
  // Borderline collectible directly above the ground. A high-apex profile reaches it;
  // a tighter-apex profile cannot. (Horizontal is comfortably in range for both.)
  collectibles: [{ name: "Star", x: 4, y: 4.2 }],
};

test("F4 profile reachability: a within-envelope collectible PASSes the gate", () => {
  // jumpApex 4.0 + vMargin 0.5 = max reach 4.5 ≥ 4.2 → reachable.
  const profile = makeProfile({ jumpApex: 4.0, timeToApex: 300, runSpeed: 8 });
  const report = evaluateProfileReachability(profile, SWAP_LAYOUT);
  assert.equal(report.verdict, "pass");
});

test("F4 profile reachability: an out-of-envelope collectible FAILs the gate", () => {
  // jumpApex 3.0 + vMargin 0.5 = max reach 3.5 < 4.2 → unreachable.
  const profile = makeProfile({ jumpApex: 3.0, timeToApex: 300, runSpeed: 8 });
  const report = evaluateProfileReachability(profile, SWAP_LAYOUT);
  assert.equal(report.verdict, "fail");
});

test("F4 computeProfileReachability: no layout → not_run stamped EXPLICITLY (seam)", () => {
  const profile = makeProfile({ jumpApex: 3, timeToApex: 300, runSpeed: 8 });
  const r = computeProfileReachability(profile, undefined);
  assert.equal(r.status, "not_run");
  assert.match(r.reason ?? "", /no level layout/i);
  assert.equal(r.checks.length, 0);
  assert.equal(r.envelope, undefined);
});

test("F4 computeProfileReachability: layout reachable → pass with the solved envelope recorded", () => {
  const profile = makeProfile({ jumpApex: 4.0, timeToApex: 300, runSpeed: 8 });
  const r = computeProfileReachability(profile, SWAP_LAYOUT);
  assert.equal(r.status, "pass");
  assert.ok(r.envelope, "envelope recorded");
  assert.equal(r.envelope?.jumpApex, 4.0);
  assert.ok(r.checks.length >= 1);
});

test("F4 computeProfileReachability: layout unreachable → fail", () => {
  const profile = makeProfile({ jumpApex: 3.0, timeToApex: 300, runSpeed: 8 });
  const r = computeProfileReachability(profile, SWAP_LAYOUT);
  assert.equal(r.status, "fail");
  assert.ok(r.checks.some((c) => c.status === "fail"));
});

test("F4 computeProfileReachability: a layout with NO collectibles → not_run, not a green that validated nothing (review #2)", () => {
  const profile = makeProfile({ jumpApex: 3, timeToApex: 300, runSpeed: 8 });
  const layouts: ReachabilityLayout[] = [
    { platforms: [{ name: "G", topY: 0, minX: -3, maxX: 12 }], collectibles: [] }, // platforms, no collectibles
    { platforms: [], collectibles: [] }, // nothing to validate
  ];
  for (const layout of layouts) {
    const r = computeProfileReachability(profile, layout);
    assert.equal(r.status, "not_run", `empty-collectible layout must be not_run, got ${r.status}`);
    assert.match(r.reason ?? "", /no collectibles/i);
    assert.equal(r.envelope, undefined);
  }
});

test("F4 computeProfileReachability: layout supplied but profile missing a band → not_run with reason (refuse-don't-skip, never a false pass)", () => {
  const profile = makeProfile({ omitJumpApex: true, timeToApex: 300, runSpeed: 8 });
  const r = computeProfileReachability(profile, SWAP_LAYOUT);
  assert.equal(r.status, "not_run");
  assert.match(r.reason ?? "", /required solve band 'jumpApex'/);
});

// ---------------------------------------------------------------------------
// Phase 5 — the F4 POINT: swapping to a tighter-apex profile flips a borderline
// collectible reachable → UNREACHABLE (FAIL). The envelope tightens on swap.
// ---------------------------------------------------------------------------

test("F4 SWAP TIGHTENS THE ENVELOPE: a borderline collectible reachable under a HIGH-apex profile flips to UNREACHABLE under a TIGHTER-apex profile", () => {
  const highApex = makeProfile({ id: "loose", jumpApex: 4.0, timeToApex: 300, runSpeed: 8 });
  const tighter = makeProfile({ id: "tight", jumpApex: 3.0, timeToApex: 300, runSpeed: 8 });

  // The borderline collectible sits at y=4.2 above the ground (topY 0).
  //  loose:  4.0 + 0.5 = 4.5  ≥ 4.2 → reachable
  //  tight:  3.0 + 0.5 = 3.5  < 4.2 → UNREACHABLE
  const looseReport = evaluateProfileReachability(highApex, SWAP_LAYOUT);
  const tightReport = evaluateProfileReachability(tighter, SWAP_LAYOUT);

  assert.equal(looseReport.verdict, "pass", "high-apex profile reaches the collectible");
  assert.equal(tightReport.verdict, "fail", "tighter-apex profile cannot — the swap stranded it");

  // And the envelope demonstrably shrank on the swap (the auditable F4 invariant).
  const looseEnv = envelopeFromProfile(highApex);
  const tightEnv = envelopeFromProfile(tighter);
  assert.ok(
    tightEnv.jumpApex < looseEnv.jumpApex,
    `tighter apex ${tightEnv.jumpApex} < loose ${looseEnv.jumpApex}`,
  );
});

test("F4 SWAP gates the VERDICT: a profile-green build flips to status=fail when the swapped envelope strands a collectible", async () => {
  // Drive the FULL report path. The tighter profile is otherwise unmeasured (so
  // metric grading alone would be 'incomplete'), but an unreachable collectible must
  // FORCE the overall status to 'fail' — mirroring the F3 mechanisms fold.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f4-swap-"));
  try {
    const tighter = makeProfile({ id: "tight", jumpApex: 3.0, timeToApex: 300, runSpeed: 8 });
    // buildProfileReport loads a SHIPPED profile by id; to test a synthetic profile
    // we exercise computeProfileReachability + the documented fold directly here, and
    // separately assert the report shape on a shipped profile below.
    const reach = computeProfileReachability(tighter, SWAP_LAYOUT);
    assert.equal(reach.status, "fail");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shipped-profile proof: classic (apex 3.8) reaches a high collectible that
// precision (apex 3.0) cannot — a REAL swap on shipped identities, no re-tuning.
// ---------------------------------------------------------------------------

test("F4 shipped swap: classic (apex 3.8) reaches a y=4.0 collectible that precision (apex 3.0) strands", async () => {
  const classic = await loadProfile("classic");
  const precision = await loadProfile("precision");
  const layout: ReachabilityLayout = {
    platforms: [{ name: "Ground", topY: 0, minX: -3, maxX: 12 }],
    // classic: 3.8 + 0.5 = 4.3 ≥ 4.0 → reachable. precision: 3.0 + 0.5 = 3.5 < 4.0 → not.
    collectibles: [{ name: "Coin", x: 5, y: 4.0 }],
  };
  assert.equal(evaluateProfileReachability(classic, layout).verdict, "pass");
  assert.equal(evaluateProfileReachability(precision, layout).verdict, "fail");
});

// ---------------------------------------------------------------------------
// buildProfileReport — the report always carries a reachability block, the fold
// forces fail, and a no-layout run stamps not_run without failing a bare feel-check.
// ---------------------------------------------------------------------------

test("F4 buildProfileReport: no layout → report stamps reachability.not_run and does NOT fail a bare feel-check on that account", async () => {
  const report = await buildProfileReport({
    root: path.join(os.tmpdir(), "nonexistent-f4-root"),
    profile: "precision",
    strict: false,
  });
  assert.equal(report.reachability.status, "not_run");
  assert.ok(report.reachability.reason);
  // not_run never CONTRIBUTES a fail; status here is driven by metrics/engine/mechanisms
  // (no measurements → not 'pass'), but it is NOT 'fail' from reachability.
  assert.notEqual(report.status, "fail");
});

test("F4 review #1: an otherwise-green headline SURFACES that reachability was not run (no silent leveled-game pass)", () => {
  // The greenwash risk: a leveled-game swap reads as a clean pass by omitting --layout.
  // It can still be 'pass', but the headline must say reachability wasn't run.
  const ctx = {
    status: "pass" as const,
    summary: { total: 3, pass: 3, fail: 0, notMeasured: 0 },
    confidence: { verified: 3, reported: 0, rejected: 0, unmeasured: 0 },
    profile: { id: "precision", title: "Precision Platformer", summary: "" },
  };
  const withSkip = headlineFor(ctx, true, true, false, true);
  const withRun = headlineFor(ctx, true, true, false, false);
  assert.match(withSkip, /reachability NOT run/i);
  assert.match(withSkip, /--layout/);
  assert.doesNotMatch(withRun, /reachability NOT run/i);
});

test("F4 review #5: build-mode reachability UNCHANGED through the acceptance.reachability OVERRIDE path", () => {
  // The committed regression test only crossed the default budget; this exercises the
  // hReachOverride (horizontalMarginU) + verticalMarginU + non-zero dash fallbacks.
  const layout: ReachabilityLayout = {
    platforms: [{ name: "G", topY: 0, minX: -3, maxX: 12 }],
    collectibles: [{ name: "C", x: 2, y: 1.0 }],
  };
  const acceptance = {
    feel: { jumpApex: { target: 3 }, timeToApex: { target: 280 }, runSpeed: { target: 9 }, dashDistance: { target: 5 } },
    reachability: { horizontalMarginU: 1.0, verticalMarginU: 0.2 },
  } as unknown as Parameters<typeof evaluateReachability>[1];
  const viaPublic = evaluateReachability(layout, acceptance);
  const viaEnvelope = evaluateReachabilityEnvelope(
    layout,
    feelEnvelope({ jumpApex: 3, dashDist: 5, runSpeed: 9, timeToApexMs: 280, vMargin: 0.2, hReachOverride: 1.0 }),
  );
  assert.deepEqual(viaPublic, viaEnvelope);
});

test("F4 buildProfileReport: an unreachable collectible on a shipped profile forces overall status=fail", async () => {
  const layout: ReachabilityLayout = {
    platforms: [{ name: "Ground", topY: 0, minX: -3, maxX: 12 }],
    // y=20 is far above precision's 3.0+0.5 reach → unreachable → gates the verdict.
    collectibles: [{ name: "Skyhook", x: 5, y: 20 }],
  };
  const report = await buildProfileReport({
    root: path.join(os.tmpdir(), "nonexistent-f4-root"),
    profile: "precision",
    strict: false,
    layout,
  });
  assert.equal(report.reachability.status, "fail");
  assert.equal(report.status, "fail");
});

// ---------------------------------------------------------------------------
// CLI wiring — the `--layout` flag (F4): routing, refusal outside --profile,
// and an end-to-end unreachable run exiting non-zero.
// ---------------------------------------------------------------------------

async function unityRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "f4-cli-"));
  await fs.mkdir(path.join(dir, "ProjectSettings"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.0f1\n",
    "utf-8",
  );
  return dir;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function feelReportPath(workspace: string): string {
  return path.join(workspace, "feel", "reports", "feel-profile.json");
}

async function readFeelProfileReport(workspace: string): Promise<any> {
  const raw = await fs.readFile(
    feelReportPath(workspace),
    "utf-8",
  );
  return JSON.parse(raw);
}

test("F4 CLI: --layout requires --profile (refused elsewhere, exit 2)", async () => {
  const root = await unityRoot();
  try {
    const layoutPath = path.join(root, "layout.json");
    await fs.writeFile(layoutPath, JSON.stringify(SWAP_LAYOUT), "utf-8");
    // No --profile → usage error (exit 2).
    const code = await runVerifyCli(["--root", root, "--layout", layoutPath]);
    assert.equal(code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F4 CLI: --profile with a reachable --layout passes the gate; report carries reachability.pass", async () => {
  const root = await unityRoot();
  try {
    const layout: ReachabilityLayout = {
      platforms: [{ name: "Ground", topY: 0, minX: -3, maxX: 12 }],
      collectibles: [{ name: "Coin", x: 5, y: 3.0 }], // within precision's 3.5 reach
    };
    const layoutPath = path.join(root, "layout.json");
    const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
    await fs.writeFile(layoutPath, JSON.stringify(layout), "utf-8");
    await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--layout", layoutPath]);
    const report = await readFeelProfileReport(workspace);
    assert.equal(report.reachability.status, "pass");
    assert.ok(report.reachability.envelope);
    assert.equal(await fileExists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F4 CLI: --profile with an UNREACHABLE --layout exits 1 and stamps reachability.fail", async () => {
  const root = await unityRoot();
  try {
    const layout: ReachabilityLayout = {
      platforms: [{ name: "Ground", topY: 0, minX: -3, maxX: 12 }],
      collectibles: [{ name: "Skyhook", x: 5, y: 20 }], // way above precision's reach
    };
    const layoutPath = path.join(root, "layout.json");
    const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
    await fs.writeFile(layoutPath, JSON.stringify(layout), "utf-8");
    const code = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--layout", layoutPath]);
    assert.equal(code, 1); // status=fail → exit 1
    const report = await readFeelProfileReport(workspace);
    assert.equal(report.reachability.status, "fail");
    assert.equal(report.status, "fail");
    assert.equal(await fileExists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F4 CLI: a malformed --layout file exits 2 (refuse, don't crash)", async () => {
  const root = await unityRoot();
  try {
    const layoutPath = path.join(root, "bad.json");
    await fs.writeFile(layoutPath, "{ not json", "utf-8");
    const code = await runVerifyCli(["--profile", "precision", "--root", root, "--layout", layoutPath]);
    assert.equal(code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
