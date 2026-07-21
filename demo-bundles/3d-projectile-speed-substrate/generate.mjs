#!/usr/bin/env node
// Assemble the canonical 3D projectileSpeed artifact FROM the immutable raw capture transcript.
// This does NOT synthesize the value from a constant: it copies the {x,y,z} trajectory verbatim
// out of the raw runtime.capture_input_motion response and runs it back through the PRODUCTION
// deriveProjectileSpeed (the dimension-agnostic calculator that now includes the z term). It also
// re-derives with z STRIPPED to prove the value is recoverable ONLY because the bridge samples z
// (the measured projectile flies purely along +Z, so x/y are constant). Delete or alter the raw
// transcript and this fails or changes — live 3D evidence cannot be minted without the raw source.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveProjectileSpeed } from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "shooter-3d-projectile-speed-raw-2026-06-25.json";
const DERIVED_NAME = "shooter-3d-projectile-speed-derived-2026-06-25.json";

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
if (!Array.isArray(response?.samples)) {
  throw new Error("raw transcript response.samples missing — cannot assemble the 3D projectileSpeed artifact");
}

// Copy the {tMs,x,y,z} trajectory VERBATIM from the raw response — never rebuild from constants.
const samples = response.samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
if (!samples.every((s) => Number.isFinite(s.z))) {
  throw new Error("raw trajectory is missing z on some samples — the 3D substrate did not emit a full {x,y,z} trajectory");
}

// True 3D derivation through the production calculator (uses the z term).
const speed3d = deriveProjectileSpeed(samples);
if (speed3d === null) {
  throw new Error("deriveProjectileSpeed refused the raw 3D trajectory (no sustained motion) — cannot mint a green");
}

// Substrate proof: the SAME samples with z stripped collapse to a stationary x/y track (the shot is
// purely +Z), so the 2D-only derivation refuses. This is what proves z is load-bearing.
const zStripped = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
const speed2dProjection = deriveProjectileSpeed(zStripped);
if (speed2dProjection !== null) {
  throw new Error(
    `expected the z-stripped (2D) projection to refuse for a pure +Z shot, but it derived ${speed2dProjection}`,
  );
}

// Provenance cross-checks from the sampled fieldTimeline (copied verbatim).
const fieldTimeline = Array.isArray(response.fieldTimeline) ? response.fieldTimeline : [];
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);
const resetSeries = seriesById("combat-reset-count");
const movingSeries = seriesById("measurement-moving");
const speedConfigSeries = seriesById("measurement-speed-config");
const firstTrue = (series) => series?.samples?.find((s) => s.value === true)?.tMs ?? null;
const lastValue = (series) => {
  const ss = series?.samples;
  return Array.isArray(ss) && ss.length > 0 ? ss[ss.length - 1].value : null;
};
const configuredSpeed = lastValue(speedConfigSeries);
const resetEdge = (() => {
  const ss = resetSeries?.samples;
  if (!Array.isArray(ss) || ss.length === 0) return null;
  const baseline = ss[0].value;
  for (const s of ss) if (typeof s.value === "number" && s.value > baseline) return s.tMs;
  return null;
})();
const launchMs = firstTrue(movingSeries);

const artifact = {
  metric: "projectileSpeed",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-projectile-speed-substrate/${RAW_NAME}`,
  fixture: {
    object: raw.request?.measure?.path,
    component: "Shooter3DMeasurementProjectile",
    scene: raw.host?.scene,
    inputSystem: true,
    flightAxis: "+Z (local forward)",
    configuredSpeed,
    note:
      "A persistent, non-damaging measurement projectile at the muzzle (x=0,y=1,z=0.6). On the first injected " +
      "Space after the R reset it flies purely along +Z at the configured speed in Update (Time.deltaTime), so a " +
      "pinned capture samples an alias-free constant-velocity +Z segment. x and y are constant for the whole " +
      "capture: the entire speed lives in z. Samples copied verbatim from the raw bridge transcript; not synthesized.",
  },
  substrateProof: {
    derived3dUnitsPerSec: speed3d,
    zStripped2dDerivation: speed2dProjection, // null → the 2D-only projection refuses
    note:
      "The measured shot is purely +Z, so dropping z leaves a stationary x/y track and the 2D-only derivation " +
      "refuses (null). The speed is recoverable ONLY because the bridge now samples a true {x,y,z} trajectory — " +
      "this is the 3D measurement substrate doing real work.",
  },
  provenance: {
    resetCountEdgeMs: resetEdge, // ResetCount 0->1: the encounter was freshly reset before the shot
    launchMs, // MeasurementProjectileMoving false->true: when the projectile launched
    configuredSpeedCrossCheck: configuredSpeed, // sampled MeasurementProjectileSpeed (independent of the trajectory)
    note:
      "ResetCount rises 0->1 at the start (deterministic reset tripwire) and stays constant (no mid-capture " +
      "straddle); MeasurementProjectileMoving flips false->true at launch; the sampled configured speed is an " +
      "independent cross-check of the trajectory-derived speed.",
  },
  capture: {
    source: raw.op,
    captureFps: raw.request?.captureFps,
    includeSamples: raw.request?.includeSamples,
    durationMs: response.durationMs,
    sampleCount: response.sampleCount,
    projectFixedTimestepBeforeMeasurement: response.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: response.measurementFixedTimestep,
    phases: (response.phases ?? []).map((p) => ({
      index: p.index,
      keys: p.keys,
      requestedDurationMs: p.requestedDurationMs,
    })),
    samples,
    fieldTimeline,
  },
  derived: {
    metric: "projectileSpeed",
    value: speed3d,
    unit: "u/s",
    calculator: "deriveProjectileSpeed",
    method:
      "median moving per-interval Euclidean speed over the {x,y,z} trajectory; stationary prefix ignored; fewer " +
      "than two moving intervals refused",
  },
  honesty: {
    measures:
      "the LIVE speed of a measurement projectile flying purely along +Z, derived from the true {x,y,z} trajectory " +
      "the Loombridge bridge samples, in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "projectile drop/gravity, real combat-projectile collision speed (the measurement projectile is a separate, " +
      "non-damaging tracer), look/recoil/ADS rotation, or production-tuned ballistics. Rotation-dependent 3D metrics " +
      "remain explicit gaps (substrate v2).",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `projectileSpeed (3D) = ${speed3d} u/s; z-stripped 2D projection = ${speed2dProjection} (refused); ` +
    `configured cross-check = ${configuredSpeed} u/s -> ${path.relative(process.cwd(), args.output)}\n`,
);
