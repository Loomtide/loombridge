/**
 * PIXEL MASKS on a trace baseline, and why every one of these tests exists.
 *
 * A tolerance is a hole of a stated size ANYWHERE in the frame. A mask is a NAMED region
 * that is never graded again. The second is strictly more dangerous, so everything that
 * makes it survivable is pinned here:
 *
 *  - the masked area is capped PER FRAME, on BOTH sides, through ONE predicate, so a
 *    hand-edited "mask the whole frame" is a broken anchor rather than a green gate;
 *  - the masks are BLANKED in both images (never excluded from the denominator), so a
 *    stamped tolerance keeps the exact meaning it was consented to;
 *  - every rect carries a human REASON, and the stamp restates the WHOLE list, so a mask
 *    set cannot grow one unnoticed rect at a time;
 *  - the tool never suggests a mask from ONE run: an identical drift twice is a
 *    deterministic change, and masking it would erase the finding;
 *  - a dims mismatch at grade time is a manifest-level harness fault, never a per-capture
 *    "unreadable", and never a silent re-interpretation of a human's rects.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { readFileSync } from "node:fs";

import {
  applyVisualDiff,
  driftFacts,
  parseMaskRectSpec,
  printSummary,
  replayExitCode,
  run,
  shouldSuggestTolerance,
} from "../../../../capabilities/replay/trace.js";
import {
  CARRIED_MANIFEST_KEYS,
  MANIFEST_KEY_DECISIONS,
  TRACE_BASELINE_MANIFEST,
  carryForward,
  isTraceBaselineManifestError,
  loadTraceBaselineManifest,
  type TraceBaselineManifest,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import {
  DEFAULT_DRIFT_FRACTION,
  DETERMINISTIC_DRIFT_WARNING,
  MAX_MASKED_FRACTION,
  MIN_CLUSTER_TIGHTNESS,
  REPRODUCED_DRIFT_SIMILARITY,
  anchorTermsSentence,
  asDriftGrid,
  clusterDriftRects,
  combinedBlindnessClause,
  comparePerceptual,
  deriveMaskSuggestion,
  driftGridOf,
  driftGridSimilarity,
  driftRegressionLine,
  driftSuggestionLines,
  formatMaskSetFlag,
  maskAnchorTerms,
  maskRefusal,
  maskSuggestionLines,
  maskedFractionFor,
  type MaskRect,
} from "../../../../capabilities/replay/visual-diff.js";
import { renderReplayReportHtml } from "../../../../capabilities/replay/report-html.js";
import { discoverVerificationAssets } from "../../../../capabilities/verification/unified/discovery.js";
import { planLines } from "../../../../capabilities/verification/unified/orchestrator.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import { PKG_ROOT } from "../../../_support/paths.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const W = 100;
const H = 100;
/** 100x100 = 10000 px, so a rect's pixel count IS its percentage times 100. */
const FRAME_PIXELS = W * H;

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "trace-masks-"));
}

async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.error = real;
  }
}

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

/** RGBA bytes for a WxH white frame with `rects` painted black. */
function pixelsWithRects(
  rects: readonly { x: number; y: number; w: number; h: number }[],
  width = W,
  height = H,
): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return data;
}

/**
 * RGBA for a white frame with `rects` black and individual pixels set to a chosen grey.
 * The grey matters: the drift threshold is perceptual, so 229 and 228 are on opposite
 * sides of it (MX1's attack matrix turns on exactly that).
 */
function pixelsWith(
  rects: readonly { x: number; y: number; w: number; h: number }[],
  points: readonly { x: number; y: number; v: number }[] = [],
): Uint8Array {
  const data = pixelsWithRects(rects);
  for (const p of points) {
    const i = (p.y * W + p.x) * 4;
    data[i] = p.v;
    data[i + 1] = p.v;
    data[i + 2] = p.v;
    data[i + 3] = 255;
  }
  return data;
}

/** A real PNG of the same frame, so the on-disk path decodes what the pure path compares. */
function pngWithRects(
  rects: readonly { x: number; y: number; w: number; h: number }[],
  width = W,
  height = H,
): Buffer {
  return pngOf(pixelsWithRects(rects, width, height), width, height);
}

function pngOf(rgba: Uint8Array, width = W, height = H): Buffer {
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
      const i = (y * width + x) * 4;
      raw[o++] = rgba[i]!;
      raw[o++] = rgba[i + 1]!;
      raw[o++] = rgba[i + 2]!;
      raw[o++] = rgba[i + 3]!;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function image(rects: readonly { x: number; y: number; w: number; h: number }[]) {
  return { width: W, height: H, data: pixelsWithRects(rects) };
}

/** A drift bitmap with `rects` marked drifted, the input the grid is a coarsening of. */
function bitmapOfRects(rects: readonly { x: number; y: number; w: number; h: number }[]): Uint8Array {
  const bitmap = new Uint8Array(FRAME_PIXELS);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) bitmap[y * W + x] = 1;
    }
  }
  return bitmap;
}

/** The structural fingerprint of a drift shaped like `rects`, via the REAL grid function. */
function gridOfRects(rects: readonly { x: number; y: number; w: number; h: number }[]): number[] {
  return driftGridOf(bitmapOfRects(rects), W, H);
}

