import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setDesignTarget } from "../loomtide/design.js";
import { runPlan } from "../loomtide/plan.js";
import { runBuild } from "../loomtide/build.js";
import { runStatus } from "../loomtide/status.js";
import { designStatus } from "../loomtide/design.js";
import { loomtidePaths, readState } from "../loomtide/state.js";
import { computeStatusModel } from "../loomtide/status-model.js";
import { readSlicePlan, writeSlicePlan, type SlicePlan } from "../loomtide/slices.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loomtide-status-"));
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
  assert.equal(await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }), 0);
}

async function statusModel(root: string) {
  const paths = loomtidePaths(root);
  return computeStatusModel({
    paths,
    state: await readState(paths),
    plan: await readSlicePlan(paths),
    design: await designStatus(paths),
  });
}

test("status is read-only on a fresh project and does not create .loomtide", async () => {
  const root = await tmpRoot();
  try {
    assert.equal(await runStatus({ root }), 0);
    await assert.rejects(fs.stat(path.join(root, ".loomtide")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status model reports pending frontier counts and next build command", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const model = await statusModel(root);
    assert.equal(model.counts.total, 9);
    assert.equal(model.counts.pending, 9);
    assert.equal(model.currentSlice?.id, "framing");
    assert.equal(model.nextCommand, "loomtide build");
    assert.deepEqual(model.warnings, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status routes built slice to capture only when deterministic captures are missing", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    assert.equal(await runBuild({ root }), 0);

    let model = await statusModel(root);
    assert.equal(model.currentSlice?.id, "framing");
    assert.equal(model.currentSlice?.state, "built");
    assert.equal(model.nextCommand, "loomtide capture --slice framing");
    assert.ok(model.warnings.some((w) => /framing: missing capture file/.test(w)));

    await fs.mkdir(path.join(root, ".loomtide", "verify", "framing"), { recursive: true });
    await fs.writeFile(path.join(root, ".loomtide", "verify", "framing", "screen-rects.json"), "{}\n", "utf-8");
    await fs.writeFile(path.join(root, ".loomtide", "verify", "framing", "console.json"), "{}\n", "utf-8");

    model = await statusModel(root);
    assert.equal(model.nextCommand, "loomtide verify --slice framing --strict");
    assert.equal(model.warnings.some((w) => /missing capture file/.test(w)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status routes verified slice to approval flow and reports proof warnings", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loomtidePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "verified",
      proof: {
        runId: "run-framing-test",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/framing.verdict.json",
        captureManifest: ["framing/screen-rects.json", "framing/console.json"],
        checkpointId: null,
        approvedAt: null,
      },
    };
    await writeSlicePlan(paths, plan);

    const model = await statusModel(root);
    assert.equal(model.currentSlice?.id, "framing");
    assert.equal(model.nextCommand, "loomtide plan (approval flow)");
    assert.ok(model.warnings.some((w) => /proof.checkpointId is missing/.test(w)));
    assert.ok(model.warnings.some((w) => /proof verdict file is missing/.test(w)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status echo prioritizes the approval seam over another unblocked slice", async () => {
  const root = await tmpRoot();
  const lines: string[] = [];
  const originalError = console.error;
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loomtidePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "approved",
      proof: {
        runId: "run-framing",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/framing.verdict.json",
        captureManifest: [],
        checkpointId: "framing",
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    plan.slices[1] = {
      ...plan.slices[1]!,
      state: "approved",
      proof: {
        runId: "run-ground",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/ground-tiling.verdict.json",
        captureManifest: [],
        checkpointId: "ground-tiling",
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    plan.slices[2] = {
      ...plan.slices[2]!,
      state: "approved",
      proof: {
        runId: "run-player",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/player-feel.verdict.json",
        captureManifest: [],
        checkpointId: "player-feel",
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    plan.slices[3] = {
      ...plan.slices[3]!,
      state: "verified",
      proof: {
        runId: "run-parallax",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/parallax.verdict.json",
        captureManifest: [],
        checkpointId: "parallax",
      },
    };
    await writeSlicePlan(paths, plan);

    console.error = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    assert.equal(await runStatus({ root }), 0);

    assert.ok(lines.some((line) => /Waiting for approval: parallax/.test(line)), lines.join("\n"));
    assert.ok(!lines.some((line) => /Next unblocked: collectibles/.test(line)), lines.join("\n"));
    assert.ok(
      lines.some((line) => /Next: say "approve parallax" or run \/loomtide:plan to approve and advance\./.test(line)),
      lines.join("\n"),
    );
  } finally {
    console.error = originalError;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status reports stale slices and dirty currentBuild bindings", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loomtidePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "built",
      proof: {
        runId: "run-framing-proof",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loomtide/reports/slices/framing.verdict.json",
        captureManifest: [],
        checkpointId: null,
        approvedAt: null,
      },
    };
    plan.slices[1] = { ...plan.slices[1]!, state: "stale" };
    await writeSlicePlan(paths, plan);

    const state = (await readState(paths))!;
    await fs.writeFile(
      paths.state,
      (await fs.readFile(paths.state, "utf-8")).replace(
        /<!-- loomtide-state: .* -->/,
        `<!-- loomtide-state: ${JSON.stringify({
          ...state,
          currentBuild: { runId: "run-different", startedAt: "2026-01-01T00:00:00.000Z" },
        })} -->`,
      ),
      "utf-8",
    );

    const model = await statusModel(root);
    assert.ok(model.warnings.some((w) => /Stale slice\(s\): ground-tiling/.test(w)));
    assert.ok(model.warnings.some((w) => /currentBuild.runId run-different does not match any slice proof/.test(w)));
    assert.ok(model.warnings.some((w) => /built proof runId run-framing-proof does not match currentBuild.runId/.test(w)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
