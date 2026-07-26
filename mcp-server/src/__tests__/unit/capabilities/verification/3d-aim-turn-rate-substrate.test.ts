import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveAimTurnRateDegPerSec } from "../../../../capabilities/verification/feel-derive.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const repoRoot = REPO_ROOT_SUPPORT;
const bundleRoot = join(repoRoot, "demo-bundles/3d-aim-turn-rate-substrate");
const RAW_NAME = "shooter-3d-aim-turn-rate-raw-2026-06-26.json";
const DERIVED_NAME = "shooter-3d-aim-turn-rate-derived-2026-06-26.json";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type RotSample = { tMs: number; x: number; y: number; z: number; rx: number; ry: number; rz: number };

interface RawTranscript {
  op: string;
  host: { projectName: string; scene: string };
  request: { measure: { path: string }; captureFps: number; includeSamples: boolean };
  editorStateAfterCapture: { error_count: number };
  response: { sampleCount: number; durationMs: number; samples: RotSample[] };
}

interface DerivedArtifact {
  metric: string;
  dimensionality: string;
  derived: { metric: string; value: number; unit: string };
  substrateProof: { derivedDegPerSec: number; rotationStrippedDerivation: number | null };
  capture: { samples: RotSample[] };
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-aimturn-"));
  const generatedPath = join(tempDir, "derived.json");
  try {
    const result = spawnSync(
      process.execPath,
      [join(bundleRoot, "generate.mjs"), "--output", generatedPath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `generate.mjs failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return JSON.parse(readFileSync(generatedPath, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("3D aimTurnRate: live capture records a true rotation (yaw) trajectory", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/AimRig");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.request.includeSamples, true);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);

  const samples = raw.response.samples;
  assert.equal(samples.length, raw.response.sampleCount);
  // Every sample carries rotation (the v2 substrate emitted an {x,y,z,rx,ry,rz} trajectory).
  assert.ok(samples.every((s) => Number.isFinite(s.ry)), "every sample must carry a finite ry (yaw)");
  // The rig only ROTATES: position is fixed; yaw rises once it begins turning.
  assert.ok(samples.every((s) => s.x === samples[0]!.x), "x is constant (rig fixed in position)");
  assert.ok(samples.every((s) => s.y === samples[0]!.y), "y is constant (rig fixed in position)");
  assert.ok(samples[samples.length - 1]!.ry > samples[0]!.ry, "yaw increases over the capture");
});

test("3D aimTurnRate: re-derives from the raw rotation trajectory and rotation is load-bearing", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  const samples = raw.response.samples;

  // Re-derive straight from the RAW trajectory through the production calculator (yaw axis).
  const turnRate = deriveAimTurnRateDegPerSec(samples);
  assert.ok(turnRate !== null, "rotation derivation must not refuse a real yaw sweep");
  // Honest precision: ~120 deg/s (configured), tMs reported rounded to 2dp.
  assert.ok(Math.abs(turnRate! - 120) < 1.0, `expected ~120 deg/s, got ${turnRate}`);
  // The committed derived artifact's value matches a fresh re-derivation (copied/derived, not minted).
  assert.equal(derived.derived.value, turnRate);
  assert.equal(derived.derived.unit, "deg/s");
  assert.equal(derived.dimensionality, "3D");

  // HEADLINE PROOF: strip rotation → a stationary position-only track → the rotation calc REFUSES.
  const stripped = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
  assert.equal(deriveAimTurnRateDegPerSec(stripped), null, "rotation-stripped track must refuse");
  assert.equal(derived.substrateProof.rotationStrippedDerivation, null);
  assert.equal(derived.substrateProof.derivedDegPerSec, turnRate);
});

test("3D aimTurnRate: canonical artifact is reproducible from the raw transcript (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  // The committed canonical artifact deep-equals a fresh generator run over the immutable raw transcript.
  assert.deepEqual(runGenerator(), derived);
  // And its embedded samples are copied verbatim from the raw response.
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.deepEqual(derived.capture.samples, raw.response.samples);
});

test("3D aimTurnRate: flat / insufficient / position-only trajectories refuse, never green", () => {
  // A flat aim (never turns) → refuse (fewer than two moving intervals).
  const flat = Array.from({ length: 10 }, (_unused, i) => ({ tMs: i * 16.67, x: 3, y: 1, z: 0, rx: 0, ry: 0, rz: 0 }));
  assert.equal(deriveAimTurnRateDegPerSec(flat), null);
  // A single moving interval (one snap) → refuse (needs >= 2 moving intervals).
  assert.equal(
    deriveAimTurnRateDegPerSec([
      { tMs: 0, x: 3, y: 1, z: 0, rx: 0, ry: 0, rz: 0 },
      { tMs: 16.67, x: 3, y: 1, z: 0, rx: 0, ry: 45, rz: 0 },
    ]),
    null,
  );
  // Position-only (no rotation fields) → refuse (rotation is required evidence).
  assert.equal(
    deriveAimTurnRateDegPerSec([
      { tMs: 0, x: 3, y: 1, z: 0 },
      { tMs: 16.67, x: 3, y: 1, z: 0 },
      { tMs: 33.34, x: 3, y: 1, z: 0 },
    ]),
    null,
  );
});
