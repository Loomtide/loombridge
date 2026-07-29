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
  UNIFIED_SCOPED_REPORT,
  UNIFIED_SCREENS_REPORT,
  UNIFIED_VERIFY_REPORT,
  resolveUnifiedOutcome,
  unifiedScopedReportPath,
  unifiedVerifyReportPath,
  type UnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import { run as runMinigame } from "../../../../capabilities/minigame/minigame.js";
import { resolveCliProjectPin } from "../../../../capabilities/setup/cli-project-pin.js";
import { createDraftAssetManifest, type AssetManifest } from "../../../../capabilities/assets/asset-manifest.js";
import { feelPaths } from "../../../../capabilities/feel/feel-workspace.js";
import { loadMeasurements } from "../../../../capabilities/feel/measurements.js";
import {
  DEFAULT_SNAPSHOT_TOLERANCES,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
  rederiveView,
  writeSnapshotBundle,
  type FeelSnapshotManifest,
} from "../../../../capabilities/feel/snapshot-manifest.js";
import { fileExists, loombridgePaths, readState, standardReplayLayout } from "../../../../domain/state.js";
import { REPO_ROOT } from "../../../_support/paths.js";

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

/** A project root `resolveCliProjectPin` recognises as a real Unity project. */
async function unityLikeProject(prefix: string): Promise<string> {
  const root = await tmpDir(prefix);
  await fs.mkdir(path.join(root, "Assets"), { recursive: true });
  return root;
}

/**
 * The BARE approved asset manifest, exactly the document a hand-written attack (or
 * `verify`'s own staging step) would drop into the inputs dir: every role
 * `primitiveFinal`, which under an `art: deferred` contract passes the gate on the
 * declaration alone, with NO `observedAssets` anywhere.
 */
function bareApprovedManifest(): AssetManifest {
  const manifest = createDraftAssetManifest({
    mode: "generated",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: "f".repeat(64) },
  });
  manifest.status = "approved";
  manifest.approvedAt = "2026-07-28T00:00:00.000Z";
  manifest.assetSources = manifest.assetSources.map((s) => ({ ...s, approved: true, license: "project-generated" }));
  manifest.assets = manifest.assets.map((a) => ({ ...a, status: "approved", primitiveFinal: true }));
  return manifest;
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

// ── feel-snapshot fixture (same technique as unified-discovery.test.ts) ──────

/** The REAL live-capture artifacts the feel-snapshot tests use (re-derives cleanly). */
const LIVE_DIR = path.join(REPO_ROOT, "Docs", "Profiles", "artifacts", "s5cb-live-capture");

const CAPTURE_CONTRACT_FIXTURE = {
  schemaVersion: "1",
  game: "fixture-game",
  subjects: [{ id: "player", locator: { path: "/Player" } }],
  interactions: [{ id: "jump", kind: "key-tap", key: "space" }],
  metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
};

