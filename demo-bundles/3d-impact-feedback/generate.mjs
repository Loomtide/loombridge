#!/usr/bin/env node
// Assemble the canonical 3D impact-feedback artifacts FROM the immutable raw capture transcript.
// This does NOT synthesize values from constants: it copies the {tMs,x,y,z} camera trajectory and the
// {tMs,value} fieldTimeline series VERBATIM out of the raw runtime.capture_input_motion response, then
// runs them back through the PRODUCTION calculators:
//   * hitstopMs       <- deriveHitstopMs over the IsHitStopped window series.
//   * screenShakeMag  <- deriveScreenShakeMag over the camera POSITION trajectory, windowed to the hit
//                        onset. The camera punch lives entirely in WORLD Z, so this also re-derives with
//                        Z STRIPPED to prove the value is recoverable ONLY because the bridge samples a
//                        true {x,y,z} trajectory (the X/Y projection refuses -> null).
// Both feedback edges are checked for CAUSALITY against the enemy's collision hit edge
// (isImmediateImpactFeedback): a feedback edge that preceded the hit, or arrived more than one frame
// late, is reported non-causal and the artifact is NOT minted. Delete or alter the raw transcript and
// this fails or changes — live 3D camera/window evidence cannot be minted without the raw source.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveHitstopMs,
  deriveScreenShakeMag,
  firstRisingEdge,
  isImmediateImpactFeedback,
  SCREEN_SHAKE_MIN_REGISTERED_U,
} from "../../mcp-server/dist/capabilities/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "3d-impact-feedback-raw-2026-06-26.json";
const HITSTOP_NAME = "3d-hitstop-derived-2026-06-26.json";
const SCREEN_SHAKE_NAME = "3d-screen-shake-derived-2026-06-26.json";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = {
    hitstopOutput: path.join(bundleDir, HITSTOP_NAME),
    screenShakeOutput: path.join(bundleDir, SCREEN_SHAKE_NAME),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--hitstop-output") {
      const next = argv[index + 1];
      if (!next) throw new Error("--hitstop-output requires a path");
      args.hitstopOutput = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--screen-shake-output") {
      const next = argv[index + 1];
      if (!next) throw new Error("--screen-shake-output requires a path");
      args.screenShakeOutput = path.resolve(process.cwd(), next);
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
if (raw.request?.measure?.path !== "/Main Camera") {
  throw new Error(`raw transcript must measure /Main Camera, got ${raw.request?.measure?.path}`);
}
const response = raw.response;
if (!Array.isArray(response?.samples)) {
  throw new Error("raw transcript response.samples missing — cannot assemble the impact-feedback artifacts");
}
if (!Array.isArray(response?.fieldTimeline)) {
  throw new Error("raw transcript response.fieldTimeline missing — cannot assemble the impact-feedback artifacts");
}

// Copy the {tMs,x,y,z} camera trajectory VERBATIM from the raw response — never rebuild from constants.
const samples = response.samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y, z: s.z }));
if (!samples.every((s) => Number.isFinite(s.z))) {
  throw new Error("raw trajectory is missing z on some samples — the 3D measurement substrate did not emit it");
}

// Copy the fieldTimeline series VERBATIM (id + {tMs,value} samples + any degraded markers).
const fieldTimeline = response.fieldTimeline.map((s) => ({
  id: s.id,
  samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })),
  ...(s.unresolved != null ? { unresolved: s.unresolved } : {}),
  ...(s.readError != null ? { readError: s.readError } : {}),
}));
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);

const hitStopSeries = seriesById("IsHitStopped");
const hitStopElapsedSeries = seriesById("HitStopElapsedMs");
const shakeMagSeries = seriesById("ShakeMagnitude");
const hitEdgeSeries = seriesById("EnemyHitCount");
if (!hitStopSeries) throw new Error("raw fieldTimeline is missing the IsHitStopped window series");
if (!hitEdgeSeries) throw new Error("raw fieldTimeline is missing the EnemyHitCount hit-edge series");

const sampleIntervalMs = 1000 / raw.request.captureFps;

// ---- hit edge (the causal reference): the enemy's collision-driven HitCount rising edge ----
const hitEdgeMs = firstRisingEdge(hitEdgeSeries);
if (hitEdgeMs === null) {
  throw new Error("the enemy was never hit in-window (no EnemyHitCount rising edge) — cannot anchor impact feedback");
}

