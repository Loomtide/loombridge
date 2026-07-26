import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidExperimentalBuildProof,
  validateExperimentalBuildProof,
  type ExperimentalBuildProof,
} from "../capabilities/genre/genre-contract/experimental-build-proof.js";
import {
  deriveTimeToKill,
  firstRisingEdge,
  deriveHitstopMs,
  deriveScreenShakeMag,
  isImmediateImpactFeedback,
} from "../capabilities/verification/feel-derive.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The production-shaped artifact reader: resolve a safe relative path to its parsed JSON. */
function readArtifact(relativeArtifactPath: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, relativeArtifactPath), "utf8"));
}

function fixture(): ExperimentalBuildProof {
  return JSON.parse(
    readFileSync(join(repoRoot, "demo-bundles/generic-build-follow-on/2d-shooter-experimental-run.json"), "utf8"),
  ) as ExperimentalBuildProof;
}

function promotedFixture(): ExperimentalBuildProof {
  return JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/2d-shooter-promoted-run.json",
      ),
      "utf8",
    ),
  ) as ExperimentalBuildProof;
}

function codes(proof: unknown, opts = { readArtifact }): string[] {
  return validateExperimentalBuildProof(proof, opts).issues.map((issue) => issue.code);
}

test("generic build follow-on bundle validates as experimental green, not production green", () => {
  const proof = fixture();
  const validated = assertValidExperimentalBuildProof(proof, { readArtifact });

  assert.equal(validated.genreContract.genreId, "2d-shooter");
  assert.equal(validated.slice.status, "experimental-green");
  assert.equal(validated.slice.productionReady, false);
  assert.deepEqual(validated.slice.supportedGates, ["manifest", "console-clean", "visual-artifacts"]);
  assert.equal(validated.capture.metricEvidence?.[0]?.metric, "fireIntervalMs");
  assert.equal(validated.capture.metricEvidence?.[1]?.metric, "projectileSpeed");
  assert.equal(validated.capture.metricEvidence?.[2]?.metric, "fireInputToSpawnLatency");
});

test("promoted shooter vertical bundle validates from promoted artifacts and LIVE shooter-combat-loop TTK evidence", () => {
  const proof = promotedFixture();
  const validated = assertValidExperimentalBuildProof(proof, { readArtifact });

  assert.equal(validated.genreContract.genreId, "2d-shooter");
  assert.equal(validated.slice.id, "weapon");
  assert.equal(validated.slice.status, "experimental-green");
  assert.equal(validated.slice.productionReady, false);
  assert.deepEqual(validated.slice.supportedGates, ["manifest", "console-clean"]);
  assert.equal(
    (validated as unknown as { promotion?: { generatedAcceptance?: string } }).promotion?.generatedAcceptance,
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/acceptance.json",
  );
  assert.deepEqual(
    validated.capture.metricEvidence?.map((row) => row.metric),
    ["fireIntervalMs", "projectileSpeed", "fireInputToSpawnLatency", "ttkMs", "hitstopMs", "screenShakeMag"],
  );

  // The ttkMs row now cites the LIVE shooter-combat-loop capture, not the GameHub
  // host-of-convenience artifact and not the superseded fixture artifact.
  const ttkRow = validated.capture.metricEvidence?.find((row) => row.metric === "ttkMs");
  assert.equal(
    ttkRow?.artifact,
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-2026-06-25.json",
  );

  // The live artifact is a real Unity capture against the repo-owned shooter fixture recording a
  // canonical derived ttkMs of 600.00ms (first projectile-collision hit -> enemy death).
  const live = readArtifact(ttkRow!.artifact) as {
    evidenceKind?: string;
    project?: string;
    derived?: { metric?: string; value?: number };
  };
  assert.equal(live.evidenceKind, "live-unity-capture");
  assert.equal(live.derived?.metric, "ttkMs");
  assert.equal(live.derived?.value, 600);
  // The host is the repo-owned shooter build, NOT a host-of-convenience.
  assert.ok(live.project?.includes("shooter-combat-dogfood"));
  assert.ok(!/host-of-convenience/i.test(live.project ?? ""));

  // The real shooter-combat-loop capture CLOSES the old residual: it is no longer an unresolved gap.
  assert.ok(
    !validated.methodologyGaps.some((gap) => gap.id === "ttk-live-shooter-combat-loop"),
    "a real shooter-combat-loop TTK capture closes the ttk-live-shooter-combat-loop gap",
  );
  // hitstopMs and screenShakeMag are now MEASURED live (not gapped): each cites a live-unity-capture
  // artifact that records its own derived value, and neither is excused by a methodology gap.
  for (const [metric, value, unit] of [
    ["hitstopMs", 116.66, "ms"],
    ["screenShakeMag", 0.3267, "u"],
  ] as const) {
    const row = validated.capture.metricEvidence?.find((r) => r.metric === metric);
    assert.ok(row, `expected a ${metric} metric row`);
    const art = readArtifact(row!.artifact) as {
      evidenceKind?: string;
      project?: string;
      derived?: { metric?: string; value?: number; unit?: string };
    };
    assert.equal(art.evidenceKind, "live-unity-capture");
    assert.equal(art.derived?.metric, metric);
    assert.equal(art.derived?.value, value);
    assert.equal(art.derived?.unit, unit);
    assert.ok(art.project?.includes("shooter-combat-dogfood"));
    assert.ok(
      !validated.methodologyGaps.some((gap) => (gap.linkedTargets ?? []).includes(metric)),
      `${metric} is measured, so it must not be excused by a methodology gap`,
    );
  }
  // The remaining-feel gap is still present (it is a contract refusalCondition) but now covers only
  // the still-unmeasured residual, not hit-stop/screen-shake.
  assert.ok(
    validated.methodologyGaps.some((gap) => gap.id === "remaining shooter feel beyond current calculators"),
  );
});

