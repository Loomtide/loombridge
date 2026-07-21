#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { promoteGenreContract } from "../../../mcp-server/dist/loombridge/genre-contract/promote.js";
import {
  deriveTimeToKill,
  firstRisingEdge,
  eventEdges,
  deriveHitstopMs,
  deriveScreenShakeMag,
  isImmediateImpactFeedback,
} from "../../../mcp-server/dist/verification/feel-derive.js";

const bundleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(bundleDir, "../../..");
const contractPath = path.join(repoRoot, "mcp-server/src/loombridge/genre-contract/examples/2d-shooter.contract.json");

// The CANONICAL live shooter-combat-loop TTK artifact. Every other TTK artifact in this bundle is
// superseded BY it; the promoted proof cites only this one for ttkMs.
const SHOOTER_COMBAT_LOOP_CANONICAL =
  "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-2026-06-25.json";
const HITSTOP_CANONICAL =
  "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/hitstop-capture-2026-06-25.json";
const SCREEN_SHAKE_CANONICAL =
  "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/screen-shake-capture-2026-06-25.json";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(relativePath, value) {
  await fs.writeFile(path.join(bundleDir, relativePath), stableJson(value), "utf8");
}

const genreContract = JSON.parse(await fs.readFile(contractPath, "utf8"));
const { acceptance, slices, report } = promoteGenreContract(genreContract);

// ── Fixture-backed TTK (SUPERSEDED) ───────────────────────────────────────────────────────────────
// Retained as deterministic fallback evidence only; the promoted proof no longer cites it. It is now
// marked `superseded` and points at the canonical live shooter-combat-loop artifact that replaced it.
const fixtureDamageSeries = {
  id: "reference-enemy-hit-count",
  samples: [
    { tMs: 0, value: 0 },
    { tMs: 66.67, value: 0 },
    { tMs: 133.33, value: 1 },
    { tMs: 200, value: 1 },
    { tMs: 266.67, value: 1 },
    { tMs: 333.33, value: 2 },
    { tMs: 400, value: 2 },
    { tMs: 466.67, value: 2 }
  ]
};
const fixtureDeathSeries = {
  id: "reference-enemy-is-dead",
  samples: [
    { tMs: 0, value: false },
    { tMs: 66.67, value: false },
    { tMs: 133.33, value: false },
    { tMs: 200, value: false },
    { tMs: 266.67, value: false },
    { tMs: 333.33, value: false },
    { tMs: 400, value: true },
    { tMs: 466.67, value: true }
  ]
};
const fixtureTtk = deriveTimeToKill(fixtureDamageSeries, fixtureDeathSeries);
if (!fixtureTtk.ok) {
  throw new Error(`fixture TTK derivation failed: ${fixtureTtk.reason}`);
}

const ttkFixtureArtifact = {
  metric: "ttkMs",
  status: "pass",
  evidenceKind: "fixture-backed",
  superseded: true,
  supersededBy: SHOOTER_COMBAT_LOOP_CANONICAL,
  capturedAt: "2026-06-25T08:00:00.000Z",
  fixture: {
    scene: "Assets/Scenes/DogfoodShooterTTK.unity",
    referenceEnemy: "/ReferenceEnemy",
    damageSignal: "ReferenceEnemy.HitCount",
    deathSignal: "ReferenceEnemy.IsDead",
    note: "SUPERSEDED fallback: deterministic fixture-shaped capture from before any live dogfood existed. The promoted proof now cites the live shooter-combat-loop Unity artifact instead; this file is kept only as offline fallback evidence."
  },
  capture: {
    source: "fixture.fieldTimeline",
    captureFps: 60,
    fieldTimeline: [fixtureDamageSeries, fixtureDeathSeries]
  },
  derived: {
    metric: "ttkMs",
    value: Number(fixtureTtk.latencyMs.toFixed(4)),
    unit: "ms",
    firstHitMs: 133.33,
    deathMs: 400
  },
  honesty: {
    measures: "first-hit edge to explicit reference-enemy death edge",
    doesNotMeasure: "player aim time, automatic enemy discovery, or a live Unity enemy-kill run"
  }
};

