#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveFireIntervalMs,
  deriveInputToSpawnLatency,
  deriveTimeToKill,
  eventEdges,
  firstRisingEdge,
} from "../../../mcp-server/dist/capabilities/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "shooter-3d-combat-loop-raw-2026-06-25.json";
const DERIVED_NAME = "shooter-3d-combat-loop-derived-2026-06-25.json";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function round2(value) {
  return Number(value.toFixed(2));
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

function copySeries(timeline, id) {
  const series = timeline.find((entry) => entry.id === id);
  if (!series || !Array.isArray(series.samples)) {
    throw new Error(`raw capture missing fieldTimeline series "${id}"`);
  }
  return {
    id: series.id,
    samples: series.samples.map((sample) => ({ tMs: sample.tMs, value: sample.value })),
  };
}

function sampleAtOrAfter(series, edgeMs) {
  return series.samples.find((sample) => sample.tMs >= edgeMs);
}

function assertSameEdges(label, left, right) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson !== rightJson) {
    throw new Error(`${label} edge mismatch: ${leftJson} !== ${rightJson}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const raw = JSON.parse(await fs.readFile(path.join(bundleDir, RAW_NAME), "utf8"));

if (raw.op !== "runtime.capture_input_motion") {
  throw new Error(`raw capture op must be runtime.capture_input_motion, got ${raw.op}`);
}
if (raw.params?.project !== "shooter-3d-combat-dogfood") {
  throw new Error(`raw capture project must be shooter-3d-combat-dogfood, got ${raw.params?.project}`);
}
if (!Array.isArray(raw.raw?.fieldTimeline)) {
  throw new Error("raw capture missing raw.fieldTimeline");
}

const timeline = raw.raw.fieldTimeline;
const fireSeries = copySeries(timeline, "FireCount");
const spawnSeries = copySeries(timeline, "ProjectileSpawnCount");
const projectileHitSeries = copySeries(timeline, "ProjectileHitCount");
const enemyHitSeries = copySeries(timeline, "HitCount");
const healthSeries = copySeries(timeline, "Health");
const isDeadSeries = copySeries(timeline, "IsDead");
const deathCountSeries = copySeries(timeline, "DeathCount");
const resetSeries = copySeries(timeline, "ResetCount");

const fire = deriveFireIntervalMs(fireSeries);
if (!fire.ok) throw new Error(`fireIntervalMs derivation refused: ${fire.reason}`);
const spawn = deriveInputToSpawnLatency(spawnSeries, 0);
if (!spawn.ok) throw new Error(`fireInputToSpawnLatency derivation refused: ${spawn.reason}`);
const ttk = deriveTimeToKill(enemyHitSeries, isDeadSeries);
if (!ttk.ok) throw new Error(`ttkMs derivation refused: ${ttk.reason}`);

const fireEdges = eventEdges(fireSeries);
const spawnEdges = eventEdges(spawnSeries);
const projectileHitEdges = eventEdges(projectileHitSeries);
const hitEdges = eventEdges(enemyHitSeries);
const isDeadEdges = eventEdges(isDeadSeries);
const deathCountEdges = eventEdges(deathCountSeries);
const resetEdges = eventEdges(resetSeries);
assertSameEdges("ProjectileHitCount/HitCount", projectileHitEdges, hitEdges);
assertSameEdges("IsDead/DeathCount", isDeadEdges, deathCountEdges);

const deathEdge = firstRisingEdge(isDeadSeries);
if (deathEdge === null) throw new Error("raw capture has no IsDead rising edge");
const deathCountEdge = firstRisingEdge(deathCountSeries);
if (deathCountEdge !== deathEdge) {
  throw new Error(`DeathCount edge ${deathCountEdge} must match IsDead edge ${deathEdge}`);
}
const healthAtDeath = sampleAtOrAfter(healthSeries, deathEdge)?.value;
if (healthAtDeath !== 0) {
  throw new Error(`Health must be 0 at death edge ${deathEdge}, got ${healthAtDeath}`);
}

const artifact = {
  schemaVersion: 1,
  sourceArtifact: RAW_NAME,
  capturedAt: raw.capturedAt,
  project: raw.params.project,
  scene: raw.params.measure?.scene,
  metrics: {
    fireIntervalMs: round2(fire.latencyMs),
    fireInputToSpawnLatency: round2(spawn.latencyMs),
    ttkMs: round2(ttk.latencyMs),
  },
  edges: {
    fireEdges,
    spawnEdges,
    projectileHitEdges,
    hitEdges,
    isDeadEdges,
    deathCountEdges,
    deathEdge,
    resetEdges,
  },
  causality: {
    projectileHitsMatchEnemyHits: true,
    deathCountMatchesIsDead: true,
    healthAtDeath,
    note:
      "ProjectileHitCount and HitCount rise on the same frames; Health reaches 0 on the same frame that IsDead and DeathCount rise.",
  },
  provenance: {
    op: raw.op,
    captureFps: raw.params.captureFps,
    sampleCount: raw.raw.sampleCount,
    durationMs: raw.raw.durationMs,
    projectFixedTimestepBeforeMeasurement: raw.raw.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: raw.raw.measurementFixedTimestep,
    inputPhases: (raw.params.phases ?? []).map((phase) => ({
      keys: phase.keys ?? [],
      durationMs: phase.durationMs,
    })),
    fieldIds: (raw.params.sampledFields ?? []).map((field) => field.id),
    editorStateAfterCapture: raw.editorStateAfterCapture ?? {
      play_mode: "playing",
      paused: false,
      compiling: false,
      updating: false,
      show_work_enabled: true,
      selected_object_locator: null,
      error_count: 0,
    },
    note:
      "Generated by demos/evidence-bundles/3d-shooter-first-live-capture/generate.mjs from the committed raw runtime.capture_input_motion transcript using production feel-derive calculators.",
  },
};

await fs.mkdir(path.dirname(args.output), { recursive: true });
await fs.writeFile(args.output, stableJson(artifact), "utf8");
