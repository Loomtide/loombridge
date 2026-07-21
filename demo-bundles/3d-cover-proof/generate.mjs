#!/usr/bin/env node
// Assemble the canonical 3D cover-proof artifact FROM the immutable raw COVERED + EXPOSED transcripts.
// It copies the {tMs,value} fieldTimeline series VERBATIM out of both raw runtime.capture_input_motion
// responses and runs them back through the PRODUCTION deriveCoverBlocksDamage (covered must block LOS +
// every valid shot + all damage; exposed must restore LOS + let the same shots damage). Delete or alter
// either raw transcript and this fails or changes — live cover evidence cannot be minted without both.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCoverBlocksDamage, firstRisingEdge } from "../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const COVERED_RAW = "3d-cover-covered-raw-2026-06-26.json";
const EXPOSED_RAW = "3d-cover-exposed-raw-2026-06-26.json";
const DERIVED_NAME = "3d-cover-derived-2026-06-26.json";

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

async function loadRaw(name) {
  const raw = JSON.parse(await fs.readFile(path.join(bundleDir, name), "utf8"));
  if (raw.op !== "runtime.capture_input_motion") {
    throw new Error(`${name} op must be runtime.capture_input_motion, got ${raw.op}`);
  }
  if (raw.host?.projectName !== "shooter-3d-combat-dogfood") {
    throw new Error(`${name} host must be shooter-3d-combat-dogfood, got ${raw.host?.projectName}`);
  }
  if (!Array.isArray(raw.response?.fieldTimeline)) {
    throw new Error(`${name} response.fieldTimeline missing — cannot assemble the cover artifact`);
  }
  return raw;
}

function copyTimeline(raw) {
  return raw.response.fieldTimeline.map((s) => ({
    id: s.id,
    samples: (s.samples ?? []).map((x) => ({ tMs: x.tMs, value: x.value })),
    ...(s.unresolved != null ? { unresolved: s.unresolved } : {}),
    ...(s.readError != null ? { readError: s.readError } : {}),
  }));
}

function captureSeries(timeline) {
  const by = (id) => timeline.find((s) => s.id === id);
  const incomingShots = by("IncomingShotCount");
  const blockedShots = by("BlockedShotCount");
  const lineOfSight = by("HasLineOfSight");
  const damage = by("DamageTakenCount");
  if (!incomingShots) throw new Error("fieldTimeline is missing the IncomingShotCount series");
  if (!blockedShots) throw new Error("fieldTimeline is missing the BlockedShotCount series");
  if (!lineOfSight) throw new Error("fieldTimeline is missing the HasLineOfSight series");
  if (!damage) throw new Error("fieldTimeline is missing the DamageTakenCount series");
  return { incomingShots, blockedShots, lineOfSight, damage };
}

const finalValue = (series) => {
  const ss = series?.samples ?? [];
  const v = ss.length > 0 ? ss[ss.length - 1].value : 0;
  return typeof v === "number" ? v : 0;
};

const args = parseArgs(process.argv.slice(2));

const coveredRaw = await loadRaw(COVERED_RAW);
const exposedRaw = await loadRaw(EXPOSED_RAW);
const coveredTimeline = copyTimeline(coveredRaw);
const exposedTimeline = copyTimeline(exposedRaw);
const coveredSeries = captureSeries(coveredTimeline);
const exposedSeries = captureSeries(exposedTimeline);

// Provenance: bind the pair to genuine covered/exposed states (CoverActive is fixture provenance, not
// fed to the calculator). The covered capture must have the cover UP throughout; the exposed capture
// must REMOVE it (a true->false transition). A mismatched pair cannot mint a green.
const coverActiveOf = (timeline) => (timeline.find((s) => s.id === "CoverActive")?.samples ?? []);
const coveredCover = coverActiveOf(coveredTimeline);
const exposedCover = coverActiveOf(exposedTimeline);
if (!(coveredCover.length > 0 && coveredCover.every((s) => s.value === true))) {
  throw new Error("the covered capture did not keep the cover active throughout — not a genuine covered case");
}
if (!(exposedCover.length > 0 && exposedCover[0].value === true && exposedCover.some((s) => s.value === false))) {
  throw new Error("the exposed capture did not remove the cover (no CoverActive true->false transition) — not a genuine exposed case");
}

// True cover proof through the production calculator.
const result = deriveCoverBlocksDamage(coveredSeries, exposedSeries);
if (!result.ok) {
  throw new Error(`deriveCoverBlocksDamage refused the raw cover pair (${result.reason}) — cannot mint a green`);
}

