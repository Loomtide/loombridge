import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artModeRefusals,
  checkAssetSourceFidelity,
  checkHeroShotFidelity,
  COMPOSITION_REFERENCE_REFUSAL,
  diskTruthDesignTargetRefusals,
  genreCoverageRefusals,
  HERO_SHOT_FIDELITY_CRITERIA,
  isFreshGreen,
  isSliceDone,
  readDeclaredArtMode,
  runDoneness,
  validateVlmReviewFindingsShape,
  type VerdictReviewFindings,
  type VerdictLike,
} from "../../../../capabilities/verification/doneness.js";
import {
  unifiedScopedReportPath,
  unifiedVerifyReportPath,
  writeUnifiedVerifyReport,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import { deriveGenreCoverage } from "../../../../capabilities/genre/genre-coverage.js";
import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";
import { deriveSliceCaptureManifest, runBuild } from "../../../../capabilities/verification/build.js";
import { validateAssetManifest } from "../../../../capabilities/assets/asset-manifest.js";
import { designPaths, designStatus, setDesignTarget } from "../../../../capabilities/verification/design.js";
import { runPlan } from "../../../../capabilities/verification/plan.js";
import { runVerify } from "../../../../capabilities/verification/verify.js";
import {
  ensureScaffold,
  fileExists,
  loombridgePaths,
  readState,
  updateState,
  writeState,
  type LoombridgePaths,
  type LoombridgeState,
} from "../../../../domain/state.js";
import {
  writeSlicePlan,
  type SliceEntry,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";
import { writeApprovedAssetManifestForDesign } from "../../../helpers/asset-manifest-fixture.js";
import { fileURLToPath } from "node:url";
import { createDraftAssetManifest } from "../../../../capabilities/assets/asset-manifest.js";
import {
  applyRegistrySelectionsToManifest,
  buildRegistrySelectionPlan,
} from "../../../../capabilities/assets/manifest-selection.js";
import { loadAssetProfile, loadRegistryPack } from "../../../../capabilities/assets/registry.js";
import { evaluateAssetSourceFidelity } from "../../../../capabilities/verification/gates/asset-source-fidelity.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const doneTestRepoRoot = REPO_ROOT_SUPPORT;

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-done-"));
}

function doneSlice(id = "s1", runId = "run-s1"): SliceEntry {
  return {
    id,
    title: "Slice",
    dependsOn: [],
    skill: "s",
    feelIntent: "f",
    acceptance: { gates: ["manifest"] },
    state: "verified",
    proof: {
      runId,
      startedAt: "2026-05-28T00:00:00.000Z",
      verdictPath: `.loombridge/run/reports/slices/${id}.verdict.json`,
      captureManifest: [`${id}/verify-manifest.json`],
      checkpointId: id,
      approvedAt: null,
    },
  };
}

async function writeSliceProofFiles(root: string, slice: SliceEntry, verdict: Partial<VerdictLike> = {}): Promise<void> {
  const paths = loombridgePaths(root);
  const proof = slice.proof!;
  await ensureScaffold(paths);
  for (const entry of proof.captureManifest ?? []) {
    const abs = path.join(paths.verifyInputs, entry);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "{}", "utf-8");
  }
  const verdictPath = path.resolve(root, proof.verdictPath!);
  await fs.mkdir(path.dirname(verdictPath), { recursive: true });
  await fs.writeFile(
    verdictPath,
    JSON.stringify({
      status: "pass",
      runId: proof.runId,
      producedAt: "2026-05-28T01:00:00.000Z",
      ...verdict,
    }),
    "utf-8",
  );
}

// The roadmap's genre must MATCH the STATE the test writes: the slice roll-up resolves fidelity
// criteria + coverage from SLICES.json (the artifact being certified) and refuses a plan-vs-STATE
// genre drift, so a fixture that disagrees is testing a refusal it did not mean to test.
function planOf(slices: SliceEntry[], genre = "platformer-2d"): SlicePlan {
  return { schemaVersion: "1", genre, slices };
}

async function approveFakeDesignTarget(root: string): Promise<string> {
  const image = path.join(root, "hero-shot-source.png");
  await fs.writeFile(image, "hero-pixels-v1", "utf-8");
  const meta = await setDesignTarget({ root, imagePath: image, mode: "generated", kind: "rendered-unity-frame", approve: true });
  return meta.pngSha256;
}

function faithfulReview(heroShotSha256: string): VerdictReviewFindings {
  return {
    reference: { heroShotSha256 },
    independence: { independent: true, reviewerCount: 3 },
    frames: [{ id: "spawn", path: "spawn/frames/spawn.png" }],
    criteria: HERO_SHOT_FIDELITY_CRITERIA.map((id) => ({ id, status: "pass", reason: "ok", evidenceFrame: "spawn" })),
    summary: "Independent hero-shot fidelity review complete.",
  };
}

/** A faithful review against the 3d-shooter genre's fidelity criteria. */
function faithful3dReview(heroShotSha256: string): VerdictReviewFindings {
  return {
    reference: { heroShotSha256 },
    independence: { independent: true, reviewerCount: 3 },
    frames: [{ id: "arena", path: "arena/frames/arena.png" }],
    criteria: ["composition-match", "arena-framing", "enemy-readability", "hud-placement"].map(
      (id) => ({ id, status: "pass", reason: "ok", evidenceFrame: "arena" }),
    ),
    summary: "Independent 3D hero-shot fidelity review complete.",
  };
}

function passingAssetSourceChecks(): VerdictLike["checks"] {
  return [
    {
      id: "asset-source.manifest-approved",
      status: "pass",
      detail: "Asset manifest is approved.",
    },
    {
      id: "asset-source.binding.player_character",
      status: "pass",
      detail: "Manifest asset 'player_character' is approved and path-bound.",
    },
  ];
}

// ── isFreshGreen pure predicate ──────────────────────────────────────────────

function baselineState(): LoombridgeState {
  return {
    genre: "platformer-2d",
    engine: "unity",
    phase: "verified-green",
    designTarget: "approved",
    currentBuild: { runId: "run-A", startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] },
    lastVerdict: { status: "pass", at: "2026-05-28T01:00:00.000Z", verdictPath: "x" },
    updatedAt: "2026-05-28T01:00:00.000Z",
  };
}

