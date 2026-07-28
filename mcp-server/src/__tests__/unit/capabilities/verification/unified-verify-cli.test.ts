/**
 * The unified `verify` FRONT DOOR, driven the way a user drives it: through `run(argv)`.
 *
 * These tests are deliberately at the argv level rather than the engine level. The S1
 * risk is not that a gate is wrong (the gates are covered where they live); it is that
 * the new routing quietly turns a run that measured nothing, or measured someone else's
 * project, into an exit 0. So each case asserts the triple that matters together: what
 * the plan SAID, what actually executed, and what the process exited with.
 *
 * Live-only sections (trace replay, feel snapshot) need a running editor, so the two
 * cases that must cover them inject `UnifiedSectionDeps` and call the orchestrator
 * directly. That seam is production code with production defaults; the argv-level tests
 * above and below it pin that the real wiring reaches it.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { run as runVerifyCli, runVerify } from "../../../../capabilities/verification/verify.js";
import { runUnifiedVerify } from "../../../../capabilities/verification/unified/orchestrator.js";
import {
  UNIFIED_SCREENS_REPORT,
  unifiedVerifyReportPath,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import { run as runMinigame } from "../../../../capabilities/minigame/minigame.js";
import { fileExists, loombridgePaths, readState, standardReplayLayout } from "../../../../domain/state.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Run a verb with BOTH streams captured (the plan prints to stderr; nothing may leak). */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  const sink = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  console.error = sink;
  console.log = sink;
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = origError;
    console.log = origLog;
  }
}

async function readUnified(root: string): Promise<UnifiedVerifyReport> {
  const file = unifiedVerifyReportPath(loombridgePaths(root).reports);
  return JSON.parse(await fs.readFile(file, "utf-8")) as UnifiedVerifyReport;
}

/** A planned project. `graded` plants the one captured input that makes a gate really grade. */
async function plannedProject(
  prefix: string,
  opts: { graded?: boolean; assetManifest?: boolean } = {},
): Promise<string> {
  const root = await tmpDir(prefix);
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);
  if (opts.assetManifest) {
    // ASSET_MANIFEST.json is the ONE file `runVerify` copies into the inputs dir before
    // grading, which is what makes the plan-first guard non-vacuous. It also feeds a real
    // gate, so only the plan-first test plants it.
    await fs.writeFile(paths.assetManifest, JSON.stringify({ mode: "placeholder", assets: [] }), "utf-8");
  }
  if (opts.graded) {
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
  }
  return root;
}

// ── trace fixtures (same shape as unified-discovery.test.ts) ─────────────────

/** Plant `<traces>/<id>.trace.json`: a recorded demonstration with NO approved baseline. */
async function plantTrace(root: string, id: string): Promise<void> {
  const layout = standardReplayLayout(root);
  await fs.mkdir(layout.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(layout.replayTraces, `${id}.trace.json`),
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "s", actions: [] }],
      outcome: { expected: "success" },
    }),
  );
}

