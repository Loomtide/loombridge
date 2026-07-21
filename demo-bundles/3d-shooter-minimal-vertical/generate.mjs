#!/usr/bin/env node
// Assemble the minimal `3d-shooter` VERTICAL roll-up: an evidence manifest + a partner-facing report that
// tie every PROVEN capability to its raw Unity bundle and list every remaining gap EXPLICITLY. It makes
// NO production-ready claim — `experimental-green` only, from supported, raw-proven capabilities.
//
// Two provenance layers:
//   1. The vertical CORE LOOP (fire cadence + input→spawn + TTK) is re-derived FRESH from this bundle's
//      own live `vertical-run-raw` transcript through the production calculators (a regression that the
//      fixture still plays end-to-end after every phase's components were added).
//   2. The advanced capabilities are rolled up from the merged phase bundles' canonical derived
//      artifacts (each itself re-derivable from its own raw by its own generator + regression test). The
//      manifest cites each derived value + its raw source; the regression test asserts the roll-up never
//      drifts from the committed evidence.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveFireIntervalMs,
  deriveInputToSpawnLatency,
  deriveTimeToKill,
} from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const demoBundles = path.resolve(bundleDir, "..");
const RAW_NAME = "vertical-run-raw-2026-06-26.json";
const DERIVED_NAME = "vertical-run-derived-2026-06-26.json";
const MANIFEST_NAME = "evidence-manifest.json";
const REPORT_REL = path.join("reports", "3d-shooter-vertical-report.json");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = {
    derivedOutput: path.join(bundleDir, DERIVED_NAME),
    manifestOutput: path.join(bundleDir, MANIFEST_NAME),
    reportOutput: path.join(bundleDir, REPORT_REL),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--derived-output") { args.derivedOutput = path.resolve(process.cwd(), next); index += 1; }
    else if (arg === "--manifest-output") { args.manifestOutput = path.resolve(process.cwd(), next); index += 1; }
    else if (arg === "--report-output") { args.reportOutput = path.resolve(process.cwd(), next); index += 1; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ── 1. Re-derive the vertical CORE LOOP fresh from the live capture ───────────────────
const raw = JSON.parse(await fs.readFile(path.join(bundleDir, RAW_NAME), "utf8"));
if (raw.op !== "runtime.capture_input_motion") {
  throw new Error(`vertical-run raw op must be runtime.capture_input_motion, got ${raw.op}`);
}
if (raw.host?.projectName !== "shooter-3d-combat-dogfood") {
  throw new Error(`vertical-run raw host must be shooter-3d-combat-dogfood, got ${raw.host?.projectName}`);
}
const timeline = raw.response?.fieldTimeline;
if (!Array.isArray(timeline)) {
  throw new Error("vertical-run raw response.fieldTimeline missing — cannot derive the core loop");
}
const series = (id) => {
  const s = timeline.find((f) => f.id === id);
  if (!s) throw new Error(`vertical-run raw is missing the ${id} series`);
  return { id: s.id, samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })) };
};
const fire = deriveFireIntervalMs(series("FireCount"));
if (!fire.ok) throw new Error(`fireIntervalMs derivation refused: ${fire.reason}`);
const spawn = deriveInputToSpawnLatency(series("ProjectileSpawnCount"), 0);
if (!spawn.ok) throw new Error(`fireInputToSpawnLatency derivation refused: ${spawn.reason}`);
const ttk = deriveTimeToKill(series("HitCount"), series("IsDead"));
if (!ttk.ok) throw new Error(`ttkMs derivation refused: ${ttk.reason}`);

const round2 = (n) => Math.round(n * 100) / 100;
const coreLoop = {
  fireIntervalMs: round2(fire.latencyMs),
  fireInputToSpawnLatency: round2(spawn.latencyMs),
  ttkMs: round2(ttk.latencyMs),
};