// ── GameHub host-of-convenience live TTK (SUPERSEDED) ─────────────────────────────────────────
// The earlier live capture: a transient DogfoodReferenceEnemy hosted in the GameHub editor (NOT a
// shipped 2D-shooter build), whose hits were injected fire-key rising edges rather than live projectile
// collisions. Still assembled here from its raw transcript so the provenance chain stays intact, but it
// is now marked `superseded` by the real shooter-combat-loop capture and the proof no longer cites it.
const HOST_RAW_REL = "ttk-live-capture-raw-2026-06-25.json";
const hostRaw = JSON.parse(await fs.readFile(path.join(bundleDir, HOST_RAW_REL), "utf8"));
if (hostRaw.op !== "runtime.capture_input_motion") {
  throw new Error(`GameHub raw transcript op must be runtime.capture_input_motion, got ${hostRaw.op}`);
}
const hostResponse = hostRaw.response;
if (!Array.isArray(hostResponse?.fieldTimeline)) {
  throw new Error("GameHub raw transcript response.fieldTimeline missing");
}
const copySeries = (timeline, id) => {
  const series = timeline.find((s) => s.id === id);
  if (!series || !Array.isArray(series.samples)) {
    throw new Error(`raw transcript missing sampled series "${id}"`);
  }
  // Copy verbatim from the raw response — never rebuild from constants.
  return { id: series.id, samples: series.samples.map((s) => ({ tMs: s.tMs, value: s.value })) };
};
const hostDamageSeries = copySeries(hostResponse.fieldTimeline, "reference-enemy-hit-count");
const hostDeathSeries = copySeries(hostResponse.fieldTimeline, "reference-enemy-is-dead");
const hostTtk = deriveTimeToKill(hostDamageSeries, hostDeathSeries);
if (!hostTtk.ok) {
  throw new Error(`GameHub live TTK derivation refused: ${hostTtk.reason}`);
}

const ttkHostLiveArtifact = {
  metric: "ttkMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  superseded: true,
  supersededBy: SHOOTER_COMBAT_LOOP_CANONICAL,
  capturedAt: hostRaw.capturedAt,
  project: `${hostRaw.host?.projectName} (host-of-convenience; NOT a shipped 2D-shooter build)`,
  rawCaptureSource: `demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/${HOST_RAW_REL}`,
  fixture: {
    object: hostRaw.request?.measure?.path,
    component: "DogfoodReferenceEnemy",
    inputSystem: true,
    maxHits: 2,
    damageSignal: "DogfoodReferenceEnemy.HitCount",
    deathSignal: "DogfoodReferenceEnemy.IsDead",
    note:
      "SUPERSEDED: transient dogfood reference enemy hosted in a GameHub editor session. Hits were the " +
      "rising edge of an injected fire key (Space), not live projectile collisions; IsDead flipped as the causal " +
      "consequence of HitCount reaching MaxHits. Replaced by the real shooter-combat-loop capture against the " +
      "repo-owned shooter-combat-dogfood fixture. Series copied verbatim from the raw bridge transcript."
  },
  capture: {
    source: hostRaw.op,
    captureFps: hostRaw.request?.captureFps,
    durationMs: hostResponse.durationMs,
    sampleCount: hostResponse.sampleCount,
    projectFixedTimestepBeforeMeasurement: hostResponse.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: hostResponse.measurementFixedTimestep,
    phases: (hostResponse.phases ?? []).map((p) => ({
      index: p.index,
      keys: p.keys,
      requestedDurationMs: p.requestedDurationMs
    })),
    fieldTimeline: [hostDamageSeries, hostDeathSeries]
  },
  derived: {
    metric: "ttkMs",
    value: Number(hostTtk.latencyMs.toFixed(2)),
    unit: "ms",
    firstHitMs: firstRisingEdge(hostDamageSeries),
    deathMs: firstRisingEdge(hostDeathSeries)
  },
  honesty: {
    measures:
      "LIVE first-hit edge to explicit reference-enemy death edge, sampled in Play Mode through the real " +
      "Loombridge bridge (both rising edges; death causal on HitCount reaching MaxHits)",
    doesNotMeasure:
      "player aim time, damage delivered by live projectile collisions, or a full shooter combat loop in a " +
      "shipped 2D-shooter build (the host project is a fixture host of convenience)"
  }
};

