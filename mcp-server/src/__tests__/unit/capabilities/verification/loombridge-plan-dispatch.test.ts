import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { runBuild } from "../../../../capabilities/verification/build.js";
import { runReopen } from "../../../../capabilities/verification/reopen.js";
import { designStatus, setDesignTarget } from "../../../../capabilities/verification/design.js";
import {
  createDraftAssetManifest,
  readAssetManifest,
  writeAssetManifest,
  type AssetManifestMode,
  type ManifestGeneratedExport,
  type ManifestRegistrySelection,
} from "../../../../capabilities/assets/asset-manifest.js";
import {
  assertValidSlicePlan,
  readSlicePlan,
  writeSlicePlan,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";
import { loombridgePaths, readState, updateState } from "../../../../domain/state.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-dispatch-"));
}

/** A throwaway "image" file (the freeze copies + hashes bytes; not a real PNG). */
async function fakeImage(dir: string, bytes = "hero-pixels-v1"): Promise<string> {
  const p = path.join(dir, "src-hero.png");
  await fs.writeFile(p, bytes, "utf-8");
  return p;
}

/** Approve only the frozen Design Target; leaves ASSET_MANIFEST.json absent. */
async function approveOnlyDesignTarget(root: string): Promise<void> {
  const img = await fakeImage(root);
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
}

function registrySelection(assetId: string): ManifestRegistrySelection {
  return {
    registryAssetId: `fixture.${assetId}`,
    packId: "platformer-2d",
    primitive: "tile",
    license: {
      name: "Creative Commons Zero v1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    source: {
      title: `Fixture ${assetId}`,
      url: "https://example.test/source",
      author: "Fixture",
      provenance: {
        verifiedAt: "2026-06-05",
        origin: "fixture",
        fixture: "loombridge-plan-dispatch",
      },
    },
    provider: {
      name: "Fixture",
      url: "https://example.test/provider",
    },
    placeholder: false,
  };
}

function generatedExport(assetId: string, sourceImageSha256: string): ManifestGeneratedExport {
  return {
    generatedSetId: "generated_set_needed",
    generator: "fixture-generator",
    sourceImageSha256,
    producedAt: "2026-06-05T00:00:00.000Z",
    license: "project-generated",
    provenance: {
      origin: "hero-shot-annotation",
      annotationId: `ann-${assetId}`,
      prompt: `Generate ${assetId}`,
      tool: "test-fixture",
    },
  };
}

/** Approve the Asset Manifest contract so slice roadmap planning can proceed. */
async function approveAssetManifest(root: string, mode: AssetManifestMode = "hybrid"): Promise<void> {
  const paths = loombridgePaths(root);
  const design = await designStatus(paths);
  assert.equal(design.status, "approved");
  assert.ok(design.pngSha256);
  const pngSha256 = design.pngSha256;
  const manifest = createDraftAssetManifest({
    mode,
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: pngSha256 },
  });
  manifest.status = "approved";
  manifest.approvedAt = "2026-06-05T00:00:00.000Z";
  for (const source of manifest.assetSources) source.approved = true;
  manifest.assets = manifest.assets.map((asset, i) => ({
    ...asset,
    status: "approved",
    resolvedPaths: [`Assets/Art/${i}-${asset.id}.png`],
    ...(asset.source === "registry" ? { registrySelection: registrySelection(asset.id) } : {}),
    ...(asset.source === "generated" ? { generatedExport: generatedExport(asset.id, pngSha256) } : {}),
  }));
  await writeAssetManifest(paths, manifest);
}

/** Approve both planning contracts so the §3c + asset-manifest gates pass. */
async function approveDesignTarget(root: string): Promise<void> {
  await approveOnlyDesignTarget(root);
  await approveAssetManifest(root);
}

/**
 * Run `runPlan` while capturing everything it writes to console.error (the echo
 * + dispatch lines all use console.error with the `[loombridge plan]` prefix).
 */
