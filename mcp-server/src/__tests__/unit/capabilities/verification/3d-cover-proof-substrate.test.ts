import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveCoverBlocksDamage, firstRisingEdge } from "../../../../capabilities/verification/feel-derive.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const repoRoot = REPO_ROOT_SUPPORT;
const bundleRoot = join(repoRoot, "demo-bundles/3d-cover-proof");
const COVERED_RAW = "3d-cover-covered-raw-2026-06-26.json";
const EXPOSED_RAW = "3d-cover-exposed-raw-2026-06-26.json";
const DERIVED_NAME = "3d-cover-derived-2026-06-26.json";

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
  covered: { incomingShots: number; blockedShots: number; damage: number };
  exposed: { incomingShots: number; blockedShots: number; damage: number };
}

function seriesOf(raw: RawTranscript, id: string): FieldSeries {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
}

function captureFrom(raw: RawTranscript) {
  return {
    incomingShots: seriesOf(raw, "IncomingShotCount"),
    blockedShots: seriesOf(raw, "BlockedShotCount"),
    lineOfSight: seriesOf(raw, "HasLineOfSight"),
    damage: seriesOf(raw, "DamageTakenCount"),
  };
}

function runGenerator(): unknown {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-cover-"));
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

// A clean COVERED capture: 3 shots fired, every shot blocked by cover, LOS never clear, no damage.
const coveredOk = () => ({
  incomingShots: counter("IncomingShotCount", [0, 1, 2, 3]),
  blockedShots: counter("BlockedShotCount", [0, 1, 2, 3]),
  lineOfSight: bools("HasLineOfSight", [false, false, false, false]),
  damage: counter("DamageTakenCount", [0, 0, 0, 0]),
});
// A clean EXPOSED capture: cover removed (LOS becomes true), 3 shots fired, none blocked, damage lands.
const exposedOk = () => ({
  incomingShots: counter("IncomingShotCount", [0, 1, 2, 3]),
  blockedShots: counter("BlockedShotCount", [0, 0, 0, 0]),
  lineOfSight: bools("HasLineOfSight", [false, true, true, true]),
  damage: counter("DamageTakenCount", [0, 1, 2, 3]),
});

test("cover: proven when covered blocks LOS+damage and exposed restores both", () => {
  const r = deriveCoverBlocksDamage(coveredOk(), exposedOk());
  assert.equal(r.ok, true);
});

test("cover: refuses a degraded series in either capture (F1 invariant)", () => {
  const c = coveredOk();
  c.blockedShots = { id: "BlockedShotCount", samples: [{ tMs: 0, value: 0 }], readError: "threw" };
  assert.equal(deriveCoverBlocksDamage(c, exposedOk()).ok, false);
  const e = exposedOk();
  e.damage = { id: "DamageTakenCount", samples: [{ tMs: 0, value: 0 }], unresolved: "no field" };
  assert.equal(deriveCoverBlocksDamage(coveredOk(), e).ok, false);
});

test("cover: refuses no shot fired in the covered case", () => {
  const c = coveredOk();
  c.incomingShots = counter("IncomingShotCount", [0, 0, 0, 0]);
  c.blockedShots = counter("BlockedShotCount", [0, 0, 0, 0]);
  assert.equal(deriveCoverBlocksDamage(c, exposedOk()).ok, false);
});

test("cover: refuses when the covered case had line of sight (cover did not block LOS)", () => {
  const c = coveredOk();
  c.lineOfSight = bools("HasLineOfSight", [false, true, true, true]);
  assert.equal(deriveCoverBlocksDamage(c, exposedOk()).ok, false);
});

test("cover: refuses a MISS counted as a cover block (blocked < incoming)", () => {
  const c = coveredOk();
  c.blockedShots = counter("BlockedShotCount", [0, 1, 1, 1]); // only 1 of 3 actually hit cover
  assert.equal(deriveCoverBlocksDamage(c, exposedOk()).ok, false);
});

test("cover: refuses DAMAGE THROUGH COVER (covered target took damage, even flat at a non-zero baseline)", () => {
  // Damage that RISES in-window through cover → refuse.
  const rising = coveredOk();
  rising.damage = counter("DamageTakenCount", [0, 1, 1, 1]);
  assert.equal(deriveCoverBlocksDamage(rising, exposedOk()).ok, false);
  // Damage flat at a NON-ZERO baseline (e.g. an unreset target) → refuse (fail-closed; the covered
  // case must show ZERO damage, not merely "no rise from baseline").
  const flatNonZero = coveredOk();
  flatNonZero.damage = counter("DamageTakenCount", [2, 2, 2, 2]);
  assert.equal(deriveCoverBlocksDamage(flatNonZero, exposedOk()).ok, false);
});

test("cover: refuses no shot / no LOS / a block in the exposed case", () => {
  const noShot = exposedOk();
  noShot.incomingShots = counter("IncomingShotCount", [0, 0, 0, 0]);
  assert.equal(deriveCoverBlocksDamage(coveredOk(), noShot).ok, false);
  const noLos = exposedOk();
  noLos.lineOfSight = bools("HasLineOfSight", [false, false, false, false]);
  assert.equal(deriveCoverBlocksDamage(coveredOk(), noLos).ok, false);
  const stillBlocked = exposedOk();
  stillBlocked.blockedShots = counter("BlockedShotCount", [0, 1, 1, 1]);
  assert.equal(deriveCoverBlocksDamage(coveredOk(), stillBlocked).ok, false);
});

test("cover: refuses FALSE COVER (exposed shots dealt no damage)", () => {
  const e = exposedOk();
  e.damage = counter("DamageTakenCount", [0, 0, 0, 0]);
  assert.equal(deriveCoverBlocksDamage(coveredOk(), e).ok, false);
});

// ── Live-capture regression (requires the committed raw transcripts) ───────────────────

test("cover: live captures record a covered (blocked) + exposed (damaging) pair, error_count=0", () => {
  for (const name of [COVERED_RAW, EXPOSED_RAW]) {
    const raw = readJson<RawTranscript>(name);
    assert.equal(raw.op, "runtime.capture_input_motion");
    assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
    assert.equal(raw.request.measure.path, "/CoverProbe");
    assert.equal(raw.request.captureFps, 60);
    assert.equal(raw.editorStateAfterCapture.error_count, 0);
    for (const id of ["IncomingShotCount", "BlockedShotCount", "HasLineOfSight", "DamageTakenCount"]) {
      assert.ok(raw.response.fieldTimeline.some((f) => f.id === id), `${name} must carry ${id}`);
    }
  }
  // Covered: blocked, no damage. Exposed: damage, no block.
  const covered = readJson<RawTranscript>(COVERED_RAW);
  const exposed = readJson<RawTranscript>(EXPOSED_RAW);
  assert.equal(firstRisingEdge(seriesOf(covered, "DamageTakenCount")), null, "covered case must take NO damage");
  assert.ok(firstRisingEdge(seriesOf(covered, "BlockedShotCount")) !== null, "covered shots must be blocked");
  assert.ok(firstRisingEdge(seriesOf(exposed, "DamageTakenCount")) !== null, "exposed case must take damage");
  assert.equal(firstRisingEdge(seriesOf(exposed, "BlockedShotCount")), null, "exposed shots must not be blocked");
});

test("cover: coverBlocksDamage re-derives true from the raw covered + exposed pair", () => {
  const covered = readJson<RawTranscript>(COVERED_RAW);
  const exposed = readJson<RawTranscript>(EXPOSED_RAW);
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  const r = deriveCoverBlocksDamage(captureFrom(covered), captureFrom(exposed));
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(derived.derived.value, true);
});

test("cover: canonical artifact is reproducible from the raw transcripts (not minted)", () => {
  const derived = readJson<DerivedArtifact>(DERIVED_NAME);
  assert.deepEqual(runGenerator(), derived);
});
