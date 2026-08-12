/**
 * S6e — single-game baseline regression.
 *
 * Coverage (offline, deterministic — real PNGs built in-memory, no live editor):
 *  - approve REFUSES a non-pass run (no bundle written);
 *  - approve writes the bundle + manifest (per-state png/rects + shas + masks);
 *  - clean compare PASSES (re-verify the same pack → no regression);
 *  - a visible PNG mutation REGRESSES (exit 1) — its OWN CR group, not a game
 *    defect and not a harness gap;
 *  - a MASKED mutation passes (the dynamic region is blanked in both);
 *  - a rect drift (png unchanged) regresses;
 *  - a CURRENT capture absent is INCOMPLETE (captureAbsent), never a regression;
 *  - a BASELINE state file missing is INCOMPLETE (can't compare), never a pass;
 *  - the pure `compareStateToBaseline` truth-table;
 *  - `minigame baseline status` prints the manifest.
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertValidMinigameContract } from "../../../../capabilities/minigame/profiles/validator.js";
import type { MinigameContract } from "../../../../capabilities/minigame/profiles/types.js";
import { runVerifyMinigame, type MinigameVerifyReport } from "../../../../capabilities/minigame/verify-minigame.js";
import { run as minigameRun } from "../../../../capabilities/minigame/minigame.js";
import {
  BASELINE_MANIFEST,
  compareStateToBaseline,
  loadBaselineManifest,
  type BaselineManifest,
  type BaselineManifestLoad,
  type BaselineStateInputs,
} from "../../../../capabilities/minigame/minigame-baseline.js";
import type { DecodedImage } from "../../../../capabilities/minigame/frame-facts.js";
import type { MinigameCaptureObject } from "../../../../capabilities/minigame/types.js";
import { plantGitRepo } from "../../../_support/git-repo-fixture.js";

// ── PNG writer (RGBA, lossless) — same shape as verification-analyze-frames.test ──
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
function pngBuffer(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const W = 16;
const H = 12;
const WHITE: [number, number, number] = [255, 255, 255];
const white = () => WHITE;

/** Paint a bottom-left-origin screenRect black (everything else white). */
function paintRectBlack(rect: { x: number; y: number; width: number; height: number }): (x: number, y: number) => [number, number, number] {
  const x0 = rect.x;
  const x1 = rect.x + rect.width;
  const yTop0 = H - (rect.y + rect.height);
  const yTop1 = H - rect.y;
  return (x, y) => (x >= x0 && x < x1 && y >= yTop0 && y < yTop1 ? [0, 0, 0] : WHITE);
}

const BTN_RECT = { x: 2, y: 3, width: 5, height: 6 };
const DYN_RECT = { x: 9, y: 3, width: 5, height: 6 };

function captureObject(id: string, screenRect: { x: number; y: number; width: number; height: number }): Record<string, unknown> {
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
    screenRect,
    viewportRect: { x: screenRect.x / W, y: screenRect.y / H, width: screenRect.width / W, height: screenRect.height / H },
    canvasScaleFactor: 1,
  };
}

function uiRectsBody(state: string, objects: Array<Record<string, unknown>>): unknown {
  return { state, viewport: { width: W, height: H, aspect: W / H }, objects };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf-8");
}

