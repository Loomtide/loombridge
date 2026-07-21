/**
 * §3a supervisor REFUSAL paths, end-to-end through the real CLI functions (P3.3).
 *
 * RUN-1 exercised the happy path (doneness=0) but NOT the negative gates the moat
 * depends on. These prove, through runPlan/runBuild/runDoneness (not just the pure
 * predicates), that the supervisor REFUSES when it must:
 *   A10 — a hero shot tampered after approval makes plan AND build refuse.
 *   B2  — a backdated verdict makes doneness refuse (producedAt before startedAt).
 *   B3  — a second build mints a NEW runId; doneness against the old verdict is stale.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../loomtide/plan.js";
import { runBuild } from "../loomtide/build.js";
import { runDoneness } from "../loomtide/doneness.js";
import { setDesignTarget, designPaths } from "../loomtide/design.js";
import { loomtidePaths, readState } from "../loomtide/state.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loomtide-refusal-"));
}

/** Run `fn` while capturing console.error lines (the CLI's refusal reasons). */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const code = await fn();
    return { code, err: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

/** Scaffold a contract + an approved, frozen Design Target so `build` can mint. */
async function plannedAndApproved(root: string): Promise<void> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const img = path.join(root, "src-hero.png");
  await fs.writeFile(img, "hero-pixels-v1", "utf-8");
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
}

// ── A10 — tamper the frozen hero shot after approval ─────────────────────────

test("A10 — tampering the approved hero shot makes plan AND build refuse", async () => {
  const root = await tmpRoot();
  try {
    await plannedAndApproved(root);
    const paths = loomtidePaths(root);

    // Gate is cleared while the frozen bytes are intact.
    assert.equal(
      await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }),
      0,
      "plan passes once the hero shot is approved + frozen",
    );

    // Tamper the frozen PNG after approval.
    await fs.writeFile(designPaths(paths).heroPng, "hero-pixels-v2-EDITED", "utf-8");

    const plan = await captureStderr(() => runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }));
    assert.equal(plan.code, 1, "plan must refuse a tampered frozen target");
    assert.match(plan.err, /CHANGED since approval|frozen hash mismatch/);

    const build = await captureStderr(() => runBuild({ root }));
    assert.equal(build.code, 1, "build must refuse a tampered frozen target");
    assert.match(build.err, /CHANGED since approval/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── B2 — a backdated verdict cannot certify ──────────────────────────────────

test("B2 — doneness refuses a verdict produced BEFORE the build started", async () => {
  const root = await tmpRoot();
  try {
    await plannedAndApproved(root);
    assert.equal(await runBuild({ root }), 0, "build mints currentBuild");
    const paths = loomtidePaths(root);
    const startedAt = (await readState(paths))!.currentBuild!.startedAt;

    // A verdict whose runId matches but was produced before the build started.
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({
        status: "pass",
        runId: (await readState(paths))!.currentBuild!.runId,
        producedAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    const done = await captureStderr(() => runDoneness({ root }));
    assert.equal(done.code, 1, "a backdated verdict must not certify");
    assert.match(done.err, /BEFORE currentBuild\.startedAt/);
    assert.ok(startedAt > "2000-01-01T00:00:00.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── B3 — a second build makes the first build's verdict stale ────────────────

test("B3 — a second build mints a new runId; doneness against the old verdict is stale", async () => {
  const root = await tmpRoot();
  try {
    await plannedAndApproved(root);
    const paths = loomtidePaths(root);

    assert.equal(await runBuild({ root }), 0);
    const run1 = (await readState(paths))!.currentBuild!.runId;

    // A verdict bound to the FIRST build.
    await fs.writeFile(
      paths.verdict,
      JSON.stringify({ status: "pass", runId: run1, producedAt: new Date().toISOString() }),
      "utf-8",
    );

    // A second build mints a fresh runId.
    assert.equal(await runBuild({ root }), 0);
    const run2 = (await readState(paths))!.currentBuild!.runId;
    assert.notEqual(run2, run1, "the second build must mint a NEW runId");

    // The first build's verdict no longer belongs to the current build.
    const done = await captureStderr(() => runDoneness({ root }));
    assert.equal(done.code, 1, "doneness must refuse a verdict from a superseded build");
    assert.match(done.err, /≠ currentBuild\.runId|stale/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