async function writeTrace(root: string, id: string): Promise<void> {
  const traces = standardReplayLayout(root).replayTraces;
  await fs.mkdir(traces, { recursive: true });
  await fs.writeFile(
    path.join(traces, `${id}.trace.json`),
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

function actualPngPath(root: string, id: string, capture = "cap"): string {
  return path.join(standardReplayLayout(root).replayReports, id, "actual", `${capture}.png`);
}

async function writeReport(root: string, id: string, captureIds: string[]): Promise<void> {
  const reports = standardReplayLayout(root).replayReports;
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(
    path.join(reports, `${id}.report.json`),
    `${JSON.stringify(artifactFor(root, id, captureIds), null, 2)}\n`,
  );
}

function artifactFor(root: string, id = "demo", captureIds = ["cap"]): ReplayRunArtifact {
  return {
    traceId: id,
    status: "pass",
    resetTier: "scene-load",
    segments: [
      {
        id: "s",
        status: "pass",
        anchorsReached: [],
        captures: captureIds.map((c) => ({ id: c, artifact: actualPngPath(root, id, c) })),
      },
    ],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "t",
    finishedAt: "t",
    durationMs: 1,
  };
}

/** A project with an APPROVED all-white baseline, promoted through the real verb. */
async function approvedProject(id = "demo", captureIds = ["cap"]): Promise<string> {
  const root = await tmpRoot();
  for (const capture of captureIds) {
    const actual = actualPngPath(root, id, capture);
    await fs.mkdir(path.dirname(actual), { recursive: true });
    await fs.writeFile(actual, pngWithRects([]));
  }
  await writeTrace(root, id);
  await writeReport(root, id, captureIds);
  const approved = await captured(() => run(["approve", "--id", id, "--root", root]));
  assert.equal(approved.code, 0, approved.out);
  return root;
}

async function readManifest(root: string, id = "demo"): Promise<TraceBaselineManifest> {
  const loaded = await loadTraceBaselineManifest(path.join(standardReplayLayout(root).replayBaselines, id));
  assert.ok(
    loaded !== null && !isTraceBaselineManifestError(loaded),
    `expected a readable manifest: ${JSON.stringify(loaded)}`,
  );
  return loaded;
}

async function editManifest(root: string, patch: Record<string, unknown>, id = "demo"): Promise<void> {
  const file = path.join(standardReplayLayout(root).replayBaselines, id, TRACE_BASELINE_MANIFEST);
  const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  await fs.writeFile(file, JSON.stringify({ ...parsed, ...patch }, null, 2));
}

/** Grade the current on-disk state, returning the artifact the run would have written. */
async function grade(root: string, id = "demo", captureIds = ["cap"]): Promise<{ artifact: ReplayRunArtifact; out: string }> {
  const artifact = artifactFor(root, id, captureIds);
  const { out } = await captured(async () => {
    await applyVisualDiff(standardReplayLayout(root), id, artifact);
    return 0;
  });
  return { artifact, out };
}

// ── THE CAP: one predicate, both sides ───────────────────────────────────────

test("the mask cap is ONE predicate: the same sentence refuses at the stamp and inside the reader", async () => {
  // 40% of the frame, the "mask the whole game" move at a plausible-looking scale.
  const overCap = [{ x: 0, y: 0, w: 100, h: 40, reason: "ambient" }];
  const stampSide = maskRefusal(overCap, W, H);
  assert.ok(stampSide !== null);
  assert.match(stampSide, /hides 40% of the frame for every capture, above the 10% cap/);

  const root = await approvedProject();
  try {
    // STAMP SIDE, through the real door.
    const before = await readManifest(root);
    const refused = await captured(() =>
      run(["mask", "--id", "demo", "--root", root, "--set", "0,0,100x40@ambient"]),
    );
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /above the 10% cap/);
    assert.match(refused.out, /nothing was stamped/);
    const after = await readManifest(root);
    assert.equal(after.maskRects, undefined, "a refused rect never reaches the anchor");
    assert.equal(after.approvedAt, before.approvedAt, "…and the anchor is not even re-stamped");

    // READ SIDE, on a manifest hand-edited past the verb entirely.
    await editManifest(root, {
      frameWidth: W,
      frameHeight: H,
      maskRects: [{ x: 0, y: 0, w: 100, h: 100, reason: "everything" }],
    });
    const loaded = await loadTraceBaselineManifest(path.join(standardReplayLayout(root).replayBaselines, "demo"));
    assert.ok(isTraceBaselineManifestError(loaded), "a full-frame mask must be a typed error, not a manifest");
    assert.match(loaded.error, /hides 100% of the frame for every capture, above the 10% cap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MASK-EVERYTHING through the REAL door: the trace row is BROKEN in unified verify", async () => {
  const root = await approvedProject();
  const workspace = await tmpRoot();
  try {
    await editManifest(root, {
      frameWidth: W,
      frameHeight: H,
      maskRects: [{ x: 0, y: 0, w: 100, h: 100, reason: "everything" }],
    });
    const { assets } = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = assets.find((a) => a.kind === "trace")!;
    assert.equal(row.runnable, "no", "an anchor that grades nothing never executes");
    assert.equal(row.notRunClass, "broken", "…and it is BROKEN (tier 2), not a quiet full-frame pass");
    assert.match(row.broken ?? "", /above the 10% cap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("exactly AT the cap is allowed; the cap is per FRAME, so scoped and trace-wide rects add up", () => {
  // 10% exactly: the comparison is `> cap`, matching the tolerance's own consent grammar.
  assert.equal(maskRefusal([{ x: 0, y: 0, w: 100, h: 10, reason: "hud clock" }], W, H), null);
  assert.notEqual(maskRefusal([{ x: 0, y: 0, w: 100, h: 11, reason: "hud clock" }], W, H), null);

  // 6% for everyone + 6% more on ONE capture = 12% of THAT frame: refused, and the
  // refusal names the capture whose frame went over, not the list.
  const mixed: MaskRect[] = [
    { x: 0, y: 0, w: 100, h: 6, reason: "hud" },
    { x: 0, y: 50, w: 100, h: 6, reason: "sparkles", captureId: "cap2" },
  ];
  const refusal = maskRefusal(mixed, W, H);
  assert.ok(refusal !== null);
  assert.match(refusal, /12% of the frame for capture 'cap2'/);
  // The trace-wide half alone is fine, which is exactly why the per-frame sum is the
  // question: a cap applied to the list as a whole would have passed this.
  assert.equal(maskRefusal([mixed[0]!], W, H), null);
});

test("overlapping rects spend the cap ONCE (union area), so a duplicate is not a double charge", () => {
  const twice: MaskRect[] = [
    { x: 0, y: 0, w: 100, h: 8, reason: "hud" },
    { x: 0, y: 0, w: 100, h: 8, reason: "hud again" },
  ];
  assert.equal(maskedFractionFor(twice, undefined, W, H), 0.08);
  assert.equal(maskRefusal(twice, W, H), null, "the same 8% counted twice would have been refused at 16%");
});

test("REFUSE-ON-ABSENT-BINDING: masks with no stamped frame dims are refused, never measured as 0", () => {
  const rects = [{ x: 0, y: 0, w: 10, h: 10, reason: "ambient" }];
  for (const [w, h] of [[undefined, undefined], [W, undefined], [undefined, H], [0, H], [W, -1]] as const) {
    const refusal = maskRefusal(rects, w as number | undefined, h as number | undefined);
    assert.ok(
      refusal !== null,
      `expected dims ${String(w)}x${String(h)} to be refused rather than silently skipping the cap`,
    );
  }
  // The absence of the RECTS is the only absence that resolves: no masks is the
  // strictest value the field can hold.
  assert.equal(maskRefusal(undefined, undefined, undefined), null);
  assert.equal(maskRefusal([], undefined, undefined), null);
});

test("the read side refuses malformed rects by TYPE, and out-of-bounds by geometry", () => {
  assert.match(maskRefusal("0,0,10x10", W, H) ?? "", /must be an array/);
  assert.match(maskRefusal([{ x: 0, y: 0, w: 10 }], W, H) ?? "", /\.h' must be an integer/);
  assert.match(maskRefusal([{ x: 0, y: 0, w: 10.5, h: 10, reason: "r" }], W, H) ?? "", /\.w' must be an integer/);
  assert.match(maskRefusal([{ x: 0, y: 0, w: 0, h: 10, reason: "r" }], W, H) ?? "", /positive w and h/);
  assert.match(maskRefusal([{ x: 95, y: 0, w: 10, h: 10, reason: "r" }], W, H) ?? "", /falls outside the 100x100 frame/);
  assert.match(maskRefusal([{ x: -1, y: 0, w: 5, h: 5, reason: "r" }], W, H) ?? "", /falls outside the 100x100 frame/);
  // The reason is MANDATORY: a mask with no stated reason is indistinguishable from a
  // laundered failure, and that is the whole audit value of the field.
  assert.match(maskRefusal([{ x: 0, y: 0, w: 5, h: 5 }], W, H) ?? "", /has no reason/);
  assert.match(maskRefusal([{ x: 0, y: 0, w: 5, h: 5, reason: "  " }], W, H) ?? "", /has no reason/);
});

// ── ENFORCEMENT: blanking, in the one reader path ────────────────────────────

test("BLANKING LITMUS: a drift INSIDE the mask grades match; the same pair unmasked grades drift", () => {
  const baseline = image([]);
  // 4% of the frame moved: eight times the 0.5% default, so nothing but the mask can
  // make this a match.
  const actual = image([{ x: 10, y: 10, w: 20, h: 20 }]);
  const mask: MaskRect[] = [{ x: 10, y: 10, w: 20, h: 20, reason: "ambient sparkle layer" }];

  const unmasked = comparePerceptual(actual, baseline);
  assert.equal(unmasked.status, "drift");
  assert.equal(unmasked.diffPixels, 400);
  assert.equal(unmasked.maskedFraction, 0);

  const masked = comparePerceptual(actual, baseline, { maskRects: mask });
  assert.equal(masked.status, "match", "the masked region is blanked in BOTH images, so it cannot differ");
  assert.equal(masked.diffPixels, 0);
  assert.equal(masked.maskedFraction, 0.04, "…and the size of the blindness is recorded, not hidden");

  // M11: THE DENOMINATOR STAYS THE FULL FRAME. A drift OUTSIDE the mask is measured
  // against 10000 pixels, not against the 9600 that were still graded, so a stamped
  // tolerance keeps the exact meaning it was consented to.
  const outside = comparePerceptual(image([{ x: 50, y: 50, w: 10, h: 10 }]), baseline, { maskRects: mask });
  assert.equal(outside.diffPixels, 100);
  assert.equal(outside.totalPixels, FRAME_PIXELS);
  assert.equal(outside.diffFraction, 0.01, "100/10000, NOT 100/9600");
});

test("a capture-scoped mask blanks ONLY its capture; the others keep grading that region", () => {
  const baseline = image([]);
  const actual = image([{ x: 10, y: 10, w: 20, h: 20 }]);
  const mask: MaskRect[] = [{ x: 10, y: 10, w: 20, h: 20, reason: "ambient", captureId: "cap-a" }];
  assert.equal(comparePerceptual(actual, baseline, { maskRects: mask, captureId: "cap-a" }).status, "match");
  assert.equal(
    comparePerceptual(actual, baseline, { maskRects: mask, captureId: "cap-b" }).status,
    "drift",
    "a mask scoped to one capture must not blind the whole trace",
  );
});

test("ENFORCEMENT through the real verb: stamping the mask turns a drifted run green, and says how much it hid", async () => {
  const root = await approvedProject();
  try {
    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([{ x: 10, y: 10, w: 20, h: 20 }]));

    const before = await grade(root);
    assert.equal(before.artifact.segments[0]!.captures[0]!.visualStatus, "drift");
    assert.equal(before.artifact.segments[0]!.captures[0]!.diffFraction, 0.04);
    assert.equal(replayExitCode(before.artifact, true), 1);

    const stamped = await captured(() =>
      run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient sparkle layer"]),
    );
    assert.equal(stamped.code, 0, stamped.out);
    assert.match(stamped.out, /masked 0% to 4% of the frame/, "the stamp prints the TRANSITION, not just the total");
    assert.match(stamped.out, /1 mask\(s\) hide 4% of every frame outright; the rest grades at 0\.5%/);

    const after = await grade(root);
    const capture = after.artifact.segments[0]!.captures[0]!;
    assert.equal(capture.visualStatus, "match");
    assert.equal(capture.maskedFraction, 0.04);
    assert.equal(capture.toleranceUsed, DEFAULT_DRIFT_FRACTION, "the tolerance did NOT have to be widened");
    assert.equal(after.artifact.visualDrift, undefined);
    assert.equal(after.artifact.visualHarnessFault, undefined);
    assert.equal(replayExitCode(after.artifact, true), 0);
    assert.equal(after.artifact.maskedFraction, 0.04, "the run records what it did not grade");
    assert.equal(after.artifact.maskRects?.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a mask does NOT hide drift outside it: the rest of the frame keeps grading at full strictness", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    // 1% of the frame moved, somewhere the human never excused.
    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([{ x: 60, y: 60, w: 10, h: 10 }]));
    const { artifact } = await grade(root);
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, "drift");
    assert.equal(artifact.segments[0]!.captures[0]!.diffFraction, 0.01);
    assert.equal(replayExitCode(artifact, true), 1);
    // Q7: the drift line QUALIFIES itself, because 1% measured with 4% blanked is not the
    // same claim as 1% measured over the whole frame.
    const facts = driftFacts(artifact);
    assert.equal(facts.maskedFraction, 0.04);
    assert.match(
      driftRegressionLine({ ...facts, exitTier: 1 }),
      /max 1% \(4% of the frame is masked and cannot differ\)$/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an UNMASKED run's lines are byte-identical to what they were before masks existed", () => {
  const facts = { driftCaptures: 39, maxDiffFraction: 0.013, toleranceUsed: DEFAULT_DRIFT_FRACTION };
  assert.equal(
    driftRegressionLine({ ...facts, exitTier: 1 }),
    "pixel-drift regression (exit 1): actuation passed, 39 capture(s) over tolerance, max 1.3%",
  );
  assert.equal(
    driftSuggestionLines({ ...facts, traceId: "t" })[0],
    "pixel drift only: max 1.3% across 39 capture(s); if this game animates, re-approve the tolerance with " +
      "`loombridge trace tolerance --id t --set 0.015`",
  );
  assert.equal(
    anchorTermsSentence(maskAnchorTerms([], W, H, DEFAULT_DRIFT_FRACTION)),
    null,
    "the default says nothing new",
  );
});

// ── the dims binding: a mismatch is a MANIFEST-level fault ───────────────────

test("DIMS MISMATCH at apply time is a MANIFEST-level harness fault, never a per-capture 'unreadable'", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    // The stamped dims now describe a frame the approved PNGs are not. (Hand-edited,
    // because the verb re-decodes and would never write this itself.)
    await editManifest(root, { frameWidth: 200, frameHeight: 200 });

    const { artifact, out } = await grade(root);
    const capture = artifact.segments[0]!.captures[0]!;
    // The pacing precedent exactly: the ANCHOR is at fault, so the captures are left
    // UNGRADED rather than stamped unreadable (they decode fine, and calling them
    // unreadable would make `approve` refuse the very report that re-anchors them).
    assert.equal(capture.visualStatus, undefined);
    assert.equal(capture.toleranceUsed, undefined, "nothing was graded, so no terms are claimed");
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(artifact.visualDrift, undefined, "a broken anchor is never reported as a game defect");
    assert.equal(replayExitCode(artifact, false), 2);
    assert.match(out, /cannot be trusted at grade time \(harness fault, not a game defect\)/);
    // MX3 MOVED THE FIRST DETECTION EARLIER, and the sentence changed with it: the manifest
    // VERIFIER now decodes a declared frame and cross-checks the stamped denominator, so a
    // hand-inflated `frameWidth` is an integrity failure that every PRE-RUN surface sees,
    // not just a grade-time one. The tier and the shape of the answer are unchanged.
    assert.match(
      out,
      /the stamped frame size 200x200 is not the size of the approved frames \(cap\.png is 100x100\)/,
    );
    assert.match(out, /loombridge trace mask --set/, "the refusal names the verb that owns the decision");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX3: the grade-time dims check still catches what the verifier's ONE decode cannot", async () => {
  // The integrity check decodes ONE declared frame (the shas prove the others are the
  // approved bytes). A baseline whose frames are NOT all one size therefore passes it while
  // still having no single denominator to measure a mask against, and `applyVisualDiff`'s
  // own `baselineFrameDims` is what catches that. Built by hand with CORRECT shas, because
  // every verb refuses to write this: without the fixture the grade-time branch would be a
  // guard nothing walks.
  const root = await approvedProject("demo", ["cap", "cap2"]);
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    const dir = path.join(standardReplayLayout(root).replayBaselines, "demo");
    const odd = pngWithRects([], 200, 200);
    await fs.writeFile(path.join(dir, "cap2.png"), odd);
    const manifest = await readManifest(root);
    await editManifest(root, {
      pngs: manifest.pngs.map((p) =>
        p.captureId === "cap2"
          ? { captureId: "cap2", sha256: createHash("sha256").update(odd).digest("hex") }
          : p,
      ),
    });

    const { artifact, out } = await grade(root, "demo", ["cap", "cap2"]);
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(artifact.visualDrift, undefined);
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, undefined, "the ANCHOR is at fault");
    assert.match(out, /masks are stamped but the approved frames are not all one size \(100x100 and 200x200/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── approve: preserve, re-validate, refuse. Never reinterpret ───────────────

test("approve PRESERVES masks, re-validates them against the newly frozen frames, and says so", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient sparkle"]));
    const again = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(again.code, 0, again.out);
    const manifest = await readManifest(root);
    assert.equal(manifest.maskRects?.length, 1, "a re-freeze must not silently un-mask a region a human excused");
    assert.equal(manifest.maskRects![0]!.reason, "ambient sparkle");
    assert.equal(manifest.frameWidth, W);
    assert.equal(manifest.frameHeight, H);
    assert.match(again.out, /1 mask\(s\) preserved and re-validated against the new frames/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX2: approve REFUSES the re-freeze at a CHANGED RESOLUTION, even when the rects still fit", async () => {
  const root = await approvedProject();
  try {
    // 10,10,20x20 hides 4% of a 100x100 frame and 1% of a 200x200 one. It lands INSIDE both,
    // so the old bounds/cap re-validation waved it through and the anchor silently re-stated
    // a human's blindness at a quarter of its size (M2's 8.33%-to-2% jump, in miniature).
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient sparkle"]));
    const before = await readManifest(root);
    assert.equal(maskedFractionFor(before.maskRects!, "cap", 100, 100), 0.04);
    assert.equal(maskedFractionFor(before.maskRects!, "cap", 200, 200), 0.01, "the same rect, a different promise");

    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([], 200, 200));
    const refused = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(refused.code, 2, refused.out);
    assert.match(
      refused.out,
      /the game's resolution changed \(100x100 to 200x200\): masks were approved against the old frames/,
    );
    assert.match(refused.out, /`loombridge trace mask --id demo --set \.\.\.` against the new frames \(or --clear\)/);

    const after = await readManifest(root);
    assert.equal(after.approvedAt, before.approvedAt, "a refused approval leaves the previous anchor untouched");
    assert.deepEqual(after.maskRects, before.maskRects);
    assert.equal(after.frameWidth, 100, "…including the denominator every printed fraction uses");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approve REFUSES the re-freeze when the preserved masks no longer fit, naming `trace mask`", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "80,80,20x20@corner clock"]));
    const before = await readManifest(root);

    // The game re-rendered at half the resolution: the approved rect now falls off the
    // frame entirely. Both silent options are wrong (dropping the mask un-blinds a region
    // a human excused; keeping it re-interprets their decision against a frame they never
    // saw), so the re-freeze refuses. MX2 made the DIMENSION CHANGE itself the refusal, so
    // this shrink is caught one step earlier than it used to be, by the stronger rule.
    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([], 50, 50));
    const refused = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /the game's resolution changed \(100x100 to 50x50\)/);
    assert.match(refused.out, /loombridge trace mask --id demo --set/);
    assert.match(
      refused.out,
      /would hide a different share of the new frame than the one their approver consented to/,
    );

    const after = await readManifest(root);
    assert.equal(after.approvedAt, before.approvedAt, "a refused approval leaves the previous anchor untouched");
    assert.deepEqual(after.maskRects, before.maskRects);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX2: a mask-bearing approve at UNCHANGED dims appends its (unchanged) fraction to the history", async () => {
  // The history is read as one entry per APPROVAL EVENT. If only `trace mask` wrote to it,
  // six re-freezes between two stamps would leave no trace at all, and 4% -> 4% would read
  // as one decision instead of the several re-consents it actually took.
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    assert.deepEqual((await readManifest(root)).maskedFractionHistory, [0.04]);

    const again = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(again.code, 0, again.out);
    assert.deepEqual((await readManifest(root)).maskedFractionHistory, [0.04, 0.04]);

    // …and `--list` shows it, so the record has a surface a human reads.
    const listed = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.match(listed.out, /mask history: 4% → 4% \(one entry per approval event/);

    // An UNMASKED approve appends nothing: an anchor with no masks has no blindness to
    // re-consent to, and a history of zeroes would be noise in the one record that matters.
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--clear"]));
    const historyAfterClear = (await readManifest(root)).maskedFractionHistory;
    await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.deepEqual((await readManifest(root)).maskedFractionHistory, historyAfterClear);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the ledger, --clear and --list ──────────────────────────────────────────

test("the ledger records the mask transition: previousMaskRects + an append-only fraction history", async () => {
  const root = await approvedProject();
  try {
    const first = await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,20x20@hud"]));
    assert.equal(first.code, 0, first.out);
    assert.deepEqual((await readManifest(root)).maskedFractionHistory, [0.04]);

    const second = await captured(() =>
      run(["mask", "--id", "demo", "--root", root, "--set", "0,0,20x20@hud", "--set", "50,50,20x20@sparkles"]),
    );
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /1 to 2 mask\(s\) \(0 removed, 1 added\), masked 4% to 8% of the frame/);
    const grown = await readManifest(root);
    // The ratchet made visible on disk: 4% then 8% is two reasonable-looking stamps.
    assert.deepEqual(grown.maskedFractionHistory, [0.04, 0.08]);
    assert.equal(grown.previousMaskRects?.length, 1);
    assert.equal(grown.approvalCount, 3, "a mask stamp is an approval event and the ledger counts it");

    // --set RESTATES the whole list (Q4): the second invocation above had to repeat the
    // first rect, and an invocation that does not repeat it DROPS it.
    const restated = await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "50,50,20x20@sparkles"]));
    assert.equal(restated.code, 0, restated.out);
    assert.equal((await readManifest(root)).maskRects?.length, 1, "--set is the whole list, never an append");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX13: --list prints previousMaskRects, so the ledger's other half has a surface", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,20x20@hud clock"]));
    const listedOnce = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.doesNotMatch(listedOnce.out, /previously:/, "there is no previous list yet, so nothing is claimed");

    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "cap:40,40,10x10@sparkles"]));
    const listed = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.equal(listed.code, 0, listed.out);
    // "How much" was already answerable from the fraction history; "WHERE, and why" was
    // written to disk and read back by nothing a human sees, which is a record kept for
    // nobody. The rects an anchor USED to hide are exactly what an auditor arrives asking for.
    assert.match(listed.out, /previously: \(every capture\) 0,0,20x20@hud clock at \d{4}-\d\d-\d\dT/);
    assert.match(listed.out, /cap 40,40,10x10 reason: sparkles/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX3: --list runs the VERIFIER first and refuses to quote the terms of an untrusted anchor", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    const honest = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.match(honest.out, /hide 4% of every frame outright/);

    // The stamped denominator, inflated by hand. Every fraction on every PRE-RUN surface is
    // computed against it, so without a decode this read-only "look before you trust" verb
    // would print 1% for a mask that hides 4% of the real frame.
    await editManifest(root, { frameWidth: 200, frameHeight: 200 });
    const refused = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /the stamped frame size 200x200 is not the size of the approved frames/);
    assert.match(refused.out, /refusing to quote this anchor's terms/);
    assert.doesNotMatch(refused.out, /hide 1% of/, "the inflated number is never printed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX3: an inflated stamped denominator is a BROKEN row in unified discovery, before anything runs", async () => {
  const root = await approvedProject();
  const workspace = await tmpRoot();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    await editManifest(root, { frameWidth: 200, frameHeight: 200 });

    const { assets, notes } = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = assets.find((a) => a.kind === "trace")!;
    assert.equal(row.runnable, "no");
    assert.equal(row.notRunClass, "broken");
    assert.match(row.broken ?? "", /the stamped frame size 200x200 is not the size of the approved frames/);
    assert.equal(row.maskedFraction, undefined, "a broken row never quotes a fraction it could not measure");
    assert.match(planLines(root, assets, notes, true).join("\n"), /BROKEN, will not run/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("MX14: the fraction HISTORY validates against [0,1], not against the live cap", async () => {
  // History is history, never enforcement: nothing reads it back into a comparison. Binding
  // it to MAX_MASKED_FRACTION would mean that LOWERING the cap later retroactively bricked
  // every anchor whose past stamps were legal when they were made, which turns a tightening
  // into a fleet of unreadable anchors. A cap change must refuse the NEXT stamp instead.
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,10,20x20@ambient"]));
    await editManifest(root, { maskedFractionHistory: [0.4, 0.25, 0.04] });
    const loaded = await readManifest(root);
    assert.deepEqual(loaded.maskedFractionHistory, [0.4, 0.25, 0.04]);
    assert.ok(0.4 > MAX_MASKED_FRACTION, "…and those entries are over today's cap");

    // The SHAPE is still checked: a fake consent record is not a record.
    for (const bogus of [[1.5], [-0.1], ["4%"], [Number.NaN]]) {
      await editManifest(root, { maskedFractionHistory: bogus });
      const broken = await loadTraceBaselineManifest(path.join(standardReplayLayout(root).replayBaselines, "demo"));
      assert.ok(isTraceBaselineManifestError(broken), JSON.stringify(bogus));
      assert.match(broken.error, /'maskedFractionHistory' has an entry outside \[0, 1\]/);
    }

    // And the LIVE cap still refuses the next stamp, which is where enforcement belongs.
    await editManifest(root, { maskedFractionHistory: [0.04] });
    const overCap = await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,100x40@everything"]));
    assert.equal(overCap.code, 2, overCap.out);
    assert.match(overCap.out, /above the 10% cap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX14: the exit-tier help block covers the read-only --list exit 0", async () => {
  // The block enumerated "0 stamped", and `--list` stamps nothing and exits 0: an agent
  // reading the block to decide what a 0 means would have concluded a write happened.
  const help = await captured(() => run(["--help"]));
  assert.equal(help.code, 0);
  assert.match(help.out, /0 stamped, or \(for the read-only `mask --list`\) printed: it\s+stamps nothing and still exits 0/);
  assert.match(help.out, /`--list` refuses to quote the terms of an untrusted anchor/);
  // MX1: the help no longer describes a bar the code does not use.
  assert.match(help.out, /Reproduction is structural, not byte\s+equality: at or above 95% of the drifted pixels landing in the same cells/);
  assert.doesNotMatch(help.out, /drift bitmaps DIFFER/);
});

test("mask --clear empties the list and SAYS so; --list touches nothing at all", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,20x20@hud"]));
    const manifestPath = path.join(standardReplayLayout(root).replayBaselines, "demo", TRACE_BASELINE_MANIFEST);

    const listed = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /1 approved mask\(s\)/);
    assert.match(listed.out, /\(every capture\) 0,0,20x20 reason: hud/);
    assert.match(listed.out, /mask history: 4%/);
    const bytesAfterList = await fs.readFile(manifestPath, "utf-8");

    const listedAgain = await captured(() => run(["mask", "--id", "demo", "--root", root, "--list"]));
    assert.equal(listedAgain.code, 0);
    assert.equal(
      await fs.readFile(manifestPath, "utf-8"),
      bytesAfterList,
      "a read-only verb that re-stamped the anchor would make 'look before you trust' impossible",
    );

    const cleared = await captured(() => run(["mask", "--id", "demo", "--root", root, "--clear"]));
    assert.equal(cleared.code, 0, cleared.out);
    assert.match(cleared.out, /masked 4% to 0% of the frame/);
    assert.match(cleared.out, /the mask list is now EMPTY: the whole frame is graded again/);
    const emptied = await readManifest(root);
    assert.equal(emptied.maskRects, undefined);
    assert.deepEqual(emptied.maskedFractionHistory, [0.04, 0], "the history keeps the un-masking too");
    assert.equal(emptied.previousMaskRects?.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mask refuses with no approved baseline (1) and with a broken one (2), exactly like tolerance", async () => {
  const bare = await tmpRoot();
  try {
    const none = await captured(() => run(["mask", "--id", "demo", "--root", bare, "--set", "0,0,10x10@hud"]));
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /approve frames first/);
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }

  const root = await approvedProject();
  try {
    await fs.writeFile(
      path.join(standardReplayLayout(root).replayBaselines, "demo", TRACE_BASELINE_MANIFEST),
      "{ not json",
    );
    const broken = await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,10x10@hud"]));
    assert.equal(broken.code, 2, broken.out);
    assert.match(broken.out, /A baseline that cannot be read is not an anchor/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mask takes EXACTLY ONE mode, and the spec parser demands a reason it never invents", async () => {
  const root = await approvedProject();
  try {
    for (const args of [
      ["mask", "--id", "demo", "--root", root],
      ["mask", "--id", "demo", "--root", root, "--set", "0,0,10x10@hud", "--clear"],
      ["mask", "--id", "demo", "--root", root, "--clear", "--list"],
    ]) {
      const { code } = await captured(() => run(args));
      assert.equal(code, 2, `expected ${args.join(" ")} to be a usage refusal`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  assert.equal(parseMaskRectSpec("0,0,10x10"), null, "no @reason is a refusal, never a default reason");
  assert.equal(parseMaskRectSpec("0,0,10x10@"), null);
  assert.equal(parseMaskRectSpec("0,0,10@why"), null);
  assert.equal(parseMaskRectSpec("../evil:0,0,10x10@why"), null, "the capture id names a file, so it is confined");
  assert.deepEqual(parseMaskRectSpec("1,2,3x4@the timer ticks"), {
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    reason: "the timer ticks",
  });
  assert.deepEqual(parseMaskRectSpec("cap-2:1,2,3x4@ambient"), {
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    reason: "ambient",
    captureId: "cap-2",
  });
});

// ── Q6: the carry-forward key enumeration ───────────────────────────────────

const MANIFEST_SRC = path.join(PKG_ROOT, "src", "capabilities", "replay", "trace-baseline-manifest.ts");

/** The top-level field names of the `TraceBaselineManifest` interface, read from source. */
function manifestInterfaceKeys(source: string): string[] {
  const start = source.indexOf("export interface TraceBaselineManifest {");
  assert.ok(start >= 0, "the interface was renamed; this scan is no longer reading anything");
  const body = source.slice(start, source.indexOf("\n}", start));
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...withoutComments.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!))].sort();
}

test("KEY-ENUMERATION LITMUS: every manifest key has a carry-forward DECISION, and the carried ones are carried", () => {
  const keys = manifestInterfaceKeys(readFileSync(MANIFEST_SRC, "utf-8"));
  // Non-vacuity: the scan is really reading the interface, not an empty string.
  assert.ok(keys.length >= 15, `the scan found only ${keys.join(", ")}; it is not reading the interface`);
  for (const known of ["traceSha256", "pngs", "driftTolerance", "maskRects", "frameWidth"]) {
    assert.ok(keys.includes(known), `the scan missed the known field ${known}`);
  }
  // THE POINT: a new field with no decision fails HERE, at the moment it is added, rather
  // than silently in whichever writer forgot to preserve it.
  assert.deepEqual(
    keys.filter((k) => !(k in MANIFEST_KEY_DECISIONS)),
    [],
    "every manifest key needs an entry in MANIFEST_KEY_DECISIONS (rewritten / carried / ledger)",
  );
  assert.deepEqual(
    Object.keys(MANIFEST_KEY_DECISIONS).filter((k) => !keys.includes(k)),
    [],
    "MANIFEST_KEY_DECISIONS names a field the manifest no longer has",
  );

  // …and the carried ones really are carried, by the one helper all three writers use.
  const previous: TraceBaselineManifest = {
    kind: "trace-baseline",
    schemaVersion: "1",
    traceId: "demo",
    traceSha256: "a",
    approvedAt: "then",
    sourceReportSha256: "b",
    pngs: [],
    driftTolerance: 0.015,
    replaySpeed: 2,
    maskRects: [{ x: 0, y: 0, w: 10, h: 10, reason: "hud" }],
    frameWidth: W,
    frameHeight: H,
  };
  const carried = carryForward(previous);
  assert.deepEqual(Object.keys(carried).sort(), CARRIED_MANIFEST_KEYS);
  assert.deepEqual(carried.maskRects, previous.maskRects);
  assert.equal(carried.driftTolerance, 0.015);
  assert.equal(carryForward(null).driftTolerance, undefined, "a first approval carries nothing forward");
});

test("approve RE-DERIVES the pacing rather than carrying it, so re-anchoring at 1x still works", async () => {
  const root = await approvedProject();
  try {
    await editManifest(root, { replaySpeed: 2 });
    // The report this approve promotes carries no speed, i.e. 1x. Carrying the stamped 2x
    // forward would mislabel these frames and break the documented escape hatch.
    const again = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(again.code, 0, again.out);
    assert.equal((await readManifest(root)).replaySpeed, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the suggestion: two runs, or nothing ────────────────────────────────────

/** Persist an artifact as THE report, so the next `grade` reads it as the previous run. */
async function persistReport(root: string, artifact: ReplayRunArtifact, id = "demo"): Promise<void> {
  await fs.writeFile(
    path.join(standardReplayLayout(root).replayReports, `${id}.report.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
}

test("MX1 LITMUS: the five-row attack matrix ALL refuse, and the sha rule they defeat is shown defeated", async () => {
  // THE ATTACK. Under sha equality, "the drift is identical" was the only thing standing
  // between an operator and masking a real regression, and byte equality is defeated by
  // flipping ONE pixel: re-run until the shas differ and the tool starts recommending a
  // mask for the bug. Every row below is a second run that a human would call the same
  // regression, and every one of them must still refuse.
  const BLOB = { x: 10, y: 10, w: 10, h: 10 };
  const rows: { name: string; second: Buffer; shaDiffers: boolean }[] = [
    { name: "identical", second: pngOf(pixelsWith([BLOB])), shaDiffers: false },
    // 229 on white is a YIQ delta of 26, UNDER the perceptual threshold: the frame changed
    // and the drift bitmap did not, which is the cheapest possible attempt.
    { name: "sub-threshold pixel", second: pngOf(pixelsWith([BLOB], [{ x: 80, y: 80, v: 229 }])), shaDiffers: false },
    // 228 is a delta of 27, OVER the threshold: one extra drifted pixel, one different sha.
    { name: "delta-27 pixel", second: pngOf(pixelsWith([BLOB], [{ x: 80, y: 80, v: 228 }])), shaDiffers: true },
    { name: "black speck", second: pngOf(pixelsWith([BLOB], [{ x: 80, y: 80, v: 0 }])), shaDiffers: true },
    // The other direction: take a pixel AWAY from the regression instead of adding one.
    { name: "one blob pixel restored", second: pngOf(pixelsWith([BLOB], [{ x: 10, y: 10, v: 255 }])), shaDiffers: true },
  ];

  for (const row of rows) {
    const root = await approvedProject();
    try {
      await fs.writeFile(actualPngPath(root, "demo"), pngOf(pixelsWith([BLOB])));
      const first = await grade(root);
      assert.equal(first.artifact.maskSuggestion?.kind, "first-run", row.name);
      await persistReport(root, first.artifact);

      await fs.writeFile(actualPngPath(root, "demo"), row.second);
      const second = await grade(root);
      const shaOne = first.artifact.segments[0]!.captures[0]!.driftDiffSha;
      const shaTwo = second.artifact.segments[0]!.captures[0]!.driftDiffSha;
      assert.equal(
        shaTwo !== shaOne,
        row.shaDiffers,
        `${row.name}: the sha rule this replaces would have been ${row.shaDiffers ? "DEFEATED" : "held"} here`,
      );

      const suggestion = second.artifact.maskSuggestion!;
      assert.equal(suggestion.kind, "identical", `${row.name}: a mask must never be offered for this drift`);
      assert.equal(suggestion.kind === "identical" && suggestion.exact, !row.shaDiffers);
      const lines = maskSuggestionLines(suggestion, "demo");
      assert.equal(lines.length, 1, row.name);
      assert.ok(lines[0]!.endsWith(DETERMINISTIC_DRIFT_WARNING), `${row.name}: ${lines[0]}`);
      assert.doesNotMatch(lines[0]!, /--set/, `${row.name}: no rect, no command, nothing to copy`);
      if (row.shaDiffers) {
        assert.match(lines[0]!, /at least 95% of the drifted pixels reproduce across two runs/, row.name);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("MX1 LITMUS: a GENUINELY shuffled drift (similarity ~0.5) still earns its suggestion", async () => {
  // The bar has to refuse a regression AND still work: over-refusing everything would be
  // safe and useless. Half the drift lands somewhere else on the second run, which is what
  // an ambient layer redrawing itself actually looks like.
  const A = { x: 10, y: 10, w: 7, h: 7 };
  const B = { x: 10, y: 80, w: 7, h: 7 };
  const C = { x: 80, y: 10, w: 7, h: 7 };
  const similarity = driftGridSimilarity(gridOfRects([A, B]), gridOfRects([A, C]));
  assert.ok(similarity > 0.45 && similarity < 0.55, `expected ~0.5, got ${similarity}`);
  assert.ok(similarity < REPRODUCED_DRIFT_SIMILARITY);

  const root = await approvedProject();
  try {
    await fs.writeFile(actualPngPath(root, "demo"), pngOf(pixelsWith([A, B])));
    await persistReport(root, (await grade(root)).artifact);

    await fs.writeFile(actualPngPath(root, "demo"), pngOf(pixelsWith([A, C])));
    const second = await grade(root);
    const suggestion = second.artifact.maskSuggestion!;
    assert.equal(suggestion.kind, "suggest");
    assert.deepEqual(
      suggestion.kind === "suggest" && suggestion.rects.map((r) => `${r.x},${r.y},${r.w}x${r.h}`),
      ["10,10,7x7", "80,10,7x7"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX1: a previous report with NO fingerprint (or a mangled one) asks for another run, never a rect", () => {
  // The previous grid arrives through a report.json an operator can edit. Absence of
  // evidence is not evidence, so it lands on `first-run`, and every malformed shape lands
  // there too rather than being coerced into agreement OR into disagreement (the direction
  // that would MINT a suggestion).
  const clusters = [{ x: 10, y: 10, w: 7, h: 7 }];
  const current = [
    { captureId: "cap", drifted: true, driftDiffSha: "b", driftGrid: gridOfRects(clusters), driftClusters: clusters },
  ];
  for (const grid of [undefined, [], [1, 2, 3], new Array(256).fill(-1), new Array(256).fill(1.5), "nope"]) {
    assert.deepEqual(
      deriveMaskSuggestion(
        current,
        [{ captureId: "cap", drifted: true, driftDiffSha: "a", driftGrid: grid as number[] | undefined }],
        W,
        H,
      ),
      { kind: "first-run" },
      `a ${JSON.stringify(grid)} fingerprint is not evidence of anything`,
    );
    assert.equal(asDriftGrid(grid), null);
  }
  // …and a WELL-FORMED, genuinely different one is what unlocks the rect.
  assert.equal(
    deriveMaskSuggestion(
      current,
      [{ captureId: "cap", drifted: true, driftDiffSha: "a", driftGrid: gridOfRects([{ x: 80, y: 10, w: 7, h: 7 }, ...clusters]) }],
      W,
      H,
    )?.kind,
    "suggest",
  );
});

test("TWO-RUN LITMUS: an IDENTICAL drift twice prints the regression warning, never a rect", async () => {
  const root = await approvedProject();
  try {
    const drifted = pngWithRects([{ x: 10, y: 10, w: 10, h: 10 }]);
    await fs.writeFile(actualPngPath(root, "demo"), drifted);

    // RUN 1: no previous evidence at all.
    const first = await grade(root);
    assert.equal(first.artifact.visualDrift, true);
    assert.deepEqual(first.artifact.maskSuggestion, { kind: "first-run" });
    assert.deepEqual(maskSuggestionLines(first.artifact.maskSuggestion!, "demo"), [
      "re-run replay once more to characterize the drift before masking.",
    ]);
    await fs.writeFile(
      path.join(standardReplayLayout(root).replayReports, "demo.report.json"),
      `${JSON.stringify(first.artifact, null, 2)}\n`,
    );

    // RUN 2: the SAME pixels moved the same way. That is the game changing, and masking
    // it would erase the finding.
    const second = await grade(root);
    assert.deepEqual(second.artifact.maskSuggestion, { kind: "identical", captures: ["cap"], exact: true });
    assert.deepEqual(maskSuggestionLines(second.artifact.maskSuggestion!, "demo"), [
      "the drift is IDENTICAL across two runs: that is a deterministic change, not ambient noise; " +
        "investigate before masking.",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TWO-RUN LITMUS: two DIFFERENT drifts in the same region suggest rects, and never apply them", async () => {
  const root = await approvedProject();
  try {
    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([{ x: 10, y: 10, w: 10, h: 10 }]));
    const first = await grade(root);
    await fs.writeFile(
      path.join(standardReplayLayout(root).replayReports, "demo.report.json"),
      `${JSON.stringify(first.artifact, null, 2)}\n`,
    );

    // The ambient layer redrew itself two pixels over: overlapping bounds, different sha.
    await fs.writeFile(actualPngPath(root, "demo"), pngWithRects([{ x: 12, y: 10, w: 10, h: 10 }]));
    const second = await grade(root);
    const suggestion = second.artifact.maskSuggestion!;
    assert.equal(suggestion.kind, "suggest");
    assert.equal(suggestion.kind === "suggest" && suggestion.rects.length, 1);
    assert.deepEqual(suggestion.kind === "suggest" && suggestion.rects[0], {
      x: 12,
      y: 10,
      w: 10,
      h: 10,
      captureId: "cap",
      reason: "ambient-animation",
    });
    const lines = maskSuggestionLines(suggestion, "demo");
    assert.equal(
      lines[0],
      "drift concentrates in 12,10,10x10 across 1 capture(s); if this region is ambient animation, mask it: " +
        "loombridge trace mask --id demo --set cap:12,10,10x10@ambient-animation",
    );
    assert.match(lines[1]!, /that masks 1% of the frame \(cap 10%\) and is NEVER applied for you/);
    assert.match(lines[1]!, /replace @ambient-animation with what actually animates there/);

    // NOTHING was applied: the anchor is exactly as the human left it.
    assert.equal((await readManifest(root)).maskRects, undefined);
    // …and the suggestion is still gated by the harness-fault predicate both doors share.
    assert.equal(shouldSuggestTolerance(second.artifact), true);
    assert.equal(
      shouldSuggestTolerance({ ...second.artifact, visualHarnessFault: true }),
      false,
      "an unreadable capture is not drift, so it is never answered with a mask",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX5: the suggested command RESTATES the stamped rects first, so following it never un-masks one", async () => {
  // `--set` replaces the whole list. A suggestion that named only the NEW rect was
  // therefore a command to DELETE every mask the operator had already approved, handed to
  // them as the remedy for a drift, and the un-masked region would come back as drift on
  // the next run with the same suggestion attached to it.
  const root = await approvedProject();
  try {
    const stamp = await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "80,80,10x10@hud clock"]));
    assert.equal(stamp.code, 0, stamp.out);

    const A = { x: 10, y: 10, w: 7, h: 7 };
    await fs.writeFile(actualPngPath(root, "demo"), pngOf(pixelsWith([A, { x: 10, y: 80, w: 7, h: 7 }])));
    await persistReport(root, (await grade(root)).artifact);
    await fs.writeFile(actualPngPath(root, "demo"), pngOf(pixelsWith([A, { x: 80, y: 10, w: 7, h: 7 }])));
    const second = await grade(root);

    const suggestion = second.artifact.maskSuggestion!;
    assert.equal(suggestion.kind, "suggest");
    const rects = suggestion.kind === "suggest" ? suggestion.rects : [];
    assert.deepEqual(rects[0], { x: 80, y: 80, w: 10, h: 10, reason: "hud clock" }, "the STAMPED rect comes first");
    assert.equal(rects.length, 3);
    const command = maskSuggestionLines(suggestion, "demo")[0]!;
    assert.match(command, /--set 80,80,10x10@hud clock --set cap:10,10,7x7@ambient-animation/);

    // MX12: THE ROUND TRIP. The formatter and the parser are two halves of one contract,
    // and nothing else in the suite makes them meet: a suggestion an operator copies must
    // parse back to the rect the tool meant, or the tool has printed a lie it can read.
    for (const rect of rects) {
      const flag = formatMaskSetFlag(rect);
      assert.ok(flag.startsWith("--set "), flag);
      assert.deepEqual(parseMaskRectSpec(flag.slice("--set ".length)), rect, flag);
    }

    // …and the whole command, lifted out of the printed line and typed back, is accepted.
    const values = command
      .slice(command.indexOf("--set ") + "--set ".length)
      .split(" --set ");
    const applied = await captured(() =>
      run(["mask", "--id", "demo", "--root", root, ...values.flatMap((v) => ["--set", v])]),
    );
    assert.equal(applied.code, 0, applied.out);
    const manifest = await readManifest(root);
    assert.equal(manifest.maskRects?.length, 3, "following the suggestion KEEPS the approved rect");
    assert.deepEqual(manifest.maskRects![0], { x: 80, y: 80, w: 10, h: 10, reason: "hud clock" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX5: a stamp that DROPS a rect says so loudly, and the count line cannot read as no-change", async () => {
  const root = await approvedProject();
  try {
    await captured(() =>
      run([
        "mask", "--id", "demo", "--root", root,
        "--set", "0,0,10x10@hud clock",
        "--set", "80,80,10x10@ambient sparkle",
      ]),
    );
    // Two out, two in: the counts are identical, and TWO regions a human approved have
    // silently gone back to being graded (or, the other way round, a typo has un-masked the
    // thing they were protecting) unless the output says which.
    const swapped = await captured(() =>
      run([
        "mask", "--id", "demo", "--root", root,
        "--set", "20,20,10x10@hud clock",
        "--set", "60,60,10x10@ambient sparkle",
      ]),
    );
    assert.equal(swapped.code, 0, swapped.out);
    assert.match(swapped.out, /2 to 2 mask\(s\) \(2 removed, 2 added\)/);
    assert.match(
      swapped.out,
      /2 mask\(s\) REMOVED: 0,0,10x10@hud clock, 80,80,10x10@ambient sparkle\. Those regions are GRADED again\./,
    );

    // A re-stamp of the SAME list says "unchanged" rather than counting churn it did not do.
    const same = await captured(() =>
      run([
        "mask", "--id", "demo", "--root", root,
        "--set", "20,20,10x10@hud clock",
        "--set", "60,60,10x10@ambient sparkle",
      ]),
    );
    assert.match(same.out, /2 to 2 mask\(s\) \(unchanged\)/);
    assert.doesNotMatch(same.out, /REMOVED/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("drift in an UNRELATED region across two runs is two findings, not one mask", () => {
  // MX1 moved this test from BOUNDING BOXES to grid CELLS, and the difference is the whole
  // point: a bounding box is the convex hull of everything that moved, so one distant speck
  // in run one would have stretched it across the frame and manufactured an "overlap" with
  // an unrelated drift in run two.
  const previous = [{ captureId: "cap", drifted: true, driftDiffSha: "a", driftGrid: gridOfRects([{ x: 0, y: 0, w: 5, h: 5 }]) }];
  const current = [
    {
      captureId: "cap",
      drifted: true,
      driftDiffSha: "b",
      driftGrid: gridOfRects([{ x: 80, y: 80, w: 5, h: 5 }]),
      driftClusters: [{ x: 80, y: 80, w: 5, h: 5 }],
    },
  ];
  assert.deepEqual(deriveMaskSuggestion(current, previous, W, H), { kind: "first-run" });

  // The bounding boxes of those same two drifts, once ONE distant speck is added to run one,
  // DO overlap: the old rule would have called this the same region and offered a rect.
  const specked = { x: 0, y: 0, w: 90, h: 90 };
  const other = { x: 80, y: 80, w: 5, h: 5 };
  assert.ok(
    specked.x < other.x + other.w && other.x < specked.x + specked.w &&
      specked.y < other.y + other.h && other.y < specked.y + specked.h,
    "the boxes overlap, which is exactly why box overlap was the wrong question",
  );
  assert.equal(
    deriveMaskSuggestion(
      current,
      [{ captureId: "cap", drifted: true, driftDiffSha: "a", driftGrid: gridOfRects([{ x: 0, y: 0, w: 5, h: 5 }, { x: 88, y: 0, w: 2, h: 2 }]) }],
      W,
      H,
    )?.kind,
    "first-run",
    "a speck that stretches a hull does not put two drifts in the same cells",
  );
});

test("DIFFUSE drift says masks cannot cover it honestly, and offers no rect at all", () => {
  // Scattered single pixels: a real ambient region is a blob, this is noise, and three
  // rects covering it would blind most of the frame.
  const bitmap = new Uint8Array(FRAME_PIXELS);
  let painted = 0;
  for (let i = 0; i < FRAME_PIXELS && painted < 200; i += 37) {
    bitmap[i] = 1;
    painted += 1;
  }
  // M8/M9 (MX7): the refusal is a NAMED reason with the number that decided it, because
  // "diffuse" alone does not tell an operator whether the region is too big, too scattered
  // or too empty, and those three call for different next steps.
  assert.deepEqual(clusterDriftRects(bitmap, W, H, painted), { kind: "too-many-components", components: 65 });

  // FOUR far-apart blobs are refused on TIGHTNESS, not on count: they do not fit in three
  // rects, so two of them must merge, and the merged box is almost entirely empty space.
  // Blinding that box to hide 36 pixels is the laundering the tightness rule exists to
  // stop, and it would arrive wearing a tool recommendation.
  const sparse = new Uint8Array(FRAME_PIXELS);
  for (const y0 of [0, 95]) {
    for (const x0 of [0, 95]) {
      for (let y = y0; y < y0 + 3; y += 1) {
        for (let x = x0; x < x0 + 3; x += 1) sparse[y * W + x] = 1;
      }
    }
  }
  const corners = clusterDriftRects(sparse, W, H, 36);
  assert.equal(
    Array.isArray(corners) ? "rects" : corners.kind,
    "too-loose",
    "four corner blobs are not one maskable region",
  );
  // Two tight blobs, on the other hand, ARE two honest rects: the rule is tightness, not
  // a superstition about how far apart drift may be.
  const pair = new Uint8Array(FRAME_PIXELS);
  for (const x0 of [0, 95]) {
    for (let y = 0; y < 3; y += 1) for (let x = x0; x < x0 + 3; x += 1) pair[y * W + x] = 1;
  }
  assert.deepEqual(clusterDriftRects(pair, W, H, 18), [
    { x: 0, y: 0, w: 3, h: 3 },
    { x: 95, y: 0, w: 3, h: 3 },
  ]);

  // Two runs that drifted in the SAME cells with DIFFERENT (unmaskable) shapes: the
  // discriminator says "nondeterministic", and the cluster rule still refuses to name a
  // rect for it. The grids are built by the real coarsening, not hand-written.
  const wide = gridOfRects([{ x: 0, y: 0, w: 100, h: 40 }]);
  const wider = gridOfRects([{ x: 0, y: 0, w: 100, h: 60 }]);
  const suggestion = deriveMaskSuggestion(
    [
      {
        captureId: "cap",
        drifted: true,
        driftDiffSha: "b",
        driftGrid: wider,
        driftClusterRefusal: { kind: "over-cap", fraction: 0.6 },
      },
    ],
    [{ captureId: "cap", drifted: true, driftDiffSha: "a", driftGrid: wide }],
    W,
    H,
  );
  assert.equal(suggestion?.kind, "diffuse");
  const line = maskSuggestionLines(suggestion!, "t")[0]!;
  assert.match(line, /drift is diffuse; masks cannot cover it honestly/);
  assert.match(line, /one region of 60%, above the 10% cap/, "the refusal names WHICH bound broke");
});

test("MX7: the three refusal sentences are DISTINCT, and each carries the number that decided it", () => {
  // One word for three different situations is one word that tells an operator nothing.
  const overCap = new Uint8Array(FRAME_PIXELS);
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 100; x += 1) overCap[y * W + x] = 1;
  assert.deepEqual(clusterDriftRects(overCap, W, H, 1200), { kind: "over-cap", fraction: 0.12 });
  assert.match(
    maskSuggestionLines({ kind: "diffuse", refusal: { kind: "over-cap", fraction: 0.12 } }, "t")[0]!,
    /one region of 12%, above the 10% cap\. Masking it would hide more of the frame than the gate may concede/,
  );
  assert.match(
    maskSuggestionLines({ kind: "diffuse", refusal: { kind: "too-many-components", components: 65 } }, "t")[0]!,
    /it breaks into more than 64 separate components, and no 3 rects cover those without covering the frame/,
  );
  assert.match(
    maskSuggestionLines({ kind: "diffuse", refusal: { kind: "too-loose", tightness: 0.4 } }, "t")[0]!,
    /the rects that would cover it are only 40% drifted pixels, under the 60% tightness bar/,
  );
  // Three different sentences, not three spellings of one.
  const sentences = new Set(
    (
      [
        { kind: "over-cap", fraction: 0.12 },
        { kind: "too-many-components", components: 65 },
        { kind: "too-loose", tightness: 0.4 },
      ] as const
    ).map((refusal) => maskSuggestionLines({ kind: "diffuse", refusal }, "t")[0]!),
  );
  assert.equal(sentences.size, 3);
});

test("MX7: the tightness bar is 0.6, measured on the AGGREGATE UNION, and the boundary is deliberate", () => {
  // FOUR solid 10x10 blobs: two stacked in a column `gap` apart, two more in a second
  // column. Four components do not fit in three rects, so the closest pair MERGES, and the
  // merged box swallows the vertical gap as empty space. Widening the gap by one pixel is
  // therefore a controlled slide down the tightness scale, with the drifted pixel count
  // held fixed at 400.
  const fixture = (gap: number) =>
    bitmapOfRects([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 0, y: gap, w: 10, h: 10 },
      { x: 60, y: 0, w: 10, h: 10 },
      { x: 60, y: gap, w: 10, h: 10 },
    ]);
  // union = the merged 10x(gap+10) column + the two unmerged 10x10 blobs.
  const tightnessAt = (gap: number) => 400 / (10 * (gap + 10) + 200);

  // gap 37 -> 59.7% of the union is actually drifted: REFUSED, and the refusal reports the
  // number it measured rather than the word "diffuse".
  assert.ok(tightnessAt(37) < MIN_CLUSTER_TIGHTNESS);
  assert.deepEqual(clusterDriftRects(fixture(37), W, H, 400), { kind: "too-loose", tightness: tightnessAt(37) });

  // gap 36 -> 60.6%: ACCEPTED, as three rects whose union IS the thing that was measured.
  assert.ok(tightnessAt(36) >= MIN_CLUSTER_TIGHTNESS);
  assert.deepEqual(clusterDriftRects(fixture(36), W, H, 400), [
    { x: 0, y: 0, w: 10, h: 46 },
    { x: 60, y: 0, w: 10, h: 10 },
    { x: 60, y: 36, w: 10, h: 10 },
  ]);

  // THE RECONCILIATION with the 0.5 bar this replaces: gap 37 sits squarely in the band the
  // old rule ACCEPTED. At 0.5 a suggested rect set was allowed to be half unchanged frame,
  // which is a coin flip dressed as a recommendation, and the suggestion is the one surface
  // that hands an operator a command to type. Under 0.5 this fixture printed a mask command;
  // under 0.6 it prints the honest refusal.
  assert.ok(tightnessAt(37) >= 0.5, "the old bar would have suggested rects for this exact drift");
  assert.equal(MIN_CLUSTER_TIGHTNESS, 0.6);

  // AGGREGATE, not per-rect: each individual blob above is 100% drifted, and the set is
  // still refused. A per-rect rule would have called this tight and been wrong about the
  // only number that matters, which is what a mask actually spends.
  assert.deepEqual(clusterDriftRects(bitmapOfRects([{ x: 0, y: 0, w: 10, h: 10 }]), W, H, 100), [
    { x: 0, y: 0, w: 10, h: 10 },
  ]);
});

test("a TIGHT cluster is found, and a cluster set over the cap is refused as diffuse", () => {
  const tight = new Uint8Array(FRAME_PIXELS);
  for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) tight[y * W + x] = 1;
  assert.deepEqual(clusterDriftRects(tight, W, H, 400), [{ x: 10, y: 10, w: 20, h: 20 }]);

  // 12% of the frame in one solid block: perfectly tight, and still refused, because the
  // suggestion may never recommend something the stamp would reject.
  const huge = new Uint8Array(FRAME_PIXELS);
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 100; x += 1) huge[y * W + x] = 1;
  assert.deepEqual(clusterDriftRects(huge, W, H, 1200), { kind: "over-cap", fraction: 0.12 });
  assert.ok(1200 / FRAME_PIXELS > MAX_MASKED_FRACTION);
});

test("the drift sha and bounds are recorded per capture, which is what makes run two possible", () => {
  const baseline = image([]);
  const a = comparePerceptual(image([{ x: 10, y: 10, w: 10, h: 10 }]), baseline);
  const b = comparePerceptual(image([{ x: 12, y: 10, w: 10, h: 10 }]), baseline);
  const again = comparePerceptual(image([{ x: 10, y: 10, w: 10, h: 10 }]), baseline);
  assert.deepEqual(a.driftBounds, { x: 10, y: 10, w: 10, h: 10 });
  assert.equal(a.driftDiffSha, again.driftDiffSha, "the same pixels moving is the same sha, every time");
  assert.notEqual(a.driftDiffSha, b.driftDiffSha, "…and different pixels are a different sha");
  // A match carries neither: there is no drift to characterize.
  assert.equal(comparePerceptual(baseline, baseline).driftDiffSha, undefined);
});

// ── MX8: BOTH DOORS PRINT, through the code that decides whether to ─────────

test("MX8: the trace verb PRINTS the mask verdict, through the real summary block", async () => {
  const root = await approvedProject();
  try {
    const artifact: ReplayRunArtifact = {
      ...artifactFor(root),
      visualDrift: true,
      toleranceUsed: DEFAULT_DRIFT_FRACTION,
      maskSuggestion: { kind: "identical", captures: ["cap"], exact: true },
    };
    artifact.segments[0]!.captures[0]!.visualStatus = "drift";
    artifact.segments[0]!.captures[0]!.diffFraction = 0.013;

    const { out } = await captured(async () => {
      printSummary(root, "demo", artifact, path.join(root, "r.json"), undefined, true);
      return 0;
    });
    assert.match(out, /pixel-drift regression \(exit 1\)/);
    assert.match(out, /pixel drift only: max 1\.3% across 1 capture\(s\)/);
    assert.match(out, new RegExp(`the drift is IDENTICAL across two runs: ${DETERMINISTIC_DRIFT_WARNING.replace(/[.;]/g, "\\$&")}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX8: drift PLUS a capture gap prints NO suggestion at all: a harness fault is never answered with a mask", async () => {
  // THE GATE, driven through the code that applies it. An unreadable capture is not drift,
  // and "mask this region" as the remedy for a broken capture is the laundering of a
  // harness fault into a consented allowance that the tiering rules exist to prevent. Both
  // suggestions live behind ONE predicate, and this is the case that proves it is still an
  // `if` and not a comment.
  const root = await approvedProject();
  try {
    const artifact: ReplayRunArtifact = {
      ...artifactFor(root),
      visualDrift: true,
      visualHarnessFault: true,
      toleranceUsed: DEFAULT_DRIFT_FRACTION,
      maskSuggestion: { kind: "suggest", rects: [{ x: 1, y: 1, w: 2, h: 2, reason: "ambient-animation" }], captures: 1, fraction: 0.0004 },
    };
    artifact.segments[0]!.captures[0]!.visualStatus = "drift";
    artifact.segments[0]!.captures[0]!.diffFraction = 0.013;

    assert.equal(shouldSuggestTolerance(artifact), false);
    const { out } = await captured(async () => {
      printSummary(root, "demo", artifact, path.join(root, "r.json"), undefined, true);
      return 0;
    });
    assert.doesNotMatch(out, /trace mask --id demo --set/, "a capture gap never answers with a rect");
    assert.doesNotMatch(out, /trace tolerance --id demo --set/);
    assert.doesNotMatch(out, /drift is diffuse/);
    // …and the drift itself is still reported: the gate silences the ADVICE, not the fact.
    assert.match(out, /pixel-drift regression \(exit 2\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the combined consent, at every door ─────────────────────────────────────

test("ONE combined consent sentence, and it names both allowances together", () => {
  const rects: MaskRect[] = [{ x: 0, y: 0, w: 20, h: 20, reason: "hud" }];
  assert.equal(
    anchorTermsSentence(maskAnchorTerms(rects, W, H, 0.015)),
    "1 mask(s) hide 4% of every frame outright; the rest grades at 1.5%, anything covering up to ~12% of " +
      "frame width by ~12% of height can change undetected; " +
      // M5/MX4: THE ARITHMETIC, DONE. "4% masked" and "1.5% tolerance" is the truth twice
      // and the answer zero times; the question a gate answers is how much of the frame can
      // move while it stays green, and that is the sum.
      "together, up to 5.5% of the frame can change while the gate stays green",
  );
  // The composed number is not decorative: it is the number nobody was computing.
  assert.equal(
    combinedBlindnessClause({ maskCount: 2, maskedFraction: 0.08, scopedCount: 0, tolerance: 0.02 }),
    "together, up to 10% of the frame can change while the gate stays green",
  );
  // Masks with the DEFAULT tolerance still speak: the masks alone are worth disclosing.
  assert.match(
    anchorTermsSentence(maskAnchorTerms(rects, W, H, DEFAULT_DRIFT_FRACTION)) ?? "",
    /1 mask\(s\) hide 4% of every frame outright; the rest grades at 0\.5%/,
  );
  // A capture-scoped rect says so, because "every frame" would be a bigger claim than
  // the truth in the direction that flatters the anchor.
  assert.match(
    anchorTermsSentence(maskAnchorTerms([{ ...rects[0]!, captureId: "cap" }], W, H, DEFAULT_DRIFT_FRACTION)) ?? "",
    /of a frame \(1 of them scoped to one capture\) outright/,
  );
});

test("the unified PLAN prints the anchor terms on their own line, from the typed mask fields", async () => {
  const root = await approvedProject();
  const workspace = await tmpRoot();
  try {
    const bare = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    assert.doesNotMatch(planLines(root, bare.assets, bare.notes, true).join("\n"), /anchor terms/);

    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "0,0,20x20@hud clock"]));
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));

    const { assets, notes } = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = assets.find((a) => a.kind === "trace")!;
    assert.equal(row.maskCount, 1, "typed, so a test never has to parse a sentence for it");
    assert.equal(row.maskedFraction, 0.04);
    assert.equal(row.runnable, "live", "a stamped mask does not change what the row can do");

    const plan = planLines(root, assets, notes, true).join("\n");
    assert.match(
      plan,
      /anchor terms: 1 mask\(s\) hide 4% of every frame outright; the rest grades at 1%, anything covering up to ~10%/,
    );
    // Q7: the terms are their own line, not an extension of the run-on above them.
    assert.match(plan, /trace 'demo': will run \(live\); approved [^\n]*\n[^\n]*anchor terms:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("MX11: a CAPTURE-SCOPED mask reaches the plan line as a scoped count, end to end", async () => {
  // V5. `maskScopedCount` was set by discovery and read by the plan, and nothing asserted
  // the number that travelled between them: hardcoding it to 0 kept every test green while
  // the plan line said "every frame" about an anchor that hides a region of ONE frame. That
  // is the direction that flatters the anchor, because "every frame" understates how
  // unevenly this comparison is graded.
  const root = await approvedProject("demo", ["cap", "cap2"]);
  const workspace = await tmpRoot();
  try {
    const stamped = await captured(() =>
      run(["mask", "--id", "demo", "--root", root, "--set", "cap:0,0,20x20@hud clock", "--set", "10,60,10x10@sparkles"]),
    );
    assert.equal(stamped.code, 0, stamped.out);

    const { assets, notes } = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = assets.find((a) => a.kind === "trace")!;
    assert.equal(row.maskCount, 2);
    assert.equal(row.maskScopedCount, 1, "TYPED, so the plan never has to parse a sentence for it");
    assert.equal(row.maskedFraction, 0.05, "the WORST frame's: 'cap' is hidden twice over, 'cap2' once");

    const plan = planLines(root, assets, notes, true).join("\n");
    assert.match(plan, /anchor terms: 2 mask\(s\) hide 5% of a frame \(1 of them scoped to one capture\) outright/);
    assert.doesNotMatch(plan, /hide 5% of every frame/, "not every frame is hidden equally, and the line must not say so");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("MX9: the REAL report writer emits the header and the overlays, not just the pure renderer", async () => {
  // V2. Everything the HTML knows about masks arrives through `writeHtmlReport`'s chrome
  // argument, and the renderer was pinned with a hand-built chrome object: passing `{}`
  // from the producer would have emitted a report with no terms line and no outlines while
  // every HTML test stayed green. This drives the shipped path end to end.
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,20,20x20@hud clock"]));
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));
    const { artifact } = await grade(root);
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, "match");
    await persistReport(root, artifact);

    const rendered = await captured(() => run(["report", "--id", "demo", "--root", root]));
    assert.equal(rendered.code, 0, rendered.out);
    const html = await fs.readFile(path.join(standardReplayLayout(root).replayReports, "demo.report.html"), "utf-8");

    assert.match(html, /anchor terms: 1 mask\(s\) hide 4% of every frame outright; the rest grades at 1%/);
    assert.match(html, /together, up to 5% of the frame can change while the gate stays green/);
    assert.match(html, /class="mask" style="left:10\.00%;top:20\.00%;width:20\.00%;height:20\.00%"/);
    assert.equal(html.match(/class="mask"/g)?.length, 2, "drawn on BOTH thumbnails, or a reader sees agreement");
    assert.match(html, /masked: hud clock/);
    assert.match(html, /4\.00% masked/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MX9: an UNGRADED run's header states the ANCHOR's real terms, never the strict default", async () => {
  // V3. `toleranceUsed` is stamped only where a comparison HAPPENED, so a run refused at
  // the harness tier (here: the pacing mismatch) carries none, and the header used to fall
  // back to the 0.5% default: the report of a refused run advertised a STRICTER anchor than
  // the one on disk, which is exactly the moment a reader is trying to find out what the
  // anchor actually concedes. The masks already fell back to the anchor; the tolerance now
  // falls back the same way.
  const root = await approvedProject();
  try {
    await captured(() => run(["mask", "--id", "demo", "--root", root, "--set", "10,20,20x20@hud clock"]));
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));
    await editManifest(root, { replaySpeed: 2 });

    const { artifact, out } = await grade(root);
    assert.match(out, /approved at 2x pacing but this run replayed at 1x/);
    assert.equal(artifact.toleranceUsed, undefined, "nothing was graded, so no terms were claimed by the RUN");
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, undefined);
    await persistReport(root, artifact);

    await captured(() => run(["report", "--id", "demo", "--root", root]));
    const html = await fs.readFile(path.join(standardReplayLayout(root).replayReports, "demo.report.html"), "utf-8");
    assert.match(html, /anchor terms: 1 mask\(s\) hide 4% of every frame outright; the rest grades at 1%/);
    assert.doesNotMatch(html, /the rest grades at 0\.5%/, "the default would understate what this anchor concedes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the HTML report draws the mask rects on the thumbnails and carries the consent in the header", () => {
  const artifact = artifactFor("/tmp/x");
  const html = renderReplayReportHtml(
    { ...artifact, toleranceUsed: 0.01 },
    [
      {
        id: "cap",
        segment: "s",
        base64: "AA==",
        baselineBase64: "AA==",
        visualStatus: "match",
        diffFraction: 0,
        maskedFraction: 0.04,
        masks: [{ x: 10, y: 20, w: 20, h: 20, reason: "hud clock" }],
      },
    ],
    {
      frameWidth: W,
      frameHeight: H,
      anchorTerms: anchorTermsSentence(
        maskAnchorTerms([{ x: 10, y: 20, w: 20, h: 20, reason: "hud clock" }], W, H, 0.01),
      ),
    },
  );
  // The overlay, in PERCENTAGES so it survives the responsive thumbnail width.
  assert.match(html, /class="mask" style="left:10\.00%;top:20\.00%;width:20\.00%;height:20\.00%"/);
  assert.match(html, /masked: hud clock/);
  // Drawn on BOTH frames: a reader comparing them has to see the blanked region twice.
  assert.equal(html.match(/class="mask"/g)?.length, 2);
  assert.match(html, /anchor terms: 1 mask\(s\) hide 4% of every frame outright/);
  assert.match(html, /4\.00% masked/);

  // No frame dims means no overlay: an outline positioned against an unknown frame would
  // point at the wrong pixels, which is worse than no outline.
  const blind = renderReplayReportHtml(artifact, [
    { id: "cap", segment: "s", base64: "AA==", visualStatus: "match", masks: [{ x: 1, y: 1, w: 2, h: 2, reason: "r" }] },
  ]);
  assert.doesNotMatch(blind, /class="mask"/);
});

test("an unmasked report renders exactly as it did: no terms line, no overlay", () => {
  const html = renderReplayReportHtml(artifactFor("/tmp/x"), [
    { id: "cap", segment: "s", base64: "AA==", visualStatus: "match", diffFraction: 0 },
  ]);
  assert.doesNotMatch(html, /anchor terms/);
  assert.doesNotMatch(html, /class="mask"/);
  assert.doesNotMatch(html, /masked/);
});
