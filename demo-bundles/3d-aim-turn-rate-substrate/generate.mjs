#!/usr/bin/env node
// Assemble the canonical 3D aimTurnRateDegPerSec artifact FROM the immutable raw capture transcript.
// This does NOT synthesize the value from a constant: it copies the {x,y,z,rx,ry,rz} trajectory
// verbatim out of the raw runtime.capture_input_motion response and runs it back through the
// PRODUCTION deriveAimTurnRateDegPerSec (the rotation calculator that reads the yaw axis = ry). It
// also re-derives with the ROTATION STRIPPED to prove the value is recoverable ONLY because the
// bridge now samples rotation (the aim rig is fixed in position; the entire signal lives in yaw).
// Delete or alter the raw transcript and this fails or changes — live rotation evidence cannot be
// minted without the raw source.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAimTurnRateDegPerSec } from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "shooter-3d-aim-turn-rate-raw-2026-06-26.json";
const DERIVED_NAME = "shooter-3d-aim-turn-rate-derived-2026-06-26.json";

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
  throw new Error("raw transcript response.samples missing — cannot assemble the aimTurnRate artifact");
}

// Copy the {tMs,x,y,z,rx,ry,rz} trajectory VERBATIM from the raw response — never rebuild from constants.
const samples = response.samples.map((s) => ({
  tMs: s.tMs,
  x: s.x,
  y: s.y,
  z: s.z,
  rx: s.rx,
  ry: s.ry,
  rz: s.rz,
}));
if (!samples.every((s) => Number.isFinite(s.ry))) {
  throw new Error("raw trajectory is missing ry (yaw) on some samples — the v2 substrate did not emit rotation");
}

// True rotation derivation through the production calculator (uses the yaw axis = ry).
const turnRate = deriveAimTurnRateDegPerSec(samples);
if (turnRate === null) {
  throw new Error("deriveAimTurnRateDegPerSec refused the raw rotation trajectory (no sustained turn) — cannot mint a green");
}

// Substrate proof: the SAME samples with rotation stripped collapse to a stationary, position-only
// track (the aim rig never translates), so the rotation calculator refuses. This is what proves the
// rotation evidence is load-bearing.
const rotationStripped = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
const strippedDerivation = deriveAimTurnRateDegPerSec(rotationStripped);
if (strippedDerivation !== null) {
  throw new Error(
    `expected the rotation-stripped projection to refuse, but it derived ${strippedDerivation}`,
  );
}

// Provenance cross-checks from the sampled fieldTimeline (copied verbatim).
const fieldTimeline = Array.isArray(response.fieldTimeline) ? response.fieldTimeline : [];
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);
const turningSeries = seriesById("aim-turning");
const rateConfigSeries = seriesById("aim-turn-rate-config");
const firstTrue = (series) => series?.samples?.find((s) => s.value === true)?.tMs ?? null;
const lastValue = (series) => {
  const ss = series?.samples;
  return Array.isArray(ss) && ss.length > 0 ? ss[ss.length - 1].value : null;
};
const configuredTurnRate = lastValue(rateConfigSeries);
const turnStartMs = firstTrue(turningSeries);

const artifact = {
  metric: "aimTurnRateDegPerSec",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-aim-turn-rate-substrate/${RAW_NAME}`,
  fixture: {
    object: raw.request?.measure?.path,
    component: "Shooter3DAimRig",
    scene: raw.host?.scene,
    inputSystem: true,
    turnAxis: "yaw (about +Y)",
    configuredTurnRate,
    note:
      "A clean-room aim rig fixed in position at (x=3,y=1,z=0). On the first injected Q after the R reset it " +
      "yaws about +Y at the configured constant rate for a bounded sweep (<360 deg so eulerAngles.y never wraps) " +
      "in Update (Time.deltaTime), so a pinned capture samples an alias-free constant-rate yaw segment. Position " +
      "is constant for the whole capture: the entire signal lives in yaw (ry). Samples copied verbatim from the " +
      "raw bridge transcript; not synthesized.",
  },
  substrateProof: {
    derivedDegPerSec: turnRate,
    rotationStrippedDerivation: strippedDerivation, // null → the position-only projection refuses
    note:
      "The aim rig only rotates (position fixed), so dropping rx/ry/rz leaves a stationary track and the rotation " +
      "calculator refuses (null). The turn rate is recoverable ONLY because the bridge now samples rotation " +
      "(eulerAngles) per trajectory sample — this is the 3D measurement substrate v2 doing real work.",
  },
  provenance: {
    turnStartMs, // AimRig.IsTurning false->true: when the yaw sweep began
    configuredTurnRateCrossCheck: configuredTurnRate, // sampled TurnRateDegPerSec (independent of the trajectory)
    note:
      "AimRig.IsTurning flips false->true at the turn start; the sampled configured TurnRateDegPerSec is an " +
      "independent cross-check of the trajectory-derived turn rate.",
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
    metric: "aimTurnRateDegPerSec",
    value: turnRate,
    unit: "deg/s",
    calculator: "deriveAimTurnRateDegPerSec",
    method:
      "median moving per-interval angular speed (wrap-aware shortest-angle delta) over the yaw (ry) axis of the " +
      "rotation trajectory; stationary prefix ignored; fewer than two moving intervals refused",
  },
  honesty: {
    measures:
      "the LIVE yaw turn rate of a clean-room aim rig sweeping at a constant rate, derived from the rotation " +
      "(eulerAngles) trajectory the Loomtide bridge now samples, in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "look responsiveness/latency (no input-onset binding here), recoil kick/recovery, ADS transition, aim " +
      "assist/fairness, mouse-look acceleration curves, or any production aim tuning. Those remain explicit gaps " +
      "(see methodology-gaps.md). This is ONE conservative rotation metric, not broad 3D-shooter aim support.",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `aimTurnRateDegPerSec = ${turnRate} deg/s; rotation-stripped projection = ${strippedDerivation} (refused); ` +
    `configured cross-check = ${configuredTurnRate} deg/s -> ${path.relative(process.cwd(), args.output)}\n`,
);
