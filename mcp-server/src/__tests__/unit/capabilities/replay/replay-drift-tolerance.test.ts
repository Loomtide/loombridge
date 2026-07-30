/**
 * THE PER-TRACE DRIFT TOLERANCE, and why every one of these tests exists.
 *
 * A game that animates under its own clock cannot hold a frozen frame to 0.5% of pixels,
 * so the pixel gate goes permanently red and gets ignored, which protects nothing. The
 * fix is a BOUNDED, HUMAN-APPROVED allowance stamped on the anchor itself. Everything
 * dangerous about that idea is what this file pins:
 *
 *  - the allowance lives in the approved manifest, never in a runtime flag, so a looser
 *    comparison is always something a person stamped;
 *  - it is capped at 2% on BOTH sides (stamp time and read time) by ONE constant, so a
 *    hand-edited manifest is a refusal rather than a self-service exemption;
 *  - `approve` NEVER takes it: the verbs are split precisely so that an operator staring
 *    at a drift failure cannot widen the gate and re-freeze the drifted frames in one
 *    command, which would destroy the anchor by way of trying to keep it;
 *  - a baseline that cannot be verified AT GRADE TIME is a harness fault, never a quiet
 *    fall back to the default tolerance;
 *  - the suggestion loop never fires for a harness fault, because an unreadable capture
 *    is not drift and "widen the tolerance" is not a remedy for it.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { readFileSync } from "node:fs";

import {
  applyVisualDiff,
  driftFacts,
  replayExitCode,
  run,
  shouldSuggestTolerance,
} from "../../../../capabilities/replay/trace.js";
import {
  TRACE_BASELINE_MANIFEST,
  isTraceBaselineManifestError,
  loadTraceBaselineManifest,
  resolveDriftTolerance,
  toleranceRefusal,
  type TraceBaselineManifest,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import {
  DEFAULT_DRIFT_FRACTION,
  MAX_DRIFT_TOLERANCE,
  comparePerceptual,
  driftRegressionLine,
  driftSuggestionLines,
  suggestedDriftTolerance,
  toleranceConsentSentence,
} from "../../../../capabilities/replay/visual-diff.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import { PKG_ROOT } from "../../../_support/paths.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "trace-tolerance-"));
}

/** Run a verb with stderr captured, so refusal WORDING can be pinned, not just tiers. */
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

/**
 * A real 100x100 RGBA PNG (10000 pixels) whose first `blackPixels` pixels are black on
 * white. The count IS the diff fraction against the all-white frame: 130 black pixels is
 * exactly 1.3%, which sits between the 0.5% default and the 2% cap. That is the whole
 * measured case this feature exists for, so the fixture states it in pixels rather than
 * hoping an image happens to land in the window.
 */
