import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setDesignTarget } from "../../../../capabilities/verification/design.js";
import { runPlan } from "../../../../capabilities/verification/plan.js";
import { runBuild } from "../../../../capabilities/verification/build.js";
import { runStatus } from "../../../../capabilities/verification/status.js";
import { designStatus } from "../../../../capabilities/verification/design.js";
import { loombridgePaths, readState } from "../../../../domain/state.js";
import { computeStatusModel, developerNextAction } from "../../../../capabilities/verification/status-model.js";
import { readSlicePlan, writeSlicePlan, type SlicePlan } from "../../../../capabilities/verification/slices.js";
import { writeApprovedAssetManifestForDesign } from "../../../helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-status-"));
}

async function fakeImage(dir: string): Promise<string> {
  const p = path.join(dir, "src-hero.png");
  await fs.writeFile(p, "hero", "utf-8");
  return p;
}

async function scaffoldApprovedRoadmap(root: string): Promise<void> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", kind: "rendered-unity-frame", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  assert.equal(await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }), 0);
}

async function statusModel(root: string) {
  const paths = loombridgePaths(root);
  return computeStatusModel({
    paths,
    state: await readState(paths),
    plan: await readSlicePlan(paths),
    design: await designStatus(paths),
  });
}

test("status is read-only on a fresh project and does not create .loombridge", async () => {
  const root = await tmpRoot();
  try {
    assert.equal(await runStatus({ root }), 0);
    await assert.rejects(fs.stat(path.join(root, ".loombridge")));
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
    assert.equal(model.nextCommand, "loombridge build");
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
    assert.equal(model.nextCommand, "loombridge capture --slice framing");
    assert.ok(model.warnings.some((w) => /framing: missing capture file/.test(w)));

    await fs.mkdir(path.join(root, ".loombridge", "verify", "framing"), { recursive: true });
    await fs.writeFile(path.join(root, ".loombridge", "verify", "framing", "screen-rects.json"), "{}\n", "utf-8");
    await fs.writeFile(path.join(root, ".loombridge", "verify", "framing", "console.json"), "{}\n", "utf-8");

    model = await statusModel(root);
    // No `--strict`: slice verify is strict by DEFAULT now (a warn never exits 0), so
    // carrying the flag in the suggested command would imply the plain form is laxer.
    assert.equal(model.nextCommand, "loombridge verify --slice framing");
    assert.equal(model.warnings.some((w) => /missing capture file/.test(w)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status names the evidence NO capture recipe produces, per slice", async () => {
  // A missing capture file is not one thing: some entries `loombridge capture`
  // will write on the next run and some it will never write. Reporting only
  // "missing capture file(s)" sends a developer back to the same command that
  // cannot fix it, which is the L34/L65 shape at the status surface.
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    const feel = plan.slices.find((s) => s.id === "player-feel")!;
    plan.slices = [
      {
        ...feel,
        dependsOn: [],
        state: "built",
        // `manifest` is the gate whose evidence file no recipe writes; the feel
        // gates' file IS produced now, so this is the slice's remaining gap.
        acceptance: { ...feel.acceptance, gates: [...feel.acceptance.gates, "manifest"] },
        proof: {
          runId: "run-player-feel-test",
          startedAt: "2026-01-01T00:00:00.000Z",
          captureManifest: [
            "player-feel/feel.json",
            "player-feel/console.json",
            "player-feel/verify-manifest.json",
          ],
        },
      },
    ];
    await writeSlicePlan(paths, plan);

    const model = await statusModel(root);
    const capture = model.captures.find((c) => c.sliceId === "player-feel")!;
    // Stage 2: feel.json is PRODUCED now (the feel recipe), so the entry still left
    // to the agent is the one nothing writes: which is exactly what status must name.
    assert.deepEqual(capture.recipes, ["feel"]);
    assert.deepEqual(capture.agentAssemblyRequired, ["verify-manifest.json"]);
    assert.ok(
      model.warnings.some((w) => /player-feel: no CLI capture recipe produces verify-manifest\.json/.test(w)),
      model.warnings.join("\n"),
    );
    assert.ok(
      !model.warnings.some((w) => /produces feel\.json/.test(w)),
      "feel.json has a producer now; status must not still route the developer to hand-author it",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("L32: after a FAILED slice verify, status names the failing gate instead of asking for evidence", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    const sliceId = plan.slices[0]!.id;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "built",
      proof: {
        runId: "run-l32",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: `.loombridge/reports/slices/${sliceId}.verdict.json`,
        captureManifest: [],
        checkpointId: null,
        approvedAt: null,
      },
    };
    await writeSlicePlan(paths, plan);

    // CONTROL: with no verdict on disk, the old "needs evidence" routing is right and
    // must be preserved: status has nothing better to say yet.
    const before = await statusModel(root);
    assert.match(developerNextAction(before), /needs capture\/verify evidence/);

    // The verdict a failed `verify --slice` leaves behind.
    await fs.mkdir(path.join(paths.reports, "slices"), { recursive: true });
    await fs.writeFile(
      path.join(paths.reports, "slices", `${sliceId}.verdict.json`),
      JSON.stringify({ status: "fail", gates: { framing: "fail", "console-clean": "pass" }, checks: [] }, null, 2),
      "utf-8",
    );

    const model = await statusModel(root);
    assert.deepEqual(
      model.gateFailures.map((f) => [f.sliceId, f.failing]),
      [[sliceId, ["framing"]]],
    );
    const next = developerNextAction(model);
    assert.match(next, /gate\(s\) framing FAILED/);
    assert.match(next, /verify --slice/);
    assert.ok(
      !/needs capture\/verify evidence/.test(next),
      "evidence exists and a gate failed: asking for evidence is the L32 defect",
    );
    assert.ok(
      model.warnings.some((w) => w.includes("failing gate(s): framing")),
      model.warnings.join("\n"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status routes verified slice to approval flow and reports proof warnings", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "verified",
      proof: {
        runId: "run-framing-test",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loombridge/reports/slices/framing.verdict.json",
        captureManifest: ["framing/screen-rects.json", "framing/console.json"],
        checkpointId: null,
        approvedAt: null,
      },
    };
    await writeSlicePlan(paths, plan);

    const model = await statusModel(root);
    assert.equal(model.currentSlice?.id, "framing");
    assert.equal(model.nextCommand, "loombridge plan (approval flow)");
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
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "approved",
      proof: {
        runId: "run-framing",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loombridge/reports/slices/framing.verdict.json",
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
        verdictPath: ".loombridge/reports/slices/ground-tiling.verdict.json",
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
        verdictPath: ".loombridge/reports/slices/player-feel.verdict.json",
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
        verdictPath: ".loombridge/reports/slices/parallax.verdict.json",
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
      lines.some((line) => /Next: say "approve parallax" or run \/loombridge:plan to approve and advance\./.test(line)),
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
    const paths = loombridgePaths(root);
    const plan = (await readSlicePlan(paths)) as SlicePlan;
    plan.slices[0] = {
      ...plan.slices[0]!,
      state: "built",
      proof: {
        runId: "run-framing-proof",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdictPath: ".loombridge/reports/slices/framing.verdict.json",
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
        /<!-- loombridge-state: .* -->/,
        `<!-- loombridge-state: ${JSON.stringify({
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