// ── Live shooter-combat-loop TTK (CANONICAL) ────────────────────────────────────────────────────────
// ASSEMBLED FROM the committed raw capture transcript (`ttk-shooter-combat-loop-raw-2026-06-25.json`) —
// the verbatim runtime.capture_input_motion bridge interaction against the REPO-OWNED shooter-combat
// fixture (`unity-projects/shooter-combat-dogfood`, scene Assets/Scenes/ShooterCombatDogfood.unity). This
// generator does NOT synthesize series from constants: it copies the sampled fieldTimeline out of the raw
// response and runs the enemy HitCount + IsDead series back through the real deriveTimeToKill. Delete or
// alter the raw transcript and this either fails or changes — live evidence cannot be minted without the
// raw source. The first hit is a real DogfoodProjectile trigger-collision (ProjectileHitCount AND enemy
// HitCount rise together, Health falls 3->0); death is the causal consequence of the third collision — not
// a timer, not an injected-edge fake, not a host-of-convenience.
const SHOOTER_RAW_REL = "ttk-shooter-combat-loop-raw-2026-06-25.json";
const shooterRaw = JSON.parse(await fs.readFile(path.join(bundleDir, SHOOTER_RAW_REL), "utf8"));
if (shooterRaw.op !== "runtime.capture_input_motion") {
  throw new Error(`shooter raw transcript op must be runtime.capture_input_motion, got ${shooterRaw.op}`);
}
if (shooterRaw.host?.projectName !== "shooter-combat-dogfood") {
  throw new Error(`shooter raw transcript host must be shooter-combat-dogfood, got ${shooterRaw.host?.projectName}`);
}
const shooterResponse = shooterRaw.response;
const shooterTimeline = shooterResponse?.fieldTimeline;
if (!Array.isArray(shooterTimeline)) {
  throw new Error("shooter raw transcript response.fieldTimeline missing — cannot assemble live TTK artifact");
}
// Copy ALL six combat series verbatim so the canonical artifact shows the full fire->spawn->collide->death
// loop, and so the regression test can deep-equal the canonical fieldTimeline against the raw response.
const fireSeries = copySeries(shooterTimeline, "combat-fire-count");
const spawnSeries = copySeries(shooterTimeline, "combat-projectile-spawn-count");
const projectileHitSeries = copySeries(shooterTimeline, "combat-projectile-hit-count");
const enemyHitSeries = copySeries(shooterTimeline, "combat-enemy-hit-count");
const healthSeries = copySeries(shooterTimeline, "combat-enemy-health");
const deathSeries = copySeries(shooterTimeline, "combat-enemy-is-dead");
const shooterFieldTimeline = [
  fireSeries,
  spawnSeries,
  projectileHitSeries,
  enemyHitSeries,
  healthSeries,
  deathSeries
];

// TTK is first ENEMY-HIT edge -> enemy DEATH edge. The first enemy hit is a projectile collision: assert
// the projectile-hit edge and the enemy-hit edge coincide (only DogfoodProjectile.OnTriggerEnter2D can
// raise both), so a missing-collision capture cannot mint a green TTK from this generator.
const shooterTtk = deriveTimeToKill(enemyHitSeries, deathSeries);
if (!shooterTtk.ok) {
  // A raw capture with no first-hit or no death edge is attempted-blocked, never a minted green.
  throw new Error(`shooter-combat-loop TTK derivation refused on the raw capture: ${shooterTtk.reason}`);
}
const firstProjectileHitMs = firstRisingEdge(projectileHitSeries);
const firstEnemyHitMs = firstRisingEdge(enemyHitSeries);
const shooterDeathMs = firstRisingEdge(deathSeries);
if (firstProjectileHitMs === null || firstProjectileHitMs !== firstEnemyHitMs) {
  throw new Error(
    `first hit is not projectile-collision evidence: projectileHit=${firstProjectileHitMs} enemyHit=${firstEnemyHitMs}`,
  );
}
if (!(firstEnemyHitMs < shooterDeathMs)) {
  throw new Error(`first hit (${firstEnemyHitMs}) must precede death (${shooterDeathMs})`);
}

