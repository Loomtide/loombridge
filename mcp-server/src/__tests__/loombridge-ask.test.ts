import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../cli.js";
import { runBuild } from "../capabilities/verification/build.js";
import { setDesignTarget } from "../capabilities/verification/design.js";
import { run, runAsk } from "../capabilities/verification/ask.js";
import { runPlan } from "../capabilities/verification/plan.js";
import { loombridgePaths } from "../domain/state.js";
import { readSlicePlan, writeSlicePlan, type SlicePlan } from "../capabilities/verification/slices.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-ask-"));
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

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    const code = await fn();
    return { code, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("ask is read-only on a fresh project and does not create .loombridge", async () => {
  const root = await tmpRoot();
  try {
    const { code, output } = await captureStdout(() => runAsk({ root }));
    assert.equal(code, 0);
    assert.match(output, /No slice roadmap exists yet/);
    await assert.rejects(fs.stat(path.join(root, ".loombridge")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask where are we mirrors compact progress", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const { code, output } = await captureStdout(() => runAsk({ root, question: "where are we" }));
    assert.equal(code, 0);
    assert.match(output, /^Progress: 0\/9 slices approved\./m);
    assert.match(output, /^Current: framing \(pending\) — Frame the level \(camera, aspect, player anchor\)\./m);
    assert.match(output, /^Next: run \/loombridge:build or say continue\./m);
    assert.doesNotMatch(output, /Gates:/);
    assert.doesNotMatch(output, /pending=|built=|verified=|stale=/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask what next returns the status model next action", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    assert.equal(await runBuild({ root }), 0);
    const { output } = await captureStdout(() => runAsk({ root, question: "what should I do next" }));
    assert.match(output, /Next: framing needs capture\/verify evidence; run \/loombridge:build or say continue\./);
    assert.match(output, /Reason: the current slice is built but still needs evidence/);
    assert.doesNotMatch(output, /--slice/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask why approval explains approval without exposing --go", async () => {
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
        captureManifest: [],
        checkpointId: "framing",
      },
    };
    await writeSlicePlan(paths, plan);

    const { output } = await captureStdout(() => runAsk({ root, question: "why approval" }));
    assert.match(output, /Waiting for approval: framing/);
    assert.match(output, /human checkpoint/);
    assert.match(output, /Next: say "approve framing" or run \/loombridge:plan to approve and advance\./);
    assert.doesNotMatch(output, /--go/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask current slice includes id, title, gates, skill, and dependencies", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const { output } = await captureStdout(() => runAsk({ root, question: "current slice" }));
    assert.match(output, /Current slice: framing \(pending\) — Frame the level/);
    assert.match(output, /Skill: platformer-level-design/);
    assert.match(output, /Gates: framing, console-clean/);
    assert.match(output, /Dependencies: none/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask warnings surfaces proof and capture warnings", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    assert.equal(await runBuild({ root }), 0);
    const { output } = await captureStdout(() => runAsk({ root, question: "warnings" }));
    assert.match(output, /Blocked or risky:/);
    assert.match(output, /framing: missing capture file\(s\): framing\/screen-rects\.json, framing\/console\.json/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ask --root without value is refused instead of falling back to cwd", async () => {
  const { code, output } = await captureStdout(() => run(["--root"]));
  assert.equal(code, 2);
  assert.match(output, /Usage: loombridge ask/);
});

test("CLI dispatcher routes ask", async () => {
  const root = await tmpRoot();
  try {
    await scaffoldApprovedRoadmap(root);
    const { code, output } = await captureStdout(() =>
      loombridgeCli(["node", "cli", "ask", "--root", root, "where", "are", "we"]),
    );
    assert.equal(code, 0);
    assert.match(output, /Progress: 0\/9 slices approved/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
