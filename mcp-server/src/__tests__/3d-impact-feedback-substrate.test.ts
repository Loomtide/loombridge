import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveHitstopMs,
  deriveScreenShakeMag,
  firstRisingEdge,
  isImmediateImpactFeedback,
} from "../verification/feel-derive.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundleRoot = join(repoRoot, "demo-bundles/3d-impact-feedback");
const RAW_NAME = "3d-impact-feedback-raw-2026-06-26.json";
const HITSTOP_NAME = "3d-hitstop-derived-2026-06-26.json";
const SCREEN_SHAKE_NAME = "3d-screen-shake-derived-2026-06-26.json";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type Sample = { tMs: number; x: number; y: number; z: number };
type FieldSample = { tMs: number; value: number | boolean };
type FieldSeries = { id: string; samples: FieldSample[]; unresolved?: string; readError?: string };

interface RawTranscript {
  op: string;
  capturedAt: string;
  host: { projectName: string; scene: string };
  request: { measure: { path: string }; captureFps: number; includeSamples: boolean };
  editorStateAfterCapture: { error_count: number };
  response: { sampleCount: number; durationMs: number; samples: Sample[]; fieldTimeline: FieldSeries[] };
}

interface DerivedArtifact {
  metric: string;
  dimensionality: string;
  capture: { samples: Sample[]; fieldTimeline: FieldSeries[] };
  derived: { metric: string; value: number; unit: string };
  causality: { hitEdgeMs: number; immediateImpactFeedback: boolean };
  substrateProof?: { derivedMag: number; zStrippedDerivation: number | null };
}