const ttkShooterArtifact = {
  metric: "ttkMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  capturedAt: shooterRaw.capturedAt,
  project:
    `${shooterRaw.host?.projectName} (repo-owned 2D-shooter combat fixture; ` +
    "unity-projects/shooter-combat-dogfood, scene Assets/Scenes/ShooterCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/${SHOOTER_RAW_REL}`,
  fixture: {
    object: shooterRaw.request?.measure?.path,
    component: "DogfoodCombatReset",
    scene: shooterRaw.host?.scene,
    inputSystem: true,
    enemyMaxHealth: 3,
    fireSignal: "DogfoodShooterFireSource.FireCount",
    spawnSignal: "DogfoodShooterFireSource.ProjectileSpawnCount",
    projectileHitSignal: "DogfoodShooterFireSource.ProjectileHitCount",
    damageSignal: "DogfoodReferenceEnemy.HitCount",
    healthSignal: "DogfoodReferenceEnemy.Health",
    deathSignal: "DogfoodReferenceEnemy.IsDead",
    note:
      "Real shooter-combat loop in the repo-owned shooter-combat-dogfood fixture. Injected Space fires a " +
      "DogfoodProjectile (18u/s) from FireSource at x=0 toward the Enemy (DogfoodReferenceEnemy, maxHealth 3) " +
      "at x=6. Each projectile trigger-collision applies 1 damage: ProjectileHitCount AND enemy HitCount rise " +
      "together (~300ms of flight after each shot) and Health falls 3->0; IsDead flips false->true as the causal " +
      "consequence of the third collision. Damage is projectile collision, never an injected fire-key edge and " +
      "never a timer. All six series copied verbatim from the raw bridge transcript; not synthesized."
  },
  combatLoop: {
    fireEdgesMs: eventEdges(fireSeries),
    projectileSpawnEdgesMs: eventEdges(spawnSeries),
    projectileHitEdgesMs: eventEdges(projectileHitSeries),
    enemyHitEdgesMs: eventEdges(enemyHitSeries),
    firstProjectileHitMs,
    firstEnemyHitMs,
    deathMs: shooterDeathMs,
    note:
      "Three fires -> three spawns -> three projectile collisions -> death. Each projectile-hit edge trails its " +
      "fire/spawn edge by ~300ms of flight; the enemy-hit edge coincides with the projectile-hit edge (the " +
      "collision is the sole damage source); death coincides with the third hit."
  },
  capture: {
    source: shooterRaw.op,
    captureFps: shooterRaw.request?.captureFps,
    durationMs: shooterResponse.durationMs,
    sampleCount: shooterResponse.sampleCount,
    projectFixedTimestepBeforeMeasurement: shooterResponse.projectFixedTimestepBeforeMeasurement,
    measurementFixedTimestep: shooterResponse.measurementFixedTimestep,
    phases: (shooterResponse.phases ?? []).map((p) => ({
      index: p.index,
      keys: p.keys,
      requestedDurationMs: p.requestedDurationMs
    })),
    fieldTimeline: shooterFieldTimeline
  },
  derived: {
    metric: "ttkMs",
    value: Number(shooterTtk.latencyMs.toFixed(2)),
    unit: "ms",
    firstHitMs: firstEnemyHitMs,
    deathMs: shooterDeathMs
  },
  honesty: {
    measures:
      "LIVE first projectile-collision hit edge to enemy death edge in a real shooter-combat loop, sampled in " +
      "Play Mode through the Loombridge bridge against the repo-owned shooter-combat-dogfood fixture (enemy HitCount " +
      "rises on DogfoodProjectile trigger collisions; IsDead is the causal consequence of Health reaching 0).",
    doesNotMeasure:
      "player aim time, or production-tuned combat balance — the fixture is a minimal, deterministic combat loop " +
      "(fixed cadence, one-shot kill at maxHealth 3), not a shipped, balanced game."
  }
};

