import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveCaptureManifest,
  deriveSliceCaptureManifest,
  evaluateBuildReadiness,
  mintSliceRunId,
  mintRunId,
  runBuild,
} from "../capabilities/verification/build.js";
import { HERO_SHOT_FIDELITY_CRITERIA, runDoneness } from "../capabilities/verification/doneness.js";
import { runPlan } from "../capabilities/verification/plan.js";
import { runVerify } from "../capabilities/verification/verify.js";
import { setDesignTarget } from "../capabilities/verification/design.js";
import { loombridgePaths, readState } from "../domain/state.js";
import { readSlicePlan, writeSlicePlan, type SlicePlan } from "../capabilities/verification/slices.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-build-"));
}

async function fakeImage(dir: string): Promise<string> {
  const p = path.join(dir, "src-hero.png");
  await fs.writeFile(p, "hero", "utf-8");
  return p;
}

async function scaffoldApprovedRoadmap(root: string): Promise<void> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  assert.equal(await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, go: true }), 0);
}

function approveSlice(plan: SlicePlan, id: string): void {
  const slice = plan.slices.find((s) => s.id === id);
  assert.ok(slice, `missing slice ${id}`);
  slice.state = "approved";
  slice.proof = {
    runId: `run-${id}-old`,
    startedAt: "2026-01-01T00:00:00.000Z",
    verdictPath: `.loombridge/reports/slices/${id}.verdict.json`,
    captureManifest: [],
    checkpointId: id,
    approvedAt: "2026-01-01T00:00:01.000Z",
  };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test("mintRunId returns unique ids and starts with `run-`", () => {
  const a = mintRunId();
  const b = mintRunId();
  assert.match(a, /^run-/);
  assert.match(b, /^run-/);
  assert.notEqual(a, b, "two mints should differ");
});

test("mintSliceRunId returns unique slice-scoped ids", () => {
  const a = mintSliceRunId("ground-tiling");
  const b = mintSliceRunId("ground-tiling");
  assert.match(a, /^run-ground-tiling-/);
  assert.match(b, /^run-ground-tiling-/);
  assert.notEqual(a, b);
});

test("deriveCaptureManifest prefixes bare filenames with state name; preserves nested paths", () => {
  const manifest = deriveCaptureManifest({
    states: [
      { name: "spawn", requiredCaptures: ["manifest.json", "screen-rects.json"] },
      { name: "win", requiredCaptures: ["win/final-frame.json"] },
    ],
  });
  assert.deepEqual(manifest, [
    "spawn/manifest.json",
    "spawn/screen-rects.json",
    "win/final-frame.json",
  ]);
});

test("deriveCaptureManifest returns [] when capturePack is absent", () => {
  assert.deepEqual(deriveCaptureManifest(undefined), []);
});

test("deriveCaptureManifest throws on a hand-constructed escape (defense in depth)", () => {
  // A pack that bypassed the validator — e.g. directly authored in code — must
  // still be refused by the minter.
  assert.throws(
    () =>
      deriveCaptureManifest({
        states: [{ name: "spawn", requiredCaptures: ["../reports/build-verdict.json"] }],
      }),
    /unsafe capture path/,
  );
  // Same when the state name would escape (e.g. ".."): rejected by validator,
  // but if someone slips it through, deriveCaptureManifest refuses.
  assert.throws(
    () =>
      deriveCaptureManifest({
        states: [{ name: "..", requiredCaptures: ["manifest.json"] }],
      }),
    /unsafe capture path/,
  );
});

test("deriveSliceCaptureManifest prefixes gate input files with the slice id", () => {
  const manifest = deriveSliceCaptureManifest({
    id: "framing",
    title: "Frame",
    dependsOn: [],
    skill: "platformer-level-design",
    feelIntent: "frame it",
    acceptance: { gates: ["framing", "console-clean", "frame-integrity"] },
    state: "pending",
  });
  assert.deepEqual(manifest, ["framing/screen-rects.json", "framing/console.json"]);
});

// ── evaluateBuildReadiness (pure gate) ───────────────────────────────────────

test("evaluateBuildReadiness blocks without a contract", () => {
  const r = evaluateBuildReadiness({
    hasContract: false,
    designReady: true,
    designStatusName: "approved",
    assetManifestReady: true,
    allowUngroundedPrototype: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((m) => /ACCEPTANCE/.test(m)));
});

test("evaluateBuildReadiness blocks without an approved Design Target (default)", () => {
  const r = evaluateBuildReadiness({
    hasContract: true,
    designReady: false,
    designStatusName: "missing",
    assetManifestReady: true,
    allowUngroundedPrototype: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((m) => /Design Target/.test(m)));
});

test("evaluateBuildReadiness — escape hatch converts the blocker into a warning", () => {
  const r = evaluateBuildReadiness({
    hasContract: true,
    designReady: false,
    designStatusName: "missing",
    assetManifestReady: false,
    assetManifestReason: "no approved ASSET_MANIFEST.json",
    allowUngroundedPrototype: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((m) => /ungrounded/.test(m)));
});

test("evaluateBuildReadiness — approved-but-drifted target is named in the diagnostic", () => {
  const r = evaluateBuildReadiness({
    hasContract: true,
    designReady: false,
    designStatusName: "approved",
    assetManifestReady: true,
    allowUngroundedPrototype: false,
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.blockers.some((m) => /CHANGED since approval/.test(m)),
    "must call out the frozen-hash mismatch case distinctly",
  );
});

test("evaluateBuildReadiness blocks without an approved Asset Manifest", () => {
  const r = evaluateBuildReadiness({
    hasContract: true,
    designReady: true,
    designStatusName: "approved",
    assetManifestReady: false,
    assetManifestReason: "ASSET_MANIFEST.json is draft, not approved",
    allowUngroundedPrototype: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((m) => /ASSET_MANIFEST\.json is draft/.test(m)));
});

// ── runBuild integration ─────────────────────────────────────────────────────

test("build blocks before plan (no contract, no state mutation)", async () => {
  const root = await tmpRoot();
  const code = await runBuild({ root });
  assert.equal(code, 1);
  // No state file means no currentBuild was minted.
  assert.equal(await readState(loombridgePaths(root)), null);
});

test("build blocks after plan when there is no approved Design Target (default hard gate)", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const code = await runBuild({ root });
  assert.equal(code, 1);
  // No currentBuild written.
  const state = await readState(loombridgePaths(root));
  assert.equal(state?.currentBuild ?? null, null);
});

test("build proceeds with --allow-ungrounded-prototype + tags currentBuild ungrounded", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });

  const code = await runBuild({ root, allowUngroundedPrototype: true });
  assert.equal(code, 0);

  const state = await readState(loombridgePaths(root));
  assert.equal(state?.phase, "built-unverified");
  assert.ok(state?.currentBuild?.runId, "currentBuild was minted");
  assert.equal(state?.currentBuild?.ungrounded, true, "ungrounded flag is sticky on the run");
});

test("build --allow-ungrounded-prototype tags ungrounded when ASSETS are unapproved (design approved) — PR #349 finding 2", async () => {
  const root = await tmpRoot();
  // Design Target IS approved + frozen, but the Asset Manifest is left UNAPPROVED (no writeApprovedAssetManifestForDesign).
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });

  const code = await runBuild({ root, allowUngroundedPrototype: true });
  assert.equal(code, 0, "escaping the asset gate proceeds with --allow-ungrounded-prototype");

  const state = await readState(loombridgePaths(root));
  assert.ok(state?.currentBuild?.runId, "currentBuild was minted");
  assert.equal(
    state?.currentBuild?.ungrounded,
    true,
    "escaping the unapproved-asset hard gate must tag the run ungrounded, not just the design-target gate",
  );
});