function pngWithBlackPixels(blackPixels: number): Buffer {
  const width = 100;
  const height = 100;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  let painted = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      const black = painted < blackPixels;
      painted += 1;
      const v = black ? 0 : 255;
      raw[o++] = v;
      raw[o++] = v;
      raw[o++] = v;
      raw[o++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function writeTrace(root: string, id: string): Promise<void> {
  const traces = path.join(root, ".loombridge", "replays", "traces");
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

/** The capture path a report/artifact points at. */
function actualPngPath(root: string, id: string): string {
  return path.join(standardReplayLayout(root).replayReports, id, "actual", "cap.png");
}

async function writeReport(
  root: string,
  id: string,
  captures: Array<{ id: string; artifact: string; visualStatus?: string }>,
): Promise<void> {
  const reports = standardReplayLayout(root).replayReports;
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(
    path.join(reports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
}

/**
 * A project with an APPROVED baseline: white frame captured, promoted through the real
 * `trace approve` (so the manifest's shas are the real ones, never hand-written).
 */
async function approvedProject(id = "demo"): Promise<string> {
  const root = await tmpRoot();
  const actual = actualPngPath(root, id);
  await fs.mkdir(path.dirname(actual), { recursive: true });
  await fs.writeFile(actual, pngWithBlackPixels(0));
  await writeTrace(root, id);
  await writeReport(root, id, [{ id: "cap", artifact: actual }]);
  const approved = await captured(() => run(["approve", "--id", id, "--root", root]));
  assert.equal(approved.code, 0, approved.out);
  return root;
}

/** A one-capture artifact over this project's captured frame, ready for `applyVisualDiff`. */
function artifactFor(root: string, id = "demo"): ReplayRunArtifact {
  return {
    traceId: id,
    status: "pass",
    resetTier: "scene-load",
    segments: [
      { id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPngPath(root, id) }] },
    ],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "t",
    finishedAt: "t",
    durationMs: 1,
  };
}

async function readManifest(root: string, id = "demo"): Promise<TraceBaselineManifest> {
  const loaded = await loadTraceBaselineManifest(path.join(standardReplayLayout(root).replayBaselines, id));
  assert.ok(loaded !== null && !isTraceBaselineManifestError(loaded), `expected a readable manifest: ${JSON.stringify(loaded)}`);
  return loaded;
}

/** Hand-edit the stamped manifest, the way an operator with a text editor would. */
async function editManifest(root: string, patch: Record<string, unknown>, id = "demo"): Promise<void> {
  const file = path.join(standardReplayLayout(root).replayBaselines, id, TRACE_BASELINE_MANIFEST);
  const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  await fs.writeFile(file, JSON.stringify({ ...parsed, ...patch }, null, 2));
}

// ── the cap, on BOTH sides, through the one reader ───────────────────────────

test("trace tolerance: 0.02 stamps and roundtrips; 0 is valid (pixel exactness); the ledger records the change", async () => {
  const root = await approvedProject();
  try {
    const first = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.02"]));
    assert.equal(first.code, 0, first.out);
    const stamped = await readManifest(root);
    assert.equal(stamped.driftTolerance, 0.02);
    assert.equal(stamped.approvalCount, 2, "the stamp is an approval event, and the ledger counts it");
    assert.ok(stamped.previousApprovedAt, "the previous approval timestamp is preserved, not overwritten silently");
    assert.equal(stamped.pngs.length, 1, "no frame was touched");

    // Exact 0 is a real value, not "absent": it demands pixel exactness, which is
    // STRICTER than the default, so it can only ever cause more refusals.
    const zero = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0"]));
    assert.equal(zero.code, 0, zero.out);
    const zeroed = await readManifest(root);
    assert.equal(zeroed.driftTolerance, 0);
    assert.equal(resolveDriftTolerance(zeroed), 0, "0 must never resolve to the default");
    assert.equal(zeroed.previousDriftTolerance, 0.02, "the ledger names what the tolerance used to be");
    assert.match(zero.out, /every pixel must match exactly/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CAP LITMUS (stamp side): --set 0.06 refuses with the vacuity sentence and stamps nothing", async () => {
  const root = await approvedProject();
  try {
    const before = await readManifest(root);
    const refused = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.06"]));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /above the 0\.02 cap/);
    // The sentence now names the verb that DOES exist: masks shipped, so pointing an
    // operator at "future work" would be pointing them at nothing.
    assert.match(refused.out, /makes the pixel comparison vacuous; use masks \(`trace mask`\) or investigate the drift/);
    const after = await readManifest(root);
    assert.equal(after.driftTolerance, undefined, "a refused value must not reach the manifest");
    assert.equal(after.approvedAt, before.approvedAt, "…and must not re-stamp the anchor either");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CAP LITMUS (read side): a HAND-EDITED over-cap tolerance is refused by the one reader", async () => {
  const root = await approvedProject();
  try {
    // The stamp-time refusal alone would be theatre: the manifest is a JSON file an
    // operator can edit, so the cap has to hold where every grader actually reads.
    await editManifest(root, { driftTolerance: 0.9 });
    const loaded = await loadTraceBaselineManifest(path.join(standardReplayLayout(root).replayBaselines, "demo"));
    assert.ok(isTraceBaselineManifestError(loaded), "an over-cap manifest must be a typed error, not a manifest");
    assert.match(loaded.error, /above the 0\.02 cap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the read side refuses every LOOSENING value non-coercively, and treats absence as the default", () => {
  // F9: `Number("0.9")` is 0.9, and a reader that coerced would accept a manifest field
  // nobody validated. Wrong TYPES are refused as wrong types.
  for (const bad of ["0.9", "0.01", true, null, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.notEqual(toleranceRefusal(bad, "driftTolerance"), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
  assert.notEqual(toleranceRefusal(-0.001, "driftTolerance"), null, "a negative tolerance is meaningless");
  assert.notEqual(toleranceRefusal(0.021, "driftTolerance"), null, "just over the cap is still over the cap");
  // Absence is the ONLY value that resolves to a default, and the default is the
  // strictest thing the field can hold, so the absence can never loosen anything.
  assert.equal(toleranceRefusal(undefined, "driftTolerance"), null);
  assert.equal(toleranceRefusal(0, "driftTolerance"), null);
  assert.equal(toleranceRefusal(MAX_DRIFT_TOLERANCE, "driftTolerance"), null);
  assert.ok(DEFAULT_DRIFT_FRACTION < MAX_DRIFT_TOLERANCE);
});

test("FAIL-SAFE DIRECTION: schemaVersion stays '1' because a pre-field reader grades STRICTLY", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.02"]));
    const stamped = await readManifest(root);
    assert.equal(stamped.schemaVersion, "1", "the field is additive: old manifests keep grading exactly as before");

    // The direction that makes that safe: a reader that never heard of `driftTolerance`
    // uses the default, and the default REFUSES a run the stamped tolerance would have
    // passed. An unknown field can therefore only ever cost a false green, never buy one.
    const baseline = { width: 100, height: 100, data: new Uint8Array(pixels(0)) };
    const actual = { width: 100, height: 100, data: new Uint8Array(pixels(130)) };
    assert.equal(comparePerceptual(actual, baseline).status, "drift", "the pre-field reader refuses");
    assert.equal(
      comparePerceptual(actual, baseline, { driftFraction: resolveDriftTolerance(stamped) }).status,
      "match",
      "…and only the stamped, human-approved tolerance passes it",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** RGBA bytes for the same 100x100 frame the PNG fixture encodes. */
function pixels(blackPixels: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10000; i += 1) {
    const v = i < blackPixels ? 0 : 255;
    out.push(v, v, v, 255);
  }
  return out;
}

// ── enforcement: the stamped tolerance is what grades ────────────────────────

test("ENFORCEMENT LITMUS: 1.3% of pixels is drift at the default and a match at the approved 0.02", async () => {
  const root = await approvedProject();
  try {
    // The frame moved by exactly 130 of 10000 pixels: over the 0.5% default, under 2%.
    await fs.writeFile(actualPngPath(root, "demo"), pngWithBlackPixels(130));

    const atDefault = artifactFor(root);
    await applyVisualDiff(standardReplayLayout(root), "demo", atDefault);
    const capture = atDefault.segments[0]!.captures[0]!;
    assert.equal(capture.visualStatus, "drift");
    assert.equal(capture.toleranceUsed, DEFAULT_DRIFT_FRACTION, "the terms are stamped where the decision happened");
    assert.equal(atDefault.toleranceUsed, DEFAULT_DRIFT_FRACTION);
    assert.equal(replayExitCode(atDefault, true), 1, "the unified door gates drift by default");
    assert.equal(Math.round((capture.diffFraction ?? 0) * 10000) / 10000, 0.013);

    const stamped = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.02"]));
    assert.equal(stamped.code, 0, stamped.out);

    const atApproved = artifactFor(root);
    await applyVisualDiff(standardReplayLayout(root), "demo", atApproved);
    assert.equal(atApproved.segments[0]!.captures[0]!.visualStatus, "match");
    assert.equal(atApproved.segments[0]!.captures[0]!.toleranceUsed, 0.02);
    assert.equal(atApproved.toleranceUsed, 0.02, "the run records the terms it graded on");
    assert.equal(atApproved.visualDrift, undefined);
    assert.equal(replayExitCode(atApproved, true), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GRADE-TIME VERIFICATION LITMUS: an over-cap manifest is a HARNESS FAULT, never a default fallback", async () => {
  const root = await approvedProject();
  try {
    await fs.writeFile(actualPngPath(root, "demo"), pngWithBlackPixels(130));
    await editManifest(root, { driftTolerance: 0.9 });

    const artifact = artifactFor(root);
    const { out } = await captured(async () => {
      await applyVisualDiff(standardReplayLayout(root), "demo", artifact);
      return 0;
    });
    const capture = artifact.segments[0]!.captures[0]!;
    // DELIBERATE CHANGE (live conflation finding): artifact-level fault, capture ungraded.
    assert.equal(capture.visualStatus, undefined, "the capture itself is ungraded, not unreadable");
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(artifact.visualDrift, undefined, "an unreadable anchor is never reported as a game defect");
    assert.equal(capture.toleranceUsed, undefined, "nothing was graded, so no terms are claimed");
    assert.equal(replayExitCode(artifact, false), 2);
    assert.match(out, /cannot be trusted at grade time \(harness fault, not a game defect\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GRADE-TIME VERIFICATION: a TAMPERED baseline frame is a harness fault at grade time too", async () => {
  const root = await approvedProject();
  try {
    // Swap the approved frame's bytes: the sha in the manifest no longer describes what
    // is on disk, so the comparison would be against a frame no human approved.
    const baselinePng = path.join(standardReplayLayout(root).replayBaselines, "demo", "cap.png");
    await fs.writeFile(baselinePng, pngWithBlackPixels(5000));
    const artifact = artifactFor(root);
    await captured(async () => {
      await applyVisualDiff(standardReplayLayout(root), "demo", artifact);
      return 0;
    });
    // Same deliberate change as above: artifact-level fault, capture left ungraded.
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, undefined);
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(artifact.visualDrift, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a LEGACY baseline (no manifest at all) still grades, at the strict default", async () => {
  // Unstamped is not broken: those baselines predate stamping, and the unified door
  // already refuses to treat them as anchors. Grading them at the default is the
  // strictest thing available, so the legacy path can never be the lenient one.
  const root = await approvedProject();
  try {
    await fs.rm(path.join(standardReplayLayout(root).replayBaselines, "demo", TRACE_BASELINE_MANIFEST));
    await fs.writeFile(actualPngPath(root, "demo"), pngWithBlackPixels(130));
    const artifact = artifactFor(root);
    await captured(async () => {
      await applyVisualDiff(standardReplayLayout(root), "demo", artifact);
      return 0;
    });
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, "drift");
    assert.equal(artifact.visualHarnessFault, undefined);
    assert.equal(artifact.toleranceUsed, DEFAULT_DRIFT_FRACTION);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the verb split: approve never widens, tolerance never re-freezes ─────────

test("trace tolerance: refuses when there is no approved baseline (1) and when one is broken (2)", async () => {
  const bare = await tmpRoot();
  try {
    const none = await captured(() => run(["tolerance", "--id", "demo", "--root", bare, "--set", "0.01"]));
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
    const broken = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));
    assert.equal(broken.code, 2, broken.out);
    assert.match(broken.out, /A baseline that cannot be read is not an anchor/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve PRESERVES a stamped tolerance (and says so), and never accepts one itself", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.015"]));
    const again = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(again.code, 0, again.out);
    const manifest = await readManifest(root);
    assert.equal(manifest.driftTolerance, 0.015, "a re-freeze must not silently re-tighten a consented gate");
    assert.match(again.out, /drift tolerance 1\.5% preserved from the previous approval/);
    assert.match(again.out, /anything covering up to ~12% of frame width/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("F13: approve REFUSES a run with an unreadable capture, leaving the approved baseline intact", async () => {
  const root = await approvedProject();
  try {
    const before = await readManifest(root);
    await writeReport(root, "demo", [
      { id: "cap", artifact: actualPngPath(root, "demo"), visualStatus: "unreadable" },
    ]);
    const refused = await captured(() => run(["approve", "--id", "demo", "--root", root]));
    assert.equal(refused.code, 2, "a capture gap is the harness tier, never a game verdict");
    assert.match(refused.out, /could not be decoded \(cap\)/);
    assert.match(refused.out, /A capture gap is a harness fault, never an anchor/);
    const after = await readManifest(root);
    assert.equal(after.approvedAt, before.approvedAt, "the previous anchor is untouched by a refused approval");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the flag guard: --set belongs to exactly one subcommand ──────────────────

const TRACE_SRC = path.join(PKG_ROOT, "src", "capabilities", "replay", "trace.ts");

/**
 * THE SCAN: the subcommands `parseArgs` actually accepts, read from source, so a NEW
 * subcommand is covered by the walk below the day it is added rather than the day
 * somebody remembers this file.
 */
function acceptedSubcommands(source: string): string[] {
  return [...new Set([...source.matchAll(/sub !== "([a-z-]+)"/g)].map((m) => m[1]!))].sort();
}

test("A6 FLAG GUARD: --set / --drift-tolerance is refused on every subcommand except tolerance", async () => {
  const subs = acceptedSubcommands(readFileSync(TRACE_SRC, "utf-8"));
  // Non-vacuity: the scan is really reading the parser, not an empty file.
  assert.ok(subs.length >= 5, `the scan found only ${subs.join(", ")}; it is not reading parseArgs`);
  for (const known of ["approve", "replay", "record", "tolerance"]) {
    assert.ok(subs.includes(known), `the scan missed the known subcommand ${known}`);
  }

  const root = await tmpRoot();
  try {
    // Every subcommand the parser knows EXCEPT the ones that own each flag. Derived from
    // the scan rather than listed, so a new subcommand is covered the day it is added.
    // `--set` now has TWO owners (the two anchor-term verbs, tolerance and mask) and they
    // parse it differently; `--drift-tolerance` still names exactly one term, so it stays
    // tolerance-only and `mask` is walked for it like every other stranger.
    const owners: Record<string, string[]> = {
      "--set": ["tolerance", "mask"],
      "--drift-tolerance": ["tolerance"],
    };
    for (const [flag, owned] of Object.entries(owners)) {
      for (const sub of subs.filter((s) => !owned.includes(s))) {
        const { code, out } = await captured(() => run([sub, "--id", "demo", "--root", root, flag, "0.01"]));
        assert.equal(code, 2, `${sub} ${flag} must be a usage refusal:\n${out}`);
        assert.match(
          out,
          /is only valid on `trace tolerance`/,
          `${sub} ${flag} must name the verb that DOES take it`,
        );
        assert.match(out, /approve NEVER takes a tolerance or a mask/);
      }
    }
    // …and the mask-only flags are refused everywhere else, by the same guard.
    for (const flag of ["--clear", "--list"]) {
      for (const sub of subs.filter((s) => s !== "mask")) {
        const { code, out } = await captured(() => run([sub, "--id", "demo", "--root", root, flag]));
        assert.equal(code, 2, `${sub} ${flag} must be a usage refusal:\n${out}`);
        assert.match(out, /is only valid on `trace mask`/);
      }
    }
    // …and the one subcommand that does take it parses it (it fails later, on there
    // being no baseline, which is a different tier entirely).
    const accepted = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));
    assert.equal(accepted.code, 1, accepted.out);
    assert.doesNotMatch(accepted.out, /is only valid on/);
    // A value-less `tolerance` refuses rather than stamping an unstated value.
    const bare = await captured(() => run(["tolerance", "--id", "demo", "--root", root]));
    assert.equal(bare.code, 2, bare.out);
    assert.match(bare.out, /tolerance requires --set/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--set is non-coercing: an empty, unit-suffixed or negative value refuses rather than meaning 0", async () => {
  const root = await approvedProject();
  try {
    for (const bad of ["", " ", "2%", "abc", "-0.01", "1e400"]) {
      const { code, out } = await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", bad]));
      assert.equal(code, 2, `expected --set ${JSON.stringify(bad)} to refuse:\n${out}`);
    }
    const manifest = await readManifest(root);
    assert.equal(manifest.driftTolerance, undefined, "no refused value reached the anchor");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the suggestion loop, and the one case it must never fire on ──────────────

test("SUGGESTION LITMUS: the suggestion never fires on a harness fault, only on drift-only", () => {
  assert.equal(shouldSuggestTolerance({ status: "pass", visualDrift: true }), true);
  assert.equal(
    shouldSuggestTolerance({ status: "pass", visualDrift: true, visualHarnessFault: true }),
    false,
    "an unreadable capture is not drift; advising a wider tolerance would paper over a broken capture",
  );
  assert.equal(
    shouldSuggestTolerance({ status: "fail", visualDrift: true }),
    false,
    "when the actuation itself failed, the pixels are not the story",
  );
  assert.equal(shouldSuggestTolerance({ status: "pass" }), false);
});

test("the suggestion arithmetic is ceil-to-3-decimals plus 0.002, capped, with no floor", () => {
  assert.equal(suggestedDriftTolerance(0.013), 0.015, "the measured real-world case");
  assert.equal(suggestedDriftTolerance(0.0131), 0.016, "the ceiling is taken before the headroom");
  assert.equal(suggestedDriftTolerance(0.0001), 0.003, "no floor: a tiny drift suggests a tiny tolerance");
  assert.equal(suggestedDriftTolerance(0.019), MAX_DRIFT_TOLERANCE, "…and the cap always wins");
  assert.equal(suggestedDriftTolerance(0.5), MAX_DRIFT_TOLERANCE);
});

test("the suggestion NAMES `trace tolerance` (never approve) and states the blanket scope", () => {
  const lines = driftSuggestionLines({
    traceId: "happy-path-2",
    driftCaptures: 39,
    maxDiffFraction: 0.013,
    toleranceUsed: DEFAULT_DRIFT_FRACTION,
  });
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    "pixel drift only: max 1.3% across 39 capture(s); if this game animates, re-approve the tolerance with "
      + "`loombridge trace tolerance --id happy-path-2 --set 0.015`",
  );
  assert.doesNotMatch(
    lines.join("\n"),
    /trace approve/,
    "an approve-shaped suggestion would promote the drifted frames the operator was trying to keep",
  );
  assert.equal(
    lines[1],
    "this value applies to every capture in the trace: at 1.5%, anything covering up to ~12% of frame width "
      + "by ~12% of height can change undetected.",
  );

  // At the cap there is nothing left to suggest, and the honest answer says so rather
  // than printing a command that would change nothing.
  const atCap = driftSuggestionLines({
    traceId: "t",
    driftCaptures: 2,
    maxDiffFraction: 0.03,
    toleranceUsed: MAX_DRIFT_TOLERANCE,
  });
  assert.equal(atCap.length, 1);
  assert.match(atCap[0]!, /already at the 2% cap/);
  // Masks shipped, so the at-cap line points at the verb rather than at future work. It
  // still does NOT hand over a rect: only the two-run mask suggestion may do that.
  assert.match(atCap[0]!, /to MASK if it is localized ambient animation \(`loombridge trace mask --id t --list`\)/);
});

test("the consent sentence states the size of the hole, in both dimensions", () => {
  assert.equal(
    toleranceConsentSentence(0.02),
    "at 2%, anything covering up to ~14% of frame width by ~14% of height can change undetected",
  );
  assert.equal(
    toleranceConsentSentence(DEFAULT_DRIFT_FRACTION),
    "at 0.5%, anything covering up to ~7% of frame width by ~7% of height can change undetected",
  );
  assert.equal(toleranceConsentSentence(0), "at 0%, every pixel must match exactly");
});

test("R3: the drift line LEADS with the failing word and carries the numbers", () => {
  assert.equal(
    driftRegressionLine({ driftCaptures: 39, maxDiffFraction: 0.013, toleranceUsed: 0.005, exitTier: 1 }),
    "pixel-drift regression (exit 1): actuation passed, 39 capture(s) over tolerance, max 1.3%",
  );
  // The old wording is the bug: an artifact whose actuation passed printed "pass (exit 1)".
  assert.doesNotMatch(
    driftRegressionLine({ driftCaptures: 1, maxDiffFraction: 0.02, toleranceUsed: 0.005, exitTier: 1 }),
    /^pass/,
  );
});

test("driftFacts reads the run's own captures, so both doors quote the same numbers", () => {
  const artifact = {
    toleranceUsed: 0.02,
    segments: [
      {
        id: "s",
        status: "pass" as const,
        anchorsReached: [],
        captures: [
          { id: "a", visualStatus: "drift" as const, diffFraction: 0.011 },
          { id: "b", visualStatus: "drift" as const, diffFraction: 0.013 },
          { id: "c", visualStatus: "match" as const, diffFraction: 0.001 },
          { id: "d", visualStatus: "no-baseline" as const },
        ],
      },
    ],
  };
  assert.deepEqual(driftFacts(artifact), {
    driftCaptures: 2,
    maxDiffFraction: 0.013,
    toleranceUsed: 0.02,
  });
  // An artifact that never compared anything reports the default, never `undefined`
  // masquerading as a tolerance.
  assert.equal(driftFacts({ segments: [] }).toleranceUsed, DEFAULT_DRIFT_FRACTION);
});

test("the trace verb prints the drift line, the tolerance and the suggestion at its own door", async () => {
  const root = await approvedProject();
  try {
    await captured(() => run(["tolerance", "--id", "demo", "--root", root, "--set", "0.01"]));
    // A drift the approved 1% does not absorb: 1.3% of the frame moved.
    await fs.writeFile(actualPngPath(root, "demo"), pngWithBlackPixels(130));
    const artifact = artifactFor(root);
    await captured(async () => {
      await applyVisualDiff(standardReplayLayout(root), "demo", artifact);
      return 0;
    });
    assert.equal(artifact.visualDrift, true);
    assert.equal(shouldSuggestTolerance(artifact), true);
    assert.deepEqual(driftFacts(artifact), {
      driftCaptures: 1,
      maxDiffFraction: 0.013,
      toleranceUsed: 0.01,
    });
    assert.equal(
      driftSuggestionLines({ ...driftFacts(artifact), traceId: "demo" })[0],
      "pixel drift only: max 1.3% across 1 capture(s); if this game animates, re-approve the tolerance with "
        + "`loombridge trace tolerance --id demo --set 0.015`",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