/** Plant a trace + a replay report, then approve it for real (the verb stamps the manifest). */
async function plantApprovedTrace(root: string, id: string): Promise<void> {
  const layout = standardReplayLayout(root);
  await plantTrace(root, id);
  const actualDir = path.join(layout.replayReports, id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actualPng = path.join(actualDir, "cap.png");
  await fs.writeFile(actualPng, Buffer.from(`frame-${id}`));
  await fs.writeFile(
    path.join(layout.replayReports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
  const approved = await captured(() => runTrace(["approve", "--id", id, "--root", root]));
  assert.equal(approved.result, 0, `approve ${id}:\n${approved.lines.join("\n")}`);
}

// ── screen-contract fixtures (PNG writer as in minigame-baseline.test.ts) ────

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const W = 16;
const H = 12;
function whitePng(): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  let o = 0;
  for (let y = 0; y < H; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < W; x += 1) {
      raw[o++] = 255;
      raw[o++] = 255;
      raw[o++] = 255;
      raw[o++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const BTN_RECT = { x: 2, y: 3, width: 5, height: 6 };

function captureObject(id: string): Record<string, unknown> {
  return {
    id,
    path: `/HUD/${id}`,
    role: "image",
    active: true,
    isVisible: true,
    visibilityReason: null,
    isFullyVisible: true,
    isPartiallyClipped: false,
    isOffScreen: false,
    clipSide: null,
    screenRect: BTN_RECT,
    viewportRect: {
      x: BTN_RECT.x / W,
      y: BTN_RECT.y / H,
      width: BTN_RECT.width / W,
      height: BTN_RECT.height / H,
    },
    canvasScaleFactor: 1,
  };
}

/**
 * A workspace holding a finalized screen contract + a PASSING capture pack, laid out at
 * the DECLARED locations discovery reads (`<ws>/<id>.minigame.json`, `<ws>/captures`,
 * `<ws>/baseline`).
 */
async function screenWorkspace(prefix: string): Promise<{ workspace: string; contractPath: string }> {
  const workspace = await tmpDir(prefix);
  const capturesDir = path.join(workspace, "captures");
  const baselineDir = path.join(workspace, "baseline");
  await fs.mkdir(capturesDir, { recursive: true });
  for (const state of ["active", "win"]) {
    await fs.writeFile(path.join(capturesDir, `${state}.png`), whitePng());
    await fs.writeFile(
      path.join(capturesDir, `${state}.ui-rects.json`),
      JSON.stringify({ state, viewport: { width: W, height: H, aspect: W / H }, objects: [captureObject("btn")] }),
      "utf-8",
    );
    await fs.writeFile(path.join(capturesDir, `${state}.console.json`), JSON.stringify({ errorCount: 0 }), "utf-8");
  }

  const contractPath = path.join(workspace, "screens-game.minigame.json");
  await fs.writeFile(
    contractPath,
    JSON.stringify(
      {
        schemaVersion: "1",
        id: "screens-game",
        type: "2d-kids-minigame",
        scenes: ["Assets/Scenes/S.unity"],
        ageBand: "3-5",
        visualProfile: "phone-landscape",
        requiredInFrame: [{ id: "btn", locator: "S:/HUD/btn" }],
        states: [
          { id: "active", kind: "active", requiredInFrame: ["btn"] },
          { id: "win", kind: "success_reward", requiredInFrame: ["btn"] },
        ],
        uiSafeAreas: { maxOverflowFraction: 0 },
        tapTargets: { minSizeDp: 96 },
        interactionFlow: { happyPath: ["active", "win"] },
        artifactThresholds: {},
        checks: { deterministic: ["required-in-frame"] },
        baseline: { ref: baselineDir },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { workspace, contractPath };
}

async function approveScreens(owningRoot: string, workspace: string, contractPath: string): Promise<void> {
  const approved = await captured(() =>
    runMinigame([
      "baseline",
      "approve",
      "--root",
      owningRoot,
      "--contract",
      contractPath,
      "--captures",
      path.join(workspace, "captures"),
      "--ref",
      path.join(workspace, "baseline"),
    ]),
  );
  assert.equal(approved.result, 0, `baseline approve:\n${approved.lines.join("\n")}`);
}

// ── the on-ramp ──────────────────────────────────────────────────────────────

test("an EMPTY project prints the on-ramp, writes nothing at all, and exits 2", async () => {
  const root = await tmpDir("unified-cli-empty-");
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "a run with nothing to check is never a pass");

    const text = lines.join("\n");
    // The real three-command sequence, in order, and the tail that says what to do after.
    assert.match(text, /loombridge trace record --observe --id <name>/);
    assert.match(text, /loombridge trace replay --id <name>/);
    assert.match(text, /loombridge trace approve --id <name>/);
    assert.match(text, /loombridge verify --live/);
    assert.ok(
      text.indexOf("trace record") < text.indexOf("trace replay")
        && text.indexOf("trace replay") < text.indexOf("trace approve"),
      `the on-ramp must be in pipeline order:\n${text}`,
    );
    // The actors: a HUMAN records; an agent must not be told to do what it cannot.
    assert.match(text, /HUMAN plays/);

    // Nothing was created. A question must not leave state behind as a side effect.
    assert.deepEqual(await fs.readdir(root), [], "the on-ramp must not scaffold .loombridge/");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── the plan prints before anything is written ───────────────────────────────

test("PLAN FIRST: nothing is written to the project before the plan has printed", async () => {
  // The RFC invariant an operator relies on: what you are shown is what WILL happen, not
  // a receipt for what already did. `runVerify` stages ASSET_MANIFEST.json into the
  // inputs dir before grading, so that staged copy is the earliest project write there is.
  const root = await plannedProject("unified-cli-planfirst-", { assetManifest: true });
  const workspace = await tmpDir("unified-cli-ws-");
  const stagedCopy = path.join(loombridgePaths(root).verifyInputs, "asset-manifest.json");
  try {
    let stagedWhenPlanPrinted: boolean | null = null;
    const origError = console.error;
    console.error = (...a: unknown[]): void => {
      const line = a.map(String).join(" ");
      if (stagedWhenPlanPrinted === null && line.includes("plan for ")) {
        stagedWhenPlanPrinted = existsSync(stagedCopy);
      }
    };
    try {
      await runVerifyCli(["--root", root, "--workspace", workspace]);
    } finally {
      console.error = origError;
    }

    assert.equal(stagedWhenPlanPrinted, false, "nothing may be written to the project before the plan prints");
    assert.ok(existsSync(stagedCopy), "…and the staging really does happen later, so the guard is not vacuous");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("planned but uncaptured: the plan names the contract, the engine refuses, STATE stays planned", async () => {
  const root = await plannedProject("unified-cli-planned-");
  const workspace = await tmpDir("unified-cli-ws-");
  const paths = loombridgePaths(root);
  try {
    const { result: code, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const text = lines.join("\n");
    assert.match(text, /contract '.*': will run \(offline\)/);
    assert.match(text, /REFUSED: nothing was graded/, "the engine refusal is the contract section's verdict");
    assert.equal(code, 2);

    const state = await readState(paths);
    assert.equal(state?.phase, "planned", "a run that graded nothing must not flip the phase");

    const report = await readUnified(root);
    assert.equal(report.sections.contract?.exit, 2);
    assert.equal(report.status, "harness-fault");
    assert.equal(report.exit, 2);
    assert.equal(report.sections.contract?.reportPath, path.relative(root, paths.verdict));
    assert.ok(report.sections.contract?.reportSha256, "the section is BOUND to the bytes it summarized");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── the green path is byte-for-byte the legacy engine ────────────────────────

test("a graded contract passes through the orchestrator EXACTLY as a legacy runVerify would", async () => {
  const viaOrchestrator = await plannedProject("unified-cli-green-a-", { graded: true });
  const viaEngine = await plannedProject("unified-cli-green-b-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const orch = await captured(() => runVerifyCli(["--root", viaOrchestrator, "--workspace", workspace]));
    assert.equal(orch.result, 0, `expected a pass:\n${orch.lines.join("\n")}`);

    const legacyPaths = loombridgePaths(viaEngine);
    const legacy = await captured(() =>
      runVerify({
        root: viaEngine,
        inputsDir: legacyPaths.verifyInputs,
        acceptancePath: legacyPaths.acceptance,
        outputPath: legacyPaths.verdict,
        strict: false,
      }),
    );
    assert.equal(legacy.result, 0);

    // PARITY: the same verdict content and the same STATE transition. `producedAt` and
    // the absolute root differ by construction, so they are the only fields dropped.
    const strip = (v: Record<string, unknown>): Record<string, unknown> => {
      const { producedAt: _p, ...rest } = v;
      return rest;
    };
    const orchVerdict = strip(JSON.parse(await fs.readFile(loombridgePaths(viaOrchestrator).verdict, "utf-8")));
    const legacyVerdict = strip(JSON.parse(await fs.readFile(legacyPaths.verdict, "utf-8")));
    assert.deepEqual(orchVerdict, legacyVerdict, "the orchestrator must not touch the verdict the engine writes");

    const orchState = await readState(loombridgePaths(viaOrchestrator));
    const legacyState = await readState(legacyPaths);
    assert.equal(orchState?.phase, legacyState?.phase);
    assert.equal(orchState?.lastVerdict?.status, legacyState?.lastVerdict?.status);
    assert.equal(orchState?.phase, "verified-warn");

    const report = await readUnified(viaOrchestrator);
    assert.equal(report.status, "pass", "one asset, executed, green");
    assert.equal(report.exit, 0);
    assert.equal(report.sections.contract?.status, "warn", "the section carries the ENGINE's own word");
    assert.deepEqual(report.notRun, []);

    // And the legacy run wrote no unified report: it never went through this door.
    assert.equal(await fileExists(unifiedVerifyReportPath(legacyPaths.reports)), false);
  } finally {
    for (const dir of [viaOrchestrator, viaEngine, workspace]) await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── screens: verify-owned report, discovered baseline ────────────────────────

test("screens execute OFFLINE against the discovered baseline and write to the verify-owned report", async () => {
  const root = await tmpDir("unified-cli-screens-");
  const { workspace, contractPath } = await screenWorkspace("unified-cli-screens-ws-");
  try {
    await approveScreens(root, workspace, contractPath);

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const text = lines.join("\n");
    assert.equal(result, 0, `expected the approved pack to re-verify clean:\n${text}`);
    assert.match(text, /screen-contract 'screens-game': will run \(offline\)/);
    assert.match(text, /approved 2\d{3}-/, "the plan names WHEN the anchor was approved");

    // The verify-owned path, never the workspace default the guided flow drives off.
    const verifyOwned = path.join(loombridgePaths(root).reports, UNIFIED_SCREENS_REPORT);
    assert.ok(await fileExists(verifyOwned), "the screens report belongs to verify");
    assert.equal(
      await fileExists(path.join(workspace, "reports", "minigame-verification.json")),
      false,
      "a unified run must not advance (or reset) the guided mini-game flow's state machine",
    );

    const report = await readUnified(root);
    assert.equal(report.sections.screens?.exit, 0);
    assert.equal(report.sections.screens?.status, "pass");
    assert.equal(report.sections.screens?.reportPath, path.relative(root, verifyOwned));
    assert.equal(report.status, "pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a layout baseline approved for ANOTHER project is BROKEN: tier 2, and it never executes", async () => {
  const root = await tmpDir("unified-cli-foreign-");
  const otherProject = await tmpDir("unified-cli-other-");
  const { workspace, contractPath } = await screenWorkspace("unified-cli-foreign-ws-");
  try {
    // Same fixture, approved while standing in a DIFFERENT project. Two checkouts can
    // collide on the derived workspace id, so the stamp is the only thing that catches it.
    await approveScreens(otherProject, workspace, contractPath);

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "a foreign anchor is a harness fault, never a game verdict");
    assert.match(lines.join("\n"), /BROKEN, will not run:.*belongs to another project|baseline projectRoot is/);

    const report = await readUnified(root);
    assert.equal(report.sections.screens, undefined, "a broken row must never be executed");
    assert.equal(report.notRun.length, 1);
    assert.equal(report.notRun[0]!.why, "broken");
    assert.equal(report.status, "nothing-checked");
    assert.equal(
      await fileExists(path.join(loombridgePaths(root).reports, UNIFIED_SCREENS_REPORT)),
      false,
      "a broken asset is tiered WITHOUT running its engine",
    );
  } finally {
    for (const dir of [root, otherProject, workspace]) await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── live-only assets, offline run ────────────────────────────────────────────

test("an approved trace alone is NOTHING-CHECKED offline, and the hint names `verify --live`", async () => {
  const root = await tmpDir("unified-cli-traceonly-");
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "happy-path");

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const text = lines.join("\n");
    assert.equal(result, 2, "zero executed is never exit 0");
    assert.match(text, /trace 'happy-path': not run: needs --live/);
    assert.match(text, /approved 2\d{3}-.*replay report/, "the plan names when and from what it was approved");
    assert.match(text, /Re-run with: loombridge verify --live/);

    const report = await readUnified(root);
    assert.equal(report.status, "nothing-checked");
    assert.equal(report.exit, 2);
    assert.deepEqual(report.sections, {});
    assert.equal(report.notRun[0]!.why, "live-only-skipped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("PARTIAL: a green contract plus a live-only trace exits 0 and NAMES the unmeasured anchor", async () => {
  const root = await plannedProject("unified-cli-partial-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "happy-path");

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 0, "the operator's own --live omission is the ONE non-execution that may still exit 0");
    const text = lines.join("\n");
    assert.match(text, /NOT MEASURED \(never folded into pass\): trace 'happy-path'/);
    assert.match(text, /PARTIAL/);

    const report = await readUnified(root);
    assert.equal(report.status, "partial");
    assert.equal(report.exit, 0);
    assert.equal(report.notRun.length, 1);
    assert.equal(report.notRun[0]!.why, "live-only-skipped");
    assert.equal(report.sections.contract?.exit, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a green contract plus an UNAPPROVED trace is partial at the HARNESS tier, never exit 0", async () => {
  // The `--live` partial exits 0 because the operator chose it. Every other unmeasured
  // anchor is a coverage gap the run could not close, and a green contract must not be
  // allowed to round it up: an unapproved demonstration is exactly the "no frozen thing to
  // compare against" case the whole product exists to refuse.
  const root = await plannedProject("unified-cli-nonanchor-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantTrace(root, "never-approved");

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "an unmeasurable anchor keeps the exit at the harness tier");
    assert.match(lines.join("\n"), /trace 'never-approved'.*recorded, not approved/);

    const report = await readUnified(root);
    assert.equal(report.status, "partial");
    assert.equal(report.exit, 2);
    assert.equal(report.notRun[0]!.why, "non-anchor");
    assert.equal(report.sections.contract?.exit, 0, "the contract really did pass; it just cannot carry the run");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── --live: per-trace isolation (injected seam; a real replay needs an editor) ─

test("--live: one trace that THROWS is that trace's harness fault; the others still run", async () => {
  const root = await tmpDir("unified-cli-live-");
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "a-ok");
    await plantApprovedTrace(root, "b-boom");

    const seen: string[] = [];
    const { result, lines } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: {
          async runFlowTrace(_layout, id, opts) {
            assert.equal(opts.strictVisual, true, "the unified flow section always gates pixel drift (A5)");
            seen.push(id);
            if (id === "b-boom") throw new Error("editor went away mid-replay");
            return { status: "pass", exitTier: 0 };
          },
        },
      }),
    );

    assert.deepEqual(seen, ["a-ok", "b-boom"], "every approved trace is attempted, in a deterministic order");
    assert.equal(result, 2, "a harness fault dominates");
    assert.match(lines.join("\n"), /harness fault, not a game defect.*editor went away/);

    const report = await readUnified(root);
    const flow = report.sections.flow!;
    assert.equal(flow.exit, 2);
    assert.deepEqual(
      flow.assets?.map((a) => [a.id, a.exit]),
      [["a-ok", 0], ["b-boom", 2]],
      "the roll-up must name WHICH trace broke, not just the worst tier",
    );
    assert.equal(report.status, "harness-fault");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a section that throws is caught as ITS harness fault; the later sections still execute", async () => {
  const root = await plannedProject("unified-cli-sectionthrow-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "happy-path");
    const { result } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: {
          async runContract() {
            throw new Error("contract engine exploded");
          },
          async runFlowTrace() {
            return { status: "pass", exitTier: 0 };
          },
        },
      }),
    );
    assert.equal(result, 2);
    const report = await readUnified(root);
    assert.equal(report.sections.contract?.exit, 2);
    assert.equal(report.sections.contract?.status, "harness-fault");
    assert.equal(report.sections.flow?.exit, 0, "the flow section still ran after the contract section threw");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── the positive allowlist ───────────────────────────────────────────────────

test("the allowlist: --live cannot be combined with a mode flag, and it says why", async () => {
  const root = await plannedProject("unified-cli-allow-");
  try {
    const { result, lines } = await captured(() => runVerifyCli(["--live", "--slice", "x", "--root", root]));
    assert.equal(result, 2);
    assert.match(lines.join("\n"), /--live belongs to the bare unified run/);
    assert.equal(
      await fileExists(unifiedVerifyReportPath(loombridgePaths(root).reports)),
      false,
      "a refused invocation writes nothing",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a legacy flag keeps the legacy path: --verbose reaches the contract ENGINE, not the orchestrator", async () => {
  const root = await plannedProject("unified-cli-legacy-");
  const paths = loombridgePaths(root);
  try {
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--verbose"]));
    assert.equal(result, 2, "the engine's own nothing-graded refusal");
    assert.match(lines.join("\n"), /REFUSED: nothing was graded/);
    assert.ok(!lines.join("\n").includes("plan for "), "the orchestrator's plan must not print for a legacy invocation");
    assert.ok(await fileExists(paths.verdict), "the engine still wrote its verdict");
    assert.equal(
      await fileExists(unifiedVerifyReportPath(paths.reports)),
      false,
      "no unified report: this argv never reached the unified door",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("orchestrator argv guards: a malformed --id and an in-project --workspace are refused (exit 2)", async () => {
  const root = await plannedProject("unified-cli-guards-");
  try {
    assert.equal((await captured(() => runVerifyCli(["--root", root, "--id", "1bad"]))).result, 2);
    assert.equal(
      (await captured(() => runVerifyCli(["--root", root, "--workspace", path.join(root, "inside")]))).result,
      2,
      "verification artifacts must never be written into the game repo",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