const summarize = (series, raw) => {
  const coverActive = raw.response?.fieldTimeline?.find((s) => s.id === "CoverActive")?.samples ?? [];
  return {
    measuredObject: raw.request?.measure?.path,
    durationMs: raw.response?.durationMs,
    sampleCount: raw.response?.sampleCount,
    incomingShots: finalValue(series.incomingShots),
    blockedShots: finalValue(series.blockedShots),
    lineOfSightEverClear: (series.lineOfSight.samples ?? []).some((s) => s.value === true),
    damage: finalValue(series.damage),
    shotsBlockedEdgeMs: firstRisingEdge(series.blockedShots),
    damageEdgeMs: firstRisingEdge(series.damage),
    coverActiveAtStart: coverActive.length > 0 ? coverActive[0].value : null,
    coverRemoved: coverActive.some((s) => s.value === false),
  };
};

const artifact = {
  metric: "coverBlocksDamage",
  status: "pass",
  evidenceKind: "live-unity-capture",
  dimensionality: "3D",
  capturedAt: coveredRaw.capturedAt,
  project:
    `${coveredRaw.host?.projectName} (repo-owned 3D shooter fixture; unity-projects/shooter-3d-combat-dogfood, ` +
    "scene Assets/Scenes/Shooter3DCombatDogfood.unity)",
  rawCaptureSources: [`demo-bundles/3d-cover-proof/${COVERED_RAW}`, `demo-bundles/3d-cover-proof/${EXPOSED_RAW}`],
  fixture: {
    probeObject: "/CoverProbe",
    probeComponent: "Shooter3DCoverProbe",
    targetObject: "/CoverEnemy",
    coverObject: "/CoverProp",
    scene: coveredRaw.host?.scene,
    note:
      "A clean-room cover probe on an isolated lane (x=-4, clear of the main combat lane and the AI occluder) " +
      "fires straight Physics.Raycast shots at a down-range CoverEnemy. A CoverProp collider sits between them. " +
      "Each shot is on the line that WOULD hit the target: if the cover is in the way the ray's first hit is the " +
      "cover (BlockedShotCount rises — a real block, distinct from a miss); otherwise it is the target (damage). " +
      "V removes the cover (expose). Series copied verbatim from the raw bridge transcripts; not synthesized.",
  },
  covered: summarize(coveredSeries, coveredRaw),
  exposed: summarize(exposedSeries, exposedRaw),
  proof: {
    note:
      "COVERED: shots fired, line of sight never clear, every shot blocked by the cover collider " +
      "(BlockedShotCount == IncomingShotCount — not a miss), zero damage. EXPOSED: the SAME shots, cover removed, " +
      "line of sight restored, no blocks, damage landed. So the obstacle causally blocks both LOS and damage, and " +
      "removing it restores both. A miss-as-block, damage-through-cover, or false cover (exposed dealt no damage) " +
      "would have refused the mint.",
  },
  derived: {
    metric: "coverBlocksDamage",
    value: result.ok,
    calculator: "deriveCoverBlocksDamage",
    method:
      "covered (LOS blocked + every valid shot blocked by the cover collider + no damage) AND exposed (LOS restored " +
      "+ no blocks + damage) from a covered/exposed capture pair. Boolean proof; refuses miss-as-block, " +
      "damage-through-cover, false cover, no shot, or no LOS probe. MEASURE-ONLY (a report row, never banded).",
  },
  honesty: {
    measures:
      "that an obstacle blocks line of sight AND prevents damage for an otherwise-valid shot, and removing it " +
      "restores both — a geometric, causal cover proof in the repo-owned 3D shooter fixture.",
    doesNotMeasure:
      "tactical planning, cover-point generation, navmesh safe areas, peeking, suppression, flanking, AI cover " +
      "selection, or production cover-map quality — all explicit gaps. This is the narrow LOS/damage-prevention " +
      "proof only, NOT a claim of 3D-shooter cover AI.",
  },
};

await fs.writeFile(args.output, stableJson(artifact), "utf8");
process.stdout.write(
  `coverBlocksDamage = ${result.ok} ` +
    `(covered: ${artifact.covered.incomingShots} shots, ${artifact.covered.blockedShots} blocked, ${artifact.covered.damage} damage; ` +
    `exposed: ${artifact.exposed.incomingShots} shots, ${artifact.exposed.blockedShots} blocked, ${artifact.exposed.damage} damage) ` +
    `-> ${path.relative(process.cwd(), args.output)}\n`,
);