function runGenerator(): { hitstop: unknown; screenShake: unknown } {
  const tempDir = mkdtempSync(join(tmpdir(), "loomtide-3d-impact-"));
  const hitstopPath = join(tempDir, "hitstop.json");
  const screenShakePath = join(tempDir, "screen-shake.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(bundleRoot, "generate.mjs"),
        "--hitstop-output",
        hitstopPath,
        "--screen-shake-output",
        screenShakePath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `generate.mjs failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return {
      hitstop: JSON.parse(readFileSync(hitstopPath, "utf8")),
      screenShake: JSON.parse(readFileSync(screenShakePath, "utf8")),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const series = (raw: RawTranscript, id: string): FieldSeries => {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
};

test("3D impact: live capture measures the Main Camera with a true {x,y,z} trajectory + window series", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/Main Camera");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.request.includeSamples, true);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);

  const samples = raw.response.samples;
  assert.equal(samples.length, raw.response.sampleCount);
  assert.ok(samples.every((s) => Number.isFinite(s.z)), "every camera sample must carry a finite z");
  // The camera punch lives entirely in WORLD Z: x/y are constant, z leaves rest.
  assert.ok(samples.every((s) => s.x === samples[0]!.x), "camera x is constant (punch is z-only)");
  assert.ok(samples.every((s) => s.y === samples[0]!.y), "camera y is constant (punch is z-only)");
  assert.ok(
    samples.some((s) => Math.abs(s.z - samples[0]!.z) > 5e-3),
    "camera z must leave rest (a real punch)",
  );
  // Required field series are present.
  for (const id of ["IsHitStopped", "EnemyHitCount", "ShakeMagnitude"]) {
    assert.ok(raw.response.fieldTimeline.some((f) => f.id === id), `fieldTimeline must carry ${id}`);
  }
});

test("3D impact: hitstopMs re-derives from the raw window series and is causally tied to the hit edge", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(HITSTOP_NAME);
  const hitStopSeries = series(raw, "IsHitStopped");
  const hitEdgeSeries = series(raw, "EnemyHitCount");

  const hitstop = deriveHitstopMs(hitStopSeries);
  assert.ok(hitstop.ok, `deriveHitstopMs must measure the window: ${hitstop.ok ? "" : hitstop.reason}`);
  assert.equal(derived.derived.value, hitstop.ok ? hitstop.latencyMs : NaN);
  assert.equal(derived.derived.unit, "ms");

  // Causality: the window opens on the SAME frame as the hit edge (or within one frame).
  const hitEdgeMs = firstRisingEdge(hitEdgeSeries);
  const windowEdgeMs = firstRisingEdge(hitStopSeries);
  assert.ok(hitEdgeMs !== null && windowEdgeMs !== null);
  assert.ok(
    isImmediateImpactFeedback(windowEdgeMs, hitEdgeMs, 1000 / raw.request.captureFps),
    "hit-stop window must open immediately after the hit edge",
  );
  assert.equal(derived.causality.immediateImpactFeedback, true);
});

test("3D impact: screenShakeMag re-derives in 3D and Z is load-bearing (X/Y projection refuses)", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(SCREEN_SHAKE_NAME);
  const samples = raw.response.samples;
  const hitEdgeMs = firstRisingEdge(series(raw, "EnemyHitCount"));
  assert.ok(hitEdgeMs !== null);

  const mag = deriveScreenShakeMag(samples, hitEdgeMs);
  assert.ok(mag !== null, "deriveScreenShakeMag must measure the 3D camera punch");
  assert.equal(derived.derived.value, mag);
  assert.equal(derived.derived.unit, "u");
  assert.equal(derived.dimensionality, "3D");

  // HEADLINE PROOF: strip z → the X/Y projection of a z-only punch → the SAME calculator REFUSES.
  const samplesNoZ = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
  assert.equal(deriveScreenShakeMag(samplesNoZ, hitEdgeMs), null, "Z-stripped projection must refuse");
  assert.equal(derived.substrateProof?.zStrippedDerivation, null);
  assert.equal(derived.substrateProof?.derivedMag, mag);
});

test("3D impact: canonical artifacts are reproducible from the raw transcript (not minted)", () => {
  const hitstop = readJson<DerivedArtifact>(HITSTOP_NAME);
  const screenShake = readJson<DerivedArtifact>(SCREEN_SHAKE_NAME);
  const regenerated = runGenerator();
  assert.deepEqual(regenerated.hitstop, hitstop);
  assert.deepEqual(regenerated.screenShake, screenShake);
  // Embedded samples are copied verbatim from the raw response.
  const raw = readJson<RawTranscript>(RAW_NAME);
  const verbatim = raw.response.samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
  assert.deepEqual(hitstop.capture.samples, verbatim);
  assert.deepEqual(screenShake.capture.samples, verbatim);
});

// ── Negative / degraded cases (pure calculators; no live capture needed) ──────────────

test("3D impact: hitstopMs refuses a degraded / windowless / never-closing series, never greens", () => {
  // Degraded (readError) → refuse.
  assert.equal(
    deriveHitstopMs({ id: "IsHitStopped", samples: [{ tMs: 0, value: false }], readError: "getter threw" }).ok,
    false,
  );
  // No rising edge (window never opened) → refuse.
  assert.equal(
    deriveHitstopMs({
      id: "IsHitStopped",
      samples: [
        { tMs: 0, value: false },
        { tMs: 16.67, value: false },
        { tMs: 33.34, value: false },
      ],
    }).ok,
    false,
  );
  // Rises but never falls (window did not close in-window) → refuse (inconclusive, not clamped).
  assert.equal(
    deriveHitstopMs({
      id: "IsHitStopped",
      samples: [
        { tMs: 0, value: false },
        { tMs: 16.67, value: true },
        { tMs: 33.34, value: true },
      ],
    }).ok,
    false,
  );
});

test("3D impact: screenShakeMag refuses a static camera, pre-impact motion, and a z-only punch stripped of z", () => {
  // Static camera (never displaced) → null (no shake observed), never a fabricated 0.
  const still = Array.from({ length: 8 }, (_u, i) => ({ tMs: i * 16.67, x: 0, y: 2, z: -8 }));
  assert.equal(deriveScreenShakeMag(still), null);

  // Pre-impact camera motion (camera moved BEFORE the onset) → null (ambiguous), windowed to onset.
  const onsetMs = 50;
  const preImpact = [
    { tMs: 0, x: 0, y: 2, z: -8 },
    { tMs: 16.67, x: 0, y: 2, z: -7.5 }, // moves before the onset
    { tMs: 33.34, x: 0, y: 2, z: -8 },
    { tMs: 50, x: 0, y: 2, z: -8 },
    { tMs: 66.67, x: 0, y: 2, z: -7.7 },
  ];
  assert.equal(deriveScreenShakeMag(preImpact, onsetMs), null);

  // A pure-z punch with z stripped → x/y constant → null (the load-bearing failure mode).
  const zOnly = [
    { tMs: 0, x: 0, y: 2, z: -8 },
    { tMs: 16.67, x: 0, y: 2, z: -7.65 },
    { tMs: 33.34, x: 0, y: 2, z: -8.2 },
    { tMs: 50, x: 0, y: 2, z: -8 },
  ];
  assert.ok(deriveScreenShakeMag(zOnly) !== null, "with z, the punch is measured");
  const stripped = zOnly.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
  assert.equal(deriveScreenShakeMag(stripped), null, "without z, the z-only punch refuses");

  // Dimension consistency (fail-closed): a HETEROGENEOUS trajectory (z present on some samples, absent
  // on others) must REFUSE rather than score the absent z as 0 against a non-zero rest baseline (which
  // would fabricate displacement from a static camera).
  const heterogeneous = [
    { tMs: 0, x: 0, y: 2, z: -8 },
    { tMs: 16.67, x: 0, y: 2 }, // z dropped mid-capture
    { tMs: 33.34, x: 0, y: 2, z: -8 },
    { tMs: 50, x: 0, y: 2, z: -8 },
  ];
  assert.equal(deriveScreenShakeMag(heterogeneous), null, "heterogeneous z must refuse, never fabricate");
});

test("3D impact: isImmediateImpactFeedback rejects pre-impact and delayed feedback edges", () => {
  const interval = 1000 / 60;
  // Same frame → immediate.
  assert.equal(isImmediateImpactFeedback(100, 100, interval), true);
  // One frame late → still immediate (sampling slack).
  assert.equal(isImmediateImpactFeedback(100 + interval, 100, interval), true);
  // Before the hit (pre-impact animation) → rejected.
  assert.equal(isImmediateImpactFeedback(90, 100, interval), false);
  // More than one frame late (delayed unrelated motion) → rejected.
  assert.equal(isImmediateImpactFeedback(100 + 3 * interval, 100, interval), false);
});