// ---- hitstopMs (dimension-agnostic temporal window): first IsHitStopped rising->falling edge ----
const hitstop = deriveHitstopMs(hitStopSeries);
if (!hitstop.ok) {
  throw new Error(`deriveHitstopMs refused the raw hit-stop series (${hitstop.reason}) — cannot mint a green`);
}
const hitStopEdgeMs = firstRisingEdge(hitStopSeries);
const hitStopCausal = isImmediateImpactFeedback(hitStopEdgeMs, hitEdgeMs, sampleIntervalMs);
if (!hitStopCausal) {
  throw new Error(
    `hit-stop window opened at ${hitStopEdgeMs}ms but the hit edge is ${hitEdgeMs}ms — not an immediate impact ` +
      "consequence (pre-impact or delayed); refusing to mint hitstopMs",
  );
}

// ---- screenShakeMag (true 3D): peak camera displacement from rest, windowed to the hit onset ----
const screenShakeMag = deriveScreenShakeMag(samples, hitEdgeMs);
if (screenShakeMag === null) {
  throw new Error("deriveScreenShakeMag refused the raw camera trajectory (no post-impact shake) — cannot mint a green");
}
// Load-bearing Z proof: the punch lives entirely in WORLD Z, so projecting onto X/Y (dropping z)
// collapses the displacement and the SAME production derivation refuses (null).
const samplesNoZ = samples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
const screenShakeMagZStripped = deriveScreenShakeMag(samplesNoZ, hitEdgeMs);
if (screenShakeMagZStripped !== null) {
  throw new Error(
    `expected the Z-stripped (X/Y) projection to refuse, but it derived ${screenShakeMagZStripped} — the camera ` +
      "punch is not Z-only, so Z is not load-bearing for this capture",
  );
}
// Causality: the camera's first displaced sample is an immediate consequence of the hit edge.
const shakeOnsetMs = (() => {
  const x0 = samples[0].x;
  const y0 = samples[0].y;
  const z0 = samples[0].z;
  for (const s of samples) {
    if (Math.hypot(s.x - x0, s.y - y0, s.z - z0) > SCREEN_SHAKE_MIN_REGISTERED_U) return s.tMs;
  }
  return null;
})();
const shakeCausal = isImmediateImpactFeedback(shakeOnsetMs, hitEdgeMs, sampleIntervalMs);
if (!shakeCausal) {
  throw new Error(
    `camera shake first displaced at ${shakeOnsetMs}ms but the hit edge is ${hitEdgeMs}ms — not an immediate impact ` +
      "consequence (pre-impact or delayed); refusing to mint screenShakeMag",
  );
}

const peakSampled = (series) => {
  const ss = series?.samples ?? [];
  let peak = null;
  for (const s of ss) {
    if (typeof s.value === "number" && (peak === null || s.value > peak)) peak = s.value;
  }
  return peak;
};

const sharedCapture = {
  source: raw.op,
  captureFps: raw.request?.captureFps,
  sampleIntervalMs,
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
};

const sharedFixture = {
  measuredObject: raw.request?.measure?.path,
  feedbackComponent: "Shooter3DImpactFeedback (on the Main Camera)",
  enemyComponent: "Shooter3DReferenceEnemy",
  scene: raw.host?.scene,
  note:
    "A clean-room impact-feedback component on the Main Camera watches the reference enemy's " +
    "collision-driven HitCount and, on its rising edge (a real Shooter3DProjectile trigger-collision, " +
    "never input or a timer), opens a deterministic hit-stop window AND a decaying camera punch along " +
    "WORLD +Z (the camera looks down +Z toward the enemy). World X/Y stay at rest, so the entire shake " +
    "signal lives in Z. Both advance on Time.deltaTime (the fixture never alters Time.timeScale), so a " +
    "pinned capture gives deterministic, capture-clock-aligned values. Samples copied verbatim from the " +
    "raw bridge transcript; not synthesized.",
};

