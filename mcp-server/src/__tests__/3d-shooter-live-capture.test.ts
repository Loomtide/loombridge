import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundleRoot = join(repoRoot, "demo-bundles/3d-shooter-first-live-capture");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(bundleRoot, name), "utf8")) as T;
}

type Timeline = { id: string; samples: Array<{ tMs: number; value: number | boolean }> };

function field(raw: { raw?: { fieldTimeline?: Timeline[] } }, id: string): Timeline {
  const found = raw.raw?.fieldTimeline?.find((entry) => entry.id === id);
  assert.ok(found, `missing fieldTimeline for ${id}`);
  return found;
}

function risingEdges(samples: Timeline["samples"]): number[] {
  const edges: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    if (Number(samples[index]!.value) > Number(samples[index - 1]!.value)) edges.push(samples[index]!.tMs);
  }
  return edges;
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-shooter-capture-"));
  const generatedPath = join(tempDir, "derived.json");
  try {
    const result = spawnSync(
      process.execPath,
      [join(bundleRoot, "generate.mjs"), "--output", generatedPath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `generate.mjs failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return JSON.parse(readFileSync(generatedPath, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("3d-shooter first live capture records fire/spawn/hit/death field evidence", () => {
  const raw = readJson<{
    op?: string;
    params?: { project?: string; captureFps?: number; sampledFields?: Array<{ id?: string }> };
    raw?: { sampleCount?: number; durationMs?: number; fieldTimeline?: Timeline[] };
  }>("shooter-3d-combat-loop-raw-2026-06-25.json");
  const derived = readJson<{
    metrics?: { fireIntervalMs?: number; fireInputToSpawnLatency?: number; ttkMs?: number };
    edges?: { fireEdges?: number[]; spawnEdges?: number[]; hitEdges?: number[]; deathEdge?: number };
    provenance?: { editorStateAfterCapture?: { error_count?: number }; sampleCount?: number; captureFps?: number };
  }>("shooter-3d-combat-loop-derived-2026-06-25.json");

  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.params?.project, "shooter-3d-combat-dogfood");
  assert.equal(raw.params?.captureFps, 60);
  assert.equal(raw.raw?.sampleCount, 111);
  assert.equal(raw.raw?.durationMs, 1833.33);
  assert.deepEqual(raw.params?.sampledFields?.map((entry) => entry.id), [
    "FireCount",
    "ShotCount",
    "ProjectileSpawnCount",
    "ProjectileHitCount",
    "HitCount",
    "Health",
    "DamageTakenCount",
    "IsDead",
    "DeathCount",
    "ResetCount",
  ]);

  assert.deepEqual(risingEdges(field(raw, "FireCount").samples), [16.67, 166.67, 316.67]);
  assert.deepEqual(risingEdges(field(raw, "ProjectileSpawnCount").samples), [16.67, 166.67, 316.67]);
  const projectileHitEdges = risingEdges(field(raw, "ProjectileHitCount").samples);
  const enemyHitEdges = risingEdges(field(raw, "HitCount").samples);
  const isDeadEdges = risingEdges(field(raw, "IsDead").samples);
  const deathCountEdges = risingEdges(field(raw, "DeathCount").samples);
  assert.deepEqual(projectileHitEdges, [633.33, 783.33, 933.33]);
  assert.deepEqual(enemyHitEdges, projectileHitEdges);
  assert.deepEqual(isDeadEdges, [933.33]);
  assert.deepEqual(deathCountEdges, isDeadEdges);
  assert.equal(field(raw, "Health").samples.find((sample) => sample.tMs >= 933.33)?.value, 0);

  assert.deepEqual(derived.edges?.fireEdges, [16.67, 166.67, 316.67]);
  assert.deepEqual(derived.edges?.spawnEdges, [16.67, 166.67, 316.67]);
  assert.deepEqual(derived.edges?.hitEdges, [633.33, 783.33, 933.33]);
  assert.deepEqual(
    (derived.edges as { projectileHitEdges?: number[] } | undefined)?.projectileHitEdges,
    [633.33, 783.33, 933.33],
  );
  assert.deepEqual((derived.edges as { isDeadEdges?: number[] } | undefined)?.isDeadEdges, [933.33]);
  assert.deepEqual((derived.edges as { deathCountEdges?: number[] } | undefined)?.deathCountEdges, [933.33]);
  assert.equal(derived.edges?.deathEdge, 933.33);
  assert.deepEqual(derived.metrics, {
    fireIntervalMs: 150,
    fireInputToSpawnLatency: 16.67,
    ttkMs: 300,
  });
  assert.equal(derived.provenance?.sampleCount, 111);
  assert.equal(derived.provenance?.captureFps, 60);
  assert.equal(derived.provenance?.editorStateAfterCapture?.error_count, 0);
  assert.deepEqual(runGenerator(), derived);
});
