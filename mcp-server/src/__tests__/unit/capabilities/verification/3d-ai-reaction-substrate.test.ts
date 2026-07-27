import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveEnemyReactionLatencyMs, firstRisingEdge } from "../../../../capabilities/verification/feel-derive.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const repoRoot = REPO_ROOT_SUPPORT;
const bundleRoot = join(repoRoot, "demos/evidence-bundles/3d-ai-reaction");
const RAW_NAME = "3d-ai-reaction-raw-2026-06-26.json";
const DERIVED_NAME = "3d-ai-reaction-derived-2026-06-26.json";

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
  derived: { metric: string; value: number; unit: string };
  ordering: { perceptionEdgeMs: number; reactionEdgeMs: number };
}

function seriesOf(raw: RawTranscript, id: string): FieldSeries {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-ai-"));
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

const perceptionSeries = (edgeIdx: number, n = 16): FieldSeries => ({
  id: "TargetAcquiredCount",
  samples: Array.from({ length: n }, (_u, i) => ({ tMs: i * 16.67, value: i >= edgeIdx ? 1 : 0 })),
});
const reactionSeries = (edgeIdx: number, n = 16): FieldSeries => ({
  id: "StartedAimingCount",
  samples: Array.from({ length: n }, (_u, i) => ({ tMs: i * 16.67, value: i >= edgeIdx ? 1 : 0 })),
});

// ── Negative / refusal cases (pure calculator; no live capture needed) ────────────────

test("ai-reaction: measures perception → reaction latency when ordering is causal", () => {
  // Perception at frame 3 (50.01ms), reaction at frame 15 (250.05ms) → ~200ms reaction latency.
  const r = deriveEnemyReactionLatencyMs(perceptionSeries(3), reactionSeries(15));
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(r.ok && Math.abs(r.latencyMs - 200) < 0.1, `expected ~200ms, got ${r.ok && r.latencyMs}`);
});

test("ai-reaction: refuses a degraded perception or reaction series (F1 invariant)", () => {
  assert.equal(
    deriveEnemyReactionLatencyMs({ id: "TargetAcquiredCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" }, reactionSeries(5)).ok,
    false,
  );
  assert.equal(
    deriveEnemyReactionLatencyMs(perceptionSeries(3), { id: "StartedAimingCount", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" }).ok,
    false,
  );
});

test("ai-reaction: refuses NO PERCEPTION (no line of sight — perception never fired), never a 0", () => {
  // CanSeePlayer/TargetAcquired never rises (occluder never removed) → no perception edge → refuse.
  const r = deriveEnemyReactionLatencyMs(perceptionSeries(99 /* never within 16 frames */), reactionSeries(99));
  assert.equal(r.ok, false);
});

test("ai-reaction: refuses when the enemy never reacted (perception but no reaction edge)", () => {
  const r = deriveEnemyReactionLatencyMs(perceptionSeries(3), reactionSeries(99));
  assert.equal(r.ok, false);
});

test("ai-reaction: refuses a PRE-ARMED reaction (reaction edge precedes perception)", () => {
  // Reaction at frame 2, perception at frame 8 → the enemy "reacted" before it could perceive → refuse.
  const r = deriveEnemyReactionLatencyMs(perceptionSeries(8), reactionSeries(2));
  assert.equal(r.ok, false);
});

// ── Live-capture regression (requires the committed raw transcript) ───────────────────

test("ai-reaction: live capture records the perception → reaction chain (error_count=0)", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/Enemy");
  assert.equal(raw.request.captureFps, 60);
  assert.equal(raw.editorStateAfterCapture.error_count, 0);
  for (const id of ["CanSeePlayer", "TargetAcquiredCount", "StartedAimingCount", "OccluderActive"]) {
    assert.ok(raw.response.fieldTimeline.some((f) => f.id === id), `fieldTimeline must carry ${id}`);
  }
  // Perception precedes reaction; the occluder was active before perception (LOS-gated, not a timer).
  const perceptionMs = firstRisingEdge(seriesOf(raw, "TargetAcquiredCount"));
  const reactionMs = firstRisingEdge(seriesOf(raw, "StartedAimingCount"));
  assert.ok(perceptionMs !== null && reactionMs !== null);
  assert.ok(reactionMs! > perceptionMs!, "reaction must follow perception");
  // OccluderActive must START true (LOS blocked) and go false (the stimulus) at/before perception.
  const occ = seriesOf(raw, "OccluderActive");
  assert.equal(occ.samples[0]!.value, true, "occluder blocks LOS at capture start");
});

test("ai-reaction: enemyReactionLatencyMs re-derives from the raw chain", () => {
  const raw = readJson<RawTranscript>(RAW_NAME);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  const r = deriveEnemyReactionLatencyMs(seriesOf(raw, "TargetAcquiredCount"), seriesOf(raw, "StartedAimingCount"));
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(derived.derived.value, r.ok ? r.latencyMs : NaN);
  assert.equal(derived.derived.unit, "ms");
});

test("ai-reaction: canonical artifact is reproducible from the raw transcript (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  assert.deepEqual(runGenerator(), derived);
});
