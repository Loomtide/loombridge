import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveFireIntervalMs, deriveInputToSpawnLatency, deriveTimeToKill } from "../capabilities/verification/feel-derive.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoBundles = join(repoRoot, "demo-bundles");
const bundleRoot = join(demoBundles, "3d-shooter-minimal-vertical");
const RAW_NAME = "vertical-run-raw-2026-06-26.json";
const DERIVED_NAME = "vertical-run-derived-2026-06-26.json";
const MANIFEST_NAME = "evidence-manifest.json";
const REPORT_REL = join("reports", "3d-shooter-vertical-report.json");

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
const bundleJson = <T>(name: string): T => readJson<T>(join(bundleRoot, name));

type FieldSeries = { id: string; samples: { tMs: number; value: number | boolean }[] };
interface RawTranscript {
  op: string;
  host: { projectName: string };
  request: { measure: { path: string }; captureFps: number };
  editorStateAfterCapture: { error_count: number };
  response: { fieldTimeline: FieldSeries[] };
}
interface Capability {
  capability: string;
  metric: string;
  value: number | boolean;
  status: string;
  rawCaptureSource: unknown;
  derivedArtifact?: string;
}
interface Manifest {
  pack: string;
  status: string;
  productionReady: boolean;
  capabilities: Capability[];
  gaps: { item: string; tag: string; status: string }[];
}

const seriesOf = (raw: RawTranscript, id: string): FieldSeries => {
  const s = raw.response.fieldTimeline.find((f) => f.id === id);
  assert.ok(s, `raw fieldTimeline missing series ${id}`);
  return s;
};

function runGenerator(): { manifest: unknown; report: unknown; derived: unknown } {
  const tempDir = mkdtempSync(join(tmpdir(), "loombridge-3d-vertical-"));
  const derivedOut = join(tempDir, "derived.json");
  const manifestOut = join(tempDir, "manifest.json");
  const reportOut = join(tempDir, "report.json");
  try {
    const result = spawnSync(
      process.execPath,
      [join(bundleRoot, "generate.mjs"), "--derived-output", derivedOut, "--manifest-output", manifestOut, "--report-output", reportOut],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `generate.mjs failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return {
      manifest: JSON.parse(readFileSync(manifestOut, "utf8")),
      report: JSON.parse(readFileSync(reportOut, "utf8")),
      derived: JSON.parse(readFileSync(derivedOut, "utf8")),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("vertical: the live core-loop capture re-derives fire cadence + input→spawn + TTK (error_count=0)", () => {
  const raw = bundleJson<RawTranscript>(RAW_NAME);
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host.projectName, "shooter-3d-combat-dogfood");
  assert.equal(raw.request.measure.path, "/CombatController");
  assert.equal(raw.editorStateAfterCapture.error_count, 0);
  const fire = deriveFireIntervalMs(seriesOf(raw, "FireCount"));
  const spawn = deriveInputToSpawnLatency(seriesOf(raw, "ProjectileSpawnCount"), 0);
  const ttk = deriveTimeToKill(seriesOf(raw, "HitCount"), seriesOf(raw, "IsDead"));
  assert.ok(fire.ok && spawn.ok && ttk.ok, "core-loop calculators must all measure the live vertical run");
  // Pin the expected core-loop numbers (locked to the immutable raw transcript, not hardcoded in the
  // generator) so a regression in the fixture or the calculators can't silently shift the vertical spine.
  assert.equal(fire.ok && fire.latencyMs, 150);
  assert.equal(spawn.ok && spawn.latencyMs, 16.67);
  assert.equal(ttk.ok && ttk.latencyMs, 300);
});

test("vertical: manifest + report + derived are reproducible from the sources (not minted)", () => {
  const regenerated = runGenerator();
  assert.deepEqual(regenerated.manifest, bundleJson(MANIFEST_NAME));
  assert.deepEqual(regenerated.report, bundleJson(REPORT_REL));
  assert.deepEqual(regenerated.derived, bundleJson(DERIVED_NAME));
});

test("vertical: the roll-up is honestly experimental-green and NOT production-ready, with explicit gaps", () => {
  const manifest = bundleJson<Manifest>(MANIFEST_NAME);
  assert.equal(manifest.status, "experimental-green");
  assert.equal(manifest.productionReady, false, "the vertical must NOT claim production-ready");
  // 3 core-loop + 8 phase capabilities = 11 measured, each with raw evidence (never green without provenance).
  assert.equal(manifest.capabilities.length, 11);
  for (const c of manifest.capabilities) {
    assert.equal(c.status, "measured", `${c.capability} must be a measured row`);
    assert.ok(c.rawCaptureSource, `${c.capability} must cite a raw capture source`);
  }
  // Gaps are present and explicit — never hidden to make the report look cleaner.
  const gapItems = manifest.gaps.map((g) => g.item.toLowerCase());
  for (const required of ["recoil", "ads", "fusion", "look responsiveness", "aiming-feel"]) {
    assert.ok(gapItems.some((g) => g.includes(required)), `gaps must explicitly list "${required}"`);
  }
  for (const g of manifest.gaps) {
    assert.ok(["not_measured", "unsupported"].includes(g.status), `gap "${g.item}" must be not_measured|unsupported, never green`);
  }
});

test("vertical: every rolled-up capability matches its source bundle's committed derived value (no drift)", () => {
  const manifest = bundleJson<Manifest>(MANIFEST_NAME);
  for (const c of manifest.capabilities) {
    if (!c.derivedArtifact) continue; // core-loop rows derive from this bundle's own raw
    const source = readJson<{ status: string; derived: { value: number | boolean } }>(join(repoRoot, c.derivedArtifact));
    assert.equal(source.status, "pass", `${c.derivedArtifact} must be status:pass`);
    assert.equal(c.value, source.derived.value, `${c.capability} value must equal its source derived value`);
  }
});
