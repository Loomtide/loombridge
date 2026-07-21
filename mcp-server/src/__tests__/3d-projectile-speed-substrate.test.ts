import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveProjectileSpeed } from "../verification/feel-derive.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundleRoot = join(repoRoot, "demo-bundles/3d-projectile-speed-substrate");
const RAW_NAME = "shooter-3d-projectile-speed-raw-2026-06-25.json";
const DERIVED_NAME = "shooter-3d-projectile-speed-derived-2026-06-25.json";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type XYZSample = { tMs: number; x: number; y: number; z: number };

interface RawTranscript {
  op: string;
  host: { projectName: string; scene: string };
  request: { measure: { path: string }; captureFps: number; includeSamples: boolean };
  editorStateAfterCapture: { error_count: number };
  response: { sampleCount: number; durationMs: number; samples: XYZSample[] };
}

interface DerivedArtifact {
  metric: string;
  dimensionality: string;
  derived: { metric: string; value: number; unit: string };
  substrateProof: { derived3dUnitsPerSec: number; zStripped2dDerivation: number | null };
  capture: { samples: XYZSample[] };
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loomtide-3d-projspeed-"));
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

test("3D projectileSpeed: live capture records a true {x,y,z} +Z trajectory", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/MeasurementProjectile");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.request.includeSamples, true);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);

  const samples = raw.response.samples;
  assert.equal(samples.length, raw.response.sampleCount);
  // Every sample carries z (the 3D substrate emitted a full {x,y,z} trajectory).
  assert.ok(samples.every((s) => Number.isFinite(s.z)), "every sample must carry a finite z");
  // The shot is PURELY +Z: x and y never change; z strictly increases once it launches.
  assert.ok(samples.every((s) => s.x === 0), "x is constant 0 (pure +Z shot)");
  assert.ok(samples.every((s) => s.y === 1), "y is constant 1 (pure +Z shot)");
  assert.ok(samples[samples.length - 1]!.z > samples[0]!.z, "z increases over the capture");
});

test("3D projectileSpeed: re-derives from the raw z trajectory and z is load-bearing", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  const samples = raw.response.samples;

  // Re-derive straight from the RAW trajectory through the production calculator.
  const speed3d = deriveProjectileSpeed(samples);
  assert.ok(speed3d !== null, "3D derivation must not refuse a real +Z trajectory");
  // Honest precision: ~18 u/s (configured), tMs is reported rounded to 2dp.
  assert.ok(Math.abs(speed3d! - 18) < 0.05, `expected ~18 u/s, got ${speed3d}`);
  // The committed derived artifact's value matches a fresh re-derivation (copied/derived, not minted).
  assert.equal(derived.derived.value, speed3d);
  assert.equal(derived.derived.unit, "u/s");
  assert.equal(derived.dimensionality, "3D");

  // HEADLINE PROOF: drop z → a stationary x/y track → the 2D-only derivation REFUSES (null).
  const zStripped = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
  assert.equal(deriveProjectileSpeed(zStripped), null, "z-stripped pure +Z shot must refuse");
  assert.equal(derived.substrateProof.zStripped2dDerivation, null);
  assert.equal(derived.substrateProof.derived3dUnitsPerSec, speed3d);
});

test("3D projectileSpeed: canonical artifact is reproducible from the raw transcript (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  // The committed canonical artifact deep-equals a fresh generator run over the immutable raw transcript.
  assert.deepEqual(runGenerator(), derived);
  // And its embedded samples are copied verbatim from the raw response.
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.deepEqual(derived.capture.samples, raw.response.samples);
});

test("3D projectileSpeed: degraded / flat / insufficient trajectories refuse, never green", () => {
  // A stationary track (no motion on any axis) → refuse.
  const stationary = Array.from({ length: 10 }, (_unused, i) => ({ tMs: i * 16.67, x: 0, y: 1, z: 0.6 }));
  assert.equal(deriveProjectileSpeed(stationary), null);
  // A single moved interval (a spawn/teleport snap) → refuse (needs >= 2 moving intervals).
  assert.equal(deriveProjectileSpeed([
    { tMs: 0, x: 0, y: 1, z: 0 },
    { tMs: 16.67, x: 0, y: 1, z: 5 },
  ]), null);
});