test("isFreshGreen — ok when phase + runId + producedAt + captures all match", () => {
  const r = isFreshGreen({
    state: baselineState(),
    verdict: { status: "pass", runId: "run-A", producedAt: "2026-05-28T01:00:00.000Z" },
    captures: [{ path: "spawn/manifest.json", exists: true }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test("isFreshGreen — collects ALL failure reasons (no short-circuit)", () => {
  // Wrong phase + wrong status + wrong runId + missing capture all at once.
  const state = { ...baselineState(), phase: "built-unverified" as const };
  const r = isFreshGreen({
    state,
    verdict: { status: "fail", runId: "run-B", producedAt: "2026-05-28T01:00:00.000Z" },
    captures: [{ path: "spawn/manifest.json", exists: false }],
  });
  assert.equal(r.ok, false);
  // Every distinct problem appears in reasons (count ≥ 4).
  assert.ok(r.reasons.some((m) => /phase is/.test(m)), `missing phase reason: ${r.reasons.join(" | ")}`);
  assert.ok(r.reasons.some((m) => /verdict\.status is/.test(m)), `missing status reason: ${r.reasons.join(" | ")}`);
  assert.ok(r.reasons.some((m) => /runId .* ≠/.test(m)), `missing runId mismatch reason: ${r.reasons.join(" | ")}`);
  assert.ok(r.reasons.some((m) => /missing captureManifest/.test(m)), `missing captures reason: ${r.reasons.join(" | ")}`);
});

test("isFreshGreen — no currentBuild ⇒ NOT done (a verdict alone cannot certify)", () => {
  const r = isFreshGreen({
    state: { ...baselineState(), currentBuild: null },
    verdict: { status: "pass", runId: "run-A", producedAt: "2026-05-28T01:00:00.000Z" },
    captures: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /currentBuild/.test(m)));
});

test("isFreshGreen — verdict produced BEFORE currentBuild.startedAt is stale", () => {
  const r = isFreshGreen({
    state: baselineState(),
    verdict: { status: "pass", runId: "run-A", producedAt: "2026-05-27T23:00:00.000Z" },
    captures: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /BEFORE currentBuild\.startedAt/.test(m)));
});

test("isFreshGreen — no state ⇒ single clear reason", () => {
  const r = isFreshGreen({ state: null, verdict: null, captures: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 1);
  assert.ok(/STATE\.md/.test(r.reasons[0]));
});

test("isFreshGreen — verdict MISSING producedAt is refused (not silently passed)", () => {
  // Every other field is perfect; producedAt is absent. Must NOT certify.
  const r = isFreshGreen({
    state: baselineState(),
    verdict: { status: "pass", runId: "run-A" /* producedAt deliberately absent */ },
    captures: [],
  });
  assert.equal(r.ok, false, "a verdict without producedAt cannot be certified");
  assert.ok(
    r.reasons.some((m) => /producedAt/.test(m)),
    `must surface a producedAt reason: ${r.reasons.join(" | ")}`,
  );
});

test("isFreshGreen — unsafe captureManifest entries are a distinct hard failure (not silently `missing`)", () => {
  const r = isFreshGreen({
    state: baselineState(),
    verdict: { status: "pass", runId: "run-A", producedAt: "2026-05-28T01:00:00.000Z" },
    captures: [
      { path: "spawn/manifest.json", exists: true },
      { path: "../reports/build-verdict.json", exists: true, unsafe: true },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.reasons.some((m) => /UNSAFE entries/.test(m)),
    `must surface a distinct unsafe reason (not silently missing): ${r.reasons.join(" | ")}`,
  );
  // The unsafe entry must NOT bleed into the `missing` reason, even though
  // the consumer marked `exists: true` — safety overrides existence.
  assert.ok(!r.reasons.some((m) => /missing captureManifest entries/.test(m)));
});

test("isFreshGreen — currentBuild missing startedAt is refused (corrupt state)", () => {
  // Defensive: refuse to certify when startedAt is missing rather than
  // accidentally accepting any producedAt as on-or-after empty string.
  const broken = {
    ...baselineState(),
    currentBuild: { runId: "run-A", startedAt: "" /* corrupt */ },
  };
  const r = isFreshGreen({
    state: broken,
    verdict: { status: "pass", runId: "run-A", producedAt: "2026-05-28T01:00:00.000Z" },
    captures: [],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.reasons.some((m) => /startedAt/.test(m)),
    `must surface a startedAt reason: ${r.reasons.join(" | ")}`,
  );
});

// ── genre coverage (CommandSurfaceRedesign W1) ───────────────────────────────

/** A promotion report for an unregistered genre, as `plan --genre-contract` would write it. */
function promotionFor(genreId: string, fidelityCriteria?: string[]) {
  return {
    schemaVersion: "0.1.0",
    sourceGenreId: genreId,
    sourceConfidence: "candidate",
    generatedAcceptance: ".loombridge/ACCEPTANCE.json",
    generatedSlices: ".loombridge/SLICES.json",
    promotedCoreSlices: ["core"],
    deferredSlices: [],
    explicitGaps: {},
    measurability: [],
    refusalConditions: [],
    humanOracleChecks: [],
    ...(fidelityCriteria ? { fidelityCriteria } : {}),
  } as never;
}

test("genreCoverageRefusals — a `graded` verdict with NO coverage block still passes (back-compat)", () => {
  // THE SEAM: every verdict written before `genreCoverage` existed omits the block, and every one of
  // those is a registered genre. Refusing an absent block there would break published consumers for no
  // safety gain — a `graded` verdict claims exactly what it always claimed.
  const resolved = deriveGenreCoverage({ genre: "platformer-2d", promotion: null });
  assert.equal(resolved.coverage, "graded");
  assert.deepEqual(genreCoverageRefusals({ resolved, claimed: undefined }), []);
});

test("genreCoverageRefusals — an absent block on a NON-graded project REFUSES", () => {
  // The gap list travels in the block; omitting it would present a scoped pass as an unscoped one.
  const resolved = deriveGenreCoverage({ genre: "puzzle", promotion: promotionFor("puzzle") });
  assert.equal(resolved.coverage, "partially-graded");
  const refusals = genreCoverageRefusals({ resolved, claimed: undefined });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!, /carries no `genreCoverage` block/);
});

test("genreCoverageRefusals — a verdict claiming `graded` over a partially-graded project REFUSES", () => {
  // The laundering shape the RFC names: hand-write coverage into the verdict and present as fully
  // graded. Disk wins; the claim is compared to it, never trusted.
  const resolved = deriveGenreCoverage({ genre: "puzzle", promotion: promotionFor("puzzle") });
  const refusals = genreCoverageRefusals({ resolved, claimed: { coverage: "graded", genre: "puzzle" } });
  assert.ok(refusals.some((r) => /claims genre coverage `graded` but disk resolves `partially-graded`/.test(r)));
});

test("genreCoverageRefusals — a verdict binding coverage to another genre REFUSES", () => {
  const resolved = deriveGenreCoverage({ genre: "puzzle", promotion: promotionFor("puzzle") });
  const refusals = genreCoverageRefusals({
    resolved,
    claimed: { coverage: "partially-graded", genre: "platformer-2d" },
  });
  assert.ok(refusals.some((r) => /binds genre coverage to "platformer-2d"/.test(r)));
});

test("genreCoverageRefusals — a plain `ungraded` project CERTIFIES when honestly stamped", () => {
  // D1, now actually reachable: a free-form genre planned from the `_generic` template is
  // legitimately ungraded, and an ungraded build may exit 0 SCOPED. What keeps that honest is not a
  // refusal here — it is the derived, non-empty gap list that `printCoverageScope` prints on success.
  const resolved = deriveGenreCoverage({ genre: "puzzle", promotion: null });
  assert.equal(resolved.coverage, "ungraded");
  assert.deepEqual(
    genreCoverageRefusals({ resolved, claimed: { coverage: "ungraded", genre: "puzzle" } }),
    [],
    "an honestly-stamped ungraded project must be allowed to certify",
  );
  // The stamp is still mandatory, and still compared against disk.
  assert.ok(genreCoverageRefusals({ resolved, claimed: undefined }).length > 0, "absent stamp refuses");
  assert.ok(
    genreCoverageRefusals({ resolved, claimed: { coverage: "graded", genre: "puzzle" } }).length > 0,
    "claiming `graded` over an ungraded project still refuses",
  );
});

test("genreCoverageRefusals — a CONTRADICTION refuses on every path, stamped or not", () => {
  // The one `ungraded` that never certifies: the disk disagreeing with itself about which genre this
  // project is. Distinct from "unsupported genre", and keyed off the structured `contradiction`
  // field rather than gap prose so rewording the message cannot disable it.
  const resolved = deriveGenreCoverage({
    genre: knownGenreIds()[0]!,
    promotion: promotionFor("some-other-genre"),
  });
  assert.ok(resolved.contradiction, "a mismatched promotion report must set `contradiction`");
  for (const claimed of [undefined, { coverage: "ungraded", genre: knownGenreIds()[0]! }]) {
    assert.ok(
      genreCoverageRefusals({ resolved, claimed }).some((r) => /CONTRADICTION/.test(r)),
      `must refuse for claimed=${JSON.stringify(claimed)}`,
    );
  }
  // ...including on the slice path, which has no stamp to require.
  assert.ok(
    genreCoverageRefusals({ resolved, claimed: undefined, expectStamp: false }).length > 0,
    "the slice roll-up must not be the cheaper way around a contradiction",
  );
});

test("genreCoverageRefusals — expectStamp:false (the slice path) does not invent a stamp requirement", () => {
  // The slice roll-up has no whole-game verdict, so an absent block there is a fact about the path,
  // not a suppressed scope. Neither ungraded nor partially-graded is refused for lacking one.
  for (const resolved of [
    deriveGenreCoverage({ genre: "puzzle", promotion: null }),
    deriveGenreCoverage({ genre: "puzzle", promotion: promotionFor("puzzle") }),
  ]) {
    assert.deepEqual(
      genreCoverageRefusals({ resolved, claimed: undefined, expectStamp: false }),
      [],
      `${resolved.coverage} must not be refused merely for having no stamp to carry`,
    );
  }
});

test("isFreshGreen — an ungraded genre CERTIFIES when fresh, green and honestly stamped", () => {
  // The free-form end state: a genre with no pack and no contract, planned from `_generic`. It
  // reaches a green doneness (D1) — the scope lives in the printed gaps, not in a refusal.
  const r = isFreshGreen({
    state: { ...baselineState(), genre: "totally-made-up", designTarget: undefined },
    verdict: {
      status: "pass",
      runId: "run-A",
      producedAt: "2026-05-28T01:00:00.000Z",
      genreCoverage: { coverage: "ungraded", genre: "totally-made-up" },
    },
    captures: [],
    promotion: null,
  });
  assert.equal(r.ok, true, r.reasons.join(" | "));
});

test("THE UNGRADED MOAT — an approved Design Target on an ungraded genre still REFUSES", () => {
  // The invariant that makes the scoped pass safe. An ungraded genre has NO fidelity criteria, so
  // there is nothing to grade a frozen hero shot against; certifying one would be claiming a visual
  // match that nothing checked. Everything else here is green, so this refusal is the only thing
  // standing between an ungraded design-targeted build and a false "hero-shot faithful".
  //
  // LITMUS: drop the `fidelityCriteriaForGenre` refusal branch in isFreshGreen and this goes green.
  const r = isFreshGreen({
    state: { ...baselineState(), genre: "totally-made-up" },
    verdict: {
      status: "pass",
      runId: "run-A",
      producedAt: "2026-05-28T01:00:00.000Z",
      designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: "a".repeat(64), frozenMatches: true },
      genreCoverage: { coverage: "ungraded", genre: "totally-made-up" },
    },
    captures: [],
    promotion: null,
  });
  assert.equal(r.ok, false, "an ungraded build with a frozen hero shot must not certify");
  assert.ok(
    r.reasons.some((m) => /no hero-shot fidelity criteria/.test(m)),
    r.reasons.join(" | "),
  );
});

test("isFreshGreen — a partially-graded build CAN pass, with its coverage stamped", () => {
  // D1: an ungraded-in-part game reaches doneness, scoped. The stamp must agree with disk.
  const promotion = promotionFor("puzzle-hypercasual");
  const resolved = deriveGenreCoverage({ genre: "puzzle-hypercasual", promotion });
  const r = isFreshGreen({
    state: { ...baselineState(), genre: "puzzle-hypercasual", designTarget: undefined },
    verdict: {
      status: "pass",
      runId: "run-A",
      producedAt: "2026-05-28T01:00:00.000Z",
      genreCoverage: { coverage: resolved.coverage, genre: resolved.genre },
    },
    captures: [],
    promotion,
  });
  assert.equal(r.ok, true, r.reasons.join(" | "));
});

test("isFreshGreen — a partially-graded build with an APPROVED design target and no declared criteria REFUSES", () => {
  // The visual moat survives the coverage split: an unregistered genre that froze a hero shot but
  // declared no fidelity criteria has no oracle for it, so it cannot certify.
  const promotion = promotionFor("puzzle-hypercasual");
  const r = isFreshGreen({
    state: { ...baselineState(), genre: "puzzle-hypercasual" },
    verdict: {
      status: "pass",
      runId: "run-A",
      producedAt: "2026-05-28T01:00:00.000Z",
      designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: "a".repeat(64), frozenMatches: true },
      genreCoverage: { coverage: "partially-graded", genre: "puzzle-hypercasual" },
    },
    captures: [],
    promotion,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /no hero-shot fidelity criteria/.test(m)), r.reasons.join(" | "));
});

// ── checkHeroShotFidelity (plan §P0.1/P0.2/P0.3/P0.5) ────────────────────────

const FROZEN_SHA = "a".repeat(64);

/** A verdict that fully satisfies the hero-shot fidelity predicate. */
function faithfulVerdict(): VerdictLike {
  return {
    status: "pass",
    runId: "run-A",
    producedAt: "2026-05-28T01:00:00.000Z",
    designTarget: { status: "approved", pngSha256: FROZEN_SHA, frozenMatches: true },
    reviewFindings: {
      reference: { heroShotSha256: FROZEN_SHA },
      independence: { independent: true, reviewerCount: 3 },
      criteria: [
        { id: "composition-match", status: "pass", reason: "layout matches the mock" },
        { id: "parallax-present", status: "pass", reason: "3 parallax layers present" },
        { id: "platform-tiers", status: "pass", reason: "multi-tier staged platforms" },
        { id: "element-placement-arc", status: "pass", reason: "fruit on the jump arc" },
      ],
    },
    checks: passingAssetSourceChecks(),
  };
}

test("checkHeroShotFidelity — N/A (no reasons) when there is no approved design target", () => {
  assert.deepEqual(checkHeroShotFidelity({ status: "pass" }), []);
  assert.deepEqual(checkHeroShotFidelity({ status: "pass", designTarget: { status: "missing" } }), []);
  assert.deepEqual(checkHeroShotFidelity({ status: "pass", designTarget: { status: "draft" } }), []);
  assert.deepEqual(checkHeroShotFidelity(null), []);
});

test("checkHeroShotFidelity — a fully faithful verdict has no reasons", () => {
  assert.deepEqual(checkHeroShotFidelity(faithfulVerdict()), []);
});

test("checkAssetSourceFidelity — approved design target requires passing asset-source checks", () => {
  assert.deepEqual(checkAssetSourceFidelity(faithfulVerdict()), []);

  const missing = faithfulVerdict();
  delete missing.checks;
  assert.ok(checkAssetSourceFidelity(missing).some((reason) => /no asset-source fidelity checks/.test(reason)));

  const failing = faithfulVerdict();
  failing.checks = [
    { id: "asset-source.binding.player_character", status: "fail", detail: "registry fallback drift" },
  ];
  assert.ok(checkAssetSourceFidelity(failing).some((reason) => /registry fallback drift/.test(reason)));
});

test("checkAssetSourceFidelity — an approved 3d-shooter manifest passes the asset-source doneness chain", async () => {
  const registry = await loadRegistryPack(path.join(doneTestRepoRoot, "asset-layer/registry/3d-shooter.json"));
  const profile = await loadAssetProfile(path.join(doneTestRepoRoot, "asset-layer/profiles/3d-shooter.json"));
  const draft = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: FROZEN_SHA },
    registry: registry.packId,
    genre: "3d-shooter",
  });
  const plan = buildRegistrySelectionPlan(draft, registry, profile, { preferredLicense: "CC0-1.0" });
  assert.deepEqual(plan.issues, []);
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]));
  const approved = applyRegistrySelectionsToManifest({
    manifest: draft,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-26T00:00:00.000Z",
    preferredLicense: "CC0-1.0",
  });

  // The real (genre-agnostic) fidelity gate produces the verdict checks… (`stagedDocument: true`
  // names the shape: the project's declaration, not a capture (see D2).)
  const report = evaluateAssetSourceFidelity({ manifest: approved, stagedDocument: true });
  assert.ok(report.checks.every((check) => check.status === "pass"), JSON.stringify(report.checks.filter((c) => c.status !== "pass"), null, 2));

  // …and the doneness asset-source gate accepts them for an approved design target.
  const reasons = checkAssetSourceFidelity({
    status: "pass",
    designTarget: { status: "approved", pngSha256: FROZEN_SHA },
    checks: report.checks,
  });
  assert.deepEqual(reasons, []);
});

test("checkHeroShotFidelity — approved target with NO review is refused", () => {
  const reasons = checkHeroShotFidelity({
    status: "pass",
    designTarget: { status: "approved", pngSha256: FROZEN_SHA },
  });
  assert.equal(reasons.length, 1);
  assert.ok(/no independent hero-shot review/.test(reasons[0]));
});

test("checkHeroShotFidelity — RUN-1 shape (self-graded WARN, no reference) is refused on every axis", () => {
  // The exact RUN-1 failure: approved target, but the review judged contract
  // attributes (no `reference`), was self-graded (no `independence`), and
  // composition-match was a self-accepted WARN with the structural criteria absent.
  const reasons = checkHeroShotFidelity({
    status: "pass",
    designTarget: { status: "approved", pngSha256: FROZEN_SHA },
    reviewFindings: {
      criteria: [{ id: "composition-match", status: "warn", reason: "flat single-ground strip vs staged platforms" }],
    },
  });
  assert.ok(reasons.some((m) => /reference\.heroShotSha256/.test(m)), `P0.1 reference: ${reasons.join(" | ")}`);
  assert.ok(reasons.some((m) => /not marked `independence\.independent/.test(m)), `P0.3 independent: ${reasons.join(" | ")}`);
  assert.ok(reasons.some((m) => /reviewerCount/.test(m)), `P0.3 count: ${reasons.join(" | ")}`);
  assert.ok(reasons.some((m) => /composition-match` is `warn`/.test(m)), `P0.2 warn: ${reasons.join(" | ")}`);
  assert.ok(reasons.some((m) => /`parallax-present` is missing/.test(m)), `P0.2 missing: ${reasons.join(" | ")}`);
});

