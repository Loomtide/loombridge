#!/usr/bin/env node
// Assemble the canonical 3D wave/objective artifact FROM the immutable raw capture transcript.
// It copies the {tMs,value} fieldTimeline series VERBATIM out of the raw runtime.capture_input_motion
// response and runs them back through the PRODUCTION deriveWaveObjectiveComplete (spawn N -> kill all ->
// objective-complete, kill-gated: ObjectiveComplete must rise AT/AFTER AliveCount returns to 0). Delete
// or alter the raw transcript and this fails or changes — live wave evidence cannot be minted without it.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveWaveObjectiveComplete, firstRisingEdge } from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "3d-wave-objective-raw-2026-06-26.json";
const DERIVED_NAME = "3d-wave-objective-derived-2026-06-26.json";

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
  throw new Error("raw transcript response.fieldTimeline missing — cannot assemble the wave artifact");
}

const fieldTimeline = response.fieldTimeline.map((s) => ({
  id: s.id,
  samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })),
  ...(s.unresolved != null ? { unresolved: s.unresolved } : {}),
  ...(s.readError != null ? { readError: s.readError } : {}),
}));
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);

const spawnCount = seriesById("SpawnCount");
const aliveCount = seriesById("AliveCount");
const killCount = seriesById("KillCount");
const objectiveComplete = seriesById("ObjectiveComplete");
if (!spawnCount) throw new Error("raw fieldTimeline is missing the SpawnCount series");
if (!aliveCount) throw new Error("raw fieldTimeline is missing the AliveCount series");
if (!killCount) throw new Error("raw fieldTimeline is missing the KillCount series");
if (!objectiveComplete) throw new Error("raw fieldTimeline is missing the ObjectiveComplete series");

const wave = { spawnCount, aliveCount, killCount, objectiveComplete };
const result = deriveWaveObjectiveComplete(wave);
if (!result.ok) {
  throw new Error(`deriveWaveObjectiveComplete refused the raw wave (${result.reason}) — cannot mint a green`);
}

const finalValue = (series) => {
  const ss = series?.samples ?? [];
  const v = ss.length > 0 ? ss[ss.length - 1].value : 0;
  return typeof v === "number" ? v : 0;
};
const peakValue = (series) => {
  let peak = 0;
  for (const s of series?.samples ?? []) {
    if (typeof s.value === "number" && s.value > peak) peak = s.value;
  }
  return peak;
};
const sampleNumber = (value) => (typeof value === "number" ? value : value === true ? 1 : 0);
// The TRUE wave-clear: first tMs where KillCount has reached the full SpawnCount AND AliveCount is 0
// (not merely the first intermediate dip to 0, which a staggered wave can hit before all N are dead).
const firstWaveClearMs = (killSeries, aliveSeries, spawnN) => {
  const aliveByT = new Map((aliveSeries?.samples ?? []).map((s) => [s.tMs, sampleNumber(s.value)]));
  for (const s of killSeries?.samples ?? []) {
    if (sampleNumber(s.value) >= spawnN && aliveByT.get(s.tMs) === 0) return s.tMs;
  }
  return null;
};

const killAllMs = firstWaveClearMs(killCount, aliveCount, finalValue(spawnCount));
const completeMs = firstRisingEdge(objectiveComplete);
const spawnEdgeMs = firstRisingEdge(spawnCount);

const artifact = {
  metric: "waveObjectiveComplete",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/3d-wave-objective/${RAW_NAME}`,
  fixture: {
    waveObject: "/WaveManager",
    waveComponent: "Shooter3DWaveObjective",
    scene: raw.host?.scene,
    note:
      "A clean-room wave manager spawns N real target GameObjects on the start key (G); each kill key (K) " +
      "destroys one and removes it from a live list, so AliveCount is the ACTUAL count of live spawned objects " +
      "and KillCount rises per kill. ObjectiveComplete flips true ONLY when the live list reaches 0 after a wave " +
      "spawned (kill-gated, never a timer). Series copied verbatim from the raw bridge transcript; not synthesized.",
  },
  sequence: {
    spawnTargetCount: peakValue(aliveCount), // N enemies alive at once after spawn
    spawnCount: finalValue(spawnCount),
    killCount: finalValue(killCount),
    aliveFinal: finalValue(aliveCount),
    spawnEdgeMs,
    killAllMs, // AliveCount returns to 0
    objectiveCompleteMs: completeMs,
    note:
      "spawn N → all N killed (KillCount == SpawnCount, AliveCount returns to 0) → ObjectiveComplete rises " +
      "at/after kill-all. A completion before kill-all (timer), alive enemies remaining, or under-kill would " +
      "have refused the mint.",
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
    metric: "waveObjectiveComplete",
    value: result.ok,
    calculator: "deriveWaveObjectiveComplete",
    method:
      "spawn N (SpawnCount > 0) → kill all (KillCount == SpawnCount AND AliveCount returns to 0 after being " +
      "positive) → ObjectiveComplete rises AT/AFTER kill-all. Boolean proof; refuses under-spawn, under-kill, " +
      "alive-remaining, no-completion, or completion-before-kill-all (timer). MEASURE-ONLY (a report row).",
  },
  honesty: {
    measures:
      "that a deterministic single wave of N enemies spawns, all N are killed, and the objective completes as " +
      "the causal consequence of kill-all — a wave/objective SEQUENCE proof in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "multi-wave pacing, difficulty curves, spawn directors, arenas, boss waves, loot rewards, mission design, " +
      "or wave-survival balance — all explicit gaps. This is the narrow spawn→kill-all→complete edge only, NOT a " +
      "claim of production wave support.",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `waveObjectiveComplete = ${result.ok} (spawn ${artifact.sequence.spawnCount}, kill ${artifact.sequence.killCount}, ` +
    `aliveFinal ${artifact.sequence.aliveFinal}; kill-all ${killAllMs}ms, complete ${completeMs}ms) ` +
    `-> ${path.relative(process.cwd(), args.output)}\n`,
);
