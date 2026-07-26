import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveHitscanImpactLatencyMs, firstRisingEdge } from "../../../../capabilities/verification/feel-derive.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const repoRoot = REPO_ROOT_SUPPORT;
const bundleRoot = join(repoRoot, "demo-bundles/3d-hitscan-weapon");
const RAW_NAME = "3d-hitscan-raw-2026-06-26.json";
const DERIVED_NAME = "3d-hitscan-derived-2026-06-26.json";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type FieldSample = { tMs: number; value: number | boolean };
type FieldSeries = { id: string; samples: FieldSample[]; unresolved?: string; readError?: string };

interface RawTranscript {
  op: string;
  host: { projectName: string; scene: string };
  request: { measure: { path: string }; captureFps: number; includeSamples: boolean };
  editorStateAfterCapture: { error_count: number };
  response: { sampleCount: number; durationMs: number; fieldTimeline: FieldSeries[] };
}

interface DerivedArtifact {
  metric: string;
  derived: { metric: string; value: number; unit: string };
  ordering: { fireOnsetMs: number; raycastHitEdgeMs: number; damageEdgeMs: number };
}

function seriesOf(raw: RawTranscript, id: string): FieldSeries {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-hitscan-"));
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

// ── Negative / refusal cases (pure calculator; no live capture needed) ────────────────

const fireSeries = (vals: number[]): FieldSeries => ({
  id: "FireCount",
  samples: vals.map((v, i) => ({ tMs: i * 16.67, value: v })),
});
const hitSeries = (vals: number[]): FieldSeries => ({
  id: "RaycastHitCount",
  samples: vals.map((v, i) => ({ tMs: i * 16.67, value: v })),
});
const dmgSeries = (vals: number[]): FieldSeries => ({
  id: "DamageTakenCount",
  samples: vals.map((v, i) => ({ tMs: i * 16.67, value: v })),
});
const FIRED = [0, 1, 1, 1];

test("hitscan: measures fire → raycast-hit latency when the chain is causal", () => {
  // Fire at onset 0; the raycast resolves on the next sampled frame (16.67ms) and damage lands same frame.
  const r = deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 1, 1, 1]), dmgSeries([0, 1, 1, 1]), 0);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.ok && r.latencyMs, 16.67);
});

test("hitscan: refuses a degraded fire / raycast-hit / damage series (F1 invariant)", () => {
  assert.equal(
    deriveHitscanImpactLatencyMs({ id: "FireCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" }, hitSeries([0, 1]), dmgSeries([0, 1]), 0).ok,
    false,
  );
  assert.equal(
    deriveHitscanImpactLatencyMs(fireSeries(FIRED), { id: "RaycastHitCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" }, dmgSeries([0, 1]), 0).ok,
    false,
  );
  assert.equal(
    deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 1]), { id: "DamageTakenCount", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" }, 0).ok,
    false,
  );
});

test("hitscan: refuses a missing fire onset", () => {
  assert.equal(deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 1]), dmgSeries([0, 1]), undefined).ok, false);
});

test("hitscan: refuses when the weapon never FIRED (fire leg is bound, not assumed)", () => {
  // A raycast-hit + damage series with onset 0 but NO fire edge → refuse (cannot green a fabricated hit).
  const r = deriveHitscanImpactLatencyMs(fireSeries([0, 0, 0, 0]), hitSeries([0, 1, 1, 1]), dmgSeries([0, 1, 1, 1]), 0);
  assert.equal(r.ok, false);
});

test("hitscan: refuses a MISS (no raycast hit edge), never a fabricated 0", () => {
  const r = deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 0, 0, 0]), dmgSeries([0, 0, 0, 0]), 0);
  assert.equal(r.ok, false);
});

test("hitscan: refuses a raycast hit edge that precedes the fire onset (non-causal)", () => {
  // Hit edge at 16.67 but the fire onset is later (50) → non-causal ordering.
  const r = deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 1, 1, 1]), dmgSeries([0, 1, 1, 1]), 50);
  assert.equal(r.ok, false);
});

test("hitscan: refuses a hit that registered NO damage (hit-without-damage)", () => {
  const r = deriveHitscanImpactLatencyMs(fireSeries(FIRED), hitSeries([0, 1, 1, 1]), dmgSeries([0, 0, 0, 0]), 0);
  assert.equal(r.ok, false);
});

test("hitscan: refuses DAMAGE WITHOUT A HIT (damage edge precedes the raycast hit edge)", () => {
  // Damage rose at 16.67 but the raycast hit only registers at 50 → an injected/independent damage the
  // raycast did not cause. Must refuse (the key review-risk guard).
  const r = deriveHitscanImpactLatencyMs(
    fireSeries(FIRED),
    { id: "RaycastHitCount", samples: [{ tMs: 0, value: 0 }, { tMs: 16.67, value: 0 }, { tMs: 33.34, value: 0 }, { tMs: 50, value: 1 }] },
    { id: "DamageTakenCount", samples: [{ tMs: 0, value: 0 }, { tMs: 16.67, value: 1 }, { tMs: 33.34, value: 1 }, { tMs: 50, value: 1 }] },
    0,
  );
  assert.equal(r.ok, false);
});

// ── Live-capture regression (requires the committed raw transcript) ───────────────────

test("hitscan: live capture records the fire → raycast-hit → damage chain (error_count=0)", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);
  for (const id of ["FireCount", "RaycastHitCount", "DamageTakenCount", "HitCount"]) {
    assert.ok(raw.response.fieldTimeline.some((f) => f.id === id), `fieldTimeline must carry ${id}`);
  }
  // Causal ordering: fire onset (0) <= raycast hit edge <= damage edge.
  const hitEdge = firstRisingEdge(seriesOf(raw, "RaycastHitCount"));
  const dmgEdge = firstRisingEdge(seriesOf(raw, "DamageTakenCount"));
  assert.ok(hitEdge !== null && dmgEdge !== null);
  assert.ok(hitEdge! >= 0, "raycast hit at/after fire onset");
  assert.ok(dmgEdge! >= hitEdge!, "damage at/after the raycast hit (hit causes damage)");
});

test("hitscan: hitscanImpactLatencyMs re-derives from the raw chain (near-instant, ~1 frame)", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  const r = deriveHitscanImpactLatencyMs(seriesOf(raw, "FireCount"), seriesOf(raw, "RaycastHitCount"), seriesOf(raw, "DamageTakenCount"), 0);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  // Hitscan resolves on the fire frame → ~one capture frame at 60fps. (Projectile TTK is ~hundreds of ms.)
  assert.ok(r.ok && r.latencyMs <= 34, `hitscan latency should be ~1 frame, got ${r.ok && r.latencyMs}`);
  assert.equal(derived.derived.value, r.ok ? r.latencyMs : NaN);
  assert.equal(derived.derived.unit, "ms");
});

test("hitscan: canonical artifact is reproducible from the raw transcript (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  assert.deepEqual(runGenerator(), derived);
});