test("checkHeroShotFidelity — an approved verdict with NO frozen hash cannot bind any reference (P0.1 defense-in-depth)", () => {
  // Hand-crafted-verdict threat: status approved but pngSha256 absent + an
  // arbitrary reference sha. The binding must REFUSE, not accept the unbindable ref.
  const reasons = checkHeroShotFidelity({
    status: "pass",
    designTarget: { status: "approved" /* pngSha256 deliberately absent */ },
    reviewFindings: {
      reference: { heroShotSha256: "deadbeef".repeat(8) },
      independence: { independent: true, reviewerCount: 3 },
      criteria: HERO_SHOT_FIDELITY_CRITERIA.map((id) => ({ id, status: "pass" })),
    },
  });
  assert.ok(
    reasons.some((m) => /designTarget\.pngSha256` is absent/.test(m)),
    `must refuse an unbindable reference: ${reasons.join(" | ")}`,
  );
});

test("checkHeroShotFidelity — review against a NON-frozen hero shot is refused (P0.1)", () => {
  const v = faithfulVerdict();
  v.reviewFindings!.reference = { heroShotSha256: "b".repeat(64) };
  const reasons = checkHeroShotFidelity(v);
  assert.ok(
    reasons.some((m) => /not the FROZEN hero shot/.test(m)),
    `must catch a stale/wrong reference: ${reasons.join(" | ")}`,
  );
});

test("checkHeroShotFidelity — a single reviewer is not enough (P0.3)", () => {
  const v = faithfulVerdict();
  v.reviewFindings!.independence = { independent: true, reviewerCount: 1 };
  const reasons = checkHeroShotFidelity(v);
  assert.ok(reasons.some((m) => /need >=2 independent reviewers|need ≥2 independent reviewers/.test(m)), reasons.join(" | "));
});

// ── the 3D design-target split: composition-reference vs rendered-unity-frame ──

test("checkHeroShotFidelity — an explicit `rendered-unity-frame` is still faithful (the final/frozen kind)", () => {
  const v = faithfulVerdict();
  v.designTarget!.kind = "rendered-unity-frame";
  assert.deepEqual(checkHeroShotFidelity(v), []);
});

test("checkHeroShotFidelity — an ABSENT kind defaults to final (2D/platformer backward compat)", () => {
  const v = faithfulVerdict();
  assert.equal(v.designTarget!.kind, undefined, "the fixture carries no kind (pre-split shape)");
  assert.deepEqual(
    checkHeroShotFidelity(v),
    [],
    "an absent kind must behave like a frozen rendered-unity-frame — existing 2D doneness is unchanged",
  );
});

test("checkHeroShotFidelity — an APPROVED `composition-reference` can NEVER certify, even with an otherwise-faithful review", () => {
  const v = faithfulVerdict();
  v.designTarget!.kind = "composition-reference";
  const reasons = checkHeroShotFidelity(v);
  assert.equal(
    reasons.length,
    1,
    `a composition-reference must short-circuit to a single refusal (not per-criterion noise): ${reasons.join(" | ")}`,
  );
  assert.ok(/composition-reference/.test(reasons[0]), reasons.join(" | "));
  assert.ok(
    /rendered-unity-frame/.test(reasons[0]),
    "the refusal must point at the next step — capture a Unity frame + freeze it as rendered-unity-frame",
  );
});

test("checkHeroShotFidelity — a DRAFT composition-reference is N/A (only an APPROVED design target is held to fidelity)", () => {
  assert.deepEqual(
    checkHeroShotFidelity({ status: "pass", designTarget: { status: "draft", kind: "composition-reference" } }),
    [],
  );
});

// ── diskTruthDesignTargetRefusals (whole-game disk-truth moat, §3c) ───────────

const DISK_SHA = "c".repeat(64);
const finalDisk = (over: Partial<Parameters<typeof diskTruthDesignTargetRefusals>[0]> = {}) => ({
  status: "approved",
  kind: "rendered-unity-frame",
  pngSha256: DISK_SHA,
  frozenMatches: true,
  ...over,
});

test("diskTruthDesignTargetRefusals — no approved disk target is N/A unless STATE still says approved and verdict omits the binding", () => {
  const missingDisk = { status: "missing", kind: "rendered-unity-frame", pngSha256: null, frozenMatches: false };
  assert.deepEqual(diskTruthDesignTargetRefusals(missingDisk, null), []);
  assert.deepEqual(diskTruthDesignTargetRefusals({ status: "draft", kind: "rendered-unity-frame", pngSha256: DISK_SHA, frozenMatches: true }, null), []);
  // The sentence is now the one the SLICE twin prints, because both paths ask the question
  // through the same `designTargetApprovalClaims` predicate (B2). Same refusal, same facts, one
  // vocabulary.
  assert.ok(
    diskTruthDesignTargetRefusals(missingDisk, { status: "pass" }, "approved")
      .some((r) => /STATE records `designTarget: approved`/.test(r)),
  );
  // AND THE TRANSITION RULE ON THIS PATH TOO: a target DOWNGRADED to `draft` with the STATE
  // record scrubbed refuses on the meta's own record of its approval. Before B2 this branch read
  // STATE alone, so the same two edits certified here as well.
  assert.deepEqual(
    diskTruthDesignTargetRefusals(
      { status: "draft", kind: "rendered-unity-frame", pngSha256: DISK_SHA, frozenMatches: true },
      { status: "pass" },
      undefined,
    ),
    [],
    "a draft that was never approved is not a downgrade",
  );
  assert.ok(
    diskTruthDesignTargetRefusals(
      { status: "draft", kind: "rendered-unity-frame", pngSha256: DISK_SHA, frozenMatches: true, approvedAt: "2026-05-28T00:00:00.000Z" },
      { status: "pass" },
      undefined,
    ).some((r) => /records its own approval/.test(r)),
    "an `approvedAt` on a non-approved target is a downgrade, whatever the status word says",
  );
  assert.ok(
    diskTruthDesignTargetRefusals(
      { status: "draft", kind: "rendered-unity-frame", pngSha256: DISK_SHA, frozenMatches: true },
      { status: "pass" },
      undefined,
      true,
    ).some((r) => /STATE carries no `designTarget` record/.test(r)),
    "a meta on disk with the STATE record scrubbed is the pair taken apart",
  );
  assert.deepEqual(
    diskTruthDesignTargetRefusals(missingDisk, { status: "pass", designTarget: { status: "approved", pngSha256: DISK_SHA } }, "approved"),
    [],
    "deletion after verify stays on the verdict-driven fidelity path when the verdict still carries the approved target",
  );
});

test("diskTruthDesignTargetRefusals — an approved composition-reference on disk always refuses", () => {
  assert.deepEqual(diskTruthDesignTargetRefusals({ status: "approved", kind: "composition-reference", pngSha256: DISK_SHA, frozenMatches: true }, null), [COMPOSITION_REFERENCE_REFUSAL]);
});

test("diskTruthDesignTargetRefusals — approved rendered-unity-frame REFUSES a verdict that doesn't bind the frozen sha (the P1 hole)", () => {
  // (a) no verdict at all
  assert.ok(diskTruthDesignTargetRefusals(finalDisk(), null).some((r) => /no matching approved `designTarget` bound/.test(r)));
  // (b) verdict omits designTarget entirely — the user-reported repro
  assert.ok(diskTruthDesignTargetRefusals(finalDisk(), { status: "pass" }).some((r) => /no matching approved `designTarget` bound/.test(r)));
  // (c) verdict carries a non-approved designTarget
  assert.ok(diskTruthDesignTargetRefusals(finalDisk(), { status: "pass", designTarget: { status: "draft", pngSha256: DISK_SHA } }).some((r) => /no matching approved/.test(r)));
  // (d) verdict approved but bound to a DIFFERENT sha than disk
  assert.ok(diskTruthDesignTargetRefusals(finalDisk(), { status: "pass", designTarget: { status: "approved", pngSha256: "d".repeat(64) } }).some((r) => /no matching approved/.test(r)));
});

test("diskTruthDesignTargetRefusals — a verdict bound to the frozen sha passes (and a tampered frozen target is caught)", () => {
  // Properly bound → no disk-truth refusal (the verdict-driven fidelity then applies).
  assert.deepEqual(diskTruthDesignTargetRefusals(finalDisk(), { status: "pass", designTarget: { status: "approved", pngSha256: DISK_SHA } }), []);
  // Bound but the on-disk bytes changed since approval → frozen-hash refusal.
  assert.ok(
    diskTruthDesignTargetRefusals(finalDisk({ frozenMatches: false }), { status: "pass", designTarget: { status: "approved", pngSha256: DISK_SHA } })
      .some((r) => /frozen hash mismatch/.test(r)),
  );
});

test("validateVlmReviewFindingsShape — refuses agent-invented criteria object maps", () => {
  const issues = validateVlmReviewFindingsShape({
    reference: { heroShotSha256: FROZEN_SHA },
    independence: { independent: true, reviewerCount: 2 },
    frames: [{ id: "spawn", path: "spawn/frames/spawn.png" }],
    criteria: {
      "composition-match": { verdict: "pass", evidence: "looks right" },
    },
    summary: "pass",
  });
  assert.ok(issues.some((issue) => /criteria must be an array/.test(issue)), issues.join(" | "));
});

test("validateVlmReviewFindingsShape — refuses unsupported extra fields", () => {
  const issues = validateVlmReviewFindingsShape({
    schemaVersion: "1",
    reference: { heroShotSha256: FROZEN_SHA, title: "custom title" },
    independence: { independent: true, reviewerCount: 2, method: "custom prose" },
    frames: [{ id: "spawn", path: "spawn/frames/spawn.png", extra: true }],
    criteria: [{ id: "composition-match", status: "pass", reason: "ok", reviewerBlocks: {} }],
    summary: "pass",
  });
  assert.ok(issues.some((issue) => /unsupported field `schemaVersion`/.test(issue)), issues.join(" | "));
  assert.ok(issues.some((issue) => /reference has unsupported field `title`/.test(issue)), issues.join(" | "));
  assert.ok(issues.some((issue) => /independence has unsupported field `method`/.test(issue)), issues.join(" | "));
  assert.ok(issues.some((issue) => /frames\[0\] has unsupported field `extra`/.test(issue)), issues.join(" | "));
  assert.ok(issues.some((issue) => /criteria\[0\] has unsupported field `reviewerBlocks`/.test(issue)), issues.join(" | "));
});

test("isFreshGreen — refuses a fresh+green RUN-1-shape build (doneness moat closes)", () => {
  // Everything the OLD predicate checked is perfect (phase/runId/producedAt/
  // captures) — this is exactly RUN-1, which reached doneness=0. The fidelity
  // predicate must now flip it to NOT done.
  const v = faithfulVerdict();
  v.reviewFindings!.criteria = [
    { id: "composition-match", status: "warn", reason: "flat bg vs parallax; flat level vs staged platforms" },
    { id: "parallax-present", status: "fail", reason: "flat two-tone background, no parallax" },
    { id: "platform-tiers", status: "fail", reason: "single flat ground strip" },
    { id: "element-placement-arc", status: "pass" },
  ];
  const r = isFreshGreen({
    state: baselineState(),
    verdict: v,
    captures: [{ path: "spawn/manifest.json", exists: true }],
  });
  assert.equal(r.ok, false, "a hero-shot-divergent build must not certify even when fresh+green");
  assert.ok(r.reasons.some((m) => /composition-match/.test(m)));
  assert.ok(r.reasons.some((m) => /parallax-present/.test(m)));
});

test("isFreshGreen — certifies a fresh+green + hero-shot-faithful build", () => {
  const r = isFreshGreen({
    state: baselineState(),
    verdict: faithfulVerdict(),
    captures: [{ path: "spawn/manifest.json", exists: true }],
  });
  assert.equal(r.ok, true, r.reasons.join(" | "));
});

// ── isSliceDone deterministic per-slice predicate ────────────────────────────

test("isSliceDone — ok for verified slice with bound fresh pass verdict and captures", async () => {
  const root = await tmpRoot();
  try {
    const slice = doneSlice();
    await writeSliceProofFiles(root, slice);
    const r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, true, r.reasons.join(" | "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isSliceDone — refuses absent proof", async () => {
  const root = await tmpRoot();
  const slice = { ...doneSlice(), proof: undefined };
  const r = await isSliceDone(slice, loombridgePaths(root));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /not built/.test(m)), r.reasons.join(" | "));
});

test("isSliceDone — refuses missing and mismatched verdict.runId", async () => {
  const root = await tmpRoot();
  try {
    const slice = doneSlice();
    await writeSliceProofFiles(root, slice, { runId: undefined });
    let r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /verdict\.runId is missing/.test(m)), r.reasons.join(" | "));

    await writeSliceProofFiles(root, slice, { runId: "different" });
    r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /verdict\.runId .*slice\.proof\.runId/.test(m)), r.reasons.join(" | "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isSliceDone — refuses missing or older producedAt", async () => {
  const root = await tmpRoot();
  try {
    const slice = doneSlice();
    await writeSliceProofFiles(root, slice, { producedAt: undefined });
    let r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /producedAt is missing/.test(m)), r.reasons.join(" | "));

    await writeSliceProofFiles(root, slice, { producedAt: "2026-05-27T23:00:00.000Z" });
    r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /BEFORE slice\.proof\.startedAt/.test(m)), r.reasons.join(" | "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isSliceDone — refuses non-pass, missing capture, unsafe capture, and wrong state", async () => {
  const root = await tmpRoot();
  try {
    const slice = doneSlice();
    await writeSliceProofFiles(root, slice, { status: "warn" });
    let r = await isSliceDone(slice, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /verdict\.status/.test(m)), r.reasons.join(" | "));

    const missing = doneSlice();
    await writeSliceProofFiles(root, missing);
    await fs.rm(path.join(loombridgePaths(root).verifyInputs, "s1", "verify-manifest.json"));
    r = await isSliceDone(missing, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /missing slice captureManifest/.test(m)), r.reasons.join(" | "));

    const unsafe = doneSlice();
    unsafe.proof!.captureManifest = ["../escape.json"];
    await writeSliceProofFiles(root, unsafe);
    r = await isSliceDone(unsafe, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /UNSAFE/.test(m)), r.reasons.join(" | "));

    const wrongState = { ...doneSlice(), state: "built" as const };
    await writeSliceProofFiles(root, wrongState);
    r = await isSliceDone(wrongState, loombridgePaths(root));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => /slice\.state/.test(m)), r.reasons.join(" | "));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── runDoneness integration ──────────────────────────────────────────────────

test("doneness — blocks when no build is in flight", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  // No currentBuild set → doneness must refuse.
  const code = await runDoneness({ root });
  assert.equal(code, 1);
});

test("doneness — recognises a fresh + green verdict tied to currentBuild", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  // Simulate build minting currentBuild + a passing verdict bound to that runId
  // (the actual minting comes from build.ts in M2; doneness machinery is here).
  const runId = "run-doneness-test";
  const startedAt = "2026-05-28T00:00:00.000Z";
  await updateState(paths, {
    phase: "verified-green",
    currentBuild: { runId, startedAt, captureManifest: ["spawn/marker"] },
  });
  // Drop the required capture file...
  await ensureScaffold(paths);
  await fs.mkdir(path.join(paths.verifyInputs, "spawn"), { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, "spawn", "marker"), "x", "utf-8");
  // ...and a passing verdict that names the runId.
  await fs.writeFile(
    paths.verdict,
    JSON.stringify({ status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z" }),
    "utf-8",
  );

  assert.equal(await runDoneness({ root }), 0);

  // Mutate the verdict's runId — now stale, doneness refuses.
  await fs.writeFile(
    paths.verdict,
    JSON.stringify({ status: "pass", runId: "different-run", producedAt: "2026-05-28T01:00:00.000Z" }),
    "utf-8",
  );
  assert.equal(await runDoneness({ root }), 1);
});

test("doneness (whole-game path) — disk-truth refusal: a verdict that LIES about a composition-reference is refused", async () => {
  // The split's threat model: a hand-edited build-verdict.json tries to launder
  // an on-disk approved `composition-reference` into a green doneness. `doneness`
  // refuses from DISK truth (designStatus), independent of the verdict's
  // self-reported designTarget — so omitting the block or claiming `draft` /
  // `rendered-unity-frame` in the verdict cannot skip the refusal.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);

    const image = path.join(root, "comp-ref.png");
    await fs.writeFile(image, "composition-pixels", "utf-8");
    const meta = await setDesignTarget({ root, imagePath: image, mode: "generated", kind: "composition-reference", approve: true });

    const runId = "run-kind-launder";
    const startedAt = "2026-05-28T00:00:00.000Z";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt, captureManifest: [] } });
    await ensureScaffold(paths);

    // A verdict that lies: claims a FINAL kind + a fully faithful review bound to
    // the frozen bytes. Only the disk-truth override stands between this and a
    // false green.
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({
        status: "pass",
        runId,
        producedAt: "2026-05-28T01:00:00.000Z",
        designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: meta.pngSha256, frozenMatches: true },
        reviewFindings: faithfulReview(meta.pngSha256),
        checks: passingAssetSourceChecks(),
      }),
      "utf-8",
    );

    // The whole design-target block is bound to disk truth, so EVERY shape of a
    // lying verdict is refused — not just the one that flips `kind`:
    //   (a) claims a final rendered-unity-frame
    //   (b) OMITS designTarget entirely (the override must still fire)
    //   (c) claims designTarget.status:"draft" (status is read from disk, not trusted)
    const faithful = faithfulReview(meta.pngSha256);
    const checks = passingAssetSourceChecks();
    const lyingVerdicts = [
      { status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z", designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: meta.pngSha256, frozenMatches: true }, reviewFindings: faithful, checks },
      { status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z", /* designTarget omitted */ reviewFindings: faithful, checks },
      { status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z", designTarget: { status: "draft", kind: "rendered-unity-frame", pngSha256: meta.pngSha256, frozenMatches: true }, reviewFindings: faithful, checks },
    ];

    for (const [i, lie] of lyingVerdicts.entries()) {
      await fs.writeFile(paths.verdict, JSON.stringify(lie), "utf-8");
      const lines: string[] = [];
      const originalError = console.error;
      console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
      try {
        assert.equal(await runDoneness({ root }), 1, `lying verdict #${i} must not launder a composition-reference into final`);
      } finally {
        console.error = originalError;
      }
      assert.ok(lines.some((line) => /composition-reference/.test(line)), `verdict #${i}: ${lines.join("\n")}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness (whole-game path) — an approved rendered-unity-frame is NOT laundered by a verdict that OMITS designTarget (P1)", async () => {
  // The user-reported P1: approve an on-disk rendered-unity-frame, then hand-write
  // a fresh/pass build-verdict.json with NO designTarget block. The verdict-driven
  // fidelity check returns N/A (no block), so without the disk-truth binding guard
  // the build certifies green having NEVER run the hero-shot review.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const image = path.join(root, "final-hero.png");
    await fs.writeFile(image, "rendered-frame-pixels", "utf-8");
    await setDesignTarget({ root, imagePath: image, mode: "provided", approve: true }); // default kind = rendered-unity-frame

    const runId = "run-omit-launder";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] } });
    await ensureScaffold(paths);
    // Fresh + passing + run-bound, but designTarget OMITTED.
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z" }), "utf-8");

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    try {
      assert.equal(await runDoneness({ root }), 1, "an approved final target whose verdict omits designTarget must be refused");
    } finally {
      console.error = originalError;
    }
    assert.ok(lines.some((line) => /no matching approved `designTarget` bound to the frozen hero shot/.test(line)), lines.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness (whole-game path) — deleting the on-disk target cannot launder an omitted designTarget verdict", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const image = path.join(root, "final-hero.png");
    await fs.writeFile(image, "rendered-frame-pixels", "utf-8");
    await setDesignTarget({ root, imagePath: image, mode: "provided", approve: true });

    const runId = "run-delete-omit-launder";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] } });
    await ensureScaffold(paths);
    await fs.rm(paths.design, { recursive: true, force: true });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z" }), "utf-8");

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    try {
      assert.equal(await runDoneness({ root }), 1, "STATE-approved target deleted from disk plus omitted verdict designTarget must refuse");
    } finally {
      console.error = originalError;
    }
    assert.ok(lines.some((line) => /STATE records `designTarget: approved`/.test(line)), lines.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness (whole-game path) — deleting the on-disk target after verify still relies on the verdict-bound target", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const image = path.join(root, "final-hero.png");
    await fs.writeFile(image, "rendered-frame-pixels", "utf-8");
    const meta = await setDesignTarget({ root, imagePath: image, mode: "provided", approve: true });

    const runId = "run-delete-after-verify";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] } });
    await ensureScaffold(paths);
    await fs.rm(paths.design, { recursive: true, force: true });
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({
        status: "pass",
        runId,
        producedAt: "2026-05-28T01:00:00.000Z",
        designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: meta.pngSha256, frozenMatches: true },
        reviewFindings: faithfulReview(meta.pngSha256),
        checks: passingAssetSourceChecks(),
      }),
      "utf-8",
    );

    assert.equal(await runDoneness({ root }), 0, "a deleted disk target is okay only when the run-bound verdict still carries the approved target and faithful review");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness (whole-game path) — an on-disk approved rendered-unity-frame with a faithful verdict certifies green", async () => {
  // The positive counterpart to the disk-truth refusal: the new disk read must
  // NOT false-refuse a legitimate final hero shot. (Confirms the disk check is
  // strictly `kind === composition-reference`, never a blanket block.)
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);

    const image = path.join(root, "final-hero.png");
    await fs.writeFile(image, "rendered-frame-pixels", "utf-8");
    // No --kind ⇒ rendered-unity-frame (the final, eligible kind).
    const meta = await setDesignTarget({ root, imagePath: image, mode: "provided", approve: true });
    assert.equal(meta.kind, "rendered-unity-frame");

    const runId = "run-final-green";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] } });
    await ensureScaffold(paths);
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({
        status: "pass",
        runId,
        producedAt: "2026-05-28T01:00:00.000Z",
        designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: meta.pngSha256, frozenMatches: true },
        reviewFindings: faithfulReview(meta.pngSha256),
        checks: passingAssetSourceChecks(),
      }),
      "utf-8",
    );

    assert.equal(await runDoneness({ root }), 0, "a frozen rendered-unity-frame with a faithful review certifies on the whole-game path");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness refuses a hand-edited manifest containing a path-traversal entry", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  // Hand-inject a manifest with one safe + one traversal entry. Make BOTH
  // "exist" so the only thing distinguishing them is the safety check —
  // otherwise the result would be hidden as "missing."
  const runId = "run-traversal";
  await updateState(paths, {
    phase: "verified-green",
    currentBuild: {
      runId,
      startedAt: "2026-05-28T00:00:00.000Z",
      captureManifest: ["spawn/legit.json", "../reports/build-verdict.json"],
    },
  });
  await fs.mkdir(path.join(paths.verifyInputs, "spawn"), { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, "spawn", "legit.json"), "{}", "utf-8");
  // The traversal target really exists (we just wrote it earlier via the
  // verdict path), so a naive doneness would treat it as required + present.
  await fs.mkdir(path.dirname(paths.verdict), { recursive: true });
  await fs.writeFile(
    paths.verdict,
    JSON.stringify({ status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z" }),
    "utf-8",
  );

  assert.equal(
    await runDoneness({ root }),
    1,
    "doneness must refuse a manifest with a path-traversal entry even if the target file exists",
  );
});

test("doneness — refuses a design-targeted build whose verdict is hero-shot-divergent", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  const runId = "run-fidelity";
  await updateState(paths, {
    phase: "verified-green",
    currentBuild: { runId, startedAt: "2026-05-28T00:00:00.000Z", captureManifest: ["spawn/marker"] },
  });
  await ensureScaffold(paths);
  await fs.mkdir(path.join(paths.verifyInputs, "spawn"), { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, "spawn", "marker"), "x", "utf-8");

  const baseVerdict = {
    status: "pass",
    runId,
    producedAt: "2026-05-28T01:00:00.000Z",
    designTarget: { status: "approved", pngSha256: FROZEN_SHA, frozenMatches: true },
    reviewFindings: {
      reference: { heroShotSha256: FROZEN_SHA },
      independence: { independent: true, reviewerCount: 3 },
      criteria: [
        { id: "composition-match", status: "pass", reason: "ok" },
        { id: "parallax-present", status: "pass", reason: "ok" },
        { id: "platform-tiers", status: "pass", reason: "ok" },
        { id: "element-placement-arc", status: "pass", reason: "ok" },
      ],
    },
    checks: passingAssetSourceChecks(),
  };
  // Faithful → certified.
  await fs.writeFile(paths.verdict, JSON.stringify(baseVerdict), "utf-8");
  assert.equal(await runDoneness({ root }), 0);

  // RUN-1 divergence: composition-match self-accepted as WARN → refused.
  const divergent = structuredClone(baseVerdict);
  divergent.reviewFindings.criteria[0]!.status = "warn";
  await fs.writeFile(paths.verdict, JSON.stringify(divergent), "utf-8");
  assert.equal(await runDoneness({ root }), 1);

  // Self-graded (independence stripped) → refused even with all criteria pass.
  const selfGraded = structuredClone(baseVerdict);
  delete (selfGraded.reviewFindings as { independence?: unknown }).independence;
  await fs.writeFile(paths.verdict, JSON.stringify(selfGraded), "utf-8");
  assert.equal(await runDoneness({ root }), 1);
});

test("REGRESSION: the SLICE path refuses a laundered coverage claim in the whole-game verdict", async () => {
  // Found by live CLI testing and reproduced end-to-end before the fix.
  //
  // W1's slice-path coverage check passed `claimed: undefined`, on the stated assumption that "the
  // slice roll-up has no whole-game verdict to check for agreement". False: a full `loombridge
  // verify` writes build-verdict.json for a slice-planned project too. So its `genreCoverage` block
  // could be hand-edited to claim `graded` and nothing contradicted it.
  //
  // WHY THAT TIER MATTERS MOST: a `partially-graded` project is BY CONSTRUCTION slice-planned (it
  // needs a promotion report, which `plan --genre-contract` writes alongside SLICES.json). So the
  // disk-vs-verdict comparison covered `graded` and `ungraded` while missing the ONE tier the whole
  // coverage split was invented for. Verified against a real project by tampering with the verdict
  // and diffing doneness output: byte-identical before the fix.
  //
  // LITMUS: restore `claimed: undefined` in evaluateSliceDoneness and this test goes green.
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    const genre = "puzzle-hypercasual";

    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    await writeSlicePlan(paths, planOf([a], genre));
    await writeState(paths, { genre, engine: "unity", phase: "planned", lastVerdict: null, updatedAt: "2026-05-28T00:00:00.000Z" });
    // A promotion report makes disk truth `partially-graded` — the tier that was unprotected.
    await fs.writeFile(paths.genrePromotion, JSON.stringify(promotionFor(genre)), "utf-8");

    // An HONEST whole-game verdict certifies.
    const verdictPath = paths.verdict;
    await fs.mkdir(path.dirname(verdictPath), { recursive: true });
    const honest = { status: "pass", genreCoverage: { coverage: "partially-graded", genre } };
    await fs.writeFile(verdictPath, JSON.stringify(honest), "utf-8");
    assert.equal(await runDoneness({ root }), 0, "an honestly-stamped slice project must certify");

    // The SAME project, with only the coverage claim laundered upward, must NOT.
    await fs.writeFile(
      verdictPath,
      JSON.stringify({ ...honest, genreCoverage: { coverage: "graded", genre } }),
      "utf-8",
    );
    assert.equal(await runDoneness({ root }), 1, "a verdict claiming `graded` over a partially-graded project must refuse");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── H3: the unified `verify` roll-up reaches the certificate ─────────────────

/** Run `doneness` with stderr captured, so a refusal can be checked BY ITS REASON. */
async function captureDonenessOutput(root: string): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    return { code: await runDoneness({ root }), text: lines.join("\n") };
  } finally {
    console.error = originalError;
  }
}

/**
 * The report a real unified run writes for the H3 shape: a green contract section plus
 * an approved-but-UNSTAMPED trace baseline, which is a non-anchor row, so the run is
 * `partial` at the harness tier. Built through the SHIPPED writer and type, so a change
 * to either moves this fixture with it.
 *
 * UPDATED FOR M-H2 / M-M3 (the S2 fix pass). The roll-up is now BOUND to what it certifies, so
 * a fixture that hard-coded a stale `producedAt` and a `runId: null` was writing a report no
 * real run could produce, and every assertion built on it would have been measuring the
 * binding rather than the rule under test. This fixture is therefore honest by construction:
 * the CURRENT time (so the report never predates the verdict written moments earlier) and the
 * runId of the build actually in flight (read from STATE, `null` when there is no build, which
 * is what a real run stamps). An individual case can still override either field to attack the
 * binding on purpose.
 *
 * The timestamp is taken from the VERDICT when one exists (one millisecond after it), not from
 * the wall clock: these fixtures write a verdict whose `producedAt` is synthesised from
 * `currentBuild.startedAt`, so a wall-clock stamp would be a roll-up that predates the verdict
 * beside it, which is exactly what M-H2 (c) refuses. A real run writes the verdict first and
 * the roll-up after it, and this reproduces that order.
 */
async function writeUnifiedReport(root: string, over: Partial<UnifiedVerifyReport>): Promise<void> {
  const paths = loombridgePaths(root);
  const state = await readState(paths);
  const verdictProducedAt = await fs
    .readFile(paths.verdict, "utf-8")
    .then((raw) => (JSON.parse(raw) as { producedAt?: unknown }).producedAt)
    .catch(() => undefined);
  const after = typeof verdictProducedAt === "string" ? Date.parse(verdictProducedAt) + 1 : Date.now();
  const report: UnifiedVerifyReport = {
    kind: "unified-verify",
    schemaVersion: "1",
    producedAt: new Date(Number.isNaN(after) ? Date.now() : after).toISOString(),
    root,
    runId: state?.currentBuild?.runId ?? null,
    live: false,
    plan: [],
    notRun: [
      {
        kind: "trace",
        id: "happy-path",
        reason: "unstamped baseline (re-approve to stamp what approved it)",
        why: "non-anchor",
      },
    ],
    absentFamilies: [],
    // S2a/F12: both fields are required on the shipped type, so the fixture states them.
    only: null,
    deselected: [],
    sections: { contract: { status: "pass", exit: 0, anchored: false } },
    anchoredSections: [],
    unanchoredSections: ["contract"],
    status: "partial",
    exit: 2,
    notes: [],
    ...over,
  };
  await writeUnifiedVerifyReport(unifiedVerifyReportPath(loombridgePaths(root).reports), report);
}

test("H3: a unified verify that REFUSED blocks doneness, even though STATE says verified-green", async () => {
  // The hole: `verify.json` governed nothing. A unified run could exit 2 because a trace
  // baseline was never stamped, while the CONTRACT section inside the same run passed and
  // flipped STATE to `verified-green`. `doneness` then exited 0 and an agent quoted it.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await injectArtMode(root, "deferred");
    assert.equal(await runBuild({ root }), 0);
    const { runId, producedAt } = await fulfilCurrentBuildCaptures(root);
    await updateState(paths, { phase: "verified-green" });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");

    // CONTROL: with no unified report at all, this project certifies. S1 is additive, so a
    // project that never ran the bare door is unaffected, and this is what makes the
    // assertions below non-vacuous.
    assert.equal(await runDoneness({ root }), 0, "the setup must certify before the roll-up is introduced");

    // THE REFUSAL.
    await writeUnifiedReport(root, {});
    const refused = await captureDonenessOutput(root);
    assert.equal(refused.code, 1, "an anchor the unified run could not measure is not certified by a green gate");
    assert.match(refused.text, /unified verify refused \(status `partial`, exit 2\)/);
    assert.match(refused.text, /re-run `loombridge verify`/);

    // REFUSE-ONLY: a FULL GREEN report adds nothing, and (being unstamped by construction)
    // can never remove a refusal another gate produced. So a forged green buys exactly the
    // absence of one extra reason, which is why it is not a laundering path.
    await writeUnifiedReport(root, { status: "pass", exit: 0, notRun: [], unanchoredSections: [] });
    assert.equal(await runDoneness({ root }), 0, "a green unified run leaves the existing gates in charge");

    // MALFORMED IS A REFUSAL, NOT A SKIP: "delete the inconvenient fields" is the cheapest
    // attack on a file like this.
    await fs.writeFile(unifiedVerifyReportPath(paths.reports), "{ not json", "utf-8");
    const malformed = await captureDonenessOutput(root);
    assert.equal(malformed.code, 1);
    assert.match(malformed.text, /unreadable unified verify report/);

    // A well-formed JSON document that is not a unified report is equally unreadable here.
    await fs.writeFile(unifiedVerifyReportPath(paths.reports), JSON.stringify({ exit: 0 }), "utf-8");
    assert.equal((await captureDonenessOutput(root)).code, 1, "a document with no `kind` cannot vouch for a run");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F3: an exit-0 PARTIAL is not a certificate either, and the refusal names what was partial", async () => {
  // THE ROOT FIX (S2/F3). `exit === 0` was the whole test, and `partial` exits 0 in three
  // ordinary situations, each of which is a run that did NOT ask the question this
  // certificate answers. That is what made the overwrite family work: run the full door, get
  // a refusal, then run a narrower door and leave a 0-exit report standing where the refusal
  // used to be. All three shapes are pinned here, plus the scoped belt-and-braces case.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await injectArtMode(root, "deferred");
    assert.equal(await runBuild({ root }), 0);
    const { runId, producedAt } = await fulfilCurrentBuildCaptures(root);
    await updateState(paths, { phase: "verified-green" });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");

    // CONTROL: the FULL green certifies, so every refusal below is caused by the field it names.
    await writeUnifiedReport(root, { status: "pass", exit: 0, notRun: [], unanchoredSections: [] });
    assert.equal(await runDoneness({ root }), 0, "the setup must certify, or this proves nothing");

    // 1. Anchors skipped under --offline: exit 0, and NOT a certificate.
    await writeUnifiedReport(root, {
      status: "partial",
      exit: 0,
      unanchoredSections: [],
      notRun: [{ kind: "trace", id: "happy-path", reason: "needs a live editor, and --offline was passed", why: "live-only-skipped" }],
    });
    const live = await captureDonenessOutput(root);
    assert.equal(live.code, 1, "an offline run after a live drift must not certify");
    assert.match(live.text, /unified verify is `partial`, not `pass`/);
    assert.match(live.text, /skipped under --offline/);
    assert.match(live.text, /trace 'happy-path'/, "the refusal names WHICH anchor went unmeasured");

    // 2. An executed section that compared no frozen human approval: exit 0, still not done.
    await writeUnifiedReport(root, { status: "partial", exit: 0, notRun: [], unanchoredSections: ["contract"] });
    const unanchored = await captureDonenessOutput(root);
    assert.equal(unanchored.code, 1);
    assert.match(unanchored.text, /compared no frozen human approval: contract/);

    // 3. A SCOPED report (F1 belt and braces). A scoped run writes verify-scoped.json and can
    //    never land here, so this is unreachable by the shipped code, and it refuses rather
    //    than assuming that stays true.
    await writeUnifiedReport(root, { status: "pass", exit: 0, notRun: [], unanchoredSections: [], only: ["tests"] });
    const scoped = await captureDonenessOutput(root);
    assert.equal(scoped.code, 1, "a scoped run is never a certificate, whatever it says about itself");
    assert.match(scoped.text, /is SCOPED \(--only tests\)/);

    // …and a malformed `only` is refused rather than shrugged at.
    await writeUnifiedReport(root, { status: "pass", exit: 0, notRun: [], unanchoredSections: [], only: "tests" as unknown as null });
    assert.equal((await captureDonenessOutput(root)).code, 1, "an unreadable scoping cannot certify");

    // A report with no status word at all is UNREADABLE, not a value to shrug at: "delete the
    // inconvenient field" must not be cheaper than fixing the run.
    await fs.writeFile(
      unifiedVerifyReportPath(paths.reports),
      JSON.stringify({ kind: "unified-verify", exit: 0 }),
      "utf-8",
    );
    const statusless = await captureDonenessOutput(root);
    assert.equal(statusless.code, 1);
    assert.match(statusless.text, /unreadable unified verify report/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * A project that certifies RIGHT NOW: planned, built, every declared capture on disk, and a
 * fresh runId-bound green verdict. Every case below starts from it, so a refusal is caused by
 * the one field the case attacks and by nothing else.
 */
async function certifiedProject(): Promise<{
  root: string;
  paths: ReturnType<typeof loombridgePaths>;
  runId: string;
}> {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);
  await injectArtMode(root, "deferred");
  assert.equal(await runBuild({ root }), 0);
  const { runId, producedAt } = await fulfilCurrentBuildCaptures(root);
  await updateState(paths, { phase: "verified-green" });
  await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");
  return { root, paths, runId };
}

/** A full-green unified report, i.e. the ONLY shape `doneness` accepts. */
const FULL_GREEN = { status: "pass" as const, exit: 0, notRun: [], unanchoredSections: [] };

test("M-H2: a green roll-up bound to nothing certifies nothing (project, build, and ordering)", async () => {
  // THE HOLE. `unifiedVerifyRefusals` read a green verify.json and asked it no questions: not
  // which project it described, not which build, not whether it was the newest thing on disk.
  // A green report is a file anyone can produce, so every one of those is a way to keep an old
  // green standing where a refusal belongs. Four bindings, each attacked separately, each
  // starting from a project that certifies.
  const { root, paths, runId } = await certifiedProject();
  try {
    // CONTROL. Without any of the attacks below this project is `done`, so every refusal that
    // follows is caused by the field its case changed.
    await writeUnifiedReport(root, FULL_GREEN);
    assert.equal(await runDoneness({ root }), 0, "the setup must certify, or this proves nothing");
    const fullGreen = await fs.readFile(unifiedVerifyReportPath(paths.reports), "utf-8");
    const fullProducedAt = Date.parse((JSON.parse(fullGreen) as UnifiedVerifyReport).producedAt);

    /** Write a scoped report stamped at `producedAt`. A scoped run's ceiling is `partial`. */
    const writeScoped = async (producedAt: string): Promise<void> => {
      await writeUnifiedVerifyReport(unifiedScopedReportPath(paths.reports), {
        ...(JSON.parse(fullGreen) as UnifiedVerifyReport),
        producedAt,
        only: ["contract"],
        status: "partial",
      });
    };

    // (a) ONLY a scoped run exists. "This project never ran the full door" must not read the
    //     same as "this project never ran the door at all" (which is the additive S1 case).
    await fs.rm(unifiedVerifyReportPath(paths.reports));
    await writeScoped(new Date(fullProducedAt).toISOString());
    const scopedOnly = await captureDonenessOutput(root);
    assert.equal(scopedOnly.code, 1, "a subset run is the only answer this project ever gave");
    assert.match(scopedOnly.text, /only a SCOPED verify run exists/);
    assert.match(scopedOnly.text, /run the full `loombridge verify`/);

    // (b) a scoped run that POSTDATES the full report: full door refuses, narrow door greens.
    await fs.writeFile(unifiedVerifyReportPath(paths.reports), fullGreen, "utf-8");
    await writeScoped(new Date(fullProducedAt + 60_000).toISOString());
    const postdates = await captureDonenessOutput(root);
    assert.equal(postdates.code, 1);
    assert.match(postdates.text, /POSTDATES the full report/);

    // …and the same file stamped BEFORE the full run is no refusal at all: the full report is
    // still this project's most recent whole answer.
    await writeScoped(new Date(fullProducedAt - 60_000).toISOString());
    assert.equal(await runDoneness({ root }), 0, "an OLDER scoped run says nothing about the full one");
    await fs.rm(unifiedScopedReportPath(paths.reports));

    // (c) a roll-up that PREDATES the verdict standing next to it: the report never saw it.
    await writeUnifiedReport(root, { ...FULL_GREEN, producedAt: new Date(fullProducedAt - 60_000).toISOString() });
    const predates = await captureDonenessOutput(root);
    assert.equal(predates.code, 1);
    assert.match(predates.text, /PREDATES the Tier-1 verdict/);

    // (d) the FXC precedent: with a build in flight the report must carry THAT runId, and an
    //     ABSENT scope is an absent binding, never a comparison that quietly does not happen.
    for (const stamped of [null, "run-somebody-elses"]) {
      await writeUnifiedReport(root, { ...FULL_GREEN, runId: stamped });
      const unbound = await captureDonenessOutput(root);
      assert.equal(unbound.code, 1, `runId ${String(stamped)} must not certify the build in flight`);
      assert.match(unbound.text, /not scoped to the build in flight/);
      assert.match(unbound.text, new RegExp(`the build in flight is \`${runId}\``));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M-M3/M-M4/V3: the report must name THIS root, agree with itself, and carry a status that cannot be skipped", async () => {
  const { root, paths } = await certifiedProject();
  const other = await tmpRoot();
  try {
    await writeUnifiedReport(root, FULL_GREEN);
    assert.equal(await runDoneness({ root }), 0, "the setup must certify, or this proves nothing");

    // M-M3. A green report from ANOTHER project is still a green report; nothing in the
    // document stopped it certifying this one.
    await writeUnifiedReport(root, { ...FULL_GREEN, root: other });
    const foreign = await captureDonenessOutput(root);
    assert.equal(foreign.code, 1);
    assert.match(foreign.text, /belongs to another project root/);

    // …and an ABSENT root is refused too, with a re-run message: the orchestrator has stamped
    // `root` since S1, so a document without one cannot have come from a run of this code.
    await writeUnifiedReport(root, { ...FULL_GREEN, root: undefined as unknown as string });
    const rootless = await captureDonenessOutput(root);
    assert.equal(rootless.code, 1);
    assert.match(rootless.text, /names no `root`/);
    assert.match(rootless.text, /re-run `loombridge verify`/);

    // M-M4. `pass` is a word the resolver can only produce when all five of these hold, so a
    // document that claims it beside any one of them is hand-written (or produced by a
    // resolver that has drifted). Each is attacked on its own.
    const inconsistent: [Partial<UnifiedVerifyReport>, RegExp][] = [
      [{ notRun: [{ kind: "trace", id: "happy-path", reason: "broken baseline", why: "broken" }] }, /1 `notRun` row/],
      [{ unanchoredSections: ["contract"] }, /unanchored section\(s\) contract/],
      [{ deselected: [{ kind: "trace", id: "happy-path", section: "flow" }] }, /1 `deselected` row/],
      [{ sections: { contract: { status: "fail", exit: 1, anchored: true } } }, /section\(s\) that did not exit 0: contract/],
    ];
    for (const [over, pattern] of inconsistent) {
      await writeUnifiedReport(root, { ...FULL_GREEN, ...over });
      const claim = await captureDonenessOutput(root);
      assert.equal(claim.code, 1, `a \`pass\` beside ${JSON.stringify(over)} must not certify`);
      assert.match(claim.text, /internally inconsistent unified verify report/);
      assert.match(claim.text, pattern);
    }

    // V3, THE FALSY-SKIP LITMUS. The status rule is `report.status !== "pass"`, and the
    // anti-pattern one edit away is `report.status && report.status !== "pass"`, which lets an
    // EMPTY status word skip the check entirely. This report is green-looking and broken in
    // every other way, so nothing else here would catch it: if the empty status stops
    // refusing, this test fails.
    await writeUnifiedReport(root, {
      status: "" as unknown as UnifiedVerifyReport["status"],
      exit: 0,
      notRun: [{ kind: "trace", id: "happy-path", reason: "broken baseline", why: "broken" }],
      unanchoredSections: ["contract"],
    });
    const empty = await captureDonenessOutput(root);
    assert.equal(empty.code, 1, "an EMPTY status word is not `pass`, and must not skip the check");
    assert.match(empty.text, /unified verify is ``, not `pass`/);
    assert.match(empty.text, /trace 'happy-path'/, "the refusal still names what went unmeasured");
    assert.match(empty.text, /compared no frozen human approval: contract/);
  } finally {
    for (const d of [root, other]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("V13: an EMPTY `only` array renders as `(empty)`, never as a blank", async () => {
  // The refusal interpolates the selection, so `only: []` printed "(--only )", a sentence that
  // reads like a formatting bug rather than a refusal, in the one line an operator is meant to
  // act on. Unreachable from the shipped code (a scoped run writes elsewhere), which is exactly
  // why it has to read correctly when it does happen.
  const { root } = await certifiedProject();
  try {
    await writeUnifiedReport(root, { ...FULL_GREEN, only: [] });
    const rendered = await captureDonenessOutput(root);
    assert.equal(rendered.code, 1);
    assert.match(rendered.text, /is SCOPED \(--only \(empty\)\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("H3: the SLICE roll-up honours the unified refusal too (both doneness paths, not one)", async () => {
  const root = await tmpRoot();
  try {
    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    await writeSlicePlan(loombridgePaths(root), planOf([a]));
    assert.equal(await runDoneness({ root }), 0, "the slice setup must certify first, or this proves nothing");

    await writeUnifiedReport(root, {});
    const refused = await captureDonenessOutput(root);
    assert.equal(refused.code, 1, "a slice-planned project runs the same bare `verify` door");
    assert.match(refused.text, /unified-verify: REFUSE/);
    assert.match(refused.text, /unified verify refused/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — all approved + done + dependency order exits 0", async () => {
  const root = await tmpRoot();
  try {
    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    const b = { ...doneSlice("b", "run-b"), dependsOn: ["a"], state: "approved" as const };
    b.proof = { ...b.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    await writeSliceProofFiles(root, b);
    await writeSlicePlan(loombridgePaths(root), planOf([a, b]));
    assert.equal(await runDoneness({ root }), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — approved design target requires root hero-shot review", async () => {
  const root = await tmpRoot();
  try {
    const heroShotSha256 = await approveFakeDesignTarget(root);
    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planOf([a]));
    await writeApprovedAssetManifestForDesign(root, "hybrid");
    // A real design-targeted build always carries the planned genre; doneness now refuses an
    // unregistered/"unknown" genre rather than defaulting to platformer fidelity criteria.
    await writeState(paths, { genre: "platformer-2d", engine: "unity", phase: "planned", lastVerdict: null, updatedAt: "2026-05-28T00:00:00.000Z" });

    assert.equal(await runDoneness({ root }), 1, "missing root vlm-review.json must refuse final roll-up");

    await fs.writeFile(
      path.join(paths.verifyInputs, "vlm-review.json"),
      JSON.stringify(faithfulReview(heroShotSha256)),
      "utf-8",
    );
    assert.equal(await runDoneness({ root }), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — an approved composition-reference REFUSES doneness even with a faithful, frozen-bound review", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    // The 3D flow stops at scene assembly: the only approved target is a
    // composition-reference (style guide), not a captured Unity frame.
    const compRef = path.join(root, "comp-ref-source.png");
    await fs.writeFile(compRef, "composition-pixels", "utf-8");
    const meta = await setDesignTarget({
      root,
      imagePath: compRef,
      mode: "generated",
      kind: "composition-reference",
      approve: true,
    });

    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    await writeSlicePlan(paths, planOf([a], "3d-shooter"));
    await writeApprovedAssetManifestForDesign(root, "hybrid");
    await writeState(paths, { genre: "3d-shooter", engine: "unity", phase: "planned", lastVerdict: null, updatedAt: "2026-05-28T00:00:00.000Z" });
    // A perfectly faithful review against the FROZEN composition-reference bytes
    // still cannot rescue it — the artifact kind is wrong, full stop.
    await fs.writeFile(
      path.join(paths.verifyInputs, "vlm-review.json"),
      JSON.stringify(faithful3dReview(meta.pngSha256)),
      "utf-8",
    );

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    try {
      assert.equal(await runDoneness({ root }), 1, "a composition-reference must never certify doneness");
    } finally {
      console.error = originalError;
    }
    assert.ok(lines.some((line) => /composition-reference/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /rendered-unity-frame/.test(line)), lines.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — re-freezing the captured Unity frame as a rendered-unity-frame lets the SAME project certify", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    // 1) approve a composition-reference (unlocks scene assembly)…
    const compRef = path.join(root, "comp-ref.png");
    await fs.writeFile(compRef, "composition-pixels", "utf-8");
    await setDesignTarget({ root, imagePath: compRef, mode: "generated", kind: "composition-reference", approve: true });
    // 2) assemble the scene, 3) capture a real Unity frame, 4) freeze THAT frame.
    const unityFrame = path.join(root, "unity-frame.png");
    await fs.writeFile(unityFrame, "real-unity-capture-pixels", "utf-8");
    const finalMeta = await setDesignTarget({ root, imagePath: unityFrame, mode: "provided", kind: "rendered-unity-frame", approve: true });

    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    await writeSlicePlan(paths, planOf([a], "3d-shooter"));
    // Bind the asset manifest AFTER the final frame is frozen (it freezes to the current sha).
    await writeApprovedAssetManifestForDesign(root, "hybrid");
    await writeState(paths, { genre: "3d-shooter", engine: "unity", phase: "planned", lastVerdict: null, updatedAt: "2026-05-28T00:00:00.000Z" });
    // 5) only NOW does strict hero-shot fidelity run — and it certifies.
    await fs.writeFile(
      path.join(paths.verifyInputs, "vlm-review.json"),
      JSON.stringify(faithful3dReview(finalMeta.pngSha256)),
      "utf-8",
    );
    assert.equal(await runDoneness({ root }), 0, "a frozen rendered-unity-frame with a faithful 3D review certifies doneness");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — existing malformed vlm-review reports schema errors", async () => {
  const root = await tmpRoot();
  try {
    const heroShotSha256 = await approveFakeDesignTarget(root);
    const a = { ...doneSlice("a", "run-a"), state: "approved" as const };
    a.proof = { ...a.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planOf([a]));
    await fs.writeFile(
      path.join(paths.verifyInputs, "vlm-review.json"),
      JSON.stringify({
        reference: { heroShotSha256 },
        independence: { independent: true, reviewerCount: 2 },
        frames: [{ id: "spawn", path: "spawn/frames/spawn.png" }],
        criteria: { "composition-match": { verdict: "pass", evidence: "custom map" } },
        summary: "pass",
      }),
      "utf-8",
    );

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    try {
      assert.equal(await runDoneness({ root }), 1);
    } finally {
      console.error = originalError;
    }
    assert.ok(lines.some((line) => /vlm-review\.json exists but does not match/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /criteria must be an array/.test(line)), lines.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — refuses not-approved, not-done, and dependency-order violations", async () => {
  const root = await tmpRoot();
  try {
    const a = doneSlice("a", "run-a"); // verified, not approved
    const b = { ...doneSlice("b", "run-b"), dependsOn: ["a"], state: "approved" as const };
    b.proof = { ...b.proof!, approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, a, { status: "fail" });
    await writeSliceProofFiles(root, b);
    await writeSlicePlan(loombridgePaths(root), planOf([a, b]));
    assert.equal(await runDoneness({ root }), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slice doneness roll-up — an empty roadmap is NOT done (no 0/0 false-green)", async () => {
  const root = await tmpRoot();
  try {
    await writeSlicePlan(loombridgePaths(root), planOf([]));
    assert.equal(await runDoneness({ root }), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── verify records runId + producedAt (the supervisor verdict provenance) ────

test("verify embeds runId from currentBuild + producedAt in the verdict", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  // No currentBuild yet — verify should record runId: null.
  await runVerify({
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  });
  let verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.runId, null, "no currentBuild ⇒ verdict.runId is null");
  assert.ok(typeof verdict.producedAt === "string", "verdict.producedAt is an ISO string");

  // Now simulate a build minting currentBuild — verify must record the runId.
  await updateState(paths, {
    currentBuild: { runId: "run-Z", startedAt: "2026-05-28T00:00:00.000Z" },
  });
  await runVerify({
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  });
  verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.runId, "run-Z");
  assert.ok(verdict.producedAt > "2026-05-28T00:00:00.000Z");
});

// ── verify --stage: a diagnostic checkpoint must NOT certify (stage harness) ──

test("verify --stage construct is diagnostic — writes verify-<stage>.json, leaves STATE + build-verdict untouched", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);

    // Put the project in a known supervisor state we can detect tampering of.
    await updateState(paths, {
      phase: "built-unverified",
      currentBuild: { runId: "run-stage-test", startedAt: "2026-05-28T00:00:00.000Z", captureManifest: [] },
    });

    const stageOut = path.join(paths.reports, "verify-construct.json");
    const code = await runVerify({
      root,
      inputsDir: paths.verifyInputs, // empty → construct gates degrade to warn
      acceptancePath: paths.acceptance,
      outputPath: stageOut,
      strict: false,
      stage: "construct",
    });

    // Diagnostic report written; the certifiable verdict is NOT created.
    const staged = JSON.parse(await fs.readFile(stageOut, "utf-8"));
    assert.equal(staged.stage, "construct");
    assert.equal(staged.diagnostic, true);
    assert.equal(await fileExists(paths.verdict), false, "a staged run must NOT write build-verdict.json");

    // STATE phase is untouched by a diagnostic run (still built-unverified, not verified-*).
    const state = await readState(paths);
    assert.equal(state?.phase, "built-unverified", "a staged run must NOT flip the phase");
    assert.equal(state?.currentBuild?.runId, "run-stage-test", "currentBuild preserved");
    // With an EMPTY inputs dir no gate consumed a capture, so this staged run graded
    // nothing, so the engine's nothing-graded refusal (exit 2) applies here too. A
    // restricted stage already cannot certify; it must also not read as green.
    assert.equal(code, 2, "a staged run that graded nothing refuses rather than exiting 0");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── Gray-box / feel-only doneness mode (RCL-D01 / RCL-D02) ───────────────────

/** Inject an `art` posture into the runPlan-seeded ACCEPTANCE.json on disk. */
async function injectArtMode(root: string, mode: "deferred" | "final"): Promise<void> {
  const paths = loombridgePaths(root);
  const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as Record<string, unknown>;
  contract.art = { mode };
  await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
}

async function fulfilCurrentBuildCaptures(root: string): Promise<{ runId: string; producedAt: string }> {
  const paths = loombridgePaths(root);
  const built = await readState(paths);
  const runId = built!.currentBuild!.runId;
  const startedAt = built!.currentBuild!.startedAt;
  await ensureScaffold(paths);
  for (const entry of built!.currentBuild!.captureManifest ?? []) {
    const abs = path.join(paths.verifyInputs, entry);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "{}", "utf-8");
  }
  return { runId, producedAt: new Date(Date.parse(startedAt) + 1000).toISOString() };
}

// (a) reaches green without a hero shot
test("gray-box (art:deferred) — a feel/structural-only build reaches green WITHOUT a hero shot (RCL-D01)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await injectArtMode(root, "deferred");

    // No Design Target, no Asset Manifest — yet the build is GROUNDED (not ungrounded).
    assert.equal(await runBuild({ root }), 0, "gray-box build must be grounded without a design target");
    const built = await readState(paths);
    assert.equal(built?.currentBuild?.ungrounded, undefined, "art:deferred build must NOT be tagged ungrounded");

    const { runId, producedAt } = await fulfilCurrentBuildCaptures(root);
    await updateState(paths, { phase: "verified-green" });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");

    assert.equal(await runDoneness({ root }), 0, "gray-box doneness must certify on feel + structure with NO hero shot");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// (b) does NOT blanket-pass: a failing feel band still fails
test("gray-box (art:deferred) does NOT blanket-pass — a non-green Tier-1 verdict (failed feel band) still fails (RCL-D01)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await injectArtMode(root, "deferred");
    assert.equal(await runBuild({ root }), 0);

    const { runId, producedAt } = await fulfilCurrentBuildCaptures(root);
    await updateState(paths, { phase: "verified-green" });
    // A feel band out of range makes verify produce a FAILING Tier-1 verdict.
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({
        status: "fail",
        runId,
        producedAt,
        checks: [{ id: "feel.runSpeed", status: "fail", detail: "runSpeed 9.1 outside band [4.5,5.5]" }],
      }),
      "utf-8",
    );
    assert.equal(await runDoneness({ root }), 1, "a failing feel band must fail doneness even under art:deferred");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// (c) no laundering: a verdict cannot claim art:deferred without the on-disk contract declaring it
test("gray-box (art:deferred) laundering — a verdict that claims art:deferred while the contract does NOT is REFUSED (RCL-D01)", async () => {
  const launder = artModeRefusals({ contractArtMode: undefined, verdictArtMode: "deferred", designApprovedOnDisk: false, runtimeClaimsApprovedDesignTarget: false });
  assert.equal(launder.deferred, false, "verdict claim alone never enables the relaxation");
  assert.ok(launder.refusals.some((r) => /does NOT declare it/.test(r)), launder.refusals.join(" | "));

  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const runId = "run-launder";
    const startedAt = "2026-05-28T00:00:00.000Z";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt, captureManifest: [] } });
    await ensureScaffold(paths);
    // Contract declares NO art; the forged verdict claims it.
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({ status: "pass", runId, producedAt: "2026-05-28T01:00:00.000Z", art: { mode: "deferred" } }),
      "utf-8",
    );
    assert.equal(await readDeclaredArtMode(paths.acceptance), undefined, "the seeded contract declares no art posture");
    assert.equal(await runDoneness({ root }), 1, "a verdict cannot launder art:deferred without the on-disk contract declaring it");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// (c') contradiction: art:deferred + an approved Design Target (on disk OR claimed by the run-bound verdict/STATE) is refused.
test("gray-box (art:deferred) contradiction — declaring it WITH an approved Design Target (disk OR verdict/STATE) is REFUSED (RCL-D01)", () => {
  // (i) approved ON DISK
  const onDisk = artModeRefusals({ contractArtMode: "deferred", verdictArtMode: undefined, designApprovedOnDisk: true, runtimeClaimsApprovedDesignTarget: false });
  assert.equal(onDisk.deferred, false, "an approved Design Target on disk forces full fidelity even if art:deferred is declared");
  assert.ok(onDisk.refusals.some((r) => /mutually exclusive/.test(r)), onDisk.refusals.join(" | "));

  // (ii) THE TOCTOU QUADRANT — disk ABSENT but the run-bound verdict/STATE claims approved.
  const toctou = artModeRefusals({ contractArtMode: "deferred", verdictArtMode: undefined, designApprovedOnDisk: false, runtimeClaimsApprovedDesignTarget: true });
  assert.equal(toctou.deferred, false, "deleting the on-disk target must NOT enable the relaxation when the verdict/STATE still claims approved");
  assert.ok(toctou.refusals.some((r) => /TOCTOU|verdict\/STATE/.test(r)), toctou.refusals.join(" | "));

  // (iii) genuine gray-box — no approved target anywhere → deferred, no refusals.
  const okDeferred = artModeRefusals({ contractArtMode: "deferred", verdictArtMode: undefined, designApprovedOnDisk: false, runtimeClaimsApprovedDesignTarget: false });
  assert.equal(okDeferred.deferred, true, "deferred resolves true only with no approved target on disk OR in the verdict/STATE");
  assert.deepEqual(okDeferred.refusals, []);
});

// (BLOCKER regression) end-to-end PoC: a hero-shot-verified build cannot be laundered
// green by adding art:deferred + DELETING the on-disk design-target meta.
test("gray-box (art:deferred) TOCTOU — verdict-approved + disk-target deleted + art:deferred REFUSES (RCL-D01)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const pngSha256 = await approveFakeDesignTarget(root);

    const runId = "run-toctou";
    const startedAt = "2026-05-28T00:00:00.000Z";
    await updateState(paths, { genre: "platformer-2d", phase: "verified-green", currentBuild: { runId, startedAt, captureManifest: [] } });
    await ensureScaffold(paths);
    // A genuinely hero-shot-verified verdict: approved Design Target + a real
    // independent review bound to the frozen sha + passing asset-source checks.
    const verifiedVerdict = {
      status: "pass",
      runId,
      producedAt: "2026-05-28T01:00:00.000Z",
      designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256, frozenMatches: true },
      reviewFindings: faithfulReview(pngSha256),
      checks: passingAssetSourceChecks(),
    };
    await fs.writeFile(paths.verdict, JSON.stringify(verifiedVerdict), "utf-8");
    // Baseline: this build legitimately certifies (the moat passes).
    assert.equal(await runDoneness({ root }), 0, "baseline: a hero-shot-verified build certifies");

    // THE EXPLOIT (verbatim PoC): without touching the verdict, (a) declare
    // art:deferred in the contract, (b) delete the on-disk design-target meta so
    // designStatus → missing.
    await injectArtMode(root, "deferred");
    await fs.rm(designPaths(paths).meta, { force: true });
    assert.notEqual((await designStatus(paths)).status, "approved", "the on-disk design target is now missing");

    // The relaxation must NOT disable the existing hero-shot moat — REFUSE.
    assert.equal(await runDoneness({ root }), 1, "TOCTOU: art:deferred cannot launder a hero-shot-verified build to green");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// (d) no regression + self-defense: a non-deferred build still enforces fidelity, AND
// isFreshGreen REFUSES to skip when the run-bound verdict itself claims an approved target.
test("guard — non-deferred enforces hero-shot fidelity; artDeferred can NOT skip an approved-target verdict (RCL-D01)", () => {
  const verdict: VerdictLike = {
    status: "pass",
    runId: "run-A",
    producedAt: "2026-05-28T01:00:00.000Z",
    designTarget: { status: "approved", pngSha256: "abc", frozenMatches: true },
  };

  // Default (artDeferred absent → false): the approved target with no independent
  // review fails today, exactly as before this slice.
  const enforced = isFreshGreen({ state: baselineState(), verdict, captures: [] });
  assert.equal(enforced.ok, false, "a non-deferred design-targeted build must still require hero-shot fidelity");
  assert.ok(enforced.reasons.some((r) => /hero-shot/.test(r)), enforced.reasons.join(" | "));

  // DEFENSE-IN-DEPTH: even if a caller passes artDeferred:true alongside a verdict
  // that ITSELF claims an approved Design Target, isFreshGreen REFUSES to skip
  // fidelity (the premise "the caller never sets it true alongside an approved
  // target" was the bug). The relaxation can never disable an existing moat.
  const cannotSkip = isFreshGreen({ state: baselineState(), verdict, captures: [], artDeferred: true });
  assert.equal(cannotSkip.ok, false, "artDeferred must NOT skip fidelity when the verdict claims an approved target");
  assert.ok(cannotSkip.reasons.some((r) => /art:deferred relaxation REFUSED/.test(r)), cannotSkip.reasons.join(" | "));

  // The skip mechanic still works for a genuine gray-box verdict (no design target).
  const grayboxVerdict: VerdictLike = { status: "pass", runId: "run-A", producedAt: "2026-05-28T01:00:00.000Z" };
  const skipped = isFreshGreen({ state: { ...baselineState(), designTarget: "missing" }, verdict: grayboxVerdict, captures: [], artDeferred: true });
  assert.equal(skipped.ok, true, "artDeferred marks fidelity N/A for a genuine gray-box verdict");
});

// (e) asset gate (RCL-D02): primitiveFinal passes ONLY under art:deferred; under
// art:final it is INERT (a normal build cannot self-declare it to skip the gate).
test("asset gate (RCL-D02) — primitiveFinal passes ONLY under art:deferred; inert under art:final", () => {
  const heroShot = { path: ".loombridge/design/hero-shot.png", sha256: "a".repeat(64) };
  const base = createDraftAssetManifest({ mode: "generated", heroShot });
  base.status = "approved";
  base.approvedAt = "2026-06-05T00:00:00.000Z";
  for (const s of base.assetSources) s.approved = true;

  const primitiveRole = base.assets[0]!.id;
  base.assets = base.assets.map((a, i) => {
    if (i === 0) {
      // Primitive IS the intended deliverable — no resolved paths / provenance.
      return { ...a, status: "approved" as const, primitiveFinal: true };
    }
    return {
      ...a,
      status: "approved" as const,
      resolvedPaths: [`Assets/Art/${i}-${a.id}.png`],
      generatedExport: {
        generatedSetId: "generated_set_needed",
        generator: "fixture",
        sourceImageSha256: heroShot.sha256,
        producedAt: "2026-06-05T00:00:00.000Z",
        license: "project-generated",
        provenance: { origin: "hero-shot-annotation" as const, annotationId: `ann-${a.id}` },
      },
    };
  });

  // ── art:deferred posture → VALID; the gate passes the primitive role by design.
  const validDeferred = validateAssetManifest(base, { artDeferred: true });
  assert.equal(validDeferred.valid, true, JSON.stringify(validDeferred.issues));
  const reportDeferred = evaluateAssetSourceFidelity({ manifest: base, artDeferred: true });
  const binding = reportDeferred.checks.find((c) => c.id === `asset-source.binding.${primitiveRole}`);
  assert.ok(binding, "primitive-final role has a binding check under art:deferred");
  assert.equal(binding!.status, "pass", "primitive-final role passes the asset gate by design under art:deferred");
  assert.match(binding!.detail ?? "", /primitive-final/);

  // ── art:final (DEFAULT) → primitiveFinal is INERT: the unprovenanced role can NOT
  //    pass. This is the HIGH fix — a normal build cannot self-declare primitiveFinal
  //    to satisfy REQUIRED_ASSET_ROLES / skip asset-source fidelity without real provenance.
  const validFinal = validateAssetManifest(base);
  assert.equal(validFinal.valid, false, "under art:final, primitiveFinal must NOT waive provenance");
  assert.ok(validFinal.issues.some((x) => x.code === "MISSING_RESOLVED_PATH"), validFinal.issues.map((x) => x.code).join(","));
  const reportFinal = evaluateAssetSourceFidelity({ manifest: base }); // no artDeferred → art:final
  assert.ok(
    reportFinal.checks.some((c) => c.id === "asset-source.manifest-valid" && c.status === "fail"),
    "art:final gate rejects the unprovenanced primitiveFinal manifest",
  );
  assert.ok(
    !reportFinal.checks.some((c) => /primitive-final/.test(c.detail ?? "")),
    "art:final must NEVER emit a primitive-final pass-by-design",
  );

  // ── A role NOT marked primitiveFinal still requires its asset, even under art:deferred.
  const unmarked = { ...base, assets: base.assets.map((a, i) => (i === 0 ? { ...a, primitiveFinal: false } : a)) };
  const resUnmarked = validateAssetManifest(unmarked, { artDeferred: true });
  assert.equal(resUnmarked.valid, false, "an unmarked role with no resolved asset must fail the manifest gate");
  assert.ok(resUnmarked.issues.some((x) => x.code === "MISSING_RESOLVED_PATH"), resUnmarked.issues.map((x) => x.code).join(","));
});

// ── refuse-on-absent across gates (the SKIP-ON-ABSENT class) ────────────────

/**
 * A slice-planned fixture that CERTIFIES, so each attack below is one deletion away from
 * green and nothing else is doing the refusing.
 *
 * `captureManifest` is minted through the SHIPPED `deriveSliceCaptureManifest` rather than a
 * literal, for the same reason doneness re-derives it: a hand-written manifest that
 * under-declares what a slice's gates owe is a fixture testing the wrong refusal.
 */
async function certifyingSliceProject(opts: { approveDesignTarget?: boolean } = {}): Promise<{
  root: string;
  paths: LoombridgePaths;
  slice: SliceEntry;
}> {
  const root = await tmpRoot();
  const paths = loombridgePaths(root);
  const slice: SliceEntry = { ...doneSlice(), state: "approved" };
  slice.proof = {
    ...slice.proof!,
    captureManifest: deriveSliceCaptureManifest(slice),
    approvedAt: "2026-05-28T02:00:00.000Z",
  };
  // The design target is approved BEFORE the slice verdict is written, because that is the real
  // order: `verify --slice` reads `designStatus` and stamps the target's status into the verdict
  // it mints. A fixture whose verdict omitted the block would be testing a proof no `verify`
  // produces, and would silently exempt itself from the signal that block carries.
  const pngSha256 = opts.approveDesignTarget ? await approveFakeDesignTarget(root) : null;
  await writeSliceProofFiles(
    root,
    slice,
    pngSha256
      ? {
          designTarget: {
            status: "approved",
            kind: "rendered-unity-frame",
            pngSha256,
            frozenMatches: true,
          },
        }
      : {},
  );
  await writeSlicePlan(paths, planOf([slice]));
  await writeState(paths, {
    genre: "platformer-2d",
    engine: "unity",
    phase: "planned",
    lastVerdict: null,
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...(opts.approveDesignTarget ? { designTarget: "approved" as const } : {}),
  });
  return { root, paths, slice };
}

/**
 * B: THE SLICE PATH HAD NO DISK-TRUTH DESIGN-TARGET GUARD, AND THE POLARITY WAS BACKWARDS.
 *
 * `checkSliceRollupHeroShotFidelity` and `checkSliceRollupAssetSourceFidelity` both opened with
 * `if (design.status !== "approved") return []`, and `designStatus` resolves a DELETED
 * `design-target.json` to `status: "missing"`. `diskTruthDesignTargetRefusals`, which handles
 * exactly this on the whole-game path, was never called from the slice path.
 *
 * The polarity is the tell: a CORRUPT target refused (`readMeta` rethrows anything that is not
 * ENOENT) while a DELETED one certified. Deleting is strictly easier than corrupting, so the
 * cheaper attack was the one that worked.
 *
 * BEFORE, one fixture, changing nothing but that one file, with STATE still recording
 * `designTarget: approved` throughout:
 *
 *   [B control: target PRESENT] exit: 1
 *     - hero-shot-fidelity: REFUSE
 *         - design target is `approved` but the verdict carries no independent hero-shot review …
 *   [B corrupt] exit: 1 | fatal: Expected property name or '}' in JSON at position 2 (line 1 column 3)
 *   [B ATTACK: target DELETED] exit: 0
 *     - hero-shot-fidelity: PASS
 *     - asset-source-fidelity: PASS
 *   [loombridge doneness] OK — 1/1 slices approved + deterministic proofs fresh + hero-shot faithful + asset-source faithful.
 *
 * LITMUS, run 2026-08-13. `sliceDiskTruthDesignTargetRefusals` neutered to `return []`, rebuilt,
 * re-run:
 *
 *   ✖ MOAT (B): a DELETED design target on the SLICE path refuses exactly as a corrupt one does (4.872708ms)
 *     AssertionError [ERR_ASSERTION]: deleting the design target must not be cheaper than corrupting it
 *
 *     0 !== 1
 *
 *   ℹ pass 79
 *   ℹ fail 2   (B and C were neutered in the same pass)
 *
 * `0 !== 1` is the certificate the deletion bought. Restored: 81 pass, 0 fail.
 */
test("MOAT (B): a DELETED design target on the SLICE path refuses exactly as a corrupt one does", async () => {
  const { root, paths } = await certifyingSliceProject({ approveDesignTarget: true });
  try {
    const metaPath = designPaths(paths).meta;

    // CONTROL: the target is present, so the roll-up asks for the fidelity review it owes.
    const present = await captureDonenessOutput(root);
    assert.equal(present.code, 1, "an approved target with no review must refuse");
    assert.match(present.text, /hero-shot-fidelity: REFUSE/);

    // CORRUPT, refused today. Asserted so it stays the baseline the deleted case is measured
    // against (`runDoneness` throws here; the CLI's own `run()` catches it and exits 1).
    await fs.writeFile(metaPath, "{ not json", "utf-8");
    const corrupt = await runDoneness({ root }).then(
      (code) => code,
      () => 1,
    );
    assert.notEqual(corrupt, 0, "a corrupt design target must never certify");

    // THE ATTACK: delete the file. Nothing else changes: STATE still says approved and the
    // frozen hero-shot png is still sitting in `.loombridge/design/`.
    await fs.rm(metaPath);
    const deleted = await captureDonenessOutput(root);
    assert.equal(deleted.code, 1, "deleting the design target must not be cheaper than corrupting it");
    assert.match(deleted.text, /hero-shot-fidelity: REFUSE/);
    assert.match(deleted.text, /the on-disk Design Target is `missing`/);
    assert.match(deleted.text, /STATE records `designTarget: approved`/);
    assert.match(deleted.text, /hero-shot artifacts are still in/);

    // AND WITH STATE SCRUBBED TOO. This is the question "what does the new refusal now depend
    // on": if it depended on STATE alone, one more hand-edit would silence it. The orphaned
    // hero-shot artifacts are an independently-written second signal.
    const state = (await readState(paths))!;
    const withoutStamp = { ...state };
    delete (withoutStamp as { designTarget?: unknown }).designTarget;
    await writeState(paths, withoutStamp);
    const scrubbed = await captureDonenessOutput(root);
    assert.equal(scrubbed.code, 1, "scrubbing STATE as well must not buy the certificate back");
    assert.match(scrubbed.text, /hero-shot artifacts are still in/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("B false-failure check: a project MID-AUTHORING (a draft that was never approved) still certifies", async () => {
  // The refusal fires on EVIDENCE that a target was approved, never on the absence of one. If
  // it ever fires on absence, every gray-box and `--allow-ungrounded-prototype` project is
  // permanently red.
  //
  // WHAT THIS TEST IS FOR, stated precisely, because the first cut of it asserted something
  // wider than it meant and thereby ENSHRINED the B2 hole: the case that must stay green is a
  // draft that was NEVER approved, which is what `target set` (no `--approve`) writes and what a
  // project genuinely mid-authoring has. A draft that carries an `approvedAt`, or one whose STATE
  // record was scrubbed, is a DOWNGRADE and refuses; see MOAT (B2). "A DRAFT design target is
  // not a deleted one" was true and beside the point.
  const { root, paths } = await certifyingSliceProject();
  try {
    assert.equal(await runDoneness({ root }), 0, "no Design Target anywhere is not a refusal");

    // A DRAFT target: the meta EXISTS, so `design.status` is `draft`, not `missing`. Nothing was
    // taken apart, so no signal in the union may fire.
    const image = path.join(root, "draft-hero.png");
    await fs.writeFile(image, "draft-pixels", "utf-8");
    await setDesignTarget({ root, imagePath: image, mode: "generated", kind: "rendered-unity-frame", approve: false });
    const status = await designStatus(paths);
    assert.equal(status.status, "draft");
    assert.equal(status.approvedAt, null, "a never-approved draft carries no approval timestamp");
    assert.equal(
      (await readState(paths))?.designTarget,
      "draft",
      "`target set` writes the meta and the STATE record together, so the pair is intact",
    );
    const draft = await captureDonenessOutput(root);
    assert.equal(draft.code, 0, "a draft that was never approved is a project mid-authoring, not a downgrade");
    assert.doesNotMatch(draft.text, /the on-disk Design Target is/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * C: OMITTING A FIELD CERTIFIED WHERE DECLARING IT REFUSED.
 *
 * `isSliceDone` read `proof.captureManifest ?? []`, so a slice whose captures were DECLARED and
 * absent refused, while the SAME slice with the field omitted certified. `assertValidSlicePlan`
 * accepts the omission (the field is optional, and the closed-key check only rejects UNKNOWN
 * keys), so nothing else noticed.
 *
 * BEFORE, one fixture, three variants of the same slice:
 *
 *   [C declared-but-missing] exit: 1 | - missing slice captureManifest entries: s1/verify-manifest.json
 *   [C omitted]              exit: 0 | - s1: PASS … OK — 1/1 slices approved …
 *   [C emptied []]           exit: 0 | - s1: PASS … OK — 1/1 slices approved …
 *
 * The `[]` variant is why refusing only the ABSENT field would have MOVED the hole rather than
 * closed it: emptying the array is one character more work. So the expected set is RE-DERIVED
 * from the slice's own declared gates through the same `sliceCaptureManifestEntries` that
 * `build` mints from (the PR #88 rule: every `expected` must be recomputable from artifacts on
 * disk, by the same code path that reads it).
 *
 * LITMUS, run 2026-08-13. Both new blocks in `isSliceDone` removed and
 * `manifest: proof.captureManifest ?? []` restored, rebuilt, re-run:
 *
 *   ✖ MOAT (C): an omitted or emptied captureManifest must not certify where a declared one refuses (4.2765ms)
 *     AssertionError [ERR_ASSERTION]: omitting the field must not be cheaper than declaring it
 *
 *     0 !== 1
 *
 *   ℹ pass 79
 *   ℹ fail 2   (B and C were neutered in the same pass)
 *
 * Restored: 81 pass, 0 fail.
 */
test("MOAT (C): an omitted or emptied captureManifest must not certify where a declared one refuses", async () => {
  const { root, paths, slice } = await certifyingSliceProject();
  try {
    assert.equal(await runDoneness({ root }), 0, "the setup must certify before anything is removed");
    const declared = slice.proof!.captureManifest!;
    assert.ok(declared.length > 0, "the fixture slice must actually owe captures");

    // DECLARED AND MISSING, refused today, and the baseline the two attacks are measured
    // against.
    for (const entry of declared) await fs.rm(path.join(paths.verifyInputs, entry));
    const missing = await captureDonenessOutput(root);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /missing slice captureManifest entries/);

    // ATTACK 1: omit the field entirely. The capture files stay deleted.
    const omitted: SliceEntry = { ...slice, proof: { ...slice.proof! } };
    delete (omitted.proof as { captureManifest?: string[] }).captureManifest;
    await writeSlicePlan(paths, planOf([omitted]));
    const omittedRun = await captureDonenessOutput(root);
    assert.equal(omittedRun.code, 1, "omitting the field must not be cheaper than declaring it");
    assert.match(omittedRun.text, /slice\.proof\.captureManifest is ABSENT/);
    assert.match(omittedRun.text, /does not declare the capture\(s\) this slice's own gates require/);

    // ATTACK 2: declare an EMPTY manifest, which is what refusing only the absent field would
    // have left open.
    await writeSlicePlan(paths, planOf([{ ...slice, proof: { ...slice.proof!, captureManifest: [] } }]));
    const emptied = await captureDonenessOutput(root);
    assert.equal(emptied.code, 1, "an emptied manifest is a shrunken anchor, not a smaller obligation");
    assert.match(emptied.text, /does not declare the capture\(s\) this slice's own gates require/);

    // AND THE CONTROL BACK: restore the captures under the honest manifest and it certifies.
    await writeSlicePlan(paths, planOf([slice]));
    for (const entry of declared) {
      const abs = path.join(paths.verifyInputs, entry);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "{}", "utf-8");
    }
    assert.equal(await runDoneness({ root }), 0, "the honest project must go green again");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("C false-failure check: a slice whose gates genuinely have no captures still certifies with []", async () => {
  // `build` prints "(none — slice gates have no captured-op file)" for exactly this case and
  // stamps `captureManifest: []`. If the re-derivation ever read that as an under-declaration,
  // every SFX-only or asset-only slice would be permanently red. Both sides call the SAME
  // function, so they agree by construction; this test is what proves the agreement is real
  // rather than assumed.
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    const slice: SliceEntry = {
      ...doneSlice(),
      state: "approved",
      acceptance: { gates: ["asset-source-fidelity"] },
    };
    assert.deepEqual(
      deriveSliceCaptureManifest(slice),
      [],
      "the fixture is only meaningful if this slice's gates genuinely mint nothing",
    );
    slice.proof = { ...slice.proof!, captureManifest: [], approvedAt: "2026-05-28T02:00:00.000Z" };
    await writeSliceProofFiles(root, slice);
    await writeSlicePlan(paths, planOf([slice]));
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "planned",
      lastVerdict: null,
      updatedAt: "2026-05-28T00:00:00.000Z",
    });
    assert.equal(await runDoneness({ root }), 0, "an honestly capture-free slice must still certify");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── present-but-vacuous: the class the refuse-on-absent wave left behind ─────
//
// The wave above closed "the bound input is ABSENT". Every predicate it added asks whether the
// bound input is there and is the right type, and none asks whether the value it holds still
// CONSTRAINS anything. So the same false green was reachable by supplying a legal value that
// means nothing. The four tests below are that class, one per door.

/**
 * B2: A DOWNGRADED DESIGN TARGET CERTIFIED, AND THE FIRST CUT ENSHRINED IT IN A TEST.
 *
 * `sliceDiskTruthDesignTargetRefusals` opens with `if (design.status === "approved") return []`
 * and then refuses on a union of three signals, none of which a target that is PRESENT but
 * `draft` trips: `orphanedDesignArtifacts` was scoped to `status === "missing"` (a draft HAS a
 * meta), the whole-game verdict is absent on a slice-planned project that never ran one, and
 * STATE is one hand-edit away. So the certificate a DELETION could not buy was available for a
 * DOWNGRADE, with nothing deleted at all.
 *
 * BEFORE, one fixture, two hand-edits:
 *
 *   [B2 control: approved target, no review]              exit 1  (hero-shot-fidelity REFUSE)
 *   [B2 target DOWNGRADED to "draft", STATE untouched]    exit 1
 *   [B2 ATTACK: + `designTarget` key removed from STATE]  exit 0  "hero-shot faithful"
 *
 * The first cut's own false-failure test asserted `draft.code === 0`, so the escape hatch shipped
 * as an assertion rather than as an oversight. That test is corrected below: what it was really
 * protecting is a project MID-AUTHORING (a draft that was never approved), and that case is
 * still green.
 *
 * THE RULE ADDED IS ABOUT THE TRANSITION, not a list of bad statuses: any evidence that this
 * target was EVER approved refuses a target that is not approved NOW, whichever non-approved
 * word is in the file. Three new signals carry it, and the meta's OWN `approvedAt` is the one
 * that makes a downgrade self-refuting.
 *
 * LITMUS, run 2026-08-13. The three new claim rows removed from
 * `designTargetApprovalClaims` (leaving the original three), rebuilt, re-run:
 *
 *   ✖ MOAT (B2): a DOWNGRADED design target refuses exactly as a deleted one does (10.386458ms)
 *     AssertionError [ERR_ASSERTION]: a target downgraded to `draft` with STATE scrubbed must not certify
 *
 *     0 !== 1
 *
 *   ℹ pass 84
 *   ℹ fail 1
 *
 * Restored: 85 pass, 0 fail.
 */
test("MOAT (B2): a DOWNGRADED design target refuses exactly as a deleted one does", async () => {
  const { root, paths } = await certifyingSliceProject({ approveDesignTarget: true });
  try {
    const metaPath = designPaths(paths).meta;

    // CONTROL: an approved target with no review owes a fidelity review and refuses.
    const approved = await captureDonenessOutput(root);
    assert.equal(approved.code, 1, "an approved target with no review must refuse");
    assert.match(approved.text, /hero-shot-fidelity: REFUSE/);

    // ATTACK STEP 1: downgrade the status. Nothing is deleted; `approvedAt` is still in the file.
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    assert.equal(meta.status, "approved");
    assert.ok(typeof meta.approvedAt === "string" && meta.approvedAt.length > 0);
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, status: "draft" }, null, 2), "utf-8");
    const downgraded = await captureDonenessOutput(root);
    assert.equal(downgraded.code, 1, "STATE still says approved, so this must refuse");

    // ATTACK STEP 2: scrub STATE's record too. This is where the certificate used to be issued.
    const state = (await readState(paths))!;
    const scrubbedState = { ...state };
    delete (scrubbedState as { designTarget?: unknown }).designTarget;
    await writeState(paths, scrubbedState);
    const scrubbed = await captureDonenessOutput(root);
    assert.equal(scrubbed.code, 1, "a target downgraded to `draft` with STATE scrubbed must not certify");
    assert.match(scrubbed.text, /hero-shot-fidelity: REFUSE/);
    assert.match(scrubbed.text, /the on-disk Design Target is `draft`/);
    assert.match(scrubbed.text, /records its own approval/);

    // ATTACK STEP 3: put a NON-approved word back in STATE, so the "no record at all" signal is
    // quiet too. The meta's own approval timestamp is what refuses now.
    await writeState(paths, { ...scrubbedState, designTarget: "draft" });
    const restated = await captureDonenessOutput(root);
    assert.equal(restated.code, 1, "renaming the STATE record must not buy the certificate either");
    assert.match(restated.text, /records its own approval/);

    // ATTACK STEP 4: delete `approvedAt` from the meta as well. The per-slice verdict, which the
    // roll-up cannot do without (delete it and the slice is not done), recorded the target's
    // status at grade time and still says `approved`.
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, status: "draft", approvedAt: null }, null, 2), "utf-8");
    const stripped = await captureDonenessOutput(root);
    assert.equal(stripped.code, 1, "the slice verdict's own claim is the fourth independent signal");
    assert.match(stripped.text, /slice verdict/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * C2: SHRINKING THE SLICE'S GATE LIST COST NOTHING ON THE DOOR THAT PRINTS THE CERTIFICATE.
 *
 * C bound `slice.proof.captureManifest` to `slice.acceptance.gates`, which is the right
 * denominator, and the note it shipped with said an attacker who shrinks the gate list pays for
 * it in "the gate coverage the roll-up separately grades". On the DONENESS path that price was
 * zero: `contractCoverageRefusals` lives in `slice-rollup.ts`, under `verify --rollup`, and
 * `evaluateSliceDoneness` never called it. So the pair (gates, captureManifest) could be shrunk
 * TOGETHER, stayed self-consistent, and the contract on disk, untouched, still declared the
 * content nothing was walking any more.
 *
 * BEFORE, one project with a real `ACCEPTANCE.json` declaring `manifest.elements`:
 *
 *   [C2 control: gates ["manifest"], captures present]         exit 0
 *   [C2 captures deleted, manifest intact]                     exit 1   <- the honest refusal
 *   [C2 ATTACK: gates+captureManifest shrunk, contract INTACT] exit 0   <- capture files gone,
 *                                                                         certificate issued
 *
 * The C false-failure fixture (gates `["asset-source-fidelity"]`, `captureManifest: []`, which
 * certifies) IS this attack minus the deletion; what makes it honest there is that it has no
 * contract declaring anything, which is exactly the difference this refusal reads.
 *
 * THE BOUND ADDED IS RECOMPUTABLE: the expected gate coverage is derived from `ACCEPTANCE.json`,
 * the artifact whose CONTENTS ARE the grading, by the same `contractCoverageRefusals` the verify
 * door uses. An attacker who wants the gate list to owe less must delete the contract section
 * that asks for it, and the contract is not a claim about the run: it is the specification the
 * run is measured against, and doneness already refuses a contract whose genre disagrees with the
 * roadmap.
 *
 * LITMUS, run 2026-08-13. The `contractCoverageRefusals` block removed from
 * `evaluateSliceDoneness`, rebuilt, re-run:
 *
 *   ✖ MOAT (C2): shrinking a slice's gate list must cost the contract coverage it stops walking (12.146583ms)
 *     AssertionError [ERR_ASSERTION]: shrinking gates + manifest together must not buy the certificate
 *
 *     0 !== 1
 *
 *   ℹ pass 84
 *   ℹ fail 1
 *
 * Restored: 85 pass, 0 fail.
 */
test("MOAT (C2): shrinking a slice's gate list must cost the contract coverage it stops walking", async () => {
  const { root, paths, slice } = await certifyingSliceProject();
  try {
    // A REAL contract section that declares content, and a slice whose gate list walks it.
    await fs.writeFile(
      paths.acceptance,
      JSON.stringify({ manifest: { elements: [{ id: "player", kind: "sprite" }] } }, null, 2),
      "utf-8",
    );
    assert.deepEqual(slice.acceptance.gates, ["manifest"], "the fixture slice must walk the declared section");
    assert.equal(await runDoneness({ root }), 0, "a covered contract must still certify");

    // THE HONEST REFUSAL the attack exists to get around: the declared captures are gone.
    const declared = slice.proof!.captureManifest!;
    assert.ok(declared.length > 0);
    for (const entry of declared) await fs.rm(path.join(paths.verifyInputs, entry));
    const missing = await captureDonenessOutput(root);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /missing slice captureManifest entries/);

    // THE ATTACK: shrink the gate list to one that owes no captures, and shrink the manifest
    // with it, so the two stay self-consistent and C's re-derivation is satisfied. The capture
    // files stay deleted and `ACCEPTANCE.json` is not touched.
    const shrunk: SliceEntry = {
      ...slice,
      acceptance: { gates: ["asset-source-fidelity"] },
      proof: { ...slice.proof!, captureManifest: [] },
    };
    assert.deepEqual(deriveSliceCaptureManifest(shrunk), [], "the shrunken pair must be self-consistent");
    await writeSlicePlan(paths, planOf([shrunk]));
    const attacked = await captureDonenessOutput(root);
    assert.equal(attacked.code, 1, "shrinking gates + manifest together must not buy the certificate");
    assert.match(attacked.text, /contract section `manifest` declares 1 required scene element\(s\)/);
    assert.match(attacked.text, /NO gate in the plan walks it/);

    // AND THE CONTROL BACK: restore the honest gate list and the captures, and it certifies.
    await writeSlicePlan(paths, planOf([slice]));
    for (const entry of declared) {
      const abs = path.join(paths.verifyInputs, entry);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "{}", "utf-8");
    }
    assert.equal(await runDoneness({ root }), 0, "the honest project must go green again");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("C2 false-failure check: a contract that declares nothing, and a slice whose gates genuinely owe no captures, both certify", async () => {
  // The coverage refusal reads sections that DECLARE required content. A contract with an EMPTY
  // or absent section declares nothing and must stay silent, or every project whose genre does
  // not use a section goes permanently red, and a refusal that gets relaxed later is how the
  // hole comes back.
  const { root, paths } = await certifyingSliceProject();
  try {
    assert.equal(await runDoneness({ root }), 0, "no contract at all is no claim");
    await fs.writeFile(
      paths.acceptance,
      JSON.stringify({ manifest: { elements: [] }, hud: {}, audio: { cues: [] } }, null, 2),
      "utf-8",
    );
    const empty = await captureDonenessOutput(root);
    assert.equal(empty.code, 0, "empty sections declare nothing, so nothing is uncovered");
    assert.doesNotMatch(empty.text, /NO gate in the plan walks it/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
