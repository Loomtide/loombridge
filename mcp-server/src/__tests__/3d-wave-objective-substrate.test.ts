import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveWaveObjectiveComplete, firstRisingEdge } from "../verification/feel-derive.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundleRoot = join(repoRoot, "demo-bundles/3d-wave-objective");
const RAW_NAME = "3d-wave-objective-raw-2026-06-26.json";
const DERIVED_NAME = "3d-wave-objective-derived-2026-06-26.json";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type FieldSample = { tMs: number; value: number | boolean };
type FieldSeries = { id: string; samples: FieldSample[]; unresolved?: string; readError?: string };

interface RawTranscript {
  op: string;
  host: { projectName: string; scene: string };
  request: { measure: { path: string }; captureFps: number };
  editorStateAfterCapture: { error_count: number };
  response: { sampleCount: number; durationMs: number; fieldTimeline: FieldSeries[] };
}

interface DerivedArtifact {
  metric: string;
  derived: { metric: string; value: boolean };
  sequence: { spawnCount: number; killCount: number; aliveFinal: number };
}

function seriesOf(raw: RawTranscript, id: string): FieldSeries {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
}

function waveFrom(raw: RawTranscript) {
  return {
    spawnCount: seriesOf(raw, "SpawnCount"),
    aliveCount: seriesOf(raw, "AliveCount"),
    killCount: seriesOf(raw, "KillCount"),
    objectiveComplete: seriesOf(raw, "ObjectiveComplete"),
  };
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-wave-"));
  const out = join(tempDir, "derived.json");
  try {
    const result = spawnSync(process.execPath, [join(bundleRoot, "generate.mjs"), "--output", out], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `generate.mjs failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── synthetic series builders (pure refusal cases; no live capture needed) ─────────────

const counter = (id: string, vals: number[]): FieldSeries => ({
  id,
  samples: vals.map((v, i) => ({ tMs: i * 16.67, value: v })),
});
const bools = (id: string, vals: boolean[]): FieldSeries => ({
  id,
  samples: vals.map((v, i) => ({ tMs: i * 16.67, value: v })),
});

// A clean wave: spawn 3 → alive 0→3 then down to 0 → kill 0→3 → complete rises when alive hits 0.
const waveOk = () => ({
  spawnCount: counter("SpawnCount", [0, 3, 3, 3, 3, 3, 3, 3]),
  aliveCount: counter("AliveCount", [0, 3, 3, 2, 2, 1, 1, 0]),
  killCount: counter("KillCount", [0, 0, 0, 1, 1, 2, 2, 3]),
  objectiveComplete: bools("ObjectiveComplete", [false, false, false, false, false, false, false, true]),
});

test("wave: proven when N spawn, all N die, and ObjectiveComplete rises at kill-all", () => {
  assert.equal(deriveWaveObjectiveComplete(waveOk()).ok, true);
});

test("wave: refuses a degraded series (F1 invariant)", () => {
  const w = waveOk();
  w.killCount = { id: "KillCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" };
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses UNDER-SPAWN (no wave spawned)", () => {
  const w = waveOk();
  w.spawnCount = counter("SpawnCount", [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses when counters claim spawn/kill but no live enemies were observed", () => {
  const w = waveOk();
  w.aliveCount = counter("AliveCount", [0, 0, 0, 0, 0, 0, 0, 0]);
  w.killCount = counter("KillCount", [0, 0, 0, 1, 1, 2, 2, 3]);
  w.objectiveComplete = bools("ObjectiveComplete", [false, false, false, false, false, false, false, true]);
  const result = deriveWaveObjectiveComplete(w);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /AliveCount never rose/);
});

test("wave: refuses a stale capture where enemies were already alive at baseline", () => {
  const w = waveOk();
  w.aliveCount = counter("AliveCount", [3, 3, 2, 1, 0, 0, 0, 0]);
  w.killCount = counter("KillCount", [0, 0, 1, 2, 3, 3, 3, 3]);
  w.objectiveComplete = bools("ObjectiveComplete", [false, false, false, false, true, true, true, true]);
  const result = deriveWaveObjectiveComplete(w);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /AliveCount never rose/);
});

test("wave: refuses fewer than N killed (KillCount != SpawnCount)", () => {
  const w = waveOk();
  w.killCount = counter("KillCount", [0, 0, 0, 1, 1, 2, 2, 2]); // only 2 of 3
  w.aliveCount = counter("AliveCount", [0, 3, 3, 2, 2, 1, 1, 1]); // 1 remains
  w.objectiveComplete = bools("ObjectiveComplete", [false, false, false, false, false, false, false, false]);
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses ALIVE REMAINING at the end (AliveCount != 0)", () => {
  const w = waveOk();
  w.aliveCount = counter("AliveCount", [0, 3, 3, 2, 2, 1, 1, 1]);
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses when the objective never completed (no edge)", () => {
  const w = waveOk();
  w.objectiveComplete = bools("ObjectiveComplete", [false, false, false, false, false, false, false, false]);
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses COMPLETION BEFORE KILL-ALL (timer, not kill-gated)", () => {
  const w = waveOk();
  // ObjectiveComplete rises at idx 3 while AliveCount is still 2 (> 0) → timer-driven, must refuse.
  w.objectiveComplete = bools("ObjectiveComplete", [false, false, false, true, true, true, true, true]);
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
});

test("wave: refuses completion at an INTERMEDIATE alive-dip in a staggered/multi-batch wave", () => {
  // A 2-batch wave: spawn 3 → kill 3 (AliveCount dips to 0) → spawn 3 more → kill 3. Final
  // KillCount == SpawnCount == 6 and final AliveCount == 0, but ObjectiveComplete rises at the FIRST
  // dip (only 3 of 6 dead). Kill-all must anchor to the TRUE clear (KillCount==6 & alive==0), so this
  // premature completion is refused — not greened on the intermediate lull.
  const w = {
    spawnCount: counter("SpawnCount", [0, 3, 3, 6, 6, 6, 6, 6]),
    aliveCount: counter("AliveCount", [0, 3, 0, 3, 2, 1, 0, 0]),
    killCount: counter("KillCount", [0, 0, 3, 3, 4, 5, 6, 6]),
    objectiveComplete: bools("ObjectiveComplete", [false, false, true, true, true, true, true, true]),
  };
  assert.equal(deriveWaveObjectiveComplete(w).ok, false);
  // And the same multi-batch wave with completion at the TRUE clear (idx 6) is proven.
  const cleared = {
    ...w,
    objectiveComplete: bools("ObjectiveComplete", [false, false, false, false, false, false, true, true]),
  };
  assert.equal(deriveWaveObjectiveComplete(cleared).ok, true);
});

// ── Live-capture regression (requires the committed raw transcript) ────────────────────

test("wave: live capture records spawn N → kill all → ObjectiveComplete (error_count=0)", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/WaveManager");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);
  for (const id of ["WaveIndex", "SpawnCount", "AliveCount", "KillCount", "ObjectiveComplete", "ResetCount"]) {
    assert.ok(raw.response.fieldTimeline.some((f) => f.id === id), `fieldTimeline must carry ${id}`);
  }
  // AliveCount returns to 0 only after the kill edges; ObjectiveComplete rises at/after that.
  const alive = seriesOf(raw, "AliveCount").samples;
  assert.ok(alive.some((s) => (s.value as number) > 0), "AliveCount must go positive (a wave spawned)");
  assert.notEqual(firstRisingEdge(seriesOf(raw, "AliveCount")), null, "AliveCount must show the live enemy rise");
  assert.equal(alive[alive.length - 1]!.value, 0, "AliveCount must end at 0 (wave cleared)");
  assert.ok(firstRisingEdge(seriesOf(raw, "ObjectiveComplete")) !== null, "ObjectiveComplete must rise");
});

test("wave: waveObjectiveComplete re-derives true from the raw chain", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  assert.equal(deriveWaveObjectiveComplete(waveFrom(raw)).ok, true);
  assert.equal(derived.derived.value, true);
});

test("wave: canonical artifact is reproducible from the raw transcript (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  assert.deepEqual(runGenerator(), derived);
});
