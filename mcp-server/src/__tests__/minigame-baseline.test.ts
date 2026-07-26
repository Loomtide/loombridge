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

import { assertValidMinigameContract } from "../capabilities/minigame/profiles/validator.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";
import { runVerifyMinigame, type MinigameVerifyReport } from "../capabilities/minigame/verify-minigame.js";
import { run as minigameRun } from "../capabilities/minigame/minigame.js";
import {
  BASELINE_MANIFEST,
  compareStateToBaseline,
  type BaselineManifest,
  type BaselineStateInputs,
} from "../capabilities/minigame/minigame-baseline.js";
import type { DecodedImage } from "../capabilities/minigame/frame-facts.js";
import type { MinigameCaptureObject } from "../capabilities/minigame/types.js";

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