test("build mints currentBuild + captureManifest from capturePack after approved target", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);

  const code = await runBuild({ root, intent: "add a coin pickup" });
  assert.equal(code, 0);

  const state = await readState(loombridgePaths(root));
  assert.equal(state?.phase, "built-unverified");
  assert.ok(state?.currentBuild?.runId);
  assert.notEqual(state?.currentBuild?.ungrounded, true, "approved target ⇒ NOT ungrounded");
  // Platformer capturePack ships 4 states × 2 captures = 8 manifest entries.
  assert.equal(state?.currentBuild?.captureManifest?.length, 8);
  assert.ok(state?.currentBuild?.captureManifest?.includes("spawn/spawn/verify-manifest.json") === false);
  assert.ok(
    state?.currentBuild?.captureManifest?.includes("spawn/verify-manifest.json"),
    "spawn/verify-manifest.json must be in the derived manifest",
  );
});

test("build auto-detects SLICES.json and mints proof for nextUnblockedSlice", async () => {
  const root = await tmpRoot();
  await scaffoldApprovedRoadmap(root);

  const paths = loombridgePaths(root);
  const before = (await readSlicePlan(paths))!;
  const expectedManifest = deriveSliceCaptureManifest(before.slices[0]!);
  assert.equal(before.slices[0]!.id, "framing");

  const code = await runBuild({ root });
  assert.equal(code, 0);

  const after = (await readSlicePlan(paths))!;
  const slice = after.slices.find((s) => s.id === "framing")!;
  assert.equal(slice.state, "built");
  assert.ok(slice.proof?.runId);
  assert.ok(slice.proof.runId.startsWith("run-framing-"));
  assert.equal(slice.proof?.checkpointId, null);
  assert.equal(slice.proof?.approvedAt, null);
  assert.equal(slice.proof?.verdictPath, path.join(".loombridge", "reports", "slices", "framing.verdict.json"));
  assert.deepEqual(slice.proof?.captureManifest, expectedManifest);
  assert.equal(after.slices.find((s) => s.id === "ground-tiling")!.state, "pending");
  assert.equal(after.slices.find((s) => s.id === "parallax")!.state, "pending");

  const state = await readState(paths);
  assert.equal(state?.phase, "built-unverified");
  assert.equal(state?.currentBuild?.runId, slice.proof?.runId);
  assert.deepEqual(state?.currentBuild?.captureManifest, expectedManifest);
});

