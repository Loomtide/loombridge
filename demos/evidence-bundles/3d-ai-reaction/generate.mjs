#!/usr/bin/env node
// Assemble the canonical 3D AI-reaction artifact FROM the immutable raw capture transcript.
// It copies the {tMs,value} fieldTimeline series VERBATIM out of the raw runtime.capture_input_motion
// response and runs them back through the PRODUCTION deriveEnemyReactionLatencyMs (perception edge ->
// first reaction edge, gated on a real perception edge that PRECEDES the reaction). The perception is a
// genuine line-of-sight edge (CanSeePlayer/TargetAcquiredCount), not a timer: the occluder blocks LOS
// until the stimulus removes it. Delete or alter the raw transcript and this fails or changes — live
// perception/reaction evidence cannot be minted without the raw source.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveEnemyReactionLatencyMs, firstRisingEdge } from "../../../mcp-server/dist/capabilities/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const RAW_NAME = "3d-ai-reaction-raw-2026-06-26.json";
const DERIVED_NAME = "3d-ai-reaction-derived-2026-06-26.json";

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
  throw new Error("raw transcript response.fieldTimeline missing — cannot assemble the AI-reaction artifact");
}

// Copy the fieldTimeline series VERBATIM (id + {tMs,value} samples + any degraded markers).
const fieldTimeline = response.fieldTimeline.map((s) => ({
  id: s.id,
  samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })),
  ...(s.unresolved != null ? { unresolved: s.unresolved } : {}),
  ...(s.readError != null ? { readError: s.readError } : {}),
}));
const seriesById = (id) => fieldTimeline.find((s) => s.id === id);

const canSeeSeries = seriesById("CanSeePlayer");
const perceptionSeries = seriesById("TargetAcquiredCount");
const reactionSeries = seriesById("StartedAimingCount");
const occluderSeries = seriesById("OccluderActive");
if (!perceptionSeries) throw new Error("raw fieldTimeline is missing the TargetAcquiredCount series");
if (!reactionSeries) throw new Error("raw fieldTimeline is missing the StartedAimingCount series");

// True perception/reaction derivation through the production calculator.
const result = deriveEnemyReactionLatencyMs(perceptionSeries, reactionSeries);
if (!result.ok) {
  throw new Error(`deriveEnemyReactionLatencyMs refused the raw chain (${result.reason}) — cannot mint a green`);
}

const perceptionEdgeMs = firstRisingEdge(perceptionSeries);
const reactionEdgeMs = firstRisingEdge(reactionSeries);
const canSeeEdgeMs = canSeeSeries ? firstRisingEdge(canSeeSeries) : null;
// Provenance: the LOS was blocked at capture start (occluder true) and the stimulus removed it.
const occluderStart = occluderSeries?.samples?.[0]?.value ?? null;
const occluderRemovedMs = occluderSeries
  ? occluderSeries.samples.find((s) => s.value === false)?.tMs ?? null
  : null;
if (occluderStart !== true) {
  throw new Error("occluder did not start active — line of sight was not blocked at capture start (no honest perception edge)");
}
if (reactionEdgeMs < perceptionEdgeMs) {
  throw new Error(`reaction edge ${reactionEdgeMs} precedes perception edge ${perceptionEdgeMs} — pre-armed reaction`);
}

const artifact = {
  metric: "enemyReactionLatencyMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: raw.capturedAt,
  project:
    `${raw.host?.projectName} (repo-owned 3D shooter fixture; unity-dev-project/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSource: `demos/evidence-bundles/3d-ai-reaction/${RAW_NAME}`,
  fixture: {
    enemyObject: "/Enemy",
    reactionComponent: "Shooter3DEnemyReaction",
    occluderObject: "/Occluder",
    scene: raw.host?.scene,
    note:
      "A clean-room reaction probe on the enemy casts a line-of-sight Physics.Linecast toward the player each " +
      "frame. The Occluder blocks that line until the injected stimulus (T) removes it; only then does " +
      "CanSeePlayer flip true (the PERCEPTION edge, TargetAcquiredCount rises), and only after a fixed reaction " +
      "delay does StartedAimingCount rise (the REACTION edge). Perception is a real LOS edge, NOT a timer — with " +
      "the occluder left in place there is no perception edge and no reaction. Series copied verbatim from the " +
      "raw bridge transcript; not synthesized.",
  },
  ordering: {
    occluderActiveAtStart: occluderStart, // true → LOS blocked before the stimulus
    occluderRemovedMs, // OccluderActive true→false (the stimulus)
    canSeePlayerEdgeMs: canSeeEdgeMs, // CanSeePlayer false→true (LOS acquired)
    perceptionEdgeMs, // TargetAcquiredCount 0→1
    reactionEdgeMs, // StartedAimingCount 0→1
    note:
      "occluder active at start → stimulus removes it → CanSeePlayer/TargetAcquired rise (perception) → " +
      "StartedAiming rises (reaction). perception edge < reaction edge: the reaction is a consequence of " +
      "perception, not a pre-armed/scripted timer. No perception edge (no LOS) would refuse the mint.",
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
    metric: "enemyReactionLatencyMs",
    value: result.latencyMs,
    unit: "ms",
    calculator: "deriveEnemyReactionLatencyMs",
    method:
      "perception edge (TargetAcquiredCount 0→1, gated on a real line-of-sight Linecast) → first reaction edge " +
      "(StartedAimingCount 0→1). Refuses if perception is absent (no LOS), if the reaction is absent, or if the " +
      "reaction precedes perception (pre-armed). MEASURE-ONLY.",
  },
  honesty: {
    measures:
      "the LIVE reaction time of a clean-room enemy from a genuine line-of-sight perception edge to its first " +
      "aim reaction, in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "behavior trees, tactical movement, squads, cover selection, pathfinding quality, accuracy/aim fairness, " +
      "target prioritization, or any broad combat intelligence — all explicit gaps. This is ONE narrow " +
      "perception→reaction latency, gated on a real LOS edge; it is NOT a claim of general 3D-shooter AI.",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `enemyReactionLatencyMs = ${result.latencyMs} ms (occluder removed ${occluderRemovedMs} -> perception ${perceptionEdgeMs} -> reaction ${reactionEdgeMs}) ` +
    `-> ${path.relative(process.cwd(), args.output)}\n`,
);