// ── Live shooter combat-feedback: hit-stop + screen-shake (CANONICAL) ───────────────────────────────
// ASSEMBLED FROM the committed raw capture transcript (`impact-feedback-raw-2026-06-25.json`) — the
// verbatim runtime.capture_input_motion bridge interaction against the SAME repo-owned shooter fixture,
// with the Main Camera as the measured subject and the combat fields sampled on /CombatController. Both
// polish metrics are derived from raw evidence, never constants:
//   hitstopMs       = deriveHitstopMs(combat-hit-stop-active)  — first impact-freeze window duration.
//   screenShakeMag  = deriveScreenShakeMag(camera samples)     — peak camera displacement from rest.
// Both are the CAUSAL consequence of the projectile collision (the enemy HitCount rises on the same
// captured frame the hit-stop window opens and the camera begins to shake). Delete or alter the raw
// transcript and assembly fails or changes.
const IMPACT_RAW_REL = "impact-feedback-raw-2026-06-25.json";
const impactRaw = JSON.parse(await fs.readFile(path.join(bundleDir, IMPACT_RAW_REL), "utf8"));
if (impactRaw.op !== "runtime.capture_input_motion") {
  throw new Error(`impact raw transcript op must be runtime.capture_input_motion, got ${impactRaw.op}`);
}
if (impactRaw.host?.projectName !== "shooter-combat-dogfood") {
  throw new Error(`impact raw transcript host must be shooter-combat-dogfood, got ${impactRaw.host?.projectName}`);
}
const impactResponse = impactRaw.response;
const impactTimeline = impactResponse?.fieldTimeline;
const impactSamples = impactResponse?.samples;
if (!Array.isArray(impactTimeline) || !Array.isArray(impactSamples)) {
  throw new Error("impact raw transcript missing response.fieldTimeline / response.samples");
}
const impactSeries = (id) => {
  const series = impactTimeline.find((s) => s.id === id);
  if (!series || !Array.isArray(series.samples)) throw new Error(`impact raw transcript missing series "${id}"`);
  // Copy verbatim from the raw response — never rebuild from constants.
  return { id: series.id, samples: series.samples.map((s) => ({ tMs: s.tMs, value: s.value })) };
};
// Copy verbatim camera trajectory + the four sampled combat series.
const cameraSamples = impactSamples.map((s) => ({ tMs: s.tMs, x: s.x, y: s.y }));
const impactEnemyHit = impactSeries("combat-enemy-hit-count");
const impactProjHit = impactSeries("combat-projectile-hit-count");
const impactHitStop = impactSeries("combat-hit-stop-active");
const impactShakeField = impactSeries("combat-shake-magnitude");

const impactFirstHitMs = firstRisingEdge(impactEnemyHit);
const impactProjFirstHitMs = firstRisingEdge(impactProjHit);
const impactHitStopRiseMs = firstRisingEdge(impactHitStop);
const impactShakeRiseMs = firstRisingEdge(impactShakeField);
if (impactProjFirstHitMs === null || impactProjFirstHitMs !== impactFirstHitMs) {
  throw new Error("impact feedback: projectile-hit edge must coincide with the enemy-hit edge");
}

const hitstop = deriveHitstopMs(impactHitStop);
if (!hitstop.ok) {
  // A capture with no hit-stop window (no rising edge) or one that never closes is refused, never green.
  throw new Error(`hitstopMs derivation refused on the raw capture: ${hitstop.reason}`);
}
// screenShakeMag is windowed to the impact: the camera must be at rest BEFORE the first hit and the peak
// is taken only at/after it, so unrelated pre-impact camera motion can never be certified as shake.
const screenShakeMag = deriveScreenShakeMag(cameraSamples, impactFirstHitMs);
if (screenShakeMag === null) {
  // Pre-impact camera motion, or no shake observed after impact → refused, never a fabricated 0.
  throw new Error("screenShakeMag derivation refused on the raw capture (pre-impact motion or no shake observed)");
}