const verticalDerived = {
  metric: "vertical-core-loop",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-shooter-minimal-vertical/${RAW_NAME}`,
  note:
    "The playable core loop re-captured AFTER every phase's components were added (a regression that the " +
    "vertical still works end-to-end): injected Space fires drive FireCount/ProjectileSpawnCount, the " +
    "projectiles collide so HitCount rises, and the enemy IsDead flips as the causal consequence. Derived " +
    "through the production fireIntervalMs / fireInputToSpawnLatency / ttkMs calculators; samples not synthesized.",
  derived: {
    fireIntervalMs: { value: coreLoop.fireIntervalMs, unit: "ms", calculator: "fireIntervalMs" },
    fireInputToSpawnLatency: { value: coreLoop.fireInputToSpawnLatency, unit: "ms", calculator: "fireInputToSpawnLatency" },
    ttkMs: { value: coreLoop.ttkMs, unit: "ms", calculator: "ttkMs" },
  },
  capture: {
    source: raw.op,
    captureFps: raw.request?.captureFps,
    sampleCount: raw.response?.sampleCount,
    durationMs: raw.response?.durationMs,
    fieldTimeline: timeline.map((s) => ({ id: s.id, samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })) })),
  },
};

// ── 2. Roll up the advanced capabilities from the merged phase bundles ────────────────
async function readDerived(relPath) {
  return JSON.parse(await fs.readFile(path.join(demoBundles, relPath), "utf8"));
}

const coreLoopCapabilities = [
  { capability: "core-loop fire cadence", metric: "fireIntervalMs", value: coreLoop.fireIntervalMs, unit: "ms", calculator: "fireIntervalMs" },
  { capability: "core-loop fire-input → projectile-spawn latency", metric: "fireInputToSpawnLatency", value: coreLoop.fireInputToSpawnLatency, unit: "ms", calculator: "fireInputToSpawnLatency" },
  { capability: "core-loop time-to-kill (first hit → death)", metric: "ttkMs", value: coreLoop.ttkMs, unit: "ms", calculator: "ttkMs" },
].map((c) => ({
  ...c,
  status: "measured",
  evidenceKind: "live-unity-capture",
  rawCaptureSource: verticalDerived.rawCaptureSource,
  phase: "vertical run (this bundle; the core loop first proven in #316)",
}));

// Each entry pulls the canonical derived value from a merged phase bundle (its own raw-backed + tested).
const bundleSpecs = [
  { capability: "true-3D projectile speed", derived: "3d-projectile-speed-substrate/shooter-3d-projectile-speed-derived-2026-06-25.json", phase: "#320 measurement substrate v1" },
  { capability: "true-3D aim turn rate", derived: "3d-aim-turn-rate-substrate/shooter-3d-aim-turn-rate-derived-2026-06-26.json", phase: "#325 measurement substrate v2" },
  { capability: "impact hit-stop window", derived: "3d-impact-feedback/3d-hitstop-derived-2026-06-26.json", phase: "#328 impact feedback" },
  { capability: "true-3D screen-shake magnitude", derived: "3d-impact-feedback/3d-screen-shake-derived-2026-06-26.json", phase: "#328 impact feedback" },
  { capability: "hitscan impact latency (fire → raycast-hit → damage)", derived: "3d-hitscan-weapon/3d-hitscan-derived-2026-06-26.json", phase: "#331 hitscan weapon" },
  { capability: "enemy AI reaction (LOS perception → reaction)", derived: "3d-ai-reaction/3d-ai-reaction-derived-2026-06-26.json", phase: "#333 AI reaction" },
  { capability: "cover blocks LOS + damage", derived: "3d-cover-proof/3d-cover-derived-2026-06-26.json", phase: "#338 cover proof" },
  { capability: "wave/objective (spawn N → kill all → complete)", derived: "3d-wave-objective/3d-wave-objective-derived-2026-06-26.json", phase: "#342 wave/objective" },
];

const bundleCapabilities = [];
for (const spec of bundleSpecs) {
  const d = await readDerived(spec.derived);
  if (!d.derived || d.derived.value === undefined) {
    throw new Error(`source bundle ${spec.derived} has no derived.value — cannot roll it up`);
  }
  if (d.status !== "pass") {
    throw new Error(`source bundle ${spec.derived} is not status:pass (${d.status}) — refusing to roll up a non-green`);
  }
  bundleCapabilities.push({
    capability: spec.capability,
    metric: d.derived.metric ?? d.metric,
    value: d.derived.value,
    unit: d.derived.unit ?? null,
    calculator: d.derived.calculator ?? null,
    status: "measured",
    evidenceKind: d.evidenceKind ?? "live-unity-capture",
    rawCaptureSource: d.rawCaptureSource ?? d.rawCaptureSources ?? null,
    derivedArtifact: `demo-bundles/${spec.derived}`,
    phase: spec.phase,
  });
}

const capabilities = [...coreLoopCapabilities, ...bundleCapabilities];

// Explicit remaining gaps (NOT measured / NOT supported) — never hidden to make the report look cleaner.
const gaps = [
  { item: "look responsiveness / latency", tag: "needs-new-bridge-capability", status: "not_measured", note: "needs an aim-input-onset binding (the rotation analog of inputLatency)" },
  { item: "recoil kick / recovery", tag: "needs-new-calculator", status: "not_measured", note: "the rotation sampler exists; no kick-then-recover calculator yet" },
  { item: "ADS transition / aim spread", tag: "needs-new-bridge-capability", status: "not_measured", note: "no ADS state/FOV/reticle transition sampling" },
  { item: "hit-stop / screen-shake FEEL QUALITY", tag: "judgment-only", status: "unsupported", note: "freeze/trauma curves, shake shape, kickback readability — not deterministic" },
  { item: "broader hitscan weapon features", tag: "needs-new-calculator", status: "not_measured", note: "penetration, spread, recoil, reload, ADS, tracer/decal, body-part multipliers, lag compensation" },
  { item: "enemy AI behavior beyond reaction", tag: "needs-new-calculator", status: "not_measured", note: "behavior trees, tactical movement, squads, target prioritization, pathfinding quality" },
  { item: "advanced cover beyond LOS/damage", tag: "needs-new-calculator", status: "not_measured", note: "tactical planning, cover-point generation, navmesh safe areas, peeking, AI cover selection" },
  { item: "wave pacing / mission design beyond one wave", tag: "needs-new-calculator", status: "not_measured", note: "multi-wave pacing, difficulty curves, spawn directors, boss waves, loot, mission design" },
  { item: "aiming-feel (fairness/readability)", tag: "judgment-only", status: "unsupported", note: "pairs with a human/VLM oracle, never a Tier-1 verdict" },
  { item: "Fusion / multiplayer / netcode", tag: "engine-unsupported-today", status: "unsupported", note: "no OnInput injection, network-tick sampling, or interpolation-aware motion sampler; single-player/local only" },
];

const manifest = {
  pack: "3d-shooter",
  kind: "minimal-vertical-builder",
  status: "experimental-green",
  productionReady: false,
  capturedAt: raw.capturedAt,
  fixture: "unity-projects/shooter-3d-combat-dogfood (Assets/Scenes/Shooter3DCombatDogfood.unity)",
  summary: `${capabilities.length} measured, raw-proven capabilities; ${gaps.length} remaining gaps kept explicit.`,
  disclaimer:
    "A minimal vertical BUILDER assembled from per-capability raw-Unity evidence — NOT a production-ready 3D " +
    "shooter pack. Every capability below cites a live capture; every gap remains unsupported/not-measured. No " +
    "production-ready claim is made and no unsupported feature is wired into a runnable gate or green row.",
  capabilities,
  gaps,
  sourceBundles: [
    "demo-bundles/3d-shooter-minimal-vertical/ (core loop, this bundle)",
    "demo-bundles/3d-shooter-first-live-capture/ (#316, original core loop)",
    "demo-bundles/3d-projectile-speed-substrate/ (#320)",
    "demo-bundles/3d-aim-turn-rate-substrate/ (#325)",
    "demo-bundles/3d-impact-feedback/ (#328)",
    "demo-bundles/3d-hitscan-weapon/ (#331)",
    "demo-bundles/3d-ai-reaction/ (#333)",
    "demo-bundles/3d-cover-proof/ (#338)",
    "demo-bundles/3d-wave-objective/ (#342)",
  ],
};

const report = {
  pack: "3d-shooter",
  title: "3D shooter — minimal vertical run",
  status: "experimental-green",
  productionReady: false,
  generatedAt: raw.capturedAt,
  verdict:
    `experimental-green: ${capabilities.length} supported capabilities are each backed by a live Unity capture ` +
    "and re-derived through production calculators. This is a minimal vertical builder, NOT a production-ready 3D " +
    "shooter — every unsupported/unmeasured feature is listed below and none is wired into a green row.",
  measured: capabilities.map((c) => ({
    capability: c.capability,
    metric: c.metric,
    value: c.value,
    unit: c.unit,
    status: c.status,
    evidence: c.rawCaptureSource,
    phase: c.phase,
  })),
  gaps,
  notMeasuredCount: gaps.filter((g) => g.status === "not_measured").length,
  unsupportedCount: gaps.filter((g) => g.status === "unsupported").length,
};

await fs.mkdir(path.dirname(args.reportOutput), { recursive: true });
await fs.writeFile(args.derivedOutput, stableJson(verticalDerived), "utf8");
await fs.writeFile(args.manifestOutput, stableJson(manifest), "utf8");
await fs.writeFile(args.reportOutput, stableJson(report), "utf8");
process.stdout.write(
  `vertical core loop: fireIntervalMs=${coreLoop.fireIntervalMs}, fireInputToSpawnLatency=${coreLoop.fireInputToSpawnLatency}, ttkMs=${coreLoop.ttkMs}; ` +
    `rolled up ${capabilities.length} measured capabilities + ${gaps.length} explicit gaps (experimental-green, NOT production-ready) ` +
    `-> ${path.relative(process.cwd(), args.manifestOutput)}, ${path.relative(process.cwd(), args.reportOutput)}\n`,
);