test("build slice mode exits non-zero when no slice is currently buildable", async () => {
  const root = await tmpRoot();
  await scaffoldApprovedRoadmap(root);
  const paths = loombridgePaths(root);
  const plan = (await readSlicePlan(paths))!;
  const first = plan.slices[0]!;
  first.state = "verified";
  first.proof = {
    runId: "run-framing-ready",
    startedAt: "2026-01-01T00:00:00.000Z",
    verdictPath: ".loombridge/reports/slices/framing.verdict.json",
    captureManifest: [],
    checkpointId: "framing",
    approvedAt: null,
  };
  await writeSlicePlan(paths, plan);

  const code = await runBuild({ root });
  assert.equal(code, 1);
  const after = (await readSlicePlan(paths))!;
  assert.equal(after.slices[0]!.state, "verified");
});

test("build keeps per-slice proof isolated when building a later slice", async () => {
  const root = await tmpRoot();
  await scaffoldApprovedRoadmap(root);
  const paths = loombridgePaths(root);
  const plan = (await readSlicePlan(paths))!;
  approveSlice(plan, "framing");
  await writeSlicePlan(paths, plan);
  const framingBefore = JSON.stringify(plan.slices.find((s) => s.id === "framing")!.proof);

  const code = await runBuild({ root });
  assert.equal(code, 0);

  const after = (await readSlicePlan(paths))!;
  assert.equal(after.slices.find((s) => s.id === "ground-tiling")!.state, "built");
  assert.equal(JSON.stringify(after.slices.find((s) => s.id === "framing")!.proof), framingBefore);
});

test("rebuilding an upstream slice invalidates approved transitive dependents", async () => {
  const root = await tmpRoot();
  await scaffoldApprovedRoadmap(root);
  const paths = loombridgePaths(root);
  const plan = (await readSlicePlan(paths))!;
  const framing = plan.slices.find((s) => s.id === "framing")!;
  framing.state = "stale";
  framing.proof = {
    runId: "run-framing-old",
    startedAt: "2026-01-01T00:00:00.000Z",
    verdictPath: ".loombridge/reports/slices/framing.verdict.json",
    captureManifest: [],
    checkpointId: "framing",
    approvedAt: null,
  };
  approveSlice(plan, "ground-tiling");
  approveSlice(plan, "player-feel");
  approveSlice(plan, "parallax");
  await writeSlicePlan(paths, plan);

  const code = await runBuild({ root });
  assert.equal(code, 0);

  const after = (await readSlicePlan(paths))!;
  assert.equal(after.slices.find((s) => s.id === "framing")!.state, "built");
  assert.equal(after.slices.find((s) => s.id === "ground-tiling")!.state, "stale");
  assert.equal(after.slices.find((s) => s.id === "player-feel")!.state, "stale");
  assert.equal(after.slices.find((s) => s.id === "parallax")!.state, "stale");
  assert.equal(after.slices.find((s) => s.id === "hud")!.state, "stale", "transitive dependent invalidated");
});

// ── end-to-end: the supervisor mechanism is now REACHABLE via the CLI ────────