// CAUSALITY (P2): the hit-stop window and the camera shake must open on the SAME captured frame as the
// first projectile-collision hit (or within one capture sample interval). A delayed or independently-
// triggered effect is refused — it cannot be certified as impact feedback.
const impactSampleIntervalMs = 1000 / impactRaw.request.captureFps;
if (!isImmediateImpactFeedback(impactHitStopRiseMs, impactFirstHitMs, impactSampleIntervalMs)) {
  throw new Error(
    `impact feedback not immediate: hit-stop rises at ${impactHitStopRiseMs}ms vs first hit ${impactFirstHitMs}ms`,
  );
}
if (!isImmediateImpactFeedback(impactShakeRiseMs, impactFirstHitMs, impactSampleIntervalMs)) {
  throw new Error(
    `impact feedback not immediate: shake rises at ${impactShakeRiseMs}ms vs first hit ${impactFirstHitMs}ms`,
  );
}

const impactProvenance = {
  capturedAt: impactRaw.capturedAt,
  project:
    `${impactRaw.host?.projectName} (repo-owned 2D-shooter combat fixture; ` +
    "unity-projects/shooter-combat-dogfood, scene Assets/Scenes/ShooterCombatDogfood.unity)",
  rawCaptureSource: `demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/${IMPACT_RAW_REL}`,
  captureSource: impactRaw.op,
  captureFps: impactRaw.request?.captureFps,
  measuredObject: impactRaw.request?.measure?.path,
  causality: {
    firstProjectileHitMs: impactProjFirstHitMs,
    firstEnemyHitMs: impactFirstHitMs,
    hitStopRiseMs: impactHitStopRiseMs,
    shakeRiseMs: impactShakeRiseMs,
    sampleIntervalMs: Number((1000 / impactRaw.request.captureFps).toFixed(2)),
    note:
      "The hit-stop window and the camera shake both open WITHIN ONE captured frame of the first " +
      "projectile-collision hit (here on the SAME frame, 516.67ms) — DogfoodImpactFeedback watches the " +
      "enemy HitCount rise, so the feedback is the immediate causal consequence of a real collision, never " +
      "input, never a timer, never a delayed/independent effect. screenShakeMag additionally requires the " +
      "camera to be at rest BEFORE the hit and measures the peak displacement only at/after it."
  }
};

const hitstopArtifact = {
  metric: "hitstopMs",
  status: "pass",
  evidenceKind: "live-unity-capture",
  capturedAt: impactProvenance.capturedAt,
  project: impactProvenance.project,
  rawCaptureSource: impactProvenance.rawCaptureSource,
  fixture: {
    object: "/CombatController",
    component: "DogfoodCombatReset",
    feedbackComponent: "DogfoodImpactFeedback (on /Main Camera)",
    scene: impactRaw.host?.scene,
    inputSystem: true,
    hitStopSignal: "DogfoodCombatReset.IsHitStopped",
    note:
      "hitstopMs is the duration of the FIRST impact hit-stop window — the rising edge (window opens on a " +
      "registered projectile hit) to the following falling edge (window closes) of the IsHitStopped signal. " +
      "The window advances on Time.deltaTime (the fixture never alters Time.timeScale), so a pinned Loombridge " +
      "capture gives it a deterministic, capture-clock-aligned duration. Series copied verbatim from the raw " +
      "bridge transcript; not synthesized."
  },
  causality: impactProvenance.causality,
  capture: {
    source: impactProvenance.captureSource,
    captureFps: impactProvenance.captureFps,
    durationMs: impactResponse.durationMs,
    sampleCount: impactResponse.sampleCount,
    fieldTimeline: [impactEnemyHit, impactProjHit, impactHitStop]
  },
  derived: {
    metric: "hitstopMs",
    value: Number(hitstop.latencyMs.toFixed(2)),
    unit: "ms",
    windowOpenMs: impactHitStopRiseMs
  },
  honesty: {
    measures:
      "the LIVE duration of the impact hit-stop WINDOW signal (the impact-freeze interval a renderer would " +
      "consume), sampled in Play Mode through the Loombridge bridge against the repo-owned shooter fixture.",
    doesNotMeasure:
      "an actual rendered freeze of the editor timeline (the fixture exposes the deterministic window rather " +
      "than stalling time), nor production-tuned hit-stop balance."
  }
};