test("promoted shooter vertical keeps the older TTK artifacts as marked-superseded fallback, not cited", () => {
  const canonical =
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-2026-06-25.json";
  const proof = promotedFixture();
  const ttkRow = proof.capture.metricEvidence?.find((row) => row.metric === "ttkMs");
  assert.ok(ttkRow && !ttkRow.artifact.includes("ttk-fixture-capture"), "proof must not cite the superseded fixture");
  assert.ok(
    ttkRow && !ttkRow.artifact.includes("ttk-live-capture"),
    "proof must not cite the GameHub host-of-convenience capture",
  );

  // The fixture-shaped artifact is superseded by the live shooter-combat-loop capture.
  const fixtureArtifact = readArtifact(
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-fixture-capture-2026-06-25.json",
  ) as { superseded?: boolean; supersededBy?: string };
  assert.equal(fixtureArtifact.superseded, true);
  assert.equal(fixtureArtifact.supersededBy, canonical);

  // The earlier GameHub host-of-convenience LIVE capture is now also superseded by the real
  // shooter-combat-loop capture (still a real capture, just no longer the cited evidence).
  const kidsArtifact = readArtifact(
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-live-capture-2026-06-25.json",
  ) as { superseded?: boolean; supersededBy?: string; evidenceKind?: string };
  assert.equal(kidsArtifact.evidenceKind, "live-unity-capture");
  assert.equal(kidsArtifact.superseded, true);
  assert.equal(kidsArtifact.supersededBy, canonical);
});