test("end-to-end: plan → build → verify → doneness lights up the §3a supervisor", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const design = await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);

  // build mints currentBuild — no test simulation needed.
  assert.equal(await runBuild({ root }), 0);
  const paths = loombridgePaths(root);
  const state = await readState(paths);
  const runId = state!.currentBuild!.runId;

  // Drop every captureManifest entry as a present file so doneness's capture
  // check passes (content doesn't matter for the manifest-presence check).
  for (const entry of state!.currentBuild!.captureManifest ?? []) {
    const abs = path.join(paths.verifyInputs, entry);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "{}", "utf-8");
  }

  // Hand-author a passing verdict bound to this runId (verify with real gates
  // against empty captures yields warn; the integration here is about the
  // supervisor wiring, so we mint a synthetic pass to exercise the path). For an
  // APPROVED Design Target the verdict must carry the frozen-sha-bound block + an
  // independent faithful hero-shot review + passing asset-source checks — exactly
  // what a real `verify --vlm` produces — or the §P0 hero-shot moat refuses.
  await fs.mkdir(path.dirname(paths.verdict), { recursive: true });
  await fs.writeFile(
    paths.verdict,
    JSON.stringify({
      status: "pass",
      runId,
      producedAt: new Date(Date.now() + 1).toISOString(),
      designTarget: { status: "approved", kind: "rendered-unity-frame", pngSha256: design.pngSha256, frozenMatches: true },
      reviewFindings: {
        reference: { heroShotSha256: design.pngSha256 },
        independence: { independent: true, reviewerCount: 2 },
        frames: [{ id: "spawn", path: "spawn/frames/spawn.png" }],
        criteria: HERO_SHOT_FIDELITY_CRITERIA.map((id) => ({ id, status: "pass", reason: "ok", evidenceFrame: "spawn" })),
        summary: "Independent hero-shot fidelity review complete.",
      },
      checks: [
        { id: "asset-source.manifest-approved", status: "pass", detail: "Asset manifest is approved." },
        { id: "asset-source.binding.player_character", status: "pass", detail: "Manifest asset is approved and path-bound." },
      ],
    }),
    "utf-8",
  );
  // verify writes phase, which we need at verified-green for doneness; simulate
  // by calling runVerify with a non-default outputPath so it doesn't overwrite
  // our synthetic verdict, then patch state's phase via a second runVerify? No
  // — simpler: patch the phase directly to mirror what verify would do on pass.
  // (This is a substrate test for the supervisor wiring, not a full Unity run.)
  const { updateState } = await import("../domain/state.js");
  await updateState(paths, { phase: "verified-green" });

  // Doneness MUST certify now: fresh + green + manifest captures present.
  assert.equal(await runDoneness({ root }), 0, "doneness should certify a fresh+green build");
});

test("end-to-end: an ungrounded build cannot be certified by doneness", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  assert.equal(await runBuild({ root, allowUngroundedPrototype: true }), 0);

  // Even with a perfect synthetic green verdict, ungrounded must refuse.
  const paths = loombridgePaths(root);
  const state = await readState(paths);
  const runId = state!.currentBuild!.runId;
  await fs.mkdir(path.dirname(paths.verdict), { recursive: true });
  await fs.writeFile(
    paths.verdict,
    JSON.stringify({
      status: "pass",
      runId,
      producedAt: new Date(Date.now() + 1).toISOString(),
    }),
    "utf-8",
  );
  const { updateState } = await import("../domain/state.js");
  await updateState(paths, { phase: "verified-green" });

  assert.equal(
    await runDoneness({ root }),
    1,
    "doneness must refuse a run started with --allow-ungrounded-prototype",
  );

  // Silence the noisy test logs by calling runVerify here? No — runVerify
  // wasn't invoked. The point: ungrounded is sticky and end-state-checked.
  void runVerify; // keep the import used
});

test("build SLICE-mode tags currentBuild ungrounded when escaping the unapproved-asset gate (PR #349 finding 2, slice path)", async () => {
  const root = await tmpRoot();
  const genreContractPath = path.join(
    process.cwd(), "src", "capabilities", "genre", "genre-contract", "examples", "2d-shooter.contract.json",
  );
  // --genre-contract promotion WRITES SLICES.json (so `build` takes the slice path) and leaves assets UNAPPROVED —
  // exactly the PR #349 dogfood shape. Design is then approved, so the ONLY escaped hard gate is the asset manifest.
  assert.equal(
    await runPlan({ root, genre: "ignored-when-contract-present", genreContractPath, engine: "unity", force: false, allowMissingDesignTarget: true }),
    0,
  );
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  const paths = loombridgePaths(root);
  assert.ok(await readSlicePlan(paths), "precondition: promotion wrote SLICES.json (slice-build path is taken)");

  const code = await runBuild({ root, allowUngroundedPrototype: true });
  assert.equal(code, 0, "escaping the asset gate proceeds on the slice path");

  const state = await readState(paths);
  assert.ok(state?.currentBuild?.runId, "a slice run was minted");
  assert.equal(
    state?.currentBuild?.ungrounded,
    true,
    "slice-build path must tag ungrounded when the asset gate is escaped (design approved ⇒ pre-fix this was falsely un-tagged)",
  );
});