const screenShakeArtifact = {
  metric: "screenShakeMag",
  status: "pass",
  evidenceKind: "live-unity-capture",
  capturedAt: impactProvenance.capturedAt,
  project: impactProvenance.project,
  rawCaptureSource: impactProvenance.rawCaptureSource,
  fixture: {
    object: impactProvenance.measuredObject,
    component: "DogfoodImpactFeedback (on /Main Camera)",
    scene: impactRaw.host?.scene,
    inputSystem: true,
    shakeSignal: "DogfoodCombatReset.ShakeMagnitude (cross-check)",
    note:
      "screenShakeMag is the PEAK displacement of the sampled Main Camera transform from its rest position " +
      "over the capture — derived directly from the measured camera trajectory (not a self-reported amplitude " +
      "field), so it proves the camera physically moved on impact. The sampled ShakeMagnitude field is " +
      "carried alongside as an independent cross-check. Samples copied verbatim from the raw bridge transcript."
  },
  causality: impactProvenance.causality,
  capture: {
    source: impactProvenance.captureSource,
    captureFps: impactProvenance.captureFps,
    durationMs: impactResponse.durationMs,
    sampleCount: impactResponse.sampleCount,
    measuredObject: impactProvenance.measuredObject,
    cameraTrajectory: cameraSamples,
    fieldTimeline: [impactEnemyHit, impactShakeField]
  },
  derived: {
    metric: "screenShakeMag",
    value: Number(screenShakeMag.toFixed(4)),
    unit: "u",
    shakeOnsetMs: impactShakeRiseMs
  },
  honesty: {
    measures:
      "the LIVE peak camera displacement (world units) after a projectile impact, derived from the sampled " +
      "Main Camera transform trajectory through the Loombridge bridge against the repo-owned shooter fixture.",
    doesNotMeasure:
      "a pixel-space shake amplitude (this is world-unit camera displacement; a px figure would depend on the " +
      "camera's orthographic size and the screen resolution), nor production-tuned shake balance."
  }
};

