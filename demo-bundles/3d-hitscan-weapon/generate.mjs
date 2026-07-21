#!/usr/bin/env node
// Assemble the canonical 3D hitscan artifact FROM the immutable raw capture transcript.
// It copies the {tMs,value} fieldTimeline series VERBATIM out of the raw runtime.capture_input_motion
// response and runs them back through the PRODUCTION deriveHitscanImpactLatencyMs (fire input onset ->
// raycast hit edge, enforcing the full fire -> raycast-hit -> damage causal ordering). The fire input
// onset is the start of the injected fire phase (0ms). Delete or alter the raw transcript and this
// fails or changes — live hitscan edge evidence cannot be minted without the raw source.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveHitscanImpactLatencyMs, firstRisingEdge } from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "3d-hitscan-raw-2026-06-26.json";
const DERIVED_NAME = "3d-hitscan-derived-2026-06-26.json";

// The fire input onset: the injected hitscan fire phase starts at t=0 (same convention as the live
// fireInputToSpawnLatency proof, which derives from inputOnset 0).
const FIRE_ONSET_MS = 0;

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { output: path.join(bundleDir, DERIVED_NAME) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      const next = argv[index + 1];
      if (!next) throw new Error("--output requires a path");
      args.output = path.resolve(process.cwd(), next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const raw = JSON.parse(await fs.readFile(path.join(bundleDir, RAW_NAME), "utf8"));
if (raw.op !== "runtime.capture_input_motion") {
  throw new Error(`raw transcript op must be runtime.capture_input_motion, got ${raw.op}`);
}
if (raw.host?.projectName !== "shooter-3d-combat-dogfood") {
  throw new Error(`raw transcript host must be shooter-3d-combat-dogfood, got ${raw.host?.projectName}`);
}
const response = raw.response;
if (!Array.isArray(response?.fieldTimeline)) {
  throw new Error("raw transcript response.fieldTimeline missing — cannot assemble the hitscan artifact");
}

// Copy the fieldTimeline series VERBATIM (id + {tMs,value} samples + any degraded markers).
const fieldTimeline = response.fieldTimeline.map((s) => ({
  id: s.id,
  samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })),
  ...(s.unresolved != null ? { unresolved: s.unresolved } : {}),
  ...(s.readError != null ? { readError: s.readError } : {}),
}));
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);

const fireSeries = seriesById("FireCount");
const raycastHitSeries = seriesById("RaycastHitCount");
const damageSeries = seriesById("DamageTakenCount");
const enemyHitSeries = seriesById("HitCount");
if (!fireSeries) throw new Error("raw fieldTimeline is missing the FireCount series");
if (!raycastHitSeries) throw new Error("raw fieldTimeline is missing the RaycastHitCount series");
if (!damageSeries) throw new Error("raw fieldTimeline is missing the DamageTakenCount series");

// True hitscan derivation through the production calculator (fire onset -> raycast hit, fire->hit->damage;
// the FireCount series makes the FIRE leg load-bearing — a fire must have actually occurred).
const result = deriveHitscanImpactLatencyMs(fireSeries, raycastHitSeries, damageSeries, FIRE_ONSET_MS);
if (!result.ok) {
  throw new Error(`deriveHitscanImpactLatencyMs refused the raw chain (${result.reason}) — cannot mint a green`);
}

const fireEdgeMs = fireSeries ? firstRisingEdge(fireSeries) : null;
const raycastHitEdgeMs = firstRisingEdge(raycastHitSeries);
const damageEdgeMs = firstRisingEdge(damageSeries);
const enemyHitEdgeMs = enemyHitSeries ? firstRisingEdge(enemyHitSeries) : null;
if (damageEdgeMs < raycastHitEdgeMs) {
  throw new Error(`damage edge ${damageEdgeMs} precedes the raycast hit edge ${raycastHitEdgeMs} — damage without a hit`);
}

const peakSampled = (series) => {
  let peak = null;
  for (const s of series?.samples ?? []) {
    if (typeof s.value === "number" && (peak === null || s.value > peak)) peak = s.value;
  }
  return peak;
};

const artifact = {
  metric: "hitscanImpactLatencyMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-hitscan-weapon/${RAW_NAME}`,
  fixture: {
    weaponObject: "/HitscanWeapon",
    weaponComponent: "Shooter3DHitscanWeapon",
    enemyComponent: "Shooter3DReferenceEnemy",
    scene: raw.host?.scene,
    note:
      "A clean-room hitscan weapon fires one Physics.Raycast along +Z on the injected F key. The ray strikes " +
      "the reference enemy's collider and applies one point of damage IN THE SAME FRAME — there is no projectile " +
      "and no travel time, so the raycast hit and the damage resolve on the fire frame. Damage is the SOLE " +
      "consequence of a raycast hit (a miss raises neither RaycastHitCount nor damage). Series copied verbatim " +
      "from the raw bridge transcript; not synthesized.",
  },
  ordering: {
    fireOnsetMs: FIRE_ONSET_MS,
    fireEdgeMs, // FireCount 0->1 (accepted fire input)
    raycastHitEdgeMs, // RaycastHitCount 0->1 (the raycast struck the enemy)
    damageEdgeMs, // DamageTakenCount 0->1 (the enemy took damage)
    enemyHitEdgeMs, // Enemy.HitCount 0->1 (cross-check of the damage edge)
    note:
      "fire onset <= raycast hit edge <= damage edge: the hitscan chain is causal and in order. A miss (no " +
      "raycast hit edge) or damage preceding the raycast hit would have refused the mint (no false green).",
  },
  capture: {
    source: raw.op,
    captureFps: raw.request?.captureFps,
    sampleIntervalMs: 1000 / raw.request.captureFps,
    durationMs: response.durationMs,
    sampleCount: response.sampleCount,
    phases: (response.phases ?? []).map((p) => ({ index: p.index, keys: p.keys, requestedDurationMs: p.requestedDurationMs })),
    fieldTimeline,
  },
  derived: {
    metric: "hitscanImpactLatencyMs",
    value: result.latencyMs,
    unit: "ms",
    calculator: "deriveHitscanImpactLatencyMs",
    method:
      "fire input onset (0ms) -> first RaycastHitCount rising edge, gated by the fire -> raycast-hit -> damage " +
      "ordering. A hitscan resolves its hit on the fire frame, so this is ~one capture frame — the measurable " +
      "signature distinguishing hitscan from the projectile loop's flight-time TTK.",
    finalRaycastHitCount: peakSampled(raycastHitSeries),
    finalDamageTakenCount: peakSampled(damageSeries),
  },
  honesty: {
    measures:
      "the LIVE fire-to-raycast-hit latency of a clean-room hitscan weapon whose ray causally drives enemy " +
      "damage on the fire frame, in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "bullet penetration, spread, recoil, reload, ADS, tracer/decal rendering, body-part multipliers, or lag " +
      "compensation — all explicit gaps. This is ONE narrow edge-chain metric (fire -> raycast hit -> damage), " +
      "not a weapon-system. Projectile metrics (fireIntervalMs/projectileSpeed/ttkMs) are unchanged. Enemy AI, " +
      "cover, and waves remain explicit gaps (see methodology-gaps.md).",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `hitscanImpactLatencyMs = ${result.latencyMs} ms (fire ${FIRE_ONSET_MS} -> raycast-hit ${raycastHitEdgeMs} -> damage ${damageEdgeMs}) ` +
    `-> ${path.relative(process.cwd(), args.output)}\n`,
);