async function runPlanCapture(
  args: Parameters<typeof runPlan>[0],
): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const code = await runPlan(args);
    return { code, err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

const base = { genre: "platformer-2d", engine: "unity", force: false } as const;

// ── design mode (no design target yet) ───────────────────────────────────────

test("design mode — no design target: gate refuses, no roadmap written", async () => {
  const root = await tmpRoot();
  try {
    const { code, err } = await runPlanCapture({ ...base, root });
    assert.notEqual(code, 0, "design gate must refuse without an approved target");
    assert.match(err, /Roadmap: none yet/);
    assert.match(err, /NOT ready/);
    // No SLICES.json mutation in the design-refused path.
    assert.equal(await readSlicePlan(loombridgePaths(root)), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("design mode — --allow-missing-design-target completes (0) but writes no roadmap", async () => {
  const root = await tmpRoot();
  try {
    const { code, err } = await runPlanCapture({
      ...base,
      root,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 0);
    assert.match(err, /WARNING: completing without an approved Design Target/);
    assert.equal(await readSlicePlan(loombridgePaths(root)), null, "no roadmap until design approved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── design → roadmap scaffold transition ─────────────────────────────────────

test("scaffold — design approved but no asset manifest refuses and writes no roadmap", async () => {
  const root = await tmpRoot();
  try {
    await approveOnlyDesignTarget(root);
    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 1);
    assert.match(err, /asset strategy required before slice planning/);
    assert.match(err, /registry/);
    assert.match(err, /generated/);
    assert.match(err, /hybrid/);
    assert.match(err, /no approved ASSET_MANIFEST\.json/);
    assert.equal(await readSlicePlan(loombridgePaths(root)), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scaffold — --asset-mode records the user strategy as a draft manifest but still refuses roadmap", async () => {
  const root = await tmpRoot();
  try {
    await approveOnlyDesignTarget(root);
    const { code, err } = await runPlanCapture({ ...base, root, assetMode: "generated" });
    assert.equal(code, 1);
    assert.match(err, /recorded asset strategy draft: generated/);
    assert.match(err, /ASSET_MANIFEST\.json is draft \(generated\)/);
    assert.equal(await readSlicePlan(loombridgePaths(root)), null);

    const manifest = await readAssetManifest(loombridgePaths(root));
    assert.equal(manifest?.mode, "generated");
    assert.equal(manifest?.status, "draft");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scaffold — design approved + no roadmap + bare plan writes SLICES.json and announces first slice", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 0);
    assert.match(err, /Roadmap: none yet/);
    assert.match(err, /scaffolded roadmap: 9 slices/);
    assert.match(err, /Plan next slice: framing/);
    assert.match(err, /next: review the slice above, then run `loombridge build`/);
    const plan = await readSlicePlan(loombridgePaths(root));
    assert.ok(plan, "bare plan should write SLICES.json once design is approved");
    assert.doesNotThrow(() => assertValidSlicePlan(plan));
    assert.equal(plan!.slices.length, 9);
    assert.ok(plan!.slices.every((s) => s.state === "pending"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scaffold — design approved + --go remains compatible and writes SLICES.json", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const { code, err } = await runPlanCapture({ ...base, root, go: true });
    assert.equal(code, 0);
    assert.match(err, /scaffolded roadmap: 9 slices/);
    const plan = await readSlicePlan(loombridgePaths(root));
    assert.ok(plan, "SLICES.json must exist after --go");
    assert.doesNotThrow(() => assertValidSlicePlan(plan));
    assert.equal(plan!.slices.length, 9);
    assert.ok(plan!.slices.every((s) => s.state === "pending"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scaffold is idempotent — does not clobber an existing roadmap", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    // Seed a roadmap where the first slice is already approved.
    await runPlan({ ...base, root, go: true });
    const seeded = (await readSlicePlan(paths))!;
    seeded.slices[0]!.state = "approved";
    await writeSlicePlan(paths, seeded);

    // Re-running plan (even with --go) must NOT re-scaffold / reset states.
    await runPlan({ ...base, root, go: true });
    const after = (await readSlicePlan(paths))!;
    assert.equal(after.slices[0]!.state, "approved", "existing roadmap must be preserved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── plan-slice mode (roadmap exists, a slice is unblocked) ────────────────────

test("plan-slice mode — announces the next unblocked slice read-only, writes nothing new", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const before = JSON.stringify(await readSlicePlan(paths));

    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 0);
    assert.match(err, /Roadmap: 0\/9 approved/);
    assert.match(err, /Next unblocked: framing/);
    assert.match(err, /Plan next slice: framing/);
    assert.match(err, /loombridge build/);

    const after = JSON.stringify(await readSlicePlan(paths));
    assert.equal(after, before, "plan-slice must not mutate SLICES.json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan-slice mode — bare plan in plan-slice never writes SLICES.json", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const before = JSON.stringify(await readSlicePlan(paths));
    // Even with --go, plan-slice makes no slice mutation in S1b.
    await runPlan({ ...base, root, go: true });
    const after = JSON.stringify(await readSlicePlan(paths));
    assert.equal(after, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── await-approval mode (a slice is built/verified but not approved) ──────────

test("await-approval mode — echoes the approval seam, flips no state", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    plan.slices[0]!.state = "verified"; // framing built+verified, not approved
    await writeSlicePlan(paths, plan);
    const before = JSON.stringify(await readSlicePlan(paths));

    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 0);
    assert.match(err, /Approving framing \(verified ✓\) and advancing — ok\?/);
    assert.match(err, /agent will run the internal approval action/);
    assert.match(err, /Next: say "approve framing" or run \/loombridge:plan to approve and advance\./);

    const after = JSON.stringify(await readSlicePlan(paths));
    assert.equal(after, before, "await-approval must not flip state in S1b");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeSliceDone(root: string, plan: SlicePlan, id: string): Promise<void> {
  const paths = loombridgePaths(root);
  const slice = plan.slices.find((s) => s.id === id)!;
  slice.state = "verified";
  slice.proof = {
    runId: `run-${id}`,
    startedAt: "2026-05-28T00:00:00.000Z",
    verdictPath: `.loombridge/reports/slices/${id}.verdict.json`,
    captureManifest: [`${id}/verify-manifest.json`],
    checkpointId: id,
    approvedAt: null,
  };
  await fs.mkdir(path.join(paths.verifyInputs, id), { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, id, "verify-manifest.json"), "{}", "utf-8");
  const proof = slice.proof;
  assert.ok(proof?.verdictPath);
  const verdictPath = path.join(root, proof.verdictPath);
  await fs.mkdir(path.dirname(verdictPath), { recursive: true });
  await fs.writeFile(
    verdictPath,
    JSON.stringify({ status: "pass", runId: proof.runId, producedAt: "2026-05-28T01:00:00.000Z" }),
    "utf-8",
  );
}

test("await-approval mode — --go approves a verified+done slice and advances", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    await makeSliceDone(root, plan, "framing");
    await writeSlicePlan(paths, plan);

    const { code, err } = await runPlanCapture({ ...base, root, go: true });
    assert.equal(code, 0);
    assert.match(err, /approved: framing/);
    assert.match(err, /Next unblocked: ground-tiling/);
    assert.match(err, /Next: run \/loombridge:build or say continue\./);

    const after = (await readSlicePlan(paths))!;
    const framing = after.slices.find((s) => s.id === "framing")!;
    assert.equal(framing.state, "approved");
    assert.ok(framing.proof?.approvedAt);
    assert.equal(framing.proof?.approvalNote, undefined);
    assert.equal(framing.proof?.signoffArtifact, undefined);
    assert.equal(framing.proof?.signoffSha256, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("await-approval mode — final --go clears currentBuild after all slices approved", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    for (const slice of plan.slices.slice(0, -1)) {
      slice.state = "approved";
      slice.proof = {
        runId: `run-${slice.id}`,
        startedAt: "2026-05-28T00:00:00.000Z",
        verdictPath: `.loombridge/reports/slices/${slice.id}.verdict.json`,
        captureManifest: [],
        checkpointId: slice.id,
        approvedAt: "2026-05-28T02:00:00.000Z",
      };
    }
    const last = plan.slices.at(-1)!;
    await makeSliceDone(root, plan, last.id);
    await writeSlicePlan(paths, plan);
    await updateState(paths, {
      phase: "verified-green",
      currentBuild: { runId: `run-${last.id}`, startedAt: "2026-05-28T00:00:00.000Z" },
    });

    const { code, err } = await runPlanCapture({ ...base, root, go: true });
    assert.equal(code, 0);
    assert.match(err, /next: all approved/);
    assert.equal((await readState(paths))?.currentBuild, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("await-approval mode — --go --note --signoff copies durable artifact and records hash", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    await makeSliceDone(root, plan, "framing");
    await writeSlicePlan(paths, plan);

    const signoffPath = path.join(root, "operator-frame.png");
    const signoffBytes = Buffer.from("operator-approved-no-visible-ground-seams");
    await fs.writeFile(signoffPath, signoffBytes);

    const { code, err } = await runPlanCapture({
      ...base,
      root,
      go: true,
      note: "No visible repeated ground seams in the frozen frame.",
      signoffPath,
    });
    assert.equal(code, 0);
    assert.match(err, /approved: framing/);

    const after = (await readSlicePlan(paths))!;
    const framing = after.slices.find((s) => s.id === "framing")!;
    assert.equal(framing.state, "approved");
    assert.equal(framing.proof?.approvalNote, "No visible repeated ground seams in the frozen frame.");
    assert.equal(framing.proof?.signoffArtifact, ".loombridge/reports/slices/framing/signoff.png");
    const durable = path.join(root, framing.proof!.signoffArtifact!);
    const durableBytes = await fs.readFile(durable);
    assert.deepEqual(durableBytes, signoffBytes);
    assert.equal(
      framing.proof?.signoffSha256,
      createHash("sha256").update(durableBytes).digest("hex"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── B4/R3: a REOPENED slice cannot re-approve without a fresh binding verify ──

test("reopen then plan --go: a reopened slice is not even offered for approval", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    await makeSliceDone(root, plan, "framing");
    await writeSlicePlan(paths, plan);
    assert.equal(await runPlan({ ...base, root, go: true }), 0);
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "approved");

    // Withdraw the approval through the verb.
    assert.equal(await runReopen({ root, sliceId: "framing" }), 0);
    const reopened = (await readSlicePlan(paths))!.slices.find((s) => s.id === "framing")!;
    assert.equal(reopened.state, "stale");

    // `plan --go` now has nothing awaiting approval: a stale slice is a BUILD target, so
    // the approval seam cannot re-approve it off the verdict it was approved on before.
    const { code, err } = await runPlanCapture({ ...base, root, go: true });
    assert.equal(code, 0);
    assert.doesNotMatch(err, /approved: framing/);
    assert.match(err, /Plan next slice: framing|Next unblocked: framing/);
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "stale", "still stale after --go");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen then a forged `verified` state is REFUSED: cleared checkpointId, then the runId binding", async () => {
  // The adversarial path the artifact-clearing exists for: after a reopen, hand-edit the
  // state back to `verified` and run the approval seam against the OLD verdict.
  //
  // Two independent doors must hold, and this test walks through the first to reach the
  // second (a LITMUS that neither is redundant): the cleared `checkpointId` refuses first;
  // forge that too, rebuild (which mints a new runId), and the run binding refuses because
  // the verdict on disk was produced under the previous run.
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const seeded = (await readSlicePlan(paths))!;
    await makeSliceDone(root, seeded, "framing");
    await writeSlicePlan(paths, seeded);
    assert.equal(await runPlan({ ...base, root, go: true }), 0);
    assert.equal(await runReopen({ root, sliceId: "framing" }), 0);

    // Forge #1: state back to `verified`, everything else as the reopen left it.
    const forged = (await readSlicePlan(paths))!;
    forged.slices[0]!.state = "verified";
    await writeSlicePlan(paths, forged);
    const first = await runPlanCapture({ ...base, root, go: true });
    assert.equal(first.code, 1, "approval must be refused");
    assert.match(first.err, /framing: NOT approved.*proof\.checkpointId is missing/);
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "verified", "no approval was granted");

    // Forge #2: put the checkpoint back too, and rebuild the slice so a REAL new run is in
    // flight. The verdict still on disk was minted under `run-framing`.
    const reset = (await readSlicePlan(paths))!;
    reset.slices[0]!.state = "stale"; // undo forge #1 so `build` can take the slice
    await writeSlicePlan(paths, reset);
    assert.equal(await runBuild({ root }), 0);
    const rebuilt = (await readSlicePlan(paths))!;
    const framing = rebuilt.slices.find((s) => s.id === "framing")!;
    framing.state = "verified";
    framing.proof = { ...framing.proof, checkpointId: "framing" };
    await writeSlicePlan(paths, rebuilt);

    const second = await runPlanCapture({ ...base, root, go: true });
    assert.equal(second.code, 1, "a verdict from the pre-reopen run cannot approve the new one");
    assert.match(second.err, /verdict\.runId `run-framing` != slice\.proof\.runId `run-framing-/);
    assert.notEqual((await readSlicePlan(paths))!.slices.find((s) => s.id === "framing")!.state, "approved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("await-approval mode — --go --signoff refuses a missing file", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    await makeSliceDone(root, plan, "framing");
    await writeSlicePlan(paths, plan);

    const { code, err } = await runPlanCapture({
      ...base,
      root,
      go: true,
      signoffPath: path.join(root, "missing.png"),
    });
    assert.equal(code, 1);
    assert.match(err, /--signoff file not found/);

    const after = (await readSlicePlan(paths))!;
    const framing = after.slices.find((s) => s.id === "framing")!;
    assert.equal(framing.state, "verified");
    assert.equal(framing.proof?.approvedAt, null);
    assert.equal(framing.proof?.signoffArtifact, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("await-approval mode — --go refuses built-not-verified and verified-not-done slices", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    plan.slices[0]!.state = "built";
    plan.slices[0]!.proof = {
      runId: "run-framing",
      startedAt: "2026-05-28T00:00:00.000Z",
      verdictPath: ".loombridge/reports/slices/framing.verdict.json",
      captureManifest: [],
      checkpointId: null,
      approvedAt: null,
    };
    await writeSlicePlan(paths, plan);

    let result = await runPlanCapture({ ...base, root, go: true });
    assert.equal(result.code, 1);
    assert.match(result.err, /verify it first/);
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "built");

    const verified = (await readSlicePlan(paths))!;
    verified.slices[0]!.state = "verified";
    verified.slices[0]!.proof = {
      ...verified.slices[0]!.proof!,
      checkpointId: "framing",
    };
    await writeSlicePlan(paths, verified);

    result = await runPlanCapture({ ...base, root, go: true });
    assert.equal(result.code, 1);
    assert.match(result.err, /doneness refused|no verdict/);
    assert.equal((await readSlicePlan(paths))!.slices[0]!.state, "verified");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── all-approved mode (every slice approved) ──────────────────────────────────

test("all-approved mode — reports completion, mutates nothing", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    for (const s of plan.slices) s.state = "approved";
    await writeSlicePlan(paths, plan);
    const before = JSON.stringify(await readSlicePlan(paths));

    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 0);
    assert.match(err, /All 9 slices approved/);
    assert.match(err, /Roadmap: 9\/9 approved/);

    const after = JSON.stringify(await readSlicePlan(paths));
    assert.equal(after, before, "all-approved must mutate nothing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all-approved mode — clears stale currentBuild from older approval flows", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    const paths = loombridgePaths(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(paths))!;
    for (const s of plan.slices) s.state = "approved";
    await writeSlicePlan(paths, plan);
    await updateState(paths, {
      phase: "verified-green",
      currentBuild: { runId: "run-old-final-slice", startedAt: "2026-05-28T00:00:00.000Z" },
    });

    const { code, err } = await runPlanCapture({ ...base, root });
    assert.equal(code, 0);
    assert.match(err, /All 9 slices approved/);
    assert.equal((await readState(paths))?.currentBuild, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── template loading (src path, schema-valid) ─────────────────────────────────

test("slice template — loaded by the scaffold path passes assertValidSlicePlan", async () => {
  const root = await tmpRoot();
  try {
    await approveDesignTarget(root);
    await runPlan({ ...base, root, go: true });
    const plan = (await readSlicePlan(loombridgePaths(root))) as SlicePlan;
    assert.doesNotThrow(() => assertValidSlicePlan(plan));
    assert.equal(plan.genre, "platformer-2d");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