const proof = {
  schemaVersion: "0.1.0",
  genreContract,
  promotion: {
    generatedAcceptance: "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/acceptance.json",
    generatedSlices: "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/slices.json",
    promotionReport: "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/promotion-report.json"
  },
  slice: {
    id: "weapon",
    title: "Weapon core: fire -> projectile + impact",
    confidence: "experimental",
    status: "experimental-green",
    productionReady: false,
    supportedGates: ["manifest", "console-clean"]
  },
  build: {
    runId: "run-2d-shooter-promoted-weapon-2026-06-25",
    builtAt: "2026-06-25T08:00:00.000Z",
    implementationSummary: "Promoted 2D-shooter weapon slice: runtime artifacts came from GenreContract promotion; evidence covers weapon gates plus measured fire cadence, projectile speed, input-to-spawn latency, a live Unity shooter-combat-loop first-hit->death TTK capture, and live combat-feedback polish (hit-stop window + camera screen-shake) — all projectile-collision-driven in the repo-owned shooter-combat-dogfood fixture."
  },
  capture: {
    capturedAt: "2026-06-25T08:00:00.000Z",
    gateEvidence: [
      {
        gate: "manifest",
        status: "pass",
        artifact: "demo-bundles/generic-build-follow-on/evidence/weapon-manifest.json",
        summary: "Required promoted weapon-slice roles are present: player, weapon, projectile, reference enemy target, muzzle VFX, hit VFX, death VFX, and combat SFX hook."
      },
      {
        gate: "console-clean",
        status: "pass",
        artifact: "demo-bundles/generic-build-follow-on/evidence/weapon-console.json",
        summary: "No compile/runtime errors are associated with the promoted weapon-slice proof."
      }
    ],
    metricEvidence: [
      {
        metric: "fireIntervalMs",
        status: "pass",
        artifact: "demo-bundles/generic-build-follow-on/live-unity-fire-dogfood/live-fire-capture-2026-06-25.json",
        summary: "Live Unity dogfood capture derives 133.3325ms cadence from a sampled DogfoodWeapon.FireCount fieldTimeline."
      },
      {
        metric: "projectileSpeed",
        status: "pass",
        artifact: "demo-bundles/generic-build-follow-on/live-unity-projectile-speed/live-projectile-speed-capture-2026-06-25.json",
        summary: "Live Unity dogfood capture derives 17.9964u/s from the sampled /Projectile trajectory after fire input launches the projectile."
      },
      {
        metric: "fireInputToSpawnLatency",
        status: "pass",
        artifact: "demo-bundles/generic-build-follow-on/live-unity-input-spawn-latency/live-input-spawn-capture-2026-06-25.json",
        summary: "Live Unity dogfood capture derives 113.33ms from fire input onset to an explicit projectile-spawn edge; the pack-default band is recorded, not gate-enforced."
      },
      {
        metric: "ttkMs",
        status: "pass",
        artifact: SHOOTER_COMBAT_LOOP_CANONICAL,
        summary: "Live Unity shooter-combat-loop capture derives 600.00ms from the first projectile-collision hit on the enemy to its death edge, both sampled in Play Mode through runtime.capture_input_motion against the repo-owned shooter-combat-dogfood fixture; the pack-default band is recorded, not gate-enforced."
      },
      {
        metric: "hitstopMs",
        status: "pass",
        artifact: HITSTOP_CANONICAL,
        summary: `Live Unity capture derives ${hitstopArtifact.derived.value.toFixed(2)}ms hit-stop window (IsHitStopped rising->falling) opening on the first projectile-collision hit, in the repo-owned shooter-combat-dogfood fixture; the pack-default band is recorded, not gate-enforced.`
      },
      {
        metric: "screenShakeMag",
        status: "pass",
        artifact: SCREEN_SHAKE_CANONICAL,
        summary: `Live Unity capture derives ${screenShakeArtifact.derived.value}u peak camera displacement after the first projectile-collision hit, from the sampled Main Camera transform trajectory in the repo-owned shooter-combat-dogfood fixture; the pack-default band is recorded, not gate-enforced.`
      }
    ]
  },
  methodologyGaps: [
    {
      id: "input-sfx-live-evidence",
      linkedTargets: ["inputToSfxLatency"],
      reason: "The calculator exists, but this promoted weapon-slice proof does not include a live fire-SFX edge capture; the target remains explicit rather than silently claimed."
    },
    {
      id: "spawn-aware-capture",
      reason: "The explicit spawn-signal metric is measured, but automatic discovery of arbitrary runtime-spawned projectile objects remains outside this proof."
    },
    {
      // hitstopMs and screenShakeMag are now MEASURED live (see the metric rows above), so they are no
      // longer linked here. This required gap (the contract refusalCondition) now covers only the still-
      // unmeasured residual feel.
      id: "remaining shooter feel beyond current calculators",
      reason: "hitstopMs and screenShakeMag are now measured live; what remains without a calculator is automatic spawned-object discovery and secondary combat feel (crosshair bloom, screen-edge vignette, directional dust), kept as explicit gaps rather than faked."
    },
    {
      id: "aim-assist fairness",
      linkedTargets: ["aiming-feel"],
      reason: "Aiming feel is judgment-only and remains tied to the human oracle check."
    }
  ]
};

await writeJson("acceptance.json", acceptance);
await writeJson("slices.json", slices);
await writeJson("promotion-report.json", report);
await writeJson("ttk-fixture-capture-2026-06-25.json", ttkFixtureArtifact);
await writeJson("ttk-live-capture-2026-06-25.json", ttkHostLiveArtifact);
await writeJson("ttk-shooter-combat-loop-2026-06-25.json", ttkShooterArtifact);
await writeJson("hitstop-capture-2026-06-25.json", hitstopArtifact);
await writeJson("screen-shake-capture-2026-06-25.json", screenShakeArtifact);
await writeJson("2d-shooter-promoted-run.json", proof);