const hitstopArtifact = {
  metric: "hitstopMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D-fixture (dimension-agnostic temporal window)",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-impact-feedback/${RAW_NAME}`,
  fixture: sharedFixture,
  causality: {
    hitEdgeMs, // EnemyHitCount false-baseline rising edge (the real collision)
    hitStopWindowOpenedMs: hitStopEdgeMs, // IsHitStopped false->true
    sampleIntervalMs,
    immediateImpactFeedback: hitStopCausal, // true: opened on the hit frame (or within one frame)
    note:
      "The hit-stop window opens on the SAME captured frame as the enemy's collision hit edge (or within " +
      "one sample interval), so it is an immediate consequence of the projectile collision — not pre-impact " +
      "animation and not a delayed/independent effect. A non-causal edge would have refused the mint.",
  },
  capture: { ...sharedCapture, samples, fieldTimeline },
  derived: {
    metric: "hitstopMs",
    value: hitstop.latencyMs,
    unit: "ms",
    calculator: "deriveHitstopMs",
    method:
      "duration of the first hit-stop WINDOW: the first rising edge of the IsHitStopped signal to the first " +
      "following falling edge. Dimension-agnostic (a temporal window has no spatial axis); the 3D evidence is " +
      "that the window is fired by a true 3D projectile collision in the 3D fixture.",
    elapsedSeriesPeakMs: peakSampled(hitStopElapsedSeries), // independent cross-check (HitStopElapsedMs peak)
  },
  honesty: {
    measures:
      "the LIVE duration of the impact hit-stop window opened as the causal consequence of a real 3D " +
      "projectile collision, in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "hit-stop QUALITY/readability, freeze curve, time-dilation feel, or any production hit-stop tuning. " +
      "hitstopMs is dimension-agnostic (the window is temporal); this proves it fires causally from a 3D hit, " +
      "not that 3D hit-stop is broadly supported. Recoil, ADS, hitscan, AI/cover/waves remain explicit gaps " +
      "(see methodology-gaps.md).",
  },
};

const screenShakeArtifact = {
  metric: "screenShakeMag",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-impact-feedback/${RAW_NAME}`,
  fixture: sharedFixture,
  substrateProof: {
    derivedMag: screenShakeMag,
    zStrippedDerivation: screenShakeMagZStripped, // null -> the X/Y projection refuses
    note:
      "The camera punch lives entirely in WORLD Z, so dropping z leaves a stationary X/Y track and the SAME " +
      "production derivation (deriveScreenShakeMag) refuses (null). The shake magnitude is recoverable ONLY " +
      "because the bridge samples a true {x,y,z} trajectory — this is the 3D measurement substrate doing real " +
      "work, the camera analog of the pure-+Z measurement projectile used for true-3D projectileSpeed.",
  },
  causality: {
    hitEdgeMs,
    cameraDisplacedFromRestMs: shakeOnsetMs,
    sampleIntervalMs,
    immediateImpactFeedback: shakeCausal,
    preImpactCameraAtRest: true, // deriveScreenShakeMag(onsetMs) refuses if the camera moved before the onset
    note:
      "deriveScreenShakeMag is anchored to the hit edge (onsetMs): it REFUSES if the camera displaced before " +
      "the onset (pre-impact motion is ambiguous) and measures the peak only AT/AFTER the onset. The camera " +
      "first leaves rest on the hit frame (or within one frame), so the peak is unambiguously the post-impact " +
      "shake — not a pre-impact pan and not delayed unrelated motion.",
  },
  capture: { ...sharedCapture, samples, fieldTimeline },
  derived: {
    metric: "screenShakeMag",
    value: screenShakeMag,
    unit: "u",
    calculator: "deriveScreenShakeMag",
    method:
      "peak Euclidean displacement of the sampled camera transform from its rest (first-sample) position, " +
      "hypot(dx,dy,dz), windowed to the hit onset. Dimension-agnostic: a missing z reads as 0 (2D unchanged), " +
      "but a true 3D punch whose X/Y never change is measured because z is sampled.",
    // Independent cross-check: the component's self-reported ShakeMagnitude peak (a sampled field,
    // not the trajectory). It should agree closely with the trajectory-derived peak above.
    selfReportedShakeMagPeak: peakSampled(shakeMagSeries),
  },
  honesty: {
    measures:
      "the LIVE peak displacement of the camera transform punched as the causal consequence of a real 3D " +
      "projectile collision, derived from the {x,y,z} trajectory the Loombridge bridge now samples, in the " +
      "repo-owned 3D shooter fixture. The entire signal lives in the Z axis, so this is genuinely a 3D proof.",
    doesNotMeasure:
      "screen-shake QUALITY/readability, trauma curves, perlin-noise shake shape, kickback feel, or any " +
      "production camera-shake authoring. This is the camera DISPLACEMENT magnitude, a conservative measure, " +
      "not broad 3D camera-feel support. Recoil, ADS, hitscan, AI/cover/waves remain explicit gaps " +
      "(see methodology-gaps.md).",
  },
};

await fs.writeFile(args.hitstopOutput, stableJson(hitstopArtifact), "utf8");
await fs.writeFile(args.screenShakeOutput, stableJson(screenShakeArtifact), "utf8");
process.stdout.write(
  `hitstopMs = ${hitstop.latencyMs} ms (causal=${hitStopCausal}); ` +
    `screenShakeMag = ${screenShakeMag} u (z-stripped projection = ${screenShakeMagZStripped} [refused], causal=${shakeCausal}) ` +
    `-> ${path.relative(process.cwd(), args.hitstopOutput)}, ${path.relative(process.cwd(), args.screenShakeOutput)}\n`,
);
