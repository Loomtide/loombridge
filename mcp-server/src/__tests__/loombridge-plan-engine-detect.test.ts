import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectEngine, run } from "../loombridge/plan.js";
import { setDesignTarget } from "../loombridge/design.js";
import { readSlicePlan } from "../loombridge/slices.js";
import { loombridgePaths } from "../loombridge/state.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-engine-"));
}

/** Drop a Unity project marker so detectEngine resolves "unity". */
async function makeUnityProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(
    path.join(root, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.0f1\n",
    "utf-8",
  );
}

/** Approve a frozen Design Target so the §3c gate passes (design-approved). */
async function approveDesignTarget(root: string): Promise<void> {
  const img = path.join(root, "src-hero.png");
  await fs.writeFile(img, "hero-pixels-v1", "utf-8");
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
}

/** Run the CLI `run([...])` path capturing console.error output + exit code. */
async function runCli(args: string[]): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const code = await run(args);
    return { code, err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

// ── pure detectEngine ─────────────────────────────────────────────────────────

test("detectEngine — Unity marker → unity", async () => {
  const root = await tmpRoot();
  try {
    await makeUnityProject(root);
    assert.deepEqual(detectEngine(root), { engine: "unity" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detectEngine — project.godot → godot", async () => {
  const root = await tmpRoot();
  try {
    await fs.writeFile(path.join(root, "project.godot"), "[application]\n", "utf-8");
    assert.deepEqual(detectEngine(root), { engine: "godot" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detectEngine — *.uproject → unreal", async () => {
  const root = await tmpRoot();
  try {
    await fs.writeFile(path.join(root, "MyGame.uproject"), "{}", "utf-8");
    assert.deepEqual(detectEngine(root), { engine: "unreal" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detectEngine — empty dir → not detected", async () => {
  const root = await tmpRoot();
  try {
    const result = detectEngine(root);
    assert.equal(result.engine, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── CLI run() resolution (parse/detect layer) ─────────────────────────────────

test("run — engine omitted + Unity project → detects unity (note printed), proceeds", async () => {
  const root = await tmpRoot();
  try {
    await makeUnityProject(root);
    await approveDesignTarget(root);
    // No --engine; detection should pick unity and the plan should run (and,
    // design approved, scaffold the roadmap + announce the first slice).
    const { code, err } = await runCli(["--root", root]);
    assert.equal(code, 0);
    assert.match(err, /detected engine: unity/);
    assert.match(err, /scaffolded roadmap: 9 slices/);
    assert.match(err, /Plan next slice: framing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("run — engine omitted + Godot project → exit 2, Unity only", async () => {
  const root = await tmpRoot();
  try {
    await fs.writeFile(path.join(root, "project.godot"), "[application]\n", "utf-8");
    const { code, err } = await runCli(["--root", root]);
    assert.equal(code, 2);
    assert.match(err, /detected godot, but Loombridge currently supports Unity only/);
    // Detection error happens before any scaffold work.
    assert.equal(await readSlicePlan(loombridgePaths(root)), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("run — engine omitted + empty dir → exit 2, could not detect", async () => {
  const root = await tmpRoot();
  try {
    const { code, err } = await runCli(["--root", root]);
    assert.equal(code, 2);
    assert.match(err, /could not detect a game engine project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("run — explicit --engine unity skips detection, works regardless of project files", async () => {
  const root = await tmpRoot();
  try {
    // No Unity marker at all — an explicit engine must NOT trigger detection.
    await approveDesignTarget(root);
    const { code, err } = await runCli(["--root", root, "--engine", "unity"]);
    assert.equal(code, 0);
    assert.doesNotMatch(err, /detected engine/);
    assert.doesNotMatch(err, /could not detect/);
    assert.match(err, /scaffolded roadmap: 9 slices/);
    assert.match(err, /Plan next slice: framing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("run — explicit --engine godot exits 2 and writes no scaffold", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    const { code, err } = await runCli([
      "--root", root,
      "--engine", "godot",
      "--allow-missing-design-target",
    ]);
    assert.equal(code, 2);
    assert.match(err, /--engine godot is not supported; Loombridge currently supports Unity only/);
    assert.equal(await readSlicePlan(paths), null);
    await assert.rejects(fs.stat(paths.state), /ENOENT/);
    await assert.rejects(fs.stat(paths.acceptance), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