/** Freeze a REAL snapshot bundle into the workspace, stamped as owned by `projectRoot`. */
async function plantSnapshot(workspace: string, projectRoot: string): Promise<void> {
  const staging = await tmpDir("unified-cli-snapshot-candidate-");
  const candidate = path.join(staging, "candidate");
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(
    path.join(candidate, SNAPSHOT_CONTRACT_FILE),
    JSON.stringify(CAPTURE_CONTRACT_FIXTURE, null, 2),
    "utf-8",
  );

  const measurements = await loadMeasurements(path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  const view = rederiveView(measurements);
  const metrics: FeelSnapshotManifest["metrics"] = {};
  for (const [id, value] of Object.entries(measurements.metrics)) {
    metrics[id] = { value, derivation: "trajectory", confidence: view.verified.has(id) ? "verified" : "reported" };
  }
  await writeSnapshotBundle({
    candidateDir: candidate,
    currentDir: feelPaths(workspace).snapshotCurrentDir,
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    note: "feels right",
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    metrics,
    rederivation: { pass: view.pass, total: view.total },
    game: "fixture-game",
    projectRoot,
    contractStats: { interactions: 1, metrics: 1 },
  });
  await fs.rm(staging, { recursive: true, force: true });
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

    // L9: the section says REFUSED, not the engine's `warn`. The verdict file legitimately
    // records `warn` (its gates name every missing capture), but copying that word up into
    // the roll-up would give the run that measured NOTHING the mildest word in the product.
    assert.equal(report.sections.contract?.status, "refused");
    assert.equal(report.sections.contract?.note, "nothing graded");
    assert.match(text, /contract: refused \(nothing graded, exit 2\)/);
    const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8")) as { status: string };
    assert.equal(verdict.status, "warn", "…and the engine's own verdict file is untouched by that relabelling");
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
    // DELIBERATE FLIP (FXH). The fixture's only asset is a contract with NO approved design
    // target, so the run compares nothing a human froze and exits 2. This test is about
    // PARITY of the verdict bytes and the STATE transition (asserted below), not about the
    // door's own exit; the engine's exit is asserted separately, and it is still 0.
    assert.equal(orch.result, 2, `expected the zero-anchored refusal:\n${orch.lines.join("\n")}`);

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
    // DELIBERATE FLIP (G1, then FXH). This asserted `pass` before the unanchored-pass rule
    // landed. The fixture is a planned project with NO approved design target, so its contract
    // section is green and UNANCHORED, a real deterministic result measured against nothing a
    // human ever froze. G1 made the word `partial`; FXH then made the EXIT 2, because a run
    // with ZERO anchored executed sections compared nothing human-approved and a self-produced
    // green cannot exit 0. The parity this test is really about (the verdict bytes and the
    // STATE transition are byte-identical to a legacy `runVerify`) is asserted above and is
    // untouched: the ENGINE still exits 0, only the DOOR's roll-up changed.
    assert.equal(report.status, "partial", "one asset, executed, green, but anchored to nothing (G1)");
    assert.equal(report.exit, 2, "FXH: nothing human-approved was compared, so the run cannot exit 0");
    assert.deepEqual(report.anchoredSections, []);
    assert.deepEqual(report.unanchoredSections, ["contract"]);
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
    // M8: this section really did compare the frozen layout baseline, and says so.
    assert.equal(report.sections.screens?.anchored, true);
    assert.deepEqual(report.anchoredSections, ["screens"]);
    assert.deepEqual(report.unanchoredSections, []);
    assert.ok(!text.includes("no frozen anchor compared"), "an anchored section must not be labelled unanchored");
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
    // L13: the provenance is printed AS RECORDED. The frame shas were re-derived from disk,
    // so the frozen bytes are audited; the source report is copied off the manifest and is
    // not re-checked, and the wording must not let a reader take it as a verified claim.
    assert.match(
      text,
      /approved 2\d{3}-.*\(recorded from replay report [0-9a-f]{12}\)/,
      "the plan names when it was approved and, as recorded, from what",
    );
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

test("PARTIAL: a live-only skip still NAMES the unmeasured anchor, and needs an anchored green to exit 0", async () => {
  // DELIBERATE FLIP (FXH). The `--live` allowance is unchanged: the operator's own omission is
  // still the one non-execution that may keep the exit at 0. What changed is that it can only
  // do so for a run that measured SOMETHING a human approved. This fixture's single executed
  // section is an unanchored contract, so the run now exits 2, and the second half of this
  // test plants an anchored green section to prove the `--live` allowance itself still works.
  const root = await plannedProject("unified-cli-partial-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "happy-path");

    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "zero anchored executed sections: the --live allowance has nothing to attach to");
    const text = lines.join("\n");
    assert.match(text, /NOT MEASURED \(never folded into pass\): trace 'happy-path'/);
    assert.match(text, /PARTIAL/);
    assert.match(text, /REFUSED: nothing human-approved was compared/);

    const report = await readUnified(root);
    assert.equal(report.status, "partial");
    assert.equal(report.exit, 2);
    assert.equal(report.notRun.length, 1);
    assert.equal(report.notRun[0]!.why, "live-only-skipped");
    assert.equal(report.sections.contract?.exit, 0, "the contract really did pass; it just anchors nothing");

    // THE ALLOWANCE ITSELF, unchanged: with one ANCHORED green executed section, the same
    // live-only skip keeps the run at exit 0 and still names the anchor it did not measure.
    assert.deepEqual(
      resolveUnifiedOutcome({
        executed: [
          { section: "screens", exit: 0, anchored: true },
          { section: "contract", exit: 0, anchored: false },
        ],
        notRun: [{ kind: "trace", id: "happy-path", reason: "needs --live", why: "live-only-skipped" }],
      }),
      { status: "partial", exit: 0 },
    );
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

// ── feel + flow: the real section seams (injected; both need a live editor) ───

test("--live: the feel section carries the engine's own tier, pass and integrity gap alike", async () => {
  // FX8. The feel section is production code that nothing drove: its tier comes straight
  // from `runVerifySnapshot` (0 clean / 1 drift / 2 integrity-or-capture-gap), and a
  // section that silently re-derived a tier would put a second opinion next to the
  // engine's. Both ends of that contract are pinned here.
  const root = await tmpDir("unified-cli-feel-");
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantSnapshot(workspace, root);

    for (const [engineExit, expectedStatus] of [[0, "pass"], [2, "harness-fault"]] as const) {
      const seen: { root: string; workspace: string; strict: boolean }[] = [];
      const { result } = await captured(() =>
        runUnifiedVerify({
          root,
          strict: false,
          live: true,
          workspace,
          deps: {
            async runFeel(args) {
              seen.push(args);
              // The real engine writes its drift report here; the double does the same so
              // the section's report binding is exercised rather than stubbed away.
              await fs.mkdir(path.dirname(feelPaths(workspace).driftReport), { recursive: true });
              await fs.writeFile(
                feelPaths(workspace).driftReport,
                JSON.stringify({ status: engineExit === 0 ? "clean" : "blocked", at: `${engineExit}` }),
                "utf-8",
              );
              return engineExit;
            },
          },
        }),
      );
      assert.equal(seen.length, 1, "the feel section really ran");
      assert.equal(seen[0]!.workspace, workspace, "the section drives the RESOLVED workspace");

      const report = await readUnified(root);
      assert.equal(report.sections.feel?.exit, engineExit, "the engine's tier is taken as-is");
      assert.equal(report.sections.feel?.status, engineExit === 0 ? "clean" : "blocked", "…and its own word");
      assert.equal(report.status, expectedStatus);
      assert.equal(result, engineExit);
      assert.equal(
        report.sections.feel?.anchored,
        true,
        "a feel row only becomes runnable after integrity + ownership verified, so it is anchored",
      );
      // FX10: the feel workspace lives OUTSIDE the project by design, so a blind
      // `path.relative` would store `../../..`, a path nothing can walk without knowing
      // the cwd it will be resolved against. An escaping path is stored ABSOLUTE.
      const reportPath = report.sections.feel?.reportPath;
      assert.equal(reportPath, feelPaths(workspace).driftReport);
      assert.ok(path.isAbsolute(String(reportPath)), `report path must be absolute, got ${reportPath}`);
      assert.ok(!String(reportPath).startsWith(".."), "never a `..`-escaping relative path");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("--live: a trace at tier 1 (pixel DRIFT) is a game defect: the run exits 1, not 2", async () => {
  // FX8 + FX5 together. The worst-selection line has to pick the tier-1 outcome as the
  // section's, and a found defect must keep exit 1 even though a second anchor went
  // unmeasured. A `fail` reported at the harness tier reads as "flaky harness, re-run it".
  const root = await plannedProject("unified-cli-drift-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "a-clean");
    await plantApprovedTrace(root, "b-drifted");
    await plantTrace(root, "z-never-approved"); // an unmeasured anchor, on purpose

    const { result, lines } = await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: {
          async runFlowTrace(_layout, id) {
            return id === "b-drifted"
              ? { status: "visual-drift", exitTier: 1 }
              : { status: "pass", exitTier: 0 };
          },
        },
      }),
    );

    const report = await readUnified(root);
    const flow = report.sections.flow!;
    assert.equal(flow.exit, 1, "the section takes the worst tier its assets earned");
    assert.equal(flow.status, "visual-drift", "…and the WORST asset's status word, not the first one's");
    assert.deepEqual(flow.assets?.map((a) => [a.id, a.exit]), [["a-clean", 0], ["b-drifted", 1]]);

    assert.equal(report.status, "fail");
    assert.equal(report.exit, 1, "a found game defect is never re-tiered to 2 by an unmeasured anchor");
    assert.equal(result, 1);
    assert.match(lines.join("\n"), /NOT MEASURED \(never folded into pass\): trace 'z-never-approved'/);
    assert.equal(report.notRun[0]!.why, "non-anchor", "the coverage gap is still reported, as a row");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("--live: the flow section PINS the editor it replays against", async () => {
  // FX3. `endpoint-discovery-latest.json` is one shared pointer every running editor
  // overwrites on its heartbeat, so an unpinned replay drives whichever project published
  // most recently. The trace verb resolves the pin the same way; this door must not be the
  // one path that replays a demonstration against someone else's game.
  const root = await unityLikeProject("unified-cli-pin-");
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    await plantApprovedTrace(root, "happy-path");
    const opts: { strictVisual: boolean; projectPathCanonical?: string }[] = [];
    await captured(() =>
      runUnifiedVerify({
        root,
        strict: false,
        live: true,
        workspace,
        deps: {
          async runFlowTrace(_layout, _id, o) {
            opts.push(o);
            return { status: "pass", exitTier: 0 };
          },
        },
      }),
    );
    assert.equal(opts.length, 1);
    assert.equal(opts[0]!.strictVisual, true, "the unified flow section always gates pixel drift (A5)");
    assert.equal(
      opts[0]!.projectPathCanonical,
      resolveCliProjectPin({ root }),
      "the section must pass the SAME pin `trace replay` resolves for this root",
    );
    assert.equal(opts[0]!.projectPathCanonical, root, "…and for a real Unity project that pin is the root");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── H1: a screen contract with no approved baseline cannot manufacture a pass ─

test("screens with NO approved layout baseline never execute: a contract graded against itself is not an anchor", async () => {
  // The manufactured-pass attack: the contract and the capture pack are both producible by
  // one agent in one session, so without a frozen third artifact the section would grade a
  // document against captures of that document and report `pass` at exit 0.
  const root = await tmpDir("unified-cli-nobaseline-");
  const { workspace } = await screenWorkspace("unified-cli-nobaseline-ws-");
  try {
    // Deliberately NO `baseline approve`: the fixture's captures are perfect, so the only
    // thing standing between this project and a green run is the missing human anchor.
    const { result, lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(result, 2, "no approved anchor, no pass");
    assert.match(lines.join("\n"), /minigame baseline approve/, "the plan names the command that fixes it");

    const report = await readUnified(root);
    assert.equal(report.sections.screens, undefined, "the section must never run");
    assert.equal(report.status, "nothing-checked");
    assert.equal(report.notRun[0]!.why, "non-anchor");
    assert.equal(
      await fileExists(path.join(loombridgePaths(root).reports, UNIFIED_SCREENS_REPORT)),
      false,
      "nothing was graded, so no screens report exists to be quoted",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── H2: the staged asset manifest cannot carry a run ─────────────────────────

test("H2: a hand-written BARE asset-manifest.json with zero captures still REFUSES, on both doors", async () => {
  // The attack, verbatim: plan a project, declare `art.mode: "deferred"` so primitive-final
  // roles need no provenance, hand-write the BARE manifest into the inputs dir, and capture
  // nothing at all. The asset-source gate then RUNS over a declaration of intent, which made
  // `gradedGates` non-empty, skipped the nothing-graded refusal, and let a run with zero
  // captured evidence produce a Tier-1 GAME VERDICT and flip STATE to a quotable
  // `verified-*`. The gate's own verdict is beside the point: what matters is that a staged
  // project document was accepted as proof that this run measured the game.
  for (const door of ["bare-argv", "runVerify"] as const) {
    const root = await plannedProject(`unified-cli-h2-${door}-`);
    const workspace = await tmpDir("unified-cli-ws-");
    const paths = loombridgePaths(root);
    try {
      const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as Record<string, unknown>;
      contract.art = { mode: "deferred" };
      await fs.writeFile(paths.acceptance, JSON.stringify(contract, null, 2), "utf-8");

      await fs.mkdir(paths.verifyInputs, { recursive: true });
      await fs.writeFile(
        path.join(paths.verifyInputs, "asset-manifest.json"),
        JSON.stringify(bareApprovedManifest(), null, 2),
        "utf-8",
      );

      const { result, lines } = await captured(() =>
        door === "bare-argv"
          ? runVerifyCli(["--root", root, "--workspace", workspace])
          : runVerify({
              root,
              inputsDir: paths.verifyInputs,
              acceptancePath: paths.acceptance,
              outputPath: paths.verdict,
              strict: false,
            }),
      );

      assert.equal(result, 2, `${door}: a run whose only "evidence" is a staged declaration is not a pass`);
      assert.match(lines.join("\n"), /REFUSED: nothing was graded/, door);

      const state = await readState(paths);
      assert.equal(state?.phase, "planned", `${door}: STATE must not flip`);
      assert.equal(state?.lastVerdict ?? null, null, `${door}: no verdict recorded on STATE`);

      // NON-VACUITY: the gate really did RUN over the planted document (it is not
      // `not_applicable`), so without the staged-document marker it would be the one
      // "graded" gate that satisfies the refusal check and lets this run report a verdict.
      const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8")) as {
        gates: Record<string, string>;
        checks: { id: string }[];
      };
      assert.ok(
        verdict.gates["asset-source-fidelity"] !== undefined
          && verdict.gates["asset-source-fidelity"] !== "not_applicable",
        `${door}: the gate must really have evaluated the planted document, or this test proves nothing`,
      );
      assert.ok(
        verdict.checks.some((c) => c.id === "asset-source-fidelity.staged-document"),
        `${door}: the staged-document marker is what stops it counting`,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("M6: staging never CLOBBERS a captured asset-manifest.json", async () => {
  // The other half of the same defect: `verify` copied the project's bare document over a
  // valid WRAPPED capture on its way past, turning a graded gate into a tier-1 fail. The
  // convenience copy must never destroy evidence.
  const root = await plannedProject("unified-cli-clobber-", { assetManifest: true });
  const paths = loombridgePaths(root);
  try {
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    const captured1 = { manifest: bareApprovedManifest(), observedAssets: [] };
    const stagedPath = path.join(paths.verifyInputs, "asset-manifest.json");
    await fs.writeFile(stagedPath, JSON.stringify(captured1, null, 2), "utf-8");

    await captured(() =>
      runVerify({
        root,
        inputsDir: paths.verifyInputs,
        acceptancePath: paths.acceptance,
        outputPath: paths.verdict,
        strict: false,
      }),
    );

    const after = JSON.parse(await fs.readFile(stagedPath, "utf-8")) as Record<string, unknown>;
    assert.ok("manifest" in after, "the WRAPPED capture must survive the staging step untouched");
    assert.ok("observedAssets" in after);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── M4: --report is a write, and is validated first ──────────────────────────

test("--report is refused when it would overwrite a project artifact, before anything runs", async () => {
  const root = await plannedProject("unified-cli-report-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  const paths = loombridgePaths(root);
  try {
    const before = await fs.readFile(paths.acceptance, "utf-8");
    const { result, lines } = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--report", ".loombridge/ACCEPTANCE.json"]),
    );
    assert.equal(result, 2);
    assert.match(lines.join("\n"), /REFUSED: --report/);
    assert.equal(await fs.readFile(paths.acceptance, "utf-8"), before, "the contract is byte-identical");
    assert.ok(!lines.join("\n").includes("plan for "), "the refusal comes BEFORE the plan, so nothing ran");
    assert.equal(await fileExists(paths.verdict), false, "no section executed");

    // …and a fresh path under the project is accepted, so the guard is not a blanket no.
    // FXH: this fixture's only asset is an UNANCHORED contract, so the run's own exit is 2
    // (nothing human-approved was compared). What this test is about is that the run was
    // ALLOWED to proceed and wrote its report where it was told, which the two assertions
    // below check directly rather than through the exit code.
    const ok = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--report", "reports/mine.json"]),
    );
    assert.equal(ok.result, 2, ok.lines.join("\n"));
    assert.ok(ok.lines.join("\n").includes("plan for "), "the run proceeded: this is not a --report refusal");
    const written = JSON.parse(await fs.readFile(path.join(root, "reports", "mine.json"), "utf-8")) as UnifiedVerifyReport;
    assert.equal(written.kind, "unified-verify");

    // Re-running over its own previous report is allowed (that is what --report is for).
    const again = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--report", "reports/mine.json"]),
    );
    assert.equal(again.result, 2, again.lines.join("\n"));
    assert.ok(!again.lines.join("\n").includes("REFUSED: --report"), "its own previous report is a legal target");

    // S1 final-test LOW-1: a path that ESCAPES the root is refused outright, even a fresh
    // one. The docs promise --report resolves relative to --root; a verify run must never
    // write outside the project it is grading.
    const escape = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--report", "../escape.json"]),
    );
    assert.equal(escape.result, 2);
    assert.match(escape.lines.join("\n"), /resolves outside the project root/);
    assert.equal(
      await fileExists(path.join(path.dirname(root), "escape.json")),
      false,
      "nothing may be written outside the root",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("--report resolves relative to --root, not the process cwd", async () => {
  const root = await plannedProject("unified-cli-reportcwd-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const { result } = await captured(() =>
      runVerifyCli(["--report", "reports/rel.json", "--root", root, "--workspace", workspace]),
    );
    // FXH: the fixture's only asset is an unanchored contract, so the run exits 2. This test
    // is about WHERE the report landed, which the assertions below pin directly.
    assert.equal(result, 2);
    assert.ok(await fileExists(path.join(root, "reports", "rel.json")), "the report lands under --root");
    assert.equal(
      await fileExists(path.join(process.cwd(), "reports", "rel.json")),
      false,
      "…and never under whatever directory the operator happened to be standing in",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── M5: a stale report is never claimed as this run's ────────────────────────

test("M5: a section that produced no report this run does not stamp the previous run's sha", async () => {
  // Run once so a good screens report lands on disk, then break the contract so the engine
  // refuses BEFORE writing anything. The section must not find the old file, hash it, and
  // present it as this run's evidence.
  const root = await tmpDir("unified-cli-stale-");
  const { workspace, contractPath } = await screenWorkspace("unified-cli-stale-ws-");
  try {
    await approveScreens(root, workspace, contractPath);
    const first = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.equal(first.result, 0, first.lines.join("\n"));
    const goodSha = (await readUnified(root)).sections.screens!.reportSha256;
    assert.match(String(goodSha), /^[0-9a-f]{64}$/);

    // The attack: a contract the engine refuses to load, so it writes no report at all.
    const contract = JSON.parse(await fs.readFile(contractPath, "utf-8")) as Record<string, unknown>;
    contract.visualProfile = "not-a-real-profile";
    await fs.writeFile(contractPath, JSON.stringify(contract, null, 2), "utf-8");

    const second = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    assert.notEqual(second.result, 0, "a refused engine is never a pass");

    const report = await readUnified(root);
    const screens = report.sections.screens;
    if (screens) {
      assert.notEqual(screens.reportSha256, goodSha, "the PREVIOUS run's sha must never be stamped as this run's");
      if (screens.reportSha256 === undefined || screens.reportSha256 === null) {
        assert.equal(screens.note, "no report produced this run", "…and the section says so out loud");
        assert.equal(screens.reportPath, undefined, "an unwritten report is not named either");
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── M8: anchor visibility ────────────────────────────────────────────────────

test("M8: the report says which executed sections compared a frozen anchor", async () => {
  const root = await plannedProject("unified-cli-anchored-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const { lines } = await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const report = await readUnified(root);

    // A planned project has no approved design target, so its contract section is green
    // and UNANCHORED. Those two facts must be separately readable.
    assert.equal(report.sections.contract?.exit, 0);
    assert.equal(report.sections.contract?.anchored, false);
    assert.deepEqual(report.anchoredSections, []);
    assert.deepEqual(report.unanchoredSections, ["contract"]);
    assert.match(lines.join("\n"), /no frozen anchor compared/, "the summary says it, not just the JSON");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── S2a: --only, the SCOPED run ──────────────────────────────────────────────

/** Read the scoped report a `--only` run writes (never `verify.json`). */
async function readScoped(root: string): Promise<UnifiedVerifyReport> {
  const file = unifiedScopedReportPath(loombridgePaths(root).reports);
  return JSON.parse(await fs.readFile(file, "utf-8")) as UnifiedVerifyReport;
}

test("--only runs the selected section, DESELECTS the healthy rest, and is never a `pass`", async () => {
  // The fixture has two healthy offline assets: an APPROVED screens pack (anchored, green)
  // and a planned contract (green, unanchored). `--only screens` must execute exactly one of
  // them and record the other as deselected, and the run must still not claim a full pass.
  const root = await plannedProject("unified-cli-only-", { graded: true });
  const { workspace, contractPath } = await screenWorkspace("unified-cli-only-ws-");
  try {
    await approveScreens(root, workspace, contractPath);

    const { result, lines } = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--only", "screens"]),
    );
    const text = lines.join("\n");
    assert.equal(result, 0, `an anchored green section still exits 0 when scoped:\n${text}`);
    assert.match(text, /scoped to --only screens/, "the plan header names the scoping");
    assert.match(text, /contract '.*': deselected \(--only screens\): not run, and not counted/);
    assert.match(text, /SCOPED RUN \(--only\)/);
    assert.match(text, /DESELECTED \(--only, excluded from the verdict\): contract/);

    const report = await readScoped(root);
    assert.deepEqual(report.only, ["screens"]);
    assert.equal(report.status, "partial", "F2: a scoped run's ceiling is partial, never pass");
    assert.equal(report.exit, 0, "…and the ceiling lowers the WORD, not the tier");
    assert.equal(report.sections.screens?.exit, 0);
    assert.equal(report.sections.contract, undefined, "a deselected section must never execute");
    assert.deepEqual(report.deselected.map((d) => [d.kind, d.section]), [["contract", "contract"]]);
    assert.deepEqual(report.notRun, [], "a deselected row is NOT a notRun row");

    // F1: the full report is a different file, and this run did not write it.
    assert.equal(
      await fileExists(unifiedVerifyReportPath(loombridgePaths(root).reports)),
      false,
      "a scoped run must never write the full unified report",
    );
    // …and the contract engine never ran, so no verdict was produced either.
    assert.equal(await fileExists(loombridgePaths(root).verdict), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("F2 LITMUS: a BROKEN asset is NOT scoped away: --only cannot make tampering stop counting", async () => {
  // THE ATTACK `--only` could otherwise buy: approve a trace baseline, repaint a frame after
  // approval, then run `--only screens` so the tampered row is "not part of this run". The
  // deselection rule therefore only ever removes a row whose `runnable` is not `no`.
  //
  // The fixture is built so the ordering is the ONLY thing that decides the exit: the
  // selected screens section is anchored and green (exit 0 on its own), and the tampered
  // trace is in a section nobody selected. Deselect-before-classify would exit 0; the shipped
  // order exits 2.
  const root = await tmpDir("unified-cli-onlybroken-");
  const { workspace, contractPath } = await screenWorkspace("unified-cli-onlybroken-ws-");
  try {
    await approveScreens(root, workspace, contractPath);
    await plantApprovedTrace(root, "demo");

    // CONTROL: with the baseline intact, the same scoped invocation is a clean exit 0 and the
    // trace really is deselected, so the flip below is caused by the tampering alone.
    const clean = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--only", "screens"]),
    );
    assert.equal(clean.result, 0, clean.lines.join("\n"));
    assert.deepEqual((await readScoped(root)).deselected.map((d) => d.kind), ["trace"]);

    // THE TAMPERING: repaint an approved frame after the fact.
    await fs.writeFile(
      path.join(standardReplayLayout(root).replayBaselines, "demo", "cap.png"),
      Buffer.from("repainted after approval"),
    );

    const { result, lines } = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--only", "screens"]),
    );
    assert.equal(result, 2, `tampering must survive the scoping:\n${lines.join("\n")}`);
    assert.match(lines.join("\n"), /trace 'demo': BROKEN, will not run/);

    const report = await readScoped(root);
    assert.equal(report.status, "partial");
    assert.equal(report.exit, 2, "a broken anchor keeps the harness tier in a scoped run");
    assert.equal(report.notRun.length, 1);
    assert.equal(report.notRun[0]!.why, "broken");
    assert.deepEqual(report.deselected, [], "a broken row is NOT deselectable, so it is not here");
    assert.equal(report.sections.screens?.exit, 0, "…and the selected section really did pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("--only over an UNANCHORED section keeps the FXH rule: a self-produced green cannot exit 0", async () => {
  // The scoping does not buy an exemption from the anchored-exit rule. A planned contract is
  // green and unanchored, so selecting only it exits 2 exactly as the full run does.
  const root = await plannedProject("unified-cli-onlyfxh-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const { result, lines } = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--only", "contract"]),
    );
    assert.equal(result, 2);
    assert.match(lines.join("\n"), /REFUSED: nothing human-approved was compared/);
    const report = await readScoped(root);
    assert.equal(report.status, "partial");
    assert.equal(report.exit, 2);
    assert.deepEqual(report.only, ["contract"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a selection that matches NO discovered asset is nothing-checked (exit 2), with the row-less reason named", async () => {
  const root = await plannedProject("unified-cli-onlynone-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const { result, lines } = await captured(() =>
      runVerifyCli(["--root", root, "--workspace", workspace, "--only", "feel"]),
    );
    assert.equal(result, 2, "a run that checked nothing is never a pass, scoped or not");
    const text = lines.join("\n");
    assert.match(text, /the selection --only feel matched no runnable asset/);
    assert.match(text, /discovered kinds: contract/);
    const report = await readScoped(root);
    assert.equal(report.status, "nothing-checked");
    assert.deepEqual(report.sections, {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a malformed --only refuses BEFORE discovery and BEFORE any write, leaving a previous report untouched", async () => {
  // F13: the selector is validated at the same position `--report` is, so a typo cannot
  // print a plan (which would tell an operator what "will run" for an invocation that never
  // could) and cannot disturb the previous run's report.
  const root = await plannedProject("unified-cli-onlybad-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  const paths = loombridgePaths(root);
  try {
    // A real previous full run, so "untouched" is a claim with something to protect.
    await captured(() => runVerifyCli(["--root", root, "--workspace", workspace]));
    const before = await fs.readFile(unifiedVerifyReportPath(paths.reports), "utf-8");

    for (const [argv, pattern] of [
      [["--only", "pixels"], /unknown --only section\(s\): pixels/],
      [["--only", ""], /--only needs at least one section name/],
    ] as const) {
      const { result, lines } = await captured(() =>
        runVerifyCli(["--root", root, "--workspace", workspace, ...argv]),
      );
      const text = lines.join("\n");
      assert.equal(result, 2, text);
      assert.match(text, pattern);
      assert.match(text, /contract, flow, feel, screens, tests/, "the refusal names the vocabulary");
      assert.ok(!text.includes("plan for "), "the refusal comes BEFORE the plan, so nothing ran");
      assert.equal(await fileExists(unifiedScopedReportPath(paths.reports)), false, "no scoped report written");
      assert.equal(await fs.readFile(unifiedVerifyReportPath(paths.reports), "utf-8"), before, "byte-identical");
    }

    // A value-less `--only` is malformed argv: the router declines it, and `run` says what is
    // actually wrong rather than reporting it as a mode combination.
    const bare = await captured(() => runVerifyCli(["--root", root, "--only"]));
    assert.equal(bare.result, 2);
    assert.match(bare.lines.join("\n"), /--only requires a comma-separated value/);
    assert.match(bare.lines.join("\n"), /contract, flow, feel, screens, tests/);

    // …and combined with a MODE flag it is the combination that is reported (F8).
    const combined = await captured(() => runVerifyCli(["--only", "tests", "--slice", "x", "--root", root]));
    assert.equal(combined.result, 2);
    assert.match(combined.lines.join("\n"), /--only belongs to the bare unified run/);
    assert.match(combined.lines.join("\n"), /cannot be combined with mode\/engine flags/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("F1: --report cannot point a scoped run at the full report, nor a full run at the scoped one", async () => {
  // Both files carry `kind: "unified-verify"`, so the previous-report allowance would happily
  // let one overwrite the other. Refused in BOTH directions, before anything runs.
  const root = await plannedProject("unified-cli-onlyreport-", { graded: true });
  const workspace = await tmpDir("unified-cli-ws-");
  try {
    const scopedAtFull = await captured(() =>
      runVerifyCli([
        "--root", root, "--workspace", workspace,
        "--only", "contract",
        "--report", `.loombridge/reports/${UNIFIED_VERIFY_REPORT}`,
      ]),
    );
    assert.equal(scopedAtFull.result, 2);
    assert.match(scopedAtFull.lines.join("\n"), /is the FULL run's unified report; a scoped run \(--only\) never writes it/);

    const fullAtScoped = await captured(() =>
      runVerifyCli([
        "--root", root, "--workspace", workspace,
        "--report", `.loombridge/reports/${UNIFIED_SCOPED_REPORT}`,
      ]),
    );
    assert.equal(fullAtScoped.result, 2);
    assert.match(fullAtScoped.lines.join("\n"), /is the scoped \(--only\) run's own report; a full run never writes it/);

    // Neither refusal wrote anything.
    const paths = loombridgePaths(root);
    assert.equal(await fileExists(unifiedVerifyReportPath(paths.reports)), false);
    assert.equal(await fileExists(unifiedScopedReportPath(paths.reports)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── S2b: the deprecation notices ─────────────────────────────────────────────

test("S2b: --snapshot and --minigame print ONE stderr notice each, and stdout stays byte-identical", async () => {
  // The notice is routing information, not a verdict: it goes to stderr, it does not change
  // the mode's behavior, and it must not appear on stdout, where a machine reads the mode's
  // own output. Both halves are pinned by capturing the two streams separately.
  const root = await tmpDir("unified-cli-notice-");
  try {
    for (const [argv, section] of [
      [["--snapshot", "--root", root, "--measurements", path.join(root, "nope.json")], "feel"],
      [["--minigame", "--root", root, "--contract", path.join(root, "c.json"), "--captures", root], "screens"],
    ] as const) {
      const out: string[] = [];
      const err: string[] = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...a: unknown[]): void => void err.push(a.map(String).join(" "));
      console.log = (...a: unknown[]): void => void out.push(a.map(String).join(" "));
      let code: number;
      try {
        code = await runVerifyCli([...argv]);
      } finally {
        console.error = origError;
        console.log = origLog;
      }

      const notice = err.filter((l) => /NOTICE: (--snapshot|--minigame) is a DEPRECATED ALIAS/.test(l));
      assert.equal(notice.length, 1, `exactly one deprecation headline on stderr:\n${err.join("\n")}`);
      assert.match(err.join("\n"), new RegExp(`loombridge verify --only ${section}`));
      assert.ok(
        !out.some((l) => /DEPRECATED ALIAS/.test(l)),
        `the notice must never reach stdout:\n${out.join("\n")}`,
      );
      assert.notEqual(code, 0, "the mode still runs and still reports its own tier");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("S2b: the notice changes NOTHING about the mode it annotates (behavior parity), and --quiet-next suppresses it", async () => {
  // Parity is asserted against the mode's own output, not just its exit: everything the mode
  // printed before is still printed, in the same order, with only the notice added. And F10:
  // the guided flow passes `--quiet-next`, so a human mid-flow is not told to leave it.
  const root = await tmpDir("unified-cli-notice-parity-");
  try {
    const argv = ["--snapshot", "--root", root, "--measurements", path.join(root, "nope.json")];
    const noisy = await captured(() => runVerifyCli([...argv]));
    const quiet = await captured(() => runVerifyCli([...argv, "--quiet-next"]));

    assert.equal(quiet.result, noisy.result, "the notice does not change the tier");
    assert.ok(
      !quiet.lines.some((l) => /DEPRECATED ALIAS/.test(l)),
      `--quiet-next must suppress the notice:\n${quiet.lines.join("\n")}`,
    );
    // BEHAVIOR PARITY: strip the notice by its own marker (every notice line carries
    // `NOTICE:`) and the two runs are line-for-line the same run.
    const withoutNotice = noisy.lines.filter((l) => !l.includes("[loombridge verify] NOTICE:"));
    assert.equal(noisy.lines.length - withoutNotice.length, 3, "the notice is the three lines, and only those");
    assert.deepEqual(withoutNotice, quiet.lines, "only the notice differs");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