test("promoted shooter vertical refuses a TTK row whose artifact does not record ttkMs", () => {
  const proof = promotedFixture();
  const ttkRow = proof.capture.metricEvidence?.find((row) => row.metric === "ttkMs");
  assert.ok(ttkRow);
  ttkRow.artifact = "demo-bundles/generic-build-follow-on/live-unity-fire-dogfood/live-fire-capture-2026-06-25.json";

  const issueCodes = codes(proof);
  assert.ok(issueCodes.includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
  assert.ok(issueCodes.includes("MISSING_METRIC_EVIDENCE"));
});

test("live shooter-combat-loop TTK artifact is bound to a raw capture transcript (provenance), not minted from constants", () => {
  const liveRel =
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-2026-06-25.json";
  const rawRel =
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-raw-2026-06-25.json";

  const live = readArtifact(liveRel) as {
    rawCaptureSource?: string;
    capture: { fieldTimeline: unknown };
  };
  const raw = readArtifact(rawRel) as {
    op?: string;
    host?: { projectName?: string };
    response?: { fieldTimeline?: unknown; phases?: Array<{ fixedTickStart?: number }> };
  };

  // The canonical artifact names the raw transcript as its source...
  assert.equal(live.rawCaptureSource, rawRel);

  // ...the raw file is a real runtime.capture_input_motion transcript (not a hand-authored fixture):
  // it carries the bridge op and per-phase fixedTick provenance only a live capture produces.
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.ok(
    raw.response?.phases?.some((p) => typeof p.fixedTickStart === "number"),
    "raw transcript must carry live per-phase fixedTick provenance",
  );

  // ...the raw transcript was captured against the REPO-OWNED shooter build, not a host-of-convenience.
  assert.equal(raw.host?.projectName, "shooter-combat-dogfood");

  // ...and the canonical series are COPIED VERBATIM from the raw response (the binding that stops
  // generate.mjs from minting live evidence from constants — change the raw file and this breaks).
  assert.deepEqual(live.capture.fieldTimeline, raw.response?.fieldTimeline);
});

test("live shooter-combat-loop TTK: projectile-collision first-hit->death derives 600ms; missing hit or death is refused, never green", () => {
  const live = readArtifact(
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/ttk-shooter-combat-loop-2026-06-25.json",
  ) as { capture: { fieldTimeline: Array<{ id: string; samples: Array<{ tMs: number; value: number | boolean }> }> } };
  const projectileHit = live.capture.fieldTimeline.find((s) => s.id === "combat-projectile-hit-count")!;
  const damage = live.capture.fieldTimeline.find((s) => s.id === "combat-enemy-hit-count")!;
  const death = live.capture.fieldTimeline.find((s) => s.id === "combat-enemy-is-dead")!;

  // The committed live series re-derive through the real calculator to the canonical value (1133.33 -
  // 533.33; floating-point exact value rounds to the 600.00ms recorded in the artifact's derived.value).
  const ttk = deriveTimeToKill(damage, death);
  assert.equal(ttk.ok, true);
  assert.ok(ttk.ok && Number(ttk.latencyMs.toFixed(2)) === 600);

  // The first hit is PROJECTILE-COLLISION evidence: ProjectileHitCount and the enemy HitCount rise on
  // the SAME tick (only DogfoodProjectile.OnTriggerEnter2D can raise both), and that hit precedes death.
  const firstProjectileHit = firstRisingEdge(projectileHit);
  const firstEnemyHit = firstRisingEdge(damage);
  const deathEdge = firstRisingEdge(death);
  assert.equal(firstProjectileHit, 533.33);
  assert.equal(firstProjectileHit, firstEnemyHit);
  assert.ok(firstEnemyHit !== null && deathEdge !== null && firstEnemyHit < deathEdge);

  // Missing death evidence (enemy never observed dying) → refused, never a fabricated/green 0.
  const noDeath = { id: death.id, samples: death.samples.map((s) => ({ tMs: s.tMs, value: false })) };
  const deathMissing = deriveTimeToKill(damage, noDeath);
  assert.equal(deathMissing.ok, false);
  assert.ok(!deathMissing.ok && /never died/i.test(deathMissing.reason));

  // Missing first-hit evidence (no projectile ever landed) → refused, never green.
  const noHit = { id: damage.id, samples: damage.samples.map((s) => ({ tMs: s.tMs, value: 0 })) };
  const hitMissing = deriveTimeToKill(noHit, death);
  assert.equal(hitMissing.ok, false);
  assert.ok(!hitMissing.ok && /never hit/i.test(hitMissing.reason));
});

const IMPACT_RAW_REL =
  "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/impact-feedback-raw-2026-06-25.json";

test("live impact-feedback artifacts are bound to one raw capture transcript (provenance), repo-owned host", () => {
  const raw = readArtifact(IMPACT_RAW_REL) as {
    op?: string;
    host?: { projectName?: string };
    response?: { samples?: unknown; fieldTimeline?: unknown; phases?: Array<{ fixedTickStart?: number }> };
  };
  // The raw file is a real runtime.capture_input_motion transcript captured against the repo-owned
  // shooter fixture, carrying live per-phase fixedTick provenance.
  assert.equal(raw.op, "runtime.capture_input_motion");
  assert.equal(raw.host?.projectName, "shooter-combat-dogfood");
  assert.ok(raw.response?.phases?.some((p) => typeof p.fixedTickStart === "number"));

  // Both canonical artifacts name THIS raw transcript as their source and copy from it verbatim.
  const hitstop = readArtifact(
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/hitstop-capture-2026-06-25.json",
  ) as { rawCaptureSource?: string; capture: { fieldTimeline: Array<{ id: string }> } };
  const shake = readArtifact(
    "demo-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/screen-shake-capture-2026-06-25.json",
  ) as { rawCaptureSource?: string; capture: { cameraTrajectory: unknown } };
  assert.equal(hitstop.rawCaptureSource, IMPACT_RAW_REL);
  assert.equal(shake.rawCaptureSource, IMPACT_RAW_REL);

  // The screen-shake artifact's camera trajectory is COPIED VERBATIM from the raw response samples
  // (the binding that stops generate.mjs minting the magnitude from constants — change the raw, this breaks).
  assert.deepEqual(shake.capture.cameraTrajectory, raw.response?.samples);
  // The hit-stop artifact's hit-stop series is copied verbatim from the raw fieldTimeline.
  const rawHitStop = (raw.response!.fieldTimeline as Array<{ id: string }>).find((s) => s.id === "combat-hit-stop-active");
  const canonHitStop = hitstop.capture.fieldTimeline.find((s) => s.id === "combat-hit-stop-active");
  assert.deepEqual(canonHitStop, rawHitStop);
});

test("live impact-feedback: hit-stop window + camera shake re-derive, are causal, and refuse missing evidence", () => {
  const raw = readArtifact(IMPACT_RAW_REL) as {
    response: {
      samples: Array<{ tMs: number; x: number; y: number }>;
      fieldTimeline: Array<{ id: string; samples: Array<{ tMs: number; value: number | boolean }> }>;
    };
  };
  const series = (id: string) => raw.response.fieldTimeline.find((s) => s.id === id)!;
  const enemyHit = series("combat-enemy-hit-count");
  const projHit = series("combat-projectile-hit-count");
  const hitStop = series("combat-hit-stop-active");
  const shakeField = series("combat-shake-magnitude");
  const firstHit = firstRisingEdge(enemyHit);
  assert.ok(firstHit !== null);
  const SAMPLE_MS = 1000 / 60;

  // The committed raw series re-derive through the real calculators to the canonical values. screenShakeMag
  // is windowed to the first hit (pre-impact-still + post-impact peak), exactly as the assembler binds it.
  const hs = deriveHitstopMs(hitStop);
  assert.equal(hs.ok, true);
  assert.ok(hs.ok && Number(hs.latencyMs.toFixed(2)) === 116.66);
  const mag = deriveScreenShakeMag(raw.response.samples, firstHit!);
  assert.ok(mag !== null && Number(mag.toFixed(4)) === 0.3267);

  // CAUSAL (P2): the first hit is a projectile collision (projectile-hit edge coincides with the
  // enemy-hit edge), and BOTH the hit-stop window and the camera shake open within one captured frame
  // of that hit (here on the same frame) — not merely "at or after" it.
  assert.equal(firstRisingEdge(projHit), firstHit);
  assert.ok(isImmediateImpactFeedback(firstRisingEdge(hitStop), firstHit, SAMPLE_MS));
  assert.ok(isImmediateImpactFeedback(firstRisingEdge(shakeField), firstHit, SAMPLE_MS));

  // P2 regression: a DELAYED hit-stop (window opens two frames after the hit) is NOT immediate feedback.
  const delayedRise = (firstRisingEdge(hitStop) ?? 0) + 2 * SAMPLE_MS;
  assert.equal(isImmediateImpactFeedback(delayedRise, firstHit, SAMPLE_MS), false);

  // P1 regression: inject UNRELATED pre-impact camera motion (a pan in 200-400ms, well before the
  // 516.67ms hit; samples[0] stays at the true rest). A whole-trajectory peak would certify the pan as
  // shake, but the onset-windowed derivation refuses (the camera was not at rest before the hit).
  const prePanCamera = raw.response.samples.map((s) =>
    s.tMs >= 200 && s.tMs < 400 ? { tMs: s.tMs, x: 3.8, y: 0 } : s,
  );
  assert.ok((deriveScreenShakeMag(prePanCamera) ?? 0) > 0.5, "naive whole-trajectory peak is misled");
  assert.equal(deriveScreenShakeMag(prePanCamera, firstHit!), null);

  // Missing hit-stop window (signal never rises) → refused, never a fabricated 0.
  const flat = { id: hitStop.id, samples: hitStop.samples.map((s) => ({ tMs: s.tMs, value: false })) };
  const noWindow = deriveHitstopMs(flat);
  assert.equal(noWindow.ok, false);
  assert.ok(!noWindow.ok && /no hit-stop window opened/i.test(noWindow.reason));

  // A degraded hit-stop series (read error) → refused.
  const degraded = deriveHitstopMs({ id: hitStop.id, samples: [], readError: "getter threw" });
  assert.equal(degraded.ok, false);

  // A static camera (no shake observed) → refused, never a fabricated 0.
  const restCamera = raw.response.samples.map((s) => ({ tMs: s.tMs, x: 3, y: 0 }));
  assert.equal(deriveScreenShakeMag(restCamera, firstHit!), null);
});

test("generic build follow-on refuses production-ready overclaim", () => {
  const proof = fixture() as unknown as { slice: { productionReady: boolean } };
  proof.slice.productionReady = true;

  assert.ok(codes(proof).includes("PRODUCTION_CLAIM"));
});

test("generic build follow-on refuses platformer proofs", () => {
  const proof = fixture();
  proof.genreContract.genreId = "platformer-2d";

  assert.ok(codes(proof).includes("NOT_GENERIC_FOLLOW_ON"));
});

test("generic build follow-on refuses unsupported or undeclared gates", () => {
  const proof = fixture();
  proof.slice.supportedGates = ["manifest", "made-up-shooter-gate"];

  const issueCodes = codes(proof);
  assert.ok(issueCodes.includes("UNSUPPORTED_GATE"));
  assert.ok(issueCodes.includes("GATE_NOT_IN_CONTRACT_SLICE"));
});

test("generic build follow-on requires every claimed supported gate to pass", () => {
  const proof = fixture();
  proof.capture.gateEvidence[0]!.status = "warn";

  assert.ok(codes(proof).includes("NON_PASSING_GATE"));
});

test("generic build follow-on validates metric evidence rows", () => {
  const proof = fixture();
  proof.capture.metricEvidence![0]!.artifact = "../outside.json";

  assert.ok(codes(proof).includes("METRIC_EVIDENCE_ARTIFACT"));
});

test("generic build follow-on metric evidence must pass and bind to measurable-now targets", () => {
  const nonPassing = fixture();
  nonPassing.capture.metricEvidence![0]!.status = "warn";
  assert.ok(codes(nonPassing).includes("METRIC_EVIDENCE_STATUS"));

  const unknown = fixture();
  // aiming-feel is judgment-only (not a measurable-now target), so binding metric
  // evidence to it is refused. (ttkMs is now measurable-now, so it would NOT trip this.)
  unknown.capture.metricEvidence![0]!.metric = "aiming-feel";
  assert.ok(codes(unknown).includes("METRIC_EVIDENCE_UNKNOWN_METRIC"));
});

test("generic build follow-on requires measurable-now core targets to be evidenced or explicitly gapped", () => {
  const proof = fixture();
  proof.capture.metricEvidence = proof.capture.metricEvidence!.filter((row) => row.metric !== "projectileSpeed");

  assert.ok(codes(proof).includes("MISSING_METRIC_EVIDENCE"));

  proof.methodologyGaps.push({
    id: "projectile-speed-live-evidence",
    linkedTargets: ["projectileSpeed"],
    reason: "explicitly blocked in this hypothetical proof",
  });
  assert.ok(!codes(proof).includes("MISSING_METRIC_EVIDENCE"));
});

test("generic build follow-on keeps unimplemented shooter-feel gaps explicit", () => {
  const proof = fixture();
  proof.methodologyGaps = proof.methodologyGaps.filter((gap) => gap.id !== "unimplemented shooter feel targets");

  assert.ok(codes(proof).includes("UNCOVERED_METHODOLOGY_GAP"));
});

test("generic build follow-on binds to a valid Genre Contract", () => {
  const proof = fixture();
  proof.genreContract.measurabilityMap[0]!.calculator = "not-implemented";

  assert.ok(codes(proof).includes("GENRE_CONTRACT_MEASURABLE_NOW_UNIMPLEMENTED"));
});

// ── Phase 0: band-enforcement — self-reported status is never the sole basis for a pass ──────────

test("band-enforcement: a status:pass metric row is UNVERIFIED without an artifact reader", () => {
  const proof = fixture();
  // No reader supplied → every status:pass metric row is unverifiable → refused, and the
  // measurable-now core targets are then MISSING_METRIC_EVIDENCE (not silently passed).
  const issueCodes = validateExperimentalBuildProof(proof).issues.map((i) => i.code);
  assert.ok(issueCodes.includes("METRIC_EVIDENCE_UNVERIFIED"));
  assert.ok(issueCodes.includes("MISSING_METRIC_EVIDENCE"));
});

test("band-enforcement: a fabricated/unreadable artifact path cannot pass", () => {
  const proof = fixture();
  // A safe-looking but non-existent artifact: the reader throws → no derived value → refused.
  proof.capture.metricEvidence![0]!.artifact =
    "demo-bundles/generic-build-follow-on/does-not-exist.json";

  const issueCodes = codes(proof);
  assert.ok(issueCodes.includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
  // fireIntervalMs can no longer be evidenced, so it surfaces as a missing core target.
  assert.ok(issueCodes.includes("MISSING_METRIC_EVIDENCE"));
});

test("band-enforcement: an artifact that records a DIFFERENT metric cannot certify this row", () => {
  const proof = fixture();
  // Point the fireIntervalMs row at the projectile-speed artifact (derived.metric = projectileSpeed).
  proof.capture.metricEvidence![0]!.artifact =
    "demo-bundles/generic-build-follow-on/live-unity-projectile-speed/live-projectile-speed-capture-2026-06-25.json";

  assert.ok(codes(proof).includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
});

test("band-enforcement: an out-of-gateBand value is refused; an in-band value passes", () => {
  // fireIntervalMs artifact derives 133.3325ms. A gateBand that excludes it must refuse.
  const outOfBand = fixture();
  const fireRow = outOfBand.genreContract.measurabilityMap.find((r) => r.target === "fireIntervalMs")!;
  fireRow.gateBand = { min: 0, max: 100, unit: "ms" };
  assert.ok(codes(outOfBand).includes("METRIC_EVIDENCE_OUT_OF_GATE_BAND"));

  // A gateBand that contains 133.3325 enforces cleanly (no out-of-band, no missing evidence).
  const inBand = fixture();
  const fireRow2 = inBand.genreContract.measurabilityMap.find((r) => r.target === "fireIntervalMs")!;
  fireRow2.gateBand = { min: 100, max: 200, unit: "ms" };
  const inBandCodes = codes(inBand);
  assert.ok(!inBandCodes.includes("METRIC_EVIDENCE_OUT_OF_GATE_BAND"));
  assert.ok(!inBandCodes.includes("MISSING_METRIC_EVIDENCE"));
});

test("band-enforcement: one-sided gateBands enforce the bounded side only", () => {
  const setGate = (proof: ExperimentalBuildProof, band: unknown) => {
    (proof.genreContract.measurabilityMap.find((r) => r.target === "fireIntervalMs")! as { gateBand?: unknown }).gateBand = band;
    return proof;
  };
  // value 133.3325: min-only below → refused; min-only satisfied → ok; max-only above → refused.
  assert.ok(codes(setGate(fixture(), { min: 200, unit: "ms" })).includes("METRIC_EVIDENCE_OUT_OF_GATE_BAND"));
  assert.ok(!codes(setGate(fixture(), { min: 100, unit: "ms" })).includes("METRIC_EVIDENCE_OUT_OF_GATE_BAND"));
  assert.ok(codes(setGate(fixture(), { max: 100, unit: "ms" })).includes("METRIC_EVIDENCE_OUT_OF_GATE_BAND"));
  // (A qualitative-only/empty gateBand is rejected at contract-validation time — see the
  // genre-contract validator tests — so it can never reach the proof as a silent no-op.)
});

test("band-enforcement: derived.value must be a finite number (0 accepted, string/NaN refused)", () => {
  const proof = fixture();
  const fireArtifact = proof.capture.metricEvidence![0]!.artifact;
  // Override only the fireIntervalMs artifact's derived value; other rows use the real reader.
  const readerWith = (value: unknown) => (rel: string): unknown =>
    rel === fireArtifact ? { derived: { metric: "fireIntervalMs", value } } : readArtifact(rel);

  // 0 is a legitimate finite value (e.g. zero latency) — must NOT be rejected for value reasons.
  assert.ok(!codes(proof, { readArtifact: readerWith(0) }).includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
  // A numeric STRING is not a number — refused.
  assert.ok(codes(proof, { readArtifact: readerWith("133.3325") }).includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
  // NaN is not finite — refused.
  assert.ok(codes(proof, { readArtifact: readerWith(Number.NaN) }).includes("METRIC_EVIDENCE_ARTIFACT_VALUE"));
});