/** Write one state's png + ui-rects + console into a captures dir. */
async function writeState(
  dir: string,
  state: string,
  objects: Array<Record<string, unknown>>,
  png: Buffer,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${state}.png`), png);
  await writeJson(path.join(dir, `${state}.ui-rects.json`), uiRectsBody(state, objects));
  await writeJson(path.join(dir, `${state}.console.json`), { errorCount: 0 });
}

/** Two-state contract (start + win). `masks`/`ref` set on baseline. */
function makeContract(refDir: string, masks: string[] = []): MinigameContract {
  return assertValidMinigameContract({
    schemaVersion: "1",
    id: "baseline-game",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/B.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [
      { id: "btn", locator: "B:/HUD/btn" },
      { id: "dyn", locator: "B:/HUD/dyn" },
    ],
    states: [
      { id: "start", kind: "start", requiredInFrame: ["btn"] },
      { id: "win", kind: "success_reward", requiredInFrame: ["btn", "dyn"] },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["start", "win"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame"] },
    baseline: { ref: refDir, ...(masks.length > 0 ? { masks } : {}) },
  });
}

/** Write a clean PASS capture pack (start + win, both objects visible, white frames). */
async function writeCleanPack(capturesDir: string): Promise<void> {
  const objs = [captureObject("btn", BTN_RECT), captureObject("dyn", DYN_RECT)];
  await writeState(capturesDir, "start", [captureObject("btn", BTN_RECT)], pngBuffer(W, H, white));
  await writeState(capturesDir, "win", objs, pngBuffer(W, H, white));
}

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
async function readReport(file: string): Promise<MinigameVerifyReport> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as MinigameVerifyReport;
}
/** Unwrap a load the test has already asserted is `ok`. */
function okManifest(load: BaselineManifestLoad): BaselineManifest {
  assert.equal(load.status, "ok", `expected a loadable manifest, got ${JSON.stringify(load)}`);
  return (load as { status: "ok"; manifest: BaselineManifest }).manifest;
}
async function approve(root: string, contractPath: string, capturesDir: string, ref?: string): Promise<number> {
  return minigameRun(["baseline", "approve", "--contract", contractPath, "--captures", capturesDir, "--root", root, ...(ref ? ["--ref", ref] : [])]);
}
async function verify(root: string, contractPath: string, capturesDir: string, outputPath: string): Promise<{ code: number; report: MinigameVerifyReport }> {
  const code = await runVerifyMinigame({ root, contractPath, capturesDir, outputPath, strict: false });
  return { code, report: await readReport(outputPath) };
}

// ── pure compareStateToBaseline truth-table ──────────────────────────────────

function img(pixel: (x: number, y: number) => [number, number, number]): DecodedImage {
  const data = new Uint8Array(W * H * 4);
  let o = 0;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = pixel(x, y);
      data[o++] = r;
      data[o++] = g;
      data[o++] = b;
      data[o++] = 255;
    }
  return { width: W, height: H, data };
}
function inputs(image: DecodedImage, objs: Array<Record<string, unknown>>): BaselineStateInputs {
  return { image, objects: objs as unknown as MinigameCaptureObject[], viewport: { width: W, height: H, aspect: W / H } };
}
const TH = { maxBaselineDiffFraction: 0.02, maxRectDriftFraction: 0.02 };

test("compareStateToBaseline: identical → not regressed", () => {
  const a = inputs(img(white), [captureObject("btn", BTN_RECT)]);
  const b = inputs(img(white), [captureObject("btn", BTN_RECT)]);
  const r = compareStateToBaseline("s", a, b, new Set(), TH);
  assert.equal(r.regressed, false);
  assert.equal(r.diffFraction, 0);
});

test("compareStateToBaseline: a big pixel change → regressed", () => {
  const cur = inputs(img(paintRectBlack(BTN_RECT)), [captureObject("btn", BTN_RECT)]);
  const base = inputs(img(white), [captureObject("btn", BTN_RECT)]);
  const r = compareStateToBaseline("s", cur, base, new Set(), TH);
  assert.equal(r.regressed, true);
  assert.ok((r.diffFraction ?? 0) > TH.maxBaselineDiffFraction);
});

test("compareStateToBaseline: the same change MASKED → not regressed", () => {
  const cur = inputs(img(paintRectBlack(DYN_RECT)), [captureObject("btn", BTN_RECT), captureObject("dyn", DYN_RECT)]);
  const base = inputs(img(white), [captureObject("btn", BTN_RECT), captureObject("dyn", DYN_RECT)]);
  const r = compareStateToBaseline("s", cur, base, new Set(["dyn"]), TH);
  assert.equal(r.regressed, false, "the masked region must be blanked in both images");
});

test("compareStateToBaseline: a non-masked rect drift (png identical) → regressed", () => {
  const moved = captureObject("btn", BTN_RECT);
  (moved as Record<string, unknown>).viewportRect = { x: 0.5, y: BTN_RECT.y / H, width: BTN_RECT.width / W, height: BTN_RECT.height / H };
  const cur = inputs(img(white), [moved]);
  const base = inputs(img(white), [captureObject("btn", BTN_RECT)]);
  const r = compareStateToBaseline("s", cur, base, new Set(), TH);
  assert.equal(r.regressed, true);
  assert.ok((r.maxRectDrift ?? 0) > TH.maxRectDriftFraction);
  assert.deepEqual(r.driftedObjects?.map((o) => o.id), ["btn"]);
});

// ── approve / status / compare end-to-end ────────────────────────────────────

test("baseline approve: REFUSES a non-pass run (no bundle written)", async () => {
  const root = await tmp("s6e-refuse-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    // 'win' is missing its required 'dyn' object INSIDE a present capture → required-in-frame fail.
    await writeState(caps, "start", [captureObject("btn", BTN_RECT)], pngBuffer(W, H, white));
    await writeState(caps, "win", [captureObject("btn", BTN_RECT)], pngBuffer(W, H, white));
    const code = await approve(root, contractPath, caps);
    assert.equal(code, 1, "a non-pass run must not be baselined");
    await assert.rejects(fs.access(path.join(ref, BASELINE_MANIFEST)), "no manifest should be written");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve (G8 MOAT): REFUSES a sequential (can't-verify) run — must not freeze it as a green baseline", async () => {
  // A run where every per-state gate PASSES but a state collapses sequential sub-screens (its capture
  // carries a `sequential` marker) is `incomplete` on `verify` — the approve path must agree, else the
  // sequentialStates incomplete-force is dropped and a can't-verify run is laundered into a green baseline.
  const root = await tmp("s6e-seq-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps); // all per-state gates pass…
    // …but mark 'win' as a sequential sub-screen (objects shown across sub-screens, not co-visible).
    await writeJson(path.join(caps, "win.ui-rects.json"), {
      state: "win",
      viewport: { width: W, height: H, aspect: W / H },
      objects: [captureObject("btn", BTN_RECT), captureObject("dyn", DYN_RECT)],
      sequential: { missing: ["dyn"] },
    });
    const code = await approve(root, contractPath, caps);
    assert.equal(code, 1, "a sequential/can't-verify run must not be baselined");
    await assert.rejects(fs.access(path.join(ref, BASELINE_MANIFEST)), "no manifest should be written");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve: writes the bundle + manifest (per-state png/rects + masks)", async () => {
  const root = await tmp("s6e-approve-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref, ["dyn"]));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    const code = await approve(root, contractPath, caps);
    assert.equal(code, 0);
    const manifest = JSON.parse(await fs.readFile(path.join(ref, BASELINE_MANIFEST), "utf-8")) as BaselineManifest;
    assert.equal(manifest.contractId, "baseline-game");
    assert.equal(manifest.approvedStatus, "pass");
    assert.deepEqual(manifest.masks, ["dyn"]);
    assert.deepEqual(manifest.states.map((s) => s.id).sort(), ["start", "win"]);
    assert.ok(manifest.states.every((s) => /^[0-9a-f]{64}$/.test(s.pngSha256)));
    for (const s of ["start", "win"]) {
      await fs.access(path.join(ref, `${s}.png`));
      await fs.access(path.join(ref, `${s}.ui-rects.json`));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve: stamps the owning PROJECT root, and a legacy unstamped bundle still compares", async () => {
  // The bundle lives outside the game repo, so nothing about its location proves
  // which project it grades. The stamp is what lets unified `verify` refuse project
  // B's screens being compared against project A's approved layout.
  const root = await tmp("s6e-stamp-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);

    const manifestPath = path.join(ref, BASELINE_MANIFEST);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as BaselineManifest;
    assert.equal(manifest.projectRoot, path.resolve(root), "a new approval names the project it is for");

    // Schema tolerance: a bundle frozen before the field existed must still load and
    // compare exactly as before: an unstamped baseline is legacy, never tampering.
    delete (manifest as { projectRoot?: string }).projectRoot;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    const legacy = await loadBaselineManifest(ref);
    assert.equal(legacy.status, "ok", "a legacy manifest still loads");
    assert.equal(okManifest(legacy).projectRoot, undefined);
    const { code } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 0, "a legacy bundle still compares clean");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a clean re-compare PASSES (no regression)", async () => {
  const root = await tmp("s6e-clean-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 0);
    assert.equal(report.status, "pass");
    assert.equal(report.baseline?.present, true);
    assert.deepEqual(report.baseline?.regressions, []);
    assert.deepEqual(report.cr.baselineRegressions, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a visible PNG mutation is a BASELINE REGRESSION (exit 1, its own CR group)", async () => {
  const root = await tmp("s6e-regress-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    // Mutate the CURRENT 'win' png — paint the btn region black (unmasked).
    await fs.writeFile(path.join(caps, "win.png"), pngBuffer(W, H, paintRectBlack(BTN_RECT)));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 1, "a baseline regression blocks like a fail");
    assert.equal(report.status, "fail");
    assert.deepEqual(report.baseline?.regressions, ["win"]);
    // Its OWN tier — not a game defect, not a harness gap.
    assert.ok(report.cr.baselineRegressions.some((f) => f.source === "baseline" && f.state === "win"));
    assert.equal(report.cr.blockingFailures.length, 0, "a regression is not a game defect");
    assert.ok(!report.cr.incompleteHarness.some((f) => f.state === "win"), "a regression is not a harness gap");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LITMUS: a REFUSED baseline manifest cannot downgrade a real regression to 'not enforced'", async () => {
  // The loader refuses a half-stamped pair. When "refused" and "absent" were one `null`,
  // this door read it as "declared but not yet approved", printed "Baseline regression not
  // enforced", and a genuine pixel regression graded PASS at exit 0. Hand-deleting one
  // field off an approved manifest was therefore a way to switch the gate off silently.
  const root = await tmp("s6e-refused-");
  const ref = path.join(root, "baseline");
  try {
    await plantGitRepo(root, "git@github.com:Loomtide/game.git");
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);

    // A real, detected regression: the btn region of 'win' goes black, unmasked.
    await fs.writeFile(path.join(caps, "win.png"), pngBuffer(W, H, paintRectBlack(BTN_RECT)));
    const caught = await verify(root, contractPath, caps, path.join(root, "caught.json"));
    assert.equal(caught.code, 1, "control: with the manifest intact the regression is caught");

    // Now half-stamp the manifest, which is all it takes to make the loader refuse it.
    const manifestPath = path.join(ref, BASELINE_MANIFEST);
    const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    delete doc.projectPath;
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.notEqual(code, 0, "a refused anchor must never let the run come out green");
    assert.equal(code, 2, "…and it is a harness fault (tier 2), not a game defect");
    assert.equal(report.status, "incomplete");
    assert.match(String(report.baseline?.refused), /stamped together/, "the report names WHY the anchor was refused");
    assert.doesNotMatch(
      String(report.baseline?.note),
      /not yet approved/,
      "a manifest that EXISTS is never reported as one nobody has approved",
    );
    assert.deepEqual(report.baseline?.incompleteStates.sort(), ["start", "win"]);
    assert.equal(report.cr.blockingFailures.length, 0, "a refused anchor is not a game defect");
    assert.ok(
      report.cr.incompleteHarness.some((f) => f.source === "baseline" && /refused/.test(f.detail)),
      JSON.stringify(report.cr.incompleteHarness),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LITMUS: `baseline status` reports a REFUSED manifest as refused (exit 2), never as 'none approved'", async () => {
  const root = await tmp("s6e-refused-status-");
  const ref = path.join(root, "baseline");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await plantGitRepo(root, "git@github.com:Loomtide/game.git");
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    const manifestPath = path.join(ref, BASELINE_MANIFEST);
    const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    delete doc.repoIdentity;
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

    lines.length = 0;
    const code = await minigameRun(["baseline", "status", "--contract", contractPath, "--root", root]);
    assert.equal(code, 2, "a baseline that exists and cannot be read is not an exit-0 'nothing approved'");
    const out = lines.join("\n");
    assert.match(out, /is REFUSED/);
    assert.doesNotMatch(out, /no approved baseline/, "telling an operator to approve what already exists is a wrong answer");
  } finally {
    console.error = orig;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: the same mutation MASKED passes", async () => {
  const root = await tmp("s6e-masked-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref, ["dyn"]));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    // Mutate ONLY the masked 'dyn' region in the current 'win' png.
    await fs.writeFile(path.join(caps, "win.png"), pngBuffer(W, H, paintRectBlack(DYN_RECT)));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 0, "a change inside a masked region must not regress");
    assert.equal(report.status, "pass");
    assert.deepEqual(report.baseline?.regressions, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a rect drift (png unchanged) is a baseline regression", async () => {
  const root = await tmp("s6e-rect-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    // Move the 'btn' rect in the current 'win' ui-rects (png identical).
    const moved = captureObject("btn", BTN_RECT);
    (moved as Record<string, unknown>).viewportRect = { x: 0.6, y: BTN_RECT.y / H, width: BTN_RECT.width / W, height: BTN_RECT.height / H };
    await writeJson(path.join(caps, "win.ui-rects.json"), uiRectsBody("win", [moved, captureObject("dyn", DYN_RECT)]));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 1);
    assert.deepEqual(report.baseline?.regressions, ["win"]);
    assert.ok((report.baseline?.states.win.maxRectDrift ?? 0) > 0.02);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a CURRENT capture absent is INCOMPLETE, never a regression", async () => {
  const root = await tmp("s6e-curabsent-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    // Remove the current 'start' capture → captureAbsent.
    await fs.rm(path.join(caps, "start.ui-rects.json"));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 2, "a missing current capture is incomplete, not a regression");
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.baseline?.regressions, []);
    assert.equal(report.baseline?.states.start.compared, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * THE COUNTING GUARD (the audit's Finding 3), and WHY THE TEST ABOVE MISSED IT.
 *
 * The test above deletes `start.ui-rects.json`. That is the one of the two capture files
 * the gate runner's `captureAbsent` watches, so it proves the branch that already worked.
 * Nobody ever deleted the PNG alone, and the two absence predicates do not cover the same
 * set: `loadStateInputs` returns null on a missing PNG **or** missing rects, while
 * `captureAbsent` fires on the rects alone. A state with readable rects and no PNG was
 * therefore pushed `compared: false` into NEITHER `regressions` NOR `incompleteStates`
 * and fell out of the run entirely.
 *
 * That is the suite-wide pattern the audit named: the tests ask "does this gate produce
 * the right verdict when it runs?" and never "did it run at all?". Both existing absence
 * tests grade a gate that DID run. This one grades a gate that did not.
 *
 * The scenario is the audit's: an approved baseline whose `start` frame is half black (a
 * ~50% diff, 25x the 2% threshold, against the white frame the game now renders) plus a
 * DELETED current `start.png`. Before the counting fix this produced `exitCode 0`,
 * `status "pass"`, `regressions []`.
 *
 * THE HALF-BLACK BASELINE IS APPROVED, NOT WRITTEN OVER (F1). The audit's own script edited
 * `ref/start.png` in place, which `verifyScreensBundle`'s re-hash now refuses as a tampered
 * anchor before any counting happens, and a counting guard whose fixture is rejected on
 * other grounds is a vacuous counting guard. So the half-black frame is CAPTURED and
 * approved (the sha is stamped for it), then the game's current frame goes back to white:
 * the same ~50% divergence, on an anchor with clean integrity.
 *
 * LITMUS, run 2026-08-12. `compareToBaseline`'s `comparisons` stamp deleted (which is
 * exactly the pre-fix code: the per-state loop and its `continue` are untouched by this
 * change, so the ONLY thing the fix adds is the count), rebuilt, re-run:
 *
 *   ✖ MOAT: a state whose PNG is gone but whose RECTS load must never reach exit 0 (10.822833ms)
 *     AssertionError [ERR_ASSERTION]: a comparison that did not happen is the HARNESS tier, never exit 0
 *
 *     0 !== 2
 *
 *   ℹ pass 21
 *   ℹ fail 5
 *
 * `0 !== 2` IS the audit's finding: a ~50% pixel diff against the approved anchor, and
 * the tool exits 0. (The other four are this file's sibling counting assertions, which
 * read the same stamp; only this one is a false GREEN.) Restored: 26 pass, 0 fail.
 */
test("MOAT: a state whose PNG is gone but whose RECTS load must never reach exit 0", async () => {
  const root = await tmp("s6e-png-only-gap-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);

    // POSITIVE CONTROL: the untouched pack compares clean and green.
    const control = await verify(root, contractPath, caps, path.join(root, "control.json"));
    assert.equal(control.code, 0, "control: a clean pack passes");

    // BREAK, both halves of the audit's scenario:
    //  1. the APPROVED 'start' frame is half black, so a comparison that HAPPENED would be
    //     a loud regression against the white frame the game renders now. Captured and
    //     re-approved rather than written over the bundle, so the anchor's integrity is
    //     clean and this test grades the COUNT and nothing else;
    //  2. the CURRENT 'start.png' is deleted while its rects stay readable, so the
    //     comparison does not happen and `captureAbsent` never fires.
    await fs.writeFile(
      path.join(caps, "start.png"),
      pngBuffer(W, H, (x, y) => (y < H / 2 ? [0, 0, 0] : WHITE)),
    );
    assert.equal(await approve(root, contractPath, caps), 0, "the half-black frame is APPROVED, not injected");
    await fs.rm(path.join(caps, "start.png"));

    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 2, "a comparison that did not happen is the HARNESS tier, never exit 0");
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.baseline?.regressions, [], "…and never a game/regression verdict either");
    assert.deepEqual(
      report.baseline?.comparisons,
      { expected: 2, performed: 1, ungraded: ["start"] },
      "the report says on disk how many comparisons it owed and how many it made",
    );
    // Named per state, in the harness bucket: "1 of 2" says the gate is broken, "start"
    // says what to re-capture.
    assert.ok(
      report.cr.incompleteHarness.some(
        (f) => f.source === "baseline" && f.state === "start" && f.detail.includes("COMPARED NOTHING"),
      ),
      `the ungraded state must be named: ${JSON.stringify(report.cr.incompleteHarness)}`,
    );

    // RESTORE the current PNG: the comparison happens, and now it is the REGRESSION the
    // half-black baseline always was. This is what proves the guard did not simply make
    // everything fail.
    await fs.writeFile(path.join(caps, "start.png"), pngBuffer(W, H, white));
    const restored = await verify(root, contractPath, caps, path.join(root, "restored.json"));
    assert.equal(restored.code, 1, "compared at last: a real regression, the game tier");
    assert.deepEqual(restored.report.baseline?.regressions, ["start"]);
    assert.deepEqual(restored.report.baseline?.comparisons, { expected: 2, performed: 2, ungraded: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the denominator is the ANCHOR's states, so a state nobody approved is no shortfall", async () => {
  // THE FALSE-FAILURE HALF of the counting rule, and the reason the denominator is the
  // MANIFEST's `states[]` rather than the contract's. `approve` SKIPS a state with no
  // capture (an outcome-gated screen a read-only verifier cannot drive), so the contract
  // declares states the anchor never froze. Counting the contract would report a
  // permanent shortfall on every run of such a project, and a gate that cries wolf about
  // states nobody approved is a gate people learn to route around.
  //
  // LITMUS, run 2026-08-12. The denominator switched to `contract.states`, rebuilt, re-run:
  //
  //   ✖ the denominator is the ANCHOR's states, so a state nobody approved is no shortfall
  //     AssertionError [ERR_ASSERTION]: the anchor declares ONE state, and this run compared it
  //
  //   ℹ pass 22
  //   ℹ fail 1
  //
  // (the run also flips to exit 2 there: a project with one outcome-gated screen would
  // have been permanently red.) Restored: 23 pass, 0 fail.
  const root = await tmp("s6e-partial-anchor-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    // 'win' is OUTCOME-GATED: not asserted by design, never captured, never bundled.
    await writeJson(
      contractPath,
      assertValidMinigameContract({
        ...makeContract(ref),
        states: [
          { id: "start", kind: "start", requiredInFrame: ["btn"] },
          { id: "win", kind: "success_reward", requiredInFrame: ["btn", "dyn"], outcomeGated: true },
        ],
      }),
    );
    const caps = path.join(root, "caps");
    await writeState(caps, "start", [captureObject("btn", BTN_RECT)], pngBuffer(W, H, white));
    assert.equal(await approve(root, contractPath, caps), 0);

    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.deepEqual(
      report.baseline?.comparisons,
      { expected: 1, performed: 1, ungraded: [] },
      "the anchor declares ONE state, and this run compared it",
    );
    assert.deepEqual(report.baseline?.regressions, []);
    assert.equal(code, 0, "a project with an outcome-gated state must not be permanently red");
    assert.ok(
      !report.cr.incompleteHarness.some((f) => f.source === "baseline" && f.detail.includes("COMPARED NOTHING")),
      `no phantom baseline shortfall: ${JSON.stringify(report.cr.incompleteHarness)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * F1 — SHRINKING THE DENOMINATOR (the adversary's attack on the counting fix above).
 *
 * Counting comparisons closed "skip the check". It opened "shrink what you owe". The
 * screens denominator is `manifest.states`, and `loadBaselineManifest` used to parse the
 * file, check `kind`, check the repoIdentity/projectPath pair, and stop. Nothing walked the
 * `<id>.png` files sitting beside it, so deleting one line from `states[]` made the gate
 * stop owing a comparison it had just been caught skipping. The frozen `start.png` is still
 * on disk in both directories; the run simply no longer mentions it.
 *
 * Demonstrated end to end (real approve, real `runVerifyMinigame`), on the exact fixture the
 * test above uses:
 *
 *   control-clean:           exit=0 pass        comparisons={expected:2, performed:2}
 *   the test above:          exit=2 incomplete  comparisons={expected:2, performed:1, ungraded:["start"]}
 *   attack-manifest-trimmed: exit=0 pass        comparisons={expected:1, performed:1}
 *
 * The fix mirrors `verifyTraceBaseline` (`replay/trace-baseline-manifest.ts`), which has
 * done both halves for the trace baseline all along: re-hash every declared PNG against its
 * stamped `pngSha256`, and sweep the directory for bundle files the manifest does NOT
 * declare. The sweep is the half that catches THIS attack, because the trimmed state's files
 * are still there.
 *
 * LITMUS, run 2026-08-12. The undeclared sweep removed from `verifyScreensBundle` (the
 * re-hash left in place, so this is precisely "one of the two halves"), rebuilt, re-run:
 *
 *   ✖ MOAT (F1): trimming a state out of the approved manifest must not shrink the denominator (20.193084ms)
 *     AssertionError [ERR_ASSERTION]: a hand-trimmed anchor is a REFUSED anchor, never a smaller one
 *
 *     0 !== 2
 *
 *   ℹ pass 25
 *   ℹ fail 1
 *
 * `0 !== 2` is the attack reaching exit 0. Restored: 26 pass, 0 fail.
 */
test("MOAT (F1): trimming a state out of the approved manifest must not shrink the denominator", async () => {
  const root = await tmp("s6e-trimmed-anchor-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);

    // POSITIVE CONTROL: the untouched bundle passes, and owes two comparisons.
    const control = await verify(root, contractPath, caps, path.join(root, "control.json"));
    assert.equal(control.code, 0, "control: a clean pack passes");
    assert.deepEqual(control.report.baseline?.comparisons, { expected: 2, performed: 2, ungraded: [] });

    // The audit's fixture: an APPROVED half-black 'start' frame (a ~50% diff, 25x the
    // threshold, against the white frame the game renders now) plus a deleted CURRENT
    // 'start.png'. The counting fix catches this as a shortfall. The frame is captured and
    // re-approved rather than written into the bundle, so the anchor's integrity is clean
    // and the attack below is the only thing this test is measuring.
    await fs.writeFile(
      path.join(caps, "start.png"),
      pngBuffer(W, H, (x, y) => (y < H / 2 ? [0, 0, 0] : WHITE)),
    );
    assert.equal(await approve(root, contractPath, caps), 0);
    await fs.rm(path.join(caps, "start.png"));
    const caught = await verify(root, contractPath, caps, path.join(root, "caught.json"));
    assert.equal(caught.code, 2, "the counting fix: a comparison that did not happen is the harness tier");
    assert.deepEqual(caught.report.baseline?.comparisons, { expected: 2, performed: 1, ungraded: ["start"] });

    // THE ATTACK: hand-edit `start` out of the manifest's `states[]`. Nothing else moves —
    // `start.png` and `start.ui-rects.json` are still in the bundle, and the rects the
    // gate runner reads are untouched, so every other gate still passes.
    const manifestPath = path.join(ref, BASELINE_MANIFEST);
    const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as BaselineManifest;
    const trimmed = { ...doc, states: doc.states.filter((s) => s.id !== "start") };
    assert.deepEqual(trimmed.states.map((s) => s.id), ["win"], "the fixture really did shrink the anchor");
    await fs.writeFile(manifestPath, JSON.stringify(trimmed, null, 2), "utf-8");

    const attack = await verify(root, contractPath, caps, path.join(root, "attack.json"));
    assert.equal(attack.code, 2, "a hand-trimmed anchor is a REFUSED anchor, never a smaller one");
    assert.equal(attack.report.status, "incomplete");
    assert.deepEqual(attack.report.baseline?.regressions, [], "harness fault is never a game defect");
    assert.equal(
      attack.report.baseline?.comparisons,
      undefined,
      "a refused manifest states no denominator at all: `anchored: false` by construction",
    );
    assert.match(
      attack.report.baseline?.refused ?? "",
      /start\.png' is not declared/,
      `the refusal must name the undeclared file: ${JSON.stringify(attack.report.baseline?.refused)}`,
    );

    // RESTORE the manifest: the bundle grades again (and is the shortfall it always was).
    // This is what proves the guard did not simply make every baseline fail.
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
    const restored = await verify(root, contractPath, caps, path.join(root, "restored.json"));
    assert.deepEqual(restored.report.baseline?.comparisons, { expected: 2, performed: 1, ungraded: ["start"] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * F1b — THE OTHER HALF: `pngSha256` was WRITE-ONLY.
 *
 * It is stamped at approve (`writeBaselineBundle`) and, before this change, read nowhere in
 * the capability: every other `pngSha256` in the tree belongs to the design-target hero
 * shot, a different artifact. A stamped-and-never-checked field on an anchor is the
 * "defined but not wired" shape CLAUDE.md calls a finding on its own, and it is what let an
 * operator RE-FREEZE the anchor to match a regressed capture without ever running
 * `baseline approve`: swap both frames for the same new bytes and the perceptual diff is
 * zero, so the run is green against an anchor no human approved.
 *
 * LITMUS, run 2026-08-12. The re-hash loop removed from `verifyScreensBundle` (the
 * undeclared sweep left in place), rebuilt, re-run:
 *
 *   ✖ MOAT (F1b): a declared state whose PNG bytes changed since approve is refused (8.321833ms)
 *     AssertionError [ERR_ASSERTION]: a re-frozen anchor is not an approved anchor
 *
 *     0 !== 2
 *
 *   ℹ pass 25
 *   ℹ fail 1
 *
 * Restored: 26 pass, 0 fail.
 */
test("MOAT (F1b): a declared state whose PNG bytes changed since approve is refused", async () => {
  const root = await tmp("s6e-reswapped-frame-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    assert.equal((await verify(root, contractPath, caps, path.join(root, "control.json"))).code, 0);

    // THE ATTACK: 'start' regressed to a half-black frame, so re-freeze the BASELINE to the
    // same bytes. Both files exist, both are declared, the diff is exactly zero.
    const regressed = pngBuffer(W, H, (x, y) => (y < H / 2 ? [0, 0, 0] : WHITE));
    await fs.writeFile(path.join(caps, "start.png"), regressed);
    await fs.writeFile(path.join(ref, "start.png"), regressed);

    const attack = await verify(root, contractPath, caps, path.join(root, "attack.json"));
    assert.equal(attack.code, 2, "a re-frozen anchor is not an approved anchor");
    assert.equal(attack.report.status, "incomplete");
    assert.deepEqual(attack.report.baseline?.regressions, []);
    assert.match(
      attack.report.baseline?.refused ?? "",
      /start\.png' sha256 mismatch/,
      `the refusal must name the edited frame: ${JSON.stringify(attack.report.baseline?.refused)}`,
    );

    // The honest path: `baseline approve` re-stamps the sha, and the bundle grades again.
    assert.equal(await approve(root, contractPath, caps), 0);
    const reapproved = await verify(root, contractPath, caps, path.join(root, "reapproved.json"));
    assert.equal(reapproved.code, 0, "re-approving is the change path, and it works");
    assert.deepEqual(reapproved.report.baseline?.comparisons, { expected: 2, performed: 2, ungraded: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F1 false-failure check: re-approving PRUNES a state the new bundle no longer declares", async () => {
  // The undeclared sweep would turn a real project permanently red if `approve` could leave
  // a stale `<id>.png` behind: mark a state outcome-gated (or lose its capture) and
  // re-approve, and the previous run's files would sit in the bundle undeclared forever.
  // `writeBaselineBundle` prunes them, exactly as `trace baseline approve` already does.
  //
  // OBSERVED BEFORE THE PRUNE EXISTED, which is why this is not a hypothetical: this test
  // failed on the very first run, against the sweep alone.
  //
  // LITMUS, run 2026-08-12. The `pruneUndeclaredBundleFiles` call in `writeBaselineBundle`
  // replaced with an empty list, rebuilt, re-run:
  //
  //   ✖ F1 false-failure check: re-approving PRUNES a state the new bundle no longer declares (5.703166ms)
  //     AssertionError [ERR_ASSERTION]: Missing expected rejection: the stale frame is pruned, not left undeclared
  //
  //   ℹ pass 25
  //   ℹ fail 1
  //
  // Restored: 26 pass, 0 fail.
  const root = await tmp("s6e-prune-stale-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    await fs.access(path.join(ref, "win.png"));

    // 'win' becomes outcome-gated: never captured, never bundled from here on.
    await writeJson(
      contractPath,
      assertValidMinigameContract({
        ...makeContract(ref),
        states: [
          { id: "start", kind: "start", requiredInFrame: ["btn"] },
          { id: "win", kind: "success_reward", requiredInFrame: ["btn", "dyn"], outcomeGated: true },
        ],
      }),
    );
    await fs.rm(path.join(caps, "win.png"));
    await fs.rm(path.join(caps, "win.ui-rects.json"));
    await fs.rm(path.join(caps, "win.console.json"));
    assert.equal(await approve(root, contractPath, caps), 0);

    await assert.rejects(fs.access(path.join(ref, "win.png")), "the stale frame is pruned, not left undeclared");
    await assert.rejects(fs.access(path.join(ref, "win.ui-rects.json")));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 0, "an outcome-gated state must not make the project permanently red");
    assert.deepEqual(report.baseline?.comparisons, { expected: 1, performed: 1, ungraded: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a BASELINE state file missing is INCOMPLETE, never a silent pass", async () => {
  const root = await tmp("s6e-baseabsent-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    // Corrupt the baseline by deleting the 'win' baseline png (current is present + clean).
    await fs.rm(path.join(ref, "win.png"));
    const { code, report } = await verify(root, contractPath, caps, path.join(root, "r.json"));
    assert.equal(code, 2, "an unreadable baseline cannot be compared → incomplete");
    assert.equal(report.status, "incomplete");
    assert.ok(report.baseline?.incompleteStates.includes("win"));
    assert.deepEqual(report.baseline?.regressions, []);
    assert.ok(report.cr.incompleteHarness.some((f) => f.source === "baseline" && f.state === "win"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve: an outcome-gated state with NO capture succeeds; manifest bundles only captured states", async () => {
  // Regression for the ENOENT crash: writeBaselineBundle used to read EVERY declared
  // state's <state>.png, but outcome-gated states are never captured by design, so the
  // read threw and left a half-written bundle (state files copied, no manifest).
  const root = await tmp("s6e-gated-");
  const ref = path.join(root, "baseline");
  try {
    const contractPath = path.join(root, "c.json");
    // Mark 'win' (a success_reward) outcome-gated — read-only can't drive its outcome.
    const contract = assertValidMinigameContract({
      ...makeContract(ref),
      states: [
        { id: "start", kind: "start", requiredInFrame: ["btn"] },
        { id: "win", kind: "success_reward", requiredInFrame: ["btn", "dyn"], outcomeGated: true },
      ],
    });
    await writeJson(contractPath, contract);
    const caps = path.join(root, "caps");
    // Only the non-gated 'start' state is captured; 'win' has NO png/ui-rects at all.
    await writeState(caps, "start", [captureObject("btn", BTN_RECT)], pngBuffer(W, H, white));
    const code = await approve(root, contractPath, caps);
    assert.equal(code, 0, "an outcome-gated state without a capture must not crash the approve");
    const manifest = JSON.parse(await fs.readFile(path.join(ref, BASELINE_MANIFEST), "utf-8")) as BaselineManifest;
    // The manifest + bundle contain ONLY the captured (non-gated) state.
    assert.deepEqual(manifest.states.map((s) => s.id), ["start"]);
    await fs.access(path.join(ref, "start.png"));
    await fs.access(path.join(ref, "start.ui-rects.json"));
    // The gated state was never bundled.
    await assert.rejects(fs.access(path.join(ref, "win.png")), "an uncaptured gated state is not bundled");
    await assert.rejects(fs.access(path.join(ref, "win.ui-rects.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve inside a git checkout stamps the PORTABLE pair; a HALF pair is refused (LITMUS)", async () => {
  // S1 of the artifact-storage RFC: an approved layout baseline has to survive being
  // COMMITTED and read from a teammate's checkout, which the absolute `projectRoot`
  // alone cannot do. The pair is derived by the writer, so an approve cannot forget it.
  const root = await tmp("s6e-portable-");
  const ref = path.join(root, "baseline");
  try {
    await plantGitRepo(root, "git@github.com:Loomtide/game.git");
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);

    const stamped = okManifest(await loadBaselineManifest(ref));
    assert.equal(stamped.repoIdentity, "github.com/Loomtide/game");
    assert.equal(stamped.projectPath, ".", "the project IS the toplevel in this fixture");
    assert.equal(stamped.projectRoot, path.resolve(root), "the absolute stamp still travels with it");

    // LITMUS: drop ONE half of the pair. A repoIdentity with no projectPath would claim
    // any position inside the repo, so the loader must refuse the manifest outright
    // rather than ignore the odd field.
    const manifestPath = path.join(ref, BASELINE_MANIFEST);
    const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    for (const dropped of ["projectPath", "repoIdentity"] as const) {
      const half = { ...doc };
      delete half[dropped];
      await fs.writeFile(manifestPath, JSON.stringify(half, null, 2), "utf-8");
      const load = await loadBaselineManifest(ref);
      assert.equal(load.status, "refused", `a manifest missing '${dropped}' is refused, not defaulted`);
      assert.match(
        String((load as { reason?: string }).reason),
        /stamped together/,
        "REFUSED is not ABSENT: the reason names the half pair so no caller can read it as 'not approved yet'",
      );
    }
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");
    assert.equal((await loadBaselineManifest(ref)).status, "ok", "control: the complete pair loads");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("minigame baseline status: prints the manifest summary", async () => {
  const root = await tmp("s6e-status-");
  const ref = path.join(root, "baseline");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref, ["dyn"]));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);
    assert.equal(await approve(root, contractPath, caps), 0);
    const code = await minigameRun(["baseline", "status", "--contract", contractPath, "--root", root]);
    assert.equal(code, 0);
    const out = lines.join("\n");
    assert.match(out, /baseline for 'baseline-game'/);
    assert.match(out, /start, win/);
    assert.match(out, /masks: dyn/);
  } finally {
    console.error = orig;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("minigame baseline status: reports 'no baseline' when none approved (exit 0)", async () => {
  const root = await tmp("s6e-nostatus-");
  const ref = path.join(root, "baseline");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const code = await minigameRun(["baseline", "status", "--contract", contractPath, "--root", root]);
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /no approved baseline/);
  } finally {
    console.error = orig;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("baseline approve WARNS when it stamps a cwd-derived project root (the guided flow prints no --root)", async () => {
  // `minigame next` builds its commands from a WORKSPACE, which knows nothing about where
  // the game repo is, so the printed `baseline approve` carries no --root and the ownership
  // stamp silently becomes the shell's cwd. A wrong stamp surfaces much later as unified
  // `verify` refusing the bundle as another project's, so say it at approval time instead.
  const root = await tmp("s6e-cwdstamp-");
  const ref = path.join(root, "baseline");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const contractPath = path.join(root, "c.json");
    await writeJson(contractPath, makeContract(ref));
    const caps = path.join(root, "caps");
    await writeCleanPack(caps);

    // No --root: the warning fires, and it names the directory it is about to stamp.
    assert.equal(
      await minigameRun(["baseline", "approve", "--contract", contractPath, "--captures", caps, "--ref", ref]),
      0,
    );
    const warned = lines.filter((l) => /no --root given: stamping this baseline/.test(l));
    assert.equal(warned.length, 1, lines.join("\n"));
    assert.ok(warned[0]!.includes(process.cwd()), "the warning must name the root it is stamping");
    const manifest = okManifest(await loadBaselineManifest(ref));
    assert.equal(manifest.projectRoot, path.resolve(process.cwd()));

    // With --root: no warning, and the stamp is the project that was named.
    lines.length = 0;
    assert.equal(await approve(root, contractPath, caps), 0);
    assert.ok(!lines.some((l) => /no --root given/.test(l)), lines.join("\n"));
    assert.equal(okManifest(await loadBaselineManifest(ref)).projectRoot, path.resolve(root));
  } finally {
    console.error = orig;
    await fs.rm(root, { recursive: true, force: true });
  }
});
